import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  getThreadSubagentDetail,
  getThreadSwarmState,
  loadChatThread,
} from '../../../lib/ipc/chat';
import type { OpenRightDockSubagentDetail } from '../../../lib/subagentNav';
import { tweens } from '../../../motion/standard/tokens';
import type { SubagentRun, SwarmMember } from '../../../types';
import { ChatWorkEntry } from '../chat/ChatItemRow';
import { MarkdownMessage } from '../chat/MarkdownMessage';
import { formatDurationLabel, formatWorkingClock } from '../chat/activityPresentation';
import {
  applySubagentEvent,
  countRunningSubagents,
  type ChatSubagentEventPayload,
} from '../chat/hooks/useSubagentEvents';
import type { ExtendedChatThread } from '../chat/types';
import { SwarmBoardInspector, formatInspectorModelName } from './SwarmBoardInspector';
import './subagents.css';

export interface SubagentInspectorViewProps {
  workspaceId: string | null;
  selectedThreadId?: string | null;
  requestedTarget?: OpenRightDockSubagentDetail | null;
}

type InspectorMode = 'subagent' | 'swarm';

function isRunActive(status?: string | null): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'running' || s === 'queued' || s === 'pending' || s === 'waiting';
}

function runStatusDotClass(status?: string | null): string {
  const s = (status ?? '').toLowerCase();
  if (isRunActive(s)) return 'subagent-dot--running';
  if (s === 'completed' || s === 'done' || s === 'ok') return 'subagent-dot--completed';
  if (s === 'failed' || s === 'error' || s === 'killed') return 'subagent-dot--failed';
  return '';
}

function runStatusLabel(run: SubagentRun, nowUnixMs: number): string {
  if (isRunActive(run.status)) {
    const startMs = run.startedAtUnixMs ?? nowUnixMs;
    const sec = Math.max(0, Math.floor((nowUnixMs - startMs) / 1000));
    return `Working · ${formatWorkingClock(sec)}`;
  }
  const s = (run.status ?? 'completed').toLowerCase();
  if (run.startedAtUnixMs && run.updatedAtUnixMs && run.updatedAtUnixMs >= run.startedAtUnixMs) {
    const durSec = (run.updatedAtUnixMs - run.startedAtUnixMs) / 1000;
    const prefix = s === 'failed' ? 'Failed' : s === 'killed' ? 'Killed' : 'Completed';
    return `${prefix} · ${formatDurationLabel(durSec)}`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const [nowUnixMs, setNowUnixMs] = useState(() => Date.now());

  const streamRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const seenStepIdsRef = useRef<Set<string>>(new Set());

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
    setBriefExpanded(false);
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
        if (cancelled) return;
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

  // Live updates via Tauri chat-subagent-event
  useEffect(() => {
    if (
      !activeThreadId ||
      typeof window === 'undefined' ||
      !('__TAURI_INTERNALS__' in window)
    ) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<ChatSubagentEventPayload>('chat-subagent-event', (event) => {
          const payload = event.payload;
          if (!payload || payload.threadId !== activeThreadId) return;
          setThread((prev) => (prev ? applySubagentEvent(prev, payload) : prev));
        }),
      )
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeThreadId]);

  const runs = thread?.subagentRuns ?? [];
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

  // Hydrate missing steps on demand via getThreadSubagentDetail / getThreadSwarmState
  useEffect(() => {
    if (!thread || !activeRun) return;
    if ((activeRun.items?.length ?? 0) > 0) return;
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
  }, [thread?.id, activeRun?.subagentId, activeRun?.items?.length]);

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

  // Live clock tick when current subagent is running
  const activeRunRunning = activeRun ? isRunActive(activeRun.status) : false;
  useEffect(() => {
    if (!activeRunRunning) return;
    const id = window.setInterval(() => setNowUnixMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeRunRunning]);

  // Auto-scroll to latest step unless manually scrolled up
  const stepCount = activeRun?.items?.length ?? 0;
  useEffect(() => {
    if (mode !== 'subagent' || !atBottomRef.current) return;
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [mode, activeRun?.subagentId, stepCount]);

  // Mark newly observed steps so only new steps play entrance reveal
  useEffect(() => {
    const items = activeRun?.items ?? [];
    for (const item of items) {
      seenStepIdsRef.current.add(item.id);
    }
  }, [activeRun?.items]);

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
      setBriefExpanded(false);
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

        {mode === 'subagent' && hasRuns && (
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
            {runs.map((run) => {
              const selected = activeRun?.subagentId === run.subagentId;
              const shortModel = formatInspectorModelName(run.model, run.provider);
              return (
                <button
                  key={run.subagentId}
                  type="button"
                  className={`subagent-inspector__selector-pill${selected ? ' subagent-inspector__selector-pill--active' : ''}`}
                  onClick={() => {
                    setSelectedSubagentId(run.subagentId);
                    setBriefExpanded(false);
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
          swarmState={swarmState}
          parentModelLabel={parentModelLabel}
          subagentRuns={runs}
          onInspectWorker={handleInspectWorker}
        />
      ) : activeRun ? (
        <>
          <div className="subagent-inspector__meta-banner">
            <div className="subagent-inspector__meta-title-row">
              <div className="subagent-inspector__role">
                <span className={`subagent-dot ${runStatusDotClass(activeRun.status)}`} />
                <span>{activeRun.role || 'Subagent'}</span>
                {activeRun.typeName && (
                  <span className="subagent-badge">{activeRun.typeName}</span>
                )}
              </div>
              <span className="subagent-badge subagent-badge--status">
                {runStatusLabel(activeRun, nowUnixMs)}
              </span>
            </div>

            <div className="subagent-inspector__meta-badges">
              <span
                className="subagent-badge subagent-badge--hierarchy"
                data-testid="subagent-model-hierarchy"
                aria-label="Main to Subagent model hierarchy"
              >
                Main: {parentModelLabel} ➔ Subagent:{' '}
                {formatInspectorModelName(activeRun.model, activeRun.provider)}
              </span>
              {activeRun.workspaceMode && (
                <span className="subagent-badge">{activeRun.workspaceMode}</span>
              )}
            </div>
          </div>

          {activeRun.prompt && (
            <div className="subagent-brief-card">
              <button
                type="button"
                className="subagent-brief-card__toggle"
                aria-expanded={briefExpanded}
                onClick={() => setBriefExpanded((v) => !v)}
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
              {(activeRun.items ?? []).length === 0 ? (
                <div className="subagent-inspector__empty">
                  <strong>Waiting for subagent steps…</strong>
                  <span>{activeRun.latestActivity || 'Starting subagent execution.'}</span>
                </div>
              ) : (
                (activeRun.items ?? []).map((step) => {
                  const isNew = !seenStepIdsRef.current.has(step.id);
                  const isTextMessage = step.kind === 'assistant' || step.kind === 'user';
                  return (
                    <motion.div
                      key={step.id}
                      className="subagent-inspector__step"
                      initial={isNew && !reduceMotion ? { opacity: 0, y: 4 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={reduceMotion ? tweens.instant : tweens.reveal}
                    >
                      {isTextMessage ? (
                        <MarkdownMessage
                          text={step.text}
                          workspaceId={workspaceId}
                        />
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
        </>
      ) : null}
    </div>
  );
};
