import { useState, useEffect, useRef } from 'react';
import type { ChatItem } from '../../../types';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invokeCommand } from '../../../lib/ipc';
import {
  ChatProvider,
  ChatMode,
  ExtendedChatThread,
  LiveChatRun,
  PROVIDER_CATALOG,
  engineToChatProvider,
} from './types';
import type { PlanActionPayload } from './ChatPlanPanel';
import { withTimeout } from './chatSessionUtils';
import { useChatAttachments } from './hooks/useChatAttachments';
import { useChatModels } from './hooks/useChatModels';
import { pollTurnUpdates } from './turnPolling';

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

  const {
    attachmentsMap,
    attachmentsMapRef,
    writeAttachments,
    handlePickAttachments,
    handleStageFiles,
    stageDroppedAttachments,
    handleRemoveAttachment,
  } = useChatAttachments();

  const {
    dynamicModelsMap,
    isRefreshingModels,
    fetchDynamicModels,
    refreshModels,
  } = useChatModels();

  const isMountedRef = useRef(true);
  const activePollRunsRef = useRef<Set<string>>(new Set());
  const focusedThreadIdRef = useRef(focusedThreadId);
  focusedThreadIdRef.current = focusedThreadId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activePollRunsRef.current.clear();
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
        void stageDroppedAttachments(threadId, payload.paths);
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
  }, [stageDroppedAttachments]);

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
    writeAttachments(threadId, []);
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
      if (res.thread?.status === 'idle') {
        setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      }
      notifyThreadsChanged();
      void pollTurnUpdates({
        runId: res.runId,
        threadId,
        afterSeq: 0,
        agentId,
        isMountedRef,
        activePollRunsRef,
        setThreadsMap,
        setIsRunning,
        notifyThreadsChanged,
      });
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
