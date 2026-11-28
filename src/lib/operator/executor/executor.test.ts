import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePlan, executeOperatorCommand, composeReplyFromReceipts } from './index';
import { sendUiAck, type UiBusRequestPayload } from './ui-bus';
import * as terminalRegistry from '../../terminalRegistry';
import * as proactiveWatcher from '../proactiveWatcher';
import { appOperatorController } from '../appOperatorController';
import { emitTrace } from '../trace/trace';
import { invokeCommand } from '../../ipc';
import type { OperatorPlan } from '../contract';

vi.mock('../../ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({}),
}));

vi.mock('../trace/trace', () => ({
  emitTrace: vi.fn(),
}));

describe('Executor — Plan Execution & Postcondition Integration (Level B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).__kiteCodeWorkspaceMounted = true;
  });

  it('B1: Receptor presente -> open 2 terminales -> recibo ok -> reply honesto', async () => {
    let mockTerminals: Array<{ sessionId: string; engine: string }> = [];

    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockImplementation(() => mockTerminals as any);

    // Mock UI bus receiver (App & CodeWorkspace)
    const handleUiRequest = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (custom.detail.kind === 'navigate') {
        sendUiAck({ reqId: custom.detail.reqId, ok: true });
      } else if (custom.detail.kind === 'spawn-terminal') {
        const sid = (custom.detail.payload as any).sessionId || 'term-1';
        mockTerminals.push({ sessionId: sid, engine: 'grok' });
        sendUiAck({ reqId: custom.detail.reqId, ok: true, sessionId: sid });
      }
    };

    window.addEventListener('kite:op-request', handleUiRequest);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [{ type: 'open_terminals', count: 2, engine: 'grok', prompts: ['ejecutar test'] }],
    };

    const res = await executePlan(plan);

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts).toHaveLength(1);
    expect(res.receipts[0].ok).toBe(true);
    expect(res.reply).toContain('Abrí 2 terminales con grok');
    expect(res.reply).toContain('ejecutar test');

    window.removeEventListener('kite:op-request', handleUiRequest);
  });

  it('B2: Sin receptor (timeout) -> recibo ok:false y mensaje explicativo', async () => {
    // No listener attached to window -> will timeout
    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [{ type: 'open_terminals', count: 1, engine: 'grok' }],
    };

    const res = await executePlan(plan);

    expect(res.overallSuccess).toBe(false);
    expect(res.receipts[0].ok).toBe(false);
    expect(res.reply).toContain('No pude abrir las terminales');
  });

  it('B4: Verificación falla cuando registry no registra nuevas terminales', async () => {
    // Listener responds with ACK but does not update getActiveAgentTerminals
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([]);

    const handleUiRequest = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (custom.detail.kind === 'navigate') {
        sendUiAck({ reqId: custom.detail.reqId, ok: true });
      } else if (custom.detail.kind === 'spawn-terminal') {
        sendUiAck({ reqId: custom.detail.reqId, ok: true, sessionId: 'fake-id' });
      }
    };

    window.addEventListener('kite:op-request', handleUiRequest);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [{ type: 'open_terminals', count: 2, engine: 'grok' }],
    };

    const res = await executePlan(plan);

    expect(res.overallSuccess).toBe(false);
    expect(res.receipts[0].ok).toBe(false);
    expect(res.reply).toContain('Se esperaban 2 terminales nuevas con grok, pero solo se detectaron 0');

    window.removeEventListener('kite:op-request', handleUiRequest);
  });

  it('B5: Cierra terminal por nombre o índice', async () => {
    vi.spyOn(appOperatorController, 'closeTerminals').mockResolvedValue({
      success: true,
      message: 'Cerrando agente o terminal "Orion".',
      data: { closedSessionIds: ['term-orion'] },
    });
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([]);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [{ type: 'close_terminals', target: 'Orion' }],
    };

    const res = await executePlan(plan);
    expect(res.overallSuccess).toBe(true);
    expect(res.receipts[0].ok).toBe(true);
    expect(res.reply).toContain('Cerrando agente o terminal "Orion"');
  });

  it('compone respuestas conversacionales cuando no hay acciones planificadas', () => {
    const plan: OperatorPlan = {
      strategy: 'llm',
      actions: [],
      answer: '¡Hola! ¿En qué puedo ayudarte hoy?',
    };

    const reply = composeReplyFromReceipts(plan, []);
    expect(reply).toBe('¡Hola! ¿En qué puedo ayudarte hoy?');
  });
});

