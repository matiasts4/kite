import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  CloseIcon,
  CheckIcon,
  FileCodeIcon,
  ChevronDownIcon,
  SearchIcon,
  PencilIcon,
} from './ChatIcons';
import {
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  ChatProvider,
  ChatMode,
  PROVIDER_CATALOG,
  getActivePlan,
} from './types';
import { BrandLogo } from '../../ui/BrandLogo';
import {
  invokeCommand,
  listWorkspaceBranches,
  switchWorkspaceBranch,
  createWorkspaceBranch,
  rewindThreadTranscript,
  restoreThreadCheckpoint,
} from '../../../lib/ipc';
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows, liveActivityRowIndex } from './ChatItemRow';
import { filterTranscriptForVisibility, readToolVisibility, TOOL_VISIBILITY_EVENT, type ToolVisibilityMode } from './toolVisibility';
import { QueuedRunsControl } from './QueuedRunsControl';
import { SideChatPane } from './SideChatPane';
import { TurnActivityStatus } from './TurnActivityStatus';
import { ChatComposer } from './ChatComposer';
import { SessionLifecycleBar } from './SessionLifecycleBar';
import { declarationFromCatalog } from './driverDeclaration';
import { getSavedSelectedModel, getSavedSelectedAgent } from './modelPersistence';
import type { DriverDeclaration, SessionProjection } from '../../../lib/session/types';
import { ChatPlanPanel, PlanActionPayload } from './ChatPlanPanel';
import { ThreadErrorBanner } from './ThreadErrorBanner';
import { openSettingsTab } from '../../../lib/settingsNav';
import { ChangedFilesCard } from './ChangedFilesCard';
import { HtmlRenderFrame } from './HtmlRenderFrame';
import { ComposerPendingUserInputPanel } from './ComposerPendingUserInputPanel';
import { ChatApprovalCard } from './ChatApprovalCard';
import { ThreadUsageCard } from './ThreadUsageCard';
import { bringBackAllowed, childApprovals, childStopIds, directMessageNotice } from './childApprovals';
import { compactSendText, fileRestoreAllowed } from './threadInteraction';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import { useTranscriptLiveEdge, useTranscriptMotion } from '../../../motion/useTranscriptMotion';
import { formatWorkingClock } from './activityPresentation';

function composeRewoundPrompt(draft: string, rewound: string): string {
  if (!draft.trim()) return rewound;
  if (draft.trim() === rewound.trim()) return rewound;
  return `${draft.replace(/\s+$/, '')}\n\n${rewound}`;
}

