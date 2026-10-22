import React, { useRef, useEffect, useState } from 'react';
import {
  FolderIcon,
  GitBranchIcon,
  SquarePenIcon,
  PanelRightIcon,
  CloseIcon,
  CheckIcon,
} from './ChatIcons';
import {
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  ChatProvider,
  ChatMode,
  PROVIDER_CATALOG,
  formatTokens,
  getActivePlan,
} from './types';
import { BrandLogo } from '../../ui/BrandLogo';
import { invokeCommand } from '../../../lib/ipc';
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows } from './ChatItemRow';
import { ChatComposer } from './ChatComposer';
import { ChatPlanPanel, PlanActionPayload } from './ChatPlanPanel';
import { ThreadInspector } from './ThreadInspector';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import { useTranscriptLiveEdge, useTranscriptMotion } from '../../../motion/useTranscriptMotion';

export interface SingleThreadPaneProps {
  thread: ExtendedChatThread;
  workspaceId: string | null;
  workspaceName?: string;
  workspaces?: Array<{ id: string; displayName?: string; name?: string }>;
  agentName?: string;
  engineLabel?: string;
  isFocused: boolean;
  isMulti: boolean;
  running: boolean;
  prompt: string;
  attachments: ChatAttachment[];
  liveRunsCount: number;
  dynamicModels: ModelOption[];
  isRefreshingModels?: boolean;
  onRefreshModels?: (provider: ChatProvider) => void;
  activeDropdown?: { threadId: string; type: 'provider' | 'model' | 'mode' } | null;
  editingTitleId: string | null;
  titleInput: string;
  showHistoryPopover?: boolean;
  knownThreadsList?: ExtendedChatThread[];
  onFocus: () => void;
  onClosePane: () => void;
  onToggleSplit?: () => void;
  onToggleHistory?: () => void;
  onNewThread: () => void;
  onSelectHistoryThread?: (id: string) => void;
  onPinThread?: (id: string, e: React.MouseEvent) => void;
  onArchiveThread?: (id: string, e: React.MouseEvent) => void;
  onStartRename: (id: string, title: string) => void;
  onSaveRename: () => void;
  onChangeTitleInput: (val: string) => void;
  onCancelRename: () => void;
  onChangePrompt: (val: string) => void;
  onSend: (overridePrompt?: string, planAction?: PlanActionPayload) => Promise<boolean | void> | void;
  onStop: () => void;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
  onStageFiles: (files: File[]) => void;
  onStagePaths: (paths: string[]) => void;
  onRemoveAttachment: (resId: string) => void;
  onDropdownToggle?: (type: 'provider' | 'model' | 'mode') => void;
  onUpdateConfig: (patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null; plan?: boolean }) => void;
  onApprovalDecision: (decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop', reqId: string) => void;
  embedded?: boolean;
}