describe('T5/S1 — Universal action.verify & filtered-plan honesty', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    window.localStorage.clear();
    (window as any).__kiteCodeWorkspaceMounted = true;
  });

  it('emits action.verify for an action that reports no verification of its own', async () => {
    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [{ type: 'stop_speaking' }],
    };

    const res = await executePlan(plan, undefined, 'turn-verify-1');

    expect(res.receipts).toHaveLength(1);
    expect(res.receipts[0].verification).toEqual({
      ok: true,
      expected: { type: 'stop_speaking' },
      observed: { ok: true },
    });
    expect(emitTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-verify-1',
        ev: 'action.verify',
        actionIdx: 0,
        ok: true,
      })
    );
  });

  it('emits action.verify for every executed action, not only the first', async () => {
    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [{ type: 'stop_speaking' }, { type: 'open_browser', url: 'https://kite.dev' }],
    };

    const res = await executePlan(plan, undefined, 'turn-verify-2');

    expect(res.receipts).toHaveLength(2);
    expect(res.receipts[1].verification?.expected).toEqual({ type: 'open_browser' });
    const verifyEvents = vi
      .mocked(emitTrace)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.ev === 'action.verify');
    expect(verifyEvents).toHaveLength(2);
  });

  it('never reports overallSuccess when safety guards stripped every action', async () => {
    const plan: OperatorPlan = {
      strategy: 'llm',
      fallbackReason: 'filtered-unsafe-close',
      actions: [],
      reply: 'Entendido, no cerraré ninguna terminal.',
    };

    const res = await executePlan(plan, undefined, 'turn-filtered');

    expect(res.receipts).toHaveLength(0);
    expect(res.overallSuccess).toBe(false);
  });

  it('keeps reporting overallSuccess for a conversational plan with no actions', async () => {
    const plan: OperatorPlan = {
      strategy: 'llm',
      actions: [],
      answer: 'Hola, ¿en qué te ayudo?',
    };

    const res = await executePlan(plan, undefined, 'turn-conversational');

    expect(res.overallSuccess).toBe(true);
  });
});

describe('T5/S4 — close_terminals filter precedence & post-IPC exit', () => {
  const antigravityOne = {
    sessionId: 'term-agy-1',
    who: 'Nova',
    title: 'Nova (antigravity)',
    engine: 'antigravity',
    state: 'working',
    latestLine: null,
    updatedAt: 1,
  };
  const grokOne = {
    sessionId: 'term-grok-1',
    who: 'Orion',
    title: 'Orion (grok)',
    engine: 'grok',
    state: 'working',
    latestLine: null,
    updatedAt: 2,
  };
  const antigravityTwo = {
    sessionId: 'term-agy-2',
    who: 'Echo',
    title: 'Echo (antigravity)',
    engine: 'antigravity',
    state: 'idle',
    latestLine: null,
    updatedAt: 3,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('applies the engine filter before the generic "abiertas" wildcard and slices from the first match', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
      antigravityOne,
      grokOne,
      antigravityTwo,
    ] as any);
    const exitedSpy = vi.spyOn(terminalRegistry, 'markTerminalExited').mockImplementation(() => {});
    const suppressSpy = vi
      .spyOn(proactiveWatcher, 'suppressProactiveAnnouncement')
      .mockImplementation(() => {});

    const res = await appOperatorController.closeTerminals('las abiertas de antigravity', undefined, 1);

    expect(res.success).toBe(true);
    expect(res.data?.closedSessionIds).toEqual(['term-agy-1']);
    expect(suppressSpy).toHaveBeenCalledWith('term-agy-1');
    expect(exitedSpy).toHaveBeenCalledWith('term-agy-1');
    expect(exitedSpy).not.toHaveBeenCalledWith('term-grok-1');
    expect(invokeCommand).toHaveBeenCalledWith(
      'dispatch_kill',
      expect.objectContaining({ address: 'session:term-agy-1' })
    );
  });

  it('does not mark a terminal exited when the terminate IPC call itself throws', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([antigravityOne] as any);
    const exitedSpy = vi.spyOn(terminalRegistry, 'markTerminalExited').mockImplementation(() => {});
    vi.mocked(invokeCommand).mockRejectedValueOnce(new Error('pty session already gone'));

    const res = await appOperatorController.closeTerminals('antigravity');

    expect(exitedSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
  });

  it('does not mark a terminal exited when dispatch_kill returns a failed receipt', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([antigravityOne] as any);
    const exitedSpy = vi.spyOn(terminalRegistry, 'markTerminalExited').mockImplementation(() => {});
    vi.mocked(invokeCommand).mockResolvedValueOnce({
      status: 'failed',
      error: 'destination_gone',
    } as any);

    const res = await appOperatorController.closeTerminals('antigravity');

    expect(exitedSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
  });
});

