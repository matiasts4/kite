import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import './composer/composer.css';
import {
  ChatProvider,
  ChatMode,
  ChatAttachment,
  ApprovalRequest,
  formatTokens,
} from './types';
import type { ChatItem } from '../../../types';
import { insertQuoteAtCaret } from './citeDraft';
import {
  citationSendLength,
  draftHasCitation,
  expandCitations,
  readCitationClipboard,
  writeCitationClipboard,
  type CitationInput,
} from './citationChip';
import {
  draftHasMention,
  expandMentions,
  filterMentionMenu,
  insertDropAtCaret,
  insertMentionAtCaret,
  KITE_FILES_MIME,
  KITE_THREAD_MIME,
  mentionFromTerminalExcerpt,
  mentionQueryAt,
  readMentionClipboard,
  writeMentionClipboard,
  deleteComposerChipKey,
} from './mentionChip';
import type { DriverDeclaration } from '../../../lib/session/types';
import { ChatApprovalCard } from './ChatApprovalCard';
import { listConnections } from '../../../lib/ipc';
import {
  verifiedSpawnConnections,
  type ConnectionCandidate,
} from './connectionBinding';
import { ComposerSurface } from './composer/ComposerSurface';
import { ComposerCommandMenu } from './ComposerCommandMenu';
import { useVoiceSession } from '../../../lib/operator/voice/voiceSessionStore';
import { composerTextWithLiveSpeech, typedDraftFromComposer } from './liveTranscriptDraft';
import { VoiceModeFooterBar } from './composer/VoiceModeFooterBar';
import {
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
import { isPlainKey } from './composer/composerTextHelpers';
import { CitationDraftEditor } from './composer/CitationDraftEditor';
import { ComposerAttachments } from './composer/ComposerAttachments';
import { ComposerDictationButton } from './composer/ComposerDictationButton';
import { ComposerPrimaryActionButton } from './composer/ComposerPrimaryActionButton';
import { ComposerConfigControls } from './composer/ComposerConfigControls';
import { usePromptHistory } from './composer/usePromptHistory';

export {
  extractUserPromptHistory,
  getNextHistoryIndex,
  isNoNewlineBefore,
  isNoNewlineAfter,
  isPlainKey,
} from './composer/composerTextHelpers';

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
  /** Opens Voice Mode in its own conversation. Falls back to binding the current thread. */
  onStartVoiceMode?: () => void;
}

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
  onStartVoiceMode,
}) => {
  const voice = useVoiceSession();
  const isVoiceModeActive =
    (voice.phase === 'active' || voice.phase === 'starting') &&
    (voice.boundThreadId === threadId || (voice.activeSurface === 'thread' && !voice.boundThreadId));
  const liveInterim = isVoiceModeActive ? (voice.interimTranscript ?? '').trim() : '';
  const [holdLiveSpeech, setHoldLiveSpeech] = useState(false);
  useEffect(() => {
    if (!liveInterim) setHoldLiveSpeech(false);
  }, [liveInterim]);
  const showLiveSpeech = isVoiceModeActive && !voice.isPausedForDictation && !holdLiveSpeech && liveInterim.length > 0;
  const composerValue = composerTextWithLiveSpeech(prompt, liveInterim, showLiveSpeech);
  const commitComposerValue = (display: string) => {
    const next = typedDraftFromComposer(display, prompt, liveInterim, showLiveSpeech);
    if (next.holdLive) setHoldLiveSpeech(true);
    if (next.typed !== prompt) onChangePrompt(next.typed);
  };
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

  const { handleHistoryKey, resetPromptHistory } = usePromptHistory({
    threadId,
    threadItems,
    prompt,
    caretRef,
    onChangePrompt,
  });

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
  }, [prompt, composerValue]);

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
      const stagedFiles = Array.from(event.dataTransfer?.files ?? []);
      if (stagedFiles.length === 0) return;
      const paths = stagedFiles
        .map((file) => (file as File & { path?: string }).path)
        .filter((path): path is string => Boolean(path));
      if (paths.length > 0) onStagePaths(paths);
      else onStageFiles(stagedFiles);
    }
  };

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

    let pasteFiles: File[] = Array.from(dt.files ?? []);
    if (pasteFiles.length === 0 && dt.items) {
      const itemFiles = Array.from(dt.items)
        .filter((item) => item.kind === 'file' || item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (itemFiles.length > 0) pasteFiles = itemFiles;
    }
    if (pasteFiles.length > 0) {
      event.preventDefault();
      onStageFiles(pasteFiles);
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

    if (event.key === 'Backspace' && !prompt && !composerValue && attachments.length > 0 && isPlainKey(event)) {
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
      resetPromptHistory();
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
        <ComposerAttachments
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
        />

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
            value={composerValue}
            onPaste={onComposerPaste}
            onCopy={onComposerCopy}
            onChange={(event) => {
              const rawStart = event.target.selectionStart ?? event.target.value.length;
              const rawEnd = event.target.selectionEnd ?? rawStart;
              const start = showLiveSpeech ? Math.min(rawStart, prompt.length) : rawStart;
              const end = showLiveSpeech ? Math.min(rawEnd, prompt.length) : rawEnd;
              caretRef.current = { start, end };
              setDraftCaret(start);
              commitComposerValue(event.target.value);
            }}
            onKeyDown={onComposerKeyDown}
            onSelect={(event) => {
              const rawStart = event.currentTarget.selectionStart ?? 0;
              const rawEnd = event.currentTarget.selectionEnd ?? rawStart;
              const start = showLiveSpeech ? Math.min(rawStart, prompt.length) : rawStart;
              const end = showLiveSpeech ? Math.min(rawEnd, prompt.length) : rawEnd;
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
            <ComposerConfigControls
              threadProvider={threadProvider}
              threadModel={threadModel}
              threadEffort={threadEffort}
              threadAgent={threadAgent}
              threadPlan={threadPlan}
              threadMode={threadMode}
              threadConnectionId={threadConnectionId}
              declaration={declaration}
              running={running}
              catalogState={catalogState}
              connectionCandidates={connectionCandidates}
              ensureDynamicModels={ensureDynamicModels}
              onUpdateConfig={onUpdateConfig}
              onSelectConnection={onSelectConnection}
            />

            {/* Right Actions */}
            <div className="kite-composer-footer-right">
              {/* Attachment Button with Popover */}
              <AttachMenuPopover
                disabled={running}
                onPickAttachments={onPickAttachments}
              />

              {/* Dictation Button */}
              <ComposerDictationButton
                running={running}
                prompt={prompt}
                onChangePrompt={onChangePrompt}
                voice={voice}
              />

              {/* Voice Mode Button (S1, S7) */}
              <button
                type="button"
                disabled={running}
                onClick={() => {
                  if (onStartVoiceMode) {
                    onStartVoiceMode();
                    return;
                  }
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
              <ComposerPrimaryActionButton
                running={running}
                prompt={prompt}
                attachmentsCount={attachments.length}
                paused={paused}
                threadProvider={threadProvider}
                followUpFlip={followUpFlip}
                canSend={canSend}
                agentName={agentName}
                goal={goal}
                onGoalStop={onGoalStop}
                onStop={onStop}
                onSend={onSend}
                deliverDraft={deliverDraft}
                hasQueueHandler={Boolean(onQueue)}
              />
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
