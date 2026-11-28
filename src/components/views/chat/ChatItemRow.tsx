import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useReduceMotion } from '../../../motion/standard/context';
import { prefersReducedMotion } from '../../../motion/contract';
import { tweens } from '../../../motion/standard/tokens';
import {
  AlertCircleIcon,
  FileCodeIcon,
  CheckIcon,
  CopyIcon,
  MicIcon,
  PencilIcon,
} from './ChatIcons';
import type { ChatItem, SubagentRun, SwarmState } from '../../../types';
import {
  areSubagentRunCardsEqual,
  dedupeSubagentRuns,
  SubagentActivityCard,
  SubagentFailureDisclosure,
} from './SubagentActivityCard';
import {
  isHookBlockedInvokeNoise,
  isItemFailed,
  matchSubagentRun,
} from './subagentRunHelpers';
import { SwarmActivityCard } from './SwarmActivityCard';
import { ActivityGlyph } from './activityGlyph';
import { AttachmentPreviewThumb } from './attachmentPreview';
import { formatBytes } from './types';
import { MarkdownMessage } from './MarkdownMessage';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import {
  citationTextFromNodes,
  draftHasCitation,
  expandCitations,
  splitDraft,
  writeCitationClipboard,
} from './citationChip';
import {
  groupTranscriptRows,
  isHiddenNoteItem,
  isInternalDispatchItem,
  liveActivityRowIndex,
  liveThoughtLine,
  reasoningPreviewRemainder,
  sanitizeAssistantProtocolText,
  userMessageFolds,
  visibleAssistantText,
  type TranscriptRow,
} from './chatItemHelpers';
import { ChatWorkEntry, ChatWorkGroup } from './ChatWorkLog';
import { AssistantCitationChip } from './ChatCitationChip';
import { useSmoothStreamingText } from './useSmoothStreamingText';
import { McpAppFrame } from '../plugins/McpAppFrame';

export {
  groupTranscriptRows,
  liveActivityRowIndex,
  liveThoughtLine,
  reasoningPreviewRemainder,
  sanitizeAssistantProtocolText,
  userMessageFolds,
  type TranscriptRow,
  ChatWorkEntry,
  ChatWorkGroup,
  AssistantCitationChip,
};

export interface ChatItemMcpAppMeta {
  serverName: string;
  resourceUri: string;
  toolName?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  title?: string;
}

