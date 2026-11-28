import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import './composer/composer.css';
import { useReduceMotion } from '../../../motion/standard/context';
import { prefersReducedMotion } from '../../../motion/contract';
import { eases, tweens } from '../../../motion/standard/tokens';
import {
  ChatProvider,
  ChatMode,
  ChatAttachment,
  ApprovalRequest,
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
import { ChatApprovalCard, type ApprovalDecision } from './ChatApprovalCard';
import { invokeCommand, listConnections } from '../../../lib/ipc';
import {
  verifiedSpawnConnections,
  type ConnectionCandidate,
} from './connectionBinding';
import { ComposerSurface } from './composer/ComposerSurface';
import { ComposerCommandMenu } from './ComposerCommandMenu';
import { useVoiceSession } from '../../../lib/operator/voice/voiceSessionStore';
import { composerTextWithLiveSpeech, typedDraftFromComposer } from './liveTranscriptDraft';
import { VoiceModeFooterBar } from './composer/VoiceModeFooterBar';
import { ComposerVoiceGlow } from './composer/ComposerVoiceGlow';
import { getVoicePalette, normalizeVoiceRgb } from '../../../lib/operator/config/voicePalettes';
import {
  clampVoicePlaybackSpeed,
  nextVoicePlaybackSpeed,
} from '../../../lib/operator/voice/callResilience';
import { InCallTextSyncBatcher } from '../../../lib/operator/voice/pttController';
import { loadOperatorConfig, saveOperatorConfig } from '../../../lib/operator/operatorConfig';
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
import { resolvePrimaryAction, useDefaultFollowUp } from './composerPrimaryAction';
import { ComposerConfigControls } from './composer/ComposerConfigControls';
import { usePromptHistory } from './composer/usePromptHistory';
import { ChangedFilesCard, type ChangedFile } from './ChangedFilesCard';

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
  threadWorkspaceId?: string | null;
  threadWorkspaceName?: string | null;
  workspaces?: Array<{ id: string; name: string }>;
  branches?: string[];
  onSwitchBranch?: (branch: string) => void;
  onCreateBranch?: (branch: string) => void;
  onSelectWorkspace?: (wsId: string | null) => void;
  declaration: DriverDeclaration;
  running: boolean;
  paused?: boolean;
  prompt: string;
  attachments: ChatAttachment[];
  totalTokens?: number;
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
  onQueue?: (text: string, attachments?: ChatAttachment[]) => void;
  onSteer?: (text: string, attachments?: ChatAttachment[]) => void | Promise<boolean | void>;
  editingQueuedId?: string | null;
  onEditLastQueued?: () => void;
  onCancelQueueEdit?: () => void;
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
  agents?: Array<{ id: string; name?: string; engine?: string }>;
  skills?: string[];
  goal?: string | null;
  onGoalStop?: (result: { goal: string | null; paused: boolean; turnEnded: boolean }) => void;
  initialStashes?: StashEntry[];
  stashEnvironment?: string;
  onApprovalDecision?(decision: ApprovalDecision, requestId: string): void;
  onSendVoiceTurn?: (text: string) => void;
  /** Opens Voice Mode in its own conversation. Falls back to binding the current thread. */
  onStartVoiceMode?: () => void;
  /** Hides the footer speed cycle control when an outer VoiceTeleprompterDock already displays VoiceSpeedPopover. */
  hideVoiceFooterSpeedControl?: boolean;
  /** True once the conversation has started so the pre-chat folder/branch strip collapses away. */
  conversationStarted?: boolean;
  /** Changed workspace files for the current turn, docked flush atop the composer. */
  changedFiles?: ChangedFile[];
  changedFilesWorkspaceName?: string | null;
  onOpenTurnDiff?: () => void;
  onOpenChangedFile?: (path: string) => void;
  /** Called synchronously inside useLayoutEffect whenever composer textarea height changes. */
  onHeightChange?: () => void;
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
  threadWorkspaceId,
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
  catalogState = null,
  ensureDynamicModels,
  ensureDynamicAgents,
  pendingApproval,
  onChangePrompt,
  onSend,
  onFreshContext,
  onCompact,
  onQueue,
  onSteer,
  editingQueuedId = null,
  onEditLastQueued,
  onCancelQueueEdit,
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
  agents = [],
  skills = [],
  goal = null,
  onGoalStop,
  initialStashes,
  stashEnvironment = '',
  onSendVoiceTurn,
  onStartVoiceMode,
  hideVoiceFooterSpeedControl = false,
  conversationStarted,
  changedFiles = [],
  changedFilesWorkspaceName,
  onOpenTurnDiff,
  onOpenChangedFile,
  onHeightChange,
}) => {
  const reduceMotion = useReduceMotion() || prefersReducedMotion();
  const defaultFollowUp = useDefaultFollowUp();
  const hasStarted = conversationStarted ?? (running || threadItems.length > 0);
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
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const onChangePromptRef = useRef(onChangePrompt);
  onChangePromptRef.current = onChangePrompt;
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;
  const prevTextareaHeightRef = useRef<number | null>(null);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [draftCaret, setDraftCaret] = useState(0);
  const [stashes, setStashes] = useState<StashEntry[]>(initialStashes ?? []);
  const [stashFileNotice, setStashFileNotice] = useState<ReturnType<typeof stashFileRestorable>>(null);
  const [sideQuestion, setSideQuestion] = useState<string | null>(null);
  const [newSessionArmed, setNewSessionArmed] = useState(false);
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  const [voicePlaybackSpeed, setVoicePlaybackSpeed] = useState<number>(() =>
    clampVoicePlaybackSpeed(loadOperatorConfig().ttsRate || 1)
  );
  const [voiceGlowPalette, setVoiceGlowPalette] = useState(() =>
    normalizeVoiceRgb(getVoicePalette(loadOperatorConfig().persona?.voice).palette)
  );

  useEffect(() => {
    const syncPalette = () => {
      setVoiceGlowPalette(
        normalizeVoiceRgb(getVoicePalette(loadOperatorConfig().persona?.voice).palette)
      );
    };
    syncPalette();
    window.addEventListener('kite:operator-config-updated', syncPalette);
    return () => window.removeEventListener('kite:operator-config-updated', syncPalette);
  }, [voice.phase]);
  const onSendVoiceTurnRef = useRef(onSendVoiceTurn);
  onSendVoiceTurnRef.current = onSendVoiceTurn;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const lastVoiceSubmitAtRef = useRef(0);
  const inCallTextBatcherRef = useRef<InCallTextSyncBatcher | null>(null);

  useEffect(() => {
    const batcher = new InCallTextSyncBatcher({
      onFlush: (payload) => {
        const mergedText = payload.text.trim();
        if (!mergedText) return;
        if (onSendVoiceTurnRef.current) {
          onSendVoiceTurnRef.current(mergedText);
        } else {
          onSendRef.current();
        }
      },
    });
    inCallTextBatcherRef.current = batcher;
    return () => {
      batcher.dispose();
      if (inCallTextBatcherRef.current === batcher) {
        inCallTextBatcherRef.current = null;
      }
    };
  }, []);

  const handleCycleVoiceSpeed = () => {
    const next = nextVoicePlaybackSpeed(voicePlaybackSpeed);
    setVoicePlaybackSpeed(next);
    saveOperatorConfig({ ttsRate: next });
  };

  useEffect(() => {
    setNewSessionArmed(false);
    setCompactNotice(null);
    prevTextareaHeightRef.current = null;
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
    const onBlur = () => setFollowUpFlip(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
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
      const currentPrompt = promptRef.current;
      const area = textareaRef.current;
      const usingField = Boolean(area) && !draftHasCitation(currentPrompt);
      const start = usingField ? (area?.selectionStart ?? currentPrompt.length) : caretRef.current.start;
      const end = usingField ? (area?.selectionEnd ?? start) : caretRef.current.end;
      const next = insertQuoteAtCaret(currentPrompt, start, end, detail);
      caretRef.current = { start: next.caret, end: next.caret };
      setPendingCaret(next.caret);
      onChangePromptRef.current(next.text);
      window.requestAnimationFrame(() => {
        const field = textareaRef.current;
        if (!field || draftHasCitation(next.text)) return;
        field.focus();
        field.setSelectionRange(next.caret, next.caret);
      });
    };
    window.addEventListener('kite:cite', onCite);
    return () => window.removeEventListener('kite:cite', onCite);
  }, []);

  useEffect(() => {
    const onExcerpt = (event: Event) => {
      const mention = mentionFromTerminalExcerpt((event as CustomEvent).detail);
      if (!mention) return;
      const currentPrompt = promptRef.current;
      const area = textareaRef.current;
      const plain = Boolean(area) && !draftHasCitation(currentPrompt) && !draftHasMention(currentPrompt);
      const start = plain ? (area?.selectionStart ?? caretRef.current.start) : caretRef.current.start;
      const end = plain ? (area?.selectionEnd ?? start) : caretRef.current.end;
      const next = insertMentionAtCaret(currentPrompt, start, end, mention);
      caretRef.current = { start: next.caret, end: next.caret };
      setDraftCaret(next.caret);
      setPendingCaret(next.caret);
      onChangePromptRef.current(next.text);
    };
    window.addEventListener('kite:terminal-excerpt', onExcerpt);
    return () => window.removeEventListener('kite:terminal-excerpt', onExcerpt);
  }, []);

  useEffect(() => {
    const onBrowserScreenshot = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          dataBase64?: string;
          mimeType?: string;
          fileName?: string;
        }>
      ).detail;
      if (!detail?.dataBase64) return;
      try {
        const binary = window.atob(detail.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        const mime = detail.mimeType || 'image/png';
        const fileName = detail.fileName || 'browser-screenshot.png';
        const file = new File([bytes], fileName, { type: mime });
        onStageFiles([file]);
      } catch (err) {
        console.warn('[ChatComposer] Failed to stage browser screenshot attachment:', err);
      }
    };
    window.addEventListener('kite:attach-browser-screenshot', onBrowserScreenshot);
    return () => window.removeEventListener('kite:attach-browser-screenshot', onBrowserScreenshot);
  }, [onStageFiles]);

  useLayoutEffect(() => {
    if (draftHasCitation(prompt) || draftHasMention(prompt) || pendingCaret === null) return;
    const field = textareaRef.current;
    if (!field) return;
    const caret = Math.min(pendingCaret, field.value.length);
    field.focus();
    field.setSelectionRange(caret, caret);
    setPendingCaret(null);
  }, [pendingCaret, prompt]);

  // Dynamic textarea height: lock the host container during measurement so collapsing to 'auto'
  // never expands the sibling flex transcript or clamps its scrollTop, and sync live-edge on real height changes.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!composerValue && el.value.length === 0) {
      const prevH = prevTextareaHeightRef.current;
      if (prevH !== null && prevH !== 52) {
        el.style.height = '';
        onHeightChangeRef.current?.();
      }
      prevTextareaHeightRef.current = 52;
      return;
    }
    const prevScrollTop = el.scrollTop;
    const computed = typeof window !== 'undefined' ? window.getComputedStyle(el) : null;
    const minH = Math.max(52, Number.parseFloat(computed?.minHeight ?? '') || 52);
    const parsedMaxH = Number.parseFloat(computed?.maxHeight ?? '');
    const maxH = Number.isFinite(parsedMaxH) && parsedMaxH > minH ? parsedMaxH : 220;

    const host = el.parentElement;
    const hostComputedHeight =
      host && typeof window !== 'undefined'
        ? Number.parseFloat(window.getComputedStyle(host).height)
        : Number.NaN;
    const lockedHostHeight =
      Number.isFinite(hostComputedHeight) && hostComputedHeight > 0
        ? hostComputedHeight
        : (host?.offsetHeight ?? 0);
    const prevHostMinHeight = host ? host.style.minHeight : '';

    let measuredHeight = minH;
    let nextHeight = minH;
    if (host && lockedHostHeight > 0) {
      host.style.minHeight = `${lockedHostHeight}px`;
    }
    try {
      el.style.height = 'auto';
      measuredHeight = el.scrollHeight;
      nextHeight = Math.min(maxH, Math.max(minH, measuredHeight));
      el.style.height = `${nextHeight}px`;
      if (measuredHeight > nextHeight) {
        const atLiveEdge =
          document.activeElement !== el ||
          (el.selectionStart ?? el.value.length) >= Math.max(0, el.value.length - 1);
        if (showLiveSpeech && atLiveEdge) {
          el.scrollTop = el.scrollHeight;
        } else if (prevScrollTop > 0) {
          el.scrollTop = prevScrollTop;
        }
      }
    } finally {
      if (host && lockedHostHeight > 0) {
        host.style.minHeight = prevHostMinHeight;
      }
    }

    if (prevTextareaHeightRef.current !== null && prevTextareaHeightRef.current !== nextHeight) {
      onHeightChangeRef.current?.();
    }
    prevTextareaHeightRef.current = nextHeight;
  }, [prompt, composerValue, showLiveSpeech]);

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
    const types = event.dataTransfer?.types ?? [];
    if (types.includes('application/x-kite-prompt')) return 'prompt';
    if (types.includes(KITE_THREAD_MIME) || types.includes(KITE_FILES_MIME)) return 'mention';
    if (types.includes('Files')) return 'attach';
    return null;
  };

  const handleDrop = (event: React.DragEvent) => {
    setDropKind(null);
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
    : running
    ? agentName || onQueue || onSteer
      ? 'Write a follow-up while your agent works…'
      : "Working — send when it's done, or stop it."
    : agentName
    ? `Message ${agentName}…`
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

  const deliverDraft = (mode: 'send' | 'queue' | 'steer') => {
    if (isVoiceModeActive && prompt.trim()) {
      const text = expandMentions(expandCitations(prompt)).trim();
      const mappedAttachments = attachments.map((att) => ({
        id: att.resourceId,
        name: att.path ?? att.resourceId,
        path: att.path ?? undefined,
        kind: att.mimeType ?? undefined,
      }));
      onChangePrompt('');
      const now = Date.now();
      const batcher = inCallTextBatcherRef.current;
      if (batcher && (batcher.hasPending() || now - lastVoiceSubmitAtRef.current < 250)) {
        lastVoiceSubmitAtRef.current = now;
        batcher.enqueue(text, mappedAttachments, now);
        return;
      }
      lastVoiceSubmitAtRef.current = now;
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
    const hasDraftPayload = Boolean(prompt.trim() || attachments.length > 0);
    if (editingQueuedId && onQueue && hasDraftPayload) {
      onQueue(expandMentions(expandCitations(prompt)), attachments);
      return;
    }
    if (mode === 'steer' && (onSteer || onQueue) && hasDraftPayload) {
      const steerTarget = onSteer ?? onQueue!;
      const result = steerTarget(expandMentions(expandCitations(prompt)), attachments);
      if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).then(
          (ok) => {
            if (ok !== false) onChangePrompt('');
          },
          () => {}
        );
      } else if ((result as unknown) !== false) {
        onChangePrompt('');
      }
      return;
    }
    if (mode === 'queue' && onQueue && hasDraftPayload) {
      onQueue(expandMentions(expandCitations(prompt)), attachments);
      onChangePrompt('');
      return;
    }
    const fresh = consumeFreshContext(newSessionArmed);
    setNewSessionArmed(fresh.armed);
    if (fresh.freshContext) onFreshContext?.();
    onSend();
  };

  const [mentionActiveIdx, setMentionActiveIdx] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);

  const mentionQuery = mentionQueryAt(prompt, draftCaret);
  const mentionKey = mentionQuery ? `${mentionQuery.start}:${mentionQuery.query}` : null;
  const mentionRows = mentionQuery
    ? filterMentionMenu(mentionQuery.query, { files, threads, models, agents })
    : [];
  const mentionOpen = Boolean(
    mentionQuery && mentionRows.length > 0 && dismissedMentionKey !== mentionKey
  );
  const clampedMentionIdx =
    mentionRows.length > 0 ? Math.min(mentionActiveIdx, mentionRows.length - 1) : 0;

  useEffect(() => {
    setMentionActiveIdx(0);
    setDismissedMentionKey(null);
  }, [mentionKey]);

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
    setMentionActiveIdx(0);
    setDismissedMentionKey(null);
    onChangePrompt(next.text);
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
    if (editingQueuedId && event.key === 'Escape' && onCancelQueueEdit) {
      event.preventDefault();
      onCancelQueueEdit();
      return;
    }
    if (mentionOpen) {
      if (event.key === 'ArrowDown' && isPlainKey(event)) {
        event.preventDefault();
        setMentionActiveIdx((prev) => (prev + 1) % mentionRows.length);
        return;
      }
      if (event.key === 'ArrowUp' && isPlainKey(event)) {
        event.preventDefault();
        setMentionActiveIdx((prev) => (prev - 1 + mentionRows.length) % mentionRows.length);
        return;
      }
      if (
        (event.key === 'Enter' || event.key === 'Tab') &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        const chosen = mentionRows[clampedMentionIdx];
        if (chosen) pickMention(chosen);
        return;
      }
      if (event.key === 'Escape' && isPlainKey(event)) {
        event.preventDefault();
        setDismissedMentionKey(mentionKey);
        return;
      }
    }
    if (
      event.altKey &&
      event.key === 'ArrowUp' &&
      !prompt.trim() &&
      attachments.length === 0 &&
      onEditLastQueued
    ) {
      event.preventDefault();
      onEditLastQueued();
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
      const keyAction = resolvePrimaryAction({
        running,
        draftEmpty: !prompt.trim() && attachments.length === 0,
        paused,
        steerSupported: Boolean(onSteer),
        defaultFollowUp,
        flip: Boolean(event.ctrlKey || event.metaKey),
      });
      deliverDraft(
        editingQueuedId && onQueue
          ? 'queue'
          : keyAction === 'steer' && onSteer
          ? 'steer'
          : keyAction === 'queue' && onQueue
          ? 'queue'
          : 'send'
      );
    }
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

      {/* Tier 0: Recessed Upper Changed-Files Strip (flush atop main composer) */}
      <AnimatePresence initial={false}>
        {changedFiles.length > 0 && (
          <motion.div
            key="composer-changed-files-strip"
            className="kite-composer-top-strip-wrap"
            initial={reduceMotion ? false : { opacity: 0, height: 0, y: 6 }}
            animate={{
              opacity: 1,
              height: 'auto',
              y: 0,
              transition: reduceMotion ? tweens.instant : tweens.disclosure,
            }}
            exit={
              reduceMotion
                ? { opacity: 0, height: 0, transition: tweens.instant }
                : {
                    opacity: 0,
                    height: 0,
                    y: 8,
                    transition: {
                      height: { duration: 0.24, ease: eases.out },
                      y: { duration: 0.2, ease: eases.out },
                      opacity: { duration: 0.14, ease: eases.leave },
                    },
                  }
            }
            style={{ overflow: 'hidden' }}
          >
            <ChangedFilesCard
              key={threadId}
              variant="composer-top"
              files={changedFiles}
              workspaceName={changedFilesWorkspaceName ?? threadWorkspaceName}
              onOpenTurnDiff={onOpenTurnDiff}
              onOpenFile={onOpenChangedFile}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tier 1: Main Floating Glass Card + Ambient Voice Horizon Glow */}
      <div
        className="kite-composer-glow-stage"
        data-voice-active={isVoiceModeActive ? 'true' : undefined}
        data-voice-state={
          !isVoiceModeActive
            ? undefined
            : voice.micMuted || voice.isPausedForDictation
              ? 'muted'
              : (voice.speakerAudioLevel ?? 0) > 0.05
                ? 'speaking'
                : (voice.liveAudioLevel ?? 0) > 0.05
                  ? 'listening'
                  : 'idle'
        }
        style={
          isVoiceModeActive
            ? ({
                '--voice-deep-rgb': `${Math.round(voiceGlowPalette.deep[0] * 255)}, ${Math.round(voiceGlowPalette.deep[1] * 255)}, ${Math.round(voiceGlowPalette.deep[2] * 255)}`,
                '--voice-core-rgb': `${Math.round(voiceGlowPalette.core[0] * 255)}, ${Math.round(voiceGlowPalette.core[1] * 255)}, ${Math.round(voiceGlowPalette.core[2] * 255)}`,
                '--voice-glint-rgb': `${Math.round(voiceGlowPalette.glint[0] * 255)}, ${Math.round(voiceGlowPalette.glint[1] * 255)}, ${Math.round(voiceGlowPalette.glint[2] * 255)}`,
                '--voice-energy': String(
                  Math.max(voice.liveAudioLevel ?? 0, voice.speakerAudioLevel ?? 0),
                ),
              } as React.CSSProperties)
            : undefined
        }
      >
        <ComposerVoiceGlow
          active={isVoiceModeActive}
          muted={Boolean(voice.micMuted || voice.isPausedForDictation)}
          micLevel={voice.liveAudioLevel ?? 0}
          speakerLevel={voice.speakerAudioLevel ?? 0}
          palette={voiceGlowPalette}
        />
        <ComposerSurface.Main
        className={isVoiceModeActive ? 'kite-composer-main--voice-active' : undefined}
        onDragOver={(event) => {
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
        {mentionOpen ? (
          <div className="composer-command-menu rounded-card" role="listbox" aria-label="Mentions">
            {mentionRows.map((row, idx) => {
              const isSelected = idx === clampedMentionIdx;
              return (
                <button
                  key={`${row.kind}:${row.id}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={
                    isSelected
                      ? 'composer-command-menu__option composer-command-menu__option--active'
                      : 'composer-command-menu__option'
                  }
                  onMouseEnter={() => setMentionActiveIdx(idx)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickMention(row)}
                >
                  {row.menuLabel}
                </button>
              );
            })}
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
            playbackSpeed={hideVoiceFooterSpeedControl ? undefined : voicePlaybackSpeed}
            onCyclePlaybackSpeed={hideVoiceFooterSpeedControl ? undefined : handleCycleVoiceSpeed}
            micFlatlined={Boolean((voice as any).micFlatlined)}
            onReconnectMic={() => {
              voice.setMicMuted(true);
              setTimeout(() => voice.setMicMuted(false), 60);
            }}
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
              <AttachMenuPopover onPickAttachments={onPickAttachments} />

              {/* Dictation Button */}
              <ComposerDictationButton
                running={running}
                prompt={prompt}
                onChangePrompt={onChangePrompt}
                voice={voice}
              />

              {/* Voice Mode Button (S1, S7) */}
              <div className="kite-voice-trigger-wrap">
                {voice.voiceError ? (
                  <div
                    data-testid="voice-error-tip"
                    role="alert"
                    className="kite-voice-error-tip rounded-control"
                  >
                    <p className="kite-voice-error-tip__msg">{voice.voiceError.message}</p>
                    <div className="kite-voice-error-tip__actions">
                      {voice.voiceError.openPrivacySettings ? (
                        <button
                          type="button"
                          onClick={() => {
                            void invokeCommand('request_dictation_permission').catch((err) => {
                              console.warn('[ChatComposer] request_dictation_permission failed:', err);
                            });
                          }}
                          className="kite-voice-error-tip__btn rounded-xs"
                        >
                          Permiso de micrófono
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => voice.setVoiceError(null)}
                        aria-label="Cerrar aviso de micrófono"
                        className="kite-voice-error-tip__close rounded-xs"
                      >
                        Cerrar
                      </button>
                    </div>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    voice.setVoiceError(null);
                    if (onStartVoiceMode) {
                      onStartVoiceMode();
                      return;
                    }
                    voice.startSession(threadId, 'thread');
                  }}
                  data-voice-starting={voice.phase === 'starting' || undefined}
                  data-voice-error={Boolean(voice.voiceError) || undefined}
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
              </div>

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
                hasSteerHandler={Boolean(onSteer)}
                editingQueued={Boolean(editingQueuedId)}
              />
            </div>
          </div>
        )}
      </ComposerSurface.Main>
      </div>

      {/* Tier 2: Recessed Lower Context Strip (draft-only; collapses smoothly once chat starts) */}
      <AnimatePresence initial={false}>
        {!hasStarted && (
          <motion.div
            key="composer-context-strip"
            className="kite-composer-context-strip-wrap"
            initial={reduceMotion ? false : { opacity: 0, height: 0, y: -6 }}
            animate={{
              opacity: 1,
              height: 'auto',
              y: 0,
              transition: reduceMotion ? tweens.instant : tweens.disclosure,
            }}
            exit={
              reduceMotion
                ? { opacity: 0, height: 0, transition: tweens.instant }
                : {
                    opacity: 0,
                    height: 0,
                    y: -8,
                    transition: {
                      height: { duration: 0.26, ease: eases.out },
                      y: { duration: 0.22, ease: eases.out },
                      opacity: { duration: 0.16, ease: eases.leave },
                    },
                  }
            }
            style={{ overflow: 'hidden' }}
          >
            <ComposerContextStrip
              currentBranch={threadBranch || 'main'}
              branches={branches}
              currentWorkspaceId={threadWorkspaceId}
              currentWorkspace={threadWorkspaceName || 'Local'}
              workspaces={workspaces}
              onSelectBranch={onSwitchBranch}
              onCreateBranch={onCreateBranch}
              onSelectWorkspace={onSelectWorkspace}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
