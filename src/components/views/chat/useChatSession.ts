import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invokeCommand } from '../../../lib/ipc';
import { voiceSessionStore } from '../../../lib/operator/voice/voiceSessionStore';
import {
  ChatProvider,
  ChatMode,
  ChatAttachment,
  QueuedRunItem,
  ExtendedChatThread,
  engineToChatProvider,
} from './types';
import { expandCitations } from './citationChip';
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
  hydrateInitialChatState,
  loadChatSummariesWithFallback,
  loadSavedGrid,
  loadThreadWithFallback,
  pruneThreadsMapLru,
  readCachedThread,
  sortAgentSummariesByTabOrder,
  toThreadSummary,
} from './hooks/useChatGridPersistence';
import { useChatTurnActions } from './hooks/useChatTurnActions';
import { useSubagentEvents } from './hooks/useSubagentEvents';

export { readThreadSendBinding, withResolvedSendBindings };

function areStringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function areThreadSnapshotsEquivalent(
  current: ExtendedChatThread | undefined,
  incoming: ExtendedChatThread
): boolean {
  if (!current || current.id !== incoming.id) return false;
  if (
    current.status !== incoming.status ||
    current.title !== incoming.title ||
    current.model !== incoming.model ||
    current.mode !== incoming.mode ||
    current.effort !== incoming.effort ||
    current.plan !== incoming.plan ||
    current.provider !== incoming.provider ||
    current.workspaceId !== incoming.workspaceId ||
    current.connectionId !== incoming.connectionId ||
    current.pinned !== incoming.pinned ||
    current.stoppedByBuilder !== incoming.stoppedByBuilder ||
    current.updatedAtUnixMs !== incoming.updatedAtUnixMs ||
    current.revision !== incoming.revision ||
    current.usage?.inputTokens !== incoming.usage?.inputTokens ||
    current.usage?.outputTokens !== incoming.usage?.outputTokens
  ) {
    return false;
  }
  if (
    current.pendingApproval ||
    incoming.pendingApproval ||
    current.pendingUserInput ||
    incoming.pendingUserInput ||
    current.turnFailure ||
    incoming.turnFailure ||
    current.swarmState ||
    incoming.swarmState ||
    current.quotaHandoffOffer ||
    incoming.quotaHandoffOffer ||
    current.reflectionCandidate ||
    incoming.reflectionCandidate ||
    (current.queuedRuns?.length ?? 0) > 0 ||
    (incoming.queuedRuns?.length ?? 0) > 0 ||
    (current.subagentRuns?.length ?? 0) > 0 ||
    (incoming.subagentRuns?.length ?? 0) > 0
  ) {
    return false;
  }
  const curItems = current.items ?? [];
  const nextItems = incoming.items ?? [];
  if (curItems.length !== nextItems.length) return false;
  for (let i = 0; i < curItems.length; i += 1) {
    const cur = curItems[i];
    const next = nextItems[i];
    if (
      cur.id !== next.id ||
      cur.kind !== next.kind ||
      cur.title !== next.title ||
      cur.status !== next.status ||
      cur.streaming !== next.streaming ||
      cur.exitCode !== next.exitCode ||
      cur.text !== next.text ||
      cur.detail !== next.detail ||
      (cur.attachments?.length ?? 0) !== (next.attachments?.length ?? 0)
    ) {
      return false;
    }
  }
  return true;
}

function mergeThreadConfigUpdate(
  existing: ExtendedChatThread | undefined,
  mergedThread: ExtendedChatThread,
  pendingQueue: QueuedRunItem[] | undefined,
  isLiveTurn: boolean
): ExtendedChatThread {
  if (!existing || !isLiveTurn) {
    return pendingQueue !== undefined
      ? { ...mergedThread, queuedRuns: pendingQueue }
      : mergedThread;
  }
  const resolvedQueuedRuns = pendingQueue ?? existing.queuedRuns ?? mergedThread.queuedRuns;
  const existingExtra = existing as ExtendedChatThread & Record<string, unknown>;
  return {
    ...mergedThread,
    items: existing.items,
    status: existing.status,
    ...(resolvedQueuedRuns !== undefined ? { queuedRuns: resolvedQueuedRuns } : {}),
    stoppedByBuilder: existing.stoppedByBuilder,
    pendingApproval: existing.pendingApproval,
    pendingUserInput: existing.pendingUserInput,
    turnFailure: existing.turnFailure,
    subagentRuns: existing.subagentRuns,
    swarmState: existing.swarmState,
    quotaHandoffOffer: existing.quotaHandoffOffer,
    reflectionCandidate: existing.reflectionCandidate,
    usage: existing.usage,
    ...(existingExtra.liveActivity !== undefined
      ? { liveActivity: existingExtra.liveActivity }
      : {}),
  };
}

