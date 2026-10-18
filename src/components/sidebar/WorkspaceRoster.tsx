import React, { useState, useEffect, useRef } from 'react';
import type { Workspace } from '../../types';
import type { WorkspaceSessionTab, ContextMenuState, MenuItem } from './types';
import { SidebarContextMenu } from './SidebarFooter';
import {
  PlusIcon,
  PinIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderOpenIcon,
  TrashIcon,
  CopyIcon,
  PencilIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from './sidebarIcons';
import { invokeCommand } from '../../lib/ipc';

export interface WorkspaceRosterProps {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onCopyWorkspacePath?: (id: string) => void;
  onTogglePinWorkspace?: (id: string, pinned: boolean) => void;
  onRenameWorkspace?: (id: string, newName: string) => void;
  onRemoveWorkspaceFromList?: (id: string) => void;
  onNewWorkspaceSession?: (workspaceId: string) => void;
  onSelectWorkspaceTab?: (workspaceId: string, tabId: string) => void;
  onCloseWorkspaceTab?: (workspaceId: string, tabId: string) => void;
  onRenameWorkspaceTab?: (workspaceId: string, tabId: string, newTitle: string) => void;
  onMoveWorkspaceTab?: (workspaceId: string, fromIndex: number, toIndex: number) => void;
  onMoveWorkspace?: (workspaceId: string, toIndex: number) => void;
  onRevealWorkspace?: (workspaceId: string) => void;
  workspaceSessions?: Record<string, WorkspaceSessionTab[]>;
  readOnly?: boolean;
  className?: string;
}

export const WorkspaceRoster: React.FC<WorkspaceRosterProps> = ({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onCopyWorkspacePath,
  onTogglePinWorkspace,
  onRenameWorkspace,
  onRemoveWorkspaceFromList,
  onNewWorkspaceSession,
  onSelectWorkspaceTab,
  onCloseWorkspaceTab,
  onRenameWorkspaceTab,
  onMoveWorkspaceTab,
  onMoveWorkspace,
  onRevealWorkspace,
  workspaceSessions,
  readOnly = false,
  className = '',
}) => {
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceValue, setRenameWorkspaceValue] = useState('');
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameTabValue, setRenameTabValue] = useState('');
  const [workspaceOrder, setWorkspaceOrder] = useState<string[] | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameTabInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-expand selected workspace
  useEffect(() => {
    if (selectedWorkspaceId) {
      setExpandedWorkspaces((prev) => {
        if (prev.has(selectedWorkspaceId)) return prev;
        const next = new Set(prev);
        next.add(selectedWorkspaceId);
        return next;
      });
    }
  }, [selectedWorkspaceId]);

  // Reset custom order when workspaces array structure changes
  useEffect(() => {
    setWorkspaceOrder(null);
  }, [workspaces]);

  // Global listener to close context menu and cancel rename on Escape
  useEffect(() => {
    if (!contextMenu && !renamingWorkspaceId && !renamingTabId) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.ui-menu')) return;
      setContextMenu(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setRenamingWorkspaceId(null);
        setRenamingTabId(null);
      }
    };

    const handleResize = () => {
      setContextMenu(null);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [contextMenu, renamingWorkspaceId, renamingTabId]);

  // Focus and select input on rename
  useEffect(() => {
    if (renamingWorkspaceId && renameInputRef.current) {
      renameInputRef.current.focus({ preventScroll: true });
      renameInputRef.current.select();
    }
  }, [renamingWorkspaceId]);

  useEffect(() => {
    if (renamingTabId && renameTabInputRef.current) {
      renameTabInputRef.current.focus({ preventScroll: true });
      renameTabInputRef.current.select();
    }
  }, [renamingTabId]);

  const toggleExpand = (wsId: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) {
        next.delete(wsId);
      } else {
        next.add(wsId);
      }
      return next;
    });
  };

  const orderedWorkspaces = (() => {
    if (!workspaceOrder) return workspaces;
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const ordered = workspaceOrder.flatMap((id) => {
      const ws = byId.get(id);
      return ws ? [ws] : [];
    });
    return ordered.length === workspaces.length ? ordered : workspaces;
  })();

  const pinnedWorkspaces = orderedWorkspaces.filter((w) => w.pinned);
  const unpinnedWorkspaces = orderedWorkspaces.filter((w) => !w.pinned);

  // Platform-aware reveal title matching WorkspaceRoster-D8NyaEmX.js k()
  const getRevealTitle = () => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/Windows/i.test(ua)) return 'Reveal in File Explorer';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'Reveal in Finder';
    return 'Open in File Manager';
  };

  const handleTogglePin = async (wsId: string, pinned: boolean) => {
    if (onTogglePinWorkspace) {
      onTogglePinWorkspace(wsId, pinned);
      return;
    }
    try {
      await invokeCommand('set_workspace_pinned', {
        supportedSchemaVersion: 1,
        workspaceId: wsId,
        pinned,
      });
    } catch (err) {
      console.error('Failed to toggle pin workspace:', err);
    }
  };

  const handleMoveRow = (wsId: string, delta: number) => {
    const current = orderedWorkspaces.map((item) => item.id);
    const fromIndex = current.indexOf(wsId);
    if (fromIndex < 0) return;
    const toIndex = fromIndex + delta;
    if (toIndex < 0 || toIndex >= current.length || toIndex === fromIndex) return;

    const next = current.slice();
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    setWorkspaceOrder(next);

    if (onMoveWorkspace) {
      onMoveWorkspace(wsId, toIndex);
    }

    void invokeCommand('move_workspace', {
      supportedSchemaVersion: 1,
      workspaceId: wsId,
      toIndex,
    }).catch((err) => {
      console.error('Failed to move workspace:', err);
    });
  };

  const handleRevealWorkspace = async (ws: Workspace) => {
    if (onRevealWorkspace) {
      onRevealWorkspace(ws.id);
      return;
    }
    try {
      await invokeCommand('reveal_workspace', {
        supportedSchemaVersion: 1,
        workspaceId: ws.id,
      });
    } catch (err) {
      console.error('Failed to reveal workspace:', err);
    }
  };

  const handleCopyPath = (ws: Workspace) => {
    if (onCopyWorkspacePath) {
      onCopyWorkspacePath(ws.id);
      return;
    }
    const path =
      (ws as any).folderUri ||
      (ws as any).folder ||
      (ws as any).path ||
      (ws as any).ssh?.folder ||
      '';
    if (path && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(path).catch(console.error);
    }
  };

  const handleRemoveWorkspace = async (wsId: string) => {
    if (onRemoveWorkspaceFromList) {
      onRemoveWorkspaceFromList(wsId);
      return;
    }
    try {
      await invokeCommand('remove_workspace', {
        supportedSchemaVersion: 1,
        workspaceId: wsId,
      });
    } catch (err) {
      console.error('Failed to remove workspace:', err);
    }
  };

  const handleOpenWorkspaceMenu = (ws: Workspace, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sshInfo = (ws as Workspace & { ssh?: { host: string; folder: string } }).ssh;
    const group = ws.pinned ? pinnedWorkspaces : unpinnedWorkspaces;
    const groupIndex = group.findIndex((item) => item.id === ws.id);

    const sections: MenuItem[][] = [
      [
        {
          id: 'new-session',
          title: 'New Session…',
          icon: <PlusIcon size={13} strokeWidth={2} />,
          action: () => {
            if (onNewWorkspaceSession) {
              onNewWorkspaceSession(ws.id);
            } else {
              onSelectWorkspace(ws.id);
            }
          },
        },
      ],
      [
        {
          id: 'pin',
          title: ws.pinned ? 'Unpin Workspace' : 'Pin Workspace',
          icon: <PinIcon size={12} filled={ws.pinned} />,
          action: () => handleTogglePin(ws.id, !ws.pinned),
        },
        {
          id: 'move-up',
          title: 'Move Up',
          icon: <ArrowUpIcon size={12} />,
          disabled: groupIndex <= 0,
          action: () => handleMoveRow(ws.id, -1),
        },
        {
          id: 'move-down',
          title: 'Move Down',
          icon: <ArrowDownIcon size={12} />,
          disabled: groupIndex < 0 || groupIndex >= group.length - 1,
          action: () => handleMoveRow(ws.id, 1),
        },
      ],
      [
        !sshInfo && ws.available !== false
          ? {
              id: 'reveal',
              title: getRevealTitle(),
              icon: <FolderOpenIcon size={12} />,
              action: () => handleRevealWorkspace(ws),
            }
          : null,
        {
          id: 'copy-path',
          title: 'Copy Path',
          icon: <CopyIcon size={12} />,
          action: () => handleCopyPath(ws),
        },
      ].filter(Boolean) as MenuItem[],
      [
        {
          id: 'rename',
          title: 'Rename…',
          icon: <PencilIcon size={12} />,
          action: () => {
            setRenamingWorkspaceId(ws.id);
            setRenameWorkspaceValue(ws.displayName);
          },
        },
        {
          id: 'remove',
          title: 'Remove from List…',
          detail: 'Keeps project files and sessions.',
          role: 'destructive',
          icon: <TrashIcon size={13} />,
          action: () => handleRemoveWorkspace(ws.id),
        },
      ],
    ];

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetId: ws.id,
      header: {
        title: ws.displayName,
        subtitle: sshInfo
          ? `${sshInfo.host}:${sshInfo.folder}`
          : ws.available === false
          ? 'Folder unavailable'
          : undefined,
      },
      sections,
    });
  };

  const handleOpenTabMenu = (
    ws: Workspace,
    tab: WorkspaceSessionTab,
    tabIndex: number,
    sessionsCount: number,
    e: React.MouseEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const sections: MenuItem[][] = [
      [
        {
          id: 'up',
          title: 'Move Up',
          icon: <ArrowUpIcon size={12} />,
          disabled: tabIndex <= 0 || readOnly,
          action: () => onMoveWorkspaceTab?.(ws.id, tabIndex, tabIndex - 1),
        },
        {
          id: 'down',
          title: 'Move Down',
          icon: <ArrowDownIcon size={12} />,
          disabled: tabIndex >= sessionsCount - 1 || readOnly,
          action: () => onMoveWorkspaceTab?.(ws.id, tabIndex, tabIndex + 1),
        },
      ],
      [
        {
          id: 'rename',
          title: 'Rename Session…',
          icon: <PencilIcon size={12} />,
          disabled: readOnly,
          action: () => {
            setRenamingTabId(tab.id);
            setRenameTabValue(tab.title || '');
          },
        },
        {
          id: 'close',
          title:
            (tab.paneCount ?? 1) > 1
              ? `Close Session (${tab.paneCount} panes)`
              : 'Close Session',
          role: 'destructive',
          icon: <CloseIcon size={10} />,
          disabled: readOnly,
          action: () => onCloseWorkspaceTab?.(ws.id, tab.id),
        },
      ],
    ];

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetId: tab.id,
      header: { title: tab.title || 'Untitled' },
      sections,
    });
  };

  const commitWorkspaceRename = (wsId: string) => {
    const trimmed = renameWorkspaceValue.trim();
    if (trimmed) {
      if (onRenameWorkspace) {
        onRenameWorkspace(wsId, trimmed);
      } else {
        void invokeCommand('rename_workspace', {
          supportedSchemaVersion: 1,
          workspaceId: wsId,
          displayName: trimmed,
        }).catch(console.error);
      }
    }
    setRenamingWorkspaceId(null);
  };

  const commitTabRename = (wsId: string, tabId: string) => {
    const trimmed = renameTabValue.trim();
    if (trimmed && onRenameWorkspaceTab) {
      onRenameWorkspaceTab(wsId, tabId, trimmed);
    }
    setRenamingTabId(null);
  };

  const renderWorkspaceBranch = (ws: Workspace) => {
    const isSelected = selectedWorkspaceId === ws.id;
    const isExpanded = expandedWorkspaces.has(ws.id);
    const sessions = workspaceSessions?.[ws.id] ?? [];
    const sessionCount = sessions.length;
    const isRenaming = renamingWorkspaceId === ws.id;
    const sshInfo = (ws as Workspace & { ssh?: { host: string; folder: string } }).ssh;

    if (isRenaming) {
      return (
        <div key={ws.id} className="workspace-branch" data-workspace-id={ws.id}>
          <form
            className="workspace-rename-form chat-rail-rename chat-rail-rename--row"
            aria-label={`Rename ${ws.displayName}`}
            onSubmit={(e) => {
              e.preventDefault();
              commitWorkspaceRename(ws.id);
            }}
          >
            <label className="sr-only" htmlFor={`rename-ws-${ws.id}`}>
              Workspace name
            </label>
            <input
              id={`rename-ws-${ws.id}`}
              ref={renameInputRef}
              autoFocus
              maxLength={256}
              value={renameWorkspaceValue}
              onChange={(e) => setRenameWorkspaceValue(e.target.value)}
              placeholder="Leave empty to use the folder's name"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setRenamingWorkspaceId(null);
                }
              }}
              onBlur={(e) => {
                if (!e.currentTarget.form?.contains(e.relatedTarget as Node)) {
                  setRenamingWorkspaceId(null);
                }
              }}
            />
            <button
              type="submit"
              aria-label="Save workspace name"
              title="Save"
              onMouseDown={(e) => e.preventDefault()}
            >
              ✓
            </button>
            <button
              type="button"
              aria-label="Cancel workspace rename"
              title="Cancel"
              onClick={() => setRenamingWorkspaceId(null)}
              onMouseDown={(e) => e.preventDefault()}
            >
              ✕
            </button>
          </form>
        </div>
      );
    }

    return (
      <div key={ws.id} className="workspace-branch" data-workspace-id={ws.id}>
        <div className="workspace-pane-drop-branch">
          <div
            className={`workspace-row${isSelected ? ' workspace-row--selected' : ''}${
              contextMenu?.targetId === ws.id ? ' workspace-row--menu-open' : ''
            }${ws.available === false && !sshInfo ? ' workspace-row--unavailable' : ''}`}
          >
            {sessionCount > 0 ? (
              <button
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${ws.displayName}`}
                className={`workspace-row__disclosure${
                  isExpanded ? ' workspace-row__disclosure--expanded' : ''
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(ws.id);
                }}
                title={isExpanded ? 'Hide sessions' : 'Show sessions'}
                type="button"
              >
                <ChevronRightIcon size={10} />
              </button>
            ) : (
              <span aria-hidden="true" className="workspace-row__disclosure-space" />
            )}

            <button
              aria-current={isSelected ? 'page' : undefined}
              aria-label={ws.displayName}
              className="workspace-row__select"
              onClick={() => onSelectWorkspace(ws.id)}
              onContextMenu={(e) => handleOpenWorkspaceMenu(ws, e)}
              onDoubleClick={() => {
                if (!readOnly) {
                  setRenamingWorkspaceId(ws.id);
                  setRenameWorkspaceValue(ws.displayName);
                }
              }}
              title={
                sshInfo
                  ? `${sshInfo.host}:${sshInfo.folder}`
                  : ws.available === false
                  ? 'Folder unavailable'
                  : ws.displayName
              }
              type="button"
            >
              <FolderOpenIcon size={13} className="workspace-row__icon" />
              <span className="workspace-row__name">{ws.displayName}</span>
            </button>

            <span className="rail-trailing rail-trailing--pair">
              {sessionCount > 0 && (
                <span className="rail-count-badge">
                  {sessionCount}
                  <span className="sr-only"> sessions</span>
                </span>
              )}
              <span className="rail-trailing__actions">
                {onTogglePinWorkspace && (
                  <button
                    aria-label={
                      ws.pinned
                        ? `Unpin ${ws.displayName}`
                        : `Pin ${ws.displayName} to the top`
                    }
                    className="workspace-row__pin"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleTogglePin(ws.id, !ws.pinned);
                    }}
                    title={
                      ws.pinned
                        ? `Unpin ${ws.displayName}`
                        : `Pin ${ws.displayName} to the top`
                    }
                    type="button"
                  >
                    <PinIcon size={11} filled={ws.pinned} />
                  </button>
                )}
                <button
                  aria-label={`New session in ${ws.displayName}`}
                  className="workspace-row__new-session"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onNewWorkspaceSession) {
                      onNewWorkspaceSession(ws.id);
                    } else {
                      onSelectWorkspace(ws.id);
                    }
                  }}
                  title={`New session in ${ws.displayName}`}
                  type="button"
                >
                  <PlusIcon size={11} strokeWidth={2.4} />
                </button>
              </span>
            </span>
          </div>

          {/* Active sessions tree */}
          {isExpanded && sessions.length > 0 && (
            <fieldset aria-label={`${ws.displayName} tabs`} className="workspace-tabs">
              {sessions.map((tab, tabIndex) => {
                const isTabActive = tab.isActive ?? isSelected;
                const isTabRenaming = renamingTabId === tab.id;

                if (isTabRenaming) {
                  return (
                    <form
                      key={tab.id}
                      className="workspace-rename-form chat-rail-rename chat-rail-rename--row chat-rail-rename--session"
                      aria-label={`Rename ${tab.title || 'Untitled'}`}
                      onSubmit={(e) => {
                        e.preventDefault();
                        commitTabRename(ws.id, tab.id);
                      }}
                    >
                      <label className="sr-only" htmlFor={`rename-tab-${tab.id}`}>
                        Session name
                      </label>
                      <input
                        id={`rename-tab-${tab.id}`}
                        ref={renameTabInputRef}
                        autoFocus
                        maxLength={256}
                        value={renameTabValue}
                        onChange={(e) => setRenameTabValue(e.target.value)}
                        placeholder="Session title"
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            setRenamingTabId(null);
                          }
                        }}
                        onBlur={(e) => {
                          if (!e.currentTarget.form?.contains(e.relatedTarget as Node)) {
                            setRenamingTabId(null);
                          }
                        }}
                      />
                      <button
                        type="submit"
                        aria-label="Save session name"
                        title="Save"
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel session rename"
                        title="Cancel"
                        onClick={() => setRenamingTabId(null)}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        ✕
                      </button>
                    </form>
                  );
                }

                return (
                  <div
                    key={tab.id}
                    className={`workspace-tab-row${isTabActive ? ' workspace-tab-row--selected' : ''}${
                      contextMenu?.targetId === tab.id ? ' workspace-tab-row--menu-open' : ''
                    }`}
                  >
                    <button
                      aria-current={isTabActive ? 'page' : undefined}
                      className="workspace-tab-row__select"
                      onClick={() =>
                        onSelectWorkspaceTab
                          ? onSelectWorkspaceTab(ws.id, tab.id)
                          : onSelectWorkspace(ws.id)
                      }
                      onContextMenu={(e) =>
                        handleOpenTabMenu(ws, tab, tabIndex, sessions.length, e)
                      }
                      onDoubleClick={() => {
                        if (!readOnly) {
                          setRenamingTabId(tab.id);
                          setRenameTabValue(tab.title || '');
                        }
                      }}
                      type="button"
                    >
                      <i
                        aria-hidden="true"
                        className="workspace-tab-row__status-dot"
                        data-status={tab.status !== 'idle' ? tab.status : undefined}
                      />
                      <span className="workspace-tab-row__name">{tab.title || 'Untitled'}</span>
                      {(tab.paneCount ?? 1) > 1 && (
                        <small>
                          {tab.paneCount}
                          <span className="sr-only"> panes</span>
                        </small>
                      )}
                    </button>
                    {onCloseWorkspaceTab && (
                      <button
                        aria-label={`Close ${tab.title || 'Untitled'} tab`}
                        className="workspace-tab-row__close"
                        disabled={readOnly}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseWorkspaceTab(ws.id, tab.id);
                        }}
                        title="Close tab (Ctrl+Shift+W)"
                        type="button"
                      >
                        <CloseIcon size={10} />
                      </button>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
        </div>
      </div>
    );
  };

  if (workspaces.length === 0) {
    return (
      <div className={`sidebar-empty sidebar-empty--hint ${className}`.trim()}>
        <p>Add a folder or drop one here</p>
      </div>
    );
  }

  return (
    <>
      <div className={className}>
        {pinnedWorkspaces.length > 0 && (
          <div className="workspace-roster__pinned">
            <h3 className="chat-rail__band-title">Pinned</h3>
            <fieldset aria-label="Pinned folders" className="workspace-roster__group">
              {pinnedWorkspaces.map((ws) => renderWorkspaceBranch(ws))}
            </fieldset>
            <div aria-hidden="true" className="sidebar__rule workspace-roster__rule" />
            <h3 className="chat-rail__band-title">Folders</h3>
          </div>
        )}

        <fieldset aria-label="Folders" className="workspace-roster__group">
          {unpinnedWorkspaces.map((ws) => renderWorkspaceBranch(ws))}
        </fieldset>
      </div>

      <SidebarContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
      />
    </>
  );
};