function changedFilesForTurn(items: ExtendedChatThread['items']) {
  let start = 0;
  items.forEach((item, index) => {
    if (item.kind === 'user') start = index + 1;
  });
  const files = new Map<string, { path: string; additions: number; deletions: number }>();
  for (const item of items.slice(start)) {
    if (!item.filePath) continue;
    if (item.toolKind !== 'fileChange' && item.addedLines == null && item.removedLines == null) continue;
    files.set(item.filePath, {
      path: item.filePath,
      additions: item.addedLines ?? 0,
      deletions: item.removedLines ?? 0,
    });
  }
  return [...files.values()];
}

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
  catalogState?: 'missing-binary' | 'signed-out' | 'loading' | 'empty' | null;
  dynamicAgents?: any[];
  ensureDynamicAgents?: (provider: ChatProvider) => void;
  /** Declaration supplied by the session layer for this thread. */
  driverDeclaration?: DriverDeclaration | null;
  /** Projection supplied by the session layer for this thread. */
  session?: SessionProjection | null;
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
  onStopThread?: (threadId: string) => void;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
  onStageFiles: (files: File[]) => void;
  onStagePaths: (paths: string[]) => void;
  onRemoveAttachment: (resId: string) => void;
  onDropdownToggle?: (type: 'provider' | 'model' | 'mode') => void;
  onUpdateConfig: (patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null; plan?: boolean; agent?: string | null; connectionId?: string | null; workspaceId?: string | null }) => void;
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
  catalogState = null,
  dynamicAgents = [],
  ensureDynamicAgents,
  driverDeclaration,
  session,
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
  onStopThread,
  knownThreadsList = [],
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onUpdateConfig,
  onApprovalDecision,
  isRefreshingModels,
  onRefreshModels,
}) => {
  const activeWsId = thread.workspaceId || workspaceId;
  const currentWorkspace = workspaces?.find((w) => w.id === activeWsId);
  const effectiveWorkspaceName =
    currentWorkspace?.displayName ||
    currentWorkspace?.name ||
    workspaceName ||
    (activeWsId ? 'Workspace' : null);

  const effectiveModel = thread.model || getSavedSelectedModel(thread.provider);
  const effectiveAgent = (thread as any).agent || (thread as any).workMode || getSavedSelectedAgent(thread.provider) || null;

  const declaration = React.useMemo(
    () =>
      driverDeclaration ??
      declarationFromCatalog({
        provider: thread.provider,
        selectedModel: effectiveModel,
        dynamicModels,
        dynamicAgents,
      }),
    [driverDeclaration, thread.provider, effectiveModel, dynamicModels, dynamicAgents]
  );

  const transcriptRef = useRef<HTMLDivElement>(null);
  const [hiddenFromId, setHiddenFromId] = useState<string | null>(null);
  const [isRepo, setIsRepo] = useState(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState<number>(0);
  const [visibleLimit, setVisibleLimit] = useState<number>(200);

  // Workspace dropdown state
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
  const wsDropdownRef = useRef<HTMLDivElement>(null);

  // Git branch dropdown state
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [newBranchInput, setNewBranchInput] = useState('');
  const [branchError, setBranchError] = useState<string | null>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Click outside to close popovers
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wsDropdownRef.current && !wsDropdownRef.current.contains(target)) {
        setWsDropdownOpen(false);
      }
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(target)) {
        setBranchDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', handleGlobalClick);
    return () => window.removeEventListener('mousedown', handleGlobalClick);
  }, []);

  const loadBranches = useCallback(async () => {
    const wsId = thread.workspaceId || workspaceId;
    if (!wsId) return;
    setBranchesLoading(true);
    setBranchError(null);
    try {
      const res = await listWorkspaceBranches(wsId);
      if (res) {
        setBranches(res.branches || []);
        if (res.current) setGitBranch(res.current);
      }
    } catch (err: any) {
      setBranchError(err?.message || 'Failed to list branches');
    } finally {
      setBranchesLoading(false);
    }
  }, [thread.workspaceId, workspaceId]);

  const handleSwitchBranch = async (b: string) => {
    const wsId = thread.workspaceId || workspaceId;
    if (!wsId) return;
    setBranchError(null);
    try {
      const res = await switchWorkspaceBranch(wsId, b);
      if (res?.current) setGitBranch(res.current);
      if (res?.branches) setBranches(res.branches);
      setBranchDropdownOpen(false);
    } catch (err: any) {
      setBranchError(err?.message || `Failed to switch to ${b}`);
    }
  };

  const handleCreateBranch = async (branchName?: string) => {
    const wsId = thread.workspaceId || workspaceId;
    const name = (typeof branchName === 'string' && branchName.trim()) ? branchName.trim() : newBranchInput.trim();
    if (!wsId || !name) return;
    setBranchError(null);
    try {
      const res = await createWorkspaceBranch(wsId, name);
      if (res?.current) setGitBranch(res.current);
      if (res?.branches) setBranches(res.branches);
      setNewBranchInput('');
      setIsCreatingBranch(false);
      setBranchDropdownOpen(false);
    } catch (err: any) {
      setBranchError(err?.message || `Failed to create ${name}`);
    }
  };

  const filteredBranches = React.useMemo(() => {
    const q = branchSearch.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, branchSearch]);

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

  const atLiveEdgeRef = useRef(true);
  const transcriptItems = React.useMemo(() => {
    if (!hiddenFromId) return thread.items;
    const index = thread.items.findIndex((item) => item.id === hiddenFromId && item.kind === 'user');
    if (index < 0) return thread.items;
    return thread.items.slice(0, index);
  }, [thread.items, hiddenFromId]);
  const enterFor = useTranscriptMotion(
    thread.id,
    transcriptItems.map((item) => item.id),
  );
  useEffect(() => {
    setHiddenFromId(null);
  }, [thread.id]);
  const rewindFromMessage = useCallback(async (messageId: string) => {
    const result = await rewindThreadTranscript(thread.id, messageId);
    if (result?.error) throw new Error(result.error);
    setHiddenFromId(messageId);
  }, [thread.id]);
  useTranscriptLiveEdge(transcriptRef, thread.id, atLiveEdgeRef);

  const providerMeta = (PROVIDER_CATALOG as Record<string, any>)[thread.provider] || PROVIDER_CATALOG.claude;
  const currentModelOption = dynamicModels.find((m) => m.id === thread.model);
  const currentModelName = currentModelOption?.name || (thread.model ? thread.model : 'Automatic');

  const totalTokens = (thread.usage?.inputTokens || 0) + (thread.usage?.outputTokens || 0);
  const directNotice = directMessageNotice(thread);
  const renderUsageCard = () => (
    <ThreadUsageCard
      reported={thread.usageReported}
      inputTokens={thread.usage?.inputTokens}
      outputTokens={thread.usage?.outputTokens}
      contextWindowTokens={thread.contextWindowTokens}
    />
  );
  const stopRunning = () => {
    try {
      if (onStopThread) {
        for (const id of childStopIds(thread.id, knownThreadsList)) onStopThread(id);
      }
    } finally {
      onStop();
    }
  };
  const activePlan = getActivePlan(thread);
  const [dismissedPlanIds, setDismissedPlanIds] = useState<Set<string>>(new Set());
  const [failureDismissed, setFailureDismissed] = useState(false);
  const isPlanDismissed = activePlan ? dismissedPlanIds.has(activePlan.id) : false;

  const formatElapsed = (secs: number): string => {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  };

  useEffect(() => {
    const wsId = thread.workspaceId || workspaceId;
    if (!wsId) {
      setIsRepo(false);
      setGitBranch(null);
      setBranches([]);
      return;
    }
    let active = true;
    void invokeCommand<{ isRepo: boolean; branch?: string }>(
      'read_workspace_changes',
      { workspaceId: wsId }
    )
      .then((res) => {
        if (!active || !res) return;
        setIsRepo(Boolean(res.isRepo));
        if (res.branch) setGitBranch(res.branch);
      })
      .catch(() => {});

    void listWorkspaceBranches(wsId)
      .then((res) => {
        if (!active || !res) return;
        if (res.branches) setBranches(res.branches);
        if (res.current) setGitBranch(res.current);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [thread.workspaceId, workspaceId]);

  const isDraft = transcriptItems.length === 0 && !running;
  const [toolVisibility, setToolVisibility] = useState<ToolVisibilityMode>(() => readToolVisibility());
  const [queuedRuns, setQueuedRuns] = useState(thread.queuedRuns ?? []);
  const [sideQuestion, setSideQuestion] = useState<string | null>(null);
  useEffect(() => {
    const onSide = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; question?: string }>).detail;
      if (detail?.threadId === thread.id && detail.question) setSideQuestion(detail.question);
    };
    window.addEventListener('kite:side-chat', onSide);
    return () => window.removeEventListener('kite:side-chat', onSide);
  }, [thread.id]);
  useEffect(() => {
    setQueuedRuns(thread.queuedRuns ?? []);
  }, [thread.queuedRuns]);
  useEffect(() => {
    const onVisibility = (event: Event) => {
      const mode = (event as CustomEvent<ToolVisibilityMode>).detail;
      if (mode) setToolVisibility(mode);
    };
    window.addEventListener(TOOL_VISIBILITY_EVENT, onVisibility);
    return () => window.removeEventListener(TOOL_VISIBILITY_EVENT, onVisibility);
  }, []);
  const transcriptRows = groupTranscriptRows(filterTranscriptForVisibility(transcriptItems, toolVisibility));
  const totalRows = transcriptRows.length;
  const displayedRows =
    totalRows > visibleLimit
      ? transcriptRows.slice(totalRows - visibleLimit)
      : transcriptRows;
  const failureBanner = thread.turnFailure && !failureDismissed ? (
    <ThreadErrorBanner
      failure={thread.turnFailure}
      onDismiss={() => setFailureDismissed(true)}
      onResume={() => onSend()}
      onResumeAtReset={(resetAtUnixMs) => {
        const delay = Math.max(0, resetAtUnixMs - Date.now());
        window.setTimeout(() => onSend(), delay);
      }}
      onSignIn={() => {
        openSettingsTab('quotas', thread.provider);
      }}
    />
  ) : null;

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
      {(agentName || embedded) ? <div className="chat-thread-header-area">{renderUsageCard()}</div> : null}
      {!agentName && !embedded && (
        <header className="chat-thread-header" role="toolbar" aria-label="Thread header">
          <div className="chat-thread-header__place">
            {/* Workspace / Project selector */}
            <div className="chat-thread-header__menu-wrap" ref={wsDropdownRef}>
              <button
                type="button"
                className={`chat-thread-header__ws-btn${wsDropdownOpen ? ' chat-thread-header__ws-btn--active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setWsDropdownOpen((v) => !v);
                  setBranchDropdownOpen(false);
                }}
                title={effectiveWorkspaceName ? `Active project: ${effectiveWorkspaceName} (Click to switch)` : 'Select project folder'}
              >
                <FolderIcon size={13} style={{ color: 'var(--text-secondary)' }} />
                <strong>{effectiveWorkspaceName ?? 'No folder'}</strong>
                <ChevronDownIcon size={10} className={`chat-thread-header__chevron${wsDropdownOpen ? ' chat-thread-header__chevron--open' : ''}`} />
              </button>

              {wsDropdownOpen && (
                <div className="chat-thread-header__menu" onClick={(e) => e.stopPropagation()}>
                  <div className="chat-thread-header__menu-header">Select Project</div>
                  <div className="chat-thread-header__menu-list">
                    {workspaces && workspaces.length > 0 ? (
                      workspaces.map((ws) => {
                        const isSelected = ws.id === (thread.workspaceId || workspaceId);
                        return (
                          <button
                            key={ws.id}
                            type="button"
                            className={`chat-thread-header__menu-item${isSelected ? ' chat-thread-header__menu-item--selected' : ''}`}
                            onClick={() => {
                              onUpdateConfig({ workspaceId: ws.id });
                              setWsDropdownOpen(false);
                            }}
                          >
                            <FolderIcon size={13} />
                            <span className="chat-thread-header__menu-item-text">{ws.displayName || ws.name || ws.id}</span>
                            {isSelected && <CheckIcon size={12} className="chat-thread-header__menu-item-check" />}
                          </button>
                        );
                      })
                    ) : (
                      <div className="chat-thread-header__menu-empty">No projects found</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Git Branch Selector & Creator */}
            {(isRepo || gitBranch) && (
              <div className="chat-thread-header__menu-wrap" ref={branchDropdownRef}>
                <button
                  type="button"
                  className={`chat-thread-header__branch-btn${branchDropdownOpen ? ' chat-thread-header__branch-btn--active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = !branchDropdownOpen;
                    setBranchDropdownOpen(next);
                    setWsDropdownOpen(false);
                    if (next) {
                      setBranchSearch('');
                      setIsCreatingBranch(false);
                      setNewBranchInput('');
                      void loadBranches();
                    }
                  }}
                  title={`Git Branch: ${gitBranch || 'detached'} (Click to switch or create)`}
                >
                  <GitBranchIcon size={11} />
                  <span>{gitBranch || 'branch'}</span>
                  <ChevronDownIcon size={10} className={`chat-thread-header__chevron${branchDropdownOpen ? ' chat-thread-header__chevron--open' : ''}`} />
                </button>

                {branchDropdownOpen && (
                  <div className="chat-thread-header__menu chat-thread-header__menu--branch" onClick={(e) => e.stopPropagation()}>
                    <div className="chat-thread-header__menu-header">
                      <span>Git Branches</span>
                      {!isCreatingBranch && (
                        <button
                          type="button"
                          className="chat-thread-header__menu-action-btn"
                          onClick={() => {
                            setIsCreatingBranch(true);
                            setBranchError(null);
                          }}
                          title="Create new branch"
                        >
                          <PlusIcon size={10} />
                          <span>New</span>
                        </button>
                      )}
                    </div>

                    {branchError && (
                      <div className="chat-thread-header__menu-error">
                        {branchError}
                      </div>
                    )}

                    {isCreatingBranch ? (
                      <div className="chat-thread-header__create-branch-box">
                        <input
                          type="text"
                          placeholder="branch-name"
                          value={newBranchInput}
                          autoFocus
                          onChange={(e) => setNewBranchInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleCreateBranch();
                            if (e.key === 'Escape') setIsCreatingBranch(false);
                          }}
                        />
                        <div className="chat-thread-header__create-branch-actions">
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => void handleCreateBranch()}
                            disabled={!newBranchInput.trim()}
                          >
                            Create
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => setIsCreatingBranch(false)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="chat-thread-header__menu-search">
                          <SearchIcon size={12} />
                          <input
                            type="text"
                            placeholder="Filter branches..."
                            value={branchSearch}
                            autoFocus
                            onChange={(e) => setBranchSearch(e.target.value)}
                          />
                        </div>

                        <div className="chat-thread-header__menu-list">
                          {branchesLoading ? (
                            <div className="chat-thread-header__menu-loading">Loading branches...</div>
                          ) : filteredBranches.length > 0 ? (
                            filteredBranches.map((b) => {
                              const isCurrent = b === gitBranch;
                              return (
                                <button
                                  key={b}
                                  type="button"
                                  className={`chat-thread-header__menu-item${isCurrent ? ' chat-thread-header__menu-item--selected' : ''}`}
                                  onClick={() => void handleSwitchBranch(b)}
                                >
                                  <GitBranchIcon size={12} />
                                  <span className="chat-thread-header__menu-item-text">{b}</span>
                                  {isCurrent && <CheckIcon size={12} className="chat-thread-header__menu-item-check" />}
                                </button>
                              );
                            })
                          ) : (
                            <div className="chat-thread-header__menu-empty">
                              {branchSearch.trim() ? (
                                <button
                                  type="button"
                                  className="chat-thread-header__create-from-search-btn"
                                  onClick={() => {
                                    setNewBranchInput(branchSearch.trim());
                                    setIsCreatingBranch(true);
                                  }}
                                >
                                  Create branch "{branchSearch.trim()}"
                                </button>
                              ) : (
                                'No branches found'
                              )}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Chat Title with inline rename */}
            {editingTitleId === thread.id ? (
              <div
                className="chat-rail-rename chat-rail-rename--row"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  value={titleInput}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => onChangeTitleInput(e.target.value)}
                  onBlur={onSaveRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSaveRename();
                    if (e.key === 'Escape') onCancelRename();
                  }}
                />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onSaveRename}
                  title="Save title"
                >
                  <CheckIcon size={12} />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onCancelRename}
                  title="Cancel"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ) : (
              <div
                className="chat-thread-header__title-wrap"
                onClick={() => onStartRename(thread.id, thread.title)}
                title="Click to rename chat"
              >
                <span className="chat-thread-header__title-text">{thread.title || 'Chat Thread'}</span>
                <PencilIcon size={11} className="chat-thread-header__title-icon" />
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

            {renderUsageCard()}

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
                  Working · {formatWorkingClock(elapsedSecs)}
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
              <PlusIcon size={13} />
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

      {/* Frame containing Main Transcript */}
      <div className="chat-thread-frame">
        <div className="chat-thread-main">
          <div className={`chat-thread-layout${isDraft ? ' chat-thread-layout--draft' : ''}`}>
            {/* Layout body: renders null when isDraft to prevent empty transcript pushing hero up */}
            <div className="chat-thread-layout__body">
              {failureBanner}
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

                    {displayedRows.map((row, index) => {
                      const rowKey = row.kind === 'work' ? row.id : row.item.id;
                      const liveAt = running ? liveActivityRowIndex(displayedRows) : -1;
                      return (
                        <React.Fragment key={rowKey}>
                          {index === liveAt ? (
                            <TurnActivityStatus
                              running={running}
                              pendingApproval={thread.pendingApproval}
                              items={transcriptItems}
                              interrupted={false}
                              durationSeconds={thread.usage?.durationSeconds}
                            />
                          ) : null}
                          {row.kind !== 'work' && row.item.kind === 'assistant' && /<html[\s\S]*<\/html>/i.test(row.item.text) ? (
                            <HtmlRenderFrame html={row.item.text.match(/<html[\s\S]*<\/html>/i)?.[0] ?? row.item.text} />
                          ) : null}
                          {row.kind === 'work' ? (
                            <ChatWorkGroup
                              items={row.items}
                              running={running}
                              enterFor={enterFor}
                              interrupted={Boolean(thread.stoppedByBuilder)}
                            />
                          ) : (
                            <ChatItemRow
                              item={row.item}
                              threadId={thread.id}
                              enter={enterFor(row.item.id)}
                              fileRestoreEnabled={fileRestoreAllowed(
                                Boolean(thread.providerCanRewind),
                                Boolean(thread.isolatedCheckout),
                              )}
                              onRewindTranscript={(messageId) => rewindFromMessage(messageId)}
                              onRestoreFiles={async (messageId) => {
                                const result = await restoreThreadCheckpoint(thread.id);
                                if (!result?.restored || result.error) {
                                  throw new Error(result?.error || 'File restore did not run.');
                                }
                                await rewindFromMessage(messageId);
                              }}
                              onEditUserMessage={(text) => {
                                onChangePrompt(composeRewoundPrompt(prompt, text));
                                const el = document.querySelector('.chat-composer textarea') as HTMLTextAreaElement | null;
                                el?.focus();
                              }}
                            />
                          )}
                        </React.Fragment>
                      );
                    })}

                    {liveActivityRowIndex(displayedRows) < 0 || !running ? (
                      <TurnActivityStatus
                        running={running}
                        pendingApproval={thread.pendingApproval}
                        items={transcriptItems}
                        interrupted={Boolean(thread.stoppedByBuilder) && !running}
                        durationSeconds={thread.usage?.durationSeconds}
                      />
                    ) : null}

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
            {activePlan && !isPlanDismissed && (
              <div style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: '0 var(--space-6)', boxSizing: 'border-box' }}>
                <ChatPlanPanel
                  key={`plan-${thread.id}-${activePlan.id}`}
                  plan={activePlan}
                  disabled={running || thread.status === 'waiting'}
                  onSend={(text, planAction) => onSend(text, planAction)}
                  onDismiss={() => setDismissedPlanIds((prev) => new Set(prev).add(activePlan.id))}
                />
              </div>
            )}
            {activePlan && isPlanDismissed && (
              <div style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: '0 var(--space-6) 6px', boxSizing: 'border-box' }}>
                <button
                  type="button"
                  onClick={() => setDismissedPlanIds((prev) => {
                    const next = new Set(prev);
                    next.delete(activePlan.id);
                    return next;
                  })}
                  style={{
                    background: 'var(--chip-fill)',
                    border: '1px solid var(--block-stroke)',
                    borderRadius: 'var(--radius-pill, 999px)',
                    padding: '3px 10px',
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  title="Mostrar artefacto oculto"
                >
                  <FileCodeIcon size={11} />
                  <span>Ver artefacto: {activePlan.status === 'ready' ? 'Proposed Plan' : activePlan.status}</span>
                </button>
              </div>
            )}

            {session && <SessionLifecycleBar projection={session} />}

            {thread.pendingUserInput?.questions && thread.pendingUserInput.questions.length > 0 ? (
              <ComposerPendingUserInputPanel
                questions={thread.pendingUserInput.questions}
                onSubmit={(answers) => {
                  void invokeCommand('respond_chat_user_input', {
                    threadId: thread.id,
                    answers,
                  });
                }}
              />
            ) : null}
            {childApprovals(thread.id, knownThreadsList).map((child) => (
              <div key={child.threadId} className="child-thread-approval rounded-card" aria-label={child.title}>
                <strong>{child.title}</strong>
                <ChatApprovalCard approval={child.approval} onDecision={onApprovalDecision} />
              </div>
            ))}
            {directNotice ? <p role="status">{directNotice}</p> : null}
            {sideQuestion ? (
              <SideChatPane
                question={sideQuestion}
                parentRunning={running}
                onClose={() => setSideQuestion(null)}
                onBringBack={(text) => {
                  if (!bringBackAllowed(running)) return;
                  onChangePrompt(text);
                  setSideQuestion(null);
                }}
              />
            ) : null}
            <QueuedRunsControl
              rows={queuedRuns}
              expanded={false}
              onToggle={() => undefined}
              onSendNow={(id) => {
                const row = queuedRuns.find((entry) => entry.id === id);
                const rest = queuedRuns.filter((entry) => entry.id !== id);
                setQueuedRuns(rest);
                void invokeCommand('update_chat_configuration', { threadId: thread.id, queuedRuns: rest });
                if (row?.text) onChangePrompt(row.text);
              }}
              onEdit={(id) => {
                const row = queuedRuns.find((entry) => entry.id === id);
                if (row) onChangePrompt(row.text);
              }}
              onRemove={(id) => {
                const rest = queuedRuns.filter((entry) => entry.id !== id);
                setQueuedRuns(rest);
                void invokeCommand('update_chat_configuration', { threadId: thread.id, queuedRuns: rest });
              }}
            />
            <ChangedFilesCard
              files={changedFilesForTurn(transcriptItems)}
              onOpenFile={(path) => {
                window.dispatchEvent(new CustomEvent('kite:open-file', { detail: { path } }));
              }}
            />

            <ChatComposer
              threadId={thread.id}
              threadItems={transcriptItems}
              agentName={agentName}
              engineLabel={engineLabel}
              threadMode={thread.mode}
              threadPlan={thread.plan}
              threadProvider={thread.provider}
              threadModel={effectiveModel}
              threadEffort={thread.effort}
              threadAgent={effectiveAgent}
              threadConnectionId={thread.connectionId ?? null}
              catalogState={catalogState}
              onQueue={directNotice ? () => undefined : (text) => {
                const next = [...queuedRuns, { id: `q-${Date.now()}`, text }];
                setQueuedRuns(next);
                void invokeCommand('update_chat_configuration', { threadId: thread.id, queuedRuns: next });
              }}
              threadBranch={gitBranch}
              branches={branches}
              threadWorkspaceName={effectiveWorkspaceName || 'Local'}
              workspaces={workspaces?.map((w) => ({ id: w.id, name: w.displayName || w.name || 'Workspace' }))}
              onSelectWorkspace={(wsId) => onUpdateConfig({ workspaceId: wsId })}
              onSwitchBranch={handleSwitchBranch}
              onCreateBranch={handleCreateBranch}
              running={running}
              prompt={prompt}
              attachments={attachments}
              totalTokens={totalTokens}
              declaration={declaration}
              ensureDynamicAgents={ensureDynamicAgents}
              isRefreshingModels={isRefreshingModels}
              onRefreshModels={onRefreshModels}
              onChangePrompt={onChangePrompt}
              onSend={directNotice ? () => undefined : () => onSend()}
              onFreshContext={() => {
                void invokeCommand('update_chat_configuration', {
                  threadId: thread.id,
                  freshContext: true,
                });
              }}
              onCompact={() => {
                if (directNotice) return;
                const text = compactSendText(thread.provider);
                if (!text) return;
                void onSend(text);
              }}
              onStop={stopRunning}
              paused={!running && thread.turnFailure?.kind === 'usageLimit'}
              onPickAttachments={onPickAttachments}
              onStageFiles={onStageFiles}
              onStagePaths={onStagePaths}
              onRemoveAttachment={onRemoveAttachment}
              onUpdateConfig={onUpdateConfig}
              onSelectConnection={(connectionId) => onUpdateConfig({ connectionId })}
              pendingApproval={session?.pendingApprovals[0] ?? thread.pendingApproval}
              onApprovalDecision={onApprovalDecision}
            />

            <div aria-hidden="true" className="chat-thread-layout__tail" />
          </div>
        </div>
      </div>
    </section>
  );
};