export interface UseChatSessionProps {
  workspaceId: string | null;
  agentId?: string | null;
  agentName?: string;
  agentEngine?: string;
  engineLabel?: string;
  threadId?: string | null;
  agents?: any[];
  embedded?: boolean;
  ownsNewThreadRequests?: boolean;
  onThreadsChanged?: () => void;
}

export function useChatSession({
  workspaceId,
  agentId,
  agentEngine,
  threadId: initialThreadId,
  agents,
  embedded = false,
  ownsNewThreadRequests,
  onThreadsChanged,
}: UseChatSessionProps) {
  // Synchronous cache hydration so Thread paints immediately without blocking on IPC
  const initialHydration = useMemo(
    () => hydrateInitialChatState(agentId, initialThreadId),
    // Computed strictly for initial mount state; later agent/thread changes reconcile in initChatView
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const skipInitialSpinnerRef = useRef(initialHydration.hydrated);

  // Threads State
  const [threadsMap, setThreadsMap] = useState<Record<string, ExtendedChatThread>>(
    () => initialHydration.threadsMap
  );
  const [knownThreadsList, setKnownThreadsList] = useState<ExtendedChatThread[]>(
    () => initialHydration.summaries
  );
  const [isLoadingInitial, setIsLoadingInitial] = useState(() => !initialHydration.hydrated);

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
    createDraftConfig(
      defaultProvider,
      currentAgent?.defaultModel || null,
      null,
      currentAgent
    )
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
  } = useChatModels(defaultProvider);

  const { dynamicAgentsMap, ensureDynamicAgents, refreshAgents } = useChatAgents(defaultProvider);

  const isMountedRef = useRef(true);
  const activePollRunsRef = useRef<Set<string>>(new Set());
  const activePollThreadsRef = useRef<Map<string, string>>(new Map());
  const prevLiveThreadIdsRef = useRef<Set<string>>(new Set());
  const reconciledStaleThreadsRef = useRef<Set<string>>(new Set());
  const configUpdateSeqRef = useRef<Record<string, number>>({});
  const reconcileThreadRef = useRef<(threadId: string) => Promise<void>>(async () => {});

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activePollRunsRef.current.clear();
      activePollThreadsRef.current.clear();
    };
  }, []);

  useSubagentEvents({ setThreadsMap, isMountedRef });

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
    initialGrid: initialHydration.grid,
  });

  const focusedThreadIdRef = useRef(focusedThreadId);
  focusedThreadIdRef.current = focusedThreadId;
  const threadsMapRef = useRef(threadsMap);
  threadsMapRef.current = threadsMap;
  const gridThreadIdsRef = useRef(gridThreadIds);
  gridThreadIdsRef.current = gridThreadIds;
  const prevAgentIdRef = useRef(agentId);
  const switchRequestSeqRef = useRef(0);
  const pendingQueuedRunsRef = useRef<Record<string, QueuedRunItem[] | undefined>>({});
  const autoDispatchingQueueRef = useRef<Set<string>>(new Set());

  const applySwitchedThread = (
    threadId: string,
    rawThread: ExtendedChatThread,
    {
      updateLayout,
      persistLayout,
    }: { updateLayout: boolean; persistLayout: boolean }
  ) => {
    const boundBase = threadWithResolvedBinding(rawThread);
    const inFlightQueue = pendingQueuedRunsRef.current[threadId];
    const boundThread =
      inFlightQueue !== undefined
        ? { ...boundBase, queuedRuns: inFlightQueue }
        : boundBase;
    const hasActivePoller = activePollThreadsRef.current.has(threadId);
    setThreadsMap((prev) => {
      const existing = prev[threadId];
      if (
        hasActivePoller &&
        boundThread.status === 'running' &&
        existing &&
        (existing.items?.length ?? 0) > (boundThread.items?.length ?? 0)
      ) {
        return prev;
      }
      const merged =
        inFlightQueue === undefined &&
        existing?.queuedRuns &&
        existing.queuedRuns.length > 0 &&
        (boundThread.queuedRuns?.length ?? 0) === 0
          ? { ...boundThread, queuedRuns: existing.queuedRuns }
          : boundThread;
      if (areThreadSnapshotsEquivalent(existing, merged)) {
        return prev;
      }
      const { [threadId]: _reordered, ...rest } = prev;
      const updated = { ...rest, [threadId]: merged };
      const protectedIds = [
        ...gridThreadIdsRef.current,
        ...(focusedThreadIdRef.current ? [focusedThreadIdRef.current] : []),
        threadId,
      ];
      return pruneThreadsMapLru(updated, protectedIds);
    });
    const summaryThread = toThreadSummary(boundThread);
    setKnownThreadsList((prev) => {
      const existing = prev.find((t) => t.id === threadId);
      if (existing && areThreadSnapshotsEquivalent(existing, summaryThread)) {
        return prev;
      }
      return existing
        ? prev.map((t) => (t.id === threadId ? summaryThread : t))
        : [summaryThread, ...prev];
    });
    if (updateLayout) {
      const currentGrid = gridThreadIdsRef.current;
      const nextGrid = currentGrid.includes(threadId) ? currentGrid : [threadId];
      if (!currentGrid.includes(threadId)) {
        gridThreadIdsRef.current = nextGrid;
        setGridThreadIds(nextGrid);
      }
      focusedThreadIdRef.current = threadId;
      setFocusedThreadId(threadId);
      if (persistLayout) {
        void persistGrid(nextGrid, threadId);
      }
    }
    setIsLoadingInitial(false);
  };

  const switchToThread = async (threadId: string) => {
    const requestSeq = ++switchRequestSeqRef.current;
    setShowHistoryPopover(false);

    const cached = threadsMapRef.current[threadId] ?? readCachedThread(threadId);
    const hasImmediateSnapshot = Boolean(cached && cached.id);
    if (cached && cached.id) {
      applySwitchedThread(threadId, cached, {
        updateLayout: true,
        persistLayout: !agentId,
      });
    }

    try {
      const fresh = await loadThreadWithFallback(threadId, agentId);
      if (!isMountedRef.current || switchRequestSeqRef.current !== requestSeq) {
        return;
      }
      if (fresh && fresh.id) {
        applySwitchedThread(threadId, fresh, {
          updateLayout: !hasImmediateSnapshot,
          persistLayout: !agentId && !hasImmediateSnapshot,
        });
      }
    } catch (err) {
      console.error('[ChatView] Failed to load chat thread:', err);
    }
  };

  const notifyThreadsChanged = () => {
    window.dispatchEvent(new CustomEvent('kite:threads-changed'));
    onThreadsChanged?.();
  };

  const {
    isRunning,
    isRunningRef,
    setIsRunning,
    liveRuns,
    hasCheckedLiveRuns,
    checkLiveRuns,
    attachPollRun,
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
    activePollThreadsRef,
    reconcileThread: (tid) => reconcileThreadRef.current(tid),
  });

  const reconcileThread = useCallback(
    async (threadId: string) => {
      try {
        const fresh = await loadThreadWithFallback(threadId, agentId);
        if (!isMountedRef.current || !fresh || !fresh.id) return;
        const boundBase = threadWithResolvedBinding(fresh);
        const inFlightQueue = pendingQueuedRunsRef.current[threadId];
        const bound =
          inFlightQueue !== undefined
            ? { ...boundBase, queuedRuns: inFlightQueue }
            : boundBase;
        const hasActivePoller = activePollThreadsRef.current.has(threadId);
        setThreadsMap((prev) => {
          const existing = prev[threadId];
          if (
            bound.status === 'running' &&
            existing &&
            (existing.status !== 'running' ||
              (hasActivePoller &&
                (existing.items?.length ?? 0) > (bound.items?.length ?? 0)))
          ) {
            return prev;
          }
          if (areThreadSnapshotsEquivalent(existing, bound)) {
            return prev;
          }
          const { [threadId]: _reordered, ...rest } = prev;
          const updated = { ...rest, [threadId]: bound };
          const protectedIds = [
            ...gridThreadIdsRef.current,
            ...(focusedThreadIdRef.current ? [focusedThreadIdRef.current] : []),
            threadId,
          ];
          return pruneThreadsMapLru(updated, protectedIds);
        });
        const summaryBound = toThreadSummary(bound);
        setKnownThreadsList((prev) => {
          const existing = prev.find((t) => t.id === threadId);
          if (existing && areThreadSnapshotsEquivalent(existing, summaryBound)) {
            return prev;
          }
          return existing
            ? prev.map((t) => (t.id === threadId ? summaryBound : t))
            : [summaryBound, ...prev];
        });
        if (bound.status !== 'running') {
          setIsRunning((prev) => (prev[threadId] ? { ...prev, [threadId]: false } : prev));
        }
        notifyThreadsChanged();
      } catch (err) {
        console.warn('[ChatView] reconcileThread failed:', err);
      }
    },
    [agentId]
  );
  reconcileThreadRef.current = reconcileThread;

  useEffect(() => {
    if (!hasCheckedLiveRuns) return;
    const nextLiveIds = new Set(liveRuns.map((r) => r.threadId));

    for (const run of liveRuns) {
      const tid = run.threadId;
      reconciledStaleThreadsRef.current.delete(tid);
      const isVisibleOrLoaded =
        gridThreadIdsRef.current.includes(tid) || Boolean(threadsMapRef.current[tid]);
      if (isVisibleOrLoaded && run.runId && !activePollRunsRef.current.has(run.runId)) {
        attachPollRun(tid, run.runId, run.nextSequence ?? 0, true);
        void reconcileThread(tid);
      }
    }

    for (const prevTid of prevLiveThreadIdsRef.current) {
      if (nextLiveIds.has(prevTid)) continue;
      const t = threadsMapRef.current[prevTid];
      if (!t) continue;
      const hasInFlightItem = (t.items ?? []).some(
        (it) =>
          Boolean(it.streaming) ||
          ['running', 'inProgress', 'pending', 'in_progress', 'started'].includes(
            String(it.status ?? '')
          )
      );
      if (t.status === 'running' || hasInFlightItem) {
        void reconcileThread(prevTid);
      }
    }

    for (const tid of gridThreadIdsRef.current) {
      const t = threadsMapRef.current[tid];
      if (
        t &&
        t.status === 'running' &&
        !nextLiveIds.has(tid) &&
        !activePollThreadsRef.current.has(tid) &&
        !reconciledStaleThreadsRef.current.has(tid)
      ) {
        reconciledStaleThreadsRef.current.add(tid);
        void reconcileThread(tid);
      }
    }

    prevLiveThreadIdsRef.current = nextLiveIds;
  }, [liveRuns, hasCheckedLiveRuns, gridThreadIds]);

  const handleUpdateQueuedRuns = useCallback(
    (threadId: string, nextQueue: QueuedRunItem[], removedAttachments?: ChatAttachment[]) => {
      if (!threadId) return;
      if (removedAttachments && removedAttachments.length > 0) {
        for (const item of removedAttachments) {
          if (item?.resourceId) {
            void invokeCommand('release_chat_attachment', { threadId, resourceId: item.resourceId });
          }
        }
      }
      pendingQueuedRunsRef.current[threadId] = nextQueue;
      if (threadsMapRef.current[threadId]) {
        threadsMapRef.current = {
          ...threadsMapRef.current,
          [threadId]: {
            ...threadsMapRef.current[threadId],
            queuedRuns: nextQueue,
          },
        };
      }
      setThreadsMap((prev) => {
        const existing = prev[threadId];
        if (!existing) return prev;
        return {
          ...prev,
          [threadId]: {
            ...existing,
            queuedRuns: nextQueue,
          },
        };
      });
      setKnownThreadsList((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, queuedRuns: nextQueue } : t))
      );
      void invokeCommand<ExtendedChatThread>('update_chat_configuration', {
        threadId,
        queuedRuns: nextQueue,
      })
        .then((updated) => {
          if (pendingQueuedRunsRef.current[threadId] !== nextQueue) {
            return;
          }
          delete pendingQueuedRunsRef.current[threadId];
          if (isMountedRef.current && updated && updated.id) {
            const resolvedQueue = updated.queuedRuns ?? nextQueue;
            if (threadsMapRef.current[threadId]) {
              threadsMapRef.current = {
                ...threadsMapRef.current,
                [threadId]: {
                  ...threadsMapRef.current[threadId],
                  queuedRuns: resolvedQueue,
                },
              };
            }
            setThreadsMap((prev) => {
              const cur = prev[threadId];
              if (!cur) return prev;
              return {
                ...prev,
                [threadId]: {
                  ...cur,
                  queuedRuns: resolvedQueue,
                },
              };
            });
          }
        })
        .catch(() => {
          if (pendingQueuedRunsRef.current[threadId] === nextQueue) {
            delete pendingQueuedRunsRef.current[threadId];
          }
        });
    },
    []
  );

  const handleQueuePrompt = useCallback(
    (threadId: string, text: string, explicitAttachments?: ChatAttachment[]) => {
      const thread = threadsMapRef.current[threadId];
      if (!thread) return;
      const atts =
        explicitAttachments !== undefined
          ? explicitAttachments
          : attachmentsMapRef.current[threadId] || [];
      const cleaned = expandCitations(text.trim());
      if (!cleaned && atts.length === 0) return;
      setPromptMap((prev) => ({ ...prev, [threadId]: '' }));
      writeAttachments(threadId, []);
      const currentQueue = pendingQueuedRunsRef.current[threadId] ?? thread.queuedRuns ?? [];
      const nextRow: QueuedRunItem = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: cleaned,
        ...(atts.length > 0 ? { attachments: atts } : {}),
        createdAtUnixMs: Date.now(),
      };
      handleUpdateQueuedRuns(threadId, [...currentQueue, nextRow]);
    },
    [handleUpdateQueuedRuns, writeAttachments]
  );

  const handleSendNowQueuedRun = useCallback(
    async (threadId: string, rowId: string) => {
      const thread = threadsMapRef.current[threadId];
      if (!thread) return;
      const currentQueue = pendingQueuedRunsRef.current[threadId] ?? thread.queuedRuns ?? [];
      const row = currentQueue.find((entry) => entry.id === rowId);
      if (!row) return;
      const rest = currentQueue.filter((entry) => entry.id !== rowId);
      autoDispatchingQueueRef.current.add(threadId);
      try {
        handleUpdateQueuedRuns(threadId, rest);
        if (isRunningRef.current[threadId] || isRunning[threadId] || thread.status === 'running') {
          const cancelled = await handleCancelTurn(threadId);
          if (!cancelled) {
            handleUpdateQueuedRuns(threadId, currentQueue);
            return;
          }
        }
        const latestThread = threadsMapRef.current[threadId] || { ...thread, queuedRuns: rest, status: 'idle' };
        await handleSendPrompt(
          threadId,
          row.text,
          { ...latestThread, queuedRuns: rest, status: 'idle', stoppedByBuilder: false },
          undefined,
          row.attachments ?? []
        );
      } finally {
        autoDispatchingQueueRef.current.delete(threadId);
      }
    },
    [handleCancelTurn, handleSendPrompt, handleUpdateQueuedRuns, isRunning, isRunningRef]
  );

  const handleSteerPrompt = useCallback(
    async (threadId: string, text: string, explicitAttachments?: ChatAttachment[]): Promise<boolean> => {
      const thread = threadsMapRef.current[threadId];
      if (!thread) return false;
      const atts =
        explicitAttachments !== undefined
          ? explicitAttachments
          : attachmentsMapRef.current[threadId] || [];
      const cleaned = expandCitations(text.trim());
      if (!cleaned && atts.length === 0) return false;
      autoDispatchingQueueRef.current.add(threadId);
      try {
        if (isRunningRef.current[threadId] || isRunning[threadId] || thread.status === 'running') {
          const cancelled = await handleCancelTurn(threadId);
          if (!cancelled) return false;
        }
        setPromptMap((prev) => ({ ...prev, [threadId]: '' }));
        writeAttachments(threadId, []);
        const latestThread = threadsMapRef.current[threadId] || { ...thread, status: 'idle' };
        const activeQueue = pendingQueuedRunsRef.current[threadId] ?? latestThread.queuedRuns;
        return await handleSendPrompt(
          threadId,
          cleaned,
          {
            ...latestThread,
            ...(activeQueue !== undefined ? { queuedRuns: activeQueue } : {}),
            status: 'idle',
            stoppedByBuilder: false,
          },
          undefined,
          atts
        );
      } finally {
        autoDispatchingQueueRef.current.delete(threadId);
      }
    },
    [handleCancelTurn, handleSendPrompt, isRunning, isRunningRef, writeAttachments]
  );

  const prevRunningStateRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const prevRunning = prevRunningStateRef.current;
    const nextRunning: Record<string, boolean> = {};
    for (const [tid, thread] of Object.entries(threadsMap)) {
      const currentlyRunning = Boolean(isRunning[tid]) || thread.status === 'running';
      nextRunning[tid] = currentlyRunning;
      const wasRunning = Boolean(prevRunning[tid]);
      const queue = pendingQueuedRunsRef.current[tid] ?? thread.queuedRuns ?? [];
      if (
        wasRunning &&
        !currentlyRunning &&
        thread.status === 'idle' &&
        !thread.stoppedByBuilder &&
        !thread.pendingApproval &&
        !(thread.pendingUserInput?.questions && thread.pendingUserInput.questions.length > 0) &&
        !thread.turnFailure &&
        queue.length > 0 &&
        !autoDispatchingQueueRef.current.has(tid)
      ) {
        autoDispatchingQueueRef.current.add(tid);
        const [nextRow, ...rest] = queue;
        handleUpdateQueuedRuns(tid, rest);
        const updatedThread: ExtendedChatThread = {
          ...thread,
          queuedRuns: rest,
          status: 'idle',
        };
        void handleSendPrompt(
          tid,
          nextRow.text,
          updatedThread,
          undefined,
          nextRow.attachments ?? []
        ).finally(() => {
          autoDispatchingQueueRef.current.delete(tid);
        });
      }
    }
    prevRunningStateRef.current = nextRunning;
  }, [threadsMap, isRunning, handleUpdateQueuedRuns, handleSendPrompt]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type !== 'drop') return;
        if (payload.paths.length === 0) return;
        const threadId = focusedThreadIdRef.current || (agentId ? `draft-${agentId}` : null);
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

  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const handleThreadsChanged = () => {
      const mySeq = ++seq;
      void loadChatSummariesWithFallback(agentId).then((summaries) => {
        if (!cancelled && isMountedRef.current && mySeq === seq) {
          setKnownThreadsList(summaries);
          setThreadsMap((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const summary of summaries) {
              const existing = next[summary.id];
              if (!existing) continue;
              if (
                existing.title !== summary.title ||
                (existing.workspaceId ?? null) !== (summary.workspaceId ?? null) ||
                existing.pinned !== summary.pinned
              ) {
                next[summary.id] = {
                  ...existing,
                  title: summary.title,
                  workspaceId: summary.workspaceId,
                  pinned: summary.pinned,
                };
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      });
    };
    window.addEventListener('kite:threads-changed', handleThreadsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('kite:threads-changed', handleThreadsChanged);
    };
  }, [agentId, isMountedRef]);

  const hasInitializedRef = useRef(false);

  // Initial load reconciles once with the backend (or when switching agents).
  // Use layout timing so switching modes/threads hydrates cached state before first paint.
  useLayoutEffect(() => {
    const agentChanged = prevAgentIdRef.current !== agentId;
    if (!hasInitializedRef.current || agentChanged) {
      hasInitializedRef.current = true;
      prevAgentIdRef.current = agentId;
      if (agentChanged) {
        const nextHydration = hydrateInitialChatState(agentId, initialThreadId);
        skipInitialSpinnerRef.current = nextHydration.hydrated;
        setKnownThreadsList(nextHydration.summaries);
        setThreadsMap((prev) => ({ ...prev, ...nextHydration.threadsMap }));
        gridThreadIdsRef.current = nextHydration.grid.threadIds;
        setGridThreadIds(nextHydration.grid.threadIds);
        focusedThreadIdRef.current = nextHydration.grid.focusedThreadId;
        setFocusedThreadId(nextHydration.grid.focusedThreadId);
        setIsLoadingInitial(!nextHydration.hydrated);
      }
      void initChatView();
      return;
    }

    if (!initialThreadId) {
      return;
    }
    if (
      focusedThreadIdRef.current === initialThreadId &&
      Boolean(threadsMapRef.current[initialThreadId]) &&
      gridThreadIdsRef.current.includes(initialThreadId)
    ) {
      return;
    }
    void switchToThread(initialThreadId);
  }, [workspaceId, agentId, initialThreadId]);

  const initChatView = async () => {
    const requestSeq = ++switchRequestSeqRef.current;
    const hydratedOnMount = skipInitialSpinnerRef.current;
    skipInitialSpinnerRef.current = false;
    if (!hydratedOnMount && gridThreadIdsRef.current.length === 0) {
      setIsLoadingInitial(true);
    }
    void fetchDynamicModels(defaultProvider, false);
    void checkLiveRuns();
    try {
      const [initialSummaries, savedGrid] = agentId
        ? [await loadChatSummariesWithFallback(agentId), null]
        : await Promise.all([
            loadChatSummariesWithFallback(agentId),
            loadSavedGrid(initialThreadId),
          ]);
      if (!isMountedRef.current) return;
      if (switchRequestSeqRef.current !== requestSeq) {
        setIsLoadingInitial(false);
        return;
      }

      let summaries = initialSummaries;
      setKnownThreadsList(summaries);

      if (agentId) {
        if (summaries.length > 0) {
          const ordered = sortAgentSummariesByTabOrder(summaries);
          summaries = ordered;
          void persistAgentTabOrder(ordered.map((thread) => thread.id).filter(Boolean));
          const first = ordered[0];
          if (first?.id) {
            const thread = await loadThreadWithFallback(first.id, agentId);
            if (!isMountedRef.current || switchRequestSeqRef.current !== requestSeq) return;
            if (thread?.id) {
              const boundThread = threadWithResolvedBinding(thread);
              setThreadsMap((prev) => ({ ...prev, [thread.id]: boundThread }));
              gridThreadIdsRef.current = [thread.id];
              setGridThreadIds([thread.id]);
              focusedThreadIdRef.current = thread.id;
              setFocusedThreadId(thread.id);
              setIsLoadingInitial(false);
              return;
            }
          }
        }
        if (isMountedRef.current && switchRequestSeqRef.current === requestSeq) {
          gridThreadIdsRef.current = [];
          setGridThreadIds([]);
          focusedThreadIdRef.current = null;
          setFocusedThreadId(null);
          setIsLoadingInitial(false);
        }
        return;
      }

      // Apply saved thread grid fetched in parallel above
      const loadedIds = savedGrid?.threadIds ?? [];
      const focused = savedGrid?.focusedThreadId ?? null;

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
        if (!isMountedRef.current) return;
        if (switchRequestSeqRef.current !== requestSeq) {
          setIsLoadingInitial(false);
          return;
        }
        setThreadsMap((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [id, loadedThread] of Object.entries(loadedMap)) {
            if ((configUpdateSeqRef.current[id] ?? 0) > 0) continue;
            if (!areThreadSnapshotsEquivalent(prev[id], loadedThread)) {
              next[id] = loadedThread;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        if (validIds.length > 0) {
          const nextFocused = validIds.includes(focused!) ? focused : validIds[0];
          if (!areStringArraysEqual(gridThreadIdsRef.current, validIds)) {
            gridThreadIdsRef.current = validIds;
            setGridThreadIds(validIds);
          }
          if (focusedThreadIdRef.current !== nextFocused) {
            focusedThreadIdRef.current = nextFocused;
            setFocusedThreadId(nextFocused);
          }
          setIsLoadingInitial(false);
          return;
        }
      }

      // No open threads -> render Chat Home
      if (isMountedRef.current && switchRequestSeqRef.current === requestSeq) {
        gridThreadIdsRef.current = [];
        setGridThreadIds([]);
        focusedThreadIdRef.current = null;
        setFocusedThreadId(null);
        setIsLoadingInitial(false);
      }
    } catch (e) {
      console.error('[ChatView] Failed to initialize chat view:', e);
      if (isMountedRef.current) {
        if (!hydratedOnMount && switchRequestSeqRef.current === requestSeq) {
          gridThreadIdsRef.current = [];
          setGridThreadIds([]);
          focusedThreadIdRef.current = null;
          setFocusedThreadId(null);
        }
        setIsLoadingInitial(false);
      }
    }
  };

  const handleStartThreadFromHome = async (promptText: string) => {
    const requestSeq = ++switchRequestSeqRef.current;
    const request = draftThreadRequest(draftConfig, agentId);
    const draftKey = agentId ? `draft-${agentId}` : 'draft';
    const draftAttachments = attachmentsMapRef.current[draftKey] || [];
    if (draftAttachments.length > 0) {
      writeAttachments(draftKey, []);
    }
    const activeFocusedWsId =
      focusedThreadIdRef.current && threadsMapRef.current[focusedThreadIdRef.current]
        ? (threadsMapRef.current[focusedThreadIdRef.current].workspaceId ?? null)
        : null;
    const homeWorkspaceId = activeFocusedWsId ?? (embedded || agentId ? workspaceId : null);
    try {
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('create_agent_chat', {
            ...request,
            ...(homeWorkspaceId ? { workspaceId: homeWorkspaceId } : {}),
          })
        : await invokeCommand<ExtendedChatThread>('create_general_chat', {
            ...request,
            workspaceId: homeWorkspaceId,
          });

      if (!isMountedRef.current || switchRequestSeqRef.current !== requestSeq) return;
      const tid = thread.id;
      const boundThread = threadWithResolvedBinding(thread);
      holdThreadSelection(tid);
      setThreadsMap((prev) => ({ ...prev, [tid]: boundThread }));
      setKnownThreadsList((prev) => [boundThread, ...prev.filter((t) => t.id !== tid)]);
      gridThreadIdsRef.current = [tid];
      setGridThreadIds([tid]);
      focusedThreadIdRef.current = tid;
      setFocusedThreadId(tid);
      setIsLoadingInitial(false);
      void persistGrid([tid], tid);
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', { detail: { threadId: tid, mode: 'chat' } })
      );
      notifyThreadsChanged();

      setTimeout(() => {
        void handleSendPrompt(tid, promptText, boundThread, undefined, draftAttachments);
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
  }, [draftConfig, agentId, workspaceId, embedded]);

  const handleCreateNewThread = async (targetWorkspaceId?: string | null | unknown): Promise<string | undefined> => {
    const requestSeq = ++switchRequestSeqRef.current;
    const activeFocusedId = focusedThreadIdRef.current ?? focusedThreadId;
    const activeFocusedThread = activeFocusedId ? threadsMapRef.current[activeFocusedId] ?? threadsMap[activeFocusedId] : null;
    const fallbackWorkspaceId = (workspaceId ?? null) !== null
      ? workspaceId
      : agentId
      ? null
      : embedded
      ? workspaceId
      : activeFocusedThread
      ? (activeFocusedThread.workspaceId ?? null)
      : null;
    const scopeWorkspaceId =
      typeof targetWorkspaceId === 'string'
        ? targetWorkspaceId
        : targetWorkspaceId === null
        ? null
        : fallbackWorkspaceId;
    const latest = createDraftConfig(
      draftConfig.provider,
      currentAgent?.defaultModel || draftConfig.model || null,
      draftConfig.agent ?? null,
      currentAgent ?? {
        defaultMode: draftConfig.mode,
        defaultPlan: draftConfig.plan,
        defaultEffort: draftConfig.effort,
      }
    );

    // Reuse the open draft ONLY if the currently focused thread in this pane is already
    // a blank conversation (zero messages, zero voice turns) in the requested scope.
    const currentThread = activeFocusedThread;
    const currentScopeMatches = currentThread
      ? (agentId
          ? currentThread.profileId === agentId
          : (currentThread.workspaceId ?? null) === (scopeWorkspaceId ?? null))
      : false;
    const isCurrentEmptyDraft = Boolean(
      currentThread &&
        currentScopeMatches &&
        currentThread.status !== 'running' &&
        !isRunningRef.current[currentThread.id] &&
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
        ...(latest.plan !== undefined ? { plan: latest.plan } : {}),
        ...(latest.agent ? { agent: latest.agent } : {}),
      });
      if (!isMountedRef.current || switchRequestSeqRef.current !== requestSeq) return currentThread.id;
      setIsLoadingInitial(false);
      holdThreadSelection(currentThread.id);
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', { detail: { threadId: currentThread.id, mode: 'chat' } })
      );
      if (scopeWorkspaceId && (embedded || agentId)) {
        window.dispatchEvent(
          new CustomEvent('kite:select-workspace', { detail: { workspaceId: scopeWorkspaceId } })
        );
      }
      return currentThread.id;
    }

    try {
      const request = draftThreadRequest(latest, agentId);
      const thread = agentId
        ? await invokeCommand<ExtendedChatThread>('create_agent_chat', {
            ...request,
            ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
          })
        : await invokeCommand<ExtendedChatThread>('create_general_chat', {
            ...request,
            workspaceId: scopeWorkspaceId ?? null,
          });
      if (!isMountedRef.current || switchRequestSeqRef.current !== requestSeq) return;
      const tid = thread.id;
      const boundThread = threadWithResolvedBinding(thread);
      holdThreadSelection(tid);
      setThreadsMap((prev) => ({ ...prev, [tid]: boundThread }));
      setKnownThreadsList((prev) => [boundThread, ...prev.filter((t) => t.id !== tid)]);

      const nextGrid = [tid];
      gridThreadIdsRef.current = nextGrid;
      setGridThreadIds(nextGrid);
      focusedThreadIdRef.current = tid;
      setFocusedThreadId(tid);
      setIsLoadingInitial(false);
      void persistGrid(nextGrid, tid);
      setShowHistoryPopover(false);
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', { detail: { threadId: tid, mode: 'chat' } })
      );
      if (scopeWorkspaceId && (embedded || agentId)) {
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

  const handleLoadThread = (threadId: string) => switchToThread(threadId);

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
    const thread = threadsMapRef.current[threadId] ?? threadsMap[threadId];
    if (!thread) return;
    const seq = (configUpdateSeqRef.current[threadId] ?? 0) + 1;
    configUpdateSeqRef.current[threadId] = seq;
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
      if (!isMountedRef.current || configUpdateSeqRef.current[threadId] !== seq) return;
      const mergedThread = threadWithResolvedBinding({
        ...updated,
        effort: effort ?? updated.effort,
      });
      const pendingQueue = pendingQueuedRunsRef.current[threadId];
      const currentSnapshot = threadsMapRef.current[threadId];
      const nextThread = mergeThreadConfigUpdate(
        currentSnapshot,
        mergedThread,
        pendingQueue,
        Boolean(
          currentSnapshot &&
            (currentSnapshot.status === 'running' ||
              isRunningRef.current[threadId] ||
              activePollThreadsRef.current.has(threadId))
        )
      );
      if (currentSnapshot) {
        threadsMapRef.current = {
          ...threadsMapRef.current,
          [threadId]: nextThread,
        };
      }
      setThreadsMap((prev) => {
        const cur = prev[threadId];
        const isLiveTurn = Boolean(
          cur &&
            (cur.status === 'running' ||
              isRunningRef.current[threadId] ||
              activePollThreadsRef.current.has(threadId))
        );
        return {
          ...prev,
          [threadId]: mergeThreadConfigUpdate(
            cur,
            mergedThread,
            pendingQueuedRunsRef.current[threadId],
            isLiveTurn
          ),
        };
      });
      setKnownThreadsList((prev) => prev.map((t) => (t.id === threadId ? nextThread : t)));
      notifyThreadsChanged();
      if (patch.workspaceId !== undefined) {
        window.dispatchEvent(
          new CustomEvent('kite:thread-workspace-assigned', {
            detail: { threadId, workspaceId: mergedThread.workspaceId ?? null },
          })
        );
      }

      void fetchDynamicModels(provider);
      void ensureDynamicAgents(provider);
    } catch (err) {
      console.error('[ChatView] update_chat_configuration error:', err);
    } finally {
      if (isMountedRef.current) setActiveDropdown(null);
    }
  };

  const handleUpdateConfigRef = useRef(handleUpdateConfig);
  handleUpdateConfigRef.current = handleUpdateConfig;

  useEffect(() => {
    if (agentId) return;
    const onAssignWorkspace = (e: Event) => {
      const custom = e as CustomEvent<{ threadId?: string; workspaceId?: string | null }>;
      const workspaceIdToAssign = custom.detail?.workspaceId;
      if (workspaceIdToAssign === undefined) return;
      const targetThreadId =
        custom.detail?.threadId ?? focusedThreadIdRef.current ?? null;
      if (!targetThreadId) return;
      void handleUpdateConfigRef.current(targetThreadId, {
        workspaceId: workspaceIdToAssign,
      });
    };
    window.addEventListener('kite:assign-thread-workspace', onAssignWorkspace);
    return () => {
      window.removeEventListener('kite:assign-thread-workspace', onAssignWorkspace);
    };
  }, [agentId]);

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
    writeAttachments,
    handleQueuePrompt,
    handleUpdateQueuedRuns,
    handleSendNowQueuedRun,
    handleSteerPrompt,
    handleSendPrompt,
    handleUserInputResponse,
    setKnownThreadsList,
    persistAgentTabOrder,
  };
}
