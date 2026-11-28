import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtendedChatThread } from './types';
import { pollTurnUpdates } from './turnPolling';
import { invokeCommand } from '../../../lib/ipc';
import { playApprovalChime } from '../../../lib/notifications/audioCues';

vi.mock('../../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

vi.mock('../../../lib/notifications/audioCues', () => ({
  playApprovalChime: vi.fn(),
}));

function makeRunningThread(): ExtendedChatThread {
  return {
    id: 'thread-sync-1',
    title: 'Long Turn',
    provider: 'antigravity',
    mode: 'agent',
    status: 'running',
    items: [
      {
        id: 'u-1',
        kind: 'user',
        text: 'Run tests',
        title: null,
        detail: null,
        status: 'completed',
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1000,
        attachments: [],
      },
      {
        id: 'tool-npx',
        kind: 'tool',
        toolKind: 'commandExecution',
        toolName: 'run_command',
        command: 'npx vitest run',
        text: 'Running tests',
        title: 'Run `npx vitest run`',
        detail: null,
        status: 'running',
        streaming: true,
        exitCode: null,
        createdAtUnixMs: 1001,
        attachments: [],
      },
    ],
  } as unknown as ExtendedChatThread;
}

describe('pollTurnUpdates synchronization & settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears in-flight tool statuses and reconciles persisted items when resyncRequired or finished without events', async () => {
    let threadsMap: Record<string, ExtendedChatThread> = {
      'thread-sync-1': makeRunningThread(),
    };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const setIsRunning = vi.fn();
    const notifyThreadsChanged = vi.fn();
    const reconcileThread = vi.fn().mockResolvedValue(undefined);
    const activePollRunsRef = { current: new Set<string>(['run-long-1']) };

    vi.mocked(invokeCommand).mockResolvedValueOnce({
      schemaVersion: 1,
      runId: 'run-long-1',
      nextSequence: 0,
      finished: true,
      resyncRequired: true,
      events: [],
    });

    await pollTurnUpdates({
      runId: 'run-long-1',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged,
      reconcileThread,
    } as any);

    expect(activePollRunsRef.current.has('run-long-1')).toBe(false);
    expect(reconcileThread).toHaveBeenCalledWith('thread-sync-1');
    const updated = threadsMap['thread-sync-1'];
    expect(updated.status).toBe('idle');
    const toolItem = updated.items.find((it) => it.id === 'tool-npx');
    expect(toolItem?.streaming).toBe(false);
    expect(toolItem?.status).toBe('completed');
  });

  it('retries transient polling timeouts with backoff instead of permanently aborting on first failure', async () => {
    let threadsMap: Record<string, ExtendedChatThread> = {
      'thread-sync-1': makeRunningThread(),
    };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const setIsRunning = vi.fn();
    const activePollRunsRef = { current: new Set<string>(['run-retry-1']) };

    vi.mocked(invokeCommand)
      .mockRejectedValueOnce(new Error('pollTurnUpdates(run-retry-1) timed out after 15000ms'))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-retry-1',
        nextSequence: 5,
        finished: true,
        resyncRequired: false,
        events: [
          { sequence: 4, kind: 'upsert', item: { id: 'asst-1', kind: 'assistant', text: 'Done!', status: 'completed', streaming: false, exitCode: null, createdAtUnixMs: 2000, attachments: [] } },
          { sequence: 5, kind: 'finished', ok: true, stoppedByBuilder: false },
        ],
      });

    await pollTurnUpdates({
      runId: 'run-retry-1',
      threadId: 'thread-sync-1',
      afterSeq: 3,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged: vi.fn(),
    });

    // After first transient failure, poller must remain active and scheduled for retry
    expect(activePollRunsRef.current.has('run-retry-1')).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);

    expect(vi.mocked(invokeCommand)).toHaveBeenCalledTimes(2);
    expect(activePollRunsRef.current.has('run-retry-1')).toBe(false);
    expect(threadsMap['thread-sync-1'].items.some((it) => it.text === 'Done!')).toBe(true);
  });

  it('continues draining when backend returns hasMore=true and handles error-field payloads with bounded backoff without clobbering newer run state', async () => {
    let threadsMap: Record<string, ExtendedChatThread> = {
      'thread-sync-1': makeRunningThread(),
    };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const isRunningUpdates: Array<Record<string, boolean>> = [];
    let isRunningMap: Record<string, boolean> = { 'thread-sync-1': true };
    const setIsRunning = vi.fn((updater) => {
      isRunningMap = typeof updater === 'function' ? updater(isRunningMap) : updater;
      isRunningUpdates.push(isRunningMap);
    });
    const activePollRunsRef = { current: new Set<string>(['run-chunk-1']) };
    const activePollThreadsRef = { current: new Map<string, string>([['thread-sync-1', 'run-chunk-1']]) };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-chunk-1',
        nextSequence: 32,
        hasMore: true,
        finished: false,
        resyncRequired: false,
        events: [
          {
            sequence: 32,
            kind: 'upsert',
            item: {
              id: 'tool-npx',
              kind: 'tool',
              text: 'halfway',
              status: 'running',
              streaming: true,
              exitCode: null,
              createdAtUnixMs: 1000,
              attachments: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-chunk-1',
        nextSequence: 34,
        hasMore: false,
        finished: true,
        resyncRequired: false,
        events: [
          {
            sequence: 33,
            kind: 'upsert',
            item: {
              id: 'asst-tail',
              kind: 'assistant',
              text: 'All 34 events delivered',
              status: 'completed',
              streaming: false,
              exitCode: null,
              createdAtUnixMs: 2000,
              attachments: [],
            },
          },
          { sequence: 34, kind: 'finished', ok: true, stoppedByBuilder: false },
        ],
      });

    await pollTurnUpdates({
      runId: 'run-chunk-1',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef,
      activePollThreadsRef,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged: vi.fn(),
    });

    // First chunk has hasMore=true -> stays active and drains immediately on next tick
    expect(activePollRunsRef.current.has('run-chunk-1')).toBe(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(vi.mocked(invokeCommand)).toHaveBeenCalledTimes(2);
    expect(activePollRunsRef.current.has('run-chunk-1')).toBe(false);
    expect(threadsMap['thread-sync-1'].items.some((it) => it.text === 'All 34 events delivered')).toBe(true);

    // Now test IPC `{ error: ... }` payload paired with a newer active run replacing `thread-sync-1`
    vi.mocked(invokeCommand).mockClear();
    const activeRuns2 = { current: new Set<string>(['run-old']) };
    const activeThreads2 = { current: new Map<string, string>([['thread-sync-1', 'run-old']]) };
    isRunningMap = { 'thread-sync-1': true };
    vi.mocked(invokeCommand).mockResolvedValue({ error: 'spawn_blocking panic' });

    const reconcileThread = vi.fn().mockResolvedValue(undefined);
    await pollTurnUpdates({
      runId: 'run-old',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef: activeRuns2,
      activePollThreadsRef: activeThreads2,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged: vi.fn(),
      reconcileThread,
      consecutiveErrors: 5,
    });

    expect(activeRuns2.current.has('run-old')).toBe(false);
    expect(reconcileThread).toHaveBeenCalledWith('thread-sync-1');

    // Stale poller must NOT clear isRunning if a newer run already owns thread-sync-1
    vi.mocked(invokeCommand).mockClear();
    const activeRuns3 = { current: new Set<string>(['run-stale', 'run-newer']) };
    const activeThreads3 = { current: new Map<string, string>([['thread-sync-1', 'run-newer']]) };
    isRunningMap = { 'thread-sync-1': true };
    vi.mocked(invokeCommand).mockResolvedValueOnce({
      schemaVersion: 1,
      runId: 'run-stale',
      nextSequence: 1,
      finished: true,
      resyncRequired: true,
      events: [],
    });

    await pollTurnUpdates({
      runId: 'run-stale',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef: activeRuns3,
      activePollThreadsRef: activeThreads3,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged: vi.fn(),
    });

    expect(activeThreads3.current.get('thread-sync-1')).toBe('run-newer');
    expect(isRunningMap['thread-sync-1']).toBe(true);
  });

  it('keeps polling on mid-turn resyncRequired, reconciles even when finished delivers events, preserves waiting approval state, and marks retry exhaustion stopped', async () => {
    let threadsMap: Record<string, ExtendedChatThread> = {
      'thread-sync-1': makeRunningThread(),
    };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const setIsRunning = vi.fn();
    const notifyThreadsChanged = vi.fn();
    const reconcileThread = vi.fn().mockResolvedValue(undefined);
    const activePollRunsRef = { current: new Set<string>(['run-mid-resync']) };
    const activePollThreadsRef = {
      current: new Map<string, string>([['thread-sync-1', 'run-mid-resync']]),
    };

    // 1. Mid-turn resyncRequired with finished=false keeps poller alive AND triggers reconcileThread
    vi.mocked(invokeCommand)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-mid-resync',
        nextSequence: 12,
        finished: false,
        hasMore: false,
        resyncRequired: true,
        events: [
          {
            sequence: 12,
            kind: 'upsert',
            item: {
              id: 'tool-npx',
              kind: 'tool',
              text: 'still working',
              status: 'running',
              streaming: true,
              exitCode: null,
              createdAtUnixMs: 1001,
              attachments: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-mid-resync',
        nextSequence: 14,
        finished: true,
        hasMore: false,
        resyncRequired: false,
        events: [
          {
            sequence: 13,
            kind: 'upsert',
            item: {
              id: 'asst-final',
              kind: 'assistant',
              text: 'Subagents reconciled',
              status: 'completed',
              streaming: false,
              exitCode: null,
              createdAtUnixMs: 2000,
              attachments: [],
            },
          },
          { sequence: 14, kind: 'finished', ok: true, stoppedByBuilder: false },
        ],
      });

    await pollTurnUpdates({
      runId: 'run-mid-resync',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef,
      activePollThreadsRef,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged,
      reconcileThread,
    });

    expect(activePollRunsRef.current.has('run-mid-resync')).toBe(true);
    expect(reconcileThread).toHaveBeenCalledTimes(1);
    expect(threadsMap['thread-sync-1'].status).toBe('running');
    expect(threadsMap['thread-sync-1'].items.find((it) => it.id === 'tool-npx')?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(450);

    // 2. Terminal finished=true with events>0 still triggers reconcileThread for post-finish subagent hydration
    expect(activePollRunsRef.current.has('run-mid-resync')).toBe(false);
    expect(reconcileThread).toHaveBeenCalledTimes(2);

    // 3. Approval-wait terminal poll keeps in-flight tool running instead of prematurely marking completed
    vi.mocked(invokeCommand).mockReset();
    threadsMap = { 'thread-sync-1': makeRunningThread() };
    const waitRuns = { current: new Set<string>(['run-wait']) };
    vi.mocked(invokeCommand).mockResolvedValueOnce({
      schemaVersion: 1,
      runId: 'run-wait',
      nextSequence: 5,
      finished: true,
      hasMore: false,
      resyncRequired: false,
      events: [
        {
          sequence: 5,
          kind: 'approvalOpened',
          approval: { requestId: 'req-1', title: 'Approve command' },
        },
      ],
    });

    await pollTurnUpdates({
      runId: 'run-wait',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef: waitRuns,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged,
    });
    expect(threadsMap['thread-sync-1'].status).toBe('waiting');
    expect(threadsMap['thread-sync-1'].items.find((it) => it.id === 'tool-npx')?.status).toBe('running');

    // 4. Exhausted retries after 15000ms timeout settle in-flight tool to 'failed' and notify listeners
    vi.mocked(invokeCommand).mockReset();
    notifyThreadsChanged.mockClear();
    reconcileThread.mockClear();
    threadsMap = { 'thread-sync-1': makeRunningThread() };
    const timeoutRuns = { current: new Set<string>(['run-timeout']) };
    vi.mocked(invokeCommand).mockImplementation(() => new Promise(() => undefined));

    const exhaustedPromise = pollTurnUpdates({
      runId: 'run-timeout',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef: timeoutRuns,
      setThreadsMap,
      setIsRunning,
      notifyThreadsChanged,
      reconcileThread,
      consecutiveErrors: 5,
    });

    await vi.advanceTimersByTimeAsync(15100);
    await exhaustedPromise;

    expect(timeoutRuns.current.has('run-timeout')).toBe(false);
    expect(threadsMap['thread-sync-1'].items.find((it) => it.id === 'tool-npx')?.status).toBe('failed');
    expect(reconcileThread).toHaveBeenCalledWith('thread-sync-1');
    expect(notifyThreadsChanged).toHaveBeenCalled();
  });

  it('removes a quiet-turn note live when backend emits a remove event', async () => {
    const runningThread = makeRunningThread();
    runningThread.items.push({
      id: 'note-quiet-1',
      kind: 'note',
      text: 'The provider has not sent an update. Stop the turn if this stays quiet.',
      title: null,
      detail: null,
      status: null,
      streaming: false,
      exitCode: null,
      createdAtUnixMs: 1500,
      attachments: [],
    } as any);

    let threadsMap: Record<string, ExtendedChatThread> = {
      'thread-sync-1': runningThread,
    };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const activePollRunsRef = { current: new Set<string>(['run-remove-1']) };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-remove-1',
        nextSequence: 2,
        finished: false,
        hasMore: false,
        resyncRequired: false,
        events: [
          { sequence: 1, kind: 'remove', itemId: 'note-quiet-1' } as any,
          {
            sequence: 2,
            kind: 'upsert',
            item: {
              id: 'tool-npx',
              kind: 'tool',
              text: 'resumed output',
              status: 'completed',
              streaming: false,
              exitCode: 0,
              createdAtUnixMs: 1001,
              attachments: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-remove-1',
        nextSequence: 3,
        finished: true,
        hasMore: false,
        resyncRequired: false,
        events: [{ sequence: 3, kind: 'finished', ok: true, stoppedByBuilder: false }],
      });

    await pollTurnUpdates({
      runId: 'run-remove-1',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef,
      setThreadsMap,
      setIsRunning: vi.fn(),
      notifyThreadsChanged: vi.fn(),
    });

    expect(
      threadsMap['thread-sync-1'].items.some((it) => it.id === 'note-quiet-1')
    ).toBe(false);
    expect(
      threadsMap['thread-sync-1'].items.find((it) => it.id === 'tool-npx')?.status
    ).toBe('completed');

    await vi.advanceTimersByTimeAsync(450);
  });

  it('replaces waiting narration on shorter assistant upsert, moves assistant to tail, and appends follow-up deltas', async () => {
    const runningThread = makeRunningThread();
    runningThread.items = [
      {
        id: 'u-1',
        kind: 'user',
        text: 'Check status',
        title: null,
        detail: null,
        status: 'completed',
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1000,
        attachments: [],
      },
      {
        id: 'asst-1',
        kind: 'assistant',
        text: 'Lancé el subagente para revisar todo el código. Estoy esperando su respuesta.',
        title: null,
        detail: null,
        status: null,
        streaming: true,
        exitCode: null,
        createdAtUnixMs: 1001,
        attachments: [],
      },
      {
        id: 'sub-1',
        kind: 'tool',
        toolKind: 'subagent',
        toolName: 'invoke_subagent',
        text: '',
        title: 'Subagent · Auditor',
        detail: null,
        status: 'completed',
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1002,
        attachments: [],
      },
    ];

    let threadsMap: Record<string, ExtendedChatThread> = {
      'thread-sync-1': runningThread,
    };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const activePollRunsRef = { current: new Set<string>(['run-wait-reset']) };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-wait-reset',
        nextSequence: 1,
        finished: false,
        hasMore: false,
        resyncRequired: false,
        events: [
          {
            sequence: 1,
            kind: 'upsert',
            item: {
              id: 'asst-1',
              kind: 'assistant',
              text: 'Listo.',
              title: null,
              detail: null,
              status: null,
              streaming: true,
              exitCode: null,
              createdAtUnixMs: 2000,
              attachments: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runId: 'run-wait-reset',
        nextSequence: 3,
        finished: true,
        hasMore: false,
        resyncRequired: false,
        events: [
          {
            sequence: 2,
            kind: 'delta',
            itemId: 'asst-1',
            text: '\n\nDetalle final.',
          },
          { sequence: 3, kind: 'finished', ok: true, stoppedByBuilder: false },
        ],
      });

    await pollTurnUpdates({
      runId: 'run-wait-reset',
      threadId: 'thread-sync-1',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef,
      setThreadsMap,
      setIsRunning: vi.fn(),
      notifyThreadsChanged: vi.fn(),
    });

    const afterUpsert = threadsMap['thread-sync-1'].items;
    expect(afterUpsert.map((it) => it.id)).toEqual(['u-1', 'sub-1', 'asst-1']);
    expect(afterUpsert[2]?.text).toBe('Listo.');

    await vi.advanceTimersByTimeAsync(450);

    const items = threadsMap['thread-sync-1'].items;
    expect(items.map((it) => it.id)).toEqual(['u-1', 'sub-1', 'asst-1']);
    expect(items[2]?.text).toBe('Listo.\n\nDetalle final.');
  });

  it('preserves active async child-thread subagent items as running when the parent turn settles', async () => {
    const threadWithActiveChild: ExtendedChatThread = {
      id: 'thread-sync-sub',
      title: 'Parent with Async Subagent',
      provider: 'antigravity',
      mode: 'fullAccess',
      status: 'running',
      subagentRuns: [
        {
          subagentId: 'sub-run-1',
          parentThreadId: 'thread-sync-sub',
          parentToolCallId: 'tool-sub-1',
          role: 'Code Explorer',
          status: 'running',
          childThreadId: 'child-thread-1',
          stepCount: 2,
          items: [],
          startedAtUnixMs: 1000,
          updatedAtUnixMs: 1200,
        },
      ],
      items: [
        {
          id: 'u-1',
          kind: 'user',
          text: 'Inspect repo',
          title: null,
          detail: null,
          status: 'completed',
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 1000,
          attachments: [],
        },
        {
          id: 'tool-sub-1',
          kind: 'tool',
          toolKind: 'subagent',
          toolName: 'kite_subagent_run',
          text: 'Working on module A',
          title: 'Subagent · Code Explorer',
          detail: null,
          status: 'running',
          streaming: true,
          exitCode: null,
          createdAtUnixMs: 1001,
          attachments: [],
          subagentMeta: {
            subagentId: 'sub-run-1',
            role: 'Code Explorer',
            childThreadId: 'child-thread-1',
            status: 'running',
          },
        },
        {
          id: 'tool-cmd-1',
          kind: 'tool',
          toolKind: 'commandExecution',
          toolName: 'run_command',
          text: '',
          title: 'Run check',
          detail: null,
          status: 'running',
          streaming: true,
          exitCode: null,
          createdAtUnixMs: 1002,
          attachments: [],
        },
      ],
    } as unknown as ExtendedChatThread;

    let threadsMap: Record<string, ExtendedChatThread> = {
      'thread-sync-sub': threadWithActiveChild,
    };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });
    const activePollRunsRef = { current: new Set<string>(['run-sub-parent']) };

    vi.mocked(invokeCommand).mockResolvedValueOnce({
      schemaVersion: 1,
      runId: 'run-sub-parent',
      nextSequence: 2,
      finished: true,
      hasMore: false,
      resyncRequired: false,
      events: [{ sequence: 2, kind: 'finished', ok: true, stoppedByBuilder: false }],
    });

    await pollTurnUpdates({
      runId: 'run-sub-parent',
      threadId: 'thread-sync-sub',
      afterSeq: 0,
      agentId: null,
      isMountedRef: { current: true },
      activePollRunsRef,
      setThreadsMap,
      setIsRunning: vi.fn(),
      notifyThreadsChanged: vi.fn(),
    });

    const updated = threadsMap['thread-sync-sub'];
    const subagentItem = updated.items.find((it) => it.id === 'tool-sub-1');
    const cmdItem = updated.items.find((it) => it.id === 'tool-cmd-1');
    expect(subagentItem?.status).toBe('running');
    expect(subagentItem?.streaming).toBe(true);
    expect(cmdItem?.status).toBe('completed');
    expect(cmdItem?.streaming).toBe(false);
  });

  it('dispatches kite:notifications-refresh on approvalOpened and finished instead of calling playApprovalChime directly', async () => {
    const refreshEvents: Event[] = [];
    const onRefresh = (e: Event) => refreshEvents.push(e);
    window.addEventListener('kite:notifications-refresh', onRefresh);

    try {
      let threadsMap: Record<string, ExtendedChatThread> = {
        'thread-sync-1': makeRunningThread(),
      };
      const setThreadsMap = vi.fn((updater) => {
        threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
      });
      const activePollRunsRef = { current: new Set<string>(['run-notif-1']) };

      vi.mocked(invokeCommand)
        .mockResolvedValueOnce({
          schemaVersion: 1,
          runId: 'run-notif-1',
          nextSequence: 1,
          finished: false,
          hasMore: false,
          resyncRequired: false,
          events: [
            {
              sequence: 1,
              kind: 'approvalOpened',
              approval: { requestId: 'req-9', title: 'Approve write' },
            },
          ],
        })
        .mockResolvedValueOnce({
          schemaVersion: 1,
          runId: 'run-notif-1',
          nextSequence: 2,
          finished: true,
          hasMore: false,
          resyncRequired: false,
          events: [{ sequence: 2, kind: 'finished', ok: true, stoppedByBuilder: false }],
        });

      await pollTurnUpdates({
        runId: 'run-notif-1',
        threadId: 'thread-sync-1',
        afterSeq: 0,
        agentId: null,
        isMountedRef: { current: true },
        activePollRunsRef,
        setThreadsMap,
        setIsRunning: vi.fn(),
        notifyThreadsChanged: vi.fn(),
      });

      expect(refreshEvents).toHaveLength(1);
      expect(playApprovalChime).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(450);

      expect(refreshEvents).toHaveLength(2);
      expect(playApprovalChime).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('kite:notifications-refresh', onRefresh);
    }
  });
});
