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

export const loadChatSummariesWithFallback = async (
  agentId?: string | null
): Promise<ExtendedChatThread[]> => {
  let summaries: ExtendedChatThread[] = [];
  try {
    const hist = agentId
      ? await invokeCommand<{ summaries: ExtendedChatThread[] }>('list_agent_chat_summaries', { agentId })
      : await invokeCommand<{ summaries: ExtendedChatThread[] }>('list_chat_summaries');
    if (hist && Array.isArray(hist.summaries)) {
      summaries = hist.summaries;
    }
  } catch (err) {
    console.warn('[ChatView] list_chat_summaries notice:', err);
  }

  if (summaries.length === 0) {
    try {
      const raw = localStorage.getItem(CHAT_SUMMARIES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          summaries = parsed;
        }
      }
    } catch {}
  }

  return summaries;
};

export const loadSavedGrid = async (initialThreadId?: string | null): Promise<SavedGridState> => {
  if (initialThreadId) {
    return { threadIds: [initialThreadId], focusedThreadId: initialThreadId };
  }
  let loadedIds: string[] = [];
  let focused: string | null = null;
  try {
    const gridRes = await invokeCommand<{ grid: { threadIds?: string[]; focusedThreadId?: string } | null }>(
      'load_thread_grid'
    );
    if (gridRes?.grid?.threadIds && Array.isArray(gridRes.grid.threadIds) && gridRes.grid.threadIds.length > 0) {
      loadedIds = gridRes.grid.threadIds;
      focused = gridRes.grid.focusedThreadId ?? loadedIds[0];
    }
  } catch (err) {
    console.warn('[ChatView] load_thread_grid notice:', err);
  }

  if (loadedIds.length === 0) {
    try {
      const raw = localStorage.getItem(CHAT_GRID_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.threadIds && Array.isArray(parsed.threadIds) && parsed.threadIds.length > 0) {
          loadedIds = parsed.threadIds;
          focused = parsed.focusedThreadId || loadedIds[0];
        }
      }
    } catch {}
  }
  return { threadIds: loadedIds, focusedThreadId: focused };
};

export const loadThreadWithFallback = async (
  tid: string,
  agentId?: string | null
): Promise<ExtendedChatThread | null> => {
  try {
    const t = agentId
      ? await invokeCommand<ExtendedChatThread>('load_agent_chat_thread', { agentId, threadId: tid })
      : await invokeCommand<ExtendedChatThread>('load_chat_thread', { threadId: tid });
    if (t && t.id) return t;
  } catch {
    try {
      const localRaw = localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}${tid}`);
      if (localRaw) {
        const parsed = JSON.parse(localRaw);
        if (parsed?.id) return parsed;
      }
    } catch {}
  }
  try {
    const localRaw = localStorage.getItem(`${CHAT_THREAD_STORAGE_PREFIX}${tid}`);
    if (localRaw) {
      const parsed = JSON.parse(localRaw);
      if (parsed?.id) return parsed;
    }
  } catch {}
  return null;
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
}: UseChatGridPersistenceOptions) {
  const [gridThreadIds, setGridThreadIds] = useState<string[]>([]);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);

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
      try {
        localStorage.setItem(CHAT_SUMMARIES_STORAGE_KEY, JSON.stringify(knownThreadsList));
      } catch {}
    }
  }, [knownThreadsList]);

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
