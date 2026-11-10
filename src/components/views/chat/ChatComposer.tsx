import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import './composer/composer.css';
import {
  StopIcon,
  CloseIcon,
  FileCodeIcon,
  ArrowUpIcon,
  MicIcon,
} from './ChatIcons';
import {
  ChatProvider,
  ChatMode,
  ChatAttachment,
  ApprovalRequest,
  AUTOMATIC_MODEL_ID,
  formatTokens,
  formatBytes,
} from './types';
import type { ChatItem } from '../../../types';
import { insertQuoteAtCaret } from './citeDraft';
import { AssistantCitationChip } from './ChatItemRow';
import {
  citationSendLength,
  draftHasCitation,
  expandCitations,
  readCitationClipboard,
  writeCitationClipboard,
  type CitationInput,
} from './citationChip';
import {
  composerPartOffset,
  deleteComposerChipKey,
  draftHasMention,
  expandMentions,
  filterMentionMenu,
  insertDropAtCaret,
  insertMentionAtCaret,
  KITE_FILES_MIME,
  KITE_THREAD_MIME,
  mentionChipLabel,
  mentionFromTerminalExcerpt,
  mentionQueryAt,
  readMentionClipboard,
  removeComposerPart,
  replaceComposerCitationComment,
  replaceComposerTextPart,
  splitComposerDraft,
  writeMentionClipboard,
  type MentionPayload,
} from './mentionChip';
import { isControlDeclared, isProviderDeclared, undeclaredReason } from '../../../lib/session/declaration';
import type { DriverDeclaration } from '../../../lib/session/types';
import { ChatApprovalCard } from './ChatApprovalCard';
import { invokeCommand, listConnections } from '../../../lib/ipc';
import {
  verifiedSpawnConnections,
  type ConnectionCandidate,
} from './connectionBinding';
import { ComposerSurface } from './composer/ComposerSurface';
import { ComposerControlSeparator } from './composer/ComposerControl';
import { ModelPickerPopover } from './composer/ModelPickerPopover';
import { catalogEmptyMessage } from './catalogEmptyState';
import { EffortSliderPopover } from './composer/EffortSliderPopover';
import { resolvePrimaryAction } from './composerPrimaryAction';
import { ComposerCommandMenu } from './ComposerCommandMenu';
import { useVoiceSession } from '../../../lib/operator/voice/voiceSessionStore';
import { VoiceModeFooterBar } from './composer/VoiceModeFooterBar';
import {
  composerGoalStop,
  restoreStash,
  slashIntent,
  stashDraft,
  stashFileRestorable,
  type StashEntry,
} from './threadInteraction';
import { pasteBecomesFile } from './threadInteraction';
import { consumeFreshContext, resolveSessionCommand } from './sessionCommands';
import { ComposerContextStrip } from './composer/ComposerContextStrip';
import { AttachMenuPopover } from './composer/AttachMenuPopover';
import { PermissionPickerPopover } from './composer/PermissionPickerPopover';
import { WorkModePickerPopover } from './composer/WorkModePickerPopover';
import { ConnectionPickerPopover } from './composer/ConnectionPickerPopover';

export interface ChatComposerProps {
  threadId: string;
  agentName?: string;
  engineLabel?: string;
  threadMode: ChatMode;
  threadPlan?: boolean;
  threadProvider: ChatProvider;
  threadModel: string | null;
  threadEffort?: string | null;
  threadAgent?: string | null;
  threadConnectionId?: string | null;
  threadItems?: ChatItem[];
  threadBranch?: string | null;
  threadWorkspaceName?: string | null;
  workspaces?: Array<{ id: string; name: string }>;
  branches?: string[];
  onSwitchBranch?: (branch: string) => void;
  onCreateBranch?: (branch: string) => void;
  onSelectWorkspace?: (wsId: string) => void;
  declaration: DriverDeclaration;
  running: boolean;
  paused?: boolean;
  prompt: string;
  attachments: ChatAttachment[];
  totalTokens: number;
  isRefreshingModels?: boolean;
  catalogState?: 'missing-binary' | 'signed-out' | 'loading' | 'empty' | null;
  onRefreshModels?: (provider: ChatProvider) => void;
  ensureDynamicModels?: (provider: ChatProvider) => void;
  ensureDynamicAgents?: (provider: ChatProvider) => void;
  activeDropdown?: { threadId: string; type: 'provider' | 'model' | 'mode' } | null;
  pendingApproval?: ApprovalRequest | null;
  onChangePrompt: (val: string) => void;
  onSend: () => void;
  /** Called when the next real message should start a fresh provider session. */
  onFreshContext?: () => void;
  /** Asks a supporting provider to compact. Does not invent a protocol frame. */
  onCompact?: () => void;
  onQueue?: (text: string) => void;
  onStop: () => void;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
  onStageFiles: (files: File[]) => void;
  onStagePaths: (paths: string[]) => void;
  onRemoveAttachment: (resId: string) => void;
  onDropdownToggle?: (type: 'provider' | 'model' | 'mode') => void;
  onUpdateConfig: (patch: {
    provider?: ChatProvider;
    mode?: ChatMode;
    model?: string | null;
    effort?: string | null;
    plan?: boolean;
    agent?: string | null;
    connectionId?: string | null;
  }) => void;
  onSelectConnection?: (connectionId: string) => void;
  files?: string[];
  threads?: Array<{ id: string; title?: string }>;
  models?: string[];
  skills?: string[];
  goal?: string | null;
  onGoalStop?: (result: { goal: string | null; paused: boolean; turnEnded: boolean }) => void;
  initialStashes?: StashEntry[];
  stashEnvironment?: string;
  onApprovalDecision?: (
    decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
    requestId: string
  ) => void;
  onSendVoiceTurn?: (text: string) => void;
}

