import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { ChatItem, SubagentRun } from '../../../types';
import { BotIcon, CheckIcon, ChevronRightIcon, CloseIcon } from './ChatIcons';
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

function isRunBacked(run?: SubagentRun | null): boolean {
  if (!run) return false;
  return Boolean(
    run.childThreadId ||
      run.transcriptUri ||
      (Array.isArray(run.items) && run.items.length > 0),
  );
}

function isSubagentItemBacked(item: ChatItem): boolean {
  const meta = item.subagentMeta;
  return Boolean(
    meta?.childThreadId ||
      meta?.transcriptUri ||
      item.id.startsWith('dispatch-subagent-'),
  );
}

export function dedupeSubagentRuns(runs?: SubagentRun[] | null): SubagentRun[] {
  if (!runs || runs.length <= 1) return runs ? [...runs] : [];
  const result: SubagentRun[] = [];
  for (const candidate of runs) {
    const candBacked = isRunBacked(candidate);
    const candRole = (candidate.role || '').trim().toLowerCase();
    const candPrompt = (candidate.prompt || '').trim();
    const existingIdx = result.findIndex((r) => {
      if (r.subagentId === candidate.subagentId) return true;
      if (r.childThreadId && candidate.childThreadId && r.childThreadId === candidate.childThreadId) {
        return true;
      }
      if (
        (r.parentToolCallId && r.parentToolCallId === candidate.subagentId) ||
        (candidate.parentToolCallId && candidate.parentToolCallId === r.subagentId)
      ) {
        return true;
      }
      const rBacked = isRunBacked(r);
      if (rBacked !== candBacked) {
        const rRole = (r.role || '').trim().toLowerCase();
        const rPrompt = (r.prompt || '').trim();
        const roleMatch =
          !rRole ||
          !candRole ||
          rRole === candRole ||
          rRole === 'subagent' ||
          candRole === 'subagent';
        const promptMatch = !rPrompt || !candPrompt || rPrompt === candPrompt;
        if (roleMatch && promptMatch && (rRole === candRole || (rPrompt && rPrompt === candPrompt))) {
          return true;
        }
      }
      return false;
    });

    if (existingIdx === -1) {
      result.push(candidate);
    } else if (candBacked && !isRunBacked(result[existingIdx])) {
      result[existingIdx] = {
        ...result[existingIdx],
        ...candidate,
        parentToolCallId: candidate.parentToolCallId ?? result[existingIdx].parentToolCallId,
      };
    }
  }
  return result;
}

export function dedupeSubagentItems(items: ChatItem[]): ChatItem[] {
  if (items.length <= 1) return items;
  const result: ChatItem[] = [];
  for (const candidate of items) {
    const candBacked = isSubagentItemBacked(candidate);
    const candMeta = candidate.subagentMeta;
    const candRole = (candMeta?.role || candidate.title || '').trim().toLowerCase();
    const candPrompt = (candMeta?.prompt || '').trim();

    const existingIdx = result.findIndex((existing) => {
      const exMeta = existing.subagentMeta;
      if (existing.id === candidate.id) return true;
      if (exMeta?.subagentId && candMeta?.subagentId && exMeta.subagentId === candMeta.subagentId) {
        return true;
      }
      if (
        exMeta?.childThreadId &&
        candMeta?.childThreadId &&
        exMeta.childThreadId === candMeta.childThreadId
      ) {
        return true;
      }
      const exBacked = isSubagentItemBacked(existing);
      if (exBacked !== candBacked) {
        const exRole = (exMeta?.role || existing.title || '').trim().toLowerCase();
        const exPrompt = (exMeta?.prompt || '').trim();
        const roleMatch =
          !exRole ||
          !candRole ||
          exRole === candRole ||
          exRole === 'subagent' ||
          candRole === 'subagent';
        const promptMatch = !exPrompt || !candPrompt || exPrompt === candPrompt;
        if (roleMatch && promptMatch && (exRole === candRole || (exPrompt && exPrompt === candPrompt))) {
          return true;
        }
      }
      return false;
    });

    if (existingIdx === -1) {
      result.push(candidate);
    } else if (candBacked && !isSubagentItemBacked(result[existingIdx])) {
      const prev = result[existingIdx];
      result[existingIdx] = {
        ...candidate,
        durationSeconds: candidate.durationSeconds ?? prev.durationSeconds,
      };
    } else if (!candBacked && isSubagentItemBacked(result[existingIdx])) {
      const prev = result[existingIdx];
      if (!prev.durationSeconds && candidate.durationSeconds) {
        result[existingIdx] = {
          ...prev,
          durationSeconds: candidate.durationSeconds,
        };
      }
    }
  }
  return result;
}

function isRawDispatchCommand(text?: string | null): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith('$') ||
    trimmed.includes('kite dispatch ') ||
    trimmed.includes('kite-code dispatch ')
  );
}

export function plainPreviewLine(raw?: string | null): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/```[^`\n]*\n?/g, ' ')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[^\w])[*_]([^*_\r\n]+)[*_](?![\w])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
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

function isItemBlocked(item: ChatItem, run?: SubagentRun | null): boolean {
  const rawStatus = (run?.status || item.subagentMeta?.status || item.status || '').toLowerCase();
  return rawStatus === 'waiting' || rawStatus === 'needsinput' || rawStatus === 'blocked';
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
    : run?.latestActivity || meta?.latestActivity || '';
  const secondaryRaw = isFailed
    ? safeActivity ||
      extractFailureSummary(item.text) ||
      safeDetail ||
      promptExcerpt ||
      ''
    : safeActivity || safeDetail || promptExcerpt || '';
  const secondaryLine = plainPreviewLine(secondaryRaw);
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
          {isFailed ? (
            <CloseIcon size={13} />
          ) : !isRunning ? (
            <CheckIcon size={13} />
          ) : (
            <BotIcon size={14} />
          )}
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
              <span>Waiting</span>
            </span>
          ) : isRunning ? (
            <>
              <span aria-hidden="true" className="chat-working-pulse" />
              <LiveElapsedClock
                className="chat-subagent-card__clock"
                running={true}
                startedAtUnixMs={startedAt}
                format="clock"
                idleLabel="Live"
              />
            </>
          ) : isFailed ? (
            <span className="chat-subagent-card__state chat-subagent-card__state--failed">
              <span>{rawStatus === 'cancelled' || rawStatus === 'killed' ? 'Stopped' : 'Failed'}</span>
            </span>
          ) : (
            <span className="chat-subagent-card__state chat-subagent-card__state--done">
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
        <span className="chat-subagent-card__steps">{dedupedItems.length} total</span>
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
