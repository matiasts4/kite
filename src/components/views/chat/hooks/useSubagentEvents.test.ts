import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtendedChatThread } from '../types';
import {
  applySubagentEvent,
  countRunningSubagents,
  shouldDispatchThreadsChanged,
  useSubagentEvents,
  type ChatSubagentEventPayload,
} from './useSubagentEvents';

const listenHandlers = vi.hoisted(() => new Map<string, (event: { payload: ChatSubagentEventPayload }) => void>());

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: ChatSubagentEventPayload }) => void) => {
    listenHandlers.set(eventName, handler);
    return () => {
      listenHandlers.delete(eventName);
    };
  }),
}));

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

  it('synthesizes a subagent run when subagentStepsUpdated arrives before subagentRunUpdated', () => {
    const base = makeThread();
    const updated = applySubagentEvent(base, {
      kind: 'subagentStepsUpdated',
      threadId: 'thread-1',
      subagentId: 'sub-early-1',
      childThreadId: 'child-1',
      role: 'Explorer',
      provider: 'gemini',
      model: 'gemini-3-flash',
      stepCount: 1,
      latestActivity: 'Reading Cargo.toml',
      status: 'running',
      items: [
        {
          id: 'early-step-1',
          kind: 'tool',
          title: 'Read Cargo.toml',
          detail: null,
          text: '',
          status: 'completed',
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 15,
          attachments: [],
        },
      ],
    });
    expect(updated.subagentRuns).toHaveLength(1);
    expect(updated.subagentRuns?.[0]?.childThreadId).toBe('child-1');
    expect(updated.subagentRuns?.[0]?.role).toBe('Explorer');
    expect(updated.subagentRuns?.[0]?.items).toHaveLength(1);
  });
});

