import React, { useId, useState } from 'react';
import { motion } from 'motion/react';
import { tweens } from '../../../motion/standard/tokens';
import { prefersReducedMotion } from '../../../motion/contract';
import { ChevronRightIcon, CloseIcon } from './ChatIcons';
import type { ChatItem } from '../../../types';
import { ActivityGlyph } from './activityGlyph';
import {
  activityTraceLabel,
  burstDurationSeconds,
  commandStatusWord,
  interruptedTurnLine,
  liveWorkGroupHeadline,
  opensInFilesSidebar,
  outputStatLabel,
  splitTraceLabel,
  summarizeWorkBurst,
  toolExpandedBody,
  traceFilePath,
  traceLineRangeLabel,
  workedForLine,
} from './activityPresentation';
import { UnifiedDiffView } from './UnifiedDiffView';
import { openFileInRightDock } from '../../../lib/filePreviewNav';

interface ParsedToolMeta {
  titleText: string;
  detailText: string | null;
  serverName: string | null;
  toolKind: string;
  addedLines: number | null;
  removedLines: number | null;
  copyTarget: string | null;
}

function parseToolDisplayMeta(item: ChatItem): ParsedToolMeta {
  const isCommand = item.kind === 'command';
  const rawTitle = item.title || item.toolName || '';
  let serverName = item.serverName || null;
  let cleanTitle = rawTitle;

  if (!serverName) {
    const doubleMatch = /^mcp__([^_]+)__(.+)$/i.exec(rawTitle);
    if (doubleMatch) {
      serverName = doubleMatch[1];
      cleanTitle = doubleMatch[2];
    } else {
      const dotMatch = /^([a-z0-9_-]+)\s*·\s*(.+)$/i.exec(rawTitle);
      if (dotMatch && dotMatch[1].toLowerCase() !== 'plan') {
        serverName = dotMatch[1];
        cleanTitle = dotMatch[2];
      }
    }
  }

  let formattedTitle = 'Tool execution';
  if (isCommand) {
    formattedTitle = 'Run';
  } else if (cleanTitle) {
    const humanized = cleanTitle.replace(/^(mcp__|tool__|cmd__)/, '').replace(/_/g, ' ').trim();
    formattedTitle = humanized.charAt(0).toUpperCase() + humanized.slice(1);
  }

  const detailText = isCommand ? item.title : item.detail;
  const toolKind =
    item.toolKind ||
    (isCommand
      ? 'commandExecution'
      : serverName
        ? 'mcpToolCall'
        : 'dynamicToolCall');

  let addedLines = typeof item.addedLines === 'number' ? item.addedLines : null;
  let removedLines = typeof item.removedLines === 'number' ? item.removedLines : null;

  if (addedLines === null && removedLines === null && item.text && (item.text.startsWith('diff --git') || item.text.includes('\n@@ -'))) {
    let add = 0;
    let rem = 0;
    for (const line of item.text.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) add += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) rem += 1;
    }
    if (add > 0 || rem > 0) {
      addedLines = add;
      removedLines = rem;
    }
  }

  const copyTarget = item.command || (isCommand ? item.title : null) || (item.text ? item.text : null);

  return {
    titleText: formattedTitle,
    detailText: detailText || null,
    serverName,
    toolKind,
    addedLines,
    removedLines,
    copyTarget,
  };
}

