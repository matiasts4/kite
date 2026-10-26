import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import './composer/composer.css';
import {
  StopIcon,
  CloseIcon,
  FileCodeIcon,
  ArrowUpIcon,
  MicIcon,
  BotIcon,
  PencilRulerIcon,
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
import { isControlDeclared, isProviderDeclared, undeclaredReason } from '../../../lib/session/declaration';
import type { DriverDeclaration } from '../../../lib/session/types';
import { ChatApprovalCard } from './ChatApprovalCard';
import { invokeCommand, listConnections } from '../../../lib/ipc';
import {
  verifiedSpawnConnections,
  type ConnectionCandidate,
} from './connectionBinding';
import { ComposerSurface } from './composer/ComposerSurface';
import { ComposerControl, ComposerControlSeparator, ComposerControlIcon } from './composer/ComposerControl';
import { ModelPickerPopover } from './composer/ModelPickerPopover';
import { EffortSliderPopover } from './composer/EffortSliderPopover';
import { ComposerContextStrip } from './composer/ComposerContextStrip';
import { AttachMenuPopover } from './composer/AttachMenuPopover';
import { PermissionPickerPopover } from './composer/PermissionPickerPopover';
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
  prompt: string;
  attachments: ChatAttachment[];
  totalTokens: number;
  isRefreshingModels?: boolean;
  onRefreshModels?: (provider: ChatProvider) => void;
  ensureDynamicModels?: (provider: ChatProvider) => void;
  activeDropdown?: { threadId: string; type: 'provider' | 'model' | 'mode' } | null;
  pendingApproval?: ApprovalRequest | null;
  onChangePrompt: (val: string) => void;
  onSend: () => void;
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
  onApprovalDecision?: (
    decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
    requestId: string
  ) => void;
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
  threadAgent: _threadAgent,
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
  prompt,
  attachments,
  totalTokens,
  ensureDynamicModels,
  pendingApproval,
  onChangePrompt,
  onSend,
  onStop,
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onUpdateConfig,
  onSelectConnection,
  onApprovalDecision,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  }, [ensureDynamicModels, threadProvider]);

  const [dropKind, setDropKind] = useState<'attach' | 'mention' | 'prompt' | null>(null);

  // Dictation state
  const [dictationAvailability, setDictationAvailability] = useState<{
    canStart: boolean;
    canRequestPermission: boolean;
    guidance: string;
  } | null>(null);
  const [dictationState, setDictationState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
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
      }
      return;
    }

    if (dictationState !== 'idle') return;

    const id = crypto.randomUUID();
    dictationReqIdRef.current = id;
    setDictationState('starting');

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
      setDictationError(err?.message || 'Dictation could not start.');
    }
  };

  const insertAtCursor = (insertion: string, isMention: boolean = false) => {
    const target = textareaRef.current;
    const start = target?.selectionStart ?? prompt.length;
    const end = target?.selectionEnd ?? start;
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
    if (types.includes('application/x-kite-files-entry')) return 'mention';
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

    if (types.includes('application/x-kite-files-entry')) {
      try {
        const raw = event.dataTransfer.getData('application/x-kite-files-entry');
        const parsed = JSON.parse(raw);
        const path = parsed.relativePath || parsed.path || parsed.name;
        if (path) insertAtCursor(path, true);
      } catch {
        const text = event.dataTransfer.getData('text/plain');
        if (text) insertAtCursor(text, true);
      }
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
    const { selectionStart, selectionEnd } = target;
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
        target.focus();
        target.setSelectionRange(nextText.length, nextText.length);
      });
      return true;
    }
    return false;
  };

  const providerDeclared = isProviderDeclared(declaration, threadProvider);
  const providerReason = providerDeclared ? null : undeclaredReason(declaration, 'provider');

  const models = declaration.models ?? [];
  const liveModels = models.filter((model) => model.id !== AUTOMATIC_MODEL_ID);
  const modelReason = liveModels.length > 0 ? null : undeclaredReason(declaration, 'model');
  const currentModelOption = models.find((model) => model.id === threadModel);
  const currentModelName =
    !threadModel || threadModel === AUTOMATIC_MODEL_ID
      ? 'Automatic'
      : currentModelOption?.label || threadModel;

  const effortDeclared = isControlDeclared(declaration.effort);
  const effortReason = effortDeclared ? null : undeclaredReason(declaration, 'effort');

  const permissions = declaration.permission ?? [];
  const permissionDeclared = isControlDeclared(declaration.permission);
  const permissionReason = permissionDeclared ? null : undeclaredReason(declaration, 'permission');

  const canSend = Boolean(prompt.trim() || attachments.length > 0);

  const composerPlaceholder = agentName
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

  return (
    <div className="kite-composer-shell" style={{ boxSizing: 'border-box' }}>
      {/* Approval Card integrated above Composer */}
      {pendingApproval && onApprovalDecision && (
        <div className="w-full max-w-[var(--chat-content-max-width,46rem)] mx-auto mb-2">
          <ChatApprovalCard approval={pendingApproval} onDecision={onApprovalDecision} />
        </div>
      )}

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

        {/* Textarea Input */}
        <textarea
          ref={textareaRef}
          data-testid={agentName ? 'agent-chat-input' : undefined}
          data-drop-targeted={dropKind !== null ? true : undefined}
          value={prompt}
          disabled={running}
          onPaste={(event) => {
            if (running) return;
            const dt = event.clipboardData;
            if (!dt) return;

            let files: File[] = Array.from(dt.files ?? []);
            if (files.length === 0 && dt.items) {
              const itemFiles = Array.from(dt.items)
                .filter((item) => item.kind === 'file' || item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null);
              if (itemFiles.length > 0) {
                files = itemFiles;
              }
            }

            if (files.length === 0) return;
            event.preventDefault();
            onStageFiles(files);
          }}
          onChange={(e) => onChangePrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.nativeEvent as any).isComposing) return;
            if (handleHistoryKey(e)) return;

            if (e.key === 'Backspace' && !prompt && attachments.length > 0 && isPlainKey(e)) {
              e.preventDefault();
              onRemoveAttachment(attachments[attachments.length - 1].resourceId);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) {
                historyStateRef.current = { owner: threadId, index: null, draft: '' };
                onSend();
              }
            }
          }}
          placeholder={composerPlaceholder}
          rows={2}
          className="kite-composer-textarea"
        />

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

            {/* Interaction Mode: Plan vs Build */}
            <ComposerControl
              active={Boolean(threadPlan)}
              disabled={running}
              title={threadPlan ? 'Planning Mode: plan created before editing' : 'Build Mode: direct execution'}
              aria-label={threadPlan ? 'Plan mode' : 'Build mode'}
              onClick={() => onUpdateConfig({ plan: !threadPlan })}
            >
              <ComposerControlIcon
                icon={threadPlan ? PencilRulerIcon : BotIcon}
                size={14}
                className={threadPlan ? 'text-primary' : 'text-muted-foreground'}
              />
              <span>{threadPlan ? 'Plan' : 'Build'}</span>
            </ComposerControl>

            <ComposerControlSeparator />

            {/* Runtime / Permission Mode Popover */}
            <PermissionPickerPopover
              threadMode={threadMode}
              permissions={permissions}
              permissionDeclared={permissionDeclared}
              permissionReason={permissionReason}
              disabled={running}
              onSelectPermission={(mode) => onUpdateConfig({ mode })}
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
              className={`size-8 rounded-control inline-flex items-center justify-center border-0 bg-transparent cursor-pointer transition-colors ${
                dictationState === 'recording'
                  ? 'bg-destructive/20 text-destructive'
                  : 'text-muted-foreground hover:text-foreground hover:bg-hover-row'
              }`}
            >
              {dictationState === 'recording' ? (
                <StopIcon size={11} />
              ) : dictationState === 'transcribing' ? (
                <svg
                  className="animate-spin"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                </svg>
              ) : (
                <MicIcon size={14} />
              )}
            </button>

            {/* Token Counter */}
            {totalTokens > 0 && (
              <span className="text-2xs font-mono text-muted-foreground px-1 select-none">
                {formatTokens(totalTokens)}
              </span>
            )}

            {/* Circular Send / Stop Primary Button */}
            {running ? (
              <button
                type="button"
                aria-label="Stop generation"
                title="Stop execution"
                onClick={onStop}
                className="kite-composer-action-btn kite-composer-action-btn--stop"
              >
                <StopIcon size={11} className="fill-current" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send message"
                title="Send prompt (Enter) · New line (Shift+Enter) · Earlier prompts (↑)"
                disabled={!canSend}
                data-testid={agentName ? 'agent-chat-send' : undefined}
                onClick={onSend}
                className="kite-composer-action-btn kite-composer-action-btn--send"
              >
                <ArrowUpIcon size={16} />
              </button>
            )}
          </div>
        </div>
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
