import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { invokeCommand } from './ipc';
import {
  areNotificationsSnapshotsEqual,
  useNotifications,
} from './notifications/useNotifications';
import { startAgentInboxPolling } from './agentInboxLoop';
import {
  resetLiveChatRunsStoreForTest,
  subscribeLiveChatRuns,
} from './liveChatRunsStore';
import type { NotificationsSnapshot } from '../types';

vi.mock('./ipc', () => ({
  invokeCommand: vi.fn(),
  isTauriEnvironment: vi.fn(() => true),
}));

vi.mock('./notifications/audioCues', () => ({
  playCompletionChime: vi.fn(),
  playApprovalChime: vi.fn(),
}));

describe('S8 idle polling & wakeup storm elimination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLiveChatRunsStoreForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLiveChatRunsStoreForTest();
  });

  it('useNotifications skips re-renders when polled snapshot is unchanged', async () => {
    const snapA: NotificationsSnapshot = {
      unreadCount: 1,
      openInputRequestCount: 0,
      preferences: { finishSoundEnabled: true, inputRequestsEnabled: true },
      records: [
        {
          id: 'n-1',
          isRead: false,
          isWaitingForInput: false,
          title: 'Done',
          body: 'Finished',
          createdAtUnixMs: 1000,
          kind: { kind: 'settled', outcome: 'completed' },
        },
      ],
    } as unknown as NotificationsSnapshot;

    const snapAClone = JSON.parse(JSON.stringify(snapA)) as NotificationsSnapshot;
    expect(areNotificationsSnapshotsEqual(snapA, snapAClone)).toBe(true);

    vi.mocked(invokeCommand).mockResolvedValueOnce(snapA).mockResolvedValueOnce(snapAClone);

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useNotifications();
    });

    await act(async () => {
      await Promise.resolve();
    });
    const rendersAfterInitial = renderCount;
    const initialSnapRef = result.current.snapshot;

    await act(async () => {
      await result.current.refresh();
    });

    // Identical poll payload must preserve reference identity and trigger zero extra renders.
    expect(result.current.snapshot).toBe(initialSnapRef);
    expect(renderCount).toBe(rendersAfterInitial);
  });

  it('startAgentInboxPolling pauses when no agents are active and wakes on terminal-agent-update', async () => {
    vi.useFakeTimers();
    vi.mocked(invokeCommand).mockResolvedValue({ requests: [] });

    let agentsActive = false;
    const stop = startAgentInboxPolling(() => 'C:\\repo', {
      isActive: () => true,
      hasActiveAgents: () => agentsActive,
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(invokeCommand).not.toHaveBeenCalled();

    // Activate an agent and dispatch wake event -> polls immediately.
    agentsActive = true;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kite:terminal-agent-update'));
      await Promise.resolve();
    });
    expect(invokeCommand).toHaveBeenCalledWith('poll_agent_inbox', { cwd: 'C:\\repo' });

    stop();
  });

  it('subscribeLiveChatRuns deduplicates concurrent polling across multiple subscribers', async () => {
    vi.useFakeTimers();
    vi.mocked(invokeCommand).mockResolvedValue([
      { runId: 'run-1', threadId: 't-1', nextSequence: 2, status: 'running' },
    ]);

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const unsubA = subscribeLiveChatRuns((runs) => seenA.push(runs), { immediate: true });
    const unsubB = subscribeLiveChatRuns((runs) => seenB.push(runs), { immediate: true });

    await act(async () => {
      await Promise.resolve();
    });

    // Two immediate subscribers share a single in-flight IPC call.
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);

    // One shared 4s timer drives both subscribers with 1 call per interval.
    vi.mocked(invokeCommand).mockClear();
    await act(async () => {
      vi.advanceTimersByTime(4100);
      await Promise.resolve();
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });
});
