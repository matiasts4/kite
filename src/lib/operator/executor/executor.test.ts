import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePlan, composeReplyFromReceipts } from './index';
import { sendUiAck, type UiBusRequestPayload } from './ui-bus';
import * as terminalRegistry from '../../terminalRegistry';
import { appOperatorController } from '../appOperatorController';
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
