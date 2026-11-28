import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ExtendedChatThread } from '../types';
import {
  CHAT_GRID_STORAGE_KEY,
  CHAT_SUMMARIES_STORAGE_KEY,
  CHAT_THREAD_STORAGE_PREFIX,
  MAX_CACHED_THREADS_IN_MEMORY,
  MAX_LOCAL_HYDRATION_ITEM_TEXT_CHARS,
  MAX_LOCAL_HYDRATION_STUB_BYTES,
  MAX_LOCAL_HYDRATION_STUB_ITEMS,
  THREAD_LOCAL_PERSIST_DEBOUNCE_MS,
  pruneThreadsMapLru,
  stripExternalizedAttachmentPreviews,
  toLocalHydrationStub,
  toThreadSummary,
  sortAgentSummariesByTabOrder,
  loadAgentTabOrder,
  loadChatSummariesWithFallback,
  loadSavedGrid,
  loadThreadWithFallback,
  useChatGridPersistence,
} from './useChatGridPersistence';
import {
  MAX_FILE_DIFF_CACHE_ENTRIES,
  createWorkspaceGitService,
} from '../../files/gitTypes';
import {
  MAX_OPEN_FILE_TABS,
  appendOpenFileTabLru,
  pruneMapLru,
} from '../../FilesView';
import { invokeCommand } from '../../../../lib/ipc';
import {
  MAX_DIFF_CONTENTS_CACHE_ENTRIES,
  createDiffFileContentsLoader,
} from '../../../../lib/diffs/diffFileContents';
import {
  MAX_VOICE_HISTORY_THREADS,
  voiceSessionStore,
} from '../../../../lib/operator/voice/voiceSessionStore';

