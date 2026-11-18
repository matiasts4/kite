import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { ChatItem, SubagentRun } from '../../../types';
import { AgentStatusIndicator } from '../../ui/AgentStatusIndicator';
import { SubagentRoleIcon } from '../../ui/SubagentRoleIcon';
import { ChevronRightIcon } from './ChatIcons';
import { LiveElapsedClock } from './LiveElapsedClock';
import { prefersReducedMotion } from '../../../motion/contract';
import { tweens } from '../../../motion/standard/tokens';
import {
  formatShortModelLabel,
  getActiveSubagentInspection,
  openSubagentInRightDock,
  SUBAGENT_INSPECTION_CHANGE_EVENT,
  type OpenRightDockSubagentDetail,
} from '../../../lib/subagentNav';
import {
  dedupeSubagentItems,
  dedupeSubagentRuns,
  extractFailureSummary,
  humanizeActivityText,
  isItemBlocked,
  isItemFailed,
  isItemRunning,
  isRawDispatchCommand,
  matchSubagentRun,
  plainPreviewLine,
} from './subagentRunHelpers';

export { dedupeSubagentItems, dedupeSubagentRuns, plainPreviewLine };

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
  const isBlocked = isItemBlocked(item, run);
  const isRunning = !isBlocked && isItemRunning(item, run);
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
  const meaningfulRunSteps = (run?.items ?? []).filter(
    (it) => it.kind === 'tool' || it.kind === 'command' || it.kind === 'reasoning',
  ).length;
  const stepCount = Math.max(run?.stepCount ?? 0, meta?.stepCount ?? 0, meaningfulRunSteps);
  const promptExcerpt = (run?.prompt || meta?.prompt || '').trim();
  const safeDetail = isRawDispatchCommand(item.detail) ? '' : item.detail || '';
  const safeActivity = isRawDispatchCommand(run?.latestActivity || meta?.latestActivity)
    ? ''
    : humanizeActivityText(run?.latestActivity || meta?.latestActivity);
  const secondaryRaw = isFailed
    ? safeActivity ||
      extractFailureSummary(item.text) ||
      safeDetail ||
      promptExcerpt ||
      ''
    : safeActivity || safeDetail || promptExcerpt || '';
  const secondaryLine = plainPreviewLine(humanizeActivityText(secondaryRaw));
  const showWorkspacePill = Boolean(workspaceMode && workspaceMode !== 'inherit');

  const statusClass = isBlocked
    ? 'chat-subagent-card--waiting'
    : isRunning
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
          <SubagentRoleIcon
            typeName={run?.typeName ?? meta?.typeName}
            role={role}
            status={
              isBlocked
                ? 'waiting'
                : isRunning
                  ? 'running'
                  : isFailed
                    ? 'failed'
                    : 'completed'
            }
            size={14}
          />
        </span>
        <span className="chat-subagent-card__title">{role}</span>
        {modelLabel ? (
          <span className="chat-subagent-card__pill chat-subagent-card__pill--model">
            {modelLabel}
          </span>
        ) : null}
        {showWorkspacePill && workspaceMode ? (
          <span className={`chat-subagent-card__pill chat-subagent-card__pill--ws-${workspaceMode}`}>
            {workspaceMode}
          </span>
        ) : null}
        <span className="chat-subagent-card__spacer" />
        <span className="chat-subagent-card__telemetry">
          {isBlocked ? (
            <span className="chat-subagent-card__state chat-subagent-card__state--waiting">
              <AgentStatusIndicator status="waiting" size={12} />
              <span>Waiting</span>
            </span>
          ) : isRunning ? (
            <>
              <AgentStatusIndicator status="running" size={13} />
              <LiveElapsedClock
                className="chat-subagent-card__clock"
                running={true}
                startedAtUnixMs={startedAt}
                format="clock"
                idleLabel=""
              />
            </>
          ) : isFailed ? (
            <span className="chat-subagent-card__state chat-subagent-card__state--failed">
              <AgentStatusIndicator
                status={rawStatus === 'cancelled' || rawStatus === 'killed' ? 'killed' : 'failed'}
                size={12}
              />
              <span>{rawStatus === 'cancelled' || rawStatus === 'killed' ? 'Stopped' : 'Failed'}</span>
            </span>
          ) : (
            <span className="chat-subagent-card__state chat-subagent-card__state--done">
              <AgentStatusIndicator status="completed" size={12} />
              <LiveElapsedClock
                running={false}
                startedAtUnixMs={startedAt}
                completedAtUnixMs={run?.completedAtUnixMs}
                durationSeconds={item.durationSeconds}
                format="duration"
                idleLabel="Done"
              />
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

export const SubagentGroupRow: React.FC<{
  items: ChatItem[];
  threadId?: string;
  workspaceId?: string | null;
  subagentRuns?: SubagentRun[] | null;
  enterFor?: (id: string) => boolean;
}> = ({ items, threadId, workspaceId = null, subagentRuns = null, enterFor }) => {
  const dedupedRuns = dedupeSubagentRuns(subagentRuns);
  const dedupedItems = dedupeSubagentItems(items);
  const resolvedRuns = dedupedItems.map((it) => matchSubagentRun(it, dedupedRuns));
  const runningCount = dedupedItems.filter((it, idx) => isItemRunning(it, resolvedRuns[idx])).length;
  const blockedCount = dedupedItems.filter((it, idx) => isItemBlocked(it, resolvedRuns[idx])).length;
  const failedCount = dedupedItems.filter((it, idx) => isItemFailed(it, resolvedRuns[idx])).length;
  const anyActiveOrBlocked = runningCount > 0 || blockedCount > 0;
  const anyRunning = runningCount > 0;
  const [expanded, setExpanded] = useState(anyActiveOrBlocked);

  useEffect(() => {
    if (anyActiveOrBlocked) {
      setExpanded(true);
    }
  }, [anyActiveOrBlocked]);

  if (dedupedItems.length === 1) {
    const single = dedupedItems[0];
    return (
      <SubagentActivityCard
        item={single}
        threadId={threadId}
        workspaceId={workspaceId}
        run={resolvedRuns[0]}
        enter={enterFor?.(single.id) ?? false}
      />
    );
  }

  const title = anyRunning
    ? `${runningCount} subagent${runningCount === 1 ? '' : 's'} running`
    : `Started ${dedupedItems.length} subagents`;

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
          <SubagentRoleIcon
            typeName="orchestrator"
            role={title}
            status={
              anyRunning
                ? 'running'
                : blockedCount > 0
                  ? 'waiting'
                  : failedCount > 0
                    ? 'failed'
                    : 'completed'
            }
            size={14}
          />
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
        <span className="chat-subagent-card__steps">{dedupedItems.length} total</span>
        {anyRunning ? (
          <AgentStatusIndicator status="running" size={13} />
        ) : blockedCount > 0 ? (
          <AgentStatusIndicator status="waiting" size={13} />
        ) : null}
        <span
          aria-hidden="true"
          className={`chat-work-entry__chevron ${expanded ? 'chat-work-entry__chevron--open' : ''}`}
        >
          <ChevronRightIcon size={12} />
        </span>
      </button>

      {expanded && (
        <div className="chat-subagent-group__items">
          {dedupedItems.map((item, idx) => (
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