export const ChatWorkEntry: React.FC<{
  item: ChatItem;
  running?: boolean;
  stepIndex?: number;
  /** True when this row is new and should animate in. */
  enter?: boolean;
}> = ({
  item,
  running,
  enter = false,
}) => {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const isCommand = item.kind === 'command';
  const isFailed =
    item.status === 'failed' || (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0);
  const isCompleted = item.status === 'completed';
  const isRunning = Boolean(running || item.streaming || item.status === 'running' || item.status === 'inProgress');
  const traceLabel = activityTraceLabel(item);
  const traceParts = splitTraceLabel(traceLabel);
  const lineRangeLabel = traceLineRangeLabel(item);
  const statLabel = outputStatLabel(item.text);
  const bodyText = toolExpandedBody(item);
  const openPath = traceFilePath(item);
  const delegatedThreadId = item.delegatedThreadId || null;
  const delegatedLabel = delegatedThreadId
    ? item.delegatedMode === 'agents'
      ? 'Abrir agente'
      : 'Abrir hilo'
    : null;
  const sidebarFile = opensInFilesSidebar(item);
  const hasText = !sidebarFile && bodyText.length > 0;
  const meta = parseToolDisplayMeta(item);
  const commandWord = isCommand || meta.toolKind === 'commandExecution' ? commandStatusWord(item) : null;
  const failedMark =
    commandWord === 'Failed' || commandWord === 'Declined' || commandWord === 'Stopped'
      ? commandWord
      : isFailed
        ? 'Failed'
        : null;

  const hasDiff = Boolean(
    item.text && (
      item.text.startsWith('diff --git') ||
      item.text.startsWith('---') ||
      item.text.includes('\n@@ -')
    )
  );

  const className = [
    'chat-work-entry',
    isCommand || meta.toolKind === 'commandExecution' ? 'chat-work-entry--command' : '',
    meta.serverName ? 'chat-work-entry--mcp' : '',
    isRunning ? 'chat-work-entry--running' : '',
    isCompleted ? 'chat-work-entry--completed' : '',
    isFailed ? 'chat-work-entry--failed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <motion.div
      className={className}
      initial={enter && !prefersReducedMotion() ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={tweens.reveal}
    >
      <button
        type="button"
        aria-expanded={hasText ? expanded : undefined}
        aria-controls={hasText ? id : undefined}
        disabled={!hasText && !openPath && !delegatedThreadId}
        title={openPath ? openPath : delegatedLabel ?? undefined}
        onClick={(e) => {
          if (e.button === 0 && delegatedThreadId) {
            e.preventDefault();
            try {
              window.dispatchEvent(
                new CustomEvent('kite:select-thread', {
                  detail: { threadId: delegatedThreadId, mode: item.delegatedMode || 'chat' },
                })
              );
            } catch {}
            return;
          }
          if (e.button !== 0 || !openPath) {
            if (!hasText) return;
            setExpanded((v) => !v);
            return;
          }
          const openInSidebar = sidebarFile || e.ctrlKey || e.metaKey;
          if (openInSidebar) {
            e.preventDefault();
            openFileInRightDock({
              candidate: openPath,
              workspaceId: (item as { workspaceId?: string | null }).workspaceId || null,
              collapseTree: true,
              preferRendered: true,
            });
            return;
          }
          if (!hasText) return;
          setExpanded((v) => !v);
        }}
      >
        <span aria-hidden="true" className="chat-work-entry__glyph">
          <ActivityGlyph item={item} size={16} />
        </span>

        <strong
          className={isRunning ? 'live-tool-shine chat-activity-shine' : undefined}
          title={traceLabel}
        >
          {traceParts.verb ? (
            <>
              <span className="chat-work-entry__verb">{traceParts.verb}</span>{' '}
              <span className="chat-work-entry__target">{traceParts.target}</span>
            </>
          ) : (
            traceLabel
          )}
        </strong>
        {lineRangeLabel ? <span className="chat-work-entry__range">{lineRangeLabel}</span> : null}
        {statLabel ? <span className="chat-work-entry__meta">{statLabel}</span> : null}
        {delegatedLabel ? <span className="chat-work-entry__meta">{delegatedLabel}</span> : null}

        {failedMark ? (
          <span className="chat-work-entry__status chat-work-entry__status--failed">
            <CloseIcon aria-hidden="true" size={12} />
            <span className="sr-only">{failedMark}</span>
          </span>
        ) : null}

        {hasText ? (
          <span
            aria-hidden="true"
            className={`chat-work-entry__chevron ${expanded ? 'chat-work-entry__chevron--open' : ''}`}
          >
            <ChevronRightIcon size={12} />
          </span>
        ) : null}
      </button>

      {hasText && expanded && (
        <div className="chat-collapsible chat-collapsible--open">
          <div className="chat-collapsible__inner">
            <section aria-label="Operation details" id={id}>
              {hasDiff ? (
                <div className="chat-work-entry__diff">
                  <UnifiedDiffView diff={bodyText} filePath={openPath ?? undefined} />
                </div>
              ) : (
                <pre>{bodyText}</pre>
              )}
            </section>
          </div>
        </div>
      )}
    </motion.div>
  );
};

export const ChatWorkGroup: React.FC<{
  items: ChatItem[];
  running?: boolean;
  enterFor?: (id: string) => boolean;
  interrupted?: boolean;
  durationSeconds?: number | null;
  defaultExpanded?: boolean;
}> = React.memo(({
  items,
  running,
  enterFor,
  interrupted = false,
  durationSeconds = null,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const groupId = useId();
  if (items.length === 0) return null;

  const groupLive = items.some(
    (item) =>
      item.streaming ||
      item.status === 'running' ||
      item.status === 'inProgress' ||
      item.status === 'pending',
  );
  const isLive = Boolean(groupLive || running);
  const settled = !isLive;
  const summary = summarizeWorkBurst(items);
  const durationLine = interrupted
    ? interruptedTurnLine(durationSeconds ?? burstDurationSeconds(items))
    : workedForLine(durationSeconds ?? burstDurationSeconds(items));
  const liveHeadline = liveWorkGroupHeadline(items);
  const settledHeadline =
    summary || (items.length === 1 ? activityTraceLabel(items[0]) : `${items.length} actions`);
  const fallbackLabel = isLive ? 'Working' : `${items.length} ${items.length === 1 ? 'action' : 'actions'}`;
  const headerLabel = (isLive ? liveHeadline : settledHeadline).trim() || fallbackLabel;
  const visibleItems = expanded ? items : [];

  return (
    <div
      className={`chat-work-group ${expanded ? 'chat-work-group--expanded' : 'chat-work-group--collapsed'} ${
        isLive ? 'chat-work-group--live' : ''
      }`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={groupId}
        className="chat-work-group__toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className={`chat-work-group__label ${isLive ? 'live-tool-shine chat-activity-shine' : ''}`}
          title={headerLabel}
        >
          {headerLabel}
        </span>
        {settled && durationLine && !expanded ? (
          <span className="chat-work-group__duration">{durationLine}</span>
        ) : null}
        <span
          aria-hidden="true"
          className={`chat-work-entry__chevron ${expanded ? 'chat-work-entry__chevron--open' : ''}`}
        >
          <ChevronRightIcon size={12} />
        </span>
      </button>
      {expanded && (
        <div id={groupId} className="chat-work-group__items">
          {visibleItems.map((item, idx) => (
            <ChatWorkEntry
              key={item.id}
              item={item}
              running={(running && item.streaming) || item.streaming}
              stepIndex={idx}
              enter={enterFor?.(item.id) ?? false}
            />
          ))}
          {isLive ? (
            <div className="chat-work-group__working" role="status">
              <span className="live-tool-shine chat-activity-shine">Working</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});