export const SingleThreadPane: React.FC<SingleThreadPaneProps> = ({
  thread,
  workspaceId,
  workspaceName,
  workspaces,
  agentName,
  engineLabel,
  isFocused,
  isMulti,
  embedded = false,
  running,
  prompt,
  attachments,
  liveRunsCount: _liveRunsCount,
  dynamicModels,
  editingTitleId,
  titleInput,
  onFocus,
  onClosePane,
  onNewThread,
  onStartRename,
  onSaveRename,
  onChangeTitleInput,
  onCancelRename,
  onChangePrompt,
  onSend,
  onStop,
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onUpdateConfig,
  onApprovalDecision,
  isRefreshingModels,
  onRefreshModels,
}) => {
  const currentWorkspace = workspaces?.find((w) => w.id === (thread.workspaceId || workspaceId));
  const effectiveWorkspaceName =
    workspaceName ||
    currentWorkspace?.displayName ||
    currentWorkspace?.name ||
    (thread.workspaceId || workspaceId ? 'Workspace' : null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const [showsChanges, setShowsChanges] = useState(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState<number>(0);
  const [visibleLimit, setVisibleLimit] = useState<number>(200);
  const [inspectorTab, setInspectorTab] = useState<'changes' | 'files' | 'browser'>('changes');
  const [inspectorFilePath, setInspectorFilePath] = useState<string | undefined>(undefined);

  // Live timer every 1s when running or waiting
  useEffect(() => {
    const isWorking = running || thread.status === 'running' || thread.status === 'waiting';
    if (!isWorking) {
      setElapsedSecs(0);
      return;
    }
    const startMs = Date.now();
    setElapsedSecs(0);
    const timer = setInterval(() => {
      setElapsedSecs(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [running, thread.status]);

  // Listen for open-inspector-file custom event
  useEffect(() => {
    const handleOpenFile = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) {
        setInspectorTab('files');
        setInspectorFilePath(detail.path);
        setShowsChanges(true);
      }
    };
    window.addEventListener('kite:open-inspector-file', handleOpenFile);
    return () => window.removeEventListener('kite:open-inspector-file', handleOpenFile);
  }, []);

  const atLiveEdgeRef = useRef(true);
  const motionClassFor = useTranscriptMotion(
    thread.id,
    thread.items.map((item) => item.id),
  );
  useTranscriptLiveEdge(transcriptRef, thread.id, atLiveEdgeRef);

  const providerMeta = (PROVIDER_CATALOG as Record<string, any>)[thread.provider] || PROVIDER_CATALOG.claude;
  const models: ModelOption[] = providerMeta.isDynamic && dynamicModels.length > 0 ? dynamicModels : providerMeta.models;
  const currentModelOption = models.find((m) => m.id === thread.model);
  const currentModelName = currentModelOption?.name || thread.model || providerMeta.defaultModel;

  const totalTokens = (thread.usage?.inputTokens || 0) + (thread.usage?.outputTokens || 0);
  const activePlan = getActivePlan(thread);

  const formatElapsed = (secs: number): string => {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  };

  useEffect(() => {
    const wsId = thread.workspaceId || workspaceId;
    if (!wsId) {
      setGitBranch(null);
      return;
    }
    let active = true;
    void invokeCommand<{ isRepo: boolean; branch?: string }>(
      'read_workspace_changes',
      { workspaceId: wsId }
    )
      .then((res) => {
        if (!active || !res) return;
        if (res.branch) setGitBranch(res.branch);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [thread.workspaceId, workspaceId]);

  const isDraft = thread.items.length === 0 && !running;
  const transcriptRows = groupTranscriptRows(thread.items);
  const totalRows = transcriptRows.length;
  const displayedRows =
    totalRows > visibleLimit
      ? transcriptRows.slice(totalRows - visibleLimit)
      : transcriptRows;

  return (
    <section
      onClick={onFocus}
      className={
        embedded
          ? `code-thread-pane chat-surface chat-surface--thread agent-chat-surface${
              isMulti ? ' chat-surface--grid-pane' : ''
            }${isFocused ? ' chat-surface--grid-focused' : ''}`
          : agentName
          ? 'pane chat-surface chat-surface--thread agent-chat-surface min-h-0'
          : `pane chat-surface chat-surface--thread agent-chat-surface${
              isMulti ? ' chat-surface--grid-pane' : ''
            }${isFocused ? ' chat-surface--grid-focused' : ''}`
      }
    >
      {/* Thread Header — Thread mode only. Agent chats use the tab rail; embedded code panes use CodePaneHeader. */}
      {!agentName && !embedded && (
        <header className="chat-thread-header" role="toolbar" aria-label="Thread header">
          <div className="chat-thread-header__place">
            <FolderIcon size={14} style={{ color: 'var(--text-secondary)' }} />
            <strong title={effectiveWorkspaceName ? `Active Workspace: ${effectiveWorkspaceName}` : 'Kite General'}>
              {effectiveWorkspaceName ?? 'No folder'}
            </strong>

            {gitBranch ? (
              <span className="chat-thread-header__branch">
                <GitBranchIcon size={10} />
                <span>{gitBranch}</span>
              </span>
            ) : null}

            {editingTitleId === thread.id ? (
              <div
                className="chat-rail-rename chat-rail-rename--row"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  value={titleInput}
                  autoFocus
                  onChange={(e) => onChangeTitleInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSaveRename();
                    if (e.key === 'Escape') onCancelRename();
                  }}
                />
                <button
                  type="button"
                  onClick={onSaveRename}
                  title="Save title"
                >
                  <CheckIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={onCancelRename}
                  title="Cancel"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ) : (
              <div
                className="chat-thread-header__title"
                style={{ cursor: 'pointer' }}
                onClick={() => onStartRename(thread.id, thread.title)}
                title="Click to rename"
              >
                <span>{thread.title || 'Chat Thread'}</span>
              </div>
            )}
          </div>

          {/* Trailing controls */}
          <div className="chat-thread-header__trailing">
            {/* Informative model badge */}
            <span className="chat-thread-header__model">
              <BrandLogo
                engine={providerMeta.engineId || thread.provider}
                label={providerMeta.label}
                size={13}
              />
              <span>{currentModelName.replace(/^Claude /u, '')}</span>
            </span>

            {/* Usage readout */}
            {totalTokens > 0 && (
              <span className="chat-thread-header__usage">{formatTokens(totalTokens)}</span>
            )}

            {/* Status indicator */}
            <span
              className={`chat-thread-header__status chat-thread-header__status--${
                running
                  ? 'running'
                  : thread.status === 'waiting'
                  ? 'waiting'
                  : thread.status === 'error'
                  ? 'error'
                  : 'idle'
              }`}
              role="status"
            >
              <i />
              {running ? (
                <span className="chat-thread-header__clock">
                  Working · {formatElapsed(elapsedSecs)}
                </span>
              ) : thread.status === 'waiting' ? (
                <span className="chat-thread-header__clock">
                  Waiting · {formatElapsed(elapsedSecs)}
                </span>
              ) : null}
            </span>

            {/* New Thread */}
            <button
              type="button"
              className="chrome-button"
              aria-label="New thread"
              title="New thread"
              onClick={onNewThread}
            >
              <SquarePenIcon size={13} />
            </button>

            {/* Changes / Inspector toggle */}
            <button
              type="button"
              className={`chrome-button${showsChanges ? ' chrome-button--active' : ''}`}
              data-changes-toggle
              aria-label="Show inspector"
              title={showsChanges ? 'Hide changes panel' : 'View file changes and diffs'}
              onClick={() => setShowsChanges((v) => !v)}
            >
              <PanelRightIcon size={13} />
            </button>

            {/* Close pane if in multi-pane view */}
            {isMulti && (
              <button
                type="button"
                className="chrome-button chat-thread-header__close"
                aria-label="Remove thread from view"
                title="Remove from view (Ctrl+W)"
                onClick={onClosePane}
              >
                <CloseIcon size={13} />
              </button>
            )}
          </div>
        </header>
      )}

      {/* Frame containing Main Transcript and Lateral ThreadInspector */}
      <div className="chat-thread-frame">
        <div className="chat-thread-main">
          <div className={`chat-thread-layout${isDraft ? ' chat-thread-layout--draft' : ''}`}>
            {/* Layout body: renders null when isDraft to prevent empty transcript pushing hero up */}
            <div className="chat-thread-layout__body">
              {isDraft ? null : (
                <div
                  className="chat-transcript"
                  ref={transcriptRef}
                  onScroll={(e) => {
                    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget;
                    atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= 48;
                  }}
                >
                  <div className="chat-transcript__column">
                    {displayedRows.length < transcriptRows.length && (
                      <div
                        className="chat-transcript__earlier"
                        style={{
                          display: 'flex',
                          justifyContent: 'center',
                          padding: '12px 0',
                        }}
                      >
                        <button
                          type="button"
                          className="secondary-button chat-transcript__earlier-btn"
                          onClick={() => {
                            if (!transcriptRef.current) {
                              setVisibleLimit((prev) => prev + 200);
                              return;
                            }
                            const prevScrollHeight = transcriptRef.current.scrollHeight;
                            setVisibleLimit((prev) => prev + 200);
                            requestAnimationFrame(() => {
                              if (transcriptRef.current) {
                                const diff = transcriptRef.current.scrollHeight - prevScrollHeight;
                                transcriptRef.current.scrollTop += diff;
                              }
                            });
                          }}
                          style={{
                            fontSize: '12px',
                            padding: '6px 14px',
                            borderRadius: '6px',
                          }}
                        >
                          Show earlier messages ({displayedRows.length} of {transcriptRows.length} shown)
                        </button>
                      </div>
                    )}

                    {displayedRows.map((row) =>
                      row.kind === 'work' ? (
                        <ChatWorkGroup
                          key={row.id}
                          items={row.items}
                          running={running}
                          motionClassFor={motionClassFor}
                        />
                      ) : (
                        <ChatItemRow
                          key={row.item.id}
                          item={row.item}
                          threadId={thread.id}
                          motionClass={motionClassFor(row.item.id)}
                        />
                      )
                    )}

                    {/* Thinking / Running Stage Indicator */}
                    {(running || thread.status === 'waiting') && (() => {
                      const activeTool = [...thread.items]
                        .reverse()
                        .find((it) => (it.kind === 'tool' || it.kind === 'command') && (it.streaming || it.status === 'running'));
                      const isStreamingAssistant = thread.items.some(
                        (it) => it.kind === 'assistant' && it.streaming && it.text.trim().length > 0
                      );
                      const stageLabel = thread.pendingApproval
                        ? `Waiting for approval · ${thread.pendingApproval.title || thread.pendingApproval.toolName}`
                        : activeTool
                          ? `Executing ${activeTool.title || activeTool.toolName || 'tool'}…`
                          : isStreamingAssistant
                            ? 'Generating response…'
                            : 'Thinking…';
                      return (
                        <div
                          className={`chat-working-row motion-row-in ${
                            thread.pendingApproval ? 'chat-working-row--waiting' : ''
                          }`}
                        >
                          <span className="chat-working-row__dots">
                            <i />
                            <i />
                            <i />
                          </span>
                          <span className="chat-working-row__stage">{stageLabel}</span>
                        </div>
                      );
                    })()}

                    {/* Quota Handoff Banner */}
                    {thread.quotaHandoffOffer && (
                      <QuotaHandoffBanner
                        offer={thread.quotaHandoffOffer}
                        threadId={thread.id}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Draft hero rendered when empty */}
            {isDraft ? (
              <div className={agentName ? 'chat-draft-hero agent-chat-hero scroll-quiet' : 'chat-draft-hero scroll-quiet'}>
                <h1>
                  {agentName ? (
                    'What should we build?'
                  ) : effectiveWorkspaceName ? (
                    <>
                      What are we shipping in{' '}
                      <strong className="chat-draft-hero__folder">{effectiveWorkspaceName}</strong>?
                    </>
                  ) : (
                    "What's on your mind?"
                  )}
                </h1>
                <p>
                  {agentName
                    ? null
                    : effectiveWorkspaceName
                    ? 'Pick a model. Then say the work.'
                    : 'Pick a model. Then ask.'}
                </p>
                {!agentName && !effectiveWorkspaceName && (
                  <button
                    type="button"
                    className="secondary-button action-button--row chat-draft-hero__action"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('kite:add-workspace'));
                    }}
                  >
                    <FolderIcon size={13} />
                    <span>Add a folder</span>
                  </button>
                )}
              </div>
            ) : null}

            {/* Composer Area with Proposed Plan Panel mounted directly above */}
            {activePlan && (
              <div style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: '0 var(--space-6)', boxSizing: 'border-box' }}>
                <ChatPlanPanel
                  key={`plan-${thread.id}-${activePlan.id}`}
                  plan={activePlan}
                  disabled={running || thread.status === 'waiting'}
                  onSend={(text, planAction) => onSend(text, planAction)}
                />
              </div>
            )}

            <ChatComposer
              threadId={thread.id}
              threadItems={thread.items}
              agentName={agentName}
              engineLabel={engineLabel}
              threadMode={thread.mode}
              threadPlan={thread.plan}
              threadProvider={thread.provider}
              threadModel={thread.model}
              threadEffort={thread.effort}
              running={running}
              prompt={prompt}
              attachments={attachments}
              totalTokens={totalTokens}
              dynamicModels={dynamicModels}
              isRefreshingModels={isRefreshingModels}
              onRefreshModels={onRefreshModels}
              onChangePrompt={onChangePrompt}
              onSend={() => onSend()}
              onStop={onStop}
              onPickAttachments={onPickAttachments}
              onStageFiles={onStageFiles}
              onStagePaths={onStagePaths}
              onRemoveAttachment={onRemoveAttachment}
              onUpdateConfig={onUpdateConfig}
              pendingApproval={thread.pendingApproval}
              onApprovalDecision={onApprovalDecision}
            />

            <div aria-hidden="true" className="chat-thread-layout__tail" />
          </div>
        </div>

        {/* Lateral Inspector Panel */}
        <ThreadInspector
          threadId={thread.id}
          workspaceId={thread.workspaceId || workspaceId}
          workspaceName={effectiveWorkspaceName ?? undefined}
          isOpen={showsChanges}
          initialTab={inspectorTab}
          initialFilePath={inspectorFilePath}
          onClose={() => setShowsChanges(false)}
        />
      </div>
    </section>
  );
};
