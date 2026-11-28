import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ipc from '../../../ipc';
import { executePlan } from '../index';
import { voiceSessionStore } from '../../voice/voiceSessionStore';

vi.mock('../../../ipc', () => ({
  isTauriEnvironment: vi.fn(() => true),
  invokeCommand: vi.fn().mockResolvedValue({}),
  listRoutines: vi.fn(),
  listAgentProfiles: vi.fn(),
}));

const AGENT_UUID = '550e8400-e29b-41d4-a716-446655440001';
const AGENT_LOCKED_UUID = '550e8400-e29b-41d4-a716-446655440002';
const ROUTINE_UUID = '550e8400-e29b-41d4-a716-446655440099';
const REVISION_HEX = 'a'.repeat(64);

describe('S4 / T4 — Routines & Autonomous Schedules Control (manage_routines)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceSessionStore.clearDraftProposal('thread-rot-1');
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
    vi.mocked(ipc.listAgentProfiles).mockResolvedValue([
      {
        id: AGENT_UUID,
        name: 'Nova',
        engine: 'claude',
        allowAgentScheduling: true,
      } as any,
      {
        id: AGENT_LOCKED_UUID,
        name: 'LockedBot',
        engine: 'codex',
        allowAgentScheduling: false,
      } as any,
    ]);
    vi.mocked(ipc.listRoutines).mockResolvedValue({
      schemaVersion: 1,
      routines: [
        {
          id: ROUTINE_UUID,
          agentId: AGENT_UUID,
          name: 'Nightly QA',
          prompt: 'Run test suite',
          cadence: { kind: 'interval', seconds: 3600 },
          enabled: true,
          author: 'builder',
          workspaceId: null,
          permissionMode: 'readOnly',
          createdAtUnixMs: 1000,
          nextRunAtUnixMs: 2000,
          lastRunAtUnixMs: null,
          lastRunThreadId: null,
          lastError: null,
        } as any,
      ],
      agentRevisions: [
        { agentId: AGENT_UUID, revision: REVISION_HEX },
        { agentId: AGENT_LOCKED_UUID, revision: 'b'.repeat(64) },
      ],
      runNowAvailability: { available: true, reason: '' },
    });
  });

  it('lists routines cleanly', async () => {
    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'manage_routines', operation: 'list' }],
      },
      { boundThreadId: 'thread-rot-1' }
    );

    expect(res.overallSuccess).toBe(true);
    expect(res.receipts[0].spokenSummaryEs).toContain('Nightly QA');
    expect((res.receipts[0].data as any).routines).toHaveLength(1);
  });

  it('toggles routine and runs routine now with agentId, expectedRevision, and non-nil requestId', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'set_routine_enabled') return { routines: [] };
      if (cmd === 'run_routine_now') return { started: true, threadId: 'thread-run-1', runId: 'run-1' };
      return {};
    });

    const toggleRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_routines',
            operation: 'toggle',
            routineQuery: 'Nightly QA',
            enabled: false,
          },
        ],
      },
      { boundThreadId: 'thread-rot-1' }
    );
    expect(toggleRes.overallSuccess).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'set_routine_enabled',
      expect.objectContaining({
        agentId: AGENT_UUID,
        routineId: ROUTINE_UUID,
        expectedRevision: REVISION_HEX,
        enabled: false,
      })
    );

    const runRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_routines',
            operation: 'run_now',
            routineQuery: 'Nightly QA',
          },
        ],
      },
      { boundThreadId: 'thread-rot-1' }
    );
    expect(runRes.overallSuccess).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'run_routine_now',
      expect.objectContaining({
        agentId: AGENT_UUID,
        routineId: ROUTINE_UUID,
        expectedRevision: REVISION_HEX,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      })
    );
  });

  it('requires consultative confirmation for create or fullAccess and honors allowAgentScheduling', async () => {
    // Locked agent rejects scheduling
    const lockedRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_routines',
            operation: 'create',
            name: 'Hourly Check',
            agentQuery: 'LockedBot',
            prompt: 'Check status',
            intervalSeconds: 1800,
            confirmed: true,
          },
        ],
      },
      { boundThreadId: 'thread-rot-1' }
    );
    expect(lockedRes.overallSuccess).toBe(false);
    expect(lockedRes.receipts[0].error).toBe('agent_scheduling_disabled');

    // Create without confirmed=true creates consultative proposal instead of mutating
    const proposeRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_routines',
            operation: 'create',
            name: 'Hourly Check',
            agentQuery: 'Nova',
            prompt: 'Check status',
            intervalSeconds: 1800,
            permissionMode: 'fullAccess',
          },
        ],
      },
      { boundThreadId: 'thread-rot-1' }
    );
    expect(proposeRes.overallSuccess).toBe(true);
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('create_routine', expect.anything());
    expect(voiceSessionStore.getDraftProposal('thread-rot-1')).not.toBeNull();

    // Confirmed create calls create_routine with exact Rust schema
    vi.mocked(ipc.invokeCommand).mockResolvedValue({ routines: [] });
    const confirmedRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'manage_routines',
            operation: 'create',
            name: 'Hourly Check',
            agentQuery: 'Nova',
            prompt: 'Check status',
            intervalSeconds: 1800,
            permissionMode: 'readOnly',
            confirmed: true,
          },
        ],
      },
      { boundThreadId: 'thread-rot-1' }
    );
    expect(confirmedRes.overallSuccess).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'create_routine',
      expect.objectContaining({
        agentId: AGENT_UUID,
        expectedRevision: REVISION_HEX,
        draft: expect.objectContaining({
          name: 'Hourly Check',
          prompt: 'Check status',
          cadence: { kind: 'interval', seconds: 1800 },
          permissionMode: 'readOnly',
        }),
      })
    );
  });
});
