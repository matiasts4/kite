import React, { useState, useId, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { tweens } from '../../../motion/standard/tokens';
import {
  ChevronRightIcon,
  TerminalIcon,
  WrenchIcon,
  AlertCircleIcon,
  FileCodeIcon,
  CheckIcon,
  EyeIcon,
  PencilIcon,
  GlobeIcon,
  BrainIcon,
  CpuIcon,
  CopyIcon,
  CompassIcon,
} from './ChatIcons';
import type { ChatItem } from '../../../types';
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

function useLiveDuration(active: boolean, createdAtUnixMs?: number, explicitSeconds?: number | null): string | null {
  const startRef = useRef<number>(
    createdAtUnixMs && createdAtUnixMs > 1_000_000_000_000 ? createdAtUnixMs : Date.now()
  );
  const [elapsedSec, setElapsedSec] = useState<number>(() => {
    if (typeof explicitSeconds === 'number' && explicitSeconds > 0) return explicitSeconds;
    if (!active) return 0;
    return Math.max(0.1, (Date.now() - startRef.current) / 1000);
  });

  useEffect(() => {
    if (typeof explicitSeconds === 'number' && explicitSeconds > 0) {
      setElapsedSec(explicitSeconds);
      return;
    }
    if (!active) return;
    const timer = window.setInterval(() => {
      setElapsedSec(Math.max(0.1, (Date.now() - startRef.current) / 1000));
    }, 150);
    return () => window.clearInterval(timer);
  }, [active, explicitSeconds]);

  if (typeof explicitSeconds === 'number' && explicitSeconds > 0) {
    return explicitSeconds < 10 ? `${explicitSeconds.toFixed(1)}s` : `${Math.round(explicitSeconds)}s`;
  }
  if (elapsedSec <= 0.05) return null;
  return elapsedSec < 10 ? `${elapsedSec.toFixed(1)}s` : `${Math.round(elapsedSec)}s`;
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

function getToolIcon(title: string | null, toolKind?: string | null, serverName?: string | null) {
  if (serverName || toolKind === 'mcpToolCall') {
    return <CpuIcon size={12} />;
  }
  if (toolKind === 'planUpdate') {
    return <CompassIcon size={12} />;
  }
  if (toolKind === 'commandExecution') {
    return <TerminalIcon size={12} />;
  }
  if (toolKind === 'fileChange') {
    return <PencilIcon size={12} />;
  }
  if (toolKind === 'webSearch') {
    return <GlobeIcon size={12} />;
  }
  const lower = (title || '').toLowerCase();
  if (lower.includes('read') || lower.includes('cat') || lower.includes('view') || lower.includes('inspect')) {
    return <EyeIcon size={12} />;
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('replace') || lower.includes('patch')) {
    return <PencilIcon size={12} />;
  }
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('browser') || lower.includes('url') || lower.includes('search')) {
    return <GlobeIcon size={12} />;
  }
  if (lower.includes('bash') || lower.includes('cmd') || lower.includes('shell') || lower.includes('terminal') || lower.includes('run')) {
    return <TerminalIcon size={12} />;
  }
  return <WrenchIcon size={12} />;
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
  const [copied, setCopied] = useState(false);
  const id = useId();
  const isCommand = item.kind === 'command';
  const hasText = Boolean(item.text && item.text.length > 0);
  const isFailed =
    item.status === 'failed' || (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0);
  const isCompleted = item.status === 'completed';
  const isRunning = Boolean(running || item.streaming || item.status === 'running' || item.status === 'inProgress');

  const durationBadge = useLiveDuration(isRunning, item.createdAtUnixMs, item.durationSeconds);
  const meta = parseToolDisplayMeta(item);

  const hasDiff = Boolean(
    item.text && (
      item.text.startsWith('diff --git') ||
      item.text.startsWith('---') ||
      item.text.includes('\n@@ -')
    )
  );

  const livePreviewLines =
    isRunning && !expanded && hasText && !hasDiff
      ? item.text
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .slice(-2)
      : [];

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
      initial={enter ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={tweens.reveal}
    >
      <button
        type="button"
        aria-expanded={hasText ? expanded : undefined}
        aria-controls={hasText ? id : undefined}
        disabled={!hasText}
        onClick={() => setExpanded((v) => !v)}
      >
        <span aria-hidden="true" className={`chat-work-entry__glyph ${isRunning ? 'chat-work-entry__glyph--active' : ''}`}>
          {isCommand ? <TerminalIcon size={12} /> : getToolIcon(item.title, meta.toolKind, meta.serverName)}
        </span>

        {meta.serverName && (
          <span className="chat-work-entry__mcp-badge" title={`MCP Server: ${meta.serverName}`}>
            {meta.serverName}
          </span>
        )}

        <strong>{meta.titleText}</strong>

        {meta.detailText && (
          <span
            className="chat-work-entry__detail"
            title="Ctrl + Click para previsualizar archivo"
            onClick={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.button === 0) {
                e.stopPropagation();
                e.preventDefault();
                openFileInRightDock({
                  candidate: meta.detailText!,
                  workspaceId: (item as any).workspaceId || null,
                  collapseTree: true,
                });
              }
            }}
          >
            {meta.detailText}
          </span>
        )}

        {(meta.addedLines !== null || meta.removedLines !== null) && (
          <span className="chat-work-entry__diff-stats" aria-label="Diff line changes">
            {meta.addedLines !== null && meta.addedLines > 0 && (
              <span className="chat-work-entry__diff-add">+{meta.addedLines}</span>
            )}
            {meta.removedLines !== null && meta.removedLines > 0 && (
              <span className="chat-work-entry__diff-del">-{meta.removedLines}</span>
            )}
          </span>
        )}

        <i className="chat-work-entry__spacer" />

        {meta.copyTarget && (
          <span
            role="button"
            tabIndex={-1}
            className="chat-work-entry__copy"
            title={copied ? 'Copied!' : 'Copy'}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              navigator.clipboard?.writeText(meta.copyTarget || '');
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
          </span>
        )}

        {durationBadge && (
          <span className={`chat-work-entry__duration ${isRunning ? 'chat-work-entry__duration--live' : ''}`}>
            {durationBadge}
          </span>
        )}

        {hasText && (
          <ChevronRightIcon
            aria-hidden="true"
            size={8}
            strokeWidth={2.5}
            className={`chat-work-entry__chevron chat-chevron chat-chevron--flip ${
              expanded ? 'chat-chevron--open' : ''
            }`}
          />
        )}

        <span
          className={`chat-work-entry__status ${
            isFailed
              ? 'chat-work-entry__status--failed'
              : isCompleted
                ? 'chat-work-entry__status--completed'
                : isRunning
                  ? 'chat-work-entry__status--running'
                  : ''
          }`}
        >
          {isFailed ? (
            <>
              <AlertCircleIcon aria-hidden="true" size={9} strokeWidth={3} />
              <span className="sr-only">Failed</span>
            </>
          ) : isCompleted ? (
            <>
              <CheckIcon aria-hidden="true" size={9} strokeWidth={3} />
              <span className="sr-only">Completed</span>
            </>
          ) : isRunning ? (
            <>
              <i aria-hidden="true" className="chat-work-entry__running" />
              <span className="sr-only">Running</span>
            </>
          ) : null}
        </span>
      </button>

      {livePreviewLines.length > 0 && (
        <div className="chat-work-entry__live-preview" onClick={() => setExpanded(true)}>
          {livePreviewLines.map((line, idx) => (
            <div key={idx} className="chat-work-entry__live-line">
              {line}
            </div>
          ))}
        </div>
      )}

      {hasText && (
        <div
          className={`chat-collapsible ${expanded ? 'chat-collapsible--open' : ''}`}
          aria-hidden={!expanded}
        >
          <div className="chat-collapsible__inner">
            <section aria-label="Operation details" id={id}>
              {hasDiff ? (
                <div className="chat-work-entry__diff">
                  <UnifiedDiffView diff={item.text} />
                </div>
              ) : (
                <pre>{item.text}</pre>
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
}> = ({ items, running, enterFor }) => {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, items.length - 1);
  const visibleItems = expanded ? items : items.slice(-1);

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const failedCount = items.filter(
    (i) => i.status === 'failed' || (i.exitCode !== null && i.exitCode !== undefined && i.exitCode !== 0)
  ).length;
  const runningCount = items.filter((i) => i.streaming || i.status === 'running' || i.status === 'inProgress').length;

  return (
    <div className={`chat-work-group ${expanded && items.length > 1 ? 'chat-work-group--expanded' : ''}`}>
      {hiddenCount > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          className="chat-work-group__toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronRightIcon
            size={10}
            strokeWidth={2.5}
            className={`chat-chevron chat-chevron--flip ${expanded ? 'chat-chevron--open' : ''}`}
          />
          <span className="chat-work-group__label">
            {expanded
              ? `Ocultar registro de acciones (${items.length})`
              : `+${hiddenCount} ${hiddenCount === 1 ? 'acción anterior' : 'acciones anteriores'}`}
          </span>
          <span className="chat-work-group__badges" aria-hidden="true">
            {runningCount > 0 && (
              <span className="chat-work-group__badge chat-work-group__badge--running">
                <span className="chat-work-group__pulse" />
                {completedCount}/{items.length}
              </span>
            )}
            {failedCount > 0 && (
              <span className="chat-work-group__badge chat-work-group__badge--failed">
                {failedCount} {failedCount === 1 ? 'fallo' : 'fallos'}
              </span>
            )}
            {runningCount === 0 && failedCount === 0 && (
              <span className="chat-work-group__badge chat-work-group__badge--done">
                ✓ {items.length} completadas
              </span>
            )}
          </span>
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
  const reasoningDuration = useLiveDuration(
    item.kind === 'reasoning' && item.streaming,
    item.createdAtUnixMs,
    item.durationSeconds
  );

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
        className={`chat-turn chat-turn--assistant chat-assistant-row ${item.streaming ? 'chat-turn--streaming' : ''}`}
        initial={enter ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={tweens.reveal}
      >
        {!item.streaming && cleanText.trim().length > 0 && (
          <div className="chat-turn__actions">
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
            <BrainIcon size={13} className={item.streaming ? 'chat-reasoning-icon--pulse' : ''} />
          </span>
          <ChevronRightIcon
            size={8}
            strokeWidth={2.5}
            className={`chat-chevron ${expandedReasoning ? 'chat-chevron--open' : ''}`}
          />
          <strong className="chat-reasoning-row__label">
            {item.streaming ? 'Thinking…' : reasoningDuration ? `Thought for ${reasoningDuration}` : 'Thought'}
          </strong>
          {item.streaming && reasoningDuration && (
            <span className="chat-reasoning-row__timer">{reasoningDuration}</span>
          )}
          {thoughtSummary && !expandedReasoning && (
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

