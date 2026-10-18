import { useState, useEffect, useRef } from 'react';
import type { ChatItem } from '../../../types';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invokeCommand } from '../../../lib/ipc';
import {
  ChatProvider,
  ChatMode,
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  LiveChatRun,
  PROVIDER_CATALOG,
  engineToChatProvider,
} from './types';
import type { PlanActionPayload } from './ChatPlanPanel';

export interface UseChatSessionProps {
  workspaceId: string | null;
  agentId?: string | null;
  agentName?: string;
  agentEngine?: string;
  engineLabel?: string;
  threadId?: string | null;
  agents?: any[];
  onThreadsChanged?: () => void;
}

export function useChatSession({
  workspaceId,
  agentId,
  agentEngine,
  threadId: initialThreadId,
  agents,
  onThreadsChanged,
}: UseChatSessionProps) {
  // Grid and Threads State
  const [gridThreadIds, setGridThreadIds] = useState<string[]>([]);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const [threadsMap, setThreadsMap] = useState<Record<string, ExtendedChatThread>>({});
  const [knownThreadsList, setKnownThreadsList] = useState<ExtendedChatThread[]>([]);
  const [isRunning, setIsRunning] = useState<Record<string, boolean>>({});
  const [liveRuns, setLiveRuns] = useState<LiveChatRun[]>([]);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);

  const defaultProvider: ChatProvider = (() => {
    if (agentEngine) {
      return engineToChatProvider(agentEngine);
    }
    if (agentId) {
      const ag = agents?.find((a) => a.id === agentId);
      if (ag?.engine) {
        return engineToChatProvider(ag.engine);
      }
    }
    return 'antigravity';
  })();

  // UI state
  const [showHistoryPopover, setShowHistoryPopover] = useState(false);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleInput, setTitleInput] = useState('');
  const [activeDropdown, setActiveDropdown] = useState<{ threadId: string; type: 'provider' | 'model' | 'mode' } | null>(null);

  // Composer inputs per thread
  const [promptMap, setPromptMap] = useState<Record<string, string>>({});
  const [attachmentsMap, setAttachmentsMap] = useState<Record<string, ChatAttachment[]>>({});
  const [dynamicModelsMap, setDynamicModelsMap] = useState<Record<string, ModelOption[]>>({});
  const [isRefreshingModels, setIsRefreshingModels] = useState<boolean>(false);

  const isMountedRef = useRef(true);
  const activePollRunsRef = useRef<Set<string>>(new Set());
  const attachmentsMapRef = useRef(attachmentsMap);
  const focusedThreadIdRef = useRef(focusedThreadId);
  const stageDroppedRef = useRef<(threadId: string, paths: string[]) => void>(() => {});
  attachmentsMapRef.current = attachmentsMap;
  focusedThreadIdRef.current = focusedThreadId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activePollRunsRef.current.clear();
      for (const [threadId, items] of Object.entries(attachmentsMapRef.current)) {
        for (const item of items) {
          void invokeCommand('release_chat_attachment', { threadId, resourceId: item.resourceId });
        }
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type !== 'drop') return;
        if (payload.paths.length === 0) return;
        const threadId = focusedThreadIdRef.current;
        if (!threadId) return;
        void stageDroppedRef.current(threadId, payload.paths);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Initial Load
  useEffect(() => {
    void initChatView();
  }, [workspaceId, agentId, initialThreadId]);

  // Periodic poll for live chat runs
  useEffect(() => {
    const timer = setInterval(() => {
      void checkLiveRuns();
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  const checkLiveRuns = async () => {
    try {
      const runs = await withTimeout(
        invokeCommand<LiveChatRun[]>('list_live_chat_runs'),
        3000,
        'list_live_chat_runs'
      );
      if (isMountedRef.current && Array.isArray(runs)) {
        setLiveRuns(runs);
      }
    } catch {
      // Ignore background failure or timeout
    }
  };

  const initChatView = async () => {
    setIsLoadingInitial(true);
    void fetchDynamicModels(defaultProvider, false);
    try {
      let summaries: ExtendedChatThread[] = [];
      try {
        const hist = agentId
          ? await invokeCommand<{ summaries: ExtendedChatThread[] }>('list_agent_chat_summaries', { agentId })
          : await invokeCommand<{ summaries: ExtendedChatThread[] }>('list_chat_summaries');
        if (hist && Array.isArray(hist.summaries)) {
          summaries = hist.summaries;
          if (isMountedRef.current) {
            setKnownThreadsList(summaries);
          }
          if (agentId && summaries.length > 0) {
            const ordered = [...summaries].sort((left, right) => {
              const leftOrder = (left as { tabOrder?: number }).tabOrder ?? Number.MAX_SAFE_INTEGER;
              const rightOrder = (right as { tabOrder?: number }).tabOrder ?? Number.MAX_SAFE_INTEGER;
              return leftOrder - rightOrder;
            });
            summaries = ordered;
            void persistAgentTabOrder(ordered.map((thread) => thread.id).filter(Boolean));
            const first = ordered[0];
            if (first?.id) {
              const thread = await invokeCommand<ExtendedChatThread>('load_agent_chat_thread', {
                agentId,
                threadId: first.id,
              });
              if (isMountedRef.current && thread?.id) {
                setThreadsMap({ [thread.id]: thread });
                setGridThreadIds([thread.id]);
                setFocusedThreadId(thread.id);
                setIsLoadingInitial(false);
                return;
              }
            }
          }
          if (agentId) {
            if (isMountedRef.current) {
              setGridThreadIds([]);
              setFocusedThreadId(null);
              setIsLoadingInitial(false);
            }
            return;
          }
        }
      } catch (err) {
        console.warn('[ChatView] list_chat_summaries notice:', err);
      }

      if (summaries.length === 0) {
        try {
          const raw = localStorage.getItem('kite.chat.summaries.v1');
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              summaries = parsed;
              if (isMountedRef.current) {
                setKnownThreadsList(summaries);
              }
            }
          }
        } catch {}
      }

      if (agentId) {
        if (isMountedRef.current) {
          setGridThreadIds([]);
          setFocusedThreadId(null);
          setIsLoadingInitial(false);
        }
        return;
      }

      // Fetch saved thread grid
      let loadedIds: string[] = initialThreadId ? [initialThreadId] : [];
      let focused: string | null = initialThreadId ?? null;
      if (!initialThreadId) {
        try {
          const gridRes = await invokeCommand<{ grid: { threadIds?: string[]; focusedThreadId?: string } | null }>('load_thread_grid');
          if (gridRes?.grid?.threadIds && Array.isArray(gridRes.grid.threadIds) && gridRes.grid.threadIds.length > 0) {
            loadedIds = gridRes.grid.threadIds;
            focused = gridRes.grid.focusedThreadId ?? loadedIds[0];
          }
        } catch (err) {
          console.warn('[ChatView] load_thread_grid notice:', err);
        }
        if (loadedIds.length === 0) {
          try {
            const raw = localStorage.getItem('kite.chat.grid.v1');
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed?.threadIds && Array.isArray(parsed.threadIds) && parsed.threadIds.length > 0) {
                loadedIds = parsed.threadIds;
                focused = parsed.focusedThreadId || loadedIds[0];
              }
            }
          } catch {}
        }
      }

      // If there are thread IDs in grid, load them
      if (loadedIds.length > 0) {
        const loadedMap: Record<string, ExtendedChatThread> = {};
        for (const tid of loadedIds) {
          try {
            const t = agentId
              ? await invokeCommand<ExtendedChatThread>('load_agent_chat_thread', { agentId, threadId: tid })
              : await invokeCommand<ExtendedChatThread>('load_chat_thread', { threadId: tid });
            if (t && t.id) loadedMap[tid] = t;
          } catch {
            // Check localStorage fallback
            try {
              const localRaw = localStorage.getItem(`kite.chat.thread.${tid}`);
              if (localRaw) {
                const parsed = JSON.parse(localRaw);
                if (parsed?.id) loadedMap[tid] = parsed;
              }
            } catch {}
          }
          if (!loadedMap[tid]) {
            try {
              const localRaw = localStorage.getItem(`kite.chat.thread.${tid}`);
              if (localRaw) {
                const parsed = JSON.parse(localRaw);
                if (parsed?.id) loadedMap[tid] = parsed;
              }
            } catch {}
          }
        }

        const validIds = loadedIds.filter((id) => !loadedMap[id] ? false : true);
        if (isMountedRef.current && validIds.length > 0) {
          setThreadsMap((prev) => ({ ...prev, ...loadedMap }));
          setGridThreadIds(validIds);
          setFocusedThreadId(validIds.includes(focused!) ? focused : validIds[0]);
          setIsLoadingInitial(false);
          return;
        }
      }

      // No open threads -> render Chat Home
      if (isMountedRef.current) {
        setGridThreadIds([]);
        setFocusedThreadId(null);
        setIsLoadingInitial(false);
      }
    } catch (e) {
      console.error('[ChatView] Failed to initialize chat view:', e);
      if (isMountedRef.current) {
        setGridThreadIds([]);
        setFocusedThreadId(null);
        setIsLoadingInitial(false);
      }
    }
  };

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
      localStorage.setItem('kite.chat.grid.v1', JSON.stringify({ threadIds: ids, focusedThreadId: focused }));
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

  useEffect(() => {
    for (const [id, thread] of Object.entries(threadsMap)) {
      if (id && thread) {
        try {
          localStorage.setItem(`kite.chat.thread.${id}`, JSON.stringify(thread));
        } catch {}
      }
    }
  }, [threadsMap]);

  useEffect(() => {
    if (knownThreadsList.length > 0) {
      try {
        localStorage.setItem('kite.chat.summaries.v1', JSON.stringify(knownThreadsList));
      } catch {}
    }
  }, [knownThreadsList]);

  const handleStartThreadFromHome = async (
    promptText: string,
    provider: ChatProvider,
    mode: ChatMode,
    model?: string
  ) => {
    try {
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('create_agent_chat', {
            agentId,
            provider,
            mode,
            model,
          })
        : await invokeCommand<ExtendedChatThread>('create_general_chat', {
            provider,
            workspaceId: workspaceId ?? null,
            mode,
            model,
          });

      if (!isMountedRef.current) return;
      const tid = thread.id;
      setThreadsMap((prev) => ({ ...prev, [tid]: thread }));
      setKnownThreadsList((prev) => [thread, ...prev.filter((t) => t.id !== tid)]);
      setGridThreadIds([tid]);
      setFocusedThreadId(tid);
      void persistGrid([tid], tid);
      notifyThreadsChanged();

      setTimeout(() => {
        void handleSendPrompt(tid, promptText, thread);
      }, 30);
    } catch (err) {
      console.error('[ChatView] Failed to start thread from Chat Home:', err);
    }
  };

  useEffect(() => {
    const handleOpenTask = (e: Event) => {
      const custom = e as CustomEvent<{ taskId: string; title: string; description: string }>;
      if (!custom.detail) return;
      const { taskId, title, description } = custom.detail;
      const prompt = `Solve task [${taskId}]: ${title}\n\n${description}`.trim();
      void handleStartThreadFromHome(prompt, defaultProvider, 'acceptEdits');
    };
    window.addEventListener('kite:open-task-in-chat', handleOpenTask);
    return () => window.removeEventListener('kite:open-task-in-chat', handleOpenTask);
  }, [defaultProvider]);

  const notifyThreadsChanged = () => {
    window.dispatchEvent(new CustomEvent('kite:threads-changed'));
    onThreadsChanged?.();
  };

  const handleCreateNewThread = async () => {
    // Deduplicate empty draft threads in the same scope
    const existingDraft = knownThreadsList.find(
      (t) =>
        (agentId ? t.profileId === agentId : (t.workspaceId ?? null) === (workspaceId ?? null)) &&
        (!t.items || t.items.length === 0 || (t as any).status === 'draft' || !t.title || t.title.toLowerCase().includes('draft') || t.title === 'New Chat')
    );
    if (existingDraft) {
      void handleLoadThread(existingDraft.id);
      return;
    }

    try {
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('create_agent_chat', {
            agentId,
            provider: defaultProvider,
            mode: 'acceptEdits',
          })
        : await invokeCommand<ExtendedChatThread>('create_general_chat', {
            provider: defaultProvider,
            workspaceId: workspaceId ?? null,
            mode: 'acceptEdits',
          });
      if (!isMountedRef.current) return;
      const tid = thread.id;
      setThreadsMap((prev) => ({ ...prev, [tid]: thread }));
      setKnownThreadsList((prev) => [thread, ...prev.filter((t) => t.id !== tid)]);

      const nextGrid = [tid];
      setGridThreadIds(nextGrid);
      setFocusedThreadId(tid);
      void persistGrid(nextGrid, tid);
      setShowHistoryPopover(false);
      notifyThreadsChanged();
    } catch (err) {
      console.error('[ChatView] Failed to create new chat:', err);
    }
  };

  const handleLoadThread = async (threadId: string) => {
    try {
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('load_agent_chat_thread', { agentId, threadId })
        : await invokeCommand<ExtendedChatThread>('load_chat_thread', { threadId });
      if (!isMountedRef.current) return;
      setThreadsMap((prev) => ({ ...prev, [threadId]: thread }));
      setKnownThreadsList((prev) => {
        const found = prev.find((t) => t.id === threadId);
        if (found) {
          return prev.map((t) => (t.id === threadId ? thread : t));
        }
        return [thread, ...prev];
      });
      if (!gridThreadIds.includes(threadId)) {
        const nextGrid = [threadId];
        setGridThreadIds(nextGrid);
        setFocusedThreadId(threadId);
        void persistGrid(nextGrid, threadId);
      } else {
        setFocusedThreadId(threadId);
      }
      setShowHistoryPopover(false);
    } catch (err) {
      console.error('[ChatView] Failed to load chat thread:', err);
    }
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
          const newThread = agentId
            ? await invokeCommand<ExtendedChatThread>('create_agent_chat', {
                agentId,
                provider: defaultProvider,
                mode: 'acceptEdits',
              })
            : await invokeCommand<ExtendedChatThread>('create_general_chat', {
                provider: defaultProvider,
                workspaceId: workspaceId ?? null,
                mode: 'acceptEdits',
              });
          if (!isMountedRef.current) return;
          setThreadsMap((prev) => ({ ...prev, [newThread.id]: newThread }));
          setKnownThreadsList((prev) => [newThread, ...prev]);
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
    const cleared = { ...attachmentsMapRef.current, [threadId]: [] as ChatAttachment[] };
    attachmentsMapRef.current = cleared;
    setAttachmentsMap(cleared);
    const remaining = gridThreadIds.filter((id) => id !== threadId);
    setGridThreadIds(remaining);
    const nextFocused = remaining.length > 0 ? (focusedThreadId === threadId ? remaining[0] : focusedThreadId) : null;
    setFocusedThreadId(nextFocused);
    void persistGrid(remaining, nextFocused);
  };

  const handlePinThread = async (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const thread = threadsMap[threadId];
    if (!thread) return;
    const nextPinned = !thread.pinned;
    try {
      const updated = await invokeCommand<ExtendedChatThread>('set_chat_thread_pinned', {
        threadId,
        pinned: nextPinned,
      });
      if (!isMountedRef.current) return;
      setThreadsMap((prev) => ({ ...prev, [threadId]: updated }));
      setKnownThreadsList((prev) => prev.map((t) => (t.id === threadId ? updated : t)));
      notifyThreadsChanged();
    } catch (err) {
      console.error('[ChatView] set_chat_thread_pinned failed:', err);
    }
  };

  const handleArchiveThread = async (threadId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      if (agentId) {
        await invokeCommand<{ deleted: boolean }>('archive_agent_chat_thread', { agentId, threadId });
      } else {
        await invokeCommand<{ deleted: boolean }>('archive_chat_thread', { threadId });
      }
      if (!isMountedRef.current) return;
      setKnownThreadsList((prev) => prev.filter((t) => t.id !== threadId));
      if (gridThreadIds.includes(threadId)) {
        handleClosePane(threadId);
      }
      notifyThreadsChanged();
    } catch (err) {
      console.error('[ChatView] archive_chat_thread failed:', err);
    }
  };

  const handleRenameThread = async (threadId: string, newTitle?: string) => {
    const finalTitle = (newTitle ?? titleInput).trim();
    if (!finalTitle) {
      setEditingTitleId(null);
      return;
    }
    try {
      const updated = agentId
        ? await invokeCommand<ExtendedChatThread>('rename_agent_chat_thread', {
            agentId,
            threadId,
            title: finalTitle,
          })
        : await invokeCommand<ExtendedChatThread>('rename_chat_thread', {
            threadId,
            title: finalTitle,
          });
      if (!isMountedRef.current) return;
      setThreadsMap((prev) => ({ ...prev, [threadId]: updated }));
      setKnownThreadsList((prev) => prev.map((t) => (t.id === threadId ? updated : t)));
      setEditingTitleId(null);
      notifyThreadsChanged();
    } catch (err) {
      console.error('[ChatView] rename_chat_thread failed:', err);
    } finally {
      if (isMountedRef.current) setEditingTitleId(null);
    }
  };

  const handleUpdateConfig = async (
    threadId: string,
    patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null }
  ) => {
    const thread = threadsMap[threadId];
    if (!thread) return;
    const provider = patch.provider ?? thread.provider;
    const mode = patch.mode ?? thread.mode;
    const model = patch.model !== undefined ? patch.model : thread.model;
    const effort = patch.effort !== undefined ? patch.effort : thread.effort;

    try {
      let updated = await invokeCommand<ExtendedChatThread>('update_chat_configuration', {
        threadId,
        provider,
        mode,
        model,
        providerOptions: effort ? [{ id: 'effort', value: effort }] : undefined,
      });
      if (agentId && (patch.provider !== undefined || patch.model !== undefined)) {
        updated = await invokeCommand<ExtendedChatThread>('set_agent_chat_model', {
          agentId,
          threadId,
          expectedRevision: updated.revision || thread.revision,
          provider,
          model: model ?? null,
        });
      }
      if (agentId && patch.mode !== undefined) {
        updated = await invokeCommand<ExtendedChatThread>('set_agent_chat_plan', {
          agentId,
          threadId,
          expectedRevision: updated.revision || thread.revision,
          plan: mode === 'readOnly',
        });
      }
      if (!isMountedRef.current) return;
      setThreadsMap((prev) => ({
        ...prev,
        [threadId]: { ...updated, effort: effort ?? updated.effort },
      }));

      if (PROVIDER_CATALOG[provider]?.isDynamic) {
        void fetchDynamicModels(provider);
      }
    } catch (err) {
      console.error('[ChatView] update_chat_configuration error:', err);
    } finally {
      if (isMountedRef.current) setActiveDropdown(null);
    }
  };

  const fetchDynamicModels = async (provider: ChatProvider, forceRefresh = false) => {
    try {
      const res = await invokeCommand<{ models: ModelOption[]; cached?: boolean }>('list_chat_provider_models', {
        provider,
        forceRefresh,
      });
      if (isMountedRef.current && res && Array.isArray(res.models) && res.models.length > 0) {
        setDynamicModelsMap((prev) => ({ ...prev, [provider]: res.models }));
      }
    } catch (err) {
      console.warn('[ChatView] list_chat_provider_models notice:', err);
    }
  };

  const refreshModels = async (provider: ChatProvider) => {
    setIsRefreshingModels(true);
    try {
      await fetchDynamicModels(provider, true);
    } finally {
      if (isMountedRef.current) {
        setIsRefreshingModels(false);
      }
    }
  };

  const handleApproval = async (
    threadId: string,
    decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
    requestId: string
  ) => {
    try {
      const updated = await invokeCommand<ExtendedChatThread>('respond_chat_approval', {
        threadId,
        decision,
        requestId,
      });
      if (isMountedRef.current) {
        setThreadsMap((prev) => ({ ...prev, [threadId]: updated }));
      }
    } catch (err) {
      console.error('[ChatView] respond_chat_approval error:', err);
    }
  };

  const handleCancelTurn = async (threadId: string) => {
    try {
      activePollRunsRef.current.clear();
      if (agentId) {
        await invokeCommand<void>('cancel_agent_chat_turn', { threadId });
      } else {
        await invokeCommand<void>('cancel_chat_turn', { threadId });
      }
      if (!isMountedRef.current) return;
      setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      setThreadsMap((prev) => {
        const t = prev[threadId];
        return t ? { ...prev, [threadId]: { ...t, status: 'idle' } } : prev;
      });
    } catch (err) {
      console.error('[ChatView] cancel_chat_turn error:', err);
    }
  };

  const writeAttachments = (threadId: string, items: ChatAttachment[]) => {
    const next = { ...attachmentsMapRef.current, [threadId]: items };
    attachmentsMapRef.current = next;
    setAttachmentsMap(next);
  };

  const acceptAttachments = (threadId: string, incoming: ChatAttachment[]) => {
    const valid = incoming.filter((item) => item && item.resourceId);
    if (valid.length === 0) return;
    const current = attachmentsMapRef.current[threadId] || [];
    const room = Math.max(0, 16 - current.length);
    for (const extra of valid.slice(room)) {
      void invokeCommand('release_chat_attachment', { threadId, resourceId: extra.resourceId });
    }
    writeAttachments(threadId, [...current, ...valid.slice(0, room)]);
  };

  const handlePickAttachments = async (threadId: string, kind: 'files' | 'folder' = 'files') => {
    try {
      const picked = await invokeCommand<ChatAttachment[]>('pick_chat_attachments', {
        threadId,
        kind,
      });
      if (!isMountedRef.current || !Array.isArray(picked)) return;
      acceptAttachments(threadId, picked);
    } catch (err) {
      console.error('[ChatView] pick_chat_attachments failed:', err);
    }
  };

  const handleStageFiles = async (threadId: string, files: File[]) => {
    const staged: ChatAttachment[] = [];
    for (const file of files.slice(0, 16)) {
      if (file.size > 10 * 1024 * 1024) continue;
      try {
        const dataBase64 = await fileToBase64(file);
        const item = await invokeCommand<ChatAttachment | null>('stage_chat_blob', {
          threadId,
          displayName: file.name || 'attachment',
          mimeType: (file.type || 'application/octet-stream').slice(0, 127),
          dataBase64,
        });
        if (item?.resourceId) staged.push(item);
      } catch (err) {
        console.error('[ChatView] stage_chat_blob failed:', err);
      }
    }
    if (isMountedRef.current) acceptAttachments(threadId, staged);
  };

  const stageDroppedAttachments = async (threadId: string, paths: string[]) => {
    const usable = paths.filter((path) => path.length > 0 && path.length <= 4096).slice(0, 16);
    if (usable.length === 0) return;
    try {
      const staged = await invokeCommand<ChatAttachment[]>('stage_dropped_chat_attachments', {
        threadId,
        paths: usable,
      });
      if (!isMountedRef.current || !Array.isArray(staged)) return;
      acceptAttachments(threadId, staged);
    } catch (err) {
      console.error('[ChatView] stage_dropped_chat_attachments failed:', err);
    }
  };
  stageDroppedRef.current = stageDroppedAttachments;

  const handleRemoveAttachment = async (threadId: string, resourceId: string) => {
    try {
      await invokeCommand('release_chat_attachment', { threadId, resourceId });
    } catch (err) {
      console.error('[ChatView] release_chat_attachment failed:', err);
      return;
    }
    if (!isMountedRef.current) return;
    writeAttachments(
      threadId,
      (attachmentsMapRef.current[threadId] || []).filter((item) => item.resourceId !== resourceId)
    );
  };

  const handleSendPrompt = async (
    threadId: string,
    overridePrompt?: string,
    overrideThread?: ExtendedChatThread,
    planAction?: PlanActionPayload
  ): Promise<boolean> => {
    const thread = overrideThread || threadsMap[threadId];
    const promptText = (overridePrompt !== undefined ? overridePrompt : promptMap[threadId] || '').trim();
    const currentAttachments = attachmentsMap[threadId] || [];

    if ((!promptText && currentAttachments.length === 0) || !thread || isRunning[threadId]) return false;

    setPromptMap((prev) => ({ ...prev, [threadId]: '' }));
    writeAttachments(threadId, []);

    const userItem: ChatItem = {
      id: `u-${Date.now()}`,
      kind: 'user',
      text: promptText,
      title: null,
      detail: null,
      status: 'completed',
      streaming: false,
      exitCode: null,
      createdAtUnixMs: Date.now(),
      attachments: currentAttachments,
    };

    setThreadsMap((prev) => {
      const t = prev[threadId] || thread;
      return { ...prev, [threadId]: { ...t, items: [...t.items, userItem], status: 'running' } };
    });
    setIsRunning((prev) => ({ ...prev, [threadId]: true }));

    try {
      let res: { schemaVersion: number; runId: string; thread: ExtendedChatThread };

      if (agentId) {
        res = await invokeCommand('start_agent_chat_turn', {
          agentId,
          threadId,
          prompt: promptText,
          mode: thread.mode,
          provider: thread.provider,
          attachments: currentAttachments,
          planAction,
        });
      } else {
        res = await invokeCommand('start_chat_turn', {
          threadId,
          prompt: promptText,
          mode: thread.mode,
          provider: thread.provider,
          attachments: currentAttachments,
          planAction,
        });
      }

      if (!isMountedRef.current) return true;
      activePollRunsRef.current.add(res.runId);
      setThreadsMap((prev) => ({ ...prev, [threadId]: res.thread }));
      notifyThreadsChanged();
      void pollTurnUpdates(res.runId, threadId, 0);
      return true;
    } catch (err: any) {
      for (const item of currentAttachments) {
        void invokeCommand('release_chat_attachment', { threadId, resourceId: item.resourceId });
      }
      console.error('[ChatView] start turn error:', err);
      if (!isMountedRef.current) return false;
      setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      const errItem: ChatItem = {
        id: `err-${Date.now()}`,
        kind: 'error',
        text: err?.message || 'Failed to start chat turn. Ensure provider CLI is installed.',
        title: 'Execution Error',
        detail: null,
        status: 'failed',
        streaming: false,
        exitCode: 1,
        createdAtUnixMs: Date.now(),
        attachments: [],
      };
      setThreadsMap((prev) => {
        const t = prev[threadId];
        return t ? { ...prev, [threadId]: { ...t, items: [...t.items, errItem], status: 'error' } } : prev;
      });
      return false;
    }
  };

  const pollTurnUpdates = async (runId: string, threadId: string, afterSeq: number) => {
    if (!isMountedRef.current || !activePollRunsRef.current.has(runId)) return;
    try {
      const pollPromise = invokeCommand<{
        schemaVersion: number;
        runId: string;
        nextSequence: number;
        events: Array<{
          sequence: number;
          kind: 'status' | 'upsert' | 'delta' | 'finished' | 'approvalOpened' | 'approvalResolved';
          status?: 'idle' | 'running' | 'waiting' | 'error';
          item?: ChatItem;
          itemId?: string;
          text?: string;
          ok?: boolean;
          stoppedByBuilder?: boolean;
          approval?: any;
          requestId?: string;
        }>;
      }>(agentId ? 'read_agent_chat_turn_updates' : 'read_chat_turn_updates', agentId
        ? {
            agentId,
            threadId,
            runId,
            afterSequence: afterSeq,
            waitMs: 350,
          }
        : {
            runId,
            threadId,
            afterSequence: afterSeq,
            waitMs: 350,
          });

      const res = await withTimeout(pollPromise, 8000, `pollTurnUpdates(${runId})`);

      if (!isMountedRef.current || !activePollRunsRef.current.has(runId)) return;

      if (res && res.events) {
        let isDone = false;
        if (res.events.length > 0) {
          console.debug(`[ChatSession] Run ${runId} received ${res.events.length} events (nextSeq=${res.nextSequence})`);
        }

        setThreadsMap((prevMap) => {
          const target = prevMap[threadId];
          if (!target) return prevMap;
          let items = [...target.items];
          let status = target.status;
          let pendingApproval = target.pendingApproval;

          for (const ev of res.events) {
            if (ev.kind === 'status' && ev.status) {
              status = ev.status;
            } else if (ev.kind === 'upsert' && ev.item) {
              const idx = items.findIndex((it) => it.id === ev.item!.id);
              if (idx >= 0) {
                items[idx] = ev.item;
              } else {
                items.push(ev.item);
              }
            } else if (ev.kind === 'delta' && ev.itemId && ev.text) {
              const idx = items.findIndex((it) => it.id === ev.itemId);
              if (idx >= 0) {
                items[idx] = {
                  ...items[idx],
                  text: items[idx].text + ev.text,
                  streaming: true,
                };
              } else {
                items.push({
                  id: ev.itemId,
                  kind: 'assistant',
                  text: ev.text,
                  title: null,
                  detail: null,
                  status: 'inProgress',
                  streaming: true,
                  exitCode: null,
                  createdAtUnixMs: Date.now(),
                  attachments: [],
                });
              }
            } else if (ev.kind === 'approvalOpened' && ev.approval) {
              pendingApproval = ev.approval;
              status = 'waiting';
            } else if (ev.kind === 'approvalResolved') {
              pendingApproval = null;
            } else if (ev.kind === 'finished') {
              isDone = true;
              status = 'idle';
              items = items.map((it) => (it.streaming ? { ...it, streaming: false } : it));
            }
          }

          return {
            ...prevMap,
            [threadId]: {
              ...target,
              items,
              status,
              pendingApproval,
            },
          };
        });

        if (isDone) {
          console.log(`[ChatSession] Run ${runId} completed. Removing poller.`);
          activePollRunsRef.current.delete(runId);
          setIsRunning((prev) => ({ ...prev, [threadId]: false }));
          notifyThreadsChanged();
        } else {
          setTimeout(() => {
            if (isMountedRef.current && activePollRunsRef.current.has(runId)) {
              void pollTurnUpdates(runId, threadId, res.nextSequence);
            }
          }, 400);
        }
      } else {
        setTimeout(() => {
          if (isMountedRef.current && activePollRunsRef.current.has(runId)) {
            void pollTurnUpdates(runId, threadId, afterSeq);
          }
        }, 500);
      }
    } catch (err) {
      console.warn('[ChatView] Polling updates finished or cancelled:', err);
      activePollRunsRef.current.delete(runId);
      if (isMountedRef.current) {
        setIsRunning((prev) => ({ ...prev, [threadId]: false }));
        setThreadsMap((prev) => {
          const t = prev[threadId];
          if (!t) return prev;
          const cleanedItems = t.items.map((it) => (it.streaming ? { ...it, streaming: false } : it));
          return {
            ...prev,
            [threadId]: {
              ...t,
              items: cleanedItems,
              status: t.status === 'running' ? 'idle' : t.status,
            },
          };
        });
      }
    }
  };

  return {
    defaultProvider,
    gridThreadIds,
    focusedThreadId,
    threadsMap,
    knownThreadsList,
    isRunning,
    liveRuns,
    isLoadingInitial,
    showHistoryPopover,
    setShowHistoryPopover,
    editingTitleId,
    setEditingTitleId,
    titleInput,
    setTitleInput,
    activeDropdown,
    setActiveDropdown,
    promptMap,
    setPromptMap,
    attachmentsMap,
    dynamicModelsMap,
    isRefreshingModels,
    refreshModels,
    setFocusedThreadId,
    persistGrid,
    handleStartThreadFromHome,
    handleCreateNewThread,
    handleLoadThread,
    handleToggleSplit,
    handleDropThread,
    handleClosePane,
    handlePinThread,
    handleArchiveThread,
    handleRenameThread,
    handleUpdateConfig,
    handleApproval,
    handleCancelTurn,
    handlePickAttachments,
    handleStageFiles,
    stageDroppedAttachments,
    handleRemoveAttachment,
    handleSendPrompt,
    setKnownThreadsList,
    persistAgentTabOrder,
  };
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x4000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} exceeded ${ms}ms`));
    }, ms);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
