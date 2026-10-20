import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOperatorAuditLog,
  recordOperatorAudit,
  clearOperatorAuditLog,
  subscribeToOperatorAuditLog,
} from './operatorLog';

describe('operatorLog', () => {
  beforeEach(() => {
    clearOperatorAuditLog();
  });

  it('records an audit entry and retrieves it', () => {
    const entry = recordOperatorAudit({
      input: 'Abre 2 terminales',
      provider: 'local',
      model: 'local-heuristic-v1',
      latencyMs: 12,
      usedFallbackLocal: true,
      reply: 'Abriendo 2 terminales.',
      actionsPlanned: [{ type: 'open_terminals', count: 2 }],
      executionResults: [
        {
          actionType: 'open_terminals',
          description: 'Abrir 2 terminales',
          status: 'success',
        },
      ],
      overallSuccess: true,
    });

    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.overallSuccess).toBe(true);

    const log = getOperatorAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].input).toBe('Abre 2 terminales');
    expect(log[0].executionResults[0].status).toBe('success');
  });

  it('notifies subscribers when a new entry is recorded', () => {
    let capturedLogCount = 0;
    const unsubscribe = subscribeToOperatorAuditLog((log) => {
      capturedLogCount = log.length;
    });

    recordOperatorAudit({
      input: 'Cierra las terminales',
      provider: 'opencode',
      model: 'opencode/kimi-k2.5',
      latencyMs: 150,
      usedFallbackLocal: false,
      reply: 'Cerrando terminales.',
      actionsPlanned: [],
      executionResults: [],
      overallSuccess: true,
    });

    expect(capturedLogCount).toBe(1);
    unsubscribe();
  });

  it('clears audit log correctly', () => {
    recordOperatorAudit({
      input: 'Test',
      provider: 'local',
      model: 'local',
      latencyMs: 5,
      usedFallbackLocal: true,
      reply: 'Ok',
      actionsPlanned: [],
      executionResults: [],
      overallSuccess: true,
    });

    expect(getOperatorAuditLog().length).toBe(1);
    clearOperatorAuditLog();
    expect(getOperatorAuditLog().length).toBe(0);
  });
});
