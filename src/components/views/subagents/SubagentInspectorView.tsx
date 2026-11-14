import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  getThreadSubagentDetail,
  respondChatApproval,
  sendSubagentMessage,
  stopSubagentRun,
} from '../../../lib/ipc/chat';
import type { OpenRightDockSubagentDetail } from '../../../lib/subagentNav';
import type { SwarmMember } from '../../../types';
import { applySubagentEvent } from '../chat/hooks/useSubagentEvents';
import { SubagentInspectorHeader } from './SubagentInspectorHeader';
import { SubagentStepStream } from './SubagentStepStream';
import { SwarmBoardInspector, formatInspectorModelName } from './SwarmBoardInspector';
import {
  filterInspectorSteps,
  isRunActive,
  type InspectorMode,
} from './subagentInspectorHelpers';
import { useSubagentInspectorThread } from './useSubagentInspectorThread';
import './subagents.css';

export { filterInspectorSteps };

export interface SubagentInspectorViewProps {
  workspaceId: string | null;
  selectedThreadId?: string | null;
  requestedTarget?: OpenRightDockSubagentDetail | null;
}

export const SubagentInspectorView: React.FC<SubagentInspectorViewProps> = ({
  workspaceId,
  selectedThreadId = null,
  requestedTarget = null,
}) => {
  const reduceMotion = useReducedMotion();
  const activeThreadId = requestedTarget?.threadId ?? selectedThreadId;

  const [mode, setMode] = useState<InspectorMode>('subagent');
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [fromSwarmRoster, setFromSwarmRoster] = useState(false);
  const [briefOverride, setBriefOverride] = useState<{ runId: string; expanded: boolean } | null>(null);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [steeringText, setSteeringText] = useState('');
  const [sendingSteering, setSendingSteering] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const streamRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const seenStepIdsRef = useRef<Set<string>>(new Set());

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
    requestedTarget,
    mode,
    selectedSubagentId,
    onAutoSwarmMode: () => setMode('swarm'),
  });

  useEffect(() => {
    if (!requestedTarget) return;
    if (requestedTarget.mode === 'swarm' || (requestedTarget.swarmId && !requestedTarget.subagentId)) {
      setMode('swarm');
      setFromSwarmRoster(false);
    } else {
      setMode('subagent');
      if (requestedTarget.subagentId) {
        setSelectedSubagentId(requestedTarget.subagentId);
      }
      setFromSwarmRoster(false);
    }
    setBriefOverride(null);
  }, [requestedTarget]);

  const briefExpanded =
    briefOverride && activeRun && briefOverride.runId === activeRun.subagentId
      ? briefOverride.expanded
      : visibleSteps.length === 0;

  const activeRunRunning = activeRun ? isRunActive(activeRun.status) : false;

  const stepCount = visibleSteps.length;
  useEffect(() => {
    if (mode !== 'subagent' || !atBottomRef.current) return;
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [mode, activeRun?.subagentId, stepCount]);

  useEffect(() => {
    for (const item of visibleSteps) {
      seenStepIdsRef.current.add(item.id);
    }
  }, [visibleSteps]);

  const parentModelLabel = formatInspectorModelName(thread?.model, thread?.provider);
  const hasRuns = runs.length > 0;
  const hasSwarm = Boolean(swarmState);

  const handleJumpToParent = () => {
    if (!thread) return;
    window.dispatchEvent(
      new CustomEvent('kite:select-thread', {
        detail: { threadId: thread.id },
      }),
    );
    if (activeRun?.subagentId) {
      const card = document.querySelector(`[data-subagent-id="${activeRun.subagentId}"]`);
      if (card && typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  const handleStopActiveRun = async () => {
    if (!thread || !activeRun || stoppingRun) return;
    setStoppingRun(true);
    setActionError(null);
    try {
      const res = await stopSubagentRun(thread.id, activeRun.subagentId);
      if (res.run) {
        setThread((prev) =>
          prev
            ? applySubagentEvent(prev, {
                kind: 'subagentRunUpdated',
                threadId: prev.id,
                run: res.run!,
              })
            : prev,
        );
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to stop subagent');
    } finally {
      setStoppingRun(false);
    }
  };

  const handleSendSteering = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!thread || !activeRun || sendingSteering) return;
    const msg = steeringText.trim();
    if (!msg) return;
    setSendingSteering(true);
    setActionError(null);
    try {
      const res = await sendSubagentMessage(thread.id, activeRun.subagentId, msg);
      setSteeringText('');
      if (res.run) {
        setThread((prev) =>
          prev
            ? applySubagentEvent(prev, {
                kind: 'subagentRunUpdated',
                threadId: prev.id,
                run: res.run!,
              })
            : prev,
        );
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to send subagent message');
    } finally {
      setSendingSteering(false);
    }
  };

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
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to resolve child approval');
      } finally {
        setResolvingApproval(false);
      }
    },
    [activeRun?.childThreadId, activeRun?.subagentId, thread, resolvingApproval, setChildApproval, setThread],
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
    }
  };

  if (!loading && (!thread || (!hasRuns && !hasSwarm))) {
    return (
      <div className="subagent-inspector" data-testid="subagent-inspector-view">
        <div className="subagent-inspector__empty" data-testid="subagent-inspector-empty">
          <strong>No subagents active yet</strong>
          <span>
            Subagents and Swarms launched by the main agent will stream step by step here.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="subagent-inspector"
      data-testid="subagent-inspector-view"
      data-workspace-id={workspaceId ?? ''}
      data-thread-id={thread?.id ?? activeThreadId ?? ''}
    >
      <SubagentInspectorHeader
        thread={thread}
        mode={mode}
        hasRuns={hasRuns}
        hasSwarm={hasSwarm}
        runs={runs}
        activeRun={activeRun}
        parentModelLabel={parentModelLabel}
        stoppingRun={stoppingRun}
        fromSwarmRoster={fromSwarmRoster}
        onJumpToParent={handleJumpToParent}
        onPopOutChildThread={handlePopOutChildThread}
        onSelectMode={(nextMode) => {
          setMode(nextMode);
          setFromSwarmRoster(false);
        }}
        onSelectRun={(subagentId) => {
          setSelectedSubagentId(subagentId);
          setBriefOverride(null);
        }}
        onStopActiveRun={() => void handleStopActiveRun()}
        onBackToSwarmRoster={() => {
          setMode('swarm');
          setFromSwarmRoster(false);
        }}
      />

      {mode === 'swarm' && swarmState ? (
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
      ) : activeRun ? (
        <SubagentStepStream
          workspaceId={workspaceId}
          threadId={thread?.id ?? null}
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
          steeringText={steeringText}
          sendingSteering={sendingSteering}
          onSteeringTextChange={setSteeringText}
          onSendSteering={(e) => void handleSendSteering(e)}
        />
      ) : null}
    </div>
  );
};
