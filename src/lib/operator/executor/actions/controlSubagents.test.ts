import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ipc from '../../../ipc';
import { ctxClient } from '../../context/ctxClient';
import { executePlan } from '../index';

vi.mock('../../../ipc', () => ({
  isTauriEnvironment: vi.fn(() => true),
  invokeCommand: vi.fn().mockResolvedValue({}),
  listAllSubagentRuns: vi.fn(),
  sendSubagentMessage: vi.fn(),
  stopSubagentRun: vi.fn(),
  getThreadSubagentDetail: vi.fn(),
  getThreadSwarmState: vi.fn(),
  swarmPostFromUi: vi.fn(),
  swarmKillWorkerFromUi: vi.fn(),
}));

describe('S3 / T3 — Active Subagent Lifecycle & Swarm Coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxClient.resetForTests();
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
    vi.mocked(ipc.listAllSubagentRuns).mockResolvedValue({
      totalCount: 2,
      activeCount: 1,
      waitingCount: 0,
      runs: [
        {
          threadId: 'thread-parent',
          threadTitle: 'Parent',
          run: {
            subagentId: 'sub-run-1',
            childThreadId: 'child-running-1',
            parentThreadId: 'thread-parent',
            parentToolCallId: 'tc-1',
            role: 'Explorer',
            provider: 'claude',
            status: 'running',
            prompt: 'Inspect auth',
            stepCount: 2,
            items: [],
            startedAtUnixMs: 1000,
            updatedAtUnixMs: 2000,
          },
        },
        {
          threadId: 'thread-parent',
          threadTitle: 'Parent',
          run: {
            subagentId: 'sub-run-2',
            childThreadId: 'child-killed-2',
            parentThreadId: 'thread-parent',
            parentToolCallId: 'tc-2',
            role: 'Reviewer',
            provider: 'codex',
            status: 'killed',
            prompt: 'Review PR',
            stepCount: 3,
            items: [],
            startedAtUnixMs: 900,
            updatedAtUnixMs: 1500,
          },
        },
      ],
    });
  });

  it('control_subagent send succeeds on active subagent via sendSubagentMessage', async () => {
    vi.mocked(ipc.sendSubagentMessage).mockResolvedValue({ ok: true, run: null });

    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'control_subagent',
            operation: 'send',
            target: 'Explorer',
            message: 'Enfocate en window.rs',
          },
        ],
      },
      { boundThreadId: 'thread-parent' }
    );

    expect(res.overallSuccess).toBe(true);
    expect(ipc.sendSubagentMessage).toHaveBeenCalledWith(
      'thread-parent',
      'sub-run-1',
      'Enfocate en window.rs'
    );
    expect(res.receipts[0].spokenSummaryEs).toContain('Explorer');
  });

  it('control_subagent send blocks already killed/settled subagents with clear guidance', async () => {
    const res = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'control_subagent',
            operation: 'send',
            target: 'Reviewer',
            message: 'Seguí revisando',
          },
        ],
      },
      { boundThreadId: 'thread-parent' }
    );

    expect(res.overallSuccess).toBe(false);
    expect(ipc.sendSubagentMessage).not.toHaveBeenCalled();
    expect(res.receipts[0].error).toBe('subagent_already_settled');
    expect(res.receipts[0].spokenSummaryEs).toBe(
      'Ese subagente ya finalizó o fue detenido; ¿querés que lance uno nuevo?'
    );
  });

  it('control_subagent cancel stops running subagent and read_finding retrieves CcrStore output', async () => {
    vi.mocked(ipc.stopSubagentRun).mockResolvedValue({ ok: true, run: null });

    const cancelRes = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'control_subagent', operation: 'cancel', target: 1 }],
      },
      { boundThreadId: 'thread-parent' }
    );
    expect(cancelRes.overallSuccess).toBe(true);
    expect(ipc.stopSubagentRun).toHaveBeenCalledWith('thread-parent', 'sub-run-1');

    const hash = ctxClient.ccrStoreLocal('Hallazgo comprimido del Explorer');
    const findingRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'control_subagent',
            operation: 'read_finding',
            target: `<<ccr:${hash}>>`,
          },
        ],
      },
      { boundThreadId: 'thread-parent' }
    );
    expect(findingRes.overallSuccess).toBe(true);
    expect((findingRes.receipts[0].data as any).content).toContain('Hallazgo comprimido');
  });

  it('coordinate_swarm supports title, add, post, status, and kill', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'dispatch_run') {
        return { status: 'started', address: 'thread:worker-1', threadId: 'worker-1' };
      }
      return { ok: true };
    });
    vi.mocked(ipc.swarmPostFromUi).mockResolvedValue({
      ok: true,
      swarmState: { title: 'Auth Team', members: [] } as any,
    });
    vi.mocked(ipc.getThreadSwarmState).mockResolvedValue({
      title: 'Auth Team',
      members: [{ name: 'auditor', role: 'Auditor', status: 'working' }],
    } as any);
    vi.mocked(ipc.swarmKillWorkerFromUi).mockResolvedValue({ ok: true, swarmState: null });

    const addRes = await executePlan(
      {
        strategy: 'llm',
        actions: [
          {
            type: 'coordinate_swarm',
            operation: 'add',
            swarmName: 'Auth Team',
            members: [{ name: 'auditor', role: 'Auditor', provider: 'claude', brief: 'Auditar auth' }],
          },
        ],
      },
      { boundThreadId: 'thread-parent' }
    );
    expect(addRes.overallSuccess).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'dispatch_run',
      expect.objectContaining({ role: 'Auditor', provider: 'claude' })
    );

    const postRes = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'coordinate_swarm', operation: 'post', message: '@auditor avanza con T1' }],
      },
      { boundThreadId: 'thread-parent' }
    );
    expect(postRes.overallSuccess).toBe(true);
    expect(ipc.swarmPostFromUi).toHaveBeenCalledWith('thread-parent', '@auditor avanza con T1', null);

    const statusRes = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'coordinate_swarm', operation: 'status' }],
      },
      { boundThreadId: 'thread-parent' }
    );
    expect(statusRes.overallSuccess).toBe(true);
    expect(statusRes.receipts[0].spokenSummaryEs).toContain('Auth Team');

    const killRes = await executePlan(
      {
        strategy: 'llm',
        actions: [{ type: 'coordinate_swarm', operation: 'kill', targetMember: 'auditor' }],
      },
      { boundThreadId: 'thread-parent' }
    );
    expect(killRes.overallSuccess).toBe(true);
    expect(ipc.swarmKillWorkerFromUi).toHaveBeenCalledWith('thread-parent', 'auditor');
  });
});