describe('T5/S7 — handoff_to_agent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    window.localStorage.clear();
    (window as any).__kiteCodeWorkspaceMounted = true;
  });

  it('extracts the ODD path from the source buffer and hands it to a new agent of the requested engine', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
      {
        sessionId: 'term-planner-1',
        who: 'Orion',
        title: 'Orion (opencode)',
        engine: 'opencode',
        state: 'done',
        latestLine: 'ODD listo',
        updatedAt: 10,
      },
    ] as any);
    vi.spyOn(terminalRegistry, 'getTerminalRollingBuffer').mockReturnValue(
      'Escribí el documento en odd/tasks/zed-assistant-overhaul.md\nListo para implementar.'
    );

    const spawnDetails: any[] = [];
    const onSpawn = (e: Event) => spawnDetails.push((e as CustomEvent).detail);
    window.addEventListener('kite:spawn-agent-terminal', onSpawn);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [
        {
          type: 'handoff_to_agent',
          sourceTarget: 'Orion',
          targetEngine: 'claude',
          spawnNew: true,
          artifactKind: 'odd',
        },
      ],
    };

    const res = await executePlan(plan, { workspaceId: 'ws-1' });
    window.removeEventListener('kite:spawn-agent-terminal', onSpawn);

    expect(res.overallSuccess).toBe(true);
    expect(spawnDetails).toHaveLength(1);
    expect(spawnDetails[0].engine).toBe('claude');
    expect(spawnDetails[0].sourceSessionId).toBe('term-planner-1');
    expect(spawnDetails[0].label).toContain('zed-assistant-overhaul.md');
    expect(spawnDetails[0].initialPrompt).toContain('odd/tasks/zed-assistant-overhaul.md');
    expect(res.receipts[0].summaryEs).toContain('Orion');
  });

  it('reports an honest failure when the source terminal cannot be found', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([] as any);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [
        {
          type: 'handoff_to_agent',
          sourceTarget: 'Nova',
          spawnNew: true,
          artifactKind: 'odd',
        },
      ],
    };

    const res = await executePlan(plan, { workspaceId: 'ws-1' });

    expect(res.overallSuccess).toBe(false);
    expect(res.receipts[0].ok).toBe(false);
    expect(res.receipts[0].error).toBe('source_terminal_not_found');
  });

  it('pipes into an existing target terminal when spawnNew is false', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
      {
        sessionId: 'term-planner-1',
        who: 'Orion',
        title: 'Orion (opencode)',
        engine: 'opencode',
        state: 'done',
        latestLine: 'ODD listo',
        updatedAt: 10,
      },
      {
        sessionId: 'term-builder-1',
        who: 'Echo',
        title: 'Echo (claude)',
        engine: 'claude',
        state: 'idle',
        latestLine: 'Esperando',
        updatedAt: 20,
      },
    ] as any);
    vi.spyOn(terminalRegistry, 'getTerminalRollingBuffer').mockReturnValue(
      'odd/tasks/zed-assistant-overhaul.md'
    );
    const injectSpy = vi
      .spyOn(appOperatorController, 'injectPrompt')
      .mockResolvedValue({ success: true, message: 'Prompt inyectado.' });

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [
        {
          type: 'handoff_to_agent',
          sourceTarget: 'Orion',
          targetSession: 'Echo',
          spawnNew: false,
          artifactKind: 'odd',
        },
      ],
    };

    const res = await executePlan(plan, { workspaceId: 'ws-1' });

    expect(res.overallSuccess).toBe(true);
    expect(injectSpy).toHaveBeenCalledWith(
      'term-builder-1',
      expect.stringContaining('odd/tasks/zed-assistant-overhaul.md'),
      expect.objectContaining({ sourceSessionId: 'term-planner-1' })
    );
  });

  it('automatically resolves the terminal that has an ODD when sourceTarget is "active"', async () => {
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockReturnValue([
      {
        sessionId: 'term-shell-1',
        who: 'Terminal 1',
        title: 'Terminal 1',
        engine: 'powershell',
        state: 'idle',
        latestLine: 'PS C:\\>',
        updatedAt: 10,
      },
      {
        sessionId: 'term-orion-1',
        who: 'Orion',
        title: 'Orion (antigravity)',
        engine: 'antigravity',
        state: 'waitingForYou',
        latestLine: 'Listo para implementar',
        updatedAt: 20,
      },
    ] as any);
    vi.spyOn(terminalRegistry, 'getTerminalRollingBuffer').mockImplementation((id: string) => {
      if (id === 'term-orion-1') {
        return 'Generé la especificación en odd/tasks/settings-consolidation-and-overhaul.md';
      }
      return 'Get-Process';
    });

    const spawnDetails: any[] = [];
    const onSpawn = (e: Event) => spawnDetails.push((e as CustomEvent).detail);
    window.addEventListener('kite:spawn-agent-terminal', onSpawn);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [
        {
          type: 'handoff_to_agent',
          sourceTarget: 'active',
          targetEngine: 'grok',
          spawnNew: true,
          artifactKind: 'odd',
        },
      ],
    };

    const res = await executePlan(plan, { workspaceId: 'ws-1' });
    window.removeEventListener('kite:spawn-agent-terminal', onSpawn);

    expect(res.overallSuccess).toBe(true);
    expect(spawnDetails).toHaveLength(1);
    expect(spawnDetails[0].engine).toBe('grok');
    expect(spawnDetails[0].sourceSessionId).toBe('term-orion-1');
    expect(spawnDetails[0].initialPrompt).toContain('settings-consolidation-and-overhaul.md');
    expect(res.receipts[0].summaryEs).toContain('Orion');
    expect(res.receipts[0].summaryEs).toContain('settings-consolidation-and-overhaul.md');
  });
});

