import React, { useState, useRef } from 'react';
import { motion } from 'motion/react';
import { tweens } from '../../../motion/standard/tokens';
import {
  AlertCircleIcon,
  FileCodeIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
} from './ChatIcons';
import type { ChatItem, SubagentRun, SwarmState } from '../../../types';
import { dedupeSubagentRuns, SubagentActivityCard } from './SubagentActivityCard';
import { SwarmActivityCard } from './SwarmActivityCard';
import { ActivityGlyph } from './activityGlyph';
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
  liveActivityRowIndex,
  liveThoughtLine,
  reasoningPreviewRemainder,
  sanitizeAssistantProtocolText,
  userMessageFolds,
  type TranscriptRow,
} from './chatItemHelpers';
import { ChatWorkEntry, ChatWorkGroup } from './ChatWorkLog';
import { AssistantCitationChip } from './ChatCitationChip';

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

export const ChatItemRow: React.FC<{
  item: ChatItem;
  threadId?: string;
  workspaceId?: string | null;
  subagentRuns?: SubagentRun[] | null;
  swarmState?: SwarmState | null;
  /** True when this row is new and should animate in. */
  enter?: boolean;
  onEditUserMessage?: (text: string) => void;
  onRewindTranscript?: (messageId: string) => void | Promise<void>;
  onRestoreFiles?: (messageId: string) => void | Promise<void>;
  fileRestoreEnabled?: boolean;
  /** False when the restore command cannot be invoked. Defaults to available. */
  restoreCommandAvailable?: boolean;
}> = ({
  item,
  threadId,
  workspaceId = null,
  subagentRuns = null,
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
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreUnavailable, setRestoreUnavailable] = useState(false);
  const [copiedAssistant, setCopiedAssistant] = useState(false);
  const [citation, setCitation] = useState<string | null>(null);
  const assistantRef = useRef<HTMLDivElement | null>(null);

  // User row: no "You" or timestamp header
  if (item.kind === 'user') {
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
        <div className="chat-turn__actions">
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
              onClick={() => setRewindOpen((open) => !open)}
            >
              <PencilIcon size={12} />
              <span>Edit from here</span>
            </button>
          )}
          {rewindOpen && onEditUserMessage ? (
            <div className="chat-rewind" role="dialog" aria-label="Edit from here">
              <button
                type="button"
                onClick={() => {
                  onEditUserMessage(item.text);
                  if (!onRewindTranscript) return;
                  void Promise.resolve(onRewindTranscript(item.id)).catch((error: unknown) => {
                    setRestoreError(restoreErrorText(error));
                  });
                }}
              >
                Rewind and keep file changes
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
                      onEditUserMessage(item.text);
                    })
                    .catch((error: unknown) => {
                      const text = restoreErrorText(error);
                      setRestoreError(text);
                      if (restoreCommandMissing(text)) setRestoreUnavailable(true);
                    });
                }}
              >
                Restore files too
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
                <FileCodeIcon size={12} className="chat-attachment__icon" />
                <span>{att.displayName || 'Attachment'}</span>
                {att.byteSize && <small>{formatBytes(att.byteSize)}</small>}
              </li>
            ))}
          </ul>
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
    const rawText = item.text.includes('<proposed_plan>') && item.text.includes('</proposed_plan>')
      ? item.text.replace('<proposed_plan>', '\n').replace('</proposed_plan>', '\n')
      : item.text;

    const cleanText = sanitizeAssistantProtocolText(rawText);

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
        {!item.streaming && cleanText.trim().length > 0 && (
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
                navigator.clipboard?.writeText(cleanText);
                setCopiedAssistant(true);
                setTimeout(() => setCopiedAssistant(false), 1500);
              }}
            >
              {copiedAssistant ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              <span>{copiedAssistant ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        )}
        <MarkdownMessage text={cleanText} workspaceId={(item as any).workspaceId || null} />
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
      const dedupedRuns = dedupeSubagentRuns(subagentRuns);
      const matchedRun =
        dedupedRuns.find(
          (r) =>
            (item.subagentMeta?.subagentId && r.subagentId === item.subagentMeta.subagentId) ||
            (item.subagentMeta?.childThreadId && r.childThreadId === item.subagentMeta.childThreadId) ||
            r.parentToolCallId === item.id ||
            (item.subagentMeta?.role &&
              r.role &&
              r.role.trim().toLowerCase() === item.subagentMeta.role.trim().toLowerCase() &&
              dedupedRuns.length === 1),
        ) ?? null;
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
    if (
      !item.streaming &&
      item.text.trim() === 'The provider has not sent an update. Stop the turn if this stays quiet.'
    ) {
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

