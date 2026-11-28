import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ipc from '../../../ipc';
import { executePlan } from '../index';
import { voiceSessionStore } from '../../voice/voiceSessionStore';

vi.mock('../../../ipc', () => ({
  isTauriEnvironment: vi.fn(() => true),
  invokeCommand: vi.fn().mockResolvedValue({}),
  getTicketSnapshot: vi.fn(),
  ticketCall: vi.fn(),
}));

describe('S2 / T2 — Native Kite Tasks Operator Capability (manage_tasks)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceSessionStore.clearDraftProposal('thread-tasks-1');
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
    vi.mocked(ipc.getTicketSnapshot).mockResolvedValue({
      schemaVersion: 1,
      revision: 3,
      issues: [
        {
          id: 'KITE-101',
          uuid: '550e8400-e29b-41d4-a716-446655440101',
          title: 'Corregir audio ducking en Windows',
          description: 'Ajustar ratio',
          state: 'To Do',
          priority: 'High',
          assignee: null,
          delegate: null,
          labels: ['voice-mode'],
          createdAt: '2026-11-24T00:00:00Z',
          updatedAt: '2026-11-24T00:00:00Z',
        },
        {
          id: 'KITE-102',
          uuid: '550e8400-e29b-41d4-a716-446655440102',
          title: 'Revisar layout de Tasks',
          description: '',
          state: 'In Progress',
          priority: 'Medium',
          assignee: null,
          delegate: null,
          labels: [],
          createdAt: '2026-11-24T00:00:00Z',
          updatedAt: '2026-11-24T00:00:00Z',
        },
        {
          id: 'KITE-103',
          uuid: '550e8400-e29b-41d4-a716-446655440103',
          title: 'Revisar layout de Settings',
          description: '',
          state: 'Review',
          priority: 'Low',
          assignee: null,
          delegate: null,
          labels: [],
          createdAt: '2026-11-24T00:00:00Z',
          updatedAt: '2026-11-24T00:00:00Z',
        },
      ],
    });
  });

  it('lists tasks with stateFilter and never speaks raw UUIDs', async () => {
    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'manage_tasks', operation: 'list', stateFilter: 'Todo', limit: 10 }],
      },
      { boundThreadId: 'thread-tasks-1' }
    );

    expect(res.overallSuccess).toBe(true);
    const receipt = res.receipts[0];
    expect(receipt.type).toBe('manage_tasks');
    expect((receipt.data as any).issues).toHaveLength(1);
    expect((receipt.data as any).issues[0].id).toBe('KITE-101');
    expect(receipt.spokenSummaryEs).toContain('KITE-101');
    expect(receipt.spokenSummaryEs).toContain('Corregir audio ducking en Windows');
    expect(receipt.spokenSummaryEs).not.toContain('550e8400');
  });

  it('creates a task stamping sourceAgent=Argos and sourceThreadId from context', async () => {
    vi.mocked(ipc.ticketCall).mockResolvedValue({
      ok: true,
      result: {
        id: 'KITE-104',
        uuid: '550e8400-e29b-41d4-a716-446655440104',
        title: 'Agregar test E2E de Argos',
        state: 'To Do',
      },
    });

    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_tasks',
            operation: 'create',
            title: 'Agregar test E2E de Argos',
            description: 'Cubrir flujo de voz',
            priority: 'High',
            oddPath: 'odd/tasks/argos-assistant-capabilities-v2.md',
          },
        ],
      },
      { boundThreadId: 'thread-tasks-1' }
    );

    expect(res.overallSuccess).toBe(true);
    expect(ipc.ticketCall).toHaveBeenCalledWith(
      'save_issue',
      expect.objectContaining({
        title: 'Agregar test E2E de Argos',
        description: 'Cubrir flujo de voz',
        priority: 'High',
        state: 'To Do',
        oddPath: 'odd/tasks/argos-assistant-capabilities-v2.md',
        sourceAgent: 'Argos',
        sourceThreadId: 'thread-tasks-1',
      })
    );
    expect(res.receipts[0].spokenSummaryEs).toContain('KITE-104');
    expect(res.receipts[0].spokenSummaryEs).not.toContain('550e8400');
  });

  it('moves state by exact taskId and rejects ambiguous title matches cleanly', async () => {
    vi.mocked(ipc.ticketCall).mockResolvedValue({
      ok: true,
      result: { id: 'KITE-101', title: 'Corregir audio ducking en Windows', state: 'Review' },
    });

    const okRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_tasks',
            operation: 'move_state',
            taskId: 'KITE-101',
            state: 'Review',
          },
        ],
      },
      { boundThreadId: 'thread-tasks-1' }
    );
    expect(okRes.overallSuccess).toBe(true);
    expect(ipc.ticketCall).toHaveBeenCalledWith(
      'save_issue',
      expect.objectContaining({ id: 'KITE-101', state: 'Review' })
    );

    const ambRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_tasks',
            operation: 'move_state',
            query: 'Revisar layout',
            state: 'Done',
          },
        ],
      },
      { boundThreadId: 'thread-tasks-1' }
    );
    expect(ambRes.overallSuccess).toBe(false);
    expect(ambRes.receipts[0].error).toBe('ambiguous_task_target');
    expect(ambRes.receipts[0].spokenSummaryEs).toContain('KITE-102');
    expect(ambRes.receipts[0].spokenSummaryEs).toContain('KITE-103');
  });

  it('requires consultative confirmation when moving multiple tasks without confirmed=true', async () => {
    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_tasks',
            operation: 'move_state',
            taskIds: ['KITE-101', 'KITE-102'],
            state: 'Done',
          },
        ],
      },
      { boundThreadId: 'thread-tasks-1' }
    );

    expect(res.overallSuccess).toBe(true);
    expect(ipc.ticketCall).not.toHaveBeenCalled();
    const proposal = voiceSessionStore.getDraftProposal('thread-tasks-1');
    expect(proposal).not.toBeNull();
    expect(res.receipts[0].spokenSummaryEs).toContain('Confirmás');
  });
});
