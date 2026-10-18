import React, { useState } from 'react';
import {
  FolderIcon,
  ChevronDownIcon,
  RefreshIcon,
  PanelLeftIcon,
  GitBranchIcon,
  CircleArrowDownIcon,
  CircleArrowUpIcon,
  CheckIcon,
  AlertCircleIcon,
} from './FileIcons';
import type { WorkspaceChanges } from './gitTypes';
import { formatUpstreamDistance } from './gitTypes';
import { addWorkspace } from '../../../lib/ipc';

export interface FilesToolbarProps {
  currentWsId: string | null;
  activeWorkspaceName?: string;
  workspacesList: Array<{ id: string; name: string }>;
  mode: 'files' | 'changes';
  showTree: boolean;
  canToggleTree: boolean;
  gitChanges: WorkspaceChanges | null;
  gitBusy: string | null;
  loading: boolean;
  statusMessage: string | null;
  errorMessage: string | null;
  onToggleTree: () => void;
  onModeChange: (mode: 'files' | 'changes') => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
}

export const FilesToolbar: React.FC<FilesToolbarProps> = ({
  currentWsId,
  activeWorkspaceName,
  workspacesList,
  mode,
  showTree,
  canToggleTree,
  gitChanges,
  gitBusy,
  loading,
  statusMessage,
  errorMessage,
  onToggleTree,
  onModeChange,
  onSelectWorkspace,
  onPull,
  onPush,
  onRefresh,
}) => {
  const [isFolderMenuOpen, setIsFolderMenuOpen] = useState(false);
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);

  const modifiedCount = gitChanges?.files?.length ?? 0;
  const upstreamDistance = formatUpstreamDistance(gitChanges?.upstream ?? null);

  return (
    <header className="_toolbar files-toolbar">
      {/* 1. Toggle File Tree Button */}
      <button
        type="button"
        className="_toolbarButton"
        aria-label={showTree ? 'Hide file tree' : 'Show file tree'}
        aria-pressed={showTree}
        disabled={!canToggleTree}
        onClick={onToggleTree}
        title={showTree ? 'Hide file tree' : 'Show file tree'}
      >
        <PanelLeftIcon size={13} />
      </button>

      {/* 2. Mode Switcher (_t) */}
      <fieldset aria-label="Files or changes" className="_modeSwitch">
        <button
          type="button"
          aria-label="Files"
          aria-pressed={mode === 'files'}
          className="_modeSegment"
          onClick={() => onModeChange('files')}
          title="Files"
        >
          <FolderIcon size={13} />
        </button>
        <button
          type="button"
          aria-label={
            modifiedCount > 0 ? `Changes, ${modifiedCount} changed files` : 'Changes'
          }
          aria-pressed={mode === 'changes'}
          className="_modeSegment"
          onClick={() => onModeChange('changes')}
          title="Changes"
        >
          <GitBranchIcon size={13} />
          {modifiedCount > 0 && <span className="_modeCount">{modifiedCount}</span>}
        </button>
      </fieldset>

      {/* 3. Workspace Folder Picker Button (vt) */}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="_folderButton"
          aria-expanded={isFolderMenuOpen}
          aria-haspopup="menu"
          aria-label={`Folder, ${activeWorkspaceName ?? 'none'}`}
          onClick={() => {
            setIsFolderMenuOpen((prev) => !prev);
            setIsBranchMenuOpen(false);
          }}
          title="Show files from another folder"
        >
          <FolderIcon size={13} />
          <span className="_folderName">{activeWorkspaceName ?? 'No folder'}</span>
          <ChevronDownIcon size={10} />
        </button>
        {isFolderMenuOpen && (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 49 }}
              onClick={() => setIsFolderMenuOpen(false)}
            />
            <div
              role="menu"
              aria-label="Show files from"
              className="ui-menu"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '4px',
                zIndex: 50,
                minWidth: '200px',
                background: 'var(--pane, #161b22)',
                border: '1px solid var(--separator, rgba(255, 255, 255, 0.1))',
                borderRadius: 'var(--radius-panel, 8px)',
                boxShadow: 'var(--shadow-lift, 0 8px 24px rgba(0, 0, 0, 0.5))',
                padding: '4px 0',
              }}
            >
              <div className="ui-menu__header" style={{ padding: '6px 10px' }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: '11px',
                    color: 'var(--text-primary, #f0f6fc)',
                  }}
                >
                  Show files from
                </div>
                {workspacesList.length === 0 && (
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary, #8b949e)' }}>
                    Add a folder in Code mode
                  </div>
                )}
              </div>
              <div
                style={{
                  height: '1px',
                  background: 'var(--separator, rgba(255,255,255,0.08))',
                  margin: '4px 0',
                }}
              />
              {workspacesList.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  role="menuitem"
                  className="ui-menu__row"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 0,
                    color: 'var(--text-primary, #f0f6fc)',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setIsFolderMenuOpen(false);
                    onSelectWorkspace(ws.id);
                  }}
                >
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      overflow: 'hidden',
                    }}
                  >
                    <FolderIcon size={13} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</span>
                  </span>
                  {ws.id === currentWsId && (
                    <span
                      style={{
                        fontSize: '10px',
                        color: 'var(--accent, #58a6ff)',
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      Showing
                    </span>
                  )}
                </button>
              ))}
              <div
                style={{
                  height: '1px',
                  background: 'var(--separator, rgba(255,255,255,0.08))',
                  margin: '4px 0',
                }}
              />
              <button
                type="button"
                role="menuitem"
                className="ui-menu__row"
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 10px',
                  fontSize: '12px',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 0,
                  color: 'var(--accent, #58a6ff)',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
                onClick={async () => {
                  setIsFolderMenuOpen(false);
                  try {
                    const created = await addWorkspace();
                    if (created) {
                      onSelectWorkspace(created.id);
                    }
                  } catch (e) {
                    console.error('Failed to add workspace from Files toolbar:', e);
                  }
                }}
              >
                <span>+ Open Folder…</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* 4. Branch Picker Button (yt) */}
      {gitChanges?.isRepo && gitChanges.branch && (
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="_branchButton"
            aria-expanded={isBranchMenuOpen}
            aria-haspopup="menu"
            aria-label={`Branch ${gitChanges.branch}${
              upstreamDistance ? `, ${upstreamDistance}` : ''
            }`}
            onClick={() => {
              setIsBranchMenuOpen((prev) => !prev);
              setIsFolderMenuOpen(false);
            }}
            title={`Branch ${gitChanges.branch}`}
          >
            <GitBranchIcon size={12} />
            <span className="_branchName">{gitChanges.branch}</span>
            {upstreamDistance && <span className="_branchDistance">{upstreamDistance}</span>}
          </button>
          {isBranchMenuOpen && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                onClick={() => setIsBranchMenuOpen(false)}
              />
              <div
                role="menu"
                aria-label="Branch"
                className="ui-menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: '4px',
                  zIndex: 50,
                  minWidth: '180px',
                  background: 'var(--pane, #161b22)',
                  border: '1px solid var(--separator, rgba(255, 255, 255, 0.1))',
                  borderRadius: 'var(--radius-panel, 8px)',
                  boxShadow: 'var(--shadow-lift, 0 8px 24px rgba(0, 0, 0, 0.5))',
                  padding: '4px 0',
                }}
              >
                <div className="ui-menu__header" style={{ padding: '6px 10px' }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '12px',
                      color: 'var(--text-primary, #f0f6fc)',
                    }}
                  >
                    {gitChanges.branch}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary, #8b949e)' }}>
                    {gitChanges.upstream === null
                      ? 'No upstream yet'
                      : upstreamDistance || 'Up to date'}
                  </div>
                </div>
                <div
                  style={{
                    height: '1px',
                    background: 'var(--separator, rgba(255,255,255,0.08))',
                    margin: '4px 0',
                  }}
                />
                <button
                  type="button"
                  role="menuitem"
                  className="ui-menu__row"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 0,
                    color: 'var(--text-primary, #f0f6fc)',
                    cursor: 'pointer',
                    opacity: gitBusy || gitChanges.upstream === null ? 0.4 : 1,
                  }}
                  disabled={Boolean(gitBusy) || gitChanges.upstream === null}
                  onClick={() => {
                    setIsBranchMenuOpen(false);
                    onPull();
                  }}
                >
                  <CircleArrowDownIcon size={13} />
                  <span>Pull</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ui-menu__row"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 0,
                    color: 'var(--text-primary, #f0f6fc)',
                    cursor: 'pointer',
                    opacity: gitBusy ? 0.4 : 1,
                  }}
                  disabled={Boolean(gitBusy)}
                  onClick={() => {
                    setIsBranchMenuOpen(false);
                    onPush();
                  }}
                >
                  <CircleArrowUpIcon size={13} />
                  <span>{gitChanges.upstream === null ? 'Publish Branch' : 'Push'}</span>
                </button>
                <div
                  style={{
                    height: '1px',
                    background: 'var(--separator, rgba(255,255,255,0.08))',
                    margin: '4px 0',
                  }}
                />
                <button
                  type="button"
                  role="menuitem"
                  className="ui-menu__row"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 0,
                    color: 'var(--text-primary, #f0f6fc)',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setIsBranchMenuOpen(false);
                    onRefresh();
                  }}
                >
                  <RefreshIcon size={12} />
                  <span>Refresh</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 5. Toolbar Spacer */}
      <span className="_toolbarSpacer" />

      {/* Status & Error Pills */}
      {statusMessage && (
        <span className="files-status-pill success mr-2">
          <CheckIcon size={11} />
          <span>{statusMessage}</span>
        </span>
      )}
      {errorMessage && (
        <span className="files-status-pill error" style={{ marginRight: '8px' }} title={errorMessage}>
          <AlertCircleIcon size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>{errorMessage}</span>
        </span>
      )}

      {/* 6. Refresh Button */}
      <button
        type="button"
        className="_toolbarButton"
        aria-label="Refresh"
        disabled={!currentWsId}
        onClick={onRefresh}
        title="Refresh"
      >
        <RefreshIcon size={13} className={loading ? 'animate-spin' : ''} />
      </button>
    </header>
  );
};
