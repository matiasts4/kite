import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import {
  StopIcon,
  PaperclipIcon,
  CloseIcon,
  CompassIcon,
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
import { isControlDeclared, isProviderDeclared, undeclaredReason } from '../../../lib/session/declaration';
import type { DriverDeclaration } from '../../../lib/session/types';
import { SelectMenu } from '../../ui/SelectMenu';
import { EffortPicker } from './EffortPicker';
import { ChatApprovalCard } from './ChatApprovalCard';
import { invokeCommand, listConnections } from '../../../lib/ipc';
import {
  verifiedSpawnConnections,
  type ConnectionCandidate,
} from './connectionBinding';

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
  declaration: DriverDeclaration;
  running: boolean;
  prompt: string;
  attachments: ChatAttachment[];
  totalTokens: number;
  /** Accepted for existing callers; the model menu no longer renders a refresh action. */
  isRefreshingModels?: boolean;
  /** Accepted for existing callers; the model menu no longer renders a refresh action. */
  onRefreshModels?: (provider: ChatProvider) => void;
  /** Loads a provider's live models on demand. Deduplicated per mounted chat session. */
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
  onUpdateConfig: (patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null; plan?: boolean; agent?: string | null; connectionId?: string | null }) => void;
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

/** Makes the reason for an undeclared control available beyond its tooltip. */
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

  // A connection appears here only when it verified this provider's local spawn
  // endpoint. With none or one the send binding is resolved without asking.
  useEffect(() => {
    let active = true;
    void listConnections().then((connections) => {
      if (active) setConnectionCandidates(verifiedSpawnConnections(threadProvider, connections));
    });
    return () => {
      active = false;
    };
  }, [threadProvider]);

  // The model menu is populated in the background; the composer never waits on it.
  useEffect(() => {
    ensureDynamicModels?.(threadProvider);
  }, [ensureDynamicModels, threadProvider]);

  // Drag & drop drop-hint state ('attach' | 'mention' | 'prompt' | null)
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
      el.style.height = '62px';
      el.style.height = `${Math.min(240, Math.max(62, el.scrollHeight))}px`;
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

  const providers = declaration.providers;
  const providerDeclared = isProviderDeclared(declaration, threadProvider);
  const providerRow = providers.find((row) => row.id === threadProvider) ?? null;
  const providerReason = providerDeclared ? null : undeclaredReason(declaration, 'provider');

  const models = declaration.models;
  const liveModels = models.filter((model) => model.id !== AUTOMATIC_MODEL_ID);
  const modelsDeclared = models.length > 0;
  const modelReason =
    liveModels.length > 0 ? null : undeclaredReason(declaration, 'model');
  const currentModelOption = models.find((model) => model.id === threadModel);
  const currentModelName =
    !threadModel || threadModel === AUTOMATIC_MODEL_ID
      ? 'Automatic'
      : currentModelOption?.label || threadModel;
  const modelTriggerLabel = currentModelName.replace(/^Claude /u, '');

  const effortChoices = declaration.effort ?? [];
  const effortDeclared = isControlDeclared(declaration.effort);
  const effortReason = effortDeclared ? null : undeclaredReason(declaration, 'effort');
  const effortValue = threadEffort || declaration.defaultEffort || null;

  const permissions = declaration.permission ?? [];
  const permissionDeclared = isControlDeclared(declaration.permission);
  const permissionReason = permissionDeclared ? null : undeclaredReason(declaration, 'permission');
  const permissionLabel =
    permissions.find((permission) => permission.id === threadMode)?.label || threadMode;

  const workModes = declaration.workMode ?? [];
  const workModeDeclared = isControlDeclared(declaration.workMode);
  const workModeReason = workModeDeclared ? null : undeclaredReason(declaration, 'workMode');
  const selectedWorkMode =
    workModes.find((mode) => (threadAgent ? mode.id === threadAgent : false)) ??
    workModes.find((mode) => mode.plan === Boolean(threadPlan)) ??
    null;

  const canSend = Boolean(prompt.trim() || attachments.length > 0);
  const selectedConnection = connectionCandidates.find(
    (candidate) => candidate.connectionId === threadConnectionId
  );

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
    <div
      className="chat-thread-layout__composer"
      style={{ width: '100%', boxSizing: 'border-box', alignItems: 'stretch' }}
      onDragOver={(event) => {
        if (running) return;
        const kind = getDropKind(event);
        if (kind !== null) {
          event.preventDefault();
        }
      }}
    >
      {/* Approval Card integrated into Composer */}
      {pendingApproval && onApprovalDecision && (
        <div style={{ width: '100%', maxWidth: 'var(--chat-column, 720px)', margin: '0 auto 10px' }}>
          <ChatApprovalCard
            approval={pendingApproval}
            onDecision={onApprovalDecision}
          />
        </div>
      )}

      <div
        className="chat-composer composer"
        style={{ width: '100%', maxWidth: 'var(--chat-column, 720px)', margin: '0 auto', boxSizing: 'border-box' }}
        data-drop={dropKind ?? undefined}
        onDragLeave={(e) => {
          const rel = e.relatedTarget;
          if (rel instanceof Node && e.currentTarget.contains(rel)) return;
          setDropKind(null);
        }}
        onDragOver={(e) => {
          const kind = getDropKind(e);
          if (kind !== null) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDropKind(kind);
          }
        }}
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (t === e.currentTarget || t === footerRef.current || t.classList.contains('chat-composer__spacer')) {
            e.preventDefault();
            textareaRef.current?.focus();
          }
        }}
        onDrop={handleDrop}
      >
        {/* Staged attachments */}
        {attachments.length > 0 && (
          <div className="chat-composer__attachment-area">
            <ul className="chat-composer__attachments">
              {attachments.map((att) => (
                <li key={att.resourceId} className="chat-composer__attachment">
                  <FileCodeIcon size={13} style={{ color: 'var(--text-secondary)' }} />
                  <span title={att.displayName}>{att.displayName}</span>
                  {att.byteSize && <small style={{ color: 'var(--text-faint)' }}>{formatBytes(att.byteSize)}</small>}
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(att.resourceId)}
                    title="Remove attachment"
                  >
                    <CloseIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Input textarea */}
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
        />

        {/* Drop Hint */}
        {dropKind && (
          <span aria-hidden="true" className="chat-composer__drop-hint">
            {dropKind === 'mention'
              ? 'Drop to mention'
              : dropKind === 'prompt'
              ? 'Drop to insert prompt'
              : 'Drop to attach'}
          </span>
        )}

        {/* Composer footer */}
        <div className="chat-composer__footer" ref={footerRef}>
          <div className="chat-composer__controls">
            {/* Attach button: fits strictly in 28px (:first-child > .select-menu-trigger--toolbar) */}
            <SelectMenu
              variant="toolbar"
              label="Attach"
              help="Attach files or a folder"
              triggerIcon={<PaperclipIcon size={14} />}
              panelTitle="Attach to message"
              panelDetail="A folder lets the agent read everything inside it."
              disabled={running}
              rows={[
                { id: 'files', title: 'Add files…', detail: 'Choose one or more files.' },
                { id: 'folder', title: 'Add folder…', detail: 'The agent can read everything inside the folder.' },
              ]}
              onSelect={(kind) => onPickAttachments(kind as 'files' | 'folder')}
            />

            {/* Work mode: wrapped in span.chat-composer__mode to avoid 28px child rule */}
            <span
              className="chat-composer__mode"
              data-execution={threadPlan ? 'plan' : selectedWorkMode?.id ?? 'build'}
            >
              <SelectMenu
                variant="toolbar"
                label="Work mode"
                help={workModeReason ?? 'How this session approaches the task'}
                triggerIcon={<CompassIcon size={12} />}
                triggerLabel={selectedWorkMode?.label ?? (threadPlan ? 'Plan' : 'Work mode')}
                disabled={running || !workModeDeclared}
                value={selectedWorkMode?.id ?? ''}
                panelTitle="Work mode"
                rows={workModes.map((mode) => ({
                  id: mode.id,
                  title: mode.label,
                  detail: mode.detail,
                }))}
                onSelect={(modeId) => {
                  const mode = workModes.find((candidate) => candidate.id === modeId);
                  if (mode) onUpdateConfig({ plan: mode.plan, agent: mode.id });
                }}
              />
            </span>
            {workModeReason && <ControlReason reason={workModeReason} />}

            {/* Permission is the driver's own "how much without asking" switch. */}
            <span className="chat-composer__mode" data-execution={threadMode}>
              <SelectMenu
                variant="toolbar"
                label="Permission"
                help={permissionReason ?? 'How much this session may do without asking'}
                triggerLabel={permissionLabel}
                disabled={running || !permissionDeclared}
                value={threadMode}
                panelTitle="Permission mode"
                rows={permissions.map((permission) => ({
                  id: permission.id,
                  title: permission.label,
                  detail: permission.detail,
                }))}
                onSelect={(mode) => onUpdateConfig({ mode: mode as ChatMode })}
              />
            </span>
            {permissionReason && <ControlReason reason={permissionReason} />}

            {connectionCandidates.length > 1 && onSelectConnection && (
              <SelectMenu
                variant="toolbar"
                label="Connection"
                help="Account connection used for this send"
                triggerLabel={selectedConnection?.displayName ?? 'Choose connection'}
                disabled={running}
                value={threadConnectionId ?? ''}
                panelTitle="Account connection"
                panelDetail="Each account is verified for its own endpoints."
                rows={connectionCandidates.map((candidate) => ({
                  id: candidate.connectionId,
                  title: candidate.displayName,
                  detail: candidate.supportedEndpoint,
                }))}
                onSelect={onSelectConnection}
              />
            )}
          </div>

          <span className="chat-composer__spacer" />

          {/* Token usage counter */}
          {totalTokens > 0 && (
            <span className="chat-composer__usage" title="Total tokens in session">
              {formatTokens(totalTokens)}
            </span>
          )}

          {/* Engine group: child 1 = Provider (30px), child 2 = Model, child 3 = Effort */}
          <div className="chat-composer__engine">
            {/* Child 1: Provider logo only (fits in 30px) */}
            <SelectMenu
              variant="toolbar"
              label="Provider"
              help={providerReason ?? `Provider · ${providerRow?.label ?? declaration.driver}`}
              triggerEngine={providerRow?.engine ?? declaration.driver}
              disabled={running || !providerDeclared}
              value={threadProvider}
              panelTitle="AI Provider"
              rows={providers.map((provider) => ({
                id: provider.id,
                title: provider.label,
                detail: provider.detail,
                engine: provider.engine ?? provider.id,
              }))}
              onSelect={(provider) => onUpdateConfig({ provider: provider as ChatProvider })}
            />

            {/* Child 2: Model selector with label */}
            <SelectMenu
              variant="toolbar"
              label="Model"
              help={modelReason ?? 'Model'}
              searchable
              triggerLabel={modelTriggerLabel}
              disabled={running || !modelsDeclared}
              value={threadModel || AUTOMATIC_MODEL_ID}
              panelTitle={`${providerRow?.label ?? declaration.driver} Models`}
              panelEngine={providerRow?.engine ?? declaration.driver}
              rows={models.map((model) => ({
                id: model.id,
                title: model.label,
                detail: model.detail,
              }))}
              onSelect={(model) => {
                onUpdateConfig({ model: model === AUTOMATIC_MODEL_ID ? null : model });
              }}
            />

            {/* Child 3: EffortPicker (declared levels only) */}
            <EffortPicker
              choices={effortChoices}
              value={effortValue}
              disabled={running || !effortDeclared}
              help={effortReason ?? undefined}
              placement="top"
              onSelect={(val) => onUpdateConfig({ effort: val })}
            />
          </div>
          {providerReason && <ControlReason reason={providerReason} />}
          {modelReason && <ControlReason reason={modelReason} />}
          {effortReason && <ControlReason reason={effortReason} />}

          {/* Dictation Control Button */}
          <span className="dictation-control">
            <button
              type="button"
              className="dictation-control__button"
              data-recording={dictationState === 'recording' || undefined}
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
            >
              {dictationState === 'recording' ? (
                <StopIcon size={10} />
              ) : dictationState === 'transcribing' ? (
                <svg
                  className="animate-spin"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                </svg>
              ) : (
                <MicIcon size={12} />
              )}
            </button>
            <span aria-live="polite" className="sr-only" role="status">
              {dictationState === 'recording' ? 'Listening. Press again to transcribe.' : 'Dictate message'}
            </span>
            {dictationError && (
              <span className="dictation-control__error" role="alert">
                {dictationError}
              </span>
            )}
          </span>

          {/* Send or Stop Button */}
          {running ? (
            <button
              type="button"
              aria-label="Stop generation"
              title="Stop execution"
              className="chat-composer__stop"
              onClick={onStop}
            >
              <StopIcon size={10} />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send message"
              title="Send prompt (Enter) · New line (Shift+Enter) · Earlier prompts (↑)"
              disabled={!canSend}
              className="chat-composer__send"
              data-testid={agentName ? 'agent-chat-send' : undefined}
              onClick={onSend}
            >
              <ArrowUpIcon size={16} />
            </button>
          )}
        </div>
      </div>
  </div>
  );
};
