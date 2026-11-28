import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  getThreadSubagentDetail,
  respondChatApproval,
  stopSubagentRun,
  type GlobalSubagentEntry,
} from '../../../lib/ipc/chat';
import type { OpenRightDockSubagentDetail } from '../../../lib/subagentNav';
import type { SwarmMember } from '../../../types';
import { applySubagentEvent } from '../chat/hooks/useSubagentEvents';
import { GlobalSubagentsView } from './GlobalSubagentsView';
import { SubagentInspectorHeader } from './SubagentInspectorHeader';
import { SubagentRunsOverview } from './SubagentRunsOverview';
import { SubagentStepStream } from './SubagentStepStream';
import { SwarmBoardInspector } from './SwarmBoardInspector';
import { formatInspectorModelName } from './swarmBoardHelpers';
import {
  filterInspectorSteps,
  isRunActive,
  resolveRequestedRunId,
  type InspectorMode,
  type InspectorScope,
} from './subagentInspectorHelpers';
import { useGlobalSubagents } from './useGlobalSubagents';
import { useSubagentInspectorThread } from './useSubagentInspectorThread';
import { ThemeHeroFigure } from '../../theme/ThemeHeroFigure';
import '../chat.css';
import './subagents.css';

export { filterInspectorSteps };

export interface SubagentInspectorViewProps {
  workspaceId: string | null;
  selectedThreadId?: string | null;
  requestedTarget?: OpenRightDockSubagentDetail | null;
  onClearTarget?: () => void;
}