describe('T5/S8 — manage_pane_layout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('dispatches the equalize request and reports a Spanish receipt', async () => {
    const details: any[] = [];
    const onLayout = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener('kite:operator-pane-layout', onLayout);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [{ type: 'manage_pane_layout', operation: 'equalize' }],
    };

    const res = await executePlan(plan, { workspaceId: 'ws-1' });
    window.removeEventListener('kite:operator-pane-layout', onLayout);

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual(
      expect.objectContaining({ operation: 'equalize', workspaceId: 'ws-1' })
    );
    expect(res.overallSuccess).toBe(true);
    expect(res.receipts[0].summaryEs).toContain('Autoajusté');
  });
});

describe('T5/S9 — switch_workspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    window.localStorage.clear();
    (window as any).__kiteCodeWorkspaceMounted = true;
  });

  it('switches workspace, changes view mode and retargets a chained open_terminals', async () => {
    window.localStorage.setItem(
      'kite.cached_workspaces',
      JSON.stringify([
        { id: 'ws-alpha', displayName: 'Alpha Project', path: '/code/alpha' },
        { id: 'ws-beta', displayName: 'Beta Project', path: '/code/beta' },
      ])
    );

    const terminals: any[] = [];
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockImplementation(() => terminals as any);

    const selections: any[] = [];
    const modes: any[] = [];
    const spawnPayloads: any[] = [];

    const onSelect = (e: Event) => selections.push((e as CustomEvent).detail);
    const onMode = (e: Event) => modes.push((e as CustomEvent).detail);

    const handleUiRequest = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (custom.detail.kind === 'navigate') {
        sendUiAck({ reqId: custom.detail.reqId, ok: true });
      } else if (custom.detail.kind === 'spawn-terminal') {
        spawnPayloads.push(custom.detail.payload);
        const sid = (custom.detail.payload as any).sessionId || 'term-new';
        terminals.push({ sessionId: sid, engine: 'powershell', workspaceId: 'ws-beta' });
        sendUiAck({ reqId: custom.detail.reqId, ok: true, sessionId: sid });
      }
    };

    window.addEventListener('kite:select-workspace', onSelect);
    window.addEventListener('kite:navigate-mode', onMode);
    window.addEventListener('kite:op-request', handleUiRequest);

    const plan: OperatorPlan = {
      strategy: 'heuristic',
      actions: [
        { type: 'switch_workspace', workspaceQuery: 'beta', viewMode: 'agents' },
        { type: 'open_terminals', count: 1, engine: 'powershell' },
      ],
    };
    const context = { workspaceId: 'ws-alpha' };
    const res = await executePlan(plan, context);

    window.removeEventListener('kite:select-workspace', onSelect);
    window.removeEventListener('kite:navigate-mode', onMode);
    window.removeEventListener('kite:op-request', handleUiRequest);

    expect(selections).toHaveLength(1);
    expect(selections[0]).toEqual(
      expect.objectContaining({ workspaceId: 'ws-beta', workspaceName: 'Beta Project' })
    );
    expect(modes).toEqual([{ mode: 'agents' }]);
    expect(context.workspaceId).toBe('ws-beta');
    expect(spawnPayloads).toHaveLength(1);
    expect(spawnPayloads[0].workspaceId).toBe('ws-beta');
    expect(res.overallSuccess).toBe(true);
    expect(res.reply).toContain('Beta Project');
  });
});

