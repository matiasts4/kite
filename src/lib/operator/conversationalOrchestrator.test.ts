import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invokeCommand } from '../ipc';
import { ActionSchema, SpawnSubagentActionSchema } from './contract';
import { formatDelegatedTask } from './executor/actions/oddBrief';
import { executeSpawnSubagentAction } from './executor/actions/spawnSubagent';
import { executeNarrateAction } from './executor/actions/narrate';
import { buildOperatorSystemPrompt } from './planner/prompt';
import { planTurnHeuristic } from './planner/heuristic';
import { voiceSessionStore } from './voice/voiceSessionStore';
import { voiceTurnArbitrator } from './voice/turnArbitrator';
import { ctxClient } from './context/ctxClient';
import { executePlan } from './executor';
import { runOperatorTurn, getOptimisticAsyncAck } from './index';
import { ttsNarrator } from './ttsNarrator';
import * as chatIndex from './chatIndex';
import type { PlannerProvider } from './providers/types';
import {
  formatWorkspaceRosterForPrompt,
  resetWorkspaceSnapshotCacheForTests,
} from './context/workspaceSnapshot';
import {
  getCachedWorkspaceEpisodicMemory,
  resetEpisodicMemoryCacheForTests,
} from './context/episodicMemory';
import {
  getSessionWorkingContext,
  recordTurnIntoWorkingContext,
  upsertSubagentFinding,
  formatWorkingContextForPrompt,
  resetWorkingContextForTests,
} from './context/workingContext';
import {
  readThreadFinalOutput,
  summarizeSubagentFindingsForVoice,
  composeSubagentReturnSpeech,
  trackDelegatedSubagent,
  handleSubagentSettlementEvent,
  startSubagentReturnWatcher,
  resetSubagentReturnWatcherForTests,
} from './subagentReturnWatcher';
import { voiceTurnsToChatItems } from '../../components/views/chat/voiceTranscript';
import * as terminalRegistry from '../terminalRegistry';

vi.mock('../ipc', async () => {
  const actual = await vi.importActual<typeof import('../ipc')>('../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(),
    isTauriEnvironment: vi.fn(() => false),
    loadChatThread: vi.fn(),
    listChatSummaries: vi.fn().mockResolvedValue([]),
  };
});

