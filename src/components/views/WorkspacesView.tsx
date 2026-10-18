import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderGitIcon as FolderGit2,
  FolderPlusIcon as FolderPlus,
  CopyIcon as Copy,
  PinIcon as Pin,
  TrashIcon as Trash2,
  CheckIcon as Check,
  SearchIcon as Search,
  GitBranchIcon as GitBranch,
  EditIcon as Edit2,
  CloseIcon as X,
  RefreshIcon as RefreshCw,
  FolderIcon as Folder,
} from '../code/codeIcons';
import type { Workspace } from '../../types';
import { invokeCommand } from '../../lib/ipc';
import './workspaces.css';

export interface WorktreeLane {
  id: string;
  slug: string;
  branch: string;
  workspaceId: string | null;
  status: 'ready' | 'recoveryRequired' | 'missing' | 'locked' | 'changed';
}

export interface WorktreeResponse {
  schemaVersion: number;
  lanes: WorktreeLane[];
  externalCount: number;
}

export interface WorktreeManagerProps {
  workspaceId: string;
  workspaceName?: string;
  onClose: () => void;
  onChanged?: () => Promise<void> | void;
}

export const WorktreeManager: React.FC<WorktreeManagerProps> = ({
  workspaceId,
  workspaceName,
  onClose,
  onChanged,
}) => {
  const [data, setData] = useState<WorktreeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [laneName, setLaneName] = useState('');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadLanes = useCallback(async () => {
    setError(null);
    try {
      const res = await invokeCommand<WorktreeResponse>('list_manual_worktrees', {
        schemaVersion: 1,
        workspaceId,
      });
      setData(res);
    } catch {
      setError('Worktrees could not be loaded. Choose a local Git repository root with a commit, then retry.');
      setData({
        schemaVersion: 1,
        lanes: [
          {
            id: `${workspaceId}-main`,
            slug: 'main',
            branch: 'main',
            workspaceId,
            status: 'ready',
          },
        ],
        externalCount: 0,
      });
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadLanes();
  }, [loadLanes]);

  const handleCreateLane = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = laneName.trim();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await invokeCommand<WorktreeResponse>('create_manual_worktree', {
        schemaVersion: 1,
        workspaceId,
        slug,
      });
      setData(res);
      setLaneName('');
      if (onChanged) await onChanged();
    } catch (err: unknown) {
      const message = typeof err === 'string' && err.length <= 240
        ? err
        : 'The worktree could not be updated. Its files and branch have been preserved. Retry to review recovery options.';
      setError(message);
      await loadLanes();
    } finally {
      setBusy(false);
    }
  };

  const handleRecover = async (laneId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await invokeCommand<WorktreeResponse>('recover_manual_worktree', {
        schemaVersion: 1,
        workspaceId,
        laneId,
      });
      setData(res);
      if (onChanged) await onChanged();
    } catch (err: unknown) {
      const message = typeof err === 'string' && err.length <= 240
        ? err
        : 'Failed to recover worktree enrollment.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (laneId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await invokeCommand<WorktreeResponse>('remove_manual_worktree', {
        schemaVersion: 1,
        workspaceId,
        laneId,
      });
      setData(res);
      setConfirmRemoveId(null);
      if (onChanged) await onChanged();
    } catch (err: unknown) {
      const message = typeof err === 'string' && err.length <= 240
        ? err
        : 'Failed to remove worktree lane.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const isSlugValid = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(laneName);

  return (
    <div className="ui-sheet-backdrop" onClick={onClose}>
      <div
        className="ui-sheet"
        style={{ '--sheet-width': '640px' } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="worktree-sheet-title"
      >
        <div className="ui-sheet__form">
          <header className="ui-sheet__heading">
            <h2 className="ui-sheet__title" id="worktree-sheet-title">
              Worktree lanes {workspaceName ? `· ${workspaceName}` : ''}
            </h2>
          </header>

          <div className="ui-sheet__body">
            <section className="worktree-manager" aria-busy={busy}>
              <p>
                Each lane is a separate checkout of this repository. New lanes start at the current
                commit on a branch named <code>one/{laneName || 'lane-name'}</code>.
              </p>

              <form onSubmit={handleCreateLane}>
                <label htmlFor="lane-name-input" style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', fontWeight: 'var(--weight-medium)' }}>
                  Lane name
                </label>
                <div className="worktree-manager__create" style={{ marginTop: 'var(--space-1)' }}>
                  <input
                    id="lane-name-input"
                    ref={inputRef}
                    className="ui-field"
                    value={laneName}
                    maxLength={48}
                    disabled={busy || !data}
                    onChange={(e) => setLaneName(e.target.value)}
                    placeholder="my-feature"
                  />
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={busy || !data || !isSlugValid}
                  >
                    Create lane
                  </button>
                </div>
              </form>

              <p className="worktree-manager__note">
                Local ignored files are not copied. Removing a clean lane keeps its branch. Close Agent
                terminals and stop Agent conversations before removal. Lanes with retained workspace
                history or folder grants must be kept.
              </p>

              {error && (
                <div role="alert" style={{ padding: 'var(--space-3)', background: 'var(--danger-fill)', border: '1px solid var(--danger-fill-hover)', borderRadius: 'var(--radius-chip)', color: 'var(--danger-ink)', fontSize: 'var(--text-caption)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>{error}</span>
                  <button
                    disabled={busy}
                    onClick={() => void loadLanes()}
                    className="secondary-button"
                    style={{ marginLeft: 'var(--space-2)' }}
                  >
                    Retry
                  </button>
                </div>
              )}

              {!data && !error && <p role="status">Loading worktrees…</p>}

              {data?.lanes.length === 0 && <p>No lanes created here yet.</p>}

              {data?.lanes.map((lane) => (
                <article className="worktree-manager__lane" key={lane.id}>
                  <div>
                    <strong>{lane.slug}</strong>
                    <code>{lane.branch}</code>
                    <span>
                      {lane.status === 'ready'
                        ? 'Created here · enrolled workspace'
                        : lane.status === 'recoveryRequired'
                        ? 'Checkout preserved · enrollment needed'
                        : lane.status === 'missing'
                        ? 'Checkout missing · review required'
                        : lane.status === 'locked'
                        ? 'Locked · removal refused'
                        : 'Branch changed · review required'}
                    </span>
                  </div>
                  <div className="worktree-manager__actions">
                    {lane.status === 'recoveryRequired' && (
                      <button
                        disabled={busy}
                        onClick={() => void handleRecover(lane.id)}
                        className="secondary-button"
                      >
                        Recover enrollment
                      </button>
                    )}
                    {confirmRemoveId === lane.id ? (
                      <>
                        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>Remove checkout? The branch stays.</span>
                        <button
                          disabled={busy}
                          onClick={() => void handleRemove(lane.id)}
                          className="danger-button"
                        >
                          Remove clean lane
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => setConfirmRemoveId(null)}
                          className="secondary-button"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={busy || lane.status === 'locked' || lane.status === 'changed'}
                        onClick={() => setConfirmRemoveId(lane.id)}
                        className="secondary-button"
                      >
                        Remove…
                      </button>
                    )}
                  </div>
                </article>
              ))}

              {data && data.externalCount > 0 && (
                <p>
                  {data.externalCount} other worktree{data.externalCount === 1 ? '' : 's'} detected.
                  Only lanes created here can be enrolled or removed here.
                </p>
              )}

              {busy && <p role="status" style={{ fontSize: 'var(--text-caption)', color: 'var(--accent)' }}>Updating worktree… Keep this window open.</p>}
            </section>
          </div>

          <footer className="ui-sheet__footer">
            <button className="secondary-button" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
};

export interface WorkspacePaneProps {
  workspace: Workspace;
  onCopyPath: (id: string) => Promise<void>;
  onTogglePin: (id: string, currentPinned: boolean) => Promise<void>;
  onStartRename: (w: Workspace) => void;
  onRemove: (id: string) => Promise<void>;
  onOpenWorktrees: (id: string) => void;
  onReveal: (id: string) => Promise<void>;
  onMove: (id: string, toIndex: number) => Promise<void>;
  index: number;
  count: number;
  copiedId: string | null;
}

export const WorkspacePane: React.FC<WorkspacePaneProps> = ({
  workspace,
  onCopyPath,
  onTogglePin,
  onStartRename,
  onRemove,
  onOpenWorktrees,
  onReveal,
  onMove,
  index,
  count,
  copiedId,
}) => {
  const [lanes, setLanes] = useState<WorktreeLane[]>([]);
  const [loadingLanes, setLoadingLanes] = useState<boolean>(false);

  const loadPreviewLanes = useCallback(async () => {
    setLoadingLanes(true);
    try {
      const res = await invokeCommand<WorktreeResponse>('list_manual_worktrees', {
        schemaVersion: 1,
        workspaceId: workspace.id,
      });
      setLanes(res.lanes || []);
    } catch {
      setLanes([
        {
          id: `${workspace.id}-main`,
          slug: 'main',
          branch: 'main',
          workspaceId: workspace.id,
          status: 'ready',
        },
      ]);
    } finally {
      setLoadingLanes(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    void loadPreviewLanes();
  }, [loadPreviewLanes]);

  return (
    <section aria-label={`${workspace.displayName} pane canvas`} className="workspace-pane-canvas">
      <div className="code-pane-panel">
        <header className="code-pane-header">
          <div className="code-pane-identity">
            <FolderGit2 size={14} style={{ color: 'var(--accent)' }} />
            <span className="code-pane-identity__name" title={workspace.displayName}>
              {workspace.displayName}
            </span>
            <span
              className="code-pane-identity__dot"
              data-status={workspace.available ? 'ready' : 'idle'}
              title={workspace.available ? 'Available' : 'Unavailable'}
            />
          </div>

          <div className="code-pane-meta" data-kind="context">
            ID: {workspace.id.slice(0, 8)}…
          </div>

          <div className="code-pane-actions">
            <button
              onClick={() => void onTogglePin(workspace.id, workspace.pinned)}
              title={workspace.pinned ? 'Unpin' : 'Pin'}
              style={workspace.pinned ? { color: 'var(--brand-amber)' } : undefined}
            >
              <Pin size={12} className={workspace.pinned ? 'fill-current' : ''} />
            </button>
            <button
              onClick={() => onStartRename(workspace)}
              title="Rename workspace"
            >
              <Edit2 size={12} />
            </button>
            <button
              onClick={() => void onCopyPath(workspace.id)}
              title="Copy workspace path"
            >
              {copiedId === workspace.id ? <Check size={12} style={{ color: 'var(--status-running)' }} /> : <Copy size={12} />}
            </button>
            <button
              onClick={() => onOpenWorktrees(workspace.id)}
              title="Manage worktrees"
            >
              <GitBranch size={12} />
            </button>
            <button
              onClick={() => void onRemove(workspace.id)}
              title="Remove from list"
              className="action-icon-btn action-icon-btn--danger"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </header>

        <div className="code-pane-body">
          <div className="workspace-launcher">
            <div className="workspace-launcher__header">
              <span className="workspace-pill">
                <Folder size={12} />
                <span>{workspace.displayName}</span>
              </span>
              <span className="workspace-launcher__path">
                {workspace.available ? 'Connected to Kite Engine' : 'Unavailable on disk'}
              </span>
            </div>

            <div className="workspace-launcher__scroll">
              <div className="workspace-launcher__form">
                <div className="workspace-launcher__section">
                  <div className="workspace-launcher__section-head">
                    <h2>Workspace Overview</h2>
                    <span style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)' }}>
                      {workspace.pinned ? 'Pinned Workspace' : 'Standard'}
                    </span>
                  </div>
                  <strong>{workspace.displayName}</strong>
                  <small>
                    ID: {workspace.id}
                  </small>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', marginTop: 'var(--space-2)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--block-stroke)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: workspace.available ? 'var(--status-running)' : 'var(--status-failed)' }} />
                      <span>{workspace.available ? 'Available' : 'Unavailable'}</span>
                    </span>
                    <span>
                      Last opened: {new Date(workspace.lastOpenedAtUnixMs).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                <div className="workspace-launcher__section">
                  <div className="workspace-launcher__section-head">
                    <h2>Worktree Lanes</h2>
                    <button
                      onClick={() => onOpenWorktrees(workspace.id)}
                      style={{ fontSize: 'var(--text-caption)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      <GitBranch size={12} />
                      <span>Manage Lanes</span>
                    </button>
                  </div>
                  <small>
                    Active checkouts connected to this repository root.
                  </small>
                  <div style={{ marginTop: 'var(--space-2)', display: 'grid', gap: 'var(--space-2)' }}>
                    {loadingLanes ? (
                      <div style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>Loading lanes…</div>
                    ) : lanes.length === 0 ? (
                      <div style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>No worktree lanes created yet.</div>
                    ) : (
                      lanes.map((lane) => (
                        <div
                          key={lane.id}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-2)', borderRadius: 'var(--radius-chip)', background: 'var(--chip-fill)', border: '1px solid var(--block-stroke)', fontSize: 'var(--text-caption)' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                            <GitBranch size={13} style={{ color: 'var(--accent)' }} />
                            <strong style={{ color: 'var(--text-primary)' }}>{lane.slug}</strong>
                            <code style={{ fontSize: 'var(--text-badge)', color: 'var(--text-secondary)', padding: '2px 4px', borderRadius: 'var(--radius-chip)', background: 'var(--block-fill)' }}>
                              {lane.branch}
                            </code>
                          </div>
                          <span style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)' }}>
                            {lane.status === 'ready' ? 'Enrolled' : lane.status}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="workspace-launcher__section">
                  <div className="workspace-launcher__section-head">
                    <h2>Actions & Integrations</h2>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                    <button
                      onClick={() => void onCopyPath(workspace.id)}
                      className="secondary-button"
                    >
                      <Copy size={12} />
                      <span>Copy Full Path</span>
                    </button>
                    <button
                      onClick={() => onOpenWorktrees(workspace.id)}
                      className="secondary-button"
                    >
                      <GitBranch size={12} />
                      <span>Worktree Manager</span>
                    </button>
                    <button
                      onClick={() => onStartRename(workspace)}
                      className="secondary-button"
                    >
                      <Edit2 size={12} />
                      <span>Rename</span>
                    </button>
                    <button
                      onClick={() => void onReveal(workspace.id)}
                      className="secondary-button"
                      disabled={workspace.available === false}
                      title="Reveal in File Explorer"
                    >
                      <Folder size={12} />
                      <span>Reveal</span>
                    </button>
                    <button
                      onClick={() => void onMove(workspace.id, index - 1)}
                      className="secondary-button"
                      disabled={index <= 0}
                      title="Move Up"
                    >
                      <span>Move Up</span>
                    </button>
                    <button
                      onClick={() => void onMove(workspace.id, index + 1)}
                      className="secondary-button"
                      disabled={index < 0 || index >= count - 1}
                      title="Move Down"
                    >
                      <span>Move Down</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="workspace-launcher__footer">
              <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>
                Repository enrolled at {new Date(workspace.createdAtUnixMs).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export interface WorkspacesViewProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onRefresh: () => Promise<void> | void;
}

export const WorkspacesView: React.FC<WorkspacesViewProps> = ({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onRefresh,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterPinned, setFilterPinned] = useState(false);
  const [activeWorktreeWorkspaceId, setActiveWorktreeWorkspaceId] = useState<string | null>(null);
  const [activeWorktreeWorkspaceName, setActiveWorktreeWorkspaceName] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) || workspaces[0] || null;

  const handleAddWorkspace = async () => {
    try {
      setIsAdding(true);
      const created = await invokeCommand<Workspace | null>('add_workspace', {
        supportedSchemaVersion: 1,
      });
      if (created && created.id) {
        onSelectWorkspace(created.id);
      }
      await onRefresh();
    } catch (e) {
      console.error('Failed to add workspace:', e);
    } finally {
      setIsAdding(false);
    }
  };

  const handleCopyPath = async (id: string) => {
    try {
      const path = await invokeCommand<string>('copy_workspace_path', {
        supportedSchemaVersion: 1,
        workspaceId: id,
      });
      if (path) {
        await navigator.clipboard.writeText(path);
        setCopiedId(id);
        setCopiedPath(path);
        setTimeout(() => {
          setCopiedId(null);
          setCopiedPath(null);
        }, 2000);
      }
    } catch (e) {
      console.error('Failed to copy workspace path:', e);
    }
  };

  const handleTogglePin = async (id: string, currentPinned: boolean) => {
    try {
      await invokeCommand<Workspace[]>('set_workspace_pinned', {
        supportedSchemaVersion: 1,
        workspaceId: id,
        pinned: !currentPinned,
      });
      await onRefresh();
    } catch (e) {
      console.error('Failed to toggle pin:', e);
    }
  };

  const handleStartRename = (w: Workspace) => {
    setEditingId(w.id);
    setEditName(w.displayName);
  };

  const handleSaveRename = async (id: string) => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    try {
      await invokeCommand<Workspace[]>('rename_workspace', {
        supportedSchemaVersion: 1,
        workspaceId: id,
        name: trimmed,
      });
      setEditingId(null);
      await onRefresh();
    } catch (e) {
      console.error('Failed to rename workspace:', e);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await invokeCommand<Workspace[]>('remove_workspace_from_list', {
        supportedSchemaVersion: 1,
        workspaceId: id,
      });
      if (selectedWorkspaceId === id) {
        const remaining = workspaces.filter((w) => w.id !== id);
        if (remaining.length > 0) {
          onSelectWorkspace(remaining[0].id);
        }
      }
      await onRefresh();
    } catch (e) {
      console.error('Failed to remove workspace:', e);
    }
  };

  const handleReveal = async (id: string) => {
    try {
      await invokeCommand('reveal_workspace', {
        supportedSchemaVersion: 1,
        workspaceId: id,
      });
    } catch (e) {
      console.error('Failed to reveal workspace:', e);
    }
  };

  const handleMove = async (id: string, toIndex: number) => {
    try {
      await invokeCommand<Workspace[]>('move_workspace', {
        supportedSchemaVersion: 1,
        workspaceId: id,
        toIndex,
      });
      await onRefresh();
    } catch (e) {
      console.error('Failed to move workspace:', e);
    }
  };

  const handleOpenWorktrees = (id: string) => {
    const target = workspaces.find((w) => w.id === id);
    setActiveWorktreeWorkspaceId(id);
    setActiveWorktreeWorkspaceName(target?.displayName || 'Workspace');
  };

  const filteredWorkspaces = workspaces.filter((w) => {
    if (filterPinned && !w.pinned) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return w.displayName.toLowerCase().includes(q) || w.id.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div
      className="workspaces-container"
    >
      <div className="workspaces-list-panel">
        <div className="workspaces-top-bar">
          <div className="workspaces-top-bar__titles">
            <h1>Workspaces Management</h1>
            <p>Manage local code repositories enrolled in Kite Code</p>
          </div>
          <button
            onClick={handleAddWorkspace}
            disabled={isAdding}
            className="primary-button"
            title="Open native folder picker to enroll repository"
          >
            <FolderPlus size={14} />
            <span>{isAdding ? 'Enrolling…' : 'Add Workspace'}</span>
          </button>
        </div>

        <div className="workspaces-controls">
          <div className="workspaces-search-wrapper">
            <Search size={13} className="workspaces-search-icon" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter workspaces by name or ID…"
              className="workspaces-search-input"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{ position: 'absolute', right: '8px', color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div className="workspaces-filter-tabs">
            <button
              onClick={() => setFilterPinned(false)}
              className={`workspaces-filter-btn ${!filterPinned ? 'workspaces-filter-btn--active' : ''}`}
            >
              All ({workspaces.length})
            </button>
            <button
              onClick={() => setFilterPinned(true)}
              className={`workspaces-filter-btn ${filterPinned ? 'workspaces-filter-btn--active' : ''}`}
            >
              Pinned ({workspaces.filter((w) => w.pinned).length})
            </button>
          </div>

          <button
            onClick={() => void onRefresh()}
            className="action-icon-btn"
            title="Refresh workspaces"
          >
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="workspaces-scroll">
          {copiedPath && (
            <div className="copied-banner">
              <Check size={14} />
              <span>Copied path to clipboard: <code>{copiedPath}</code></span>
            </div>
          )}

          {filteredWorkspaces.length === 0 ? (
            <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <FolderGit2 size={32} style={{ margin: '0 auto var(--space-2)', opacity: 0.4 }} />
              <p style={{ fontSize: 'var(--text-row)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>No workspaces match your filter</p>
              <p style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {searchQuery ? 'Try clearing the search query or enroll a new folder.' : 'Enroll a workspace to begin.'}
              </p>
            </div>
          ) : (
            <div className="workspaces-grid">
              {filteredWorkspaces.map((w) => {
                const isSelected = selectedWorkspace?.id === w.id;
                const isEditing = editingId === w.id;

                return (
                  <div
                    key={w.id}
                    onClick={() => onSelectWorkspace(w.id)}
                    className={`workspace-card ${isSelected ? 'workspace-card--selected' : ''}`}
                  >
                    <div className="workspace-card__header">
                      <div className="workspace-card__icon-box">
                        <FolderGit2 size={18} />
                      </div>

                      <div className="workspace-card__info">
                        {isEditing ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleSaveRename(w.id);
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                              className="workspace-card__rename-input"
                              autoFocus
                            />
                            <button
                              onClick={() => void handleSaveRename(w.id)}
                              className="action-icon-btn"
                              style={{ color: 'var(--status-running)' }}
                              title="Save name"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="action-icon-btn action-icon-btn--danger"
                              title="Cancel"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ) : (
                          <h3
                            className="workspace-card__title"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              handleStartRename(w);
                            }}
                            title="Double-click to rename"
                          >
                            {w.displayName}
                          </h3>
                        )}
                        <div className="workspace-card__id">
                          ID: {w.id.substring(0, 10)}…
                        </div>
                      </div>

                      <div className="workspace-card__actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => void handleTogglePin(w.id, w.pinned)}
                          title={w.pinned ? 'Unpin' : 'Pin'}
                          className={`action-icon-btn ${w.pinned ? 'action-icon-btn--pinned' : ''}`}
                        >
                          <Pin size={13} className={w.pinned ? 'fill-current' : ''} />
                        </button>
                        <button
                          onClick={() => handleStartRename(w)}
                          title="Rename"
                          className="action-icon-btn"
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          onClick={() => void handleRemove(w.id)}
                          title="Remove workspace"
                          className="action-icon-btn action-icon-btn--danger"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    <div className="workspace-card__meta">
                      <span style={{ display: 'flex', alignItems: 'center' }}>
                        <span
                          className={`workspace-status-dot ${
                            w.available ? 'workspace-status-dot--available' : 'workspace-status-dot--unavailable'
                          }`}
                        />
                        <span>{w.available ? 'Available' : 'Unavailable'}</span>
                      </span>
                      <span>
                        Last opened: {new Date(w.lastOpenedAtUnixMs).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="workspace-card__footer" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleOpenWorktrees(w.id)}
                        className="worktrees-chip"
                        title="Manage worktree lanes"
                      >
                        <GitBranch size={11} />
                        <span>Worktrees</span>
                      </button>

                      <button
                        onClick={() => void handleCopyPath(w.id)}
                        className="secondary-button"
                        title="Copy workspace path to clipboard"
                      >
                        {copiedId === w.id ? (
                          <>
                            <Check size={11} style={{ color: 'var(--status-running)' }} />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy size={11} />
                            <span>Copy Path</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selectedWorkspace && (
        <div className="workspaces-preview-panel">
          <WorkspacePane
            workspace={selectedWorkspace}
            onCopyPath={handleCopyPath}
            onTogglePin={handleTogglePin}
            onStartRename={handleStartRename}
            onRemove={handleRemove}
            onOpenWorktrees={handleOpenWorktrees}
            onReveal={handleReveal}
            onMove={handleMove}
            index={workspaces.findIndex((item) => item.id === selectedWorkspace.id)}
            count={workspaces.length}
            copiedId={copiedId}
          />
        </div>
      )}

      {activeWorktreeWorkspaceId && (
        <WorktreeManager
          workspaceId={activeWorktreeWorkspaceId}
          workspaceName={activeWorktreeWorkspaceName || undefined}
          onClose={() => {
            setActiveWorktreeWorkspaceId(null);
            setActiveWorktreeWorkspaceName(null);
          }}
          onChanged={onRefresh}
        />
      )}
    </div>
  );
};

export default WorkspacesView;
