import React, { useRef, useState, useEffect } from 'react';
import {
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  CloseIcon,
  CheckIcon,
  ChevronDownIcon,
  SearchIcon,
  PencilIcon,
} from '../ChatIcons';
import { BrandLogo } from '../../../ui/BrandLogo';
import type { ExtendedChatThread } from '../types';
import type { UseThreadBranchesResult } from './useThreadBranches';

export interface SingleThreadHeaderProps {
  thread: ExtendedChatThread;
  effectiveWorkspaceName: string | null;
  workspaces?: Array<{ id: string; displayName?: string; name?: string }>;
  currentWorkspaceId?: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  branchState: UseThreadBranchesResult;
  editingTitleId: string | null;
  titleInput: string;
  onStartRename: (id: string, title: string) => void;
  onSaveRename: () => void;
  onChangeTitleInput: (val: string) => void;
  onCancelRename: () => void;
  providerMeta: { engineId?: string; label: string; [key: string]: any };
  currentModelName: string;
  usageCard?: React.ReactNode;
  running: boolean;
  onNewThread: () => void | Promise<string | null | undefined | void>;
  isMulti: boolean;
  onClosePane: () => void;
  onPinThread?: (id: string, e: React.MouseEvent) => void;
  onArchiveThread?: (id: string, e: React.MouseEvent) => void;
  onToggleSplit?: () => void;
}

export const SingleThreadHeader: React.FC<SingleThreadHeaderProps> = ({
  thread,
  effectiveWorkspaceName,
  workspaces,
  currentWorkspaceId,
  onSelectWorkspace,
  branchState,
  editingTitleId,
  titleInput,
  onStartRename,
  onSaveRename,
  onChangeTitleInput,
  onCancelRename,
  providerMeta,
  currentModelName,
  usageCard,
  running,
  onNewThread,
  isMulti,
  onClosePane,
}) => {
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
  const wsDropdownRef = useRef<HTMLDivElement>(null);

  const {
    isRepo,
    gitBranch,
    branchesLoading,
    branchSearch,
    setBranchSearch,
    branchDropdownOpen,
    setBranchDropdownOpen,
    isCreatingBranch,
    setIsCreatingBranch,
    newBranchInput,
    setNewBranchInput,
    branchError,
    setBranchError,
    branchDropdownRef,
    filteredBranches,
    loadBranches,
    handleSwitchBranch,
    handleCreateBranch,
  } = branchState;

  useEffect(() => {
    if (!wsDropdownOpen) return;
    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wsDropdownRef.current && !wsDropdownRef.current.contains(target)) {
        setWsDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', handleGlobalClick);
    return () => window.removeEventListener('mousedown', handleGlobalClick);
  }, [wsDropdownOpen]);

  return (
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
                    const isSelected = ws.id === (thread.workspaceId || currentWorkspaceId);
                    return (
                      <button
                        key={ws.id}
                        type="button"
                        className={`chat-thread-header__menu-item${isSelected ? ' chat-thread-header__menu-item--selected' : ''}`}
                        onClick={() => {
                          onSelectWorkspace(ws.id);
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

        {usageCard}

        {/* Status indicator (single counter lives at the bottom of the transcript) */}
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
        </span>

        {/* New Thread */}
        <button
          type="button"
          className="chrome-button"
          aria-label="New thread"
          title="New thread"
          onClick={() => void onNewThread()}
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
  );
};