describe('T3 / S3 — launch_thread', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    (window as any).__kiteCodeWorkspaceMounted = true;
  });

  function watchTerminalSpawns() {
    const spawns: unknown[] = [];
    const navigates: unknown[] = [];
    const modes: unknown[] = [];
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<UiBusRequestPayload>).detail;
      if (detail?.kind === 'spawn-terminal') spawns.push(detail.payload);
      if (detail?.kind === 'navigate') navigates.push(detail.payload);
    };
    const onLegacySpawn = (event: Event) => spawns.push((event as CustomEvent).detail);
    const onMode = (event: Event) => modes.push((event as CustomEvent).detail);
    window.addEventListener('kite:op-request', onRequest);
    window.addEventListener('kite:spawn-agent-terminal', onLegacySpawn);
    window.addEventListener('kite:navigate-mode', onMode);
    return {
      spawns,
      navigates,
      modes,
      stop() {
        window.removeEventListener('kite:op-request', onRequest);
        window.removeEventListener('kite:spawn-agent-terminal', onLegacySpawn);
        window.removeEventListener('kite:navigate-mode', onMode);
      },
    };
  }

  it('submits a new thread through dispatch and does not spawn a terminal', async () => {
    vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'create_general_chat') return { id: 'thread-new' };
      if (cmd === 'dispatch_send') return { status: 'submitted' };
      return {};
    });
    const watch = watchTerminalSpawns();

    const res = await executeOperatorCommand('abre un thread para revisar el login', 'ws-1');
    watch.stop();

    expect(res.success).toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith(
      'create_general_chat',
      expect.objectContaining({ workspaceId: 'ws-1' })
    );
    const createArgs = vi.mocked(invokeCommand).mock.calls.find((call) => call[0] === 'create_general_chat')?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(createArgs).not.toHaveProperty('provider');
    expect(invokeCommand).toHaveBeenCalledWith('dispatch_send', {
      address: 'thread:thread-new',
      body: expect.stringMatching(/revisar el login/i),
      caller: 'agent',
    });
    expect(invokeCommand).not.toHaveBeenCalledWith('start_chat_turn', expect.anything());
    expect(watch.spawns).toHaveLength(0);
    expect(watch.navigates).toHaveLength(0);
    expect(watch.modes).toHaveLength(0);
    expect(res.data?.map((receipt: { type: string }) => receipt.type)).toEqual(['launch_thread']);
  });

  it('does not create a thread when the person named one', async () => {
    vi.mocked(invokeCommand).mockResolvedValue({ status: 'submitted' } as any);
    const watch = watchTerminalSpawns();

    const res = await executePlan({
      strategy: 'heuristic',
      actions: [{ type: 'launch_thread', threadId: 'auth-1', body: 'revisa el login' }],
    } as OperatorPlan);
    watch.stop();

    expect(res.overallSuccess).toBe(true);
    expect(invokeCommand).not.toHaveBeenCalledWith('create_general_chat', expect.anything());
    expect(invokeCommand).toHaveBeenCalledWith('dispatch_send', {
      address: 'thread:auth-1',
      body: 'revisa el login',
      caller: 'agent',
    });
    expect(invokeCommand).not.toHaveBeenCalledWith('start_chat_turn', expect.anything());
    expect(watch.spawns).toHaveLength(0);
    expect(watch.navigates).toHaveLength(0);
  });

  it('reports a failed thread launch and does not retry it as a terminal', async () => {
    vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'create_general_chat') throw new Error('el hilo no se pudo crear');
      return {};
    });
    const watch = watchTerminalSpawns();

    const res = await executeOperatorCommand('abre un thread');
    watch.stop();

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no pude abrir el hilo/i);
    expect(res.message).not.toMatch(/terminal/i);
    expect(watch.spawns).toHaveLength(0);
    expect(watch.navigates).toHaveLength(0);
    expect(watch.modes).toHaveLength(0);
    expect(invokeCommand).not.toHaveBeenCalledWith('start_terminal', expect.anything());
    expect(invokeCommand).not.toHaveBeenCalledWith('start_chat_turn', expect.anything());
    expect(res.data?.some((receipt: { type: string }) => receipt.type === 'open_terminals')).toBe(false);
  });

  it('reports a rejected thread send and does not open a terminal instead', async () => {
    vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'create_general_chat') return { id: 'thread-new' };
      if (cmd === 'dispatch_send') return { status: 'rejected', error: 'destino bloqueado' };
      return {};
    });
    const watch = watchTerminalSpawns();

    const res = await executeOperatorCommand('abre un thread para revisar el login');
    watch.stop();

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no pude enviar el mensaje al hilo/i);
    expect(watch.spawns).toHaveLength(0);
    expect(res.data?.map((receipt: { type: string }) => receipt.type)).toEqual(['launch_thread']);
  });

  it('does not call create_general_chat when the person asked for a terminal', async () => {
    const terminals: Array<{ sessionId: string; engine: string }> = [];
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockImplementation(() => terminals as any);
    const handleUiRequest = (event: Event) => {
      const custom = event as CustomEvent<UiBusRequestPayload>;
      if (custom.detail.kind === 'navigate') {
        sendUiAck({ reqId: custom.detail.reqId, ok: true });
      } else if (custom.detail.kind === 'spawn-terminal') {
        const sid = (custom.detail.payload as { sessionId?: string }).sessionId || 'term-1';
        terminals.push({ sessionId: sid, engine: 'powershell' });
        sendUiAck({ reqId: custom.detail.reqId, ok: true, sessionId: sid });
      }
    };
    window.addEventListener('kite:op-request', handleUiRequest);

    const res = await executeOperatorCommand('abre una terminal');
    window.removeEventListener('kite:op-request', handleUiRequest);

    expect(res.success).toBe(true);
    expect(res.message).toMatch(/terminal/i);
    expect(invokeCommand).not.toHaveBeenCalledWith('create_general_chat', expect.anything());
    expect(terminals).toHaveLength(1);
  });
});

