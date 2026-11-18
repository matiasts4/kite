import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  CHAT_GRID_STORAGE_KEY,
  CHAT_SUMMARIES_STORAGE_KEY,
  CHAT_THREAD_STORAGE_PREFIX,
} from './hooks/useChatGridPersistence';
import { useChatSession } from './useChatSession';
import { invokeCommand } from '../../../lib/ipc';
import { requestNewThread } from '../../../lib/newThreadRequest';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    invokeCommand: vi.fn(),
    isTauriEnvironment: () => true,
    subscribeEvent: vi.fn().mockResolvedValue(() => {}),
    listConnections: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}));

describe('useChatSession instant hydration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('hydrates cached grid and thread from localStorage without blocking behind initial spinner while backend refreshes', () => {
    const cachedThread = {
      id: 't-cached',
      title: 'Cached Thread',
      provider: 'claude',
      status: 'idle',
      items: [{ id: 'm1', kind: 'user', text: 'hello' }],
    };
    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([cachedThread]));
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['t-cached'], focusedThreadId: 't-cached' })
    );
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-cached`, JSON.stringify(cachedThread));

    // Pending IPC promises simulate a slow backend response
    vi.mocked(invokeCommand).mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useChatSession({
        workspaceId: 'ws-1',
        threadId: null,
        agents: [],
        ownsNewThreadRequests: true,
      })
    );

    expect(result.current.isLoadingInitial).toBe(false);
    expect(result.current.gridThreadIds).toEqual(['t-cached']);
    expect(result.current.focusedThreadId).toBe('t-cached');
    expect(result.current.threadsMap['t-cached']?.title).toBe('Cached Thread');
  });

  it('still reconciles with backend on initial mount when initialThreadId is cached and clears stale summaries on empty IPC', async () => {
    const staleThread = {
      id: 't-init-cached',
      title: 'Stale Title',
      provider: 'claude',
      status: 'idle',
      items: [],
    };
    const freshThread = {
      ...staleThread,
      title: 'Fresh Title',
    };
    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([staleThread]));
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-init-cached`, JSON.stringify(staleThread));

    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'list_chat_summaries') return { summaries: [] };
      if (cmd === 'load_chat_thread') return freshThread;
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      return null;
    });

    const { result } = renderHook(() =>
      useChatSession({
        workspaceId: 'ws-1',
        threadId: 't-init-cached',
        agents: [],
        ownsNewThreadRequests: true,
      })
    );

    expect(result.current.isLoadingInitial).toBe(false);
    expect(result.current.focusedThreadId).toBe('t-init-cached');

    await waitFor(() => {
      expect(result.current.threadsMap['t-init-cached']?.title).toBe('Fresh Title');
      expect(result.current.knownThreadsList).toEqual([]);
    });
  });

  it('switches to a cached thread synchronously without flashing initial spinner or refetching all summaries', async () => {
    const t1 = {
      id: 't-1',
      title: 'Thread One',
      provider: 'claude',
      status: 'idle',
      items: [{ id: 'm1', kind: 'user', text: 'first' }],
    };
    const t2Cached = {
      id: 't-2',
      title: 'Thread Two Cached',
      provider: 'claude',
      status: 'idle',
      items: [{ id: 'm2', kind: 'user', text: 'second cached' }],
    };
    const t2Fresh = {
      ...t2Cached,
      title: 'Thread Two Fresh',
    };
    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([t1, t2Cached]));
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['t-1'], focusedThreadId: 't-1' })
    );
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-1`, JSON.stringify(t1));
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-2`, JSON.stringify(t2Cached));

    let resolveT2: ((value: unknown) => void) | undefined;
    vi.mocked(invokeCommand).mockImplementation((cmd, args) => {
      if (cmd === 'list_chat_summaries') return Promise.resolve({ summaries: [t1, t2Cached] });
      if (cmd === 'load_thread_grid') return Promise.resolve({ grid: { threadIds: ['t-1'], focusedThreadId: 't-1' } });
      if (cmd === 'load_chat_thread' && (args as { threadId?: string })?.threadId === 't-1') {
        return Promise.resolve(t1);
      }
      if (cmd === 'load_chat_thread' && (args as { threadId?: string })?.threadId === 't-2') {
        return new Promise((resolve) => {
          resolveT2 = resolve;
        });
      }
      if (cmd === 'list_chat_provider_models') return Promise.resolve({ models: [] });
      if (cmd === 'list_provider_agents') return Promise.resolve({ agents: [] });
      return Promise.resolve(null);
    });

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useChatSession({
          workspaceId: 'ws-1',
          threadId,
          agents: [],
          ownsNewThreadRequests: true,
        }),
      { initialProps: { threadId: 't-1' as string | null } }
    );

    await waitFor(() => {
      expect(result.current.focusedThreadId).toBe('t-1');
    });

    const summaryCallsBeforeSwitch = vi
      .mocked(invokeCommand)
      .mock.calls.filter(([cmd]) => cmd === 'list_chat_summaries').length;

    rerender({ threadId: 't-2' });

    // Immediate switch using cached snapshot, zero initial-loading flash, zero extra summary list waterfall
    expect(result.current.isLoadingInitial).toBe(false);
    expect(result.current.focusedThreadId).toBe('t-2');
    expect(result.current.gridThreadIds).toEqual(['t-2']);
    expect(result.current.threadsMap['t-2']?.title).toBe('Thread Two Cached');
    const summaryCallsAfterSwitch = vi
      .mocked(invokeCommand)
      .mock.calls.filter(([cmd]) => cmd === 'list_chat_summaries').length;
    expect(summaryCallsAfterSwitch).toBe(summaryCallsBeforeSwitch);

    resolveT2?.(t2Fresh);
    await waitFor(() => {
      expect(result.current.threadsMap['t-2']?.title).toBe('Thread Two Fresh');
    });
  });

  it('keeps the active thread mounted while a cold target loads and drops stale responses on rapid switches', async () => {
    const t1 = {
      id: 't-1',
      title: 'Thread One',
      provider: 'claude',
      status: 'idle',
      items: [{ id: 'm1', kind: 'user', text: 'first' }],
    };
    const t2 = {
      id: 't-2',
      title: 'Thread Two',
      provider: 'claude',
      status: 'idle',
      items: [{ id: 'm2', kind: 'user', text: 'second' }],
    };
    const t3 = {
      id: 't-3',
      title: 'Thread Three',
      provider: 'claude',
      status: 'idle',
      items: [{ id: 'm3', kind: 'user', text: 'third' }],
    };
    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([t1, t2, t3]));
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-1`, JSON.stringify(t1));

    let resolveT2: ((value: unknown) => void) | undefined;
    let resolveT3: ((value: unknown) => void) | undefined;
    vi.mocked(invokeCommand).mockImplementation((cmd, args) => {
      if (cmd === 'list_chat_summaries') return Promise.resolve({ summaries: [t1, t2, t3] });
      if (cmd === 'load_chat_thread') {
        const tid = (args as { threadId?: string })?.threadId;
        if (tid === 't-1') return Promise.resolve(t1);
        if (tid === 't-2') return new Promise((resolve) => { resolveT2 = resolve; });
        if (tid === 't-3') return new Promise((resolve) => { resolveT3 = resolve; });
      }
      if (cmd === 'list_chat_provider_models') return Promise.resolve({ models: [] });
      if (cmd === 'list_provider_agents') return Promise.resolve({ agents: [] });
      return Promise.resolve(null);
    });

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useChatSession({
          workspaceId: 'ws-1',
          threadId,
          agents: [],
          ownsNewThreadRequests: true,
        }),
      { initialProps: { threadId: 't-1' as string | null } }
    );

    await waitFor(() => {
      expect(result.current.focusedThreadId).toBe('t-1');
    });

    // Click t-2 (cold): stay cleanly on t-1 without spinner flash or missing-thread cell
    rerender({ threadId: 't-2' });
    expect(result.current.isLoadingInitial).toBe(false);
    expect(result.current.gridThreadIds).toEqual(['t-1']);

    // Rapidly click t-3 before t-2 finishes
    rerender({ threadId: 't-3' });
    expect(result.current.isLoadingInitial).toBe(false);

    // Latest click resolves first
    await act(async () => {
      resolveT3?.(t3);
    });
    await waitFor(() => {
      expect(result.current.focusedThreadId).toBe('t-3');
      expect(result.current.gridThreadIds).toEqual(['t-3']);
    });

    // Stale t-2 resolves later -> must NOT overwrite t-3
    await act(async () => {
      resolveT2?.(t2);
    });
    expect(result.current.focusedThreadId).toBe('t-3');
    expect(result.current.gridThreadIds).toEqual(['t-3']);
  });

  it('re-attaches detached live runs on mount and reconciles threads when liveRuns transitions to idle', async () => {
    const runningThread = {
      id: 't-detached',
      title: 'Detached Long Turn',
      provider: 'antigravity',
      status: 'running',
      items: [
        { id: 'u1', kind: 'user', text: 'run suite', status: 'completed', streaming: false },
        {
          id: 'tool-npx',
          kind: 'tool',
          toolKind: 'commandExecution',
          toolName: 'run_command',
          command: 'npx vitest run',
          text: '',
          status: 'running',
          streaming: true,
        },
      ],
    };
    const settledThread = {
      ...runningThread,
      status: 'idle',
      items: [
        { id: 'u1', kind: 'user', text: 'run suite', status: 'completed', streaming: false },
        {
          id: 'tool-npx',
          kind: 'tool',
          toolKind: 'commandExecution',
          toolName: 'run_command',
          command: 'npx vitest run',
          text: 'All tests passed',
          status: 'completed',
          streaming: false,
        },
        {
          id: 'asst-final',
          kind: 'assistant',
          text: 'Verified everything passed.',
          status: 'completed',
          streaming: false,
        },
      ],
    };

    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'list_chat_summaries') return { summaries: [runningThread] };
      if (cmd === 'load_thread_grid') {
        return { grid: { threadIds: ['t-detached'], focusedThreadId: 't-detached' } };
      }
      if (cmd === 'load_chat_thread') return runningThread;
      if (cmd === 'list_live_chat_runs') {
        return [
          {
            runId: 'run-detached-99',
            threadId: 't-detached',
            profileId: null,
            workspaceId: 'ws-1',
            provider: 'antigravity',
            title: 'Detached Long Turn',
            needsYou: false,
            startedAtUnixMs: 1000,
            nextSequence: 4,
            line: 'Running...',
          },
        ];
      }
      if (cmd === 'read_chat_turn_updates') {
        return {
          schemaVersion: 1,
          runId: 'run-detached-99',
          nextSequence: 6,
          finished: true,
          resyncRequired: false,
          events: [
            {
              sequence: 5,
              kind: 'upsert',
              item: settledThread.items[1],
            },
            {
              sequence: 6,
              kind: 'upsert',
              item: settledThread.items[2],
            },
          ],
        };
      }
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      return null;
    });

    const { result } = renderHook(() =>
      useChatSession({
        workspaceId: 'ws-1',
        threadId: null,
        agents: [],
        ownsNewThreadRequests: true,
      })
    );

    await waitFor(() => {
      expect(result.current.threadsMap['t-detached']?.status).toBe('idle');
    });
    expect(
      result.current.threadsMap['t-detached']?.items.some(
        (it) => it.text === 'Verified everything passed.'
      )
    ).toBe(true);
    expect(
      vi
        .mocked(invokeCommand)
        .mock.calls.some(
          ([cmd, args]) =>
            cmd === 'read_chat_turn_updates' &&
            (args as { runId?: string; afterSequence?: number })?.runId === 'run-detached-99' &&
            (args as { afterSequence?: number })?.afterSequence === 4
        )
    ).toBe(true);
  });

  it('reconciles a stale running thread immediately when liveRuns drops it without sending another message', async () => {
    vi.useFakeTimers();
    try {
      const runningThread = {
        id: 't-reconcile',
        title: 'Heartbeat Turn',
        provider: 'antigravity',
        status: 'running',
        items: [
          {
            id: 'tool-npx',
            kind: 'tool',
            toolKind: 'commandExecution',
            status: 'running',
            streaming: true,
            text: '',
          },
        ],
      };
      const finishedThread = {
        ...runningThread,
        status: 'idle',
        items: [
          {
            id: 'tool-npx',
            kind: 'tool',
            toolKind: 'commandExecution',
            status: 'completed',
            streaming: false,
            text: 'done',
          },
          {
            id: 'asst-1',
            kind: 'assistant',
            status: 'completed',
            streaming: false,
            text: 'Final response synced automatically.',
          },
        ],
      };

      let livePhase: 'active' | 'idle' = 'active';
      vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
        if (cmd === 'list_chat_summaries') return { summaries: [runningThread] };
        if (cmd === 'load_thread_grid') {
          return { grid: { threadIds: ['t-reconcile'], focusedThreadId: 't-reconcile' } };
        }
        if (cmd === 'load_chat_thread') {
          return livePhase === 'active' ? runningThread : finishedThread;
        }
        if (cmd === 'list_live_chat_runs') {
          return livePhase === 'active'
            ? [
                {
                  // Intentionally omit runId to simulate an already-running heartbeat transition
                  threadId: 't-reconcile',
                  profileId: null,
                  workspaceId: 'ws-1',
                  provider: 'antigravity',
                  title: 'Heartbeat Turn',
                  needsYou: false,
                  startedAtUnixMs: 1000,
                  line: null,
                },
              ]
            : [];
        }
        if (cmd === 'list_chat_provider_models') return { models: [] };
        if (cmd === 'list_provider_agents') return { agents: [] };
        return null;
      });

      const { result } = renderHook(() =>
        useChatSession({
          workspaceId: 'ws-1',
          threadId: null,
          agents: [],
          ownsNewThreadRequests: true,
        })
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current.threadsMap['t-reconcile']?.status).toBe('running');

      livePhase = 'idle';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });

      expect(result.current.threadsMap['t-reconcile']?.status).toBe('idle');
      expect(
        result.current.threadsMap['t-reconcile']?.items.some(
          (it) => it.text === 'Final response synced automatically.'
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents initial mount initChatView from clobbering a new-thread request and assigns workspace / syncs titles cleanly', async () => {
    let resolveSavedGrid: ((val: unknown) => void) | null = null;
    const assignedEvents: Array<{ threadId?: string; workspaceId?: string | null }> = [];
    const onAssigned = (e: Event) =>
      assignedEvents.push((e as CustomEvent<{ threadId?: string; workspaceId?: string | null }>).detail);
    window.addEventListener('kite:thread-workspace-assigned', onAssigned);

    let summaryTitle = 'New Chat';
    let summaryWorkspaceId: string | null = 'ws-kite';

    const oldThread = {
      id: 't-old',
      title: 'Old Thread',
      provider: 'claude',
      status: 'idle',
      workspaceId: null,
      items: [],
    };
    const newWsThread = {
      id: 't-new-ws',
      title: 'New Chat',
      provider: 'claude',
      status: 'idle',
      workspaceId: 'ws-kite',
      items: [],
    };
    const createdNullThreads: Array<string | null> = [];

    vi.mocked(invokeCommand).mockImplementation(async (cmd, args) => {
      const params = (args ?? {}) as Record<string, any>;
      if (cmd === 'load_thread_grid') {
        return new Promise((resolve) => {
          resolveSavedGrid = resolve;
        });
      }
      if (cmd === 'list_chat_summaries') {
        return {
          summaries: [
            { ...newWsThread, title: summaryTitle, workspaceId: summaryWorkspaceId },
            oldThread,
          ],
        };
      }
      if (cmd === 'load_chat_thread') {
        return params.threadId === 't-new-ws' ? newWsThread : oldThread;
      }
      if (cmd === 'create_general_chat') {
        createdNullThreads.push(params.workspaceId ?? null);
        if (params.workspaceId === 'ws-kite') {
          return newWsThread;
        }
        return {
          id: 't-unassigned',
          title: 'New Chat',
          provider: 'claude',
          status: 'idle',
          workspaceId: null,
          items: [],
        };
      }
      if (cmd === 'update_chat_configuration') {
        if (params.threadId === 't-new-ws') {
          summaryWorkspaceId = params.workspaceId ?? null;
          return {
            ...newWsThread,
            workspaceId: summaryWorkspaceId,
          };
        }
        return {
          id: params.threadId,
          title: 'New Chat',
          provider: 'claude',
          status: 'idle',
          workspaceId: params.workspaceId ?? null,
          items: [],
        };
      }
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      if (cmd === 'list_live_chat_runs') return [];
      return null;
    });

    try {
      const { result } = renderHook(() =>
        useChatSession({
          workspaceId: 'ws-code',
          threadId: null,
          agents: [],
          ownsNewThreadRequests: true,
        })
      );

      await act(async () => {
        requestNewThread('ws-kite');
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.focusedThreadId).toBe('t-new-ws');
        expect(result.current.isLoadingInitial).toBe(false);
      });

      // Late resolution of initial saved grid must NOT clobber t-new-ws back to t-old
      await act(async () => {
        resolveSavedGrid?.({ grid: { threadIds: ['t-old'], focusedThreadId: 't-old' } });
        await Promise.resolve();
      });

      expect(result.current.focusedThreadId).toBe('t-new-ws');
      expect(result.current.gridThreadIds).toEqual(['t-new-ws']);

      // Assigning another workspace via global event updates thread + fires sidebar expansion event
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('kite:assign-thread-workspace', {
            detail: { threadId: 't-new-ws', workspaceId: 'ws-other' },
          })
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.threadsMap['t-new-ws']?.workspaceId).toBe('ws-other');
      });
      expect(assignedEvents).toContainEqual({ threadId: 't-new-ws', workspaceId: 'ws-other' });

      // Regenerated / healed summary titles propagate into threadsMap on kite:threads-changed
      summaryTitle = 'Fix folder association on new threads';
      await act(async () => {
        window.dispatchEvent(new CustomEvent('kite:threads-changed'));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(result.current.threadsMap['t-new-ws']?.title).toBe(
          'Fix folder association on new threads'
        );
      });

      // Calling handleCreateNewThread(null) stays unassigned despite Code-mode props.workspaceId = 'ws-code'
      await act(async () => {
        await result.current.handleCreateNewThread(null);
      });
      expect(createdNullThreads).toContain(null);
      expect(createdNullThreads).not.toContain('ws-code');
    } finally {
      window.removeEventListener('kite:thread-workspace-assigned', onAssigned);
    }
  });

  it('persists queued messages with attachments across thread switches and automatically dispatches FIFO when a turn settles', async () => {
    const imgAttachment = {
      resourceId: 'att-img-q',
      displayName: 'screenshot.png',
      isDirectory: false,
      byteSize: 4096,
      mimeType: 'image/png',
      path: 'C:/tmp/screenshot.png',
    };
    let serverRunningStatus: 'running' | 'idle' = 'running';
    let serverQueuedRuns: Array<{ id: string; text: string; attachments?: unknown[] }> = [];
    let resolveActiveRunPoll: ((val: unknown) => void) | null = null;
    const startedTurns: Array<{ threadId?: string; prompt?: string; attachments?: unknown[] }> = [];

    const runningThread = {
      id: 't-work',
      title: 'Working Thread',
      provider: 'claude',
      mode: 'acceptEdits',
      status: 'running',
      items: [{ id: 'u1', kind: 'user', text: 'Initial task' }],
      queuedRuns: [],
    };
    const otherThread = {
      id: 't-other',
      title: 'Other Thread',
      provider: 'claude',
      mode: 'acceptEdits',
      status: 'idle',
      items: [{ id: 'u2', kind: 'user', text: 'Other task' }],
      queuedRuns: [],
    };

    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([runningThread, otherThread]));
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['t-work'], focusedThreadId: 't-work' })
    );
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-work`, JSON.stringify(runningThread));
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-other`, JSON.stringify(otherThread));

    vi.mocked(invokeCommand).mockImplementation(async (cmd, args) => {
      const params = (args ?? {}) as {
        threadId?: string;
        prompt?: string;
        attachments?: unknown[];
        queuedRuns?: Array<{ id: string; text: string; attachments?: unknown[] }>;
      };
      if (cmd === 'list_chat_summaries') {
        return {
          summaries: [
            { ...runningThread, status: serverRunningStatus, queuedRuns: serverQueuedRuns },
            otherThread,
          ],
        };
      }
      if (cmd === 'load_thread_grid') {
        return { grid: { threadIds: ['t-work'], focusedThreadId: 't-work' } };
      }
      if (cmd === 'load_chat_thread') {
        if (params.threadId === 't-other') return otherThread;
        // Simulate stale backend response before update_chat_configuration finishes
        return {
          ...runningThread,
          status: serverRunningStatus,
          queuedRuns: serverQueuedRuns,
        };
      }
      if (cmd === 'update_chat_configuration') {
        if (Array.isArray(params.queuedRuns)) {
          serverQueuedRuns = params.queuedRuns;
        }
        return {
          ...runningThread,
          status: serverRunningStatus,
          queuedRuns: serverQueuedRuns,
        };
      }
      if (cmd === 'start_chat_turn') {
        startedTurns.push({
          threadId: params.threadId,
          prompt: params.prompt,
          attachments: params.attachments,
        });
        serverRunningStatus = 'running';
        return {
          runId: `run-${startedTurns.length}`,
          thread: {
            ...runningThread,
            status: 'running',
            queuedRuns: serverQueuedRuns,
            items: [
              ...runningThread.items,
              { id: `u-next-${startedTurns.length}`, kind: 'user', text: params.prompt ?? '' },
            ],
          },
        };
      }
      if (cmd === 'read_chat_turn_updates') {
        const runId = (args as { runId?: string })?.runId;
        if (runId === 'run-live-1') {
          return new Promise((resolve) => {
            resolveActiveRunPoll = resolve;
          });
        }
        return new Promise(() => {});
      }
      if (cmd === 'list_live_chat_runs') {
        return serverRunningStatus === 'running'
          ? [{ threadId: 't-work', runId: 'run-live-1', nextSequence: 0 }]
          : [];
      }
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      return null;
    });

    const { result } = renderHook(() =>
      useChatSession({
        workspaceId: 'ws-1',
        threadId: 't-work',
        agents: [],
        ownsNewThreadRequests: true,
      })
    );

    await waitFor(() => {
      expect(result.current.focusedThreadId).toBe('t-work');
    });

    // Queue two messages while t-work is running
    act(() => {
      result.current.handleQueuePrompt('t-work', 'Queued step 1 with image', [imgAttachment]);
      result.current.handleQueuePrompt('t-work', 'Queued step 2');
    });

    expect(result.current.threadsMap['t-work']?.queuedRuns).toHaveLength(2);
    expect(result.current.threadsMap['t-work']?.queuedRuns?.[0]?.text).toBe(
      'Queued step 1 with image'
    );
    expect(result.current.threadsMap['t-work']?.queuedRuns?.[0]?.attachments).toEqual([
      imgAttachment,
    ]);

    // Switch to t-other and immediately back to t-work -> queuedRuns must NOT be lost
    await act(async () => {
      await result.current.handleLoadThread('t-other');
    });
    expect(result.current.focusedThreadId).toBe('t-other');

    await act(async () => {
      await result.current.handleLoadThread('t-work');
    });
    expect(result.current.focusedThreadId).toBe('t-work');
    expect(result.current.threadsMap['t-work']?.queuedRuns).toHaveLength(2);
    expect(result.current.threadsMap['t-work']?.queuedRuns?.[0]?.text).toBe(
      'Queued step 1 with image'
    );

    // Simulate active turn completing (running -> idle) -> FIFO auto-dispatches queuedRuns[0]
    serverRunningStatus = 'idle';
    await act(async () => {
      resolveActiveRunPoll?.({
        schemaVersion: 1,
        runId: 'run-live-1',
        nextSequence: 1,
        finished: true,
        resyncRequired: false,
        events: [],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(startedTurns).toHaveLength(1);
    });
    expect(startedTurns[0]).toEqual({
      threadId: 't-work',
      prompt: 'Queued step 1 with image',
      attachments: [imgAttachment],
    });
    expect(result.current.threadsMap['t-work']?.queuedRuns).toHaveLength(1);
    expect(result.current.threadsMap['t-work']?.queuedRuns?.[0]?.text).toBe('Queued step 2');
  });

  it('steers and sends-now queued items cleanly across cancel->send without stale isRunning drop, FIFO steal, or queue resurrection, and preserves live items on config update', async () => {
    const imgAtt = {
      resourceId: 'att-steer-1',
      displayName: 'shot.png',
      isDirectory: false,
      byteSize: 512,
      mimeType: 'image/png',
    };
    const startedPrompts: Array<{ prompt?: string; attachments?: unknown[] }> = [];
    const cancelledThreads: string[] = [];

    const runningThread = {
      id: 't-live',
      title: 'Live Thread',
      provider: 'antigravity',
      mode: 'acceptEdits',
      model: 'gemini-2.5-pro',
      effort: 'medium',
      status: 'running',
      items: [
        { id: 'u1', kind: 'user', text: 'Initial prompt' },
        { id: 'a1', kind: 'assistant', text: 'Streaming response chunk...', streaming: true, status: 'running' },
      ],
      queuedRuns: [
        { id: 'q-1', text: 'Queued first' },
        { id: 'q-2', text: 'Queued second', attachments: [imgAtt] },
      ],
    };

    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([runningThread]));
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['t-live'], focusedThreadId: 't-live' })
    );
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-live`, JSON.stringify(runningThread));

    let resolveStartTurn: ((val: unknown) => void) | null = null;
    vi.mocked(invokeCommand).mockImplementation(async (cmd, args) => {
      const params = (args ?? {}) as Record<string, any>;
      if (cmd === 'list_chat_summaries') return { summaries: [runningThread] };
      if (cmd === 'load_thread_grid') {
        return { grid: { threadIds: ['t-live'], focusedThreadId: 't-live' } };
      }
      if (cmd === 'load_chat_thread') return runningThread;
      if (cmd === 'list_live_chat_runs') {
        return [{ threadId: 't-live', runId: 'run-live', nextSequence: 0 }];
      }
      if (cmd === 'read_chat_turn_updates') {
        return new Promise(() => {});
      }
      if (cmd === 'cancel_chat_turn') {
        cancelledThreads.push(params.threadId);
        return undefined;
      }
      if (cmd === 'update_chat_configuration') {
        if (params.model) {
          // Simulate backend returning stale empty items & idle status while turn is streaming
          return {
            ...runningThread,
            model: params.model,
            effort: params.effort ?? runningThread.effort,
            status: 'idle',
            items: [{ id: 'u1', kind: 'user', text: 'Initial prompt' }],
            queuedRuns: [],
          };
        }
        return {
          ...runningThread,
          queuedRuns: params.queuedRuns ?? [],
        };
      }
      if (cmd === 'start_chat_turn') {
        startedPrompts.push({ prompt: params.prompt, attachments: params.attachments });
        if (startedPrompts.length === 1) {
          // Return stale server snapshot still holding q-2 to verify cleared queue doesn't resurrect
          return {
            schemaVersion: 1,
            runId: 'run-next-1',
            thread: {
              ...runningThread,
              status: 'running',
              queuedRuns: [{ id: 'q-1', text: 'Queued first' }, { id: 'q-2', text: 'Queued second', attachments: [imgAtt] }],
            },
          };
        }
        return new Promise((resolve) => {
          resolveStartTurn = resolve;
        });
      }
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      return null;
    });

    const { result } = renderHook(() =>
      useChatSession({
        workspaceId: 'ws-1',
        threadId: 't-live',
        agents: [],
        ownsNewThreadRequests: true,
      })
    );

    await waitFor(() => {
      expect(result.current.focusedThreadId).toBe('t-live');
    });

    // 1. Update config while running: must update model WITHOUT clobbering live streamed items, status, or queuedRuns
    await act(async () => {
      await result.current.handleUpdateConfig('t-live', { model: 'gemini-2.5-flash' });
    });
    expect(result.current.threadsMap['t-live']?.model).toBe('gemini-2.5-flash');
    expect(result.current.threadsMap['t-live']?.status).toBe('running');
    expect(result.current.threadsMap['t-live']?.items).toHaveLength(2);
    expect(result.current.threadsMap['t-live']?.items[1]?.text).toBe('Streaming response chunk...');
    expect(result.current.threadsMap['t-live']?.queuedRuns).toHaveLength(2);

    // 2. Send now on q-2 while q-1 is still queued -> cancels active turn and starts q-2 (NOT q-1!)
    await act(async () => {
      await result.current.handleSendNowQueuedRun('t-live', 'q-2');
    });
    expect(cancelledThreads).toEqual(['t-live']);
    expect(startedPrompts).toEqual([{ prompt: 'Queued second', attachments: [imgAtt] }]);
    expect(result.current.threadsMap['t-live']?.queuedRuns?.map((r) => r.id)).toEqual(['q-1']);

    // 3. Remove q-1 so queue is [], then Steer -> cancels active turn, starts steer prompt, does NOT resurrect q-1 or q-2
    act(() => {
      result.current.handleUpdateQueuedRuns('t-live', []);
    });
    expect(result.current.threadsMap['t-live']?.queuedRuns).toEqual([]);

    await act(async () => {
      const steerPromise = result.current.handleSteerPrompt('t-live', 'Steer immediately', [imgAtt]);
      await Promise.resolve();
      await Promise.resolve();
      resolveStartTurn?.({
        schemaVersion: 1,
        runId: 'run-steer-2',
        thread: {
          ...runningThread,
          status: 'running',
          queuedRuns: [{ id: 'q-1', text: 'Queued first' }],
        },
      });
      await steerPromise;
    });

    expect(startedPrompts).toHaveLength(2);
    expect(startedPrompts[1]).toEqual({ prompt: 'Steer immediately', attachments: [imgAtt] });
    expect(result.current.threadsMap['t-live']?.queuedRuns).toEqual([]);
  });

  it('ignores stale out-of-order handleUpdateConfig responses and preserves draft/queue if cancel fails during steer or sendNow', async () => {
    const imgAtt = {
      resourceId: 'att-res-fail',
      displayName: 'shot.png',
      isDirectory: false,
      byteSize: 512,
      mimeType: 'image/png',
    };
    const runningThread = {
      id: 't-race',
      title: 'Race Thread',
      provider: 'antigravity',
      mode: 'acceptEdits',
      model: 'initial-model',
      status: 'running',
      items: [],
      queuedRuns: [{ id: 'q-stay', text: 'Stay in queue', attachments: [imgAtt] }],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };

    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([runningThread]));
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['t-race'], focusedThreadId: 't-race' })
    );
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-race`, JSON.stringify(runningThread));

    let resolveFirstConfig: ((v: unknown) => void) | null = null;
    vi.mocked(invokeCommand).mockImplementation(async (cmd, rawArgs) => {
      const params = (rawArgs ?? {}) as { model?: string; queuedRuns?: unknown[] };
      if (cmd === 'list_chat_summaries') return { summaries: [runningThread] };
      if (cmd === 'load_thread_grid') return { grid: { threadIds: ['t-race'], focusedThreadId: 't-race' } };
      if (cmd === 'load_chat_thread') return runningThread;
      if (cmd === 'list_live_chat_runs') return [];
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      if (cmd === 'cancel_chat_turn') throw new Error('cancel timeout');
      if (cmd === 'update_chat_configuration') {
        if (params.model === 'stale-first-model') {
          return new Promise((resolve) => {
            resolveFirstConfig = resolve;
          });
        }
        return { ...runningThread, model: params.model ?? 'second-newer-model', queuedRuns: params.queuedRuns ?? runningThread.queuedRuns };
      }
      return null;
    });

    const { result } = renderHook(() =>
      useChatSession({
        workspaceId: 'ws-1',
        threadId: 't-race',
        agents: [],
        ownsNewThreadRequests: true,
      })
    );

    await waitFor(() => {
      expect(result.current.focusedThreadId).toBe('t-race');
    });

    // Overlapping config updates: second completes first, slower first resolves later and must NOT clobber second
    await act(async () => {
      const p1 = result.current.handleUpdateConfig('t-race', { model: 'stale-first-model' });
      const p2 = result.current.handleUpdateConfig('t-race', { model: 'second-newer-model' });
      await p2;
      resolveFirstConfig?.({ ...runningThread, model: 'stale-first-model' });
      await p1;
    });
    expect(result.current.threadsMap['t-race']?.model).toBe('second-newer-model');

    // Failed cancel during handleSendNowQueuedRun restores queued item
    await act(async () => {
      await result.current.handleSendNowQueuedRun('t-race', 'q-stay');
    });
    expect(result.current.threadsMap['t-race']?.queuedRuns?.map((q) => q.id)).toEqual(['q-stay']);

    // Failed cancel during handleSteerPrompt preserves prompt & attachments
    act(() => {
      result.current.setPromptMap((prev) => ({ ...prev, 't-race': 'Do not drop me' }));
      result.current.writeAttachments('t-race', [imgAtt]);
    });
    await act(async () => {
      await result.current.handleSteerPrompt('t-race', 'Do not drop me', [imgAtt]);
    });
    expect(result.current.promptMap['t-race']).toBe('Do not drop me');
    expect(result.current.attachmentsMap['t-race']).toEqual([imgAtt]);
  });
});
