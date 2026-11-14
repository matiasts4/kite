import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  getThreadSubagentDetail,
  getThreadSwarmState,
  loadChatThread,
  respondChatApproval,
  sendSubagentMessage,
  stopSubagentRun,
} from '../../../lib/ipc/chat';
import type { OpenRightDockSubagentDetail } from '../../../lib/subagentNav';
import { setActiveSubagentInspection } from '../../../lib/subagentNav';
import { tweens } from '../../../motion/standard/tokens';
import type { ChatItem, SwarmMember } from '../../../types';
import { ActivityGlyph } from '../chat/activityGlyph';
import { ChatApprovalCard } from '../chat/ChatApprovalCard';
import { ChatWorkEntry, ChatWorkGroup, groupTranscriptRows } from '../chat/ChatItemRow';
import { LiveElapsedClock } from '../chat/LiveElapsedClock';
import { MarkdownMessage } from '../chat/MarkdownMessage';
import { dedupeSubagentRuns, SubagentGroupRow } from '../chat/SubagentActivityCard';
import {
  applySubagentEvent,
  countRunningSubagents,
  type ChatSubagentEventPayload,
} from '../chat/hooks/useSubagentEvents';
import type { ApprovalRequest, ExtendedChatThread } from '../chat/types';
import { SwarmBoardInspector, formatInspectorModelName } from './SwarmBoardInspector';
import './subagents.css';

export interface SubagentInspectorViewProps {
  workspaceId: string | null;
  selectedThreadId?: string | null;
  requestedTarget?: OpenRightDockSubagentDetail | null;
}

type InspectorMode = 'subagent' | 'swarm';

function isRunBlocked(status?: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'waiting' || s === 'needsinput' || s === 'blocked';
}

function isRunActive(status?: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'running' || s === 'queued' || s === 'pending' || isRunBlocked(s);
}

function runStatusDotClass(status?: string | null): string {
  const s = (status ?? '').toLowerCase();
  if (isRunBlocked(s)) return 'subagent-dot--waiting';
  if (isRunActive(s)) return 'subagent-dot--running';
  if (s === 'completed' || s === 'done' || s === 'ok') return 'subagent-dot--completed';
  if (s === 'failed' || s === 'error' || s === 'killed') return 'subagent-dot--failed';
  return '';
}

