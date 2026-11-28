import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getThreadSubagentDetail,
  getThreadSwarmState,
  loadChatThread,
} from '../../../lib/ipc/chat';
import {
  setActiveSubagentInspection,
  type OpenRightDockSubagentDetail,
} from '../../../lib/subagentNav';
import { groupTranscriptRows } from '../chat/ChatItemRow';
import { dedupeSubagentRuns } from '../chat/SubagentActivityCard';
import {
  applySubagentEvent,
  countRunningSubagents,
  type ChatSubagentEventPayload,
} from '../chat/hooks/useSubagentEvents';
import type { ApprovalRequest, ExtendedChatThread } from '../chat/types';
import {
  filterInspectorSteps,
  isRunBlocked,
  type InspectorMode,
} from './subagentInspectorHelpers';

interface UseSubagentInspectorThreadArgs {
  workspaceId: string | null;
  activeThreadId: string | null;
  requestedTarget: OpenRightDockSubagentDetail | null;
  mode: InspectorMode;
  selectedSubagentId: string | null;
  onAutoSwarmMode: () => void;
}

export function useSubagentInspectorThread({
  workspaceId,
  activeThreadId,
  requestedTarget,
  mode,
  selectedSubagentId,
  onAutoSwarmMode,
}: UseSubagentInspectorThreadArgs) {
  const [thread, setThread] = useState<ExtendedChatThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [childApproval, setChildApproval] = useState<ApprovalRequest | null>(null);
  const hydratedKeyRef = useRef<string | null>(null);
  const loadedThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    hydratedKeyRef.current = null;
    if (!activeThreadId) {
      loadedThreadIdRef.current = null;
      setThread(null);
      setChildApproval(null);
      setLoading(false);
      return;
    }
    if (loadedThreadIdRef.current === activeThreadId && !requestedTarget) {
      return;
    }
    if (loadedThreadIdRef.current !== activeThreadId) {
      loadedThreadIdRef.current = null;
    }
    setThread((prev) => (prev?.id === activeThreadId ? prev : null));
    setChildApproval(null);
    let cancelled = false;
    setLoading(true);
    void loadChatThread(activeThreadId)
      .then((loaded) => {
        if (cancelled || !loaded) return;
        loadedThreadIdRef.current = activeThreadId;
        setThread(loaded);
        if (!requestedTarget && !loaded.subagentRuns?.length && loaded.swarmState) {
          onAutoSwarmMode();
        }
      })
      .catch(() => {
        if (!cancelled) setThread(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeThreadId, requestedTarget]);

  useEffect(() => {
    if (
      !activeThreadId ||
      typeof window === 'undefined' ||
      !('__TAURI_INTERNALS__' in window)
    ) {
      return;
    }
    let unlistenSub: (() => void) | undefined;
    let unlistenSwarm: (() => void) | undefined;
    let cancelled = false;
    const handleEvent = (payload: ChatSubagentEventPayload | undefined) => {
      if (!payload || payload.threadId !== activeThreadId) return;
      setThread((prev) => (prev ? applySubagentEvent(prev, payload) : prev));
    };
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const stopSub = await listen<ChatSubagentEventPayload>('chat-subagent-event', (event) => {
          handleEvent(event.payload);
        });
        if (cancelled) {
          stopSub();
          return;
        }
        unlistenSub = stopSub;
        const stopSwarm = await listen<ChatSubagentEventPayload>('chat-swarm-event', (event) => {
          handleEvent(event.payload);
        });
        if (cancelled) {
          stopSwarm();
          return;
        }
        unlistenSwarm = stopSwarm;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlistenSub?.();
      unlistenSwarm?.();
    };
  }, [activeThreadId]);

  // Live updates arrive through `chat-subagent-event` / `chat-swarm-event` above and step
  // transcripts hydrate lazily via `getThreadSubagentDetail`, so `kite:threads-changed`
  // never re-downloads the whole parent thread here.

  const runs = useMemo(
    () => dedupeSubagentRuns(thread?.subagentRuns),
    [thread?.subagentRuns],
  );
  const swarmState = thread?.swarmState ?? null;

  useEffect(() => {
    if (!thread) return;
    window.dispatchEvent(
      new CustomEvent('kite:subagent-activity-count', {
        detail: { threadId: thread.id, count: countRunningSubagents(thread) },
      }),
    );
  }, [thread]);

  const activeRun = useMemo(() => {
    if (runs.length === 0) return null;
    if (selectedSubagentId) {
      const exact = runs.find(
        (r) =>
          r.subagentId === selectedSubagentId ||
          r.parentToolCallId === selectedSubagentId ||
          r.childThreadId === selectedSubagentId,
      );
      if (exact) return exact;
    }
    return runs.length === 1 ? runs[0] : null;
  }, [runs, selectedSubagentId]);

  const visibleSteps = useMemo(
    () => filterInspectorSteps(activeRun?.items, activeRun?.prompt),
    [activeRun?.items, activeRun?.prompt],
  );

  const groupedRows = useMemo(() => groupTranscriptRows(visibleSteps), [visibleSteps]);

  useEffect(() => {
    return () => {
      setActiveSubagentInspection(null);
    };
  }, []);

  useEffect(() => {
    if (!activeThreadId) {
      setActiveSubagentInspection(null);
      return;
    }
    if (!thread) return;
    if (mode === 'swarm' && swarmState) {
      setActiveSubagentInspection({
        threadId: thread.id,
        swarmId: swarmState.swarmId,
        mode: 'swarm',
        workspaceId,
      });
    } else if (activeRun) {
      setActiveSubagentInspection({
        threadId: thread.id,
        subagentId: activeRun.subagentId,
        childThreadId: activeRun.childThreadId ?? null,
        mode: 'subagent',
        workspaceId,
      });
    } else if (!loading) {
      setActiveSubagentInspection(null);
    }
  }, [
    activeThreadId,
    loading,
    thread?.id,
    mode,
    swarmState?.swarmId,
    activeRun?.subagentId,
    activeRun?.childThreadId,
    workspaceId,
  ]);

  const hydratedItemCount = activeRun?.items?.length ?? 0;
  const reportedStepCount = activeRun?.stepCount ?? 0;
  useEffect(() => {
    if (!thread || !activeRun) return;
    const needsHydration =
      visibleSteps.length === 0 || reportedStepCount > hydratedItemCount;
    if (!needsHydration) return;
    const hydrationKey = `${thread.id}:${activeRun.subagentId}:${activeRun.status ?? ''}:${reportedStepCount}:${hydratedItemCount}:${activeRun.updatedAtUnixMs ?? 0}`;
    if (hydratedKeyRef.current === hydrationKey) return;
    hydratedKeyRef.current = hydrationKey;
    let cancelled = false;
    void getThreadSubagentDetail(thread.id, activeRun.subagentId)
      .then((detail) => {
        if (cancelled || !detail) return;
        setThread((prev) =>
          prev
            ? applySubagentEvent(prev, {
                kind: 'subagentRunUpdated',
                threadId: prev.id,
                run: detail,
              })
            : prev,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    thread?.id,
    activeRun?.subagentId,
    activeRun?.status,
    activeRun?.updatedAtUnixMs,
    reportedStepCount,
    hydratedItemCount,
    visibleSteps.length,
  ]);

  useEffect(() => {
    const childTid = activeRun?.childThreadId;
    if (!childTid || !isRunBlocked(activeRun?.status)) {
      setChildApproval(null);
      return;
    }
    let cancelled = false;
    void loadChatThread(childTid)
      .then((loaded) => {
        if (cancelled || !loaded) return;
        setChildApproval(loaded.pendingApproval ?? null);
      })
      .catch(() => {
        if (!cancelled) setChildApproval(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.childThreadId, activeRun?.status, activeRun?.updatedAtUnixMs]);

  useEffect(() => {
    if (!thread || !swarmState || swarmState.posts.length > 0) return;
    let cancelled = false;
    void getThreadSwarmState(thread.id)
      .then((latest) => {
        if (cancelled || !latest) return;
        setThread((prev) =>
          prev
            ? applySubagentEvent(prev, {
                kind: 'swarmStateUpdated',
                threadId: prev.id,
                swarmState: latest,
              })
            : prev,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [thread?.id, swarmState?.swarmId]);

  return {
    thread,
    setThread,
    loading,
    runs,
    swarmState,
    activeRun,
    visibleSteps,
    groupedRows,
    childApproval,
    setChildApproval,
  };
}