describe('shouldDispatchThreadsChanged and useSubagentEvents sync', () => {
  afterEach(() => {
    vi.useRealTimers();
    listenHandlers.clear();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('matches run, swarm, and childThreadId/status step updates', () => {
    expect(shouldDispatchThreadsChanged(undefined)).toBe(false);
    expect(
      shouldDispatchThreadsChanged({
        kind: 'subagentStepsUpdated',
        threadId: 'thread-1',
        subagentId: 'sub-1',
        stepCount: 2,
      })
    ).toBe(false);
    expect(
      shouldDispatchThreadsChanged({
        kind: 'subagentStepsUpdated',
        threadId: 'thread-1',
        subagentId: 'sub-1',
        childThreadId: 'child-1',
      })
    ).toBe(true);
    expect(
      shouldDispatchThreadsChanged({
        kind: 'subagentStepsUpdated',
        threadId: 'thread-1',
        subagentId: 'sub-1',
        status: 'completed',
      })
    ).toBe(true);
    expect(
      shouldDispatchThreadsChanged({
        kind: 'subagentRunUpdated',
        threadId: 'thread-1',
      })
    ).toBe(true);
    expect(
      shouldDispatchThreadsChanged({
        kind: 'swarmStateUpdated',
        threadId: 'thread-1',
        swarmState: {
          swarmId: 'swarm-1',
          title: 'Team',
          members: [],
          posts: [],
          channels: [{ name: 'main', archived: false }],
        },
      })
    ).toBe(true);
  });

  it('batches kite:threads-changed dispatches over a 120ms window and cancels on unmount', async () => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const onThreadsChanged = vi.fn();
    window.addEventListener('kite:threads-changed', onThreadsChanged);

    let threadsMap: Record<string, ExtendedChatThread> = { 'thread-1': makeThread() };
    const setThreadsMap = vi.fn(
      (updater: React.SetStateAction<Record<string, ExtendedChatThread>>) => {
        threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
      }
    );
    const isMountedRef = { current: true };

    try {
      const { unmount } = renderHook(() =>
        useSubagentEvents({ setThreadsMap, isMountedRef })
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const subHandler = listenHandlers.get('chat-subagent-event');
      const swarmHandler = listenHandlers.get('chat-swarm-event');
      expect(subHandler).toBeDefined();
      expect(swarmHandler).toBeDefined();

      act(() => {
        subHandler?.({
          payload: {
            kind: 'subagentRunUpdated',
            threadId: 'thread-1',
            subagentId: 'sub-1',
            run: {
              subagentId: 'sub-1',
              parentThreadId: 'thread-1',
              parentToolCallId: 'call-1',
              role: 'Explorer',
              status: 'running',
              childThreadId: 'child-1',
              stepCount: 0,
              items: [],
              startedAtUnixMs: 1,
              updatedAtUnixMs: 1,
            },
          },
        });
        swarmHandler?.({
          payload: {
            kind: 'swarmStateUpdated',
            threadId: 'thread-1',
            swarmState: {
              swarmId: 'swarm-1',
              title: 'Team',
              members: [],
              posts: [],
              channels: [{ name: 'main', archived: false }],
            },
          },
        });
      });

      act(() => {
        vi.advanceTimersByTime(119);
      });
      expect(onThreadsChanged).toHaveBeenCalledTimes(0);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onThreadsChanged).toHaveBeenCalledTimes(1);

      act(() => {
        subHandler?.({
          payload: {
            kind: 'subagentStepsUpdated',
            threadId: 'thread-1',
            subagentId: 'sub-1',
            status: 'completed',
          },
        });
      });
      unmount();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(onThreadsChanged).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('kite:threads-changed', onThreadsChanged);
    }
  });

  it('only fires for run creation and lifecycle transitions when signatures are tracked', () => {
    const seen = new Map<string, string>();
    const created: ChatSubagentEventPayload = {
      kind: 'subagentRunUpdated',
      threadId: 'thread-1',
      run: {
        subagentId: 'sub-1',
        parentThreadId: 'thread-1',
        parentToolCallId: 'call-1',
        childThreadId: 'child-1',
        role: 'Explorer',
        status: 'running',
        stepCount: 0,
        items: [],
        startedAtUnixMs: 1,
        updatedAtUnixMs: 1,
      },
    };
    const progress: ChatSubagentEventPayload = {
      kind: 'subagentStepsUpdated',
      threadId: 'thread-1',
      subagentId: 'sub-1',
      childThreadId: 'child-1',
      status: 'running',
      stepCount: 7,
    };
    expect(shouldDispatchThreadsChanged(created, seen)).toBe(true);
    for (let i = 0; i < 25; i += 1) {
      expect(shouldDispatchThreadsChanged({ ...progress, stepCount: 7 + i }, seen)).toBe(false);
      expect(shouldDispatchThreadsChanged(created, seen)).toBe(false);
    }
    expect(shouldDispatchThreadsChanged({ ...progress, status: 'completed' }, seen)).toBe(true);
    expect(shouldDispatchThreadsChanged({ ...progress, status: 'completed' }, seen)).toBe(false);

    const removal: ChatSubagentEventPayload = {
      kind: 'subagentRunRemoved',
      threadId: 'thread-1',
      subagentId: 'sub-1',
    };
    expect(shouldDispatchThreadsChanged(removal, seen)).toBe(true);
    expect(shouldDispatchThreadsChanged(created, seen)).toBe(true);
  });

  it('dispatches kite:threads-changed once for a burst of subagent progress events', async () => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const onThreadsChanged = vi.fn();
    window.addEventListener('kite:threads-changed', onThreadsChanged);
    let threadsMap: Record<string, ExtendedChatThread> = { 'thread-1': makeThread() };
    const setThreadsMap = vi.fn((updater: React.SetStateAction<Record<string, ExtendedChatThread>>) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const isMountedRef = { current: true };

    try {
      const { unmount } = renderHook(() => useSubagentEvents({ setThreadsMap, isMountedRef }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const subHandler = listenHandlers.get('chat-subagent-event');
      expect(subHandler).toBeDefined();

      act(() => {
        for (let i = 0; i < 50; i += 1) {
          subHandler?.({
            payload: {
              kind: 'subagentStepsUpdated',
              threadId: 'thread-1',
              subagentId: 'sub-burst',
              childThreadId: 'child-burst',
              status: 'running',
              stepCount: i,
            },
          });
        }
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(onThreadsChanged).toHaveBeenCalledTimes(1);

      act(() => {
        subHandler?.({
          payload: {
            kind: 'subagentStepsUpdated',
            threadId: 'thread-1',
            subagentId: 'sub-burst',
            childThreadId: 'child-burst',
            status: 'completed',
            stepCount: 51,
          },
        });
        vi.advanceTimersByTime(500);
      });
      expect(onThreadsChanged).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      window.removeEventListener('kite:threads-changed', onThreadsChanged);
    }
  });

  it('removes a retracted unspawned subagent placeholder run on subagentRunRemoved', () => {
    const base = makeThread();
    const withRuns: ExtendedChatThread = {
      ...base,
      subagentRuns: [
        {
          subagentId: 't_run1_40',
          parentThreadId: 'thread-1',
          parentToolCallId: 't_run1_40',
          role: 'Subagent',
          status: 'running',
          stepCount: 0,
          items: [],
          startedAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        {
          subagentId: 'child-1',
          parentThreadId: 'thread-1',
          parentToolCallId: 't_run1_45',
          childThreadId: 'child-1',
          role: 'Chat Keystroke Jump Investigator',
          status: 'running',
          stepCount: 2,
          items: [],
          startedAtUnixMs: 2,
          updatedAtUnixMs: 2,
        },
      ],
    };

    const removalPayload: ChatSubagentEventPayload = {
      kind: 'subagentRunRemoved',
      threadId: 'thread-1',
      subagentId: 't_run1_40',
      parentToolCallId: 't_run1_40',
    };
    expect(shouldDispatchThreadsChanged(removalPayload)).toBe(true);
    const updated = applySubagentEvent(withRuns, removalPayload);
    expect(updated.subagentRuns?.map((r) => r.subagentId)).toEqual(['child-1']);
  });

  it('never overwrites or merges sibling steps when two parallel runs share a collided parentToolCallId', () => {
    const base = makeThread();
    const withCollidedParallelRuns: ExtendedChatThread = {
      ...base,
      subagentRuns: [
        {
          subagentId: 'child-audit',
          parentThreadId: 'thread-1',
          parentToolCallId: 't_call_242',
          childThreadId: 'child-audit',
          role: 'Kite-Ctx & Zed Conversational Audit',
          status: 'completed',
          stepCount: 58,
          items: [
            {
              id: 'step-audit-1',
              kind: 'tool',
              text: '',
              title: 'Read zedVoice.ts',
              detail: '',
              status: 'completed',
              streaming: false,
              exitCode: null,
              createdAtUnixMs: 100,
              attachments: [],
            },
          ],
          startedAtUnixMs: 1_000,
          updatedAtUnixMs: 2_000,
          completedAtUnixMs: 2_000,
        },
        {
          subagentId: 'child-grok',
          parentThreadId: 'thread-1',
          parentToolCallId: 't_call_242',
          childThreadId: 'child-grok',
          role: 'Grok Bot Desktop RE',
          status: 'running',
          stepCount: 10,
          items: [],
          startedAtUnixMs: 1_015,
          updatedAtUnixMs: 1_500,
        },
        {
          subagentId: 'child-audit',
          parentThreadId: 'thread-1',
          parentToolCallId: 'dispatch-subagent-child-audit',
          childThreadId: 'child-audit',
          role: 'Kite-Ctx & Zed Conversational Audit',
          status: 'running',
          stepCount: 0,
          items: [],
          startedAtUnixMs: 1_050,
          updatedAtUnixMs: 1_050,
        },
      ],
    };

    const updated = applySubagentEvent(withCollidedParallelRuns, {
      kind: 'subagentRunUpdated',
      threadId: 'thread-1',
      subagentId: 'child-grok',
      run: {
        subagentId: 'child-grok',
        parentThreadId: 'thread-1',
        parentToolCallId: 't_call_242',
        childThreadId: 'child-grok',
        role: 'Grok Bot Desktop RE',
        status: 'running',
        stepCount: 11,
        items: [
          {
            id: 'step-grok-11',
            kind: 'tool',
            text: '',
            title: 'Inspect workspace bundle',
            detail: '',
            status: 'completed',
            streaming: false,
            exitCode: null,
            createdAtUnixMs: 2_100,
            attachments: [],
          },
        ],
        startedAtUnixMs: 1_015,
        updatedAtUnixMs: 2_100,
      },
    });

    expect(updated.subagentRuns?.[0]?.subagentId).toBe('child-audit');
    expect(updated.subagentRuns?.[0]?.status).toBe('completed');
    expect(updated.subagentRuns?.[0]?.items?.map((it) => it.id)).toEqual(['step-audit-1']);
    expect(updated.subagentRuns?.[1]?.subagentId).toBe('child-grok');
    expect(updated.subagentRuns?.[1]?.stepCount).toBe(11);
    expect(updated.subagentRuns?.[1]?.items?.map((it) => it.id)).toEqual(['step-grok-11']);
    expect(countRunningSubagents(updated)).toBe(1);
  });
});
