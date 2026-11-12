import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ExtendedChatThread } from '../types';
import {
  CHAT_GRID_STORAGE_KEY,
  CHAT_SUMMARIES_STORAGE_KEY,
  CHAT_THREAD_STORAGE_PREFIX,
  sortAgentSummariesByTabOrder,
  loadAgentTabOrder,
  loadChatSummariesWithFallback,
  loadSavedGrid,
  loadThreadWithFallback,
  useChatGridPersistence,
} from './useChatGridPersistence';
import { invokeCommand } from '../../../../lib/ipc';

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
});
