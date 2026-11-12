import { useState, useEffect, useRef } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invokeCommand } from '../../../lib/ipc';
import { voiceSessionStore } from '../../../lib/operator/voice/voiceSessionStore';
import {
  ChatProvider,
  ChatMode,
  ExtendedChatThread,
  engineToChatProvider,
} from './types';
import { useChatAttachments } from './hooks/useChatAttachments';
import { useChatModels } from './hooks/useChatModels';
import { useChatAgents } from './hooks/useChatAgents';
import {
  applyDraftPatch,
  createDraftConfig,
  draftThreadRequest,
  type ChatConfigPatch,
  type ChatDraftConfig,
} from './hooks/useChatDraftConfig';
import { getSavedSelectedProvider } from './modelPersistence';
import { holdThreadSelection, registerNewThreadHandler } from '../../../lib/newThreadRequest';
import {
  useChatConnectionBindings,
  readThreadSendBinding,
  withResolvedSendBindings,
} from './hooks/useChatConnectionBindings';
import {
  useChatGridPersistence,
  loadChatSummariesWithFallback,
  loadSavedGrid,
  loadThreadWithFallback,
  sortAgentSummariesByTabOrder,
} from './hooks/useChatGridPersistence';
import { useChatTurnActions } from './hooks/useChatTurnActions';

export { readThreadSendBinding, withResolvedSendBindings };

export interface UseChatSessionProps {
  workspaceId: string | null;
  agentId?: string | null;
  agentName?: string;
  agentEngine?: string;
  engineLabel?: string;
  threadId?: string | null;
  agents?: any[];
  ownsNewThreadRequests?: boolean;
  onThreadsChanged?: () => void;
}

