import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { ChatItem, SubagentRun } from '../../../types';
import { BotIcon, CheckIcon, ChevronRightIcon, CloseIcon } from './ChatIcons';
import { formatDurationLabel, formatWorkingClock } from './activityPresentation';
import { prefersReducedMotion } from '../../../motion/contract';
import { tweens } from '../../../motion/standard/tokens';
import {
  formatShortModelLabel,
  getActiveSubagentInspection,
  openSubagentInRightDock,
  SUBAGENT_INSPECTION_CHANGE_EVENT,
  type OpenRightDockSubagentDetail,
} from '../../../lib/subagentNav';

export interface SubagentActivityCardProps {
  item: ChatItem;
  threadId?: string;
  workspaceId?: string | null;
  run?: SubagentRun | null;
  enter?: boolean;
}

function useActiveInspection(): OpenRightDockSubagentDetail | null {
  const [active, setActive] = useState<OpenRightDockSubagentDetail | null>(() =>
    getActiveSubagentInspection(),
  );
  useEffect(() => {
    const handler = (ev: Event) => {
      setActive((ev as CustomEvent<OpenRightDockSubagentDetail | null>).detail ?? null);
    };
    window.addEventListener(SUBAGENT_INSPECTION_CHANGE_EVENT, handler);
    return () => window.removeEventListener(SUBAGENT_INSPECTION_CHANGE_EVENT, handler);
  }, []);
  return active;
}

function extractFailureSummary(text?: string | null): string {
  const raw = (text ?? '').trim();
  if (!raw) return '';
  for (const line of [...raw.split(/\r?\n/)].reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown; reason?: unknown };
        const msg = parsed.error ?? parsed.message ?? parsed.reason;
        if (typeof msg === 'string' && msg.trim()) {
          return msg.trim();
        }
      } catch {
        // Ignore malformed JSON fragments and fall back to plain text.
      }
    }
  }
  return raw;
}

function isItemRunning(item: ChatItem, run?: SubagentRun | null): boolean {
  const rawStatus = (run?.status || item.subagentMeta?.status || item.status || 'running').toLowerCase();
  return (
    Boolean(item.streaming) ||
    rawStatus === 'running' ||
    rawStatus === 'inprogress' ||
    rawStatus === 'in_progress' ||
    rawStatus === 'pending'
  );
}

function isItemFailed(item: ChatItem, run?: SubagentRun | null): boolean {
  const rawStatus = (run?.status || item.subagentMeta?.status || item.status || '').toLowerCase();
  return rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'killed' || rawStatus === 'cancelled';
}

