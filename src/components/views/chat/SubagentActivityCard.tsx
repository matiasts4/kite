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
  isSuppressedSubagentNoiseItem,
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

type InspectionSubscriber = (detail: OpenRightDockSubagentDetail | null) => void;
const inspectionSubscribers = new Set<InspectionSubscriber>();
let globalInspectionListenerAttached = false;

function handleGlobalInspectionChange(ev: Event) {
  const detail = (ev as CustomEvent<OpenRightDockSubagentDetail | null>).detail ?? null;
  for (const sub of inspectionSubscribers) {
    sub(detail);
  }
}

function subscribeInspectionStore(sub: InspectionSubscriber): () => void {
  inspectionSubscribers.add(sub);
  if (!globalInspectionListenerAttached && typeof window !== 'undefined') {
    window.addEventListener(SUBAGENT_INSPECTION_CHANGE_EVENT, handleGlobalInspectionChange);
    globalInspectionListenerAttached = true;
  }
  return () => {
    inspectionSubscribers.delete(sub);
    if (
      inspectionSubscribers.size === 0 &&
      globalInspectionListenerAttached &&
      typeof window !== 'undefined'
    ) {
      window.removeEventListener(SUBAGENT_INSPECTION_CHANGE_EVENT, handleGlobalInspectionChange);
      globalInspectionListenerAttached = false;
    }
  };
}

function computeIsInspected(
  activeInspection: OpenRightDockSubagentDetail | null,
  isInspectable: boolean,
  threadId: string | undefined,
  subagentId: string,
  childThreadId: string | null
): boolean {
  return Boolean(
    isInspectable &&
      activeInspection &&
      activeInspection.mode !== 'swarm' &&
      activeInspection.threadId === threadId &&
      ((activeInspection.subagentId && activeInspection.subagentId === subagentId) ||
        (childThreadId && activeInspection.childThreadId === childThreadId))
  );
}

function useIsSubagentInspected(
  isInspectable: boolean,
  threadId: string | undefined,
  subagentId: string,
  childThreadId: string | null
): boolean {
  const [isInspected, setIsInspected] = useState<boolean>(() =>
    computeIsInspected(
      getActiveSubagentInspection(),
      isInspectable,
      threadId,
      subagentId,
      childThreadId
    )
  );
  useEffect(() => {
    setIsInspected(
      computeIsInspected(
        getActiveSubagentInspection(),
        isInspectable,
        threadId,
        subagentId,
        childThreadId
      )
    );
    return subscribeInspectionStore((detail) => {
      const next = computeIsInspected(detail, isInspectable, threadId, subagentId, childThreadId);
      setIsInspected((prev) => (prev === next ? prev : next));
    });
  }, [isInspectable, threadId, subagentId, childThreadId]);
  return isInspected;
}

export function areSubagentRunCardsEqual(
  a?: SubagentRun | null,
  b?: SubagentRun | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return (
    a.subagentId === b.subagentId &&
    a.status === b.status &&
    a.stepCount === b.stepCount &&
    a.latestActivity === b.latestActivity &&
    a.updatedAtUnixMs === b.updatedAtUnixMs &&
    a.completedAtUnixMs === b.completedAtUnixMs &&
    (a.childThreadId ?? null) === (b.childThreadId ?? null) &&
    (a.transcriptUri ?? null) === (b.transcriptUri ?? null) &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.provider ?? null) === (b.provider ?? null) &&
    (a.role ?? null) === (b.role ?? null) &&
    (a.workspaceMode ?? null) === (b.workspaceMode ?? null) &&
    (a.typeName ?? null) === (b.typeName ?? null) &&
    (a.prompt ?? null) === (b.prompt ?? null) &&
    (a.items?.length ?? 0) === (b.items?.length ?? 0)
  );
}