function extractUserPromptHistory(items: ChatItem[] = []): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (item.kind !== 'user') continue;
    const text = item.text?.trim() ?? '';
    if (text.length !== 0 && result[result.length - 1] !== text) {
      result.push(text);
    }
  }
  return result;
}

function getNextHistoryIndex(
  length: number,
  currentIndex: number | null,
  direction: 'older' | 'newer'
): number | null | undefined {
  if (length === 0) return undefined;
  if (direction === 'older') {
    return currentIndex === null ? length - 1 : currentIndex > 0 ? currentIndex - 1 : undefined;
  }
  if (currentIndex !== null) {
    return currentIndex + 1 < length ? currentIndex + 1 : null;
  }
  return undefined;
}

function isNoNewlineBefore(text: string, pos: number): boolean {
  return !text.slice(0, pos).includes('\n');
}

function isNoNewlineAfter(text: string, pos: number): boolean {
  return !text.slice(pos).includes('\n');
}

function isPlainKey(e: React.KeyboardEvent): boolean {
  return !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
}

function MentionDraftChip({
  mention,
  token,
  onRemove,
}: {
  mention: MentionPayload;
  token: string;
  onRemove: () => void;
}) {
  return (
    <span
      className="citation-chip rounded-sm"
      contentEditable={false}
      data-mention-token={token}
      data-mention-kind={mention.kind}
      onCopy={(event) => {
        event.preventDefault();
        event.stopPropagation();
        writeMentionClipboard(event.clipboardData, token);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Backspace' || event.key === 'Delete') {
          event.preventDefault();
          onRemove();
        }
      }}
    >
      <span className="citation-chip__jump">{mentionChipLabel(mention)}</span>
    </span>
  );
}

function CitationDraftEditor({
  prompt,
  onChange,
  onKeyDown,
  onPaste,
  onCopy,
  pendingCaret,
  onPendingCaretApplied,
  onCaret,
  onDraftCaret,
  caretRef,
  testId,
}: {
  prompt: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onCopy: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  pendingCaret: number | null;
  onPendingCaretApplied: () => void;
  onCaret: (caret: number) => void;
  onDraftCaret: (caret: number) => void;
  caretRef: React.MutableRefObject<{ start: number; end: number }>;
  testId?: string;
}) {
  const parts = splitComposerDraft(prompt);
  const fields = useRef<Array<HTMLTextAreaElement | null>>([]);

  useLayoutEffect(() => {
    if (pendingCaret === null) return;
    let cursor = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const size = part.kind === 'text' ? part.text.length : part.token.length;
      if (part.kind === 'text' && pendingCaret <= cursor + size) {
        const field = fields.current[index];
        const local = Math.max(0, pendingCaret - cursor);
        field?.focus();
        field?.setSelectionRange(local, local);
        caretRef.current = { start: cursor + local, end: cursor + local };
        break;
      }
      cursor += size;
    }
    onPendingCaretApplied();
  }, [caretRef, onPendingCaretApplied, parts, pendingCaret]);

  return (
    <div className="kite-composer-draft">
      {parts.map((part, index) => {
        if (part.kind === 'citation') {
          return (
            <AssistantCitationChip
              key={`cite-${index}-${part.citation.comment}`}
              citation={part.citation}
              token={part.token}
              onEditComment={(comment) => onChange(replaceComposerCitationComment(prompt, index, comment))}
              onRemove={() => {
                const caret = composerPartOffset(parts, index);
                caretRef.current = { start: caret, end: caret };
                onCaret(caret);
                onDraftCaret(caret);
                onChange(removeComposerPart(prompt, index));
              }}
            />
          );
        }
        if (part.kind === 'mention') {
          return (
            <MentionDraftChip
              key={`mention-${index}-${part.mention.kind}-${part.mention.id}`}
              mention={part.mention}
              token={part.token}
              onRemove={() => {
                const caret = composerPartOffset(parts, index);
                caretRef.current = { start: caret, end: caret };
                onCaret(caret);
                onDraftCaret(caret);
                onChange(removeComposerPart(prompt, index));
              }}
            />
          );
        }
        const offset = composerPartOffset(parts, index);
        return (
          <textarea
            key={`text-${index}`}
            ref={(node) => {
              fields.current[index] = node;
            }}
            data-testid={index === 0 ? testId : undefined}
            className="kite-composer-textarea kite-composer-draft__text"
            value={part.text}
            rows={1}
            onSelect={(event) => {
              const start = offset + (event.currentTarget.selectionStart ?? 0);
              const end = offset + (event.currentTarget.selectionEnd ?? start);
              caretRef.current = { start, end };
              onDraftCaret(start);
            }}
            onChange={(event) => {
              const local = event.target.selectionStart ?? event.target.value.length;
              const nextCaret = offset + local;
              caretRef.current = { start: nextCaret, end: nextCaret };
              onDraftCaret(nextCaret);
              onChange(replaceComposerTextPart(prompt, index, event.target.value));
            }}
            onKeyDown={(event) => {
              const localStart = event.currentTarget.selectionStart ?? 0;
              const localEnd = event.currentTarget.selectionEnd ?? localStart;
              const draftStart = offset + localStart;
              const draftEnd = offset + localEnd;
              caretRef.current = { start: draftStart, end: draftEnd };
              onDraftCaret(draftStart);
              if ((event.key === 'Backspace' || event.key === 'Delete') && isPlainKey(event)) {
                const deleted = deleteComposerChipKey(prompt, draftStart, draftEnd, event.key);
                if (deleted) {
                  event.preventDefault();
                  caretRef.current = { start: deleted.caret, end: deleted.caret };
                  onCaret(deleted.caret);
                  onDraftCaret(deleted.caret);
                  onChange(deleted.text);
                  return;
                }
              }
              onKeyDown(event);
            }}
            onPaste={onPaste}
            onCopy={onCopy}
          />
        );
      })}
    </div>
  );
}

