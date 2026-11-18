import { useState, useEffect } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import type { ExtendedChatThread, ChatAttachment } from '../types';
import { draftThreadRequest, type ChatDraftConfig } from './useChatDraftConfig';

export const CHAT_GRID_STORAGE_KEY = 'kite.chat.grid.v1';
export const CHAT_SUMMARIES_STORAGE_KEY = 'kite.chat.summaries.v1';
export const CHAT_THREAD_STORAGE_PREFIX = 'kite.chat.thread.';

export interface SavedGridState {
  threadIds: string[];
  focusedThreadId: string | null;
}

export const readCachedChatSummaries = (agentId?: string | null): ExtendedChatThread[] => {
  try {
    const raw = localStorage.getItem(CHAT_SUMMARIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const typed = parsed.filter((t): t is ExtendedChatThread => Boolean(t && t.id));
    if (agentId) {
      return sortAgentSummariesByTabOrder(typed.filter((t) => t.profileId === agentId));
    }
    return typed.filter((t) => !t.profileId);
  } catch {
    return [];
  }
};

export const readCachedSavedGrid = (): SavedGridState | null => {
  try {
    const raw = localStorage.getItem(CHAT_GRID_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.threadIds)) {
      return {
        threadIds: parsed.threadIds.filter((id: unknown): id is string => typeof id === 'string'),
        focusedThreadId:
          typeof parsed.focusedThreadId === 'string' ? parsed.focusedThreadId : null,
      };
    }
  } catch {}
  return null;
};

export const normalizeLoadedThread = (thread: ExtendedChatThread): ExtendedChatThread =>
  Array.isArray(thread.items) ? thread : { ...thread, items: [] };