export const SubagentInspectorView: React.FC<SubagentInspectorViewProps> = ({
  workspaceId,
  selectedThreadId = null,
  requestedTarget = null,
  onClearTarget,
}) => {
  const reduceMotion = useReducedMotion();

  const [scope, setScope] = useState<InspectorScope>('thread');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [globalTarget, setGlobalTarget] = useState<OpenRightDockSubagentDetail | null>(null);
  const [mode, setMode] = useState<InspectorMode>('subagent');
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(() =>
    resolveRequestedRunId(requestedTarget),
  );
  const [fromSwarmRoster, setFromSwarmRoster] = useState(false);
  const [briefOverride, setBriefOverride] = useState<{ runId: string; expanded: boolean } | null>(null);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [stoppingRunKey, setStoppingRunKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const streamRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const seenStepIdsRef = useRef<Set<string>>(new Set());

  const effectiveTarget = scope === 'all' ? globalTarget : requestedTarget;
  const activeThreadId =
    scope === 'all'
      ? (globalTarget?.threadId ?? null)
      : (requestedTarget?.threadId ?? selectedThreadId);

  const prevThreadIdRef = useRef<string | null>(activeThreadId);

  const {
    snapshot: globalSnapshot,
    loading: globalLoading,
    refresh: refreshGlobal,
  } = useGlobalSubagents({ includeHistory });

  const {
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
  } = useSubagentInspectorThread({
    workspaceId,
    activeThreadId,
    requestedTarget: effectiveTarget,
    mode,
    selectedSubagentId,
    onAutoSwarmMode: () => setMode('swarm'),
  });

  useEffect(() => {
    if (!requestedTarget) return;
    setScope('thread');
    setGlobalTarget(null);
    if (
      requestedTarget.mode === 'swarm' ||
      (requestedTarget.swarmId && !resolveRequestedRunId(requestedTarget))
    ) {
      setMode('swarm');
      setSelectedSubagentId(null);
    } else {
      setMode('subagent');
      setSelectedSubagentId(resolveRequestedRunId(requestedTarget));
    }
    setFromSwarmRoster(false);
    setBriefOverride(null);
    atBottomRef.current = true;
    setAutoScrollPaused(false);
    setActionError(null);
  }, [requestedTarget]);

  useEffect(() => {
    if (prevThreadIdRef.current === activeThreadId) return;
    prevThreadIdRef.current = activeThreadId;
    const targetForThread =
      effectiveTarget && effectiveTarget.threadId === activeThreadId ? effectiveTarget : null;
    if (
      targetForThread?.mode === 'swarm' ||
      (targetForThread?.swarmId && !resolveRequestedRunId(targetForThread))
    ) {
      setMode('swarm');
      setSelectedSubagentId(null);
    } else {
      setMode('subagent');
      setSelectedSubagentId(resolveRequestedRunId(targetForThread));
    }
    setFromSwarmRoster(false);
    setBriefOverride(null);
    atBottomRef.current = true;
    setAutoScrollPaused(false);
    setActionError(null);
  }, [activeThreadId, effectiveTarget]);

  const briefExpanded =
    briefOverride && activeRun && briefOverride.runId === activeRun.subagentId
      ? briefOverride.expanded
      : visibleSteps.length === 0;

  const activeRunRunning = activeRun ? isRunActive(activeRun.status) : false;

  useEffect(() => {
    for (const item of visibleSteps) {
      seenStepIdsRef.current.add(item.id);
    }
  }, [visibleSteps]);

  const parentModelLabel = formatInspectorModelName(thread?.model, thread?.provider);
  const hasRuns = runs.length > 0;
  const hasSwarm = Boolean(swarmState);
  const showingThreadOverview =
    scope === 'thread' && mode === 'subagent' && runs.length > 1 && !activeRun;
  const fromGlobalView = scope === 'all' && Boolean(globalTarget);

  const handleJumpToThread = useCallback(
    (targetThreadId: string, subagentId?: string | null) => {
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', {
          detail: { threadId: targetThreadId },
        }),
      );
      if (subagentId) {
        const card = document.querySelector(`[data-subagent-id="${subagentId}"]`);
        if (card && typeof card.scrollIntoView === 'function') {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    },
    [],
  );

  const handleJumpToParent = () => {
    if (!thread) return;
    handleJumpToThread(thread.id, activeRun?.subagentId);
  };

  const handleStopRun = useCallback(
    async (targetThreadId: string, subagentId: string) => {
      const key = `${targetThreadId}:${subagentId}`;
      if (stoppingRunKey) return;
      setStoppingRunKey(key);
      setActionError(null);
      try {
        const res = await stopSubagentRun(targetThreadId, subagentId);
        if (res.run) {
          setThread((prev) =>
            prev && prev.id === targetThreadId
              ? applySubagentEvent(prev, {
                  kind: 'subagentRunUpdated',
                  threadId: prev.id,
                  run: res.run!,
                })
              : prev,
          );
        }
        void refreshGlobal();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to stop subagent');
      } finally {
        setStoppingRunKey(null);
      }
    },
    [stoppingRunKey, setThread, refreshGlobal],
  );

  const handlePopOutChildThread = () => {
    if (!activeRun?.childThreadId) return;
    window.dispatchEvent(
      new CustomEvent('kite:select-thread', {
        detail: { threadId: activeRun.childThreadId },
      }),
    );
  };

  const handleChildApprovalDecision = useCallback(
    async (
      decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
      requestId: string,
    ) => {
      const childTid = activeRun?.childThreadId;
      if (!childTid || !thread || resolvingApproval) return;
      setResolvingApproval(true);
      setActionError(null);
      try {
        await respondChatApproval(childTid, decision, requestId);
        setChildApproval(null);
        const detail = await getThreadSubagentDetail(thread.id, activeRun.subagentId);
        if (detail) {
          setThread((prev) =>
            prev
              ? applySubagentEvent(prev, {
                  kind: 'subagentRunUpdated',
                  threadId: prev.id,
                  run: detail,
                })
              : prev,
          );
        }
        void refreshGlobal();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to resolve child approval');
      } finally {
        setResolvingApproval(false);
      }
    },
    [
      activeRun?.childThreadId,
      activeRun?.subagentId,
      thread,
      resolvingApproval,
      setChildApproval,
      setThread,
      refreshGlobal,
    ],
  );

  const handleInspectWorker = (member: SwarmMember) => {
    const matched = runs.find(
      (r) =>
        (member.subagentId && r.subagentId === member.subagentId) ||
        (member.childThreadId && r.childThreadId === member.childThreadId) ||
        r.swarmMemberName?.toLowerCase() === member.name.toLowerCase(),
    );
    const targetId = matched?.subagentId ?? member.subagentId;
    if (targetId) {
      setSelectedSubagentId(targetId);
      setFromSwarmRoster(true);
      setMode('subagent');
      setBriefOverride(null);
      atBottomRef.current = true;
      setAutoScrollPaused(false);
    }
  };

  const handleSelectScope = (nextScope: InspectorScope) => {
    if (nextScope === 'thread') {
      if (requestedTarget && selectedThreadId && requestedTarget.threadId !== selectedThreadId) {
        onClearTarget?.();
      }
      setGlobalTarget(null);
      setScope('thread');
      setSelectedSubagentId(null);
      setFromSwarmRoster(false);
    } else {
      setGlobalTarget(null);
      setScope('all');
      void refreshGlobal();
    }
    setBriefOverride(null);
    setActionError(null);
  };

  const handleInspectGlobalEntry = (entry: GlobalSubagentEntry) => {
    setGlobalTarget({
      threadId: entry.threadId,
      subagentId: entry.run.subagentId,
      childThreadId: entry.run.childThreadId ?? null,
      mode: 'subagent',
      workspaceId: entry.workspaceId ?? null,
    });
    setSelectedSubagentId(entry.run.subagentId);
    setMode('subagent');
    setFromSwarmRoster(false);
    setBriefOverride(null);
    atBottomRef.current = true;
    setAutoScrollPaused(false);
  };

  const isThreadEmpty =
    scope === 'thread' && !loading && (!thread || (!hasRuns && !hasSwarm));
  const threadScopeBadgeCount =
    scope === 'thread'
      ? runs.length
      : selectedThreadId
        ? globalSnapshot.runs.filter((entry) => entry.threadId === selectedThreadId).length
        : 0;

  return (
    <div
      className="subagent-inspector"
      data-testid="subagent-inspector-view"
      data-workspace-id={workspaceId ?? ''}
      data-thread-id={thread?.id ?? activeThreadId ?? ''}
    >
      <SubagentInspectorHeader
        scope={scope}
        threadRunsCount={threadScopeBadgeCount}
        globalTotalCount={globalSnapshot.totalCount}
        globalActiveCount={globalSnapshot.activeCount}
        thread={scope === 'all' && !globalTarget ? null : thread}
        mode={mode}
        hasRuns={hasRuns}
        hasSwarm={hasSwarm}
        runs={runs}
        activeRun={activeRun}
        showingOverview={showingThreadOverview}
        fromGlobalView={fromGlobalView}
        parentModelLabel={parentModelLabel}
        stoppingRun={Boolean(
          activeRun &&
            thread &&
            stoppingRunKey === `${thread.id}:${activeRun.subagentId}`,
        )}
        fromSwarmRoster={fromSwarmRoster}
        onSelectScope={handleSelectScope}
        onJumpToParent={handleJumpToParent}
        onPopOutChildThread={handlePopOutChildThread}
        onSelectMode={(nextMode) => {
          setMode(nextMode);
          setFromSwarmRoster(false);
        }}
        onSelectRun={(subagentId) => {
          setSelectedSubagentId(subagentId);
          setBriefOverride(null);
          atBottomRef.current = true;
          setAutoScrollPaused(false);
        }}
        onBackToOverview={() => {
          if (requestedTarget) {
            onClearTarget?.();
          }
          setSelectedSubagentId(null);
          setFromSwarmRoster(false);
          setBriefOverride(null);
        }}
        onBackToGlobal={() => {
          setGlobalTarget(null);
          setSelectedSubagentId(null);
          setBriefOverride(null);
          void refreshGlobal();
        }}
        onStopActiveRun={() => {
          if (thread && activeRun) {
            void handleStopRun(thread.id, activeRun.subagentId);
          }
        }}
        onBackToSwarmRoster={() => {
          setMode('swarm');
          setFromSwarmRoster(false);
        }}
      />

      {scope === 'all' && !globalTarget ? (
        <GlobalSubagentsView
          workspaceId={workspaceId}
          selectedThreadId={selectedThreadId}
          entries={globalSnapshot.runs}
          totalCount={globalSnapshot.totalCount}
          activeCount={globalSnapshot.activeCount}
          historyCount={globalSnapshot.historyCount ?? 0}
          includeHistory={includeHistory}
          loading={globalLoading}
          stoppingRunKey={stoppingRunKey}
          onInspectEntry={handleInspectGlobalEntry}
          onStopEntry={(entry) => void handleStopRun(entry.threadId, entry.run.subagentId)}
          onFocusThread={(tid) => handleJumpToThread(tid)}
          onToggleHistory={() => setIncludeHistory((prev) => !prev)}
        />
      ) : isThreadEmpty ? (
        <div className="subagent-inspector__empty" data-testid="subagent-inspector-empty">
          <div style={{ margin: '0 auto 4px' }}>
            <ThemeHeroFigure variant="card" />
          </div>
          <strong>No subagents active yet</strong>
          <span>
            Subagents and Swarms launched by the main agent will stream step by step here.
          </span>
          {globalSnapshot.totalCount > 0 && (
            <button
              type="button"
              className="subagent-inspector__empty-cta"
              onClick={() => handleSelectScope('all')}
            >
              {globalSnapshot.activeCount > 0
                ? `View ${globalSnapshot.activeCount} live across all threads`
                : `Browse ${globalSnapshot.totalCount} across all threads`}
            </button>
          )}
        </div>
      ) : mode === 'swarm' && swarmState ? (
        <SwarmBoardInspector
          threadId={thread?.id ?? null}
          swarmState={swarmState}
          parentModelLabel={parentModelLabel}
          subagentRuns={runs}
          onInspectWorker={handleInspectWorker}
          onSwarmUpdated={(nextSwarm) =>
            setThread((prev) =>
              prev
                ? applySubagentEvent(prev, {
                    kind: 'swarmStateUpdated',
                    threadId: prev.id,
                    swarmState: nextSwarm,
                  })
                : prev,
            )
          }
        />
      ) : showingThreadOverview ? (
        <SubagentRunsOverview
          runs={runs}
          stoppingRunId={
            thread && stoppingRunKey?.startsWith(`${thread.id}:`)
              ? stoppingRunKey.slice(thread.id.length + 1)
              : null
          }
          onInspectRun={(subagentId) => {
            setSelectedSubagentId(subagentId);
            setFromSwarmRoster(false);
            setBriefOverride(null);
            atBottomRef.current = true;
            setAutoScrollPaused(false);
          }}
          onStopRun={(subagentId) => {
            if (thread) {
              void handleStopRun(thread.id, subagentId);
            }
          }}
        />
      ) : activeRun ? (
        <SubagentStepStream
          workspaceId={thread?.workspaceId ?? workspaceId ?? null}
          parentThreadId={thread?.id ?? activeThreadId ?? ''}
          activeRun={activeRun}
          activeRunRunning={activeRunRunning}
          visibleSteps={visibleSteps}
          groupedRows={groupedRows}
          briefExpanded={briefExpanded}
          onToggleBrief={() =>
            setBriefOverride({ runId: activeRun.subagentId, expanded: !briefExpanded })
          }
          reduceMotion={reduceMotion}
          streamRef={streamRef}
          atBottomRef={atBottomRef}
          seenStepIdsRef={seenStepIdsRef}
          autoScrollPaused={autoScrollPaused}
          onSetAutoScrollPaused={setAutoScrollPaused}
          childApproval={childApproval}
          resolvingApproval={resolvingApproval}
          onChildApprovalDecision={(decision, reqId) =>
            void handleChildApprovalDecision(decision, reqId)
          }
          actionError={actionError}
          onJumpToParent={handleJumpToParent}
        />
      ) : null}
    </div>
  );
};