describe('T17 / S9-S10 — Spoken summary separation & real Thread/Subagent/Agent ODD delegation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    const { voiceSessionStore } = await import('../voice/voiceSessionStore');
    voiceSessionStore.stopSession();
    (window as any).__kiteCodeWorkspaceMounted = true;
  });

  it('S9: keeps spoken reply concise for open_terminals when prompt exceeds 80 chars instead of reciting the full prompt', async () => {
    const terminals: Array<{ sessionId: string; engine: string }> = [];
    vi.spyOn(terminalRegistry, 'getActiveAgentTerminals').mockImplementation(() => terminals as any);

    const handleUiRequest = (event: Event) => {
      const detail = (event as CustomEvent<UiBusRequestPayload>).detail;
      if (detail.kind === 'navigate') {
        sendUiAck({ reqId: detail.reqId, ok: true });
      } else if (detail.kind === 'spawn-terminal') {
        const sid = (detail.payload as any).sessionId || 'term-long-1';
        terminals.push({ sessionId: sid, engine: 'antigravity' });
        sendUiAck({ reqId: detail.reqId, ok: true, sessionId: sid });
      }
    };
    window.addEventListener('kite:op-request', handleUiRequest);

    const longPrompt =
      'Implementa las funcionalidades de orquestación del proyecto. Revisa primero el código existente relacionado con orquestación multiagente, identifica lo que falta por completar y propón un plan completo.';

    const res = await executePlan({
      strategy: 'llm',
      actions: [{ type: 'open_terminals', count: 1, engine: 'antigravity', prompts: [longPrompt] }],
    });
    window.removeEventListener('kite:op-request', handleUiRequest);

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts[0].summaryEs).toContain(longPrompt);
    expect(res.receipts[0].spokenSummaryEs).toBeDefined();
    expect(res.reply).not.toContain('Revisa primero el código existente');
    expect(res.reply).toContain('Abrí 1 terminal con antigravity');
  });

  it('S10: launch_thread with title & oddMode during active Thread Voice Mode renames thread, frames ODD brief, and stays in the voice call', async () => {
    const { voiceSessionStore } = await import('../voice/voiceSessionStore');
    voiceSessionStore.startSession('voice-thread-1', 'thread');

    vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'create_general_chat') return { id: 'delegated-thread-99' };
      if (cmd === 'rename_chat_thread') return {};
      if (cmd === 'dispatch_send') return { status: 'submitted' };
      return {};
    });

    const selectedThreads: unknown[] = [];
    const onSelect = (e: Event) => selectedThreads.push((e as CustomEvent).detail);
    window.addEventListener('kite:select-thread', onSelect);

    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'launch_thread',
            provider: 'antigravity',
            title: 'ODD de Notificaciones',
            body: 'Investiga y diseña el sistema de notificaciones.',
            oddMode: true,
          },
        ],
      },
      { workspaceId: 'ws-1', mode: 'thread', boundThreadId: 'voice-thread-1', voiceSessionActive: true }
    );

    window.removeEventListener('kite:select-thread', onSelect);
    voiceSessionStore.stopSession();

    expect(res.overallSuccess).toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith('rename_chat_thread', {
      supportedSchemaVersion: 1,
      threadId: 'delegated-thread-99',
      title: 'ODD de Notificaciones',
    });
    expect(invokeCommand).toHaveBeenCalledWith(
      'dispatch_send',
      expect.objectContaining({
        address: 'thread:delegated-thread-99',
        body: expect.stringMatching(/odd\/tasks\/<slug>\.md/i),
        caller: 'agent',
      })
    );
    // Must not steal UI focus away from active Thread Voice Mode call unless focusThread: true
    expect(selectedThreads).toHaveLength(0);
    expect(res.reply).not.toContain('delegated-thread-99');
    expect(res.reply).toMatch(/en segundo plano/i);
  });

  it('S10: launch_thread treats queued and settled dispatch_send statuses as success', async () => {
    vi.mocked(invokeCommand).mockResolvedValue({ status: 'queued' } as any);

    const res = await executePlan({
      strategy: 'llm',
      actions: [{ type: 'launch_thread', threadId: 'busy-thread-1', body: 'agrega pruebas de regresión' }],
    });

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts[0].ok).toBe(true);
  });

  it('S10: spawn_subagent dispatches a real Thread subagent via dispatch_run bound to active voice thread with ODD framing', async () => {
    const { voiceSessionStore } = await import('../voice/voiceSessionStore');
    voiceSessionStore.startSession('voice-parent-42', 'thread');

    vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'dispatch_run') {
        return { status: 'submitted', address: 'thread:sub-child-7' };
      }
      return {};
    });

    const spawnTermSpy = vi.spyOn(appOperatorController, 'spawnTerminals');

    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'spawn_subagent',
            provider: 'antigravity',
            role: 'ODD Planner',
            workspace: 'inherit',
            oddMode: true,
            task: 'Explorar permisos y armar plan de pruebas',
          },
        ],
      },
      { workspaceId: 'ws-1', mode: 'thread', boundThreadId: 'voice-parent-42', voiceSessionActive: true }
    );
    voiceSessionStore.stopSession();

    expect(res.overallSuccess).toBe(true);
    expect(spawnTermSpy).not.toHaveBeenCalled();
    expect(invokeCommand).toHaveBeenCalledWith(
      'dispatch_run',
      expect.objectContaining({
        via: 'thread',
        provider: 'antigravity',
        role: 'ODD Planner',
        workspaceMode: 'inherit',
        from: 'thread:voice-parent-42',
        parent: 'thread:voice-parent-42',
        wait: false,
        caller: 'agent',
        task: expect.stringMatching(/odd\/tasks\/<slug>\.md/i),
      })
    );
    expect(res.receipts[0].data).toEqual(
      expect.objectContaining({
        via: 'thread',
        role: 'ODD Planner',
        threadId: 'sub-child-7',
        parentThreadId: 'voice-parent-42',
        oddMode: true,
      })
    );
    expect(res.reply).toMatch(/subagente ODD Planner/i);
  });

  it('S10: spawn_subagent reports honest failure on dispatch_run rejection without opening a terminal', async () => {
    vi.mocked(invokeCommand).mockResolvedValue({
      status: 'rejected',
      error: 'subagent_limit_reached',
    } as any);
    const spawnTermSpy = vi.spyOn(appOperatorController, 'spawnTerminals');

    const res = await executePlan({
      strategy: 'llm',
      actions: [{ type: 'spawn_subagent', task: 'revisar módulo auth' }],
    });

    expect(res.overallSuccess).toBe(false);
    expect(spawnTermSpy).not.toHaveBeenCalled();
    expect(res.reply).toMatch(/subagent_limit_reached/i);
  });

  it('S10: launch_agent matches an Autonomous Agent profile, creates its chat, and starts an ODD-focused turn', async () => {
    const { voiceSessionStore } = await import('../voice/voiceSessionStore');
    voiceSessionStore.startSession('voice-thread-2', 'thread');

    vi.mocked(invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_agent_profiles') {
        return [
          { id: 'agent-sec-1', name: 'Security auditor', engine: 'claude', pinned: false },
        ];
      }
      if (cmd === 'create_agent_chat') return { id: 'agent-thread-55' };
      if (cmd === 'start_agent_chat_turn') return { runId: 'run-1' };
      return {};
    });

    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'launch_agent',
            agentQuery: 'security',
            body: 'Audita los endpoints de autenticación.',
            oddMode: true,
          },
        ],
      },
      { workspaceId: 'ws-1', mode: 'thread', boundThreadId: 'voice-thread-2', voiceSessionActive: true }
    );
    voiceSessionStore.stopSession();

    expect(res.overallSuccess).toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith('create_agent_chat', {
      agentId: 'agent-sec-1',
      workspaceId: 'ws-1',
      provider: 'claude',
    });
    expect(invokeCommand).toHaveBeenCalledWith(
      'start_agent_chat_turn',
      expect.objectContaining({
        agentId: 'agent-sec-1',
        threadId: 'agent-thread-55',
        provider: 'claude',
        prompt: expect.stringMatching(/odd\/tasks\/<slug>\.md/i),
      })
    );
    expect(res.reply).toMatch(/Security auditor/i);
  });

  it('S10: runOperatorTurn in thread voice mode does not hijack ODD/chat questions into terminal narrate_summary', async () => {
    const { runOperatorTurn } = await import('../index');
    const planSpy = vi.fn().mockResolvedValue({
      rawText: JSON.stringify({
        reply: 'Podemos armar primero el ODD de notificaciones y luego delegar la implementación a un subagente.',
        actions: [],
        answer: 'Podemos armar primero el ODD de notificaciones y luego delegar la implementación a un subagente.',
      }),
      latencyMs: 50,
      model: 'test-model',
    });

    const result = await runOperatorTurn('cuéntame cómo armamos el ODD de notificaciones', {
      mode: 'thread',
      source: 'voz',
      context: { mode: 'thread', voiceSessionActive: true, activeTerminals: [] },
      provider: {
        id: 'test-llm',
        plan: planSpy,
      } as any,
    });

    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(result.plan.actions).toEqual([]);
    expect(result.reply).toContain('ODD de notificaciones');
  });
});