function settledPrefixLabel(status?: string | null): string {
  const s = (status ?? 'completed').toLowerCase();
  if (s === 'failed' || s === 'error') return 'Failed';
  if (s === 'killed' || s === 'cancelled') return 'Killed';
  if (s === 'completed' || s === 'done' || s === 'ok') return 'Completed';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function filterInspectorSteps(
  items?: ChatItem[] | null,
  initialPrompt?: string | null,
): ChatItem[] {
  if (!items || items.length === 0) return [];
  const promptTrim = (initialPrompt ?? '').trim();
  return items.filter((item, idx) => {
    const rawKind = String(item.kind ?? '');
    if (rawKind === 'notice' || rawKind === 'note') return false;
    if (item.kind === 'user') {
      const text = (item.text ?? '').trim();
      if (
        idx === 0 ||
        text.startsWith('[Subagent Role:') ||
        (promptTrim.length > 0 && text === promptTrim)
      ) {
        return false;
      }
    }
    if (item.kind === 'reasoning' && !(item.text ?? '').trim()) return false;
    return true;
  });
}

export const SubagentInspectorView: React.FC<SubagentInspectorViewProps> = ({
  workspaceId,
  selectedThreadId = null,
  requestedTarget = null,
}) => {
  const reduceMotion = useReducedMotion();
  const activeThreadId = requestedTarget?.threadId ?? selectedThreadId;

  const [thread, setThread] = useState<ExtendedChatThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<InspectorMode>('subagent');
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [fromSwarmRoster, setFromSwarmRoster] = useState(false);
  const [briefOverride, setBriefOverride] = useState<{ runId: string; expanded: boolean } | null>(null);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const [childApproval, setChildApproval] = useState<ApprovalRequest | null>(null);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [steeringText, setSteeringText] = useState('');
  const [sendingSteering, setSendingSteering] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const streamRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const seenStepIdsRef = useRef<Set<string>>(new Set());
  const hydratedKeyRef = useRef<string | null>(null);

  // Apply explicit navigation requests immediately
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

  // Hydrate active thread subagents + swarm from backend
  useEffect(() => {
    if (!activeThreadId) {
      setThread(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadChatThread(activeThreadId)
      .then((loaded) => {
        if (cancelled || !loaded) return;
        setThread(loaded);
        if (!requestedTarget && !loaded.subagentRuns?.length && loaded.swarmState) {
          setMode('swarm');
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

  // Live updates via Tauri chat-subagent-event and chat-swarm-event
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

  const runs = useMemo(
    () => dedupeSubagentRuns(thread?.subagentRuns),
    [thread?.subagentRuns],
  );
  const swarmState = thread?.swarmState ?? null;

  // Keep dock tab badge synced whenever inspected thread updates
  useEffect(() => {
    if (!thread) return;
    window.dispatchEvent(
      new CustomEvent('kite:subagent-activity-count', {
        detail: { threadId: thread.id, count: countRunningSubagents(thread) },
      }),
    );
  }, [thread]);

  // Ensure a valid selected subagent exists when runs arrive
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
    return runs[0];
  }, [runs, selectedSubagentId]);

  const visibleSteps = useMemo(
    () => filterInspectorSteps(activeRun?.items, activeRun?.prompt),
    [activeRun?.items, activeRun?.prompt],
  );

  const groupedRows = useMemo(() => groupTranscriptRows(visibleSteps), [visibleSteps]);

  const briefExpanded =
    briefOverride && activeRun && briefOverride.runId === activeRun.subagentId
      ? briefOverride.expanded
      : visibleSteps.length === 0;

  useEffect(() => {
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
    }
  }, [thread?.id, mode, swarmState?.swarmId, activeRun?.subagentId, activeRun?.childThreadId, workspaceId]);

  // Hydrate missing steps on demand via getThreadSubagentDetail without stalling after step 1
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

  // Hydrate inline child pendingApproval when the active child run is waiting for approval
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

  const activeRunRunning = activeRun ? isRunActive(activeRun.status) : false;

  // Auto-scroll to latest step unless manually scrolled up
  const stepCount = visibleSteps.length;
  useEffect(() => {
    if (mode !== 'subagent' || !atBottomRef.current) return;
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [mode, activeRun?.subagentId, stepCount]);

  // Mark newly observed steps so only new steps play entrance reveal
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
    [activeRun?.childThreadId, activeRun?.subagentId, thread, resolvingApproval],
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
      <div className="subagent-inspector__header">
        <div className="subagent-inspector__top-row">
          {thread && (
            <button
              type="button"
              className="subagent-inspector__parent-link"
              onClick={handleJumpToParent}
              title={`Focus main thread: ${thread.title || thread.id}`}
            >
              <span>← Main Thread: {thread.title || 'Untitled Thread'}</span>
            </button>
          )}

          <div className="subagent-inspector__top-actions">
            {mode === 'subagent' && activeRun?.childThreadId && (
              <button
                type="button"
                className="subagent-inspector__popout-btn"
                onClick={handlePopOutChildThread}
                aria-label="Open subagent thread in main pane"
                title="Open subagent conversation in main pane"
              >
                Open thread
              </button>
            )}

            {hasSwarm && (
              <div
                className="subagent-inspector__segmented"
                role="tablist"
                aria-label="Inspector mode"
              >
                {hasRuns && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'subagent'}
                    className={`subagent-inspector__segment-btn${mode === 'subagent' ? ' subagent-inspector__segment-btn--active' : ''}`}
                    onClick={() => {
                      setMode('subagent');
                      setFromSwarmRoster(false);
                    }}
                  >
                    Subagent
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'swarm'}
                  className={`subagent-inspector__segment-btn${mode === 'swarm' ? ' subagent-inspector__segment-btn--active' : ''}`}
                  onClick={() => {
                    setMode('swarm');
                    setFromSwarmRoster(false);
                  }}
                >
                  Swarm Board
                </button>
              </div>
            )}
          </div>
        </div>

        {mode === 'subagent' && activeRun && (
          <div className="subagent-inspector__identity-row">
            <div className="subagent-inspector__meta-title-row">
              <div className="subagent-inspector__role">
                <span className={`subagent-dot ${runStatusDotClass(activeRun.status)}`} />
                <span>{activeRun.role || 'Subagent'}</span>
                {activeRun.typeName &&
                  activeRun.typeName.toLowerCase() !== (activeRun.provider ?? '').toLowerCase() && (
                    <span className="subagent-inspector__type-label">{activeRun.typeName}</span>
                  )}
              </div>
              <div className="subagent-inspector__status-actions">
                {isRunBlocked(activeRun.status) ? (
                  <span className="subagent-inspector__status-text subagent-inspector__status-text--waiting">
                    Waiting for approval
                  </span>
                ) : isRunActive(activeRun.status) ? (
                  <LiveElapsedClock
                    className="subagent-inspector__status-text"
                    running={true}
                    startedAtUnixMs={activeRun.startedAtUnixMs}
                    prefix="Working · "
                    format="clock"
                    idleLabel="Working…"
                  />
                ) : (
                  <LiveElapsedClock
                    className="subagent-inspector__status-text"
                    running={false}
                    startedAtUnixMs={activeRun.startedAtUnixMs}
                    completedAtUnixMs={activeRun.updatedAtUnixMs ?? null}
                    prefix={`${settledPrefixLabel(activeRun.status)} · `}
                    format="duration"
                    idleLabel={settledPrefixLabel(activeRun.status)}
                  />
                )}
                {isRunActive(activeRun.status) && (
                  <button
                    type="button"
                    className="subagent-stop-btn"
                    aria-label="Stop subagent"
                    disabled={stoppingRun}
                    onClick={() => void handleStopActiveRun()}
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>

            <div className="subagent-inspector__meta-subtitle">
              <span
                data-testid="subagent-model-hierarchy"
                aria-label="Main to Subagent model hierarchy"
              >
                Main: {parentModelLabel} ➔ Subagent:{' '}
                {formatInspectorModelName(activeRun.model, activeRun.provider)}
              </span>
              {activeRun.workspaceMode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{activeRun.workspaceMode}</span>
                </>
              )}
            </div>
          </div>
        )}

        {mode === 'subagent' && hasRuns && (runs.length > 1 || (fromSwarmRoster && hasSwarm)) && (
          <div className="subagent-inspector__selector-strip" role="navigation" aria-label="Subagent selector">
            {fromSwarmRoster && hasSwarm && (
              <button
                type="button"
                className="subagent-inspector__back-btn"
                onClick={() => {
                  setMode('swarm');
                  setFromSwarmRoster(false);
                }}
              >
                ← Back to Swarm Roster
              </button>
            )}
            {runs.length > 1 &&
              runs.map((run) => {
                const selected = activeRun?.subagentId === run.subagentId;
                const shortModel = formatInspectorModelName(run.model, run.provider);
                return (
                  <button
                    key={run.subagentId}
                    type="button"
                    className={`subagent-inspector__selector-pill${selected ? ' subagent-inspector__selector-pill--active' : ''}`}
                    onClick={() => {
                      setSelectedSubagentId(run.subagentId);
                      setBriefOverride(null);
                    }}
                  >
                    <span className={`subagent-dot ${runStatusDotClass(run.status)}`} />
                    <span>{run.role || run.typeName || run.subagentId}</span>
                    <span className="subagent-badge">{shortModel}</span>
                  </button>
                );
              })}
          </div>
        )}
      </div>

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
        <>

          {activeRun.status?.toLowerCase() === 'failed' && (
            <div
              className="subagent-inspector__failure-card"
              data-testid="subagent-failure-card"
              role="status"
            >
              <strong>Subagent execution failed</strong>
              <span>
                {activeRun.latestActivity ||
                  'The subagent exited with an error. Check provider credentials, model availability, or CLI arguments.'}
              </span>
            </div>
          )}

          {activeRun.prompt && (
            <div className="subagent-brief-card">
              <button
                type="button"
                className="subagent-brief-card__toggle"
                aria-expanded={briefExpanded}
                onClick={() =>
                  setBriefOverride({ runId: activeRun.subagentId, expanded: !briefExpanded })
                }
              >
                <span>Task Brief</span>
                <span>{briefExpanded ? 'Collapse' : 'Expand'}</span>
              </button>
              <div
                className={`subagent-brief-card__body${!briefExpanded ? ' subagent-brief-card__body--clamped' : ''}`}
              >
                {activeRun.prompt}
              </div>
            </div>
          )}

          <div className="subagent-inspector__stream-wrap">
            <div
              ref={streamRef}
              className="subagent-inspector__stream"
              onScroll={(e) => {
                const el = e.currentTarget;
                const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
                atBottomRef.current = nearBottom;
                setAutoScrollPaused(!nearBottom);
              }}
            >
              {visibleSteps.length === 0 ? (
                <div className="subagent-inspector__empty">
                  {activeRun.status?.toLowerCase() === 'failed' ? (
                    <>
                      <strong>No steps captured before failure</strong>
                      <span>
                        {activeRun.latestActivity || 'The subagent failed before producing transcript items.'}
                      </span>
                    </>
                  ) : !isRunActive(activeRun.status) ? (
                    <>
                      <strong>
                        {activeRun.status?.toLowerCase() === 'killed' ? 'Subagent stopped' : 'Subagent settled'}
                      </strong>
                      <span>
                        {activeRun.latestActivity || 'No individual step items were recorded for this run.'}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>Waiting for subagent steps…</strong>
                      <span>{activeRun.latestActivity || 'Starting subagent execution.'}</span>
                    </>
                  )}
                </div>
              ) : (
                groupedRows.map((row) => {
                  if (row.kind === 'work') {
                    const isNewGroup = row.items.some((it) => !seenStepIdsRef.current.has(it.id));
                    return (
                      <motion.div
                        key={row.id}
                        className="subagent-inspector__step subagent-inspector__step--work"
                        initial={isNewGroup && !reduceMotion ? { opacity: 0, y: 4 } : false}
                        animate={{ opacity: 1, y: 0 }}
                        transition={reduceMotion ? tweens.instant : tweens.reveal}
                      >
                        <ChatWorkGroup
                          items={row.items}
                          running={activeRunRunning}
                          enterFor={(id) => !seenStepIdsRef.current.has(id)}
                        />
                      </motion.div>
                    );
                  }
                  if (row.kind === 'subagentGroup') {
                    return (
                      <SubagentGroupRow
                        key={row.id}
                        items={row.items}
                        threadId={activeRun.childThreadId ?? thread?.id}
                        workspaceId={workspaceId}
                        enterFor={(id) => !seenStepIdsRef.current.has(id)}
                      />
                    );
                  }
                  const step = row.item;
                  const isNew = !seenStepIdsRef.current.has(step.id);
                  return (
                    <motion.div
                      key={step.id}
                      className={`subagent-inspector__step subagent-inspector__step--${step.kind}`}
                      initial={isNew && !reduceMotion ? { opacity: 0, y: 4 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={reduceMotion ? tweens.instant : tweens.reveal}
                    >
                      {step.kind === 'assistant' ? (
                        <div className="subagent-inspector__response">
                          <MarkdownMessage
                            text={step.text}
                            workspaceId={workspaceId}
                          />
                        </div>
                      ) : step.kind === 'user' ? (
                        <div className="subagent-inspector__user-msg">
                          <MarkdownMessage
                            text={step.text}
                            workspaceId={workspaceId}
                          />
                        </div>
                      ) : step.kind === 'reasoning' ? (
                        <div className="subagent-inspector__thought">
                          <span className="subagent-inspector__thought-head">
                            <ActivityGlyph item={step} size={14} />
                            <span>Thought</span>
                          </span>
                          <p className="subagent-inspector__thought-body">{step.text}</p>
                        </div>
                      ) : (
                        <ChatWorkEntry
                          item={step}
                          running={isRunActive(step.status) || Boolean(step.streaming)}
                          enter={isNew}
                        />
                      )}
                    </motion.div>
                  );
                })
              )}
              {childApproval && (
                <div className="subagent-inspector__approval-wrap" data-testid="subagent-child-approval">
                  <ChatApprovalCard
                    approval={childApproval}
                    busy={resolvingApproval}
                    onDecision={(decision, reqId) => void handleChildApprovalDecision(decision, reqId)}
                  />
                </div>
              )}
            </div>

            {autoScrollPaused && (
              <button
                type="button"
                className="subagent-inspector__jump-latest"
                onClick={() => {
                  atBottomRef.current = true;
                  setAutoScrollPaused(false);
                  if (streamRef.current) {
                    streamRef.current.scrollTop = streamRef.current.scrollHeight;
                  }
                }}
              >
                Jump to latest
              </button>
            )}
          </div>

          {actionError && (
            <div className="subagent-inspector__error" role="alert">
              {actionError}
            </div>
          )}

          <form
            className="subagent-inspector__composer"
            data-testid="subagent-steering-form"
            onSubmit={(e) => void handleSendSteering(e)}
          >
            <input
              type="text"
              className="subagent-inspector__composer-input"
              value={steeringText}
              placeholder={
                activeRun.childThreadId
                  ? `Message ${activeRun.role || 'subagent'}…`
                  : 'Follow-up steering requires a child thread subagent'
              }
              disabled={!activeRun.childThreadId || sendingSteering}
              onChange={(e) => setSteeringText(e.target.value)}
            />
            <button
              type="submit"
              className="subagent-inspector__composer-submit"
              disabled={!activeRun.childThreadId || sendingSteering || !steeringText.trim()}
            >
              Send
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
};
