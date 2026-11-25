import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTurnLLM } from './llm';
import { runLedger } from '../runLedger';
import { OPERATOR_NATIVE_TOOLS } from '../contract';
import type { PlannerProvider, ProviderMessage } from '../providers/types';
import {
  getCachedLiveChatCatalog,
  invalidateChatCatalogCache,
  prewarmVoiceSession,
  resetSessionPrewarmForTests,
} from '../voice/sessionPrewarm';
import * as ipc from '../../ipc';

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn().mockResolvedValue({ success: true, status: 200, body: '{}' }),
    isTauriEnvironment: vi.fn(() => false),
    listChatSummaries: vi.fn().mockResolvedValue([
      {
        id: 'chat-1',
        title: 'Auth thread',
        provider: 'claude',
        status: 'completed',
        updatedAtUnixMs: 1000,
        workspaceId: 'ws-1',
      },
    ]),
  };
});

describe('planTurnLLM — KV-Cache Split, Tool Pruning, History Compaction & Prewarm (S2/T2)', () => {
  beforeEach(() => {
    localStorage.clear();
    runLedger.clearHistory();
    resetSessionPrewarmForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    runLedger.clearHistory();
    resetSessionPrewarmForTests();
  });

  it('keeps messages[0] byte-identical across turns and places dynamicTail in a trailing context block', async () => {
    const capturedCalls: Array<{ messages: ProviderMessage[]; tools?: unknown[] }> = [];
    const mockProvider: PlannerProvider = {
      id: 'opencode',
      plan: vi.fn(async (messages, opts) => {
        capturedCalls.push({ messages, tools: opts?.tools });
        return {
          rawText: JSON.stringify({
            answer: 'Todo en orden por acá.',
            reply: 'Todo en orden por acá.',
            actions: [],
          }),
          latencyMs: 120,
          model: 'deepseek-v4.1-flash',
          tokenCounts: { prompt: 500, completion: 30, cache: 350 },
        };
      }),
    };

    await planTurnLLM(
      'hola, ¿cómo va todo?',
      mockProvider,
      { workspaceId: 'ws-1', workspaceName: 'kite', gitBranch: 'feat/a', mode: 'thread' },
      'turn-kv-1'
    );

    await planTurnLLM(
      'hola de nuevo',
      mockProvider,
      {
        workspaceId: 'ws-1',
        workspaceName: 'kite',
        gitBranch: 'feat/b',
        mode: 'code',
        activeTerminals: [{ sessionId: 't1', engine: 'grok', who: 'Orion', state: 'running' }],
      },
      'turn-kv-2'
    );

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0].messages[0].role).toBe('system');
    expect(capturedCalls[0].messages[0].content).toBe(capturedCalls[1].messages[0].content);

    // Dynamic tail is separated from messages[0] and precedes the final user message
    const m0 = capturedCalls[0].messages;
    const m1 = capturedCalls[1].messages;
    expect(m0[m0.length - 1]).toEqual({ role: 'user', content: 'hola, ¿cómo va todo?' });
    expect(m1[m1.length - 2].content).toContain('Orion');
    expect(m1[m1.length - 2].content).not.toBe(m0[m0.length - 2].content);

    // Conversational turn pruned to <= 2 tools
    expect((capturedCalls[0].tools ?? []).length).toBeLessThanOrEqual(2);

    // Token breakdown recorded in runLedger with cacheHitRatio
    const run = runLedger.getRun('turn-kv-1');
    expect(run?.tokenBreakdown?.cachedTokens).toBe(350);
    expect(run?.tokenBreakdown?.cacheHitRatio).toBeCloseTo(0.7, 2);
  });

  it('bounds history to last 4 verbatim turns + compressed <=120-token rolling summary', async () => {
    let sentMessages: ProviderMessage[] = [];
    const mockProvider: PlannerProvider = {
      id: 'opencode',
      plan: vi.fn(async (messages) => {
        sentMessages = messages;
        return {
          rawText: JSON.stringify({ answer: 'Entendido.', reply: 'Entendido.', actions: [] }),
          latencyMs: 80,
          model: 'deepseek-v4.1-flash',
        };
      }),
    };

    const history: ProviderMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      history.push({ role: 'user', content: `Pregunta número ${i} sobre el proyecto ${'detalle '.repeat(12)}` });
      history.push({ role: 'assistant', content: `Respuesta número ${i} con explicación ${'contexto '.repeat(12)}` });
    }

    await planTurnLLM(
      'seguimos con esto',
      mockProvider,
      { workspaceId: 'ws-1', workspaceName: 'kite', mode: 'thread' },
      'turn-hist-1',
      history
    );

    // System static + 1 summary + 8 verbatim messages (4 turns) + dynamic tail + user input = 12
    expect(sentMessages.length).toBeLessThanOrEqual(12);
    const verbatimContents = sentMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
    expect(verbatimContents).toContain('Pregunta número 10');
    expect(verbatimContents).toContain('Pregunta número 7');
    expect(verbatimContents).not.toContain('Pregunta número 2');
    const summaryMsg = sentMessages.find((m) => m.content.includes('RESUMEN DE TURNOS PREVIOS'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content.length).toBeLessThanOrEqual(480);
  });

  it('retries once with full OPERATOR_NATIVE_TOOLS catalog when a pruned turn emits a missing tool', async () => {
    const toolLengths: number[] = [];
    const mockProvider: PlannerProvider = {
      id: 'opencode',
      plan: vi.fn(async (_messages, opts) => {
        toolLengths.push((opts?.tools ?? []).length);
        if (toolLengths.length === 1) {
          // Simulates model emitting a tool outside the pruned conversational subset or missing tool
          return {
            rawText: '',
            latencyMs: 60,
            model: 'deepseek-v4.1-flash',
            toolCalls: [{ name: 'open_terminals', arguments: { count: 1, engine: 'powershell' } }],
          };
        }
        return {
          rawText: 'Abriendo terminal.',
          latencyMs: 70,
          model: 'deepseek-v4.1-flash',
          toolCalls: [{ name: 'open_terminals', arguments: { count: 1, engine: 'powershell' } }],
        };
      }),
    };

    const plan = await planTurnLLM(
      'hola', // classified conversational first, then model unexpectedly tried open_terminals
      mockProvider,
      { workspaceId: 'ws-1', workspaceName: 'kite', mode: 'code' },
      'turn-retry-catalog'
    );

    expect(toolLengths).toHaveLength(2);
    expect(toolLengths[0]).toBeLessThanOrEqual(2);
    expect(toolLengths[1]).toBe(OPERATOR_NATIVE_TOOLS.length);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe('open_terminals');
  });

  it('caches chat catalog with 30s TTL, invalidates on demand, and prewarms voice session', async () => {
    const first = await getCachedLiveChatCatalog('ws-1');
    const second = await getCachedLiveChatCatalog('ws-1');
    expect(first.entries).toHaveLength(1);
    expect(second.entries).toHaveLength(1);
    expect(ipc.listChatSummaries).toHaveBeenCalledTimes(1);

    invalidateChatCatalogCache('ws-1');
    await getCachedLiveChatCatalog('ws-1');
    expect(ipc.listChatSummaries).toHaveBeenCalledTimes(2);

    await expect(prewarmVoiceSession({ workspaceId: 'ws-1' })).resolves.toBeUndefined();
  });
});
