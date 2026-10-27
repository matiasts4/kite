import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseOperatorIntent,
  parseOperatorCommandLocal,
  executeOperatorCommand,
  dispatchOperatorCommand,
  formatActiveTerminalsContext,
} from './operatorBrain';
import { cleanTextForSpeech } from './ttsNarrator';
import { formatSummaryForSpeech, extractOutcomeFromBuffer } from './sessionContextHub';
import { appOperatorController } from './appOperatorController';
import { runLedger } from './runLedger';
import { planTurnLLM } from './planner/llm';
import { saveOperatorConfig, DEFAULT_OPERATOR_CONFIG } from './operatorConfig';
import * as operatorProvidersModule from './operatorProviders';
import * as terminalRegistry from '../terminalRegistry';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({}),
}));

vi.mock('./planner/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./planner/llm')>()),
  planTurnLLM: vi.fn(),
}));

describe('Operator Assistant & TTS', () => {
  beforeEach(() => {
    localStorage.clear();
    saveOperatorConfig(DEFAULT_OPERATOR_CONFIG);
    vi.clearAllMocks();
  });

  describe('parseOperatorIntent', () => {
    it('parses spawn terminal command with count and engine', () => {
      const intent = parseOperatorIntent('Abre 3 terminales con Grok');
      expect(intent.kind).toBe('SPAWN_TERMINALS');
      expect(intent.count).toBe(3);
      expect(intent.engine).toBe('grok');
    });

    it('parses spawn command with word numbers and prompt task', () => {
      const intent = parseOperatorIntent(
        'Abre dos terminales con codex con la tarea refactorizar los componentes'
      );
      expect(intent.kind).toBe('SPAWN_TERMINALS');
      expect(intent.count).toBe(2);
      expect(intent.engine).toBe('codex');
      expect(intent.prompt).toBe('refactorizar los componentes');
    });

    it('parses natural spawn command with connective "y" and prompt', () => {
      const intent = parseOperatorIntent('Abre una terminal y busca los errores en el proyecto');
      expect(intent.kind).toBe('SPAWN_TERMINALS');
      expect(intent.count).toBe(1);
      expect(intent.prompt).toBe('busca los errores en el proyecto');
    });

    it('parses audio STT punctuation anomaly and subjunctive verbs ("abriera dos. Terminales, en ellas abrirá Grok y ejecute los test")', () => {
      const intent = parseOperatorIntent('abriera dos. Terminales, en ellas abrirá Grok y ejecute los test');
      expect(intent.kind).toBe('SPAWN_TERMINALS');
      expect(intent.count).toBe(2);
      expect(intent.engine).toBe('grok');
      expect(intent.prompt).toBe('ejecute los test');
    });

    it('parses subjunctive and imperative variants e.g. "quiero que abras dos terminales" and "lanzame 2 terminales"', () => {
      const intent1 = parseOperatorIntent('quiero que abras dos terminales con grok');
      expect(intent1.kind).toBe('SPAWN_TERMINALS');
      expect(intent1.count).toBe(2);
      expect(intent1.engine).toBe('grok');

      const intent2 = parseOperatorIntent('lanzame dos terminales con grok');
      expect(intent2.kind).toBe('SPAWN_TERMINALS');
      expect(intent2.count).toBe(2);
      expect(intent2.engine).toBe('grok');
    });

    it('parses local command generation with prompt inclusion', () => {
      const res = parseOperatorCommandLocal('abrí dos terminales en ellas abrirá Grok y ejecute los test');
      expect(res.reply).toContain('Abriendo 2 terminales con grok para "ejecute los test".');
      expect(res.actions).toHaveLength(1);
      expect(res.actions[0]).toEqual({
        type: 'open_terminals',
        count: 2,
        engine: 'grok',
        prompts: ['ejecute los test'],
      });
    });

    it('parses close finished terminals command', () => {
      const intent = parseOperatorIntent('Cierra las terminales terminadas');
      expect(intent.kind).toBe('CLOSE_TERMINALS');
      expect(intent.target).toBe('finished');
    });

    it('parses close all terminals command', () => {
      const intent = parseOperatorIntent('Cierra todas las terminales');
      expect(intent.kind).toBe('CLOSE_TERMINALS');
      expect(intent.target).toBe('all');
    });

    it('parses summarize and speak command with terminal index', () => {
      const intent = parseOperatorIntent('Léeme el resumen de la terminal 2');
      expect(intent.kind).toBe('SUMMARIZE_AND_SPEAK');
      expect(intent.terminalIndex).toBe(2);
    });

    it('parses open browser command with URL', () => {
      const intent = parseOperatorIntent('Abre el navegador en https://github.com');
      expect(intent.kind).toBe('OPEN_BROWSER');
      expect(intent.url).toBe('https://github.com');
    });

    it('parses silence / stop speaking command', () => {
      const intent = parseOperatorIntent('Silencio');
      expect(intent.kind).toBe('STOP_SPEAKING');
    });

    it('parses seseo close command targeting named agent (e.g. "Sierra Orion")', () => {
      const intent = parseOperatorIntent('Sierra Orion');
      expect(intent.kind).toBe('CLOSE_TERMINALS');
      expect(intent.target).toBe('Orion');
    });

    it('parses direct close command targeting named agent (e.g. "Cierra Orion")', () => {
      const intent = parseOperatorIntent('Cierra Orion');
      expect(intent.kind).toBe('CLOSE_TERMINALS');
      expect(intent.target).toBe('Orion');
    });

    it('parses kill / terminate command targeting named agent ("Mata al agente Orion")', () => {
      const intent = parseOperatorIntent('Mata al agente Orion');
      expect(intent.kind).toBe('CLOSE_TERMINALS');
      expect(intent.target).toBe('Orion');
    });

    it('parses seseo variations like "serrar la terminal 2"', () => {
      const intent = parseOperatorIntent('serrar la terminal 2');
      expect(intent.kind).toBe('CLOSE_TERMINALS');
      expect(intent.target).toBe('2');
    });

    it('parses apaga / elimina variations like "elimina todas las terminales"', () => {
      const intent = parseOperatorIntent('elimina todas las terminales');
      expect(intent.kind).toBe('CLOSE_TERMINALS');
      expect(intent.target).toBe('all');
    });
  });

  describe('cleanTextForSpeech', () => {
    it('strips code blocks, markdown symbols, and emojis', () => {
      const input = `
# Resumen de cambios 🚀
El agente completó la tarea:
\`\`\`rust
fn main() { println!("Hello"); }
\`\`\`
Ver archivo en [main.rs](file:///E:/kite/src/main.rs). Todo listo ✅!
`;
      const cleaned = cleanTextForSpeech(input);
      expect(cleaned).not.toContain('```');
      expect(cleaned).not.toContain('🚀');
      expect(cleaned).not.toContain('✅');
      expect(cleaned).toContain('bloque de código omitido');
      expect(cleaned).toContain('Ver archivo en main.rs');
    });
  });

  describe('formatSummaryForSpeech & extractOutcomeFromBuffer', () => {
    it('formats multiple terminal summaries into spoken sentences', () => {
      const summaries = [
        {
          sessionId: 's-1',
          engine: 'grok',
          title: 'Grok Build',
          state: 'done' as const,
          latestLine: 'Build finished in 4s',
          extractedOutcome: 'Build finished in 4s',
          updatedAt: Date.now(),
        },
        {
          sessionId: 's-2',
          engine: 'codex',
          title: 'Codex',
          state: 'working' as const,
          latestLine: 'Compiling files...',
          extractedOutcome: 'Compiling files...',
          updatedAt: Date.now(),
        },
      ];

      const spoken = formatSummaryForSpeech(summaries, 'es');
      expect(spoken).toContain('Tienes 2 terminales activas');
      expect(spoken).toContain('Terminal 1, con Grok Build: ha terminado su tarea');
      expect(spoken).toContain('Terminal 2, con Codex: está trabajando activamente');
    });

    it('uses a short phrase when a single terminal has no recorded activity', () => {
      const spoken = formatSummaryForSpeech(
        [
          {
            sessionId: 's-empty',
            engine: 'grok',
            title: 'Grok',
            state: 'idle' as const,
            latestLine: null,
            extractedOutcome: 'Sin actividad registrada',
            updatedAt: Date.now(),
          },
        ],
        'es'
      );
      expect(spoken).toBe('No hay nada en esa terminal.');
    });

    it('extracts outcome from noisy buffer with spinners and escape characters', () => {
      const noisy = '⠋ Compiling...\r\n⠙ Compiling...\r\n✔ All tests passed successfully!\r\n';
      const outcome = extractOutcomeFromBuffer(noisy, null);
      expect(outcome).toContain('All tests passed successfully!');
    });
  });

  describe('executeOperatorCommand', () => {
    it('handles stop speaking command', async () => {
      const stopSpy = vi.spyOn(appOperatorController, 'stopSpeaking');
      const res = await executeOperatorCommand('Silencio');
      expect(res.success).toBe(true);
      expect(stopSpy).toHaveBeenCalled();
    });

    it('handles spawn terminal execution', async () => {
      const spawnSpy = vi.spyOn(appOperatorController, 'spawnTerminals').mockResolvedValueOnce({
        success: true,
        message: 'Se abrieron 3 terminales con grok.',
      });

      const res = await executeOperatorCommand('Abre 3 terminales con grok');
      expect(res.success).toBe(true);
      expect(spawnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          count: 3,
          engine: 'grok',
        })
      );
    });

    it('handles unknown commands gracefully with helpful instructions', async () => {
      const res = await executeOperatorCommand('hacer café');
      expect(res.success).toBe(false);
      expect(res.message).toContain('No reconocí el comando');
    });
  });

  describe('dispatchOperatorCommand', () => {
    it('handles immediate silence command with fast-path local-immediate-v1', async () => {
      const stopSpy = vi.spyOn(appOperatorController, 'stopSpeaking');
      const res = await dispatchOperatorCommand('Silencio');
      expect(res.provider).toBe('local');
      expect(res.model).toBe('local-immediate-v1');
      expect(res.reply).toBe('Lectura en voz alta detenida.');
      expect(res.actions).toEqual([{ type: 'stop_speaking' }]);
      expect(stopSpy).toHaveBeenCalled();
    });

    it('routes to local heuristic when activeProvider === "local"', async () => {
      saveOperatorConfig({ activeProvider: 'local' });
      vi.spyOn(appOperatorController, 'spawnTerminals').mockResolvedValueOnce({
        success: true,
        message: 'Se abrieron 2 terminales.',
      });

      const res = await dispatchOperatorCommand('Abre dos terminales con grok');
      expect(res.provider).toBe('local');
      expect(res.model).toBe('local-heuristic-v1');
      expect(res.actions[0].type).toBe('open_terminals');
    });

    it('routes commands to configured AI provider and executes returned actions', async () => {
      saveOperatorConfig({ activeProvider: 'opencode' });
      const spawnSpy = vi.spyOn(appOperatorController, 'spawnTerminals').mockResolvedValueOnce({
        success: true,
        message: '2 terminales creadas.',
      });

      const providerSpy = vi
        .spyOn(operatorProvidersModule, 'dispatchOperatorWithProvider')
        .mockResolvedValueOnce({
          provider: 'opencode',
          model: 'deepseek-v4.1-flash',
          latencyMs: 120,
          taskType: 'open_terminals',
          usedFallbackLocal: false,
          reply: 'Abriendo 2 terminales para analizar errores.',
          actions: [
            {
              type: 'open_terminals',
              count: 2,
              engine: 'codex',
              prompts: ['busca los errores'],
            },
          ],
          rawContent: '{"reply": "...", "actions": [...]}',
        });

      const res = await dispatchOperatorCommand('Abre dos terminales con codex y busca los errores');
      expect(providerSpy).toHaveBeenCalledTimes(1);
      expect(res.provider).toBe('opencode');
      expect(res.model).toBe('deepseek-v4.1-flash');
      expect(res.reply).toBe('Abriendo 2 terminales para analizar errores.');
      expect(spawnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          count: 2,
          engine: 'codex',
          prompts: ['busca los errores'],
        })
      );
      expect(res.executionResults?.[0].status).toBe('success');
    });

    it('passes active terminals context to remote provider and handles close_agent action alias', async () => {
      saveOperatorConfig({ activeProvider: 'opencode' });
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
        {
          sessionId: 'term-orion-123',
          who: 'Orion',
          title: 'Agent 1 (grok)',
          engine: 'grok',
          state: 'working',
          latestLine: 'Active',
          updatedAt: Date.now(),
        },
      ]);

      const closeSpy = vi.spyOn(appOperatorController, 'closeTerminals').mockResolvedValueOnce({
        success: true,
        message: 'Terminal cerrada con éxito.',
        data: { closedSessionIds: ['term-orion-123'] },
      });

      const providerSpy = vi
        .spyOn(operatorProvidersModule, 'dispatchOperatorWithProvider')
        .mockResolvedValueOnce({
          provider: 'opencode',
          model: 'deepseek-v4.1-flash',
          latencyMs: 150,
          taskType: 'close_terminals',
          usedFallbackLocal: false,
          reply: 'Cerrando el agente Orion.',
          actions: [
            {
              type: 'close_agent',
              target: 'Orion',
            },
          ],
          rawContent:
            '{"reply": "Cerrando el agente Orion.", "actions": [{"type": "close_agent", "target": "Orion"}]}',
        });

      const res = await dispatchOperatorCommand('Sierra Orion');
      expect(providerSpy).toHaveBeenCalledTimes(1);
      // Check that 3rd argument passed to provider was activeTerminalsContext containing Orion
      expect(providerSpy.mock.calls[0][2]).toContain('Orion');
      expect(closeSpy).toHaveBeenCalledWith('Orion');
      expect(res.reply).toBe('Cerrando el agente Orion.');
      expect(res.executionResults?.[0].status).toBe('success');
    });
  });

  describe('formatActiveTerminalsContext', () => {
    it('returns empty message when no terminals are active', () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValueOnce([]);
      const ctx = formatActiveTerminalsContext();
      expect(ctx).toContain('No hay terminales activas');
    });

    it('formats active terminals with agent names, engine, and status', () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValueOnce([
        {
          sessionId: 'term-orion-123',
          who: 'Orion',
          title: 'Agent 1 (grok)',
          engine: 'grok',
          state: 'working',
          latestLine: 'Running tests...',
          updatedAt: Date.now(),
        },
        {
          sessionId: 'term-atlas-456',
          who: 'Atlas',
          title: 'Agent 2 (codex)',
          engine: 'codex',
          state: 'idle',
          latestLine: 'Ready',
          updatedAt: Date.now(),
        },
      ]);
      const ctx = formatActiveTerminalsContext();
      expect(ctx).toContain('Terminales activas actualmente (2)');
      expect(ctx).toContain('Orion');
      expect(ctx).toContain('Atlas');
      expect(ctx).toContain('grok');
      expect(ctx).toContain('codex');
    });
  });

  describe('appOperatorController.closeTerminals', () => {
    it('resolves and closes terminal by agent name', async () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
        {
          sessionId: 'term-orion-123',
          who: 'Orion',
          title: 'Agent 1 (grok)',
          engine: 'grok',
          state: 'working',
          latestLine: 'Working',
          updatedAt: Date.now(),
        },
      ]);

      const res = await appOperatorController.closeTerminals('Orion');
      expect(res.success).toBe(true);
      expect(res.data?.closedSessionIds).toEqual(['term-orion-123']);
    });

    it('resolves and closes terminal by 1-based index', async () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
        {
          sessionId: 'term-1',
          who: 'AgentA',
          title: 'Title 1',
          engine: 'grok',
          state: 'working',
          latestLine: '',
          updatedAt: Date.now(),
        },
        {
          sessionId: 'term-2',
          who: 'AgentB',
          title: 'Title 2',
          engine: 'codex',
          state: 'working',
          latestLine: '',
          updatedAt: Date.now(),
        },
      ]);

      const res = await appOperatorController.closeTerminals(2);
      expect(res.success).toBe(true);
      expect(res.data?.closedSessionIds).toEqual(['term-2']);
    });

    it('closes multiple terminals atomically when compound target is passed (e.g. "1, 2" or array)', async () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
        { sessionId: 'term-1', engine: 'grok', title: 'Terminal 1', state: 'idle', updatedAt: 100, latestLine: null, who: 'Orion' },
        { sessionId: 'term-2', engine: 'grok', title: 'Terminal 2', state: 'idle', updatedAt: 100, latestLine: null, who: 'Nova' },
      ]);

      const res = await appOperatorController.closeTerminals('1, 2');
      expect(res.success).toBe(true);
      expect(res.data?.closedSessionIds).toEqual(['term-1', 'term-2']);
    });

    it('scopes closing to the specified workspaceId avoiding cross-project termination', async () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
        { sessionId: 'term-ws1', engine: 'grok', title: 'T1', state: 'idle', updatedAt: 100, latestLine: null, who: 'Orion', workspaceId: 'ws-1' },
        { sessionId: 'term-ws2', engine: 'antigravity', title: 'T2', state: 'idle', updatedAt: 100, latestLine: null, who: 'Nova', workspaceId: 'ws-2' },
      ]);

      // When scoped to ws-2, index 1 corresponds to term-ws2
      const res = await appOperatorController.closeTerminals(1, undefined, undefined, 'ws-2');
      expect(res.success).toBe(true);
      expect(res.data?.closedSessionIds).toEqual(['term-ws2']);
    });

    it('returns empty message if target not found', async () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([]);

      const res = await appOperatorController.closeTerminals('Inexistente');
      expect(res.success).toBe(false);
      expect(res.message).toContain('No se encontraron terminales');
    });

    it('still closes every open terminal for the generic wildcard target', async () => {
      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
        { sessionId: 'term-1', engine: 'grok', title: 'T1', state: 'idle', updatedAt: 100, latestLine: null, who: 'Orion' },
        { sessionId: 'term-2', engine: 'antigravity', title: 'T2', state: 'working', updatedAt: 100, latestLine: null, who: 'Nova' },
      ]);

      const res = await appOperatorController.closeTerminals('todas');
      expect(res.success).toBe(true);
      expect(res.data?.closedSessionIds).toEqual(['term-1', 'term-2']);
    });
  });

  describe('appOperatorController.injectPrompt', () => {
    it('writes the prompt through write_terminal when no terminal pane is mounted', async () => {
      const { invokeCommand } = await import('../ipc');

      const res = await appOperatorController.injectPrompt('term-1', 'corre los tests');

      expect(res.success).toBe(true);
      expect(vi.mocked(invokeCommand)).toHaveBeenCalledWith(
        'write_terminal',
        expect.objectContaining({ sessionId: 'term-1' })
      );
    });
  });

  describe('resolvePlannerProvider', () => {
    it('constructs Cloudflare OpenAiCompat planner with accountId and /ai/v1', async () => {
      const { resolvePlannerProvider } = await import('./index');
      const provider = resolvePlannerProvider({
        ...DEFAULT_OPERATOR_CONFIG,
        activeProvider: 'cloudflare',
        cloudflareAccountId: 'b5166808e3e6d420747e65b040d267df',
        cloudflareBaseUrl: 'https://api.cloudflare.com/client/v4/accounts',
      }) as any;

      expect(provider.id).toBe('cloudflare');
      expect(provider.baseUrl).toBe(
        'https://api.cloudflare.com/client/v4/accounts/b5166808e3e6d420747e65b040d267df/ai/v1'
      );
    });

    it('constructs Cloudflare gateway URL when gateway slug is configured', async () => {
      const { resolvePlannerProvider } = await import('./index');
      const provider = resolvePlannerProvider({
        ...DEFAULT_OPERATOR_CONFIG,
        activeProvider: 'cloudflare',
        cloudflareAccountId: 'b5166808e3e6d420747e65b040d267df',
        cloudflareGatewaySlug: 'my-gateway',
      }) as any;

      expect(provider.id).toBe('cloudflare');
      expect(provider.baseUrl).toBe(
        'https://gateway.ai.cloudflare.com/v1/b5166808e3e6d420747e65b040d267df/my-gateway/workers-ai'
      );
    });
  });

  describe('captureCurrentTurnContext workspace scoping', () => {
    it('filters active terminals strictly to the selected workspace and maps relative indices', async () => {
      const { captureCurrentTurnContext } = await import('./index');
      localStorage.setItem('kite.selectedWorkspaceId', 'ws-alpha');
      localStorage.setItem(
        'kite.cached_workspaces',
        JSON.stringify([
          { id: 'ws-alpha', displayName: 'Alpha Project', path: '/code/alpha' },
          { id: 'ws-beta', displayName: 'Beta Project', path: '/code/beta' },
        ])
      );

      vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
        { sessionId: 'term-b1', engine: 'claude', title: 'Beta 1', state: 'working', updatedAt: 100, latestLine: null, who: 'Echo', workspaceId: 'ws-beta' },
        { sessionId: 'term-a1', engine: 'antigravity', title: 'Alpha 1', state: 'idle', updatedAt: 200, latestLine: null, who: 'Orion', workspaceId: 'ws-alpha' },
        { sessionId: 'term-a2', engine: 'grok', title: 'Alpha 2', state: 'idle', updatedAt: 300, latestLine: null, who: 'Nova', workspaceId: 'ws-alpha' },
      ]);

      const ctx = captureCurrentTurnContext('code', 'ws-alpha');
      expect(ctx.workspaceId).toBe('ws-alpha');
      expect(ctx.workspaceName).toBe('Alpha Project');
      expect(ctx.workspacePath).toBe('/code/alpha');
      expect(ctx.activeTerminals).toHaveLength(2);
      expect(ctx.activeTerminals![0].sessionId).toBe('term-a1');
      expect(ctx.activeTerminals![0].idx).toBe(1);
      expect(ctx.activeTerminals![1].sessionId).toBe('term-a2');
      expect(ctx.activeTerminals![1].idx).toBe(2);
    });
  });
});

