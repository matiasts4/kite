import React, { useState, useId, useRef } from 'react';
import { motion } from 'motion/react';
import { tweens } from '../../../motion/standard/tokens';
import {
  AlertCircleIcon,
  FileCodeIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
} from './ChatIcons';
import type { ChatItem } from '../../../types';
import { ActivityGlyph } from './activityGlyph';
import {
  activityTraceLabel,
  burstDurationSeconds,
  commandStatusWord,
  expandableToolBody,
  opensInFilesSidebar,
  outputStatLabel,
  summarizeWorkBurst,
  traceFilePath,
  workedForLine,
} from './activityPresentation';
import { prefersReducedMotion } from '../../../motion/contract';
import { formatBytes } from './types';
import { MarkdownMessage } from './MarkdownMessage';
import { UnifiedDiffView } from './UnifiedDiffView';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import { openFileInRightDock } from '../../../lib/filePreviewNav';

export function liveThoughtLine(markdown?: string | null): string {
  if (!markdown) return '';
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/`+|\*\*|~~/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

export type TranscriptRow =
  | { kind: 'work'; id: string; items: ChatItem[] }
  | { kind: 'item'; item: ChatItem };

export function groupTranscriptRows(items: ChatItem[]): TranscriptRow[] {
  const result: TranscriptRow[] = [];
  let currentWork: ChatItem[] = [];

  const flushWork = () => {
    if (currentWork.length > 0) {
      result.push({
        kind: 'work',
        id: `work-${currentWork[0]?.id ?? result.length}`,
        items: currentWork,
      });
      currentWork = [];
    }
  };

  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'command') {
      currentWork.push(item);
      continue;
    }
    if ((item.kind !== 'assistant' && item.kind !== 'reasoning') || item.text.length !== 0) {
      flushWork();
      result.push({ kind: 'item', item });
    }
  }
  flushWork();
  return result;
}

/** Index of the trailing action group, so the working caption sits above it. */
export function liveActivityRowIndex(rows: TranscriptRow[]): number {
  const last = rows[rows.length - 1];
  if (!last) return -1;
  if (last.kind === 'work') return rows.length - 1;
  if (last.kind === 'item' && last.item.kind === 'reasoning') return rows.length - 1;
  return -1;
}

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
  const statLabel = outputStatLabel(item.text);
  const bodyText = expandableToolBody(item.text);
  const openPath = traceFilePath(item);
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
        disabled={!hasText && !openPath}
        title={openPath ? openPath : undefined}
        onClick={(e) => {
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

        <strong className={isRunning ? 'chat-activity-shine' : undefined}>{traceLabel}</strong>
        {statLabel ? <span className="chat-work-entry__meta">{statLabel}</span> : null}

        <i className="chat-work-entry__spacer" />

        {failedMark ? (
          <span className="chat-work-entry__status chat-work-entry__status--failed">
            <AlertCircleIcon aria-hidden="true" size={12} strokeWidth={2} />
            <span className="sr-only">{failedMark}</span>
          </span>
        ) : null}
      </button>

      {hasText && expanded && (
        <div className="chat-collapsible chat-collapsible--open">
          <div className="chat-collapsible__inner">
            <section aria-label="Operation details" id={id}>
              {hasDiff ? (
                <div className="chat-work-entry__diff">
                  <UnifiedDiffView diff={bodyText} />
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
}> = ({ items, running, enterFor, interrupted = false, durationSeconds = null }) => {
  const [expanded, setExpanded] = useState(false);
  const groupLive = items.some(
    (item) => item.streaming || item.status === 'running' || item.status === 'inProgress',
  );
  const settled = !groupLive && !running;
  const summary = summarizeWorkBurst(items);
  const durationLine = interrupted
    ? null
    : workedForLine(durationSeconds ?? burstDurationSeconds(items));
  const showSummary = settled && items.length > 1;
  const visibleItems = showSummary && !expanded ? [] : items;
  const headerLabel = summary || `${items.length} actions`;

  return (
    <div className={`chat-work-group ${expanded && items.length > 1 ? 'chat-work-group--expanded' : ''}`}>
      {showSummary && (
        <button
          type="button"
          aria-expanded={expanded}
          className="chat-work-group__toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          <span aria-hidden="true" className="chat-work-entry__glyph">
            <ActivityGlyph item={items[0]} size={16} />
          </span>
          <span className="chat-work-group__label">{headerLabel}</span>
          {settled && durationLine && !expanded ? (
            <span className="chat-work-group__duration">{durationLine}</span>
          ) : null}
        </button>
      )}
      <div className="chat-work-group__items">
        {visibleItems.map((item, idx) => (
          <ChatWorkEntry
            key={item.id}
            item={item}
            running={(running && item.streaming) || item.streaming}
            stepIndex={idx}
            enter={enterFor?.(item.id) ?? false}
          />
        ))}
      </div>
    </div>
  );
};

export const ChatItemRow: React.FC<{
  item: ChatItem;
  threadId?: string;
  /** True when this row is new and should animate in. */
  enter?: boolean;
  onEditUserMessage?: (text: string) => void;
}> = ({
  item,
  threadId,
  enter = false,
  onEditUserMessage,
}) => {
  const [folded, setFolded] = useState(false);
  const [expandedReasoning, setExpandedReasoning] = useState(false);
  const [copiedUser, setCopiedUser] = useState(false);
  const [copiedAssistant, setCopiedAssistant] = useState(false);
  const [citation, setCitation] = useState<string | null>(null);
  const assistantRef = useRef<HTMLDivElement>(null);

  // User row: no "You" or timestamp header
  if (item.kind === 'user') {
    const isLong = item.text.length > 500;
    return (
      <motion.article
        className={`chat-turn chat-turn--user chat-user-row ${folded ? 'chat-user-row--folded' : ''}`}
        initial={enter ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={tweens.reveal}
      >
        <div className="chat-turn__actions">
          <button
            type="button"
            className="chat-turn__action-btn"
            title={copiedUser ? 'Copiado!' : 'Copiar mensaje'}
            onClick={() => {
              navigator.clipboard?.writeText(item.text);
              setCopiedUser(true);
              setTimeout(() => setCopiedUser(false), 1500);
            }}
          >
            {copiedUser ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            <span>{copiedUser ? 'Copiado' : 'Copiar'}</span>
          </button>
          {onEditUserMessage && (
            <button
              type="button"
              className="chat-turn__action-btn"
              title="Volver al mensaje y reescribirlo"
              onClick={() => onEditUserMessage(item.text)}
            >
              <PencilIcon size={12} />
              <span>Editar</span>
            </button>
          )}
        </div>

        {/* User Attachments */}
        {item.attachments && item.attachments.length > 0 && (
          <ul className="chat-attachments">
            {(item.attachments as any[]).map((att, i) => (
              <li key={i} className="chat-attachment">
                <FileCodeIcon size={12} className="chat-attachment__icon" />
                <span>{att.displayName || 'Attachment'}</span>
                {att.byteSize && <small>{formatBytes(att.byteSize)}</small>}
              </li>
            ))}
          </ul>
        )}

        <p>{item.text}</p>
        {isLong && (
          <button
            type="button"
            className="chat-user-row__toggle"
            onClick={() => setFolded((v) => !v)}
          >
            {folded ? 'Show more' : 'Show less'}
          </button>
        )}
      </motion.article>
    );
  }

  // Assistant row: no assistant label or timestamp header
  if (item.kind === 'assistant') {
    const rawText = item.text.includes('<proposed_plan>') && item.text.includes('</proposed_plan>')
      ? item.text.replace('<proposed_plan>', '\n').replace('</proposed_plan>', '\n')
      : item.text;

    // Filter out any leaked protocol JSON blobs (e.g. {"type":"step-finish",...})
    const cleanText = rawText
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          if (
            trimmed.includes('"type"') &&
            (trimmed.includes('"step-finish"') ||
              trimmed.includes('"step_finish"') ||
              trimmed.includes('"tool-call"') ||
              trimmed.includes('"tokens"') ||
              trimmed.includes('"sessionID"'))
          ) {
            return false;
          }
        }
        return true;
      })
      .join('\n');

    return (
      <motion.div
        ref={assistantRef}
        className={`chat-turn chat-turn--assistant chat-assistant-row ${item.streaming ? 'chat-turn--streaming' : ''}`}
        initial={enter ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={tweens.reveal}
        onMouseUp={() => {
          const selection = window.getSelection();
          const root = assistantRef.current;
          const anchor = selection?.anchorNode;
          if (!selection || selection.isCollapsed || !root || !anchor || !root.contains(anchor)) {
            setCitation(null);
            return;
          }
          const passage = selection.toString().trim();
          setCitation(passage || null);
        }}
      >
        {!item.streaming && cleanText.trim().length > 0 && (
          <div className="chat-turn__actions">
            {citation && (
              <button
                type="button"
                className="chat-turn__action-btn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('kite:cite', { detail: citation }));
                  window.getSelection()?.removeAllRanges();
                  setCitation(null);
                }}
              >
                Citar en el compositor
              </button>
            )}
            <button
              type="button"
              className="chat-turn__action-btn"
              title={copiedAssistant ? 'Copiado!' : 'Copiar respuesta'}
              onClick={() => {
                navigator.clipboard?.writeText(cleanText);
                setCopiedAssistant(true);
                setTimeout(() => setCopiedAssistant(false), 1500);
              }}
            >
              {copiedAssistant ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              <span>{copiedAssistant ? 'Copiado' : 'Copiar'}</span>
            </button>
          </div>
        )}
        <MarkdownMessage text={cleanText} workspaceId={(item as any).workspaceId || null} />
      </motion.div>
    );
  }

  // Reasoning Row
  if (item.kind === 'reasoning') {
    const thoughtSummary = liveThoughtLine(item.text);
    return (
      <motion.div
        className={`chat-turn chat-turn--reasoning chat-reasoning-row ${item.streaming ? 'chat-reasoning-row--streaming' : ''}`}
        initial={enter ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={tweens.reveal}
      >
        <button
          type="button"
          onClick={() => setExpandedReasoning((v) => !v)}
          className="chat-reasoning-row__trigger"
          aria-expanded={expandedReasoning}
          title={expandedReasoning ? 'Collapse reasoning details' : 'Expand full reasoning'}
        >
          <span className="chat-reasoning-row__icon-wrap">
            <ActivityGlyph item={item} size={16} />
          </span>
          <strong className={`chat-reasoning-row__label${item.streaming && !thoughtSummary ? ' chat-activity-shine' : ''}`}>
            {item.streaming ? (thoughtSummary || 'Thinking') : 'Thought'}
          </strong>
          {!item.streaming && thoughtSummary && !expandedReasoning && (
            <span className="chat-reasoning-row__headline">{thoughtSummary}</span>
          )}
        </button>
        <div
          className={`chat-collapsible ${expandedReasoning ? 'chat-collapsible--open' : ''}`}
          aria-hidden={!expandedReasoning}
        >
          <div className="chat-collapsible__inner">
            <div className="chat-reasoning-row__content">
              <p>{item.text}</p>
            </div>
          </div>
        </div>
      </motion.div>
    );
  }

  // Tool / Command Work Row (rendered individually if not grouped)
  if (item.kind === 'tool' || item.kind === 'command') {
    return <ChatWorkEntry item={item} running={item.streaming} enter={enter} />;
  }

  // Error Row
  if (item.kind === 'error') {
    return (
      <div className="chat-turn chat-turn--error chat-error-row" role="alert">
        <AlertCircleIcon size={14} />
        <div>
          {item.title && <strong>{item.title}</strong>}
          <p>{item.text}</p>
        </div>
      </div>
    );
  }

  // Note Row
  if (item.kind === 'note') {
    return <p className="chat-turn chat-turn--note chat-note-row">{item.text}</p>;
  }

  // Quota Handoff Row
  if (item.kind === 'quotaHandoff' && item.handoffOffer) {
    return (
      <QuotaHandoffBanner
        offer={item.handoffOffer}
        threadId={threadId || (item as any).threadId || ''}
      />
    );
  }

  return null;
};