export const SubagentActivityCard: React.FC<SubagentActivityCardProps> = ({
  item,
  threadId,
  workspaceId = null,
  run = null,
  enter = false,
}) => {
  const meta = item.subagentMeta;
  const subagentId = run?.subagentId || meta?.subagentId || item.id;
  const childThreadId = run?.childThreadId ?? meta?.childThreadId ?? null;
  const role = run?.role || meta?.role || item.title || 'Subagent';
  const modelLabel = formatShortModelLabel(run?.model ?? meta?.model, run?.provider ?? meta?.provider);
  const workspaceMode = run?.workspaceMode ?? meta?.workspaceMode ?? null;
  const rawStatus = (run?.status || meta?.status || item.status || 'running').toLowerCase();
  const isRunning = isItemRunning(item, run);
  const isFailed = isItemFailed(item, run);
  const isBacked = Boolean(
    childThreadId ||
      run?.transcriptUri ||
      meta?.transcriptUri ||
      (run?.items?.length ?? 0) > 0,
  );
  const isInspectable = Boolean(threadId) && isBacked;
  const activeInspection = useActiveInspection();
  const isInspected = Boolean(
    isInspectable &&
      activeInspection &&
      activeInspection.mode !== 'swarm' &&
      activeInspection.threadId === threadId &&
      ((activeInspection.subagentId && activeInspection.subagentId === subagentId) ||
        (childThreadId && activeInspection.childThreadId === childThreadId)),
  );

  const startedAt = run?.startedAtUnixMs || item.createdAtUnixMs || 0;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const elapsedSeconds =
    !isRunning && typeof item.durationSeconds === 'number' && item.durationSeconds > 0
      ? item.durationSeconds
      : !isRunning && run?.completedAtUnixMs && startedAt > 0
        ? Math.max(0, (run.completedAtUnixMs - startedAt) / 1000)
        : startedAt > 0
          ? Math.max(0, (nowMs - startedAt) / 1000)
          : 0;

  const stepCount = Math.max(run?.stepCount ?? 0, meta?.stepCount ?? 0, run?.items?.length ?? 0);
  const promptExcerpt = (run?.prompt || meta?.prompt || '').trim();
  const secondaryRaw = isFailed
    ? run?.latestActivity ||
      meta?.latestActivity ||
      extractFailureSummary(item.text) ||
      item.detail ||
      ''
    : run?.latestActivity || meta?.latestActivity || item.detail || '';
  const secondaryLine = secondaryRaw.trim();
  const inlineSummary = promptExcerpt && promptExcerpt !== secondaryLine ? promptExcerpt : '';

  const statusClass = isRunning
    ? 'chat-subagent-card--running'
    : isFailed
      ? 'chat-subagent-card--failed'
      : 'chat-subagent-card--completed';

  const handleOpen = () => {
    if (!isInspectable || !threadId) return;
    openSubagentInRightDock({
      threadId,
      subagentId,
      childThreadId,
      mode: 'subagent',
      workspaceId,
    });
  };

  const content = (
    <>
      <div className="chat-subagent-card__header">
        <span aria-hidden="true" className="chat-subagent-card__icon">
          {isFailed ? (
            <CloseIcon size={13} />
          ) : !isRunning ? (
            <CheckIcon size={13} />
          ) : (
            <BotIcon size={14} />
          )}
        </span>
        <span className="chat-subagent-card__title">{role}</span>
        {inlineSummary ? (
          <span className="chat-subagent-card__summary">{inlineSummary}</span>
        ) : null}
        {modelLabel ? (
          <span className="chat-subagent-card__pill chat-subagent-card__pill--model">
            {modelLabel}
          </span>
        ) : null}
        {workspaceMode ? (
          <span className={`chat-subagent-card__pill chat-subagent-card__pill--ws-${workspaceMode}`}>
            {workspaceMode}
          </span>
        ) : null}
        <span className="chat-subagent-card__spacer" />
        <span className="chat-subagent-card__telemetry">
          {isRunning ? (
            <>
              <span aria-hidden="true" className="chat-working-pulse" />
              <span className="chat-subagent-card__clock">
                {startedAt > 0 ? formatWorkingClock(elapsedSeconds) : 'Live'}
              </span>
            </>
          ) : isFailed ? (
            <span className="chat-subagent-card__state chat-subagent-card__state--failed">
              <span>{rawStatus === 'cancelled' || rawStatus === 'killed' ? 'Stopped' : 'Failed'}</span>
            </span>
          ) : (
            <span className="chat-subagent-card__state chat-subagent-card__state--done">
              <span>
                {elapsedSeconds > 0 ? formatDurationLabel(elapsedSeconds) : 'Done'}
              </span>
            </span>
          )}
          {stepCount > 0 ? (
            <span className="chat-subagent-card__steps">
              {stepCount} {stepCount === 1 ? 'step' : 'steps'}
            </span>
          ) : null}
          {isInspectable ? (
            <span className="chat-subagent-card__chevron" aria-hidden="true">
              <ChevronRightIcon size={12} />
            </span>
          ) : null}
        </span>
      </div>

      {secondaryLine && secondaryLine !== role ? (
        <div className="chat-subagent-card__body">
          <p className={`chat-subagent-card__preview ${isRunning ? 'live-tool-shine' : ''}`}>
            {secondaryLine}
          </p>
        </div>
      ) : null}
    </>
  );

  const cardClass = [
    'chat-subagent-card',
    statusClass,
    isInspected ? 'chat-subagent-card--active' : '',
    !isInspectable ? 'chat-subagent-card--static' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <motion.div
      className="chat-subagent-card-wrap"
      initial={enter && !prefersReducedMotion() ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={tweens.reveal}
    >
      {isInspectable ? (
        <button
          type="button"
          className={cardClass}
          data-subagent-id={subagentId}
          onClick={handleOpen}
          aria-label={`Inspect subagent ${role}`}
        >
          {content}
        </button>
      ) : (
        <div className={cardClass} data-subagent-id={subagentId}>
          {content}
        </div>
      )}
    </motion.div>
  );
};

function matchSubagentRun(item: ChatItem, subagentRuns?: SubagentRun[] | null): SubagentRun | null {
  if (!subagentRuns?.length || !item.subagentMeta) return null;
  const sid = item.subagentMeta.subagentId;
  const ctid = item.subagentMeta.childThreadId;
  return (
    subagentRuns.find(
      (r) =>
        (sid && (r.subagentId === sid || r.parentToolCallId === item.id)) ||
        (ctid && r.childThreadId === ctid),
    ) ?? null
  );
}

export const SubagentGroupRow: React.FC<{
  items: ChatItem[];
  threadId?: string;
  workspaceId?: string | null;
  subagentRuns?: SubagentRun[] | null;
  enterFor?: (id: string) => boolean;
}> = ({ items, threadId, workspaceId = null, subagentRuns = null, enterFor }) => {
  const resolvedRuns = items.map((it) => matchSubagentRun(it, subagentRuns));
  const runningCount = items.filter((it, idx) => isItemRunning(it, resolvedRuns[idx])).length;
  const failedCount = items.filter((it, idx) => isItemFailed(it, resolvedRuns[idx])).length;
  const anyRunning = runningCount > 0;
  const [expanded, setExpanded] = useState(anyRunning);

  useEffect(() => {
    if (anyRunning) {
      setExpanded(true);
    }
  }, [anyRunning]);

  const title = anyRunning
    ? `${runningCount} subagent${runningCount === 1 ? '' : 's'} running`
    : `Started ${items.length} subagents`;

  return (
    <div
      className={`chat-subagent-group ${expanded ? 'chat-subagent-group--expanded' : ''}`}
      data-testid="subagent-disclosure-group"
    >
      <button
        type="button"
        className="chat-subagent-group__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span aria-hidden="true" className="chat-subagent-card__icon">
          <BotIcon size={14} />
        </span>
        <span className={`chat-subagent-group__label ${anyRunning ? 'live-tool-shine' : ''}`}>
          {title}
        </span>
        {failedCount > 0 ? (
          <span className="chat-subagent-card__state chat-subagent-card__state--failed">
            {failedCount} failed
          </span>
        ) : null}
        <span className="chat-subagent-card__spacer" />
        <span className="chat-subagent-card__steps">{items.length} total</span>
        {anyRunning ? <span aria-hidden="true" className="chat-working-pulse" /> : null}
        <span
          aria-hidden="true"
          className={`chat-work-entry__chevron ${expanded ? 'chat-work-entry__chevron--open' : ''}`}
        >
          <ChevronRightIcon size={12} />
        </span>
      </button>

      {expanded && (
        <div className="chat-subagent-group__items">
          {items.map((item, idx) => (
            <SubagentActivityCard
              key={item.id}
              item={item}
              threadId={threadId}
              workspaceId={workspaceId}
              run={resolvedRuns[idx]}
              enter={enterFor?.(item.id) ?? false}
            />
          ))}
        </div>
      )}
    </div>
  );
};