describe('T9/S4.2 — Parallel DAG action wave execution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invokeCommand).mockResolvedValue({} as any);
    vi.clearAllMocks();
    window.localStorage.clear();
    (window as any).__kiteCodeWorkspaceMounted = true;
  });

  it('executes contiguous peek_* actions concurrently via Promise.allSettled and preserves actionIdx ordering', async () => {
    const events: string[] = [];
    const { ctxClient } = await import('../context/ctxClient');

    vi.spyOn(ctxClient, 'readCompact').mockImplementation(async (path: string) => {
      events.push(`start:${path}`);
      await new Promise((r) => setTimeout(r, path === 'src/slow.ts' ? 45 : 5));
      events.push(`end:${path}`);
      return { path, mode: 'signatures', content: `// ${path}`, source: 'fallback' };
    });

    const plan: OperatorPlan = {
      strategy: 'llm',
      actions: [
        { type: 'peek_files', path: 'src/slow.ts', mode: 'signatures' },
        { type: 'peek_runs', limit: 5 },
        { type: 'peek_files', path: 'src/fast.ts', mode: 'signatures' },
      ],
    };

    const res = await executePlan(plan, { workspaceId: 'ws-1' }, 'turn-dag-peek');

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts.map((r) => [r.actionIdx, r.type])).toEqual([
      [0, 'peek_files'],
      [1, 'peek_runs'],
      [2, 'peek_files'],
    ]);
    expect((res.receipts[0].data as any)?.path).toBe('src/slow.ts');
    expect((res.receipts[2].data as any)?.path).toBe('src/fast.ts');
    // Concurrent execution: fast file starts and ends while slow file is still awaiting.
    const startSlowIdx = events.indexOf('start:src/slow.ts');
    const startFastIdx = events.indexOf('start:src/fast.ts');
    const endFastIdx = events.indexOf('end:src/fast.ts');
    const endSlowIdx = events.indexOf('end:src/slow.ts');
    expect(startSlowIdx).toBeGreaterThanOrEqual(0);
    expect(startFastIdx).toBeGreaterThan(startSlowIdx);
    expect(endFastIdx).toBeLessThan(endSlowIdx);
  });

  it('executes multiple independent spawn_subagent actions in parallel and preserves actionIdx ordering', async () => {
    const events: string[] = [];

    vi.mocked(invokeCommand).mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'dispatch_run') {
        const role = args?.role || 'unknown';
        events.push(`start:${role}`);
        await new Promise((r) => setTimeout(r, role === 'Alpha' ? 40 : 5));
        events.push(`end:${role}`);
        return { status: 'submitted', address: `thread:child-${role}` };
      }
      return {};
    });

    const plan: OperatorPlan = {
      strategy: 'llm',
      actions: [
        { type: 'spawn_subagent', role: 'Alpha', task: 'Primera tarea', provider: 'claude' },
        { type: 'spawn_subagent', role: 'Beta', task: 'Segunda tarea', provider: 'grok' },
      ],
    };

    const res = await executePlan(plan, { workspaceId: 'ws-1', mode: 'thread' }, 'turn-dag-subagents');

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts.map((r) => [r.actionIdx, (r.data as any)?.role])).toEqual([
      [0, 'Alpha'],
      [1, 'Beta'],
    ]);
    expect(events.indexOf('start:Beta')).toBeLessThan(events.indexOf('end:Alpha'));
    expect(events.indexOf('end:Beta')).toBeLessThan(events.indexOf('end:Alpha'));
  });

  it('treats stateful actions (propose_task / switch_workspace) as wave barriers across parallel waves', async () => {
    const events: string[] = [];
    const { voiceSessionStore } = await import('../voice/voiceSessionStore');
    const { ctxClient } = await import('../context/ctxClient');
    voiceSessionStore.startSession('voice-barrier-1', 'thread');

    vi.spyOn(ctxClient, 'readCompact').mockImplementation(async (path: string) => {
      events.push('wave1:peek_files:start');
      await new Promise((r) => setTimeout(r, 25));
      events.push('wave1:peek_files:end');
      return { path, mode: 'signatures', content: '// ok', source: 'fallback' };
    });

    vi.mocked(invokeCommand).mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'dispatch_run') {
        const role = args?.role || 'sub';
        events.push(`wave3:${role}`);
        return { status: 'submitted', address: `thread:${role}` };
      }
      return {};
    });

    const plan: OperatorPlan = {
      strategy: 'llm',
      actions: [
        { type: 'peek_files', path: 'src/app.ts', mode: 'signatures' },
        { type: 'peek_runs', limit: 3 },
        {
          type: 'propose_task',
          targetKind: 'subagent',
          title: 'Propuesta barrera',
          taskBrief: 'Ejecutar después de peek',
        },
        { type: 'spawn_subagent', role: 'WorkerA', task: 'Post barrera A' },
        { type: 'spawn_subagent', role: 'WorkerB', task: 'Post barrera B' },
      ],
    };

    const res = await executePlan(
      plan,
      { workspaceId: 'ws-1', mode: 'thread', boundThreadId: 'voice-barrier-1', voiceSessionActive: true },
      'turn-dag-barriers'
    );
    voiceSessionStore.clearDraftProposal('voice-barrier-1');
    voiceSessionStore.stopSession();

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts.map((r) => r.actionIdx)).toEqual([0, 1, 2, 3, 4]);
    expect(res.receipts.map((r) => r.type)).toEqual([
      'peek_files',
      'peek_runs',
      'propose_task',
      'spawn_subagent',
      'spawn_subagent',
    ]);
    // Wave 1 must complete before Wave 3 subagents begin
    const wave1End = events.indexOf('wave1:peek_files:end');
    const wave3A = events.indexOf('wave3:WorkerA');
    const wave3B = events.indexOf('wave3:WorkerB');
    expect(wave1End).toBeGreaterThanOrEqual(0);
    expect(wave3A).toBeGreaterThan(wave1End);
    expect(wave3B).toBeGreaterThan(wave1End);
  });
});
