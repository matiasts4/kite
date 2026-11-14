import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtendedChatThread } from '../types';
import {
  applySubagentEvent,
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
});