vi.mock('../../../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

describe('grid sorting and helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('sorts agent summaries by tabOrder ascending', () => {
    const list = [
      { id: 't-2', tabOrder: 2 } as unknown as ExtendedChatThread,
      { id: 't-1', tabOrder: 1 } as unknown as ExtendedChatThread,
      { id: 't-3' } as unknown as ExtendedChatThread,
    ];
    const sorted = sortAgentSummariesByTabOrder(list);
    expect(sorted.map((t) => t.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(loadAgentTabOrder(list)).toEqual(['t-1', 't-2', 't-3']);
  });

  it('loads summaries from localStorage fallback when invokeCommand fails or is empty', async () => {
    vi.mocked(invokeCommand).mockRejectedValueOnce(new Error('fail'));
    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([{ id: 't-local' }]));

    const summaries = await loadChatSummariesWithFallback(null);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('t-local');
  });

  it('loads saved grid from localStorage fallback', async () => {
    vi.mocked(invokeCommand).mockRejectedValueOnce(new Error('fail'));
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['t-1', 't-2'], focusedThreadId: 't-2' })
    );

    const grid = await loadSavedGrid(null);
    expect(grid.threadIds).toEqual(['t-1', 't-2']);
    expect(grid.focusedThreadId).toBe('t-2');
  });

  it('loads single thread with localStorage fallback', async () => {
    vi.mocked(invokeCommand).mockRejectedValueOnce(new Error('fail'));
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}t-fallback`, JSON.stringify({ id: 't-fallback', title: 'Test' }));

    const thread = await loadThreadWithFallback('t-fallback', null);
    expect(thread?.id).toBe('t-fallback');
    expect(thread?.title).toBe('Test');
  });

  it('normalizes missing items array from IPC or cached threads', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce({
      id: 'parent-done-test',
      title: 'Completed Thread',
    });

    const loadedFromIpc = await loadThreadWithFallback('parent-done-test', null);
    expect(Array.isArray(loadedFromIpc?.items)).toBe(true);
    expect(loadedFromIpc?.items).toEqual([]);

    vi.mocked(invokeCommand).mockRejectedValueOnce(new Error('offline'));
    localStorage.setItem(
      `${CHAT_THREAD_STORAGE_PREFIX}t-cache-no-items`,
      JSON.stringify({ id: 't-cache-no-items', title: 'Cached No Items' })
    );
    const loadedFromCache = await loadThreadWithFallback('t-cache-no-items', null);
    expect(Array.isArray(loadedFromCache?.items)).toBe(true);
    expect(loadedFromCache?.items).toEqual([]);
  });

  it('does not resurrect stale localStorage summaries or grid when IPC returns authoritative empty state', async () => {
    localStorage.setItem(
      CHAT_SUMMARIES_STORAGE_KEY,
      JSON.stringify([
        { id: 't-stale-general' },
        { id: 't-agent-keep', profileId: 'agent-1' },
      ])
    );
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['t-stale-general'], focusedThreadId: 't-stale-general' })
    );

    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'list_chat_summaries') return { summaries: [] };
      if (cmd === 'load_thread_grid') return { grid: null };
      return null;
    });

    const summaries = await loadChatSummariesWithFallback(null);
    const grid = await loadSavedGrid(null);

    expect(summaries).toEqual([]);
    expect(grid).toEqual({ threadIds: [], focusedThreadId: null });
    expect(JSON.parse(localStorage.getItem(CHAT_SUMMARIES_STORAGE_KEY) || '[]')).toEqual([
      { id: 't-agent-keep', profileId: 'agent-1' },
    ]);
    expect(JSON.parse(localStorage.getItem(CHAT_GRID_STORAGE_KEY) || '{}')).toEqual({
      threadIds: [],
      focusedThreadId: null,
    });
  });
});

describe('useChatGridPersistence hook', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('persists grid layout and provides split/drop/close actions', async () => {
    const setThreadsMap = vi.fn();
    const setKnownThreadsList = vi.fn();
    const threadWithResolvedBinding = (t: ExtendedChatThread) => t;
    const attachmentsMapRef = { current: {} };
    const writeAttachments = vi.fn();
    const isMountedRef = { current: true };

    const { result } = renderHook(() =>
      useChatGridPersistence({
        agentId: null,
        workspaceId: 'ws-1',
        draftConfig: { provider: 'antigravity', mode: 'acceptEdits', model: null, effort: null },
        threadsMap: { 't-1': { id: 't-1' } as unknown as ExtendedChatThread },
        setThreadsMap,
        knownThreadsList: [{ id: 't-1' } as unknown as ExtendedChatThread],
        setKnownThreadsList,
        threadWithResolvedBinding,
        attachmentsMapRef,
        writeAttachments,
        isMountedRef,
      })
    );

    await act(async () => {
      await result.current.persistGrid(['t-1'], 't-1');
    });

    expect(JSON.parse(localStorage.getItem(CHAT_GRID_STORAGE_KEY)!)).toEqual({
      threadIds: ['t-1'],
      focusedThreadId: 't-1',
    });

    act(() => {
      result.current.setGridThreadIds(['t-1', 't-2']);
      result.current.setFocusedThreadId('t-1');
    });

    act(() => {
      result.current.handleClosePane('t-1');
    });

    expect(result.current.gridThreadIds).toEqual(['t-2']);
    expect(result.current.focusedThreadId).toBe('t-2');
  });

  it('strips items from summaries, strips externalized attachment previews, and enforces LRU caps', async () => {
    const heavyThread = {
      id: 't-heavy',
      title: 'Heavy',
      status: 'idle',
      items: [
        {
          id: 'u1',
          kind: 'user',
          text: 'Huge transcript item',
          attachments: [
            {
              resourceId: 'res-1',
              displayName: 'shot.png',
              path: 'C:\\Users\\PC\\AppData\\Roaming\\Kite Code\\chat-attachments\\t-heavy\\res-1\\shot.png',
              previewDataUrl: 'data:image/png;base64,HUGE_BASE64',
            },
            {
              resourceId: '',
              displayName: 'legacy-inline.png',
              previewDataUrl: 'data:image/png;base64,LEGACY_KEEP',
            },
          ],
        },
      ],
    } as unknown as ExtendedChatThread;

    // 1. toThreadSummary strips heavy items[]
    const summary = toThreadSummary(heavyThread);
    expect(summary.id).toBe('t-heavy');
    expect(summary.items).toBeUndefined();

    // 2. stripExternalizedAttachmentPreviews strips base64 when path/resourceId exists, keeps legacy-only inline
    const cleaned = stripExternalizedAttachmentPreviews(heavyThread);
    const cleanedAtts = (cleaned.items[0] as unknown as { attachments: Array<{ previewDataUrl?: string }> }).attachments;
    expect(cleanedAtts[0].previewDataUrl).toBeUndefined();
    expect(cleanedAtts[1].previewDataUrl).toBe('data:image/png;base64,LEGACY_KEEP');

    // 3. pruneThreadsMapLru caps closed threads at MAX_CACHED_THREADS_IN_MEMORY while keeping protected/running
    const manyThreads: Record<string, ExtendedChatThread> = {};
    for (let i = 0; i < MAX_CACHED_THREADS_IN_MEMORY + 5; i += 1) {
      manyThreads[`t-${i}`] = {
        id: `t-${i}`,
        status: i === 0 ? 'running' : 'idle',
        items: [],
      } as unknown as ExtendedChatThread;
    }
    const pruned = pruneThreadsMapLru(manyThreads, ['t-1']);
    expect(Object.keys(pruned)).toHaveLength(MAX_CACHED_THREADS_IN_MEMORY);
    expect(pruned['t-0']).toBeDefined(); // running protected
    expect(pruned['t-1']).toBeDefined(); // open protected
    expect(pruned['t-2']).toBeUndefined(); // oldest closed evicted

    // 4. debounced dirty-only persistence writes only changed threads and strips externalized previews
    vi.useFakeTimers();
    try {
      const baseProps = {
        agentId: null,
        workspaceId: 'ws-1',
        draftConfig: { provider: 'antigravity' as const, mode: 'acceptEdits' as const, model: null, effort: null },
        setThreadsMap: vi.fn(),
        knownThreadsList: [heavyThread],
        setKnownThreadsList: vi.fn(),
        threadWithResolvedBinding: (t: ExtendedChatThread) => t,
        attachmentsMapRef: { current: {} },
        writeAttachments: vi.fn(),
        isMountedRef: { current: true },
      };
      const tA = { id: 't-a', title: 'A', items: [] } as unknown as ExtendedChatThread;
      const tB = heavyThread;
      const { rerender } = renderHook(
        ({ threadsMap }) => useChatGridPersistence({ ...baseProps, threadsMap }),
        { initialProps: { threadsMap: { 't-a': tA, 't-heavy': tB } } }
      );
      act(() => {
        vi.advanceTimersByTime(THREAD_LOCAL_PERSIST_DEBOUNCE_MS + 10);
      });
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-heavy`)).not.toContain('HUGE_BASE64');
      expect(localStorage.getItem(CHAT_SUMMARIES_STORAGE_KEY)).not.toContain('Huge transcript item');

      // Remove t-heavy from localStorage; updating only t-a must NOT re-serialize untouched t-heavy.
      localStorage.removeItem(`${CHAT_THREAD_STORAGE_PREFIX}t-heavy`);
      const tA2 = { id: 't-a', title: 'A-updated', items: [] } as unknown as ExtendedChatThread;
      rerender({ threadsMap: { 't-a': tA2, 't-heavy': tB } });
      act(() => {
        vi.advanceTimersByTime(THREAD_LOCAL_PERSIST_DEBOUNCE_MS + 10);
      });
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-a`)).toContain('A-updated');
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-heavy`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // 5. Git diff cache LRU caps at MAX_FILE_DIFF_CACHE_ENTRIES
    vi.mocked(invokeCommand).mockResolvedValue({ diff: '' });
    const gitSvc = createWorkspaceGitService();
    for (let i = 0; i < MAX_FILE_DIFF_CACHE_ENTRIES + 5; i += 1) {
      await gitSvc.readWorkspaceFileDiff('ws-1', `file-${i}.ts`, false);
    }
    vi.mocked(invokeCommand).mockClear();
    // Oldest entry (file-0.ts) was evicted and must re-fetch; newest entry stays cached.
    await gitSvc.readWorkspaceFileDiff('ws-1', `file-${MAX_FILE_DIFF_CACHE_ENTRIES + 4}.ts`, false);
    expect(invokeCommand).not.toHaveBeenCalled();
    await gitSvc.readWorkspaceFileDiff('ws-1', 'file-0.ts', false);
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    // 6. FilesView open tabs & map LRU helpers cap cleanly while keeping dirty tabs
    let tabs: Parameters<typeof appendOpenFileTabLru>[0] = [];
    for (let i = 0; i < MAX_OPEN_FILE_TABS + 4; i += 1) {
      tabs = appendOpenFileTabLru(tabs, {
        entryId: `e-${i}`,
        name: `f-${i}.ts`,
        relativePath: `f-${i}.ts`,
        revision: '1',
        draftText: i === 0 ? 'unsaved' : 'clean',
        initialText: 'clean',
        previewData: null,
      });
    }
    expect(tabs).toHaveLength(MAX_OPEN_FILE_TABS);
    expect(tabs.some((t) => t.entryId === 'e-0')).toBe(true); // unsaved preserved
    expect(tabs.some((t) => t.entryId === 'e-1')).toBe(false); // oldest clean evicted

    const m = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]]);
    const prunedMap = pruneMapLru(m, 2, new Set(['a']));
    expect(prunedMap.size).toBe(2);
    expect(prunedMap.has('a')).toBe(true);
    expect(prunedMap.has('b')).toBe(false);
  });

  it('bounds toLocalHydrationStub below 150 KB, defers mid-turn streaming writes, and cleans evicted LRU keys', () => {
    const giantText = 'x'.repeat(20_000);
    const items = Array.from({ length: 60 }, (_, idx) => ({
      id: `item-${idx}`,
      kind: 'tool',
      title: `Tool ${idx}`,
      text: giantText,
      detail: giantText,
      status: 'completed',
      streaming: false,
      exitCode: null,
      createdAtUnixMs: idx,
      attachments: [],
    }));
    const massiveThread = {
      id: 't-massive',
      title: 'Massive Thread',
      status: 'idle',
      items,
      subagentRuns: [
        {
          subagentId: 'sub-1',
          parentThreadId: 't-massive',
          parentToolCallId: 'call-1',
          role: 'Explorer',
          status: 'completed',
          stepCount: 40,
          startedAtUnixMs: 1,
          updatedAtUnixMs: 2,
          items: items.slice(0, 20),
        },
      ],
    } as unknown as ExtendedChatThread;

    const stub = toLocalHydrationStub(massiveThread);
    const serialized = JSON.stringify(stub);
    expect(serialized.length).toBeLessThanOrEqual(MAX_LOCAL_HYDRATION_STUB_BYTES);
    expect(stub.items.length).toBeLessThanOrEqual(MAX_LOCAL_HYDRATION_STUB_ITEMS);
    expect(stub.items[stub.items.length - 1]?.id).toBe('item-59');
    expect(stub.items[0]?.text?.length).toBeLessThanOrEqual(MAX_LOCAL_HYDRATION_ITEM_TEXT_CHARS);
    expect(stub.subagentRuns?.[0]?.items).toEqual([]);
    expect(stub.subagentRuns?.[0]?.stepCount).toBe(40);

    // LRU eviction also removes stale localStorage entries
    const manyThreads: Record<string, ExtendedChatThread> = {};
    for (let i = 0; i < MAX_CACHED_THREADS_IN_MEMORY + 3; i += 1) {
      const id = `t-lru-${i}`;
      localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}${id}`, '{}');
      manyThreads[id] = { id, status: 'idle', items: [] } as unknown as ExtendedChatThread;
    }
    pruneThreadsMapLru(manyThreads, []);
    expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-lru-0`)).toBeNull();
    expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-lru-1`)).toBeNull();
    expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-lru-2`)).toBeNull();
    expect(
      localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-lru-${MAX_CACHED_THREADS_IN_MEMORY + 2}`)
    ).toBe('{}');

    // Mid-turn streaming deltas do not write to localStorage until the turn settles
    vi.useFakeTimers();
    try {
      const baseProps = {
        agentId: null,
        workspaceId: 'ws-1',
        draftConfig: { provider: 'antigravity' as const, mode: 'acceptEdits' as const, model: null, effort: null },
        setThreadsMap: vi.fn(),
        knownThreadsList: [],
        setKnownThreadsList: vi.fn(),
        threadWithResolvedBinding: (t: ExtendedChatThread) => t,
        attachmentsMapRef: { current: {} },
        writeAttachments: vi.fn(),
        isMountedRef: { current: true },
      };
      const settled0 = {
        id: 't-stream',
        title: 'Stream',
        status: 'idle',
        items: [{ id: 'm1', kind: 'assistant', text: 'v0', streaming: false }],
      } as unknown as ExtendedChatThread;

      const { rerender } = renderHook(
        ({ threadsMap }) => useChatGridPersistence({ ...baseProps, threadsMap }),
        { initialProps: { threadsMap: { 't-stream': settled0 } } }
      );
      act(() => {
        vi.advanceTimersByTime(THREAD_LOCAL_PERSIST_DEBOUNCE_MS + 10);
      });
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-stream`)).toContain('"v0"');

      for (let step = 1; step <= 5; step += 1) {
        const streamingNext = {
          id: 't-stream',
          title: 'Stream',
          status: 'running',
          items: [{ id: 'm1', kind: 'assistant', text: `delta-${step}`, streaming: true }],
        } as unknown as ExtendedChatThread;
        rerender({ threadsMap: { 't-stream': streamingNext } });
        act(() => {
          vi.advanceTimersByTime(THREAD_LOCAL_PERSIST_DEBOUNCE_MS + 10);
        });
      }
      // Still holds the pre-stream 'v0' snapshot; zero mid-turn overwrites occurred
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-stream`)).toContain('"v0"');
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-stream`)).not.toContain('delta-');

      const settledFinal = {
        id: 't-stream',
        title: 'Stream',
        status: 'idle',
        items: [{ id: 'm1', kind: 'assistant', text: 'settled-final', streaming: false }],
      } as unknown as ExtendedChatThread;
      rerender({ threadsMap: { 't-stream': settledFinal } });
      act(() => {
        vi.advanceTimersByTime(THREAD_LOCAL_PERSIST_DEBOUNCE_MS + 10);
      });
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-stream`)).toContain('settled-final');
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts dropped thread IDs from lastPersistedThreadsRef so re-added identical references persist again and strips subagentRuns items in summaries', () => {
    const heavySubagentThread = {
      id: 't-sub-strip',
      title: 'Sub Strip',
      status: 'idle',
      items: [{ id: 'm1', kind: 'user', text: 'parent msg' }],
      subagentRuns: [
        {
          subagentId: 'sub-1',
          parentThreadId: 't-sub-strip',
          parentToolCallId: 'call-1',
          role: 'Explorer',
          status: 'completed',
          stepCount: 2,
          startedAtUnixMs: 1,
          updatedAtUnixMs: 2,
          items: [{ id: 'sub-m1', kind: 'assistant', text: 'subagent heavy step' }],
        },
      ],
    } as unknown as ExtendedChatThread;

    const summary = toThreadSummary(heavySubagentThread);
    expect(summary.items).toBeUndefined();
    expect(summary.subagentRuns?.[0]?.items).toEqual([]);

    vi.useFakeTimers();
    try {
      const baseProps = {
        agentId: null,
        workspaceId: 'ws-1',
        draftConfig: { provider: 'antigravity' as const, mode: 'acceptEdits' as const, model: null, effort: null },
        setThreadsMap: vi.fn(),
        knownThreadsList: [],
        setKnownThreadsList: vi.fn(),
        threadWithResolvedBinding: (t: ExtendedChatThread) => t,
        attachmentsMapRef: { current: {} },
        writeAttachments: vi.fn(),
        isMountedRef: { current: true },
      };

      const tKeep = { id: 't-keep', title: 'Keep', items: [] } as unknown as ExtendedChatThread;
      const tEvict = { id: 't-evict', title: 'EvictMe', items: [] } as unknown as ExtendedChatThread;

      const { rerender } = renderHook(
        ({ threadsMap }) => useChatGridPersistence({ ...baseProps, threadsMap }),
        { initialProps: { threadsMap: { 't-keep': tKeep, 't-evict': tEvict } as Record<string, ExtendedChatThread> } }
      );

      act(() => {
        vi.advanceTimersByTime(THREAD_LOCAL_PERSIST_DEBOUNCE_MS + 10);
      });
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-evict`)).toContain('EvictMe');

      // Simulate LRU eviction: t-evict is dropped from threadsMap and removed from localStorage.
      localStorage.removeItem(`${CHAT_THREAD_STORAGE_PREFIX}t-evict`);
      rerender({ threadsMap: { 't-keep': tKeep } });

      // Re-opening the exact same tEvict object reference must see it was evicted from lastPersistedThreadsRef
      // and write its snapshot back to localStorage.
      rerender({ threadsMap: { 't-keep': tKeep, 't-evict': tEvict } });
      act(() => {
        vi.advanceTimersByTime(THREAD_LOCAL_PERSIST_DEBOUNCE_MS + 10);
      });
      expect(localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}t-evict`)).toContain('EvictMe');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies pruneThreadsMapLru and toThreadSummary when handleToggleSplit creates a new thread', async () => {
    const initialMap: Record<string, ExtendedChatThread> = {};
    for (let i = 0; i < MAX_CACHED_THREADS_IN_MEMORY; i += 1) {
      initialMap[`t-${i}`] = {
        id: `t-${i}`,
        title: `Thread ${i}`,
        status: 'idle',
        items: [],
      } as unknown as ExtendedChatThread;
    }

    let currentThreadsMap = initialMap;
    const setThreadsMap = vi.fn((updater) => {
      currentThreadsMap = typeof updater === 'function' ? updater(currentThreadsMap) : updater;
    });
    let currentKnown: ExtendedChatThread[] = [initialMap['t-0']];
    const setKnownThreadsList = vi.fn((updater) => {
      currentKnown = typeof updater === 'function' ? updater(currentKnown) : updater;
    });

    const createdSplitThread = {
      id: 't-split-new',
      title: 'Split New',
      status: 'idle',
      items: [{ id: 'm-split', kind: 'user', text: 'SPLIT_FULL_ITEM' }],
      subagentRuns: [
        {
          subagentId: 'sub-split',
          parentThreadId: 't-split-new',
          parentToolCallId: 'call-split',
          role: 'Explorer',
          status: 'completed',
          stepCount: 1,
          startedAtUnixMs: 1,
          updatedAtUnixMs: 2,
          items: [{ id: 'sub-item', kind: 'assistant', text: 'SPLIT_SUBAGENT_ITEM' }],
        },
      ],
    } as unknown as ExtendedChatThread;

    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'create_general_chat') return createdSplitThread;
      return undefined;
    });

    const { result } = renderHook(() =>
      useChatGridPersistence({
        agentId: null,
        workspaceId: 'ws-1',
        draftConfig: { provider: 'antigravity', mode: 'acceptEdits', model: null, effort: null },
        threadsMap: currentThreadsMap,
        setThreadsMap,
        knownThreadsList: currentKnown,
        setKnownThreadsList,
        threadWithResolvedBinding: (t) => t,
        attachmentsMapRef: { current: {} },
        writeAttachments: vi.fn(),
        isMountedRef: { current: true },
        initialGrid: { threadIds: ['t-0'], focusedThreadId: 't-0' },
      })
    );

    await act(async () => {
      await result.current.handleToggleSplit();
    });

    expect(Object.keys(currentThreadsMap)).toHaveLength(MAX_CACHED_THREADS_IN_MEMORY);
    expect(currentThreadsMap['t-0']).toBeDefined();
    expect(currentThreadsMap['t-split-new']).toBeDefined();
    expect(currentThreadsMap['t-1']).toBeUndefined();

    const addedSummary = currentKnown.find((t) => t.id === 't-split-new');
    expect(addedSummary).toBeDefined();
    expect(addedSummary?.items).toBeUndefined();
    expect(addedSummary?.subagentRuns?.[0]?.items).toEqual([]);
  });

  it('bounds diffFileContents cache to MAX_DIFF_CONTENTS_CACHE_ENTRIES (24) and voiceSessionStore turnsByThread to MAX_VOICE_HISTORY_THREADS (8)', async () => {
    expect(MAX_DIFF_CONTENTS_CACHE_ENTRIES).toBe(24);
    expect(MAX_VOICE_HISTORY_THREADS).toBe(8);

    const fetchContents = vi.fn().mockResolvedValue({
      oldContent: 'old',
      newContent: 'new',
    });
    const loader = createDiffFileContentsLoader('ws-lru', fetchContents);
    const makeMeta = (idx: number) =>
      ({
        name: `src/file-${idx}.ts`,
        type: 'change',
        hunks: [],
        splitLineCount: 0,
        unifiedLineCount: 0,
        deletionLines: ['old'],
        additionLines: ['new'],
      }) as unknown as Parameters<typeof loader>[0];

    for (let i = 0; i < MAX_DIFF_CONTENTS_CACHE_ENTRIES; i += 1) {
      await loader(makeMeta(i));
    }
    // Touch file-0 so file-1 becomes the least recently used entry
    await loader(makeMeta(0));
    // Insert 25th entry -> must evict file-1
    await loader(makeMeta(MAX_DIFF_CONTENTS_CACHE_ENTRIES));

    fetchContents.mockClear();
    await loader(makeMeta(0));
    await loader(makeMeta(MAX_DIFF_CONTENTS_CACHE_ENTRIES));
    expect(fetchContents).not.toHaveBeenCalled();

    await loader(makeMeta(1));
    expect(fetchContents).toHaveBeenCalledTimes(1);

    const createdVoiceThreads: string[] = ['vt-bound'];
    try {
      voiceSessionStore.startSession('vt-bound', 'thread');
      voiceSessionStore.addThreadVoiceTurn('vt-bound', {
        turnId: 'turn-bound',
        userPrompt: 'bound prompt',
        source: 'voz',
        reply: 'bound reply',
        createdAt: 1,
      });

      for (let i = 0; i < MAX_VOICE_HISTORY_THREADS + 2; i += 1) {
        const tid = `vt-hist-${i}`;
        createdVoiceThreads.push(tid);
        voiceSessionStore.addThreadVoiceTurn(tid, {
          turnId: `turn-${i}`,
          userPrompt: `prompt ${i}`,
          source: 'voz',
          reply: `reply ${i}`,
          createdAt: 10 + i,
        });
      }

      const internalMap = (
        voiceSessionStore as unknown as { turnsByThread: Record<string, unknown[]> }
      ).turnsByThread;
      expect(Object.keys(internalMap).length).toBeLessThanOrEqual(MAX_VOICE_HISTORY_THREADS);
      expect(internalMap['vt-bound']).toBeDefined();
      expect(internalMap['vt-hist-0']).toBeUndefined();
      // Evicted inactive thread still reloads seamlessly from localStorage on demand
      expect(voiceSessionStore.getThreadVoiceTurns('vt-hist-0')).toHaveLength(1);
    } finally {
      voiceSessionStore.stopSession();
      for (const tid of createdVoiceThreads) {
        voiceSessionStore.clearThreadVoiceTurns(tid);
      }
    }
  });
});