export const readCachedThread = (tid: string): ExtendedChatThread | null => {
  try {
    const localRaw = localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}${tid}`);
    if (localRaw) {
      const parsed = JSON.parse(localRaw);
      if (parsed && parsed.id) return normalizeLoadedThread(parsed as ExtendedChatThread);
    }
  } catch {}
  return null;
};

export interface InitialChatHydration {
  hydrated: boolean;
  summaries: ExtendedChatThread[];
  threadsMap: Record<string, ExtendedChatThread>;
  grid: SavedGridState;
}

/**
 * Reads previously persisted Thread summaries, grid layout, and pane snapshots
 * synchronously so reopening Thread renders immediately while IPC reconciles.
 */
export const hydrateInitialChatState = (
  agentId?: string | null,
  initialThreadId?: string | null
): InitialChatHydration => {
  const summaries = readCachedChatSummaries(agentId);
  const threadsMap: Record<string, ExtendedChatThread> = {};

  if (agentId) {
    const first = summaries[0];
    const cached = first?.id ? readCachedThread(first.id) : null;
    if (cached) {
      threadsMap[cached.id] = cached;
      return {
        hydrated: true,
        summaries,
        threadsMap,
        grid: { threadIds: [cached.id], focusedThreadId: cached.id },
      };
    }
    return {
      hydrated: false,
      summaries,
      threadsMap,
      grid: { threadIds: [], focusedThreadId: null },
    };
  }

  const savedGrid = readCachedSavedGrid();
  if (initialThreadId) {
    const targetCached = readCachedThread(initialThreadId);
    if (targetCached) {
      const ids = savedGrid?.threadIds.includes(initialThreadId)
        ? savedGrid.threadIds
        : [initialThreadId];
      for (const tid of ids) {
        const cached = readCachedThread(tid);
        if (cached) threadsMap[cached.id] = cached;
      }
      const validIds = ids.filter((id) => Boolean(threadsMap[id]));
      if (validIds.length > 0) {
        return {
          hydrated: true,
          summaries,
          threadsMap,
          grid: {
            threadIds: validIds,
            focusedThreadId: initialThreadId,
          },
        };
      }
    }
  } else if (savedGrid !== null) {
    if (savedGrid.threadIds.length === 0) {
      return {
        hydrated: true,
        summaries,
        threadsMap,
        grid: { threadIds: [], focusedThreadId: null },
      };
    }
    for (const tid of savedGrid.threadIds) {
      const cached = readCachedThread(tid);
      if (cached) threadsMap[cached.id] = cached;
    }
    const validIds = savedGrid.threadIds.filter((id) => Boolean(threadsMap[id]));
    if (validIds.length > 0) {
      const focused =
        savedGrid.focusedThreadId && validIds.includes(savedGrid.focusedThreadId)
          ? savedGrid.focusedThreadId
          : validIds[0];
      return {
        hydrated: true,
        summaries,
        threadsMap,
        grid: { threadIds: validIds, focusedThreadId: focused },
      };
    }
  }

  return {
    hydrated: false,
    summaries,
    threadsMap,
    grid: { threadIds: [], focusedThreadId: null },
  };
};

export const sortAgentSummariesByTabOrder = (
  summaries: ExtendedChatThread[]
): ExtendedChatThread[] => {
  return [...summaries].sort((left, right) => {
    const leftOrder = (left as { tabOrder?: number }).tabOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = (right as { tabOrder?: number }).tabOrder ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
};

export const loadAgentTabOrder = (summaries: ExtendedChatThread[]): string[] => {
  const sorted = sortAgentSummariesByTabOrder(summaries);
  return sorted.map((thread) => thread.id).filter(Boolean);
};

const syncCachedSummariesForScope = (
  summaries: ExtendedChatThread[],
  agentId?: string | null
): void => {
  try {
    const raw = localStorage.getItem(CHAT_SUMMARIES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const existing = Array.isArray(parsed)
      ? parsed.filter((t): t is ExtendedChatThread => Boolean(t && t.id))
      : [];
    const otherScopes = agentId
      ? existing.filter((t) => t.profileId !== agentId)
      : existing.filter((t) => Boolean(t.profileId));
    localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify([...summaries, ...otherScopes]));
  } catch {}
};

export const loadChatSummariesWithFallback = async (
  agentId?: string | null
): Promise<ExtendedChatThread[]> => {
  let summaries: ExtendedChatThread[] = [];
  let ipcSucceeded = false;
  try {
    const hist = agentId
      ? await invokeCommand<{ summaries: ExtendedChatThread[] }>('list_agent_chat_summaries', { agentId })
      : await invokeCommand<{ summaries: ExtendedChatThread[] }>('list_chat_summaries');
    if (hist && Array.isArray(hist.summaries)) {
      summaries = hist.summaries;
      ipcSucceeded = true;
    }
  } catch (err) {
    console.warn('[ChatView] list_chat_summaries notice:', err);
  }

  if (ipcSucceeded) {
    syncCachedSummariesForScope(summaries, agentId);
    return summaries;
  }

  return readCachedChatSummaries(agentId);
};

export const loadSavedGrid = async (initialThreadId?: string | null): Promise<SavedGridState> => {
  if (initialThreadId) {
    return { threadIds: [initialThreadId], focusedThreadId: initialThreadId };
  }
  let loadedIds: string[] = [];
  let focused: string | null = null;
  let ipcSucceeded = false;
  try {
    const gridRes = await invokeCommand<{ grid: { threadIds?: string[]; focusedThreadId?: string } | null }>(
      'load_thread_grid'
    );
    if (gridRes && typeof gridRes === 'object' && 'grid' in gridRes) {
      ipcSucceeded = true;
      if (gridRes.grid?.threadIds && Array.isArray(gridRes.grid.threadIds) && gridRes.grid.threadIds.length > 0) {
        loadedIds = gridRes.grid.threadIds;
        focused = gridRes.grid.focusedThreadId ?? loadedIds[0];
      }
    }
  } catch (err) {
    console.warn('[ChatView] load_thread_grid notice:', err);
  }

  if (ipcSucceeded) {
    try {
      localStorage.setItem(
        CHAT_GRID_STORAGE_KEY,
        JSON.stringify({ threadIds: loadedIds, focusedThreadId: focused })
      );
    } catch {}
    return { threadIds: loadedIds, focusedThreadId: focused };
  }

  return readCachedSavedGrid() ?? { threadIds: [], focusedThreadId: null };
};

export const loadThreadWithFallback = async (
  tid: string,
  agentId?: string | null
): Promise<ExtendedChatThread | null> => {
  try {
    const t = agentId
      ? await invokeCommand<ExtendedChatThread>('load_agent_chat_thread', { agentId, threadId: tid })
      : await invokeCommand<ExtendedChatThread>('load_chat_thread', { threadId: tid });
    if (t && t.id) return normalizeLoadedThread(t);
  } catch {
    // Fall back to localStorage if IPC fails or thread is offline
  }
  return readCachedThread(tid);
};

export interface UseChatGridPersistenceOptions {
  agentId?: string | null;
  workspaceId?: string | null;
  draftConfig: ChatDraftConfig;
  threadsMap: Record<string, ExtendedChatThread>;
  setThreadsMap: Dispatch<SetStateAction<Record<string, ExtendedChatThread>>>;
  knownThreadsList: ExtendedChatThread[];
  setKnownThreadsList: Dispatch<SetStateAction<ExtendedChatThread[]>>;
  threadWithResolvedBinding: (thread: ExtendedChatThread) => ExtendedChatThread;
  attachmentsMapRef: MutableRefObject<Record<string, ChatAttachment[]>>;
  writeAttachments: (threadId: string, attachments: ChatAttachment[]) => void;
  isMountedRef: MutableRefObject<boolean>;
  initialGrid?: SavedGridState | null;
}

export function useChatGridPersistence({
  agentId,
  workspaceId,
  draftConfig,
  threadsMap,
  setThreadsMap,
  knownThreadsList,
  setKnownThreadsList,
  threadWithResolvedBinding,
  attachmentsMapRef,
  writeAttachments,
  isMountedRef,
  initialGrid,
}: UseChatGridPersistenceOptions) {
  const [gridThreadIds, setGridThreadIds] = useState<string[]>(() => initialGrid?.threadIds ?? []);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(
    () => initialGrid?.focusedThreadId ?? null
  );

  const persistAgentTabOrder = async (ids: string[]) => {
    if (!agentId || ids.length === 0) return;
    const threadIds = [...new Set(ids)].slice(0, 512);
    try {
      await invokeCommand('reorder_agent_chat_tabs', {
        supportedSchemaVersion: 1,
        agentId,
        threadIds,
      });
    } catch (err) {
      console.warn('[ChatView] reorder_agent_chat_tabs notice:', err);
    }
  };

  const persistGrid = async (ids: string[], focused: string | null) => {
    if (!focused && ids.length > 0) focused = ids[0];
    try {
      localStorage.setItem(CHAT_GRID_STORAGE_KEY, JSON.stringify({ threadIds: ids, focusedThreadId: focused }));
    } catch {}
    try {
      await invokeCommand<void>('save_thread_grid', {
        grid: {
          schemaVersion: 1,
          threadIds: ids,
          focusedThreadId: focused ?? '11111111-1111-4111-8111-111111111111',
        },
      });
    } catch (err) {
      console.warn('[ChatView] save_thread_grid notice:', err);
    }
    await persistAgentTabOrder(ids);
  };

  const handleToggleSplit = async () => {
    if (gridThreadIds.length > 1) {
      const single = focusedThreadId ? [focusedThreadId] : gridThreadIds.slice(0, 1);
      setGridThreadIds(single);
      void persistGrid(single, focusedThreadId);
    } else {
      const existingCandidate = knownThreadsList.find((t) => !gridThreadIds.includes(t.id));
      if (existingCandidate) {
        const nextGrid = [...gridThreadIds, existingCandidate.id];
        setGridThreadIds(nextGrid);
        void persistGrid(nextGrid, focusedThreadId);
      } else {
        try {
          const request = draftThreadRequest(draftConfig, agentId);
          const newThread = agentId
            ? await invokeCommand<ExtendedChatThread>('create_agent_chat', request)
            : await invokeCommand<ExtendedChatThread>('create_general_chat', {
                ...request,
                workspaceId: workspaceId ?? null,
              });
          if (!isMountedRef.current) return;
          const boundThread = threadWithResolvedBinding(newThread);
          setThreadsMap((prev) => ({ ...prev, [newThread.id]: boundThread }));
          setKnownThreadsList((prev) => [boundThread, ...prev]);
          const nextGrid = [...gridThreadIds, newThread.id];
          setGridThreadIds(nextGrid);
          void persistGrid(nextGrid, focusedThreadId);
        } catch (err) {
          console.error('[ChatView] Failed to split with new chat:', err);
        }
      }
    }
  };

  const handleDropThread = (
    targetThreadId: string,
    droppedThreadId: string,
    position: 'before' | 'replace' | 'after'
  ) => {
    if (targetThreadId === droppedThreadId && position === 'replace') return;
    if (position === 'replace') {
      const nextGrid = gridThreadIds.map((id) => (id === targetThreadId ? droppedThreadId : id));
      setGridThreadIds(nextGrid);
      setFocusedThreadId(droppedThreadId);
      void persistGrid(nextGrid, droppedThreadId);
    } else if (position === 'before') {
      const filtered = gridThreadIds.filter((id) => id !== droppedThreadId);
      const targetIdx = filtered.indexOf(targetThreadId);
      if (targetIdx !== -1 && filtered.length < 6) {
        filtered.splice(targetIdx, 0, droppedThreadId);
        setGridThreadIds(filtered);
        setFocusedThreadId(droppedThreadId);
        void persistGrid(filtered, droppedThreadId);
      }
    } else if (position === 'after') {
      const filtered = gridThreadIds.filter((id) => id !== droppedThreadId);
      const targetIdx = filtered.indexOf(targetThreadId);
      if (targetIdx !== -1 && filtered.length < 6) {
        filtered.splice(targetIdx + 1, 0, droppedThreadId);
        setGridThreadIds(filtered);
        setFocusedThreadId(droppedThreadId);
        void persistGrid(filtered, droppedThreadId);
      }
    }
  };

  const handleClosePane = (threadId: string) => {
    for (const item of attachmentsMapRef.current[threadId] || []) {
      void invokeCommand('release_chat_attachment', { threadId, resourceId: item.resourceId });
    }
    writeAttachments(threadId, []);
    const remaining = gridThreadIds.filter((id) => id !== threadId);
    setGridThreadIds(remaining);
    const nextFocused = remaining.length > 0 ? (focusedThreadId === threadId ? remaining[0] : focusedThreadId) : null;
    setFocusedThreadId(nextFocused);
    void persistGrid(remaining, nextFocused);
  };

  useEffect(() => {
    for (const [id, thread] of Object.entries(threadsMap)) {
      if (id && thread) {
        try {
          localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}${id}`, JSON.stringify(thread));
        } catch {}
      }
    }
  }, [threadsMap]);

  useEffect(() => {
    if (knownThreadsList.length > 0) {
      syncCachedSummariesForScope(knownThreadsList, agentId);
    }
  }, [knownThreadsList, agentId]);

  return {
    gridThreadIds,
    setGridThreadIds,
    focusedThreadId,
    setFocusedThreadId,
    persistGrid,
    persistAgentTabOrder,
    handleToggleSplit,
    handleDropThread,
    handleClosePane,
  };
}