function areSubagentItemsEqual(a: ChatItem, b: ChatItem): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.title !== b.title ||
    a.detail !== b.detail ||
    a.text !== b.text ||
    a.status !== b.status ||
    Boolean(a.streaming) !== Boolean(b.streaming) ||
    a.createdAtUnixMs !== b.createdAtUnixMs
  ) {
    return false;
  }
  const ma = a.subagentMeta;
  const mb = b.subagentMeta;
  if (ma === mb) return true;
  if (!ma || !mb) return false;
  return (
    ma.subagentId === mb.subagentId &&
    ma.status === mb.status &&
    ma.stepCount === mb.stepCount &&
    ma.latestActivity === mb.latestActivity &&
    ma.childThreadId === mb.childThreadId &&
    ma.transcriptUri === mb.transcriptUri &&
    ma.role === mb.role &&
    ma.model === mb.model &&
    ma.provider === mb.provider &&
    ma.workspaceMode === mb.workspaceMode &&
    ma.typeName === mb.typeName &&
    ma.prompt === mb.prompt
  );
}

const SubagentActivityCardInner: React.FC<SubagentActivityCardProps> = ({
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
  const isInspected = useIsSubagentInspected(isInspectable, threadId, subagentId, childThreadId);

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
                durationSeconds={
                  typeof run?.completedAtUnixMs === 'number' &&
                  startedAt > 0 &&
                  run.completedAtUnixMs >= startedAt
                    ? undefined
                    : item.durationSeconds
                }
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

export const SubagentActivityCard = React.memo(
  SubagentActivityCardInner,
  (prev, next) =>
    prev.threadId === next.threadId &&
    prev.workspaceId === next.workspaceId &&
    prev.enter === next.enter &&
    areSubagentItemsEqual(prev.item, next.item) &&
    areSubagentRunCardsEqual(prev.run, next.run)
);
SubagentActivityCard.displayName = 'SubagentActivityCard';

interface SubagentGroupRowProps {
  items: ChatItem[];
  threadId?: string;
  workspaceId?: string | null;
  subagentRuns?: SubagentRun[] | null;
  enterFor?: (id: string) => boolean;
}

function areSubagentGroupRowPropsEqual(
  prev: SubagentGroupRowProps,
  next: SubagentGroupRowProps
): boolean {
  if (
    prev.threadId !== next.threadId ||
    prev.workspaceId !== next.workspaceId ||
    prev.items.length !== next.items.length
  ) {
    return false;
  }
  for (let i = 0; i < next.items.length; i += 1) {
    if (!areSubagentItemsEqual(prev.items[i]!, next.items[i]!)) return false;
  }
  if (prev.subagentRuns === next.subagentRuns) return true;
  const prevDeduped = dedupeSubagentRuns(prev.subagentRuns);
  const nextDeduped = dedupeSubagentRuns(next.subagentRuns);
  const dedupedItems = dedupeSubagentItems(next.items);
  for (const item of dedupedItems) {
    const prevRun = matchSubagentRun(item, prevDeduped);
    const nextRun = matchSubagentRun(item, nextDeduped);
    if (!areSubagentRunCardsEqual(prevRun, nextRun)) return false;
  }
  return true;
}

export interface SubagentFailureDisclosureProps {
  items: ChatItem[];
  runs?: ReadonlyArray<SubagentRun | null>;
  threadId?: string;
  workspaceId?: string | null;
  enterFor?: (id: string) => boolean;
  enter?: boolean;
}

/**
 * Option 1 discreet non-red disclosure for genuine subagent failures in the main
 * timeline. Starts collapsed with muted neutral chrome and expands on click to reveal
 * calm neutral cards with click-to-inspect diagnostics when backed.
 */
export const SubagentFailureDisclosure: React.FC<SubagentFailureDisclosureProps> = React.memo(
  ({ items, runs = [], threadId, workspaceId = null, enterFor, enter = false }) => {
    const [expanded, setExpanded] = useState(false);
    if (items.length === 0) return null;

    const first = items[0]!;
    const firstRun = runs[0] ?? null;
    const firstRole = firstRun?.role || first.subagentMeta?.role || first.title || 'Subagent';
    const firstStatus = (
      firstRun?.status ||
      first.subagentMeta?.status ||
      first.status ||
      'failed'
    ).toLowerCase();
    const isStopped = firstStatus === 'killed' || firstStatus === 'cancelled';

    const label =
      items.length === 1
        ? `${firstRole} · ${isStopped ? 'Stopped' : 'Did not finish'}`
        : `${items.length} subagents did not finish`;

    const totalSteps = items.reduce((acc, it, idx) => {
      const r = runs[idx];
      const steps = Math.max(r?.stepCount ?? 0, it.subagentMeta?.stepCount ?? 0);
      return acc + steps;
    }, 0);

    return (
      <div
        className={`chat-subagent-failed-disclosure ${expanded ? 'chat-subagent-failed-disclosure--expanded' : ''}`}
        data-testid="subagent-failed-disclosure"
      >
        <button
          type="button"
          className="chat-subagent-failed-disclosure__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span aria-hidden="true" className="chat-subagent-failed-disclosure__icon">
            <AgentStatusIndicator status={isStopped ? 'killed' : 'failed'} size={12} />
          </span>
          <span className="chat-subagent-failed-disclosure__label">{label}</span>
          <span className="chat-subagent-card__spacer" />
          {totalSteps > 0 ? (
            <span className="chat-subagent-failed-disclosure__meta">
              {totalSteps} {totalSteps === 1 ? 'step' : 'steps'}
            </span>
          ) : null}
          <span className="chat-subagent-failed-disclosure__meta">
            {expanded ? 'Hide' : 'Details'}
          </span>
          <span
            aria-hidden="true"
            className={`chat-work-entry__chevron ${expanded ? 'chat-work-entry__chevron--open' : ''}`}
          >
            <ChevronRightIcon size={12} />
          </span>
        </button>

        {expanded && (
          <div className="chat-subagent-failed-disclosure__items">
            {items.map((item, idx) => (
              <SubagentActivityCard
                key={item.id}
                item={item}
                threadId={threadId}
                workspaceId={workspaceId}
                run={runs[idx] ?? null}
                enter={enterFor ? enterFor(item.id) : enter}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
SubagentFailureDisclosure.displayName = 'SubagentFailureDisclosure';

export const SubagentGroupRow: React.FC<SubagentGroupRowProps> = React.memo(
  ({ items, threadId, workspaceId = null, subagentRuns = null, enterFor }) => {
  const dedupedRuns = dedupeSubagentRuns(subagentRuns);
  const dedupedItems = dedupeSubagentItems(items);
  const allResolvedRuns = dedupedItems.map((it) => matchSubagentRun(it, dedupedRuns));
  const visibleEntries = dedupedItems
    .map((it, idx) => ({ item: it, run: allResolvedRuns[idx] ?? null }))
    .filter(
      ({ item, run }) =>
        !isSuppressedSubagentNoiseItem(item, dedupedItems, run, allResolvedRuns),
    );
  const visibleItems = visibleEntries.map((e) => e.item);
  const resolvedRuns = visibleEntries.map((e) => e.run);
  const runningCount = visibleItems.filter((it, idx) => isItemRunning(it, resolvedRuns[idx])).length;
  const blockedCount = visibleItems.filter((it, idx) => isItemBlocked(it, resolvedRuns[idx])).length;
  const failedCount = visibleItems.filter((it, idx) => isItemFailed(it, resolvedRuns[idx])).length;
  const anyActiveOrBlocked = runningCount > 0 || blockedCount > 0;
  const anyRunning = runningCount > 0;
  const [expanded, setExpanded] = useState(anyActiveOrBlocked);

  useEffect(() => {
    if (anyActiveOrBlocked) {
      setExpanded(true);
    }
  }, [anyActiveOrBlocked]);

  if (visibleItems.length === 0) {
    return null;
  }

  if (failedCount === visibleItems.length) {
    return (
      <SubagentFailureDisclosure
        items={visibleItems}
        runs={resolvedRuns}
        threadId={threadId}
        workspaceId={workspaceId}
        enterFor={enterFor}
      />
    );
  }

  if (visibleItems.length === 1) {
    const single = visibleItems[0]!;
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
    : `Started ${visibleItems.length} subagents`;

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
            {failedCount} did not finish
          </span>
        ) : null}
        <span className="chat-subagent-card__spacer" />
        <span className="chat-subagent-card__steps">{visibleItems.length} total</span>
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
          {visibleItems.map((item, idx) => (
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
}, areSubagentGroupRowPropsEqual);