export type ChatItemWithMcpApp = ChatItem & {
  mcpApp?: ChatItemMcpAppMeta | null;
  _meta?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstNonEmptyString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function extractServerFromToolName(raw: string | null | undefined): string | null {
  const clean = (raw ?? '').trim();
  if (!clean) return null;
  const doubleMatch = /^mcp__(.+?)__(.+)$/i.exec(clean);
  if (doubleMatch && doubleMatch[1].trim()) {
    return doubleMatch[1].trim();
  }
  const dotMatch = /^([a-z0-9_-]+)\s*·\s*(.+)$/i.exec(clean);
  if (dotMatch && dotMatch[1].toLowerCase() !== 'plan') {
    return dotMatch[1].trim();
  }
  return null;
}

function tryParseJsonRecord(raw: string | null | undefined): Record<string, unknown> | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return asRecord(parsed) ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveInlineMcpApp(item: ChatItemWithMcpApp): ChatItemMcpAppMeta | null {
  if (item.kind !== 'tool' && item.kind !== 'command') return null;

  const explicit = item.mcpApp;
  if (explicit && typeof explicit === 'object') {
    const resourceUri = typeof explicit.resourceUri === 'string' ? explicit.resourceUri.trim() : '';
    const serverName =
      firstNonEmptyString(
        explicit.serverName,
        item.serverName,
        extractServerFromToolName(item.toolName || item.title),
      ) ?? '';
    if (resourceUri.toLowerCase().startsWith('ui://') && serverName.length > 0) {
      return {
        serverName,
        resourceUri,
        toolName: explicit.toolName ?? item.toolName ?? undefined,
        input: explicit.input,
        result: explicit.result,
        title: explicit.title,
      };
    }
  }

  const metaObj = asRecord(item._meta) ?? asRecord(item.meta);
  if (!metaObj) return null;
  const uiObj = asRecord(metaObj.ui);
  const rawUri = firstNonEmptyString(
    uiObj?.resourceUri,
    uiObj?.resource_uri,
    metaObj['ui/resourceUri'],
  );
  if (!rawUri || !rawUri.toLowerCase().startsWith('ui://')) return null;

  const serverName =
    firstNonEmptyString(item.serverName, extractServerFromToolName(item.toolName || item.title)) ??
    '';
  if (!serverName) return null;

  const derivedResult =
    !item.streaming && item.text.trim().length > 0
      ? {
          content: [{ type: 'text', text: item.text }],
          isError: item.status === 'failed',
        }
      : undefined;

  return {
    serverName,
    resourceUri: rawUri,
    toolName: item.toolName ?? undefined,
    input: tryParseJsonRecord(item.detail),
    result: derivedResult,
    title: firstNonEmptyString(uiObj?.title) ?? undefined,
  };
}

function restoreErrorText(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'File restore did not run.';
}

function restoreCommandMissing(text: string): boolean {
  return /not found|unavailable/i.test(text);
}

export interface ChatItemRowProps {
  item: ChatItemWithMcpApp;
  threadId?: string;
  workspaceId?: string | null;
  subagentRuns?: SubagentRun[] | null;
  matchedSubagentRun?: SubagentRun | null;
  swarmState?: SwarmState | null;
  /** True when this row is new and should animate in. */
  enter?: boolean;
  onEditUserMessage?: (text: string) => void;
  onRewindTranscript?: (messageId: string) => void | Promise<void>;
  onRestoreFiles?: (messageId: string) => void | Promise<void>;
  fileRestoreEnabled?: boolean;
  /** False when the restore command cannot be invoked. Defaults to available. */
  restoreCommandAvailable?: boolean;
}

const ChatItemRowInner: React.FC<ChatItemRowProps> = ({
  item,
  threadId,
  workspaceId = null,
  subagentRuns = null,
  matchedSubagentRun,
  swarmState = null,
  enter = false,
  onEditUserMessage,
  onRewindTranscript,
  onRestoreFiles,
  fileRestoreEnabled = false,
  restoreCommandAvailable = true,
}) => {
  const [folded, setFolded] = useState(() => item.kind === 'user' && userMessageFolds(item.text));
  const [expandedReasoning, setExpandedReasoning] = useState(false);
  const [copiedUser, setCopiedUser] = useState(false);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPlacement, setRewindPlacement] = useState<'bottom' | 'top'>('bottom');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreUnavailable, setRestoreUnavailable] = useState(false);
  const [copiedAssistant, setCopiedAssistant] = useState(false);
  const [citation, setCitation] = useState<string | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const assistantRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!rewindOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (actionsRef.current && event.target instanceof Node && !actionsRef.current.contains(event.target)) {
        setRewindOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRewindOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [rewindOpen]);
  const reduceMotion = useReduceMotion() || prefersReducedMotion();
  const cleanAssistantText = item.kind === 'assistant' ? visibleAssistantText(item.text) : '';
  const displayedAssistantText = useSmoothStreamingText(
    cleanAssistantText,
    item.kind === 'assistant' && Boolean(item.streaming) && !reduceMotion,
    { animateInitial: Boolean(enter) },
  );

  // User row: no "You" or timestamp header
  if (item.kind === 'user') {
    if (isInternalDispatchItem(item)) return null;
    const isLong = userMessageFolds(item.text);
    return (
      <motion.article
        className={`chat-turn chat-turn--user chat-user-row chat-user-row--bubble ${folded ? 'chat-user-row--folded' : ''}`}
        data-message-id={item.id}
        data-turn-user-id={item.id}
        initial={enter ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={tweens.reveal}
      >
        <div
          ref={actionsRef}
          className="chat-turn__actions"
          data-open={rewindOpen ? 'true' : undefined}
        >
          <button
            type="button"
            className="chat-turn__action-btn"
            title={copiedUser ? 'Copied!' : 'Copy message'}
            onClick={() => {
              navigator.clipboard?.writeText(expandCitations(item.text));
              setCopiedUser(true);
              setTimeout(() => setCopiedUser(false), 1500);
            }}
          >
            {copiedUser ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            <span>{copiedUser ? 'Copied' : 'Copy'}</span>
          </button>
          {onEditUserMessage && (
            <button
              type="button"
              className="chat-turn__action-btn"
              title="Edit from here"
              aria-expanded={rewindOpen}
              onClick={(event) => {
                const trigger = event.currentTarget;
                setRewindOpen((open) => {
                  const next = !open;
                  if (next) {
                    const rect = trigger.getBoundingClientRect();
                    const scroller = trigger.closest('.chat-transcript');
                    const bottomLimit = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
                    setRewindPlacement(rect.bottom + 116 > bottomLimit ? 'top' : 'bottom');
                  }
                  return next;
                });
              }}
            >
              <PencilIcon size={12} />
              <span>Edit from here</span>
            </button>
          )}
          {rewindOpen && onEditUserMessage ? (
            <div
              className="chat-rewind"
              role="dialog"
              aria-label="Edit from here"
              data-placement={rewindPlacement}
            >
              <button
                type="button"
                onClick={() => {
                  onEditUserMessage(item.text);
                  if (!onRewindTranscript) return;
                  void Promise.resolve(onRewindTranscript(item.id))
                    .then(() => {
                      setRewindOpen(false);
                    })
                    .catch((error: unknown) => {
                      setRestoreError(restoreErrorText(error));
                    });
                }}
              >
                <PencilIcon size={12} />
                <span>Rewind and keep file changes</span>
              </button>
              <button
                type="button"
                disabled={!fileRestoreEnabled || !restoreCommandAvailable || restoreUnavailable}
                title={
                  !restoreCommandAvailable || restoreUnavailable
                    ? 'File restore is unavailable.'
                    : fileRestoreEnabled
                      ? undefined
                      : 'File restore stays off unless this thread has its own isolated checkout.'
                }
                onClick={() => {
                  if (!fileRestoreEnabled || !restoreCommandAvailable || restoreUnavailable || !onRestoreFiles) return;
                  void Promise.resolve(onRestoreFiles(item.id))
                    .then(() => {
                      setRestoreError(null);
                      setRewindOpen(false);
                      onEditUserMessage(item.text);
                    })
                    .catch((error: unknown) => {
                      const text = restoreErrorText(error);
                      setRestoreError(text);
                      if (restoreCommandMissing(text)) setRestoreUnavailable(true);
                    });
                }}
              >
                <FileCodeIcon size={12} />
                <span>Restore files too</span>
              </button>
              {restoreError ? <p role="alert">{restoreError}</p> : null}
            </div>
          ) : null}
        </div>

        {/* User Attachments */}
        {item.attachments && item.attachments.length > 0 && (
          <ul className="chat-attachments">
            {(item.attachments as any[]).map((att, i) => (
              <li key={i} className="chat-attachment">
                <AttachmentPreviewThumb
                  attachment={att}
                  threadId={threadId}
                  alt={att.displayName || 'Attachment'}
                  className="chat-attachment__thumb"
                  fallback={<FileCodeIcon size={12} className="chat-attachment__icon" />}
                />
                <span>{att.displayName || 'Attachment'}</span>
                {att.byteSize && <small>{formatBytes(att.byteSize)}</small>}
              </li>
            ))}
          </ul>
        )}

        {item.inputSource === 'voice' && (
          <span
            className="chat-user-row__voice-badge"
            title="Enviado por voz"
            aria-label="Mensaje por voz"
          >
            <MicIcon size={11} />
            <span>Voz</span>
          </span>
        )}

        <p
          className={folded ? 'chat-user-row__text chat-user-row__text--folded' : 'chat-user-row__text'}
          onCopy={(event) => {
            if (!draftHasCitation(item.text)) return;
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) return;
            const holder = document.createElement('div');
            holder.appendChild(selection.getRangeAt(0).cloneContents());
            const selected = citationTextFromNodes(holder);
            if (!draftHasCitation(selected)) return;
            event.preventDefault();
            writeCitationClipboard(event.clipboardData, selected);
          }}
        >
          {draftHasCitation(item.text)
            ? splitDraft(item.text).map((part, index) =>
                part.kind === 'text' ? (
                  <span key={`text-${index}`}>{part.text}</span>
                ) : (
                  <AssistantCitationChip key={`cite-${index}`} citation={part.citation} token={part.token} />
                ),
              )
            : item.text}
        </p>
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
    if (cleanAssistantText.trim().length === 0) return null;

    return (
      <motion.div
        ref={(node) => {
          assistantRef.current = node;
          if (node) node.dataset.messageId = item.id;
        }}
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
        <div id={item.id} data-message-id={item.id}>
        {!item.streaming && cleanAssistantText.trim().length > 0 && (
          <div className="chat-turn__actions">
            {citation && (
              <button
                type="button"
                className="chat-turn__action-btn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent('kite:cite', { detail: { messageId: item.id, quote: citation } }),
                  );
                  window.getSelection()?.removeAllRanges();
                  setCitation(null);
                }}
              >
                Quote in composer
              </button>
            )}
            <button
              type="button"
              className="chat-turn__action-btn"
              title={copiedAssistant ? 'Copied!' : 'Copy response'}
              onClick={() => {
                navigator.clipboard?.writeText(cleanAssistantText);
                setCopiedAssistant(true);
                setTimeout(() => setCopiedAssistant(false), 1500);
              }}
            >
              {copiedAssistant ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              <span>{copiedAssistant ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        )}
        <MarkdownMessage text={displayedAssistantText} workspaceId={(item as any).workspaceId || null} />
        </div>
      </motion.div>
    );
  }

  // Reasoning Row
  if (item.kind === 'reasoning') {
    // A thought with no text yet is not rendered: the brain appears once the provider sends it.
    if (item.text.trim().length === 0) return null;
    const thoughtSummary = liveThoughtLine(item.text);
    const thoughtRemainder = reasoningPreviewRemainder(item.text, thoughtSummary);
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
          {item.streaming && !expandedReasoning && thoughtRemainder.length > 0 && (
            <span className="chat-reasoning-row__preview">{thoughtRemainder}</span>
          )}
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
    if (item.toolKind === 'subagent' || item.subagentMeta) {
      if (isHookBlockedInvokeNoise(item)) {
        return null;
      }
      const matchedRun =
        matchedSubagentRun !== undefined
          ? matchedSubagentRun
          : matchSubagentRun(item, dedupeSubagentRuns(subagentRuns));
      if (isItemFailed(item, matchedRun)) {
        return (
          <SubagentFailureDisclosure
            items={[item]}
            runs={[matchedRun]}
            threadId={threadId}
            workspaceId={workspaceId}
            enter={enter}
          />
        );
      }
      return (
        <SubagentActivityCard
          item={item}
          threadId={threadId}
          workspaceId={workspaceId}
          run={matchedRun}
          enter={enter}
        />
      );
    }
    if (item.toolKind === 'swarm' || item.swarmMeta) {
      return (
        <SwarmActivityCard
          item={item}
          threadId={threadId}
          workspaceId={workspaceId}
          swarmState={swarmState}
          enter={enter}
        />
      );
    }
    const inlineMcpApp = resolveInlineMcpApp(item);
    if (inlineMcpApp) {
      return (
        <div className="chat-work-entry-app">
          <ChatWorkEntry item={item} running={item.streaming} enter={enter} />
          <McpAppFrame
            key={`chat-${item.id}`}
            mode="inline"
            serverName={inlineMcpApp.serverName}
            resourceUri={inlineMcpApp.resourceUri}
            toolName={inlineMcpApp.toolName}
            title={inlineMcpApp.title ?? item.title ?? inlineMcpApp.toolName ?? 'Extension App'}
            workspaceId={workspaceId}
            toolInput={inlineMcpApp.input ?? null}
            toolResult={inlineMcpApp.result ?? null}
            instanceId={`chat-${item.id}`}
          />
        </div>
      );
    }
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
    if (isHiddenNoteItem(item)) {
      return null;
    }
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

function areChatItemsVisuallyEqual(prev: ChatItemWithMcpApp, next: ChatItemWithMcpApp): boolean {
  if (prev === next) return true;
  if (
    prev.id !== next.id ||
    prev.kind !== next.kind ||
    prev.text !== next.text ||
    prev.title !== next.title ||
    prev.detail !== next.detail ||
    prev.status !== next.status ||
    Boolean(prev.streaming) !== Boolean(next.streaming) ||
    prev.exitCode !== next.exitCode ||
    prev.durationSeconds !== next.durationSeconds ||
    prev.addedLines !== next.addedLines ||
    prev.removedLines !== next.removedLines ||
    prev.filePath !== next.filePath ||
    prev.command !== next.command ||
    prev.toolName !== next.toolName ||
    prev.toolKind !== next.toolKind ||
    prev.serverName !== next.serverName ||
    prev.createdAtUnixMs !== next.createdAtUnixMs ||
    Boolean(prev.internalDispatch) !== Boolean(next.internalDispatch) ||
    prev.delegatedThreadId !== next.delegatedThreadId ||
    prev.delegatedMode !== next.delegatedMode ||
    (prev as { workspaceId?: string | null }).workspaceId !==
      (next as { workspaceId?: string | null }).workspaceId ||
    prev.handoffOffer !== next.handoffOffer
  ) {
    return false;
  }
  const prevAtts = prev.attachments ?? [];
  const nextAtts = next.attachments ?? [];
  if (prevAtts.length !== nextAtts.length) return false;
  for (let i = 0; i < prevAtts.length; i += 1) {
    if (prevAtts[i] !== nextAtts[i]) return false;
  }
  if (prev.subagentMeta !== next.subagentMeta) {
    if (!prev.subagentMeta || !next.subagentMeta) return false;
    if (
      prev.subagentMeta.subagentId !== next.subagentMeta.subagentId ||
      prev.subagentMeta.typeName !== next.subagentMeta.typeName ||
      prev.subagentMeta.provider !== next.subagentMeta.provider ||
      prev.subagentMeta.workspaceMode !== next.subagentMeta.workspaceMode ||
      prev.subagentMeta.prompt !== next.subagentMeta.prompt ||
      prev.subagentMeta.status !== next.subagentMeta.status ||
      prev.subagentMeta.stepCount !== next.subagentMeta.stepCount ||
      prev.subagentMeta.latestActivity !== next.subagentMeta.latestActivity ||
      prev.subagentMeta.childThreadId !== next.subagentMeta.childThreadId ||
      prev.subagentMeta.transcriptUri !== next.subagentMeta.transcriptUri ||
      prev.subagentMeta.role !== next.subagentMeta.role ||
      prev.subagentMeta.model !== next.subagentMeta.model
    ) {
      return false;
    }
  }
  if (prev.swarmMeta !== next.swarmMeta) return false;
  if (prev.mcpApp !== next.mcpApp) {
    if (!prev.mcpApp || !next.mcpApp) return false;
    if (
      prev.mcpApp.serverName !== next.mcpApp.serverName ||
      prev.mcpApp.resourceUri !== next.mcpApp.resourceUri ||
      prev.mcpApp.toolName !== next.mcpApp.toolName ||
      prev.mcpApp.title !== next.mcpApp.title ||
      prev.mcpApp.input !== next.mcpApp.input ||
      prev.mcpApp.result !== next.mcpApp.result
    ) {
      return false;
    }
  }
  if (prev._meta !== next._meta || prev.meta !== next.meta) return false;
  return true;
}

function areChatItemRowPropsEqual(prev: ChatItemRowProps, next: ChatItemRowProps): boolean {
  if (
    prev.threadId !== next.threadId ||
    prev.workspaceId !== next.workspaceId ||
    prev.enter !== next.enter
  ) {
    return false;
  }
  if (
    next.item.kind === 'user' &&
    (prev.fileRestoreEnabled !== next.fileRestoreEnabled ||
      prev.restoreCommandAvailable !== next.restoreCommandAvailable ||
      prev.onEditUserMessage !== next.onEditUserMessage ||
      prev.onRewindTranscript !== next.onRewindTranscript ||
      prev.onRestoreFiles !== next.onRestoreFiles)
  ) {
    return false;
  }
  if (!areChatItemsVisuallyEqual(prev.item, next.item)) return false;
  const isTool = next.item.kind === 'tool' || next.item.kind === 'command';
  const usesSubagents = isTool && (next.item.toolKind === 'subagent' || Boolean(next.item.subagentMeta));
  const usesSwarm = isTool && (next.item.toolKind === 'swarm' || Boolean(next.item.swarmMeta));
  if (usesSubagents) {
    const prevRun =
      prev.matchedSubagentRun !== undefined
        ? prev.matchedSubagentRun
        : matchSubagentRun(prev.item, dedupeSubagentRuns(prev.subagentRuns));
    const nextRun =
      next.matchedSubagentRun !== undefined
        ? next.matchedSubagentRun
        : matchSubagentRun(next.item, dedupeSubagentRuns(next.subagentRuns));
    if (!areSubagentRunCardsEqual(prevRun, nextRun)) return false;
  }
  if (usesSwarm && prev.swarmState !== next.swarmState) return false;
  return true;
}

export const ChatItemRow = React.memo(ChatItemRowInner, areChatItemRowPropsEqual);
ChatItemRow.displayName = 'ChatItemRow';

