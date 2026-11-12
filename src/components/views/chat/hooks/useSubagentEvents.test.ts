import { describe, expect, it } from 'vitest';
import type { ExtendedChatThread } from '../types';
import { applySubagentEvent } from './useSubagentEvents';

function makeThread(id = 'thread-1'): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: 'rev-1',
    id,
    profileId: null,
    provider: 'claude',
    title: 'Main',
    items: [],
    mode: 'acceptEdits',
    plan: false,
    model: 'claude-opus-4-6',
    status: 'running',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    workspaceId: null,
    pinned: false,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    subagentRuns: [],
    swarmState: null,
  };
}

describe('applySubagentEvent', () => {
  it('upserts subagent runs, merges incremental steps, and applies swarmState updates', () => {
    const base = makeThread();
    const withRun = applySubagentEvent(base, {
      kind: 'subagentRunUpdated',
      threadId: 'thread-1',
      run: {
        subagentId: 'sub-1',
        parentThreadId: 'thread-1',
        parentToolCallId: 'call-1',
        role: 'Codebase Researcher',
        status: 'running',
        stepCount: 0,
        items: [],
        startedAtUnixMs: 10,
        updatedAtUnixMs: 10,
      },
    });
    expect(withRun.subagentRuns).toHaveLength(1);

    const withSteps = applySubagentEvent(withRun, {
      kind: 'subagentStepsUpdated',
      threadId: 'thread-1',
      subagentId: 'sub-1',
      stepCount: 2,
      latestActivity: 'Reading threads.rs',
      items: [
        {
          id: 'step-1',
          kind: 'tool',
          title: 'Reading threads.rs',
          detail: null,
          text: '',
          status: 'completed',
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 20,
          attachments: [],
        },
      ],
    });
    expect(withSteps.subagentRuns?.[0]?.stepCount).toBe(2);
    expect(withSteps.subagentRuns?.[0]?.latestActivity).toBe('Reading threads.rs');
    expect(withSteps.subagentRuns?.[0]?.items).toHaveLength(1);

    const withSwarm = applySubagentEvent(withSteps, {
      kind: 'swarmStateUpdated',
      threadId: 'thread-1',
      swarmState: {
        swarmId: 'swarm_1',
        title: 'Parser Fix',
        coordinatorModel: 'claude-opus-4-6',
        members: [],
        posts: [],
        channels: [{ name: 'main', archived: false }],
      },
    });
    expect(withSwarm.swarmState?.title).toBe('Parser Fix');
    expect(withSwarm.swarmId).toBe('swarm_1');
  });
});