export function useChatSession({
  workspaceId,
  agentId,
  agentEngine,
  threadId: initialThreadId,
  agents,
  ownsNewThreadRequests,
  onThreadsChanged,
}: UseChatSessionProps) {
  // Threads State
  const [threadsMap, setThreadsMap] = useState<Record<string, ExtendedChatThread>>({});
  const [knownThreadsList, setKnownThreadsList] = useState<ExtendedChatThread[]>([]);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);

  const currentAgent = agentId ? agents?.find((a) => a.id === agentId) : undefined;

  const defaultProvider: ChatProvider = (() => {
    if (agentEngine) {
      return engineToChatProvider(agentEngine);
    }
    if (currentAgent?.engine) {
      return engineToChatProvider(currentAgent.engine);
    }
    const saved = getSavedSelectedProvider();
    if (saved && ['claude', 'codex', 'cursor', 'grok', 'opencode', 'antigravity'].includes(saved)) {
      return saved as ChatProvider;
    }
    return 'antigravity';
  })();

  // Agent surface draft: provider, mode, model and effort chosen before the
  // first thread exists. An existing thread's own fields take precedence. The
  // draft inherits the agent profile's default model so the first thread does
  // not silently reset a configured model to Automatic.
  const [draftConfig, setDraftConfig] = useState<ChatDraftConfig>(() =>
    createDraftConfig(defaultProvider, currentAgent?.defaultModel || null)
  );

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
    catalogStateMap,
    isRefreshingModels,
    fetchDynamicModels,
    refreshModels,
  } = useChatModels();

  const { dynamicAgentsMap, ensureDynamicAgents, refreshAgents } = useChatAgents(defaultProvider);

  const isMountedRef = useRef(true);
  const activePollRunsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activePollRunsRef.current.clear();
    };
  }, []);

  const {
    threadWithResolvedBinding,
    selectThreadConnection,
  } = useChatConnectionBindings({
    threadsMap,
    setThreadsMap,
    isMountedRef,
  });

  const {
    gridThreadIds,
    setGridThreadIds,
    focusedThreadId,
    setFocusedThreadId,
    persistGrid,
    persistAgentTabOrder,
    handleToggleSplit,
    handleDropThread,
    handleClosePane,
  } = useChatGridPersistence({
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
  });

  const focusedThreadIdRef = useRef(focusedThreadId);
  focusedThreadIdRef.current = focusedThreadId;

  const notifyThreadsChanged = () => {
    window.dispatchEvent(new CustomEvent('kite:threads-changed'));
    onThreadsChanged?.();
  };

  const {
    isRunning,
    liveRuns,
    handleApproval,
    handleCancelTurn,
    handleSendPrompt,
    handleUserInputResponse,
  } = useChatTurnActions({
    agentId,
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
  });

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

  // Initial Load. When the pane is already showing this thread, a later selection
  // update must not reload it and replace the thread the session just opened.
  useEffect(() => {
    if (initialThreadId && focusedThreadIdRef.current === initialThreadId) return;
    void initChatView();
  }, [workspaceId, agentId, initialThreadId]);

  const initChatView = async () => {
    setIsLoadingInitial(true);
    void fetchDynamicModels(defaultProvider, false);
    try {
      let summaries = await loadChatSummariesWithFallback(agentId);
      if (isMountedRef.current && summaries.length > 0) {
        setKnownThreadsList(summaries);
      }

      if (agentId) {
        if (summaries.length > 0) {
          const ordered = sortAgentSummariesByTabOrder(summaries);
          summaries = ordered;
          void persistAgentTabOrder(ordered.map((thread) => thread.id).filter(Boolean));
          const first = ordered[0];
          if (first?.id) {
            const thread = await loadThreadWithFallback(first.id, agentId);
            if (isMountedRef.current && thread?.id) {
              const boundThread = threadWithResolvedBinding(thread);
              setThreadsMap({ [thread.id]: boundThread });
              setGridThreadIds([thread.id]);
              setFocusedThreadId(thread.id);
              setIsLoadingInitial(false);
              return;
            }
          }
        }
        if (isMountedRef.current) {
          setGridThreadIds([]);
          setFocusedThreadId(null);
          setIsLoadingInitial(false);
        }
        return;
      }

      // Fetch saved thread grid
      const { threadIds: loadedIds, focusedThreadId: focused } = await loadSavedGrid(initialThreadId);

      // If there are thread IDs in grid, load them in parallel
      if (loadedIds.length > 0) {
        const loadedEntries = await Promise.all(
          loadedIds.map(async (tid) => {
            const t = await loadThreadWithFallback(tid, agentId);
            if (t && t.id) return [tid, threadWithResolvedBinding(t)] as const;
            return null;
          })
        );

        const loadedMap: Record<string, ExtendedChatThread> = {};
        for (const entry of loadedEntries) {
          if (entry) {
            loadedMap[entry[0]] = entry[1];
          }
        }

        const validIds = loadedIds.filter((id) => Boolean(loadedMap[id]));
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

  const handleStartThreadFromHome = async (promptText: string) => {
    const request = draftThreadRequest(draftConfig, agentId);
    try {
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('create_agent_chat', request)
        : await invokeCommand<ExtendedChatThread>('create_general_chat', {
            ...request,
            workspaceId: workspaceId ?? null,
          });

      if (!isMountedRef.current) return;
      const tid = thread.id;
      const boundThread = threadWithResolvedBinding(thread);
      setThreadsMap((prev) => ({ ...prev, [tid]: boundThread }));
      setKnownThreadsList((prev) => [boundThread, ...prev.filter((t) => t.id !== tid)]);
      setGridThreadIds([tid]);
      setFocusedThreadId(tid);
      void persistGrid([tid], tid);
      notifyThreadsChanged();

      setTimeout(() => {
        void handleSendPrompt(tid, promptText, boundThread);
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
      void handleStartThreadFromHome(prompt);
    };
    window.addEventListener('kite:open-task-in-chat', handleOpenTask);
    return () => window.removeEventListener('kite:open-task-in-chat', handleOpenTask);
  }, [draftConfig, agentId, workspaceId]);

  const handleCreateNewThread = async (targetWorkspaceId?: string | null | unknown): Promise<string | undefined> => {
    const scopeWorkspaceId =
      typeof targetWorkspaceId === 'string'
        ? targetWorkspaceId
        : targetWorkspaceId === null
        ? null
        : workspaceId;
    const latest = createDraftConfig(draftConfig.provider, null, draftConfig.agent ?? null);

    // Reuse the open draft ONLY if the currently focused thread in this pane is already
    // a blank conversation (zero messages, zero voice turns) in the requested scope.
    const currentThread = focusedThreadId ? threadsMap[focusedThreadId] : null;
    const currentScopeMatches = currentThread
      ? (agentId
          ? currentThread.profileId === agentId
          : (currentThread.workspaceId ?? null) === (scopeWorkspaceId ?? null))
      : false;
    const isCurrentEmptyDraft = Boolean(
      currentThread &&
        currentScopeMatches &&
        (!currentThread.items || currentThread.items.length === 0) &&
        currentThread.hasContent !== true &&
        voiceSessionStore.getThreadVoiceTurns(currentThread.id).length === 0
    );

    if (isCurrentEmptyDraft && currentThread) {
      await invokeCommand('update_chat_configuration', {
        threadId: currentThread.id,
        provider: latest.provider,
        model: latest.model,
        effort: latest.effort,
        mode: latest.mode,
        ...(latest.agent ? { agent: latest.agent } : {}),
      });
      holdThreadSelection(currentThread.id);
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', { detail: { threadId: currentThread.id, mode: 'chat' } })
      );
      if (scopeWorkspaceId) {
        window.dispatchEvent(
          new CustomEvent('kite:select-workspace', { detail: { workspaceId: scopeWorkspaceId } })
        );
      }
      return currentThread.id;
    }

    try {
      const request = draftThreadRequest(latest, agentId);
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('create_agent_chat', request)
        : await invokeCommand<ExtendedChatThread>('create_general_chat', {
            ...request,
            workspaceId: scopeWorkspaceId ?? null,
          });
      if (!isMountedRef.current) return;
      const tid = thread.id;
      const boundThread = threadWithResolvedBinding(thread);
      holdThreadSelection(tid);
      setThreadsMap((prev) => ({ ...prev, [tid]: boundThread }));
      setKnownThreadsList((prev) => [boundThread, ...prev.filter((t) => t.id !== tid)]);

      const nextGrid = [tid];
      setGridThreadIds(nextGrid);
      setFocusedThreadId(tid);
      void persistGrid(nextGrid, tid);
      setShowHistoryPopover(false);
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', { detail: { threadId: tid, mode: 'chat' } })
      );
      if (scopeWorkspaceId) {
        window.dispatchEvent(
          new CustomEvent('kite:select-workspace', { detail: { workspaceId: scopeWorkspaceId } })
        );
      }
      notifyThreadsChanged();
      return tid;
    } catch (err) {
      console.error('[ChatView] Failed to create new chat:', err);
      return undefined;
    }
  };

  const createNewThreadRef = useRef(handleCreateNewThread);
  createNewThreadRef.current = handleCreateNewThread;

  useEffect(() => {
    if (!ownsNewThreadRequests) return;
    return registerNewThreadHandler((requestedWorkspaceId) => {
      void createNewThreadRef.current(requestedWorkspaceId);
    });
  }, [ownsNewThreadRequests]);

  const handleLoadThread = async (threadId: string) => {
    try {
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('load_agent_chat_thread', { agentId, threadId })
        : await invokeCommand<ExtendedChatThread>('load_chat_thread', { threadId });
      if (!isMountedRef.current) return;
      const boundThread = threadWithResolvedBinding(thread);
      setThreadsMap((prev) => ({ ...prev, [threadId]: boundThread }));
      setKnownThreadsList((prev) => {
        const found = prev.find((t) => t.id === threadId);
        if (found) {
          return prev.map((t) => (t.id === threadId ? boundThread : t));
        }
        return [boundThread, ...prev];
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

  const handleDraftConfigChange = (patch: ChatConfigPatch) => {
    if (patch.provider) {
      void ensureDynamicAgents(patch.provider);
      void fetchDynamicModels(patch.provider);
    }
    setDraftConfig((prev) => applyDraftPatch(prev, patch));
  };

  const handleUpdateConfig = async (
    threadId: string,
    patch: {
      provider?: ChatProvider;
      mode?: ChatMode;
      model?: string | null;
      effort?: string | null;
      plan?: boolean;
      agent?: string | null;
      connectionId?: string | null;
      workspaceId?: string | null;
    }
  ) => {
    const thread = threadsMap[threadId];
    if (!thread) return;
    const currentConfig: ChatDraftConfig = {
      provider: thread.provider,
      mode: thread.mode,
      model: thread.model ?? null,
      effort: thread.effort ?? null,
      agent: (thread as any).agent || (thread as any).workMode || null,
    };
    const { provider, mode, model, effort, agent } = applyDraftPatch(currentConfig, patch);
    const providerChanged = provider !== thread.provider;
    const connectionOnly =
      patch.connectionId !== undefined &&
      patch.provider === undefined &&
      patch.mode === undefined &&
      patch.model === undefined &&
      patch.effort === undefined &&
      patch.plan === undefined &&
      patch.agent === undefined &&
      patch.workspaceId === undefined;

    if (patch.connectionId !== undefined) {
      await selectThreadConnection(threadId, patch.connectionId);
    }
    if (providerChanged) {
      void ensureDynamicAgents(provider);
      void fetchDynamicModels(provider);
      // A binding belonged to the previous provider, so it is cleared before
      // the new provider's verified connection, if any, is resolved.
      await selectThreadConnection(threadId, null);
    }
    if (connectionOnly) {
      setActiveDropdown(null);
      return;
    }

    try {
      let updated = await invokeCommand<ExtendedChatThread>('update_chat_configuration', {
        threadId,
        provider,
        mode,
        model,
        effort: effort ?? null,
        plan: patch.plan !== undefined ? patch.plan : thread.plan,
        agent: agent ?? (thread as any).agent ?? (thread as any).workMode,
        providerOptions: effort ? [{ id: 'effort', value: effort }] : undefined,
        workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : (thread.workspaceId ?? null),
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
      const mergedThread = threadWithResolvedBinding({
        ...updated,
        effort: effort ?? updated.effort,
      });
      setThreadsMap((prev) => ({
        ...prev,
        [threadId]: mergedThread,
      }));
      setKnownThreadsList((prev) => prev.map((t) => (t.id === threadId ? mergedThread : t)));
      notifyThreadsChanged();

      void fetchDynamicModels(provider);
      void ensureDynamicAgents(provider);
    } catch (err) {
      console.error('[ChatView] update_chat_configuration error:', err);
    } finally {
      if (isMountedRef.current) setActiveDropdown(null);
    }
  };

  return {
    defaultProvider,
    draftConfig,
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
    catalogStateMap,
    dynamicAgentsMap,
    ensureDynamicAgents,
    refreshAgents,
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
    handleDraftConfigChange,
    handleUpdateConfig,
    handleApproval,
    handleCancelTurn,
    handlePickAttachments,
    handleStageFiles,
    stageDroppedAttachments,
    handleRemoveAttachment,
    handleSendPrompt,
    handleUserInputResponse,
    setKnownThreadsList,
    persistAgentTabOrder,
  };
}
