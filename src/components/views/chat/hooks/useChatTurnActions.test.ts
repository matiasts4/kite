import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ExtendedChatThread } from '../types';
import { useChatTurnActions } from './useChatTurnActions';
import { invokeCommand } from '../../../../lib/ipc';

vi.mock('../../../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

describe('useChatTurnActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles approval response correctly', async () => {
    const thread: ExtendedChatThread = {
      id: 't-1',
      provider: 'antigravity',
      mode: 'agent',
      status: 'waiting_for_approval',
      items: [],
    } as unknown as ExtendedChatThread;

    const updatedThread: ExtendedChatThread = {
      ...thread,
      status: 'running',
    };

    vi.mocked(invokeCommand).mockResolvedValueOnce(updatedThread);

    let threadsMap = { 't-1': thread };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });

    const promptMap = { 't-1': '' };
    const setPromptMap = vi.fn();
    const attachmentsMap = { 't-1': [] };
    const writeAttachments = vi.fn();
    const threadWithResolvedBinding = (t: ExtendedChatThread) => t;
    const notifyThreadsChanged = vi.fn();
    const isMountedRef = { current: true };
    const activePollRunsRef = { current: new Set<string>() };

    const { result } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap,
        setThreadsMap,
        promptMap,
        setPromptMap,
        attachmentsMap,
        writeAttachments,
        threadWithResolvedBinding,
        notifyThreadsChanged,
        isMountedRef,
        activePollRunsRef,
      })
    );

    await act(async () => {
      await result.current.handleApproval('t-1', 'allowOnce', 'req-1');
    });

    expect(invokeCommand).toHaveBeenCalledWith('respond_chat_approval', {
      threadId: 't-1',
      decision: 'allowOnce',
      requestId: 'req-1',
    });
    expect(setThreadsMap).toHaveBeenCalled();
  });

  it('handles cancelling turn correctly', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce(undefined);

    const thread: ExtendedChatThread = {
      id: 't-1',
      provider: 'antigravity',
      mode: 'agent',
      status: 'running',
      items: [],
    } as unknown as ExtendedChatThread;

    const setThreadsMap = vi.fn();
    const isMountedRef = { current: true };
    const activePollRunsRef = { current: new Set<string>(['run-1']) };

    const { result } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap: { 't-1': thread },
        setThreadsMap,
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef,
        activePollRunsRef,
      })
    );

    await act(async () => {
      await result.current.handleCancelTurn('t-1');
    });

    expect(activePollRunsRef.current.size).toBe(0);
    expect(invokeCommand).toHaveBeenCalledWith('cancel_chat_turn', { threadId: 't-1' });
    expect(result.current.isRunning['t-1']).toBe(false);
  });

  it('handles user input response', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap: {},
        setThreadsMap: vi.fn(),
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef: { current: true },
        activePollRunsRef: { current: new Set() },
      })
    );

    await act(async () => {
      await result.current.handleUserInputResponse('t-1', { question1: 'answer1' });
    });

    expect(invokeCommand).toHaveBeenCalledWith('respond_chat_user_input', {
      threadId: 't-1',
      answers: { question1: 'answer1' },
    });
  });

  it('does not cancel pollers on other active threads when cancelling a thread without an active poller', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce(undefined);
    const activePollRunsRef = { current: new Set<string>(['run-other-thread']) };
    const activePollThreadsRef = { current: new Map<string, string>([['t-other', 'run-other-thread']]) };

    const { result } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap: {},
        setThreadsMap: vi.fn(),
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef: { current: true },
        activePollRunsRef,
        activePollThreadsRef,
      })
    );

    await act(async () => {
      await result.current.handleCancelTurn('t-1');
    });

    expect(activePollRunsRef.current.has('run-other-thread')).toBe(true);
    expect(activePollThreadsRef.current.get('t-other')).toBe('run-other-thread');
  });

  it('prevents overlapping list_live_chat_runs calls across 4000ms ticks and recovers after 5000ms timeout', async () => {
    vi.useFakeTimers();
    let resolveHanging!: (val: unknown) => void;
    const hangingPromise = new Promise((resolve) => {
      resolveHanging = resolve;
    });
    vi.mocked(invokeCommand)
      .mockReturnValueOnce(hangingPromise as Promise<any>)
      .mockResolvedValueOnce([{ threadId: 't-recovered', runId: 'r-1', status: 'running' }]);

    const { result, unmount } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap: {},
        setThreadsMap: vi.fn(),
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef: { current: true },
        activePollRunsRef: { current: new Set() },
      })
    );

    // Tick 1 at 4000ms fires first hanging IPC call (withTimeout expires at 4000 + 5000 = 9000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    // Tick 2 at 8000ms AND a manual check while still in flight (< 9000ms) MUST NOT stack another IPC call
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
      await result.current.checkLiveRuns();
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    // Advance past t=9000ms so the 5000ms withTimeout rejects and finally resets isCheckingLiveRunsRef
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.hasCheckedLiveRuns).toBe(false);

    // Tick 3 at 12000ms recovers and invokes list_live_chat_runs again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(result.current.hasCheckedLiveRuns).toBe(true);
    expect(result.current.liveRuns).toEqual([
      { threadId: 't-recovered', runId: 'r-1', status: 'running' },
    ]);

    resolveHanging([]);
    unmount();
  });

  it('optimistically clears stale turnFailure when sending a new prompt', async () => {
    let resolveStart!: (val: unknown) => void;
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });
    vi.mocked(invokeCommand).mockReturnValueOnce(startPromise as Promise<any>);

    const failedThread: ExtendedChatThread = {
      id: 't-retry',
      provider: 'antigravity',
      mode: 'fullAccess',
      status: 'error',
      turnFailure: {
        kind: 'processError',
        message: 'API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host',
      },
      items: [],
    } as unknown as ExtendedChatThread;

    let threadsMap: Record<string, ExtendedChatThread> = { 't-retry': failedThread };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });

    const { result, unmount } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap,
        setThreadsMap,
        promptMap: { 't-retry': 'continue' },
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef: { current: true },
        activePollRunsRef: { current: new Set() },
      })
    );

    let sendPromise!: Promise<boolean>;
    act(() => {
      sendPromise = result.current.handleSendPrompt('t-retry');
    });
    expect(threadsMap['t-retry'].status).toBe('running');
    expect(threadsMap['t-retry'].turnFailure).toBeUndefined();

    await act(async () => {
      resolveStart({
        schemaVersion: 1,
        runId: 'run-retry',
        thread: { ...failedThread, status: 'idle', turnFailure: undefined },
      });
      await sendPromise;
    });
    unmount();
  });

  it('does not drop handleSendPrompt after handleCancelTurn in the same async flow (isRunningRef) and preserves empty queue []', async () => {
    const runningThread: ExtendedChatThread = {
      id: 't-steer',
      provider: 'antigravity',
      mode: 'fullAccess',
      status: 'running',
      queuedRuns: [],
      items: [{ id: 'u1', kind: 'user', text: 'old', title: null, detail: null, status: 'completed', streaming: false, exitCode: null, createdAtUnixMs: 1, attachments: [] }],
    } as unknown as ExtendedChatThread;

    let threadsMap: Record<string, ExtendedChatThread> = { 't-steer': runningThread };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });

    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'cancel_chat_turn') return undefined;
      if (cmd === 'start_chat_turn') {
        return {
          schemaVersion: 1,
          runId: 'run-steered',
          // Simulate stale server snapshot still carrying old queued item
          thread: {
            ...runningThread,
            status: 'running',
            queuedRuns: [{ id: 'q-stale', text: 'Should not resurrect' }],
          },
        };
      }
      if (cmd === 'read_chat_turn_updates') {
        return { schemaVersion: 1, runId: 'run-steered', nextSequence: 1, finished: true, resyncRequired: false, events: [] };
      }
      return null;
    });

    const { result, unmount } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap,
        setThreadsMap,
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef: { current: true },
        activePollRunsRef: { current: new Set() },
      })
    );

    // Put thread into running state via setIsRunning
    act(() => {
      result.current.setIsRunning({ 't-steer': true });
    });
    expect(result.current.isRunning['t-steer']).toBe(true);

    // Run cancel -> send in ONE async closure (without waiting for React rerender)
    let sent = false;
    await act(async () => {
      await result.current.handleCancelTurn('t-steer');
      expect(threadsMap['t-steer'].stoppedByBuilder).toBe(true);
      sent = await result.current.handleSendPrompt(
        't-steer',
        'Steered prompt',
        { ...threadsMap['t-steer'], queuedRuns: [], status: 'idle', stoppedByBuilder: false },
        undefined,
        []
      );
    });

    expect(sent).toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith(
      'start_chat_turn',
      expect.objectContaining({ threadId: 't-steer', prompt: 'Steered prompt' })
    );
    // Intentionally cleared [] must NOT be overwritten by stale server queuedRuns
    expect(threadsMap['t-steer'].queuedRuns).toEqual([]);
    unmount();
  });

  it('returns false from handleCancelTurn when cancel_chat_turn rejects and resumes stopped threads on empty send', async () => {
    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'cancel_chat_turn') throw new Error('abort failed');
      if (cmd === 'start_chat_turn') {
        return {
          schemaVersion: 1,
          runId: 'run-resumed',
          thread: { ...threadsMap['t-stop'], status: 'running', stoppedByBuilder: false, queuedRuns: [] },
        };
      }
      return undefined;
    });

    let threadsMap: Record<string, ExtendedChatThread> = {
      't-stop': {
        id: 't-stop',
        title: 'Stopped thread',
        provider: 'antigravity',
        mode: 'fullAccess',
        status: 'idle',
        stoppedByBuilder: true,
        items: [],
        queuedRuns: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      } as unknown as ExtendedChatThread,
    };

    const setThreadsMap = (updater: any) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    };

    const { result, unmount } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap,
        setThreadsMap,
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef: { current: true },
        activePollRunsRef: { current: new Set() },
      })
    );

    act(() => {
      result.current.setIsRunning({ 't-stop': true });
    });

    let cancelled = true;
    await act(async () => {
      cancelled = (await result.current.handleCancelTurn('t-stop')) as unknown as boolean;
    });
    expect(cancelled).toBe(false);
    expect(result.current.isRunning['t-stop']).toBe(true);

    act(() => {
      result.current.setIsRunning({ 't-stop': false });
    });

    let resumed = false;
    await act(async () => {
      resumed = await result.current.handleSendPrompt('t-stop', '');
    });
    expect(resumed).toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith(
      'start_chat_turn',
      expect.objectContaining({ threadId: 't-stop', prompt: 'Continue' })
    );
    expect(threadsMap['t-stop'].stoppedByBuilder).toBe(false);
    unmount();
  });
});