const ControlReason: React.FC<{ reason: string }> = ({ reason }) => (
  <span className="sr-only">{reason}</span>
);

export const ChatComposer: React.FC<ChatComposerProps> = ({
  threadId,
  agentName,
  engineLabel: _engineLabel,
  threadMode,
  threadPlan,
  threadProvider,
  threadModel,
  threadEffort,
  threadAgent,
  threadConnectionId,
  threadItems = [],
  threadBranch,
  threadWorkspaceName,
  workspaces,
  branches = [],
  onSwitchBranch,
  onCreateBranch,
  onSelectWorkspace,
  declaration,
  running,
  paused = false,
  prompt,
  attachments,
  totalTokens,
  catalogState = null,
  ensureDynamicModels,
  ensureDynamicAgents,
  pendingApproval,
  onChangePrompt,
  onSend,
  onFreshContext,
  onCompact,
  onQueue,
  onStop,
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onUpdateConfig,
  onSelectConnection,
  onApprovalDecision,
  files = [],
  threads = [],
  models = [],
  skills = [],
  goal = null,
  onGoalStop,
  initialStashes,
  stashEnvironment = '',
  onSendVoiceTurn,
}) => {
  const voice = useVoiceSession();
  const isVoiceModeActive =
    (voice.phase === 'active' || voice.phase === 'starting') &&
    (voice.boundThreadId === threadId || (voice.activeSurface === 'thread' && !voice.boundThreadId));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef({ start: 0, end: 0 });
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [draftCaret, setDraftCaret] = useState(0);
  const [stashes, setStashes] = useState<StashEntry[]>(initialStashes ?? []);
  const [stashFileNotice, setStashFileNotice] = useState<ReturnType<typeof stashFileRestorable>>(null);
  const [sideQuestion, setSideQuestion] = useState<string | null>(null);
  const [newSessionArmed, setNewSessionArmed] = useState(false);
  const [compactNotice, setCompactNotice] = useState<string | null>(null);

  useEffect(() => {
    setNewSessionArmed(false);
    setCompactNotice(null);
  }, [threadId]);
  const footerRef = useRef<HTMLDivElement>(null);

  const [connectionCandidates, setConnectionCandidates] = useState<ConnectionCandidate[]>([]);

  useEffect(() => {
    let active = true;
    void listConnections().then((connections) => {
      if (active) setConnectionCandidates(verifiedSpawnConnections(threadProvider, connections));
    });
    return () => {
      active = false;
    };
  }, [threadProvider]);

  useEffect(() => {
    ensureDynamicModels?.(threadProvider);
    ensureDynamicAgents?.(threadProvider);
  }, [ensureDynamicModels, ensureDynamicAgents, threadProvider]);

  const [dropKind, setDropKind] = useState<'attach' | 'mention' | 'prompt' | null>(null);

  // Dictation state
  const [dictationAvailability, setDictationAvailability] = useState<{
    canStart: boolean;
    canRequestPermission: boolean;
    guidance: string;
  } | null>(null);
  const [dictationState, setDictationState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [followUpFlip, setFollowUpFlip] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setFollowUpFlip(event.type === 'keydown');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const dictationReqIdRef = useRef<string | null>(null);
  const dictationPollRef = useRef<number | null>(null);

  // Prompt History navigation state
  const historyStateRef = useRef<{ owner: string; index: number | null; draft: string }>({
    owner: threadId,
    index: null,
    draft: '',
  });

  useEffect(() => {
    historyStateRef.current = { owner: threadId, index: null, draft: '' };
  }, [threadId]);

  useEffect(() => {
    const onCite = (event: Event) => {
      const detail = (event as CustomEvent<CitationInput>).detail;
      if (typeof detail !== 'string' && (detail === null || typeof detail !== 'object')) return;
      const area = textareaRef.current;
      const usingField = Boolean(area) && !draftHasCitation(prompt);
      const start = usingField ? (area?.selectionStart ?? prompt.length) : caretRef.current.start;
      const end = usingField ? (area?.selectionEnd ?? start) : caretRef.current.end;
      const next = insertQuoteAtCaret(prompt, start, end, detail);
      caretRef.current = { start: next.caret, end: next.caret };
      setPendingCaret(next.caret);
      onChangePrompt(next.text);
      window.requestAnimationFrame(() => {
        const field = textareaRef.current;
        if (!field || draftHasCitation(next.text)) return;
        field.focus();
        field.setSelectionRange(next.caret, next.caret);
      });
    };
    window.addEventListener('kite:cite', onCite);
    return () => window.removeEventListener('kite:cite', onCite);
  }, [onChangePrompt, prompt]);

  useEffect(() => {
    const onExcerpt = (event: Event) => {
      const mention = mentionFromTerminalExcerpt((event as CustomEvent).detail);
      if (!mention) return;
      const area = textareaRef.current;
      const plain = Boolean(area) && !draftHasCitation(prompt) && !draftHasMention(prompt);
      const start = plain ? (area?.selectionStart ?? caretRef.current.start) : caretRef.current.start;
      const end = plain ? (area?.selectionEnd ?? start) : caretRef.current.end;
      const next = insertMentionAtCaret(prompt, start, end, mention);
      caretRef.current = { start: next.caret, end: next.caret };
      setDraftCaret(next.caret);
      setPendingCaret(next.caret);
      onChangePrompt(next.text);
    };
    window.addEventListener('kite:terminal-excerpt', onExcerpt);
    return () => window.removeEventListener('kite:terminal-excerpt', onExcerpt);
  }, [onChangePrompt, prompt]);

  useLayoutEffect(() => {
    if (draftHasCitation(prompt) || draftHasMention(prompt) || pendingCaret === null) return;
    const field = textareaRef.current;
    if (!field) return;
    const caret = Math.min(pendingCaret, field.value.length);
    field.focus();
    field.setSelectionRange(caret, caret);
    setPendingCaret(null);
  }, [pendingCaret, prompt]);

  // Dynamic textarea height
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = '52px';
      el.style.height = `${Math.min(240, Math.max(52, el.scrollHeight))}px`;
    }
  }, [prompt]);

  // Load dictation availability on mount
  useEffect(() => {
    let isMounted = true;
    invokeCommand<any>('read_dictation_availability', { supportedSchemaVersion: 1 })
      .then((avail) => {
        if (isMounted && avail) {
          setDictationAvailability({
            canStart: Boolean(avail.canStart),
            canRequestPermission: Boolean(avail.canRequestPermission),
            guidance: avail.guidance || '',
          });
        }
      })
      .catch(() => {
        if (isMounted) {
          setDictationAvailability({
            canStart: false,
            canRequestPermission: false,
            guidance: 'Dictation is unavailable on this computer.',
          });
        }
      });

    return () => {
      isMounted = false;
      if (dictationPollRef.current) {
        window.clearInterval(dictationPollRef.current);
        dictationPollRef.current = null;
      }
      if (dictationReqIdRef.current) {
        invokeCommand('cancel_dictation', {
          id: dictationReqIdRef.current,
          supportedSchemaVersion: 1,
        }).catch(() => undefined);
        dictationReqIdRef.current = null;
        voice.resumeFromDictation();
      }
    };
  }, []);

  const toggleDictation = async () => {
    if (running) return;
    setDictationError(null);

    if (dictationState === 'recording' || dictationState === 'starting') {
      const id = dictationReqIdRef.current;
      if (!id) return;
      setDictationState('transcribing');
      try {
        await invokeCommand('stop_dictation', { id, supportedSchemaVersion: 1 });
      } catch (err: any) {
        setDictationError(err?.message || 'Error stopping dictation.');
        setDictationState('idle');
        dictationReqIdRef.current = null;
        voice.resumeFromDictation();
      }
      return;
    }

    if (dictationState !== 'idle') return;

    const id = crypto.randomUUID();
    dictationReqIdRef.current = id;
    setDictationState('starting');
    voice.pauseForDictation();

    try {
      await invokeCommand('start_dictation', { id, supportedSchemaVersion: 1 });
      setDictationState('recording');

      dictationPollRef.current = window.setInterval(async () => {
        if (dictationReqIdRef.current !== id) {
          if (dictationPollRef.current) window.clearInterval(dictationPollRef.current);
          return;
        }
        try {
          const take = await invokeCommand<any>('read_dictation', { id, supportedSchemaVersion: 1 });
          if (!take) return;
          if (take.phase === 'recording') {
            setDictationState('recording');
          } else if (take.phase === 'transcribing') {
            setDictationState('transcribing');
          } else if (take.phase === 'done') {
            if (dictationPollRef.current) {
              window.clearInterval(dictationPollRef.current);
              dictationPollRef.current = null;
            }
            dictationReqIdRef.current = null;
            setDictationState('idle');
            voice.resumeFromDictation();
            const transcript = (take.transcript || '').trim();
            if (transcript) {
              onChangePrompt(prompt.trim() ? `${prompt.trimEnd()} ${transcript}` : transcript);
            }
          } else if (take.phase === 'error' || take.phase === 'cancelled') {
            if (dictationPollRef.current) {
              window.clearInterval(dictationPollRef.current);
              dictationPollRef.current = null;
            }
            dictationReqIdRef.current = null;
            setDictationState('idle');
            voice.resumeFromDictation();
            if (take.error?.message) {
              setDictationError(take.error.message);
            } else if (take.message) {
              setDictationError(take.message);
            }
          }
        } catch {
          // Keep polling
        }
      }, 250);
    } catch (err: any) {
      dictationReqIdRef.current = null;
      setDictationState('idle');
      voice.resumeFromDictation();
      setDictationError(err?.message || 'Dictation could not start.');
    }
  };

  const insertAtCursor = (insertion: string, isMention: boolean = false) => {
    const target = textareaRef.current;
    const start = target?.selectionStart ?? caretRef.current.start;
    const end = target?.selectionEnd ?? caretRef.current.end;
    const before = prompt.slice(0, start);
    const formatted = isMention
      ? `${before.length === 0 || /\s$/u.test(before) ? '' : ' '}@${insertion} `
      : insertion;
    const next = `${before}${formatted}${prompt.slice(end)}`;
    const nextCaret = start + formatted.length;
    onChangePrompt(next);
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const getDropKind = (event: React.DragEvent): 'attach' | 'mention' | 'prompt' | null => {
    if (running) return null;
    const types = event.dataTransfer?.types ?? [];
    if (types.includes('application/x-kite-prompt')) return 'prompt';
    if (types.includes(KITE_THREAD_MIME) || types.includes(KITE_FILES_MIME)) return 'mention';
    if (types.includes('Files')) return 'attach';
    return null;
  };

  const handleDrop = (event: React.DragEvent) => {
    setDropKind(null);
    if (running) return;
    event.preventDefault();

    const types = event.dataTransfer?.types ?? [];

    if (types.includes('application/x-kite-prompt')) {
      const promptText =
        event.dataTransfer.getData('application/x-kite-prompt') ||
        event.dataTransfer.getData('text/plain');
      if (promptText) insertAtCursor(promptText, false);
      return;
    }

    if (types.includes(KITE_THREAD_MIME) || types.includes(KITE_FILES_MIME)) {
      const threadRaw = types.includes(KITE_THREAD_MIME) ? event.dataTransfer.getData(KITE_THREAD_MIME) : '';
      const mime = threadRaw ? KITE_THREAD_MIME : KITE_FILES_MIME;
      const raw = threadRaw || event.dataTransfer.getData(KITE_FILES_MIME);
      const area = textareaRef.current;
      const plain = Boolean(area) && !draftHasCitation(prompt) && !draftHasMention(prompt);
      const start = plain ? (area?.selectionStart ?? caretRef.current.start) : caretRef.current.start;
      const end = plain ? (area?.selectionEnd ?? start) : caretRef.current.end;
      const next = insertDropAtCaret(prompt, start, end, mime, raw);
      if (!next) return;
      caretRef.current = { start: next.caret, end: next.caret };
      setDraftCaret(next.caret);
      setPendingCaret(next.caret);
      onChangePrompt(next.text);
      return;
    }

    if (types.includes('Files')) {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      const paths = files
        .map((file) => (file as File & { path?: string }).path)
        .filter((path): path is string => Boolean(path));
      if (paths.length > 0) onStagePaths(paths);
      else onStageFiles(files);
    }
  };

  const handleHistoryKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const isUp = e.key === 'ArrowUp';
    if ((!isUp && e.key !== 'ArrowDown') || !isPlainKey(e)) return false;

    const target = e.currentTarget;
    const fullField = target.value === prompt;
    const selectionStart = fullField ? target.selectionStart : caretRef.current.start;
    const selectionEnd = fullField ? target.selectionEnd : caretRef.current.end;
    if (selectionStart !== selectionEnd) return false;

    if (isUp ? !isNoNewlineBefore(prompt, selectionStart) : !isNoNewlineAfter(prompt, selectionStart)) {
      return false;
    }

    const history = extractUserPromptHistory(threadItems);
    if (history.length === 0) return false;

    const currentIdx = historyStateRef.current.owner === threadId ? historyStateRef.current.index : null;
    const resolvedIdx = currentIdx !== null && prompt === history[currentIdx] ? currentIdx : null;

    if (resolvedIdx === null && isUp) {
      historyStateRef.current.draft = prompt;
    }

    const nextIdx = getNextHistoryIndex(history.length, resolvedIdx, isUp ? 'older' : 'newer');
    if (nextIdx !== undefined) {
      e.preventDefault();
      historyStateRef.current = {
        owner: threadId,
        index: nextIdx,
        draft: historyStateRef.current.draft,
      };
      const nextText = nextIdx === null ? historyStateRef.current.draft : (history[nextIdx] ?? '');
      onChangePrompt(nextText);
      requestAnimationFrame(() => {
        if (!fullField) return;
        target.focus();
        target.setSelectionRange(nextText.length, nextText.length);
      });
      return true;
    }
    return false;
  };

  const providerDeclared = isProviderDeclared(declaration, threadProvider);
  const providerReason = providerDeclared ? null : undeclaredReason(declaration, 'provider');

  const declaredModels = declaration.models ?? [];
  const liveModels = declaredModels.filter((model) => model.id !== AUTOMATIC_MODEL_ID);
  const modelReason =
    liveModels.length > 0
      ? null
      : catalogState
        ? catalogEmptyMessage(catalogState, threadProvider)
        : undeclaredReason(declaration, 'model');
  const currentModelOption = declaredModels.find((model) => model.id === threadModel);
  const currentModelName =
    !threadModel || threadModel === AUTOMATIC_MODEL_ID
      ? 'Automatic'
      : currentModelOption?.label || threadModel;

  const effortDeclared = isControlDeclared(declaration.effort);
  const effortReason = effortDeclared ? null : undeclaredReason(declaration, 'effort');

  const permissions = declaration.permission ?? [];
  const permissionDeclared = isControlDeclared(declaration.permission);
  const permissionReason = permissionDeclared ? null : undeclaredReason(declaration, 'permission');

  const measuredLength = citationSendLength(prompt);
  const draftOverLimit = measuredLength > 120_000;
  const canSend = !draftOverLimit && Boolean(prompt.trim() || attachments.length > 0);

  const composerPlaceholder = isVoiceModeActive
    ? 'Escribir en la sesión de voz…'
    : agentName
    ? running
      ? 'Write a follow-up while your agent works…'
      : `Message ${agentName}…`
    : running
    ? "Working — send when it's done, or stop it."
    : threadPlan
    ? 'Describe the work. You approve the plan before anything changes.'
    : threadMode === 'fullAccess'
    ? 'Describe the work. Edits and commands run without asking.'
    : threadMode === 'readOnly'
    ? 'Ask about the code. Nothing gets changed.'
    : 'Ask anything, or describe the change…';

  const onComposerCopy = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const fullField = field.value === prompt;
    const start = fullField ? (field.selectionStart ?? 0) : caretRef.current.start;
    const end = fullField ? (field.selectionEnd ?? start) : caretRef.current.end;
    const selected = prompt.slice(start, end);
    if (draftHasMention(selected)) {
      event.preventDefault();
      writeMentionClipboard(event.clipboardData, selected);
      return;
    }
    if (!draftHasCitation(selected)) return;
    event.preventDefault();
    writeCitationClipboard(event.clipboardData, selected);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (running) return;
    const dt = event.clipboardData;
    if (!dt) return;

    let files: File[] = Array.from(dt.files ?? []);
    if (files.length === 0 && dt.items) {
      const itemFiles = Array.from(dt.items)
        .filter((item) => item.kind === 'file' || item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (itemFiles.length > 0) files = itemFiles;
    }
    if (files.length > 0) {
      event.preventDefault();
      onStageFiles(files);
      return;
    }

    const mentioned = readMentionClipboard(dt);
    const kite = mentioned ?? readCitationClipboard(dt);
    if (kite) {
      event.preventDefault();
      const field = event.currentTarget;
      const fullField = !draftHasCitation(prompt) || field.value === prompt;
      const start = fullField ? (field.selectionStart ?? prompt.length) : caretRef.current.start;
      const end = fullField ? (field.selectionEnd ?? start) : caretRef.current.end;
      const next = `${prompt.slice(0, start)}${kite}${prompt.slice(end)}`;
      const caret = start + kite.length;
      caretRef.current = { start: caret, end: caret };
      setPendingCaret(caret);
      onChangePrompt(next);
      return;
    }

    if (typeof dt.getData !== 'function') return;
    const text = dt.getData('text/plain');
    if (!text) return;
    const flags = event.nativeEvent as { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
    const forceInline = Boolean((flags.ctrlKey || flags.metaKey) && flags.shiftKey);
    const bytes = new TextEncoder().encode(text).length;
    if (!pasteBecomesFile(bytes, measuredLength, text.length, forceInline)) return;
    event.preventDefault();
    onStageFiles([new File([text], 'pasted-text.txt', { type: 'text/plain' })]);
  };

  const deliverDraft = (mode: 'send' | 'queue') => {
    if (isVoiceModeActive && prompt.trim()) {
      const text = expandMentions(expandCitations(prompt)).trim();
      onChangePrompt('');
      if (onSendVoiceTurn) {
        onSendVoiceTurn(text);
      } else {
        onSend();
      }
      return;
    }

    const command = resolveSessionCommand(prompt, threadProvider);
    if (command.kind === 'compact') {
      onChangePrompt('');
      onCompact?.();
      return;
    }
    if (command.kind === 'refuse-compact') {
      setCompactNotice(command.notice);
      onChangePrompt('');
      return;
    }
    if (command.kind === 'arm-clear') {
      setNewSessionArmed(true);
      onChangePrompt('');
      return;
    }
    if (mode === 'queue' && onQueue && prompt.trim()) {
      onQueue(expandMentions(expandCitations(prompt)));
      onChangePrompt('');
      return;
    }
    const fresh = consumeFreshContext(newSessionArmed);
    setNewSessionArmed(fresh.armed);
    if (fresh.freshContext) onFreshContext?.();
    onSend();
  };

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.nativeEvent as { isComposing?: boolean }).isComposing) return;
    const field = event.currentTarget;
    const fullField = field.value === prompt;
    if (fullField && (event.key === 'Backspace' || event.key === 'Delete') && isPlainKey(event)) {
      const deleted = deleteComposerChipKey(
        prompt,
        field.selectionStart ?? 0,
        field.selectionEnd ?? 0,
        event.key,
      );
      if (deleted) {
        event.preventDefault();
        caretRef.current = { start: deleted.caret, end: deleted.caret };
        setPendingCaret(deleted.caret);
        onChangePrompt(deleted.text);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (prompt.trim()) {
        const next = stashDraft(stashes, prompt, Date.now());
        setStashes(next.entries);
        setStashFileNotice(null);
        if (next.cleared) onChangePrompt('');
      } else {
        const entry = stashes.length === 1 ? stashes[0] : null;
        const fileRestore = entry ? stashFileRestorable(entry, Date.now(), stashEnvironment) : null;
        const restored = restoreStash(stashes);
        setStashes(restored.entries);
        setStashFileNotice(fileRestore);
        if (restored.text) onChangePrompt(restored.text);
      }
      return;
    }
    if (handleHistoryKey(event)) return;

    if (event.key === 'Backspace' && !prompt && attachments.length > 0 && isPlainKey(event)) {
      event.preventDefault();
      onRemoveAttachment(attachments[attachments.length - 1].resourceId);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (isVoiceModeActive) {
        if (!prompt.trim()) return;
        deliverDraft('send');
        return;
      }
      if (!canSend) return;
      historyStateRef.current = { owner: threadId, index: null, draft: '' };
      const intent = slashIntent(prompt, threadProvider);
      if (intent === 'side') {
        const question = prompt.replace(/^\/(side|btw)\s*/i, '').trim() || prompt;
        setSideQuestion(question);
        window.dispatchEvent(new CustomEvent('kite:side-chat', { detail: { threadId, question } }));
        onChangePrompt('');
        return;
      }
      deliverDraft(running && onQueue ? 'queue' : 'send');
    }
  };

  const mentionQuery = mentionQueryAt(prompt, draftCaret);
  const mentionRows = mentionQuery ? filterMentionMenu(mentionQuery.query, { files, threads, models }) : [];
  const pickMention = (row: (typeof mentionRows)[number]) => {
    if (!mentionQuery) return;
    const next = insertMentionAtCaret(prompt, mentionQuery.start, draftCaret, {
      kind: row.kind,
      id: row.id,
      label: row.label,
    });
    caretRef.current = { start: next.caret, end: next.caret };
    setDraftCaret(next.caret);
    setPendingCaret(next.caret);
    onChangePrompt(next.text);
  };

  return (
    <div className="kite-composer-shell" style={{ boxSizing: 'border-box' }}>
      {/* Approval Card integrated above Composer */}
      {pendingApproval && onApprovalDecision && (
        <div className="w-full max-w-[var(--chat-content-max-width,46rem)] mx-auto mb-2">
          <ChatApprovalCard approval={pendingApproval} onDecision={onApprovalDecision} />
        </div>
      )}

      {compactNotice ? (
        <p className="chat-note-row" role="status">
          {compactNotice}
        </p>
      ) : null}
      {newSessionArmed ? (
        <div className="chat-note-row" role="status">
          <span>New session</span>
          <button type="button" onClick={() => setNewSessionArmed(false)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Tier 1: Main Floating Glass Card */}
      <ComposerSurface.Main
        onDragOver={(event) => {
          if (running) return;
          const kind = getDropKind(event);
          if (kind !== null) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDropKind(kind);
          }
        }}
        onDragLeave={(e) => {
          const rel = e.relatedTarget;
          if (rel instanceof Node && e.currentTarget.contains(rel)) return;
          setDropKind(null);
        }}
        onDrop={handleDrop}
      >
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="kite-composer-attachments">
            {attachments.map((att) => (
              <div key={att.resourceId} className="kite-composer-attachment-chip">
                <FileCodeIcon size={13} className="text-muted-foreground shrink-0" />
                <span title={att.displayName}>{att.displayName}</span>
                {att.byteSize && (
                  <span className="text-2xs opacity-60 shrink-0">
                    {formatBytes(att.byteSize)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(att.resourceId)}
                  title="Remove attachment"
                  className="size-4 rounded-xs inline-flex items-center justify-center text-muted-foreground hover:text-foreground border-0 bg-transparent cursor-pointer ml-0.5"
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {prompt.startsWith('/') || prompt.startsWith('$') ? (
          <ComposerCommandMenu
            query={prompt}
            skills={skills}
            onPick={(value) => onChangePrompt(value.startsWith('/') ? `${value} ` : value)}
          />
        ) : null}
        {mentionQuery ? (
          <div className="composer-command-menu rounded-card" role="listbox" aria-label="Mentions">
            {mentionRows.map((row) => (
              <button
                key={`${row.kind}:${row.id}`}
                type="button"
                role="option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickMention(row)}
              >
                {row.menuLabel}
              </button>
            ))}
          </div>
        ) : null}
        {stashFileNotice === 'attach-again' ? (
          <button type="button" onClick={() => onPickAttachments()}>
            Attach again
          </button>
        ) : null}
        {stashFileNotice === 'wrong-environment' ? (
          <p role="status">Uploaded files stay in the environment that saved them.</p>
        ) : null}
        {sideQuestion ? (
          <p className="chat-note-row" role="status">
            Side: {sideQuestion}
          </p>
        ) : null}

        {/* Textarea Input */}
        {draftHasCitation(prompt) || draftHasMention(prompt) ? (
          <CitationDraftEditor
            prompt={prompt}
            onChange={onChangePrompt}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
            onCopy={onComposerCopy}
            pendingCaret={pendingCaret}
            onPendingCaretApplied={() => setPendingCaret(null)}
            onCaret={setPendingCaret}
            onDraftCaret={setDraftCaret}
            caretRef={caretRef}
            testId={agentName ? 'agent-chat-input' : undefined}
          />
        ) : (
          <textarea
            ref={textareaRef}
            data-testid={agentName ? 'agent-chat-input' : undefined}
            data-drop-targeted={dropKind !== null ? true : undefined}
            value={prompt}
            onPaste={onComposerPaste}
            onCopy={onComposerCopy}
            onChange={(event) => {
              const start = event.target.selectionStart ?? event.target.value.length;
              const end = event.target.selectionEnd ?? start;
              caretRef.current = { start, end };
              setDraftCaret(start);
              onChangePrompt(event.target.value);
            }}
            onKeyDown={onComposerKeyDown}
            onSelect={(event) => {
              const start = event.currentTarget.selectionStart ?? 0;
              const end = event.currentTarget.selectionEnd ?? start;
              caretRef.current = { start, end };
              setDraftCaret(start);
            }}
            placeholder={composerPlaceholder}
            rows={2}
            className="kite-composer-textarea"
          />
        )}

        {/* Drop Hint */}
        {dropKind && (
          <span className="absolute top-2 right-2 px-2.5 py-0.5 rounded-full bg-primary text-white text-2xs font-semibold pointer-events-none z-20">
            {dropKind === 'mention'
              ? 'Drop to mention'
              : dropKind === 'prompt'
              ? 'Drop to insert prompt'
              : 'Drop to attach'}
          </span>
        )}

        {/* Footer Bar */}
        {isVoiceModeActive ? (
          <VoiceModeFooterBar
            threadId={threadId}
            hasDraftText={Boolean(prompt.trim())}
            onSendDraft={() => deliverDraft('send')}
            onEndSession={() => voice.stopSession()}
          />
        ) : (
          <div ref={footerRef} className="kite-composer-footer">
          {/* Left Controls */}
          <div className="kite-composer-footer-left">
            {/* Model & Provider Picker Popover */}
            <ModelPickerPopover
              provider={threadProvider}
              model={threadModel}
              declaration={declaration}
              disabled={running}
              modelReason={modelReason}
              catalogState={catalogState}
              ensureDynamicModels={ensureDynamicModels}
              onSelectModel={(modelId) => onUpdateConfig({ model: modelId })}
              onSelectProvider={(provider) => onUpdateConfig({ provider })}
            />
            {modelReason && <ControlReason reason={modelReason} />}
            {providerReason && <ControlReason reason={providerReason} />}

            <ComposerControlSeparator />

            {/* Effort Slider Popover (Exact Codex Discrete Slider Card) */}
            <EffortSliderPopover
              effort={threadEffort}
              modelName={currentModelName}
              declaration={declaration}
              disabled={running}
              unlistedReason={effortReason}
              onChangeEffort={(effortId) => onUpdateConfig({ effort: effortId })}
            />

            <ComposerControlSeparator />

            {/* Work Mode & Dynamic Agents Popover */}
            <WorkModePickerPopover
              workModes={declaration.workMode || []}
              currentAgent={threadAgent}
              currentPlan={threadPlan}
              currentMode={threadMode}
              disabled={running}
              onSelectWorkMode={(patch) => onUpdateConfig(patch)}
            />

            <ComposerControlSeparator />

            {/* Runtime / Permission Mode Popover */}
            <PermissionPickerPopover
              threadMode={threadMode}
              permissions={permissions}
              permissionDeclared={permissionDeclared}
              permissionReason={permissionReason}
              disabled={running}
              onSelectPermission={(mode) =>
                onUpdateConfig({
                  mode,
                  plan: mode === 'readOnly',
                  ...(mode === 'readOnly' ? {} : { agent: null }),
                })
              }
            />

            {/* Connection Selector (when multiple accounts verified the spawn endpoint) */}
            {connectionCandidates.length > 1 && onSelectConnection && (
              <>
                <ComposerControlSeparator />
                <ConnectionPickerPopover
                  threadConnectionId={threadConnectionId ?? null}
                  candidates={connectionCandidates}
                  disabled={running}
                  onSelectConnection={onSelectConnection}
                />
              </>
            )}
          </div>

          {/* Right Actions */}
          <div className="kite-composer-footer-right">
            {/* Attachment Button with Popover */}
            <AttachMenuPopover
              disabled={running}
              onPickAttachments={onPickAttachments}
            />

            {/* Dictation Button */}
            <button
              type="button"
              disabled={
                running ||
                (dictationAvailability !== null &&
                  !dictationAvailability.canStart &&
                  !dictationAvailability.canRequestPermission)
              }
              onClick={toggleDictation}
              title={
                dictationState === 'recording'
                  ? 'Finish dictation'
                  : dictationState === 'transcribing'
                  ? 'Transcribing…'
                  : dictationError || 'Dictate message'
              }
              aria-label={dictationState === 'recording' ? 'Finish dictation' : 'Dictate message'}
              className={`chat-dictate-control size-8 rounded-control ${
                dictationState === 'recording' ? 'chat-dictate-control--recording' : ''
              }`}
            >
              {dictationState === 'recording' ? (
                <StopIcon size={14} />
              ) : dictationState === 'transcribing' ? (
                <svg
                  className="chat-dictate-glyph animate-spin"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M12 4a8 8 0 1 1-6.32 3.1" />
                </svg>
              ) : (
                <MicIcon size={14} />
              )}
            </button>

            {/* Voice Mode Button (S1, S7) */}
            <button
              type="button"
              disabled={running}
              onClick={() => {
                voice.startSession(threadId, 'thread');
              }}
              title="Iniciar sesión de voz"
              aria-label="Iniciar sesión de voz"
              className="chat-voice-mode-control size-8 rounded-control"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 10v4" />
                <path d="M8 6v12" />
                <path d="M12 3v18" />
                <path d="M16 7v10" />
                <path d="M20 11v2" />
              </svg>
            </button>

            {/* Token Counter */}
            {totalTokens > 0 && (
              <span className="text-2xs font-mono text-muted-foreground px-1 select-none">
                {formatTokens(totalTokens)}
              </span>
            )}
            {draftOverLimit && (
              <span className="text-2xs font-mono text-destructive px-1 select-none" role="status">
                {measuredLength.toLocaleString()} / 120,000
              </span>
            )}

            {/* Send / Interrupt / Queue / Steer / Resume */}
            {(() => {
              const action = resolvePrimaryAction({
                running,
                draftEmpty: prompt.trim().length === 0 && attachments.length === 0,
                paused,
                steerSupported: threadProvider === 'codex' || threadProvider === 'claude' || threadProvider === 'grok',
                defaultFollowUp: 'queue',
                flip: followUpFlip,
              });
              if (action === 'interrupt') {
                return (
                  <button
                    type="button"
                    aria-label="Interrupt"
                    title="Interrupt"
                    onClick={() => {
                      const stopped = composerGoalStop(threadProvider, goal ?? null);
                      onGoalStop?.(stopped);
                      onStop();
                    }}
                    className="kite-composer-action-btn kite-composer-action-btn--stop"
                  >
                    <StopIcon size={11} className="fill-current" />
                  </button>
                );
              }
              const label = action === 'queue' ? 'Queue' : action === 'steer' ? 'Steer' : action === 'resume' ? 'Resume' : 'Send message';
              return (
                <button
                  type="button"
                  aria-label={label}
                  title="Send prompt (Enter) · New line (Shift+Enter) · Earlier prompts (↑)"
                  disabled={action === 'send' && !canSend}
                  data-testid={agentName ? 'agent-chat-send' : undefined}
                  onClick={() => {
                    if (action === 'resume') {
                      onSend();
                      return;
                    }
                    if ((action === 'queue' || action === 'steer') && onQueue && prompt.trim()) {
                      deliverDraft('queue');
                      return;
                    }
                    deliverDraft('send');
                  }}
                  className="kite-composer-action-btn kite-composer-action-btn--send"
                >
                  <ArrowUpIcon size={16} />
                </button>
              );
            })()}
          </div>
        </div>
      )}
      </ComposerSurface.Main>

      {/* Tier 2: Recessed Lower Context Strip */}
      <ComposerContextStrip
        currentBranch={threadBranch || 'main'}
        branches={branches}
        currentWorkspace={threadWorkspaceName || 'Local'}
        workspaces={workspaces}
        onSelectBranch={onSwitchBranch}
        onCreateBranch={onCreateBranch}
        onSelectWorkspace={onSelectWorkspace}
      />
    </div>
  );
};