describe('SETH Conversational Orchestrator — S1..S4', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    voiceSessionStore.stopSession();
    voiceSessionStore.clearThreadVoiceTurns('voice-thread-1');
    voiceTurnArbitrator.resetForTests();
    resetWorkspaceSnapshotCacheForTests();
    resetEpisodicMemoryCacheForTests();
    resetWorkingContextForTests();
    resetSubagentReturnWatcherForTests();
    ctxClient.resetForTests();
    voiceSessionStore.clearDraftProposal('voice-thread-1');
    voiceSessionStore.clearDraftProposal('__default__');
    voiceSessionStore.setHandsFreeReplyWindow(0);
  });

  afterEach(() => {
    resetSubagentReturnWatcherForTests();
    voiceSessionStore.stopSession();
    voiceTurnArbitrator.resetForTests();
  });

  describe('S1 — Anchored Voice Thread & Explore vs ODD Subagent Delegation', () => {
    it('accepts mode explore|odd|execute on SpawnSubagentActionSchema while preserving oddMode compatibility', () => {
      const explore = SpawnSubagentActionSchema.parse({
        type: 'spawn_subagent',
        mode: 'explore',
        via: 'thread',
        task: 'Revisar la arquitectura del orquestador',
      });
      expect(explore.mode).toBe('explore');

      const legacyOdd = ActionSchema.parse({
        type: 'spawn_subagent',
        oddMode: true,
        task: 'Armar ODD de notificaciones',
      });
      expect(legacyOdd.type).toBe('spawn_subagent');
    });

    it('frames explore subagents as read-only without forcing ODD creation, and keeps ODD framing for odd mode', () => {
      const explorePrompt = formatDelegatedTask('Revisar cómo funciona prompt.ts y narrate.ts', {
        mode: 'explore',
        oddMode: false,
        targetKind: 'subagent',
      });
      expect(explorePrompt).toMatch(/solo lectura/i);
      expect(explorePrompt).not.toMatch(/odd\/tasks\/<slug>\.md/i);

      const oddPrompt = formatDelegatedTask('Diseñar el nuevo pipeline de memoria', {
        mode: 'odd',
        oddMode: true,
        targetKind: 'subagent',
      });
      expect(oddPrompt).toMatch(/odd\/tasks\/<slug>\.md/i);
      expect(oddPrompt).not.toMatch(/solo lectura/i);
    });

    it('anchors prompt instructions on spawn_subagent in active voice threads and restricts launch_thread to explicit requests', () => {
      const prompt = buildOperatorSystemPrompt({
        workspaceId: 'ws-kite',
        workspaceName: 'kite',
        mode: 'thread',
        voiceSessionActive: true,
        boundThreadId: 'voice-thread-1',
      });

      expect(prompt).toMatch(/hilo principal/i);
      expect(prompt).toMatch(/spawn_subagent/i);
      expect(prompt).toMatch(/"mode":\s*"explore"/i);
      expect(prompt).toMatch(/launch_thread.*expl[ií]citamente/i);
    });

    it('does not force oddMode=true in heuristic for read-only exploration subagent requests', () => {
      const plan = planTurnHeuristic(
        'lanza un subagente con claude para investigar cómo funciona el orquestador'
      );
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].type).toBe('spawn_subagent');
      if (plan.actions[0].type === 'spawn_subagent') {
        expect(plan.actions[0].oddMode).toBeFalsy();
        expect(plan.actions[0].mode).toBe('explore');
      }
    });

    it('spawns explore subagent anchored to boundThreadId with read-only brief and Explorer role', async () => {
      voiceSessionStore.startSession('voice-thread-1', 'thread');
      vi.mocked(invokeCommand).mockResolvedValueOnce({
        status: 'submitted',
        address: 'thread:child-explore-1',
        threadId: 'child-explore-1',
      });

      const receipt = await executeSpawnSubagentAction(
        {
          type: 'spawn_subagent',
          provider: 'claude',
          mode: 'explore',
          task: 'Revisar el flujo del operador y el watcher proactivo',
        },
        0,
        {
          workspaceId: 'ws-kite',
          mode: 'thread',
          voiceSessionActive: true,
          boundThreadId: 'voice-thread-1',
        }
      );

      expect(receipt.ok).toBe(true);
      expect(invokeCommand).toHaveBeenCalledWith(
        'dispatch_run',
        expect.objectContaining({
          via: 'thread',
          role: 'Explorer',
          from: 'thread:voice-thread-1',
          parent: 'thread:voice-thread-1',
          task: expect.stringMatching(/solo lectura/i),
        })
      );
      expect((receipt.data as any)?.mode).toBe('explore');
      expect((receipt.data as any)?.oddMode).toBe(false);
    });
  });

  describe('S2 — Closed-Loop Subagent Return Watcher & Spoken Callback', () => {
    it('reads final assistant output via dispatch_read with last=true', async () => {
      vi.mocked(invokeCommand).mockResolvedValueOnce({
        status: 'settled',
        text: 'Se encontraron 2 causas: prompt.ts prioriza launch_thread y proactiveWatcher no escucha subagentes.',
      });

      const out = await readThreadFinalOutput('child-explore-1');
      expect(invokeCommand).toHaveBeenCalledWith(
        'dispatch_read',
        expect.objectContaining({
          address: 'thread:child-explore-1',
          last: true,
        })
      );
      expect(out).toContain('Se encontraron 2 causas');
    });

    it('cleans technical paths/UUIDs and composes a concise 2-4 sentence Spanish voice report with next-step proposal', () => {
      const raw = [
        '## Hallazgos en `src/lib/operator/planner/prompt.ts` (run 550e8400-e29b-41d4-a716-446655440000)',
        '- La regla siete prioriza abrir hilos independientes en vez de subagentes hijos.',
        '- El watcher proactivo solo observa terminales y nunca consulta el resultado final de los subagentes.',
        '```ts',
        'const x = 1;',
        '```',
      ].join('\n');

      const summary = summarizeSubagentFindingsForVoice(raw);
      expect(summary).not.toContain('550e8400');
      expect(summary).not.toContain('src/lib/operator');
      expect(summary).not.toContain('const x = 1');
      expect(summary).toMatch(/regla siete|watcher proactivo/i);

      const speech = composeSubagentReturnSpeech({
        role: 'Explorer',
        status: 'completed',
        mode: 'explore',
        findingsSummary: summary,
      });
      expect(speech).toMatch(/Explorer|explorador/i);
      expect(speech).toMatch(/\?$/);
    });

    it('on subagent settlement reads findings via dispatch_read, updates working context & episodic memory, records proactive turn, and respects VoiceTurnArbitrator', async () => {
      voiceSessionStore.startSession('voice-thread-1', 'thread');
      const spoken: string[] = [];

      const stop = startSubagentReturnWatcher({
        speak: (text) => {
          spoken.push(text);
        },
        isVoiceSessionOpen: () => true,
      });

      trackDelegatedSubagent({
        childThreadId: 'child-explore-42',
        parentThreadId: 'voice-thread-1',
        role: 'Explorer',
        provider: 'claude',
        mode: 'explore',
        task: 'Revisar arquitectura del operador',
        workspaceId: 'ws-kite',
      });

      vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
        if (cmd === 'dispatch_read') {
          return {
            status: 'settled',
            text: 'El operador usa delegación sin retorno porque el watcher solo escucha terminales y el historial se corta a 8 turnos.',
          };
        }
        return {};
      });

      // Simulate user currently speaking -> speech MUST queue instead of overlapping!
      voiceTurnArbitrator.transition('user_speaking');

      await handleSubagentSettlementEvent({
        kind: 'subagentRunUpdated',
        threadId: 'voice-thread-1',
        subagentId: 'sub-42',
        run: {
          subagentId: 'sub-42',
          childThreadId: 'child-explore-42',
          role: 'Explorer',
          provider: 'claude',
          status: 'completed',
        },
      });

      // Floor was busy -> queued, NOT overlapping user speech
      expect(spoken).toHaveLength(0);
      expect(voiceTurnArbitrator.getQueuedNoticeCount()).toBe(1);

      // Working context and episodic memory already have the findings!
      const wc = getSessionWorkingContext('voice-thread-1');
      expect(wc.findings).toHaveLength(1);
      expect(wc.findings[0].status).toBe('completed');
      expect(wc.findings[0].findingsSummary).toMatch(/watcher solo escucha terminales/i);

      const mem = getCachedWorkspaceEpisodicMemory('ws-kite');
      expect(mem.delegations.some((d) => d.resourceId === 'child-explore-42' && d.outcomeSummary?.includes('watcher'))).toBe(true);

      // Proactive turn was projected to voice thread without a fake user bubble
      const turns = voiceSessionStore.getThreadVoiceTurns('voice-thread-1');
      expect(turns.some((t) => t.isProactiveReport)).toBe(true);
      const chatItems = voiceTurnsToChatItems(turns);
      expect(chatItems.filter((it) => it.kind === 'user')).toHaveLength(0);
      expect(chatItems.some((it) => it.kind === 'assistant' && it.text.includes('watcher solo escucha terminales'))).toBe(true);

      // Floor becomes free -> queued subagent speech fires once
      voiceTurnArbitrator.transition('listening');
      expect(spoken).toHaveLength(1);
      expect(spoken[0]).toMatch(/watcher solo escucha terminales/i);

      // Duplicate settlement event MUST NOT re-announce
      await handleSubagentSettlementEvent({
        kind: 'subagentRunUpdated',
        threadId: 'voice-thread-1',
        subagentId: 'sub-42',
        run: {
          subagentId: 'sub-42',
          childThreadId: 'child-explore-42',
          role: 'Explorer',
          provider: 'claude',
          status: 'completed',
        },
      });
      expect(spoken).toHaveLength(1);

      stop();
    });
  });

  describe('S3 — Real Findings in narrate_summary & Workspace Roster', () => {
    it('reads real subagent output via dispatch_read when asked manually in narrate_summary', async () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([]);
      vi.mocked(invokeCommand).mockResolvedValueOnce({
        status: 'settled',
        text: 'Confirmé tres cuellos de botella: falta watcher de subagentes, falta lectura por dispatch_read y el historial se trunca.',
      });

      const receipt = await executeNarrateAction({ target: 'Explorer' }, 0, {
        workspaceId: 'ws-kite',
        boundThreadId: 'voice-thread-1',
        activeSubagents: [
          {
            id: 'child-explore-99',
            role: 'Explorer',
            provider: 'claude',
            status: 'completed',
            parentThreadId: 'voice-thread-1',
            updatedAtUnixMs: 2000,
          },
        ],
      });

      expect(receipt.ok).toBe(true);
      expect(invokeCommand).toHaveBeenCalledWith(
        'dispatch_read',
        expect.objectContaining({
          address: 'thread:child-explore-99',
          last: true,
        })
      );
      expect(receipt.summaryEs).toMatch(/tres cuellos de botella/i);
      expect(receipt.spokenSummaryEs).toMatch(/tres cuellos de botella/i);
    });

    it('resolves Spanish heuristic queries like "¿cómo va el subagente?" and "¿qué encontró el explorador?" without capturing bare article "el"', async () => {
      const q1 = planTurnHeuristic('¿cómo va el subagente?');
      expect(q1.actions).toEqual([{ type: 'narrate_summary', target: 'subagente' }]);

      const q2 = planTurnHeuristic('¿qué encontró el explorador?');
      expect(q2.actions).toEqual([{ type: 'narrate_summary', target: 'explorador' }]);

      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([]);
      vi.mocked(invokeCommand).mockResolvedValueOnce({
        status: 'settled',
        text: 'El explorador verificó que dispatch_read devuelve la última respuesta limpia.',
      });

      const receipt = await executeNarrateAction({ target: 'subagente' }, 0, {
        workspaceId: 'ws-kite',
        boundThreadId: 'voice-thread-1',
        activeSubagents: [
          {
            id: 'child-anchored-7',
            role: 'Explorer',
            provider: 'claude',
            status: 'completed',
            parentThreadId: 'voice-thread-1',
            updatedAtUnixMs: 3000,
          },
        ],
      });
      expect(receipt.ok).toBe(true);
      expect(receipt.spokenSummaryEs).toMatch(/dispatch read devuelve la última respuesta limpia/i);
    });

    it('exposes subagent findingsSummary inside formatWorkspaceRosterForPrompt', () => {
      const roster = formatWorkspaceRosterForPrompt({
        workspaceId: 'ws-kite',
        activeSubagents: [
          {
            id: 'child-explore-99',
            role: 'Explorer',
            provider: 'claude',
            status: 'completed',
            findingsSummary: 'Detectó sesgo hacia launch_thread y falta de lazo de retorno.',
            updatedAtUnixMs: 2000,
          },
        ],
      });
      expect(roster).toContain('Explorer');
      expect(roster).toContain('Detectó sesgo hacia launch_thread');
    });
  });

  describe('S4 — Long-Session Rolling Working Context (40+ min continuity)', () => {
    it('preserves topic, agreed decisions, subagent findings, and compacted older turns past the 8-turn history window', () => {
      voiceSessionStore.startSession('voice-thread-1', 'thread');

      // Simulate a 12-turn conversation (turns 1-4 will roll off the 8-turn window)
      for (let i = 1; i <= 12; i++) {
        const prompt =
          i === 1
            ? 'Quiero revisar la arquitectura del asistente SETH y el orquestador de subagentes'
            : i === 2
              ? 'Dale, acordamos usar subagentes exploradores por defecto y solo crear hilos aparte si lo pido'
              : `Seguimiento del punto ${i} sobre el diseño conversacional`;
        const reply =
          i === 2
            ? 'Perfecto, queda acordado usar subagentes exploradores por defecto. ¿Querés que revisemos el watcher?'
            : `Entendido sobre el punto ${i}.`;

        voiceSessionStore.addThreadVoiceTurn('voice-thread-1', {
          turnId: `t-${i}`,
          userPrompt: prompt,
          source: 'voz',
          reply,
          createdAt: 1000 + i * 1000,
        });
      }

      upsertSubagentFinding('voice-thread-1', {
        subagentId: 'child-1',
        role: 'Explorer',
        provider: 'claude',
        mode: 'explore',
        status: 'completed',
        taskSummary: 'Auditar prompt y watcher',
        findingsSummary: 'Prompt priorizaba launch_thread y proactiveWatcher no escuchaba subagentes.',
      });

      const wc = getSessionWorkingContext('voice-thread-1');
      expect(wc.currentTopic).toMatch(/arquitectura del asistente SETH/i);
      expect(wc.decisions.some((d) => /subagentes exploradores/i.test(d))).toBe(true);
      expect(wc.findings).toHaveLength(1);
      expect(wc.compactedTurnCount).toBe(4);
      expect(wc.olderTurnsSummary.length).toBeGreaterThan(0);

      const block = formatWorkingContextForPrompt(wc);
      expect(block).toContain('CONTEXTO VIVO DE LA SESIÓN ACTUAL');
      expect(block).toContain('arquitectura del asistente SETH');
      expect(block).toContain('Prompt priorizaba launch_thread');

      const fullPrompt = buildOperatorSystemPrompt({
        workspaceId: 'ws-kite',
        workspaceName: 'kite',
        mode: 'thread',
        voiceSessionActive: true,
        boundThreadId: 'voice-thread-1',
      });
      expect(fullPrompt).toContain('CONTEXTO VIVO DE LA SESIÓN ACTUAL');
      expect(fullPrompt).toContain('Prompt priorizaba launch_thread');

      // Recent conversation history stays bounded to 8 turns without dropping older context from prompt
      const history = voiceSessionStore.getConversationHistory('voice-thread-1', 8);
      expect(history).toHaveLength(16);
    });

    it('merges proactive assistant report turns cleanly in getConversationHistory without consecutive assistant messages', () => {
      voiceSessionStore.startSession('voice-thread-1', 'thread');
      voiceSessionStore.addThreadVoiceTurn('voice-thread-1', {
        turnId: 't-1',
        userPrompt: 'Revisa el orquestador',
        source: 'voz',
        reply: 'Mandé un subagente explorador a revisar el orquestador.',
        createdAt: 1000,
      });
      voiceSessionStore.addThreadVoiceTurn('voice-thread-1', {
        turnId: 't-report-1',
        userPrompt: '',
        source: 'voz',
        isProactiveReport: true,
        reply: 'Volvió el explorador: encontró que falta dispatch_read.',
        createdAt: 2000,
      });

      const history = voiceSessionStore.getConversationHistory('voice-thread-1', 8);
      expect(history).toHaveLength(2);
      expect(history[0].role).toBe('user');
      expect(history[1].role).toBe('assistant');
      expect(history[1].content).toContain('Mandé un subagente explorador');
      expect(history[1].content).toContain('Volvió el explorador');
    });

    it('preserves recordTurnIntoWorkingContext idempotently without duplicating decisions', () => {
      recordTurnIntoWorkingContext('voice-thread-1', {
        turnId: 't-dup',
        userPrompt: 'Acordamos implementar el watcher primero',
        source: 'voz',
        reply: 'Listo, arrancamos por el watcher.',
        createdAt: 5000,
      });
      recordTurnIntoWorkingContext('voice-thread-1', {
        turnId: 't-dup',
        userPrompt: 'Acordamos implementar el watcher primero',
        source: 'voz',
        reply: 'Listo, arrancamos por el watcher.',
        createdAt: 5000,
      });
      const wc = getSessionWorkingContext('voice-thread-1');
      expect(wc.decisions).toHaveLength(1);
    });
  });

  describe('T3 — Consultative Argos Brain, ctxClient, peek_*, DraftTaskProposal & Folded Returns', () => {
    it('S2.2/S2.3: ctxClient packs voice context under 250 tokens, scrubs volatile KV tokens, and supports in-memory share/CCR fallback', async () => {
      const packed = await ctxClient.packVoiceContext({
        workspaceName: 'kite',
        gitBranch: 'feat/response-thread',
        mode: 'thread',
        voiceSessionActive: true,
        boundThreadId: 'voice-thread-1',
        workingContextSummary: 'Unificación de Argos y kite-ctx',
      });
      expect(packed.estimatedTokens).toBeLessThan(250);
      expect(packed.packedText).toContain('Proyecto="kite"');

      const kv = await ctxClient.kvPlan({
        staticPrefix: 'Identidad estática hace 5s',
        dynamicTail: 'Rama=feat/response-thread',
      });
      expect(kv.volatileTokensScrubbed).toBe(1);
      expect(kv.stablePrefix).not.toContain('hace 5s');

      await ctxClient.sharePut('brief:Explorer', 'Revisar auth');
      expect(await ctxClient.shareGet('brief:Explorer')).toBe('Revisar auth');
      expect(ctxClient.getInMemoryShareMap().get('brief:Explorer')?.value).toBe('Revisar auth');

      const hash = ctxClient.ccrStoreLocal('Línea 1: auth ok\nLínea 2: falta timeout');
      expect(await ctxClient.ccrRetrieve(hash, { search: 'timeout' })).toContain('falta timeout');
    });

    it('S3.1: executes peek_changes, peek_runs, peek_agents, peek_files, and stay_silent cleanly within fast budget', async () => {
      ctxClient.registerFallbackFileContent('src/auth.ts', 'export function login() {}\nexport function logout() {}');

      const res = await executePlan(
        {
          strategy: 'llm',
          actions: [
            { type: 'peek_changes', includeDiff: false },
            { type: 'peek_runs', limit: 3, filterStatus: 'all' },
            { type: 'peek_agents', scope: 'all' },
            { type: 'peek_files', path: 'src/auth.ts', mode: 'signatures' },
          ],
        },
        { workspaceId: 'ws-kite', gitBranch: 'feat/response-thread' }
      );
      expect(res.overallSuccess).toBe(true);
      expect(res.receipts).toHaveLength(4);
      expect((res.receipts[3].data as any)?.content).toContain('export function login()');

      const silentRes = await executePlan({
        strategy: 'llm',
        actions: [{ type: 'stay_silent', reason: 'ambient noise' }],
      });
      expect(silentRes.overallSuccess).toBe(true);
      expect(silentRes.reply).toBe('');
      expect(silentRes.receipts[0].silent).toBe(true);
    });

    it('S3.2/S3.3: runs bounded peek_* -> propose_task -> refine_proposal -> fast heuristic confirm_proposal lifecycle and skips TTS on stay_silent', async () => {
      voiceSessionStore.startSession('voice-thread-1', 'thread');
      const speakSpy = vi.spyOn(ttsNarrator, 'speak').mockResolvedValue();
      const chatCatalogSpy = vi.spyOn(chatIndex, 'fetchLiveChatCatalog');

      let hop = 0;
      const mockProvider: PlannerProvider = {
        id: 'mock-argos',
        plan: vi.fn(async (messages) => {
          hop += 1;
          if (hop === 1) {
            // Hop 1: fast read-only peek before proposing
            return {
              rawText: JSON.stringify({
                reply: '',
                actions: [{ type: 'peek_agents', scope: 'all' }],
              }),
              latencyMs: 15,
              model: 'argos-test',
            };
          }
          if (hop === 2) {
            // Hop 2 after peek observation: propose consultative task
            expect(messages.some((m: { content: string }) => m.content.includes('Observación peek_agents'))).toBe(true);
            return {
              rawText: JSON.stringify({
                reply: 'Propongo explorar auth. ¿Lo lanzo con Claude?',
                actions: [
                  {
                    type: 'propose_task',
                    targetKind: 'subagent',
                    title: 'Explorar módulo auth',
                    taskBrief: 'Revisar el flujo de autenticación actual.',
                    role: 'Explorer',
                    provider: 'grok',
                    mode: 'explore',
                    questionForUser: '¿Lo lanzo con Grok o preferís Claude?',
                  },
                ],
              }),
              latencyMs: 20,
              model: 'argos-test',
            };
          }
          // Hop 3: refinement turn receives active DraftTaskProposal in prompt
          expect(messages[0].content).toContain('PROPUESTA DE TAREA ACTIVA');
          return {
            rawText: JSON.stringify({
              reply: 'Actualizado a Claude.',
              actions: [
                {
                  type: 'refine_proposal',
                  provider: 'claude',
                  questionForUser: '¿Confirmamos con Claude?',
                },
              ],
            }),
            latencyMs: 20,
            model: 'argos-test',
          };
        }),
      };

      const ctx = {
        workspaceId: 'ws-kite',
        mode: 'thread',
        voiceSessionActive: true,
        boundThreadId: 'voice-thread-1',
        activeTerminals: [],
      };

      // Turn 1: peek_agents -> propose_task (does NOT call fetchLiveChatCatalog on default path)
      const t1 = await runOperatorTurn('revisemos el módulo de autenticación', {
        provider: mockProvider,
        context: ctx,
        ttsEnabled: true,
      });
      expect(chatCatalogSpy).not.toHaveBeenCalled();
      expect(t1.plan.actions[0].type).toBe('propose_task');
      expect(voiceSessionStore.getDraftProposal('voice-thread-1')?.provider).toBe('grok');
      expect(voiceSessionStore.isInHandsFreeReplyWindow()).toBe(true);
      expect(speakSpy).toHaveBeenCalledTimes(1);

      // Turn 2: refinement ("mejor usa Claude")
      const t2 = await runOperatorTurn('mejor usa Claude', {
        provider: mockProvider,
        context: ctx,
        ttsEnabled: true,
      });
      expect(t2.plan.actions[0].type).toBe('refine_proposal');
      expect(voiceSessionStore.getDraftProposal('voice-thread-1')?.provider).toBe('claude');
      expect(voiceSessionStore.getDraftProposal('voice-thread-1')?.revision).toBe(2);

      // Turn 3: fast heuristic confirmation ("dale") -> dispatches spawn_subagent & stores brief in ctxClient
      vi.mocked(invokeCommand).mockResolvedValueOnce({
        status: 'submitted',
        address: 'thread:child-confirmed-1',
        threadId: 'child-confirmed-1',
      });
      const t3 = await runOperatorTurn('dale', {
        provider: mockProvider,
        context: ctx,
        ttsEnabled: true,
      });
      expect(t3.strategy).toBe('heuristic');
      expect(t3.plan.actions[0].type).toBe('confirm_proposal');
      expect(t3.overallSuccess).toBe(true);
      expect(voiceSessionStore.getDraftProposal('voice-thread-1')).toBeNull();
      expect(await ctxClient.shareGet('brief:Explorer')).toContain('Revisar el flujo de autenticación');

      // Cancel path check
      await executePlan(
        {
          strategy: 'llm',
          actions: [
            {
              type: 'propose_task',
              targetKind: 'subagent',
              title: 'Otra tarea',
              taskBrief: 'Revisar logs.',
            },
          ],
        },
        ctx
      );
      expect(voiceSessionStore.getDraftProposal('voice-thread-1')).not.toBeNull();
      const tCancel = await runOperatorTurn('olvídalo', {
        provider: mockProvider,
        context: ctx,
      });
      expect(tCancel.plan.actions[0].type).toBe('cancel_proposal');
      expect(voiceSessionStore.getDraftProposal('voice-thread-1')).toBeNull();

      // stay_silent skips TTS
      speakSpy.mockClear();
      const silentProvider: PlannerProvider = {
        id: 'mock-silent',
        plan: vi.fn(async () => ({
          rawText: JSON.stringify({ reply: '', actions: [{ type: 'stay_silent', reason: 'noise' }] }),
          latencyMs: 10,
          model: 'argos-test',
        })),
      };
      const tSilent = await runOperatorTurn('mmm', {
        provider: silentProvider,
        context: ctx,
        ttsEnabled: true,
      });
      expect(tSilent.reply).toBe('');
      expect(speakSpy).not.toHaveBeenCalled();
    });

    it('S2.3/S3.3: folds multiple concurrent subagent returns in VoiceTurnArbitrator and stores <<ccr:HASH>> findings in ctxClient', async () => {
      voiceSessionStore.startSession('voice-thread-1', 'thread');
      const spoken: string[] = [];

      const stop = startSubagentReturnWatcher({
        speak: (text) => {
          spoken.push(text);
        },
        isVoiceSessionOpen: () => true,
      });

      trackDelegatedSubagent({
        childThreadId: 'child-fold-1',
        parentThreadId: 'voice-thread-1',
        role: 'Explorer',
        provider: 'claude',
        mode: 'explore',
        task: 'Revisar auth',
        workspaceId: 'ws-kite',
      });
      trackDelegatedSubagent({
        childThreadId: 'child-fold-2',
        parentThreadId: 'voice-thread-1',
        role: 'Auditor',
        provider: 'grok',
        mode: 'explore',
        task: 'Revisar permisos',
        workspaceId: 'ws-kite',
      });

      vi.mocked(invokeCommand).mockImplementation(async (cmd: string, args: any) => {
        if (cmd === 'dispatch_read') {
          if (args?.address === 'thread:child-fold-1') {
            return { status: 'settled', text: 'Auth usa JWT con expiración corta.' };
          }
          return { status: 'settled', text: 'Permisos validan roles en el middleware.' };
        }
        return {};
      });

      voiceTurnArbitrator.transition('user_speaking');

      await handleSubagentSettlementEvent({
        kind: 'subagentRunUpdated',
        threadId: 'voice-thread-1',
        subagentId: 'sub-f1',
        run: { childThreadId: 'child-fold-1', role: 'Explorer', status: 'completed' },
      });
      await handleSubagentSettlementEvent({
        kind: 'subagentRunUpdated',
        threadId: 'voice-thread-1',
        subagentId: 'sub-f2',
        run: { childThreadId: 'child-fold-2', role: 'Auditor', status: 'completed' },
      });

      expect(spoken).toHaveLength(0);
      expect(voiceTurnArbitrator.getFoldedUpdateCount()).toBe(2);

      const finding1 = await ctxClient.shareGet('finding:child-fold-1');
      expect(finding1).toMatch(/<<ccr:[0-9a-f]+>>/);

      voiceTurnArbitrator.transition('post_tts_guard');
      expect(spoken).toHaveLength(0);

      voiceTurnArbitrator.transition('awaiting_reply');
      expect(spoken).toHaveLength(1);
      expect(spoken[0]).toContain('Terminaron 2 tareas en segundo plano');
      expect(spoken[0]).toContain('Explorer');
      expect(spoken[0]).toContain('Auditor');
      expect(voiceTurnArbitrator.getFoldedUpdateCount()).toBe(0);

      stop();
    });
  });

  describe('T3 — 3-Tier Hybrid Routing (L0 -> L1 -> L2) & Safe Optimistic Acks (S3)', () => {
    it('escalates from L1 (fast) to L2 (diagnosis) when L1 returns escalate: true, preserving peek context', async () => {
      localStorage.setItem(
        'kite.operator.providerConfig.v2',
        JSON.stringify({
          activeProvider: 'opencode',
          opencodeApiKey: 'test-key',
          opencodeModel: 'deepseek-v4.1-flash',
        })
      );

      const planSpy = vi.fn();
      const l1Mock: PlannerProvider = {
        id: 'opencode',
        plan: vi.fn(async () => {
          planSpy('L1');
          return {
            rawText: JSON.stringify({
              escalate: true,
              answer: 'Voy a revisar esto en profundidad.',
              actions: [],
            }),
            latencyMs: 90,
            model: 'deepseek-v4.1-flash',
          };
        }),
      };
      const l2Mock: PlannerProvider = {
        id: 'opencode',
        plan: vi.fn(async () => {
          planSpy('L2');
          return {
            rawText: JSON.stringify({
              reply: 'Propongo armar el ODD completo de seguridad.',
              actions: [
                {
                  type: 'propose_task',
                  targetKind: 'subagent',
                  title: 'ODD de Seguridad',
                  taskBrief: 'Diseñar el ODD completo de seguridad.',
                  mode: 'odd',
                  oddMode: true,
                },
              ],
            }),
            latencyMs: 220,
            model: 'deepseek-v4-pro',
          };
        }),
      };

      const res = await runOperatorTurn('diseña la arquitectura ODD de autenticación completa', {
        source: 'voz',
        ttsEnabled: false,
        context: { workspaceId: 'ws-kite', workspaceName: 'kite', mode: 'thread' },
        provider: l1Mock,
        diagnosisProvider: l2Mock,
      });

      expect(planSpy.mock.calls.map((c) => c[0])).toEqual(['L1', 'L2']);
      expect(res.plan.actions).toHaveLength(1);
      expect(res.plan.actions[0].type).toBe('propose_task');
    });

    it('permits optimistic spoken ack ONLY for safe async launches and strictly forbids it on destructive actions', () => {
      expect(
        getOptimisticAsyncAck({
          strategy: 'llm',
          actions: [
            {
              type: 'spawn_subagent',
              via: 'thread',
              mode: 'explore',
              task: 'Revisar auth',
            },
          ],
        })
      ).toMatch(/subagente|segundo plano/i);

      expect(
        getOptimisticAsyncAck({
          strategy: 'llm',
          actions: [{ type: 'close_terminals', target: 'all' }],
        })
      ).toBeNull();

      expect(
        getOptimisticAsyncAck({
          strategy: 'llm',
          actions: [{ type: 'cancel_proposal' }],
        })
      ).toBeNull();
    });
  });
});