describe('runOperatorTurn — negation short-circuit & run ledger closure', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([]);
  });

  it('keeps a negated terminal imperative on the heuristic refusal plan instead of escalating to the LLM', async () => {
    const { runOperatorTurn } = await import('./index');
    vi.mocked(planTurnLLM).mockResolvedValue({ strategy: 'llm', actions: [], answer: 'ok' });

    const res = await runOperatorTurn('no cierres las terminales', {
      provider: { id: 'opencode' } as any,
      turnId: 'turn-negation-1',
    });

    expect(planTurnLLM).not.toHaveBeenCalled();
    expect(res.plan.actions).toEqual([]);
    expect(res.strategy).toBe('heuristic');
    expect(res.reply.toLowerCase()).toContain('terminal');
    expect(res.receipts).toEqual([]);
  });

  it('closes the run ledger run opened while planning the turn', async () => {
    const { runOperatorTurn } = await import('./index');
    vi.mocked(planTurnLLM).mockImplementationOnce(async (input, _provider, _context, turnId) => {
      const runId = turnId || 'llm-plan-run';
      if (!runLedger.getRun(runId)) {
        runLedger.startRun(input, { runId, taskType: 'llm_plan' });
      }
      return { strategy: 'llm', actions: [], answer: 'Todo listo.' };
    });

    const res = await runOperatorTurn('hola, ¿cómo vamos?', {
      provider: { id: 'opencode' } as any,
      turnId: 'turn-ledger-1',
    });

    const run = runLedger.getRun('turn-ledger-1');
    expect(res.turnId).toBe('turn-ledger-1');
    expect(run).toBeDefined();
    expect(typeof run?.completedAt).toBe('number');
    expect(run?.outcome).toBe('success');
  });

  it('records a quota failure on the turn when the model does not answer', async () => {
    const { runOperatorTurn } = await import('./index');
    const { getTurnTrace } = await import('./trace/trace');
    vi.mocked(planTurnLLM).mockResolvedValue({
      strategy: 'heuristic-fallback',
      actions: [],
      fallbackReason: 'Error HTTP 402 desde https://api.example/chat/completions: insufficient_quota',
    });

    const res = await runOperatorTurn('hola, ¿cómo vamos?', {
      provider: { id: 'opencode' } as any,
      turnId: 'turn-quota-1',
    });

    expect(res.overallSuccess).toBe(false);
    expect(getTurnTrace('turn-quota-1')?.error).toMatch(/sin cuota/i);
  });
});

