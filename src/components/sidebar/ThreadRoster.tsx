import React, { useState, useRef, useEffect } from 'react';
import type { Workspace } from '../../types';
import type { ChatThreadSummary, MenuItem, ContextMenuState } from './types';
import { formatThreadTrailing } from './types';
import {
  PlusIcon,
  PinIcon,
  ArchiveIcon,
  FolderOpenIcon,
  ChevronRightIcon,
  CheckIcon,
  CloseIcon,
  PencilIcon,
} from './sidebarIcons';

export interface ThreadRosterProps {
  threads: ChatThreadSummary[];
  workspaces?: Workspace[];
  selectedThreadId?: string | null;
  onSelectThread?: (id: string) => void;
  onNewChat?: () => void;
  onNewChatInWorkspace?: (workspaceId: string) => void;
  onAddWorkspace?: () => void;
  onTogglePinThread?: (id: string, pinned: boolean) => void;
  onRenameThread?: (id: string, newTitle: string) => void;
  onDeleteThread?: (id: string) => void;
  onOpenArchivedChats?: () => void;
  onOpenMenu?: (menu: ContextMenuState) => void;
  onOpenContextMenu?: (menu: ContextMenuState) => void;
  contextMenuTargetId?: string | null;
  activeContextMenuTargetId?: string | null;
}

function getStatusDotClass(status?: string): string {
  switch (status) {
    case 'running':
      return 'chat-thread-row__dot chat-thread-row__dot--running';
    case 'waiting':
      return 'chat-thread-row__dot chat-thread-row__dot--waiting';
    case 'error':
      return 'chat-thread-row__dot chat-thread-row__dot--failed';
    default:
      return 'chat-thread-row__dot';
  }
}

function getTrailingModifier(status?: string): string {
  switch (status) {
    case 'running':
      return ' chat-thread-row__trailing--running';
    case 'waiting':
      return ' chat-thread-row__trailing--waiting';
    case 'error':
      return ' chat-thread-row__trailing--failed';
    default:
      return '';
  }
}

export const ThreadRoster: React.FC<ThreadRosterProps> = ({
  threads,
  workspaces = [],
  selectedThreadId,
  onSelectThread,
  onNewChat,
  onNewChatInWorkspace,
  onAddWorkspace,
  onTogglePinThread,
  onRenameThread,
  onDeleteThread,
  onOpenArchivedChats,
  onOpenMenu,
  onOpenContextMenu,
  contextMenuTargetId,
  activeContextMenuTargetId,
}) => {
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    () => new Set(workspaces.map((w) => w.id))
  );

  useEffect(() => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      workspaces.forEach((w) => {
        if (!next.has(w.id)) next.add(w.id);
      });
      return next;
    });
  }, [workspaces]);

  useEffect(() => {
    if (renamingThreadId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingThreadId]);

  const openMenu = onOpenMenu ?? onOpenContextMenu;
  const menuTargetId = contextMenuTargetId ?? activeContextMenuTargetId;

  const pinnedThreads = threads.filter((t) => t.isPinned || t.pinned);
  const workspaceIds = new Set(workspaces.map((w) => w.id));
  const otherThreads = threads.filter(
    (t) => !(t.isPinned || t.pinned) && (!t.workspaceId || !workspaceIds.has(t.workspaceId))
  );

  const toggleWorkspace = (wsId: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const handleCommitRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingThreadId) return;
    const clean = renameTitle.trim();
    if (clean) {
      onRenameThread?.(renamingThreadId, clean);
    }
    setRenamingThreadId(null);
  };

  const handleOpenThreadMenu = (thread: ChatThreadSummary, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!openMenu) return;

    const isPinned = thread.isPinned ?? thread.pinned ?? false;

    const sections: MenuItem[][] = [
      [
        {
          id: 'rename',
          title: 'Rename…',
          icon: <PencilIcon size={12} />,
          action: () => {
            setRenamingThreadId(thread.id);
            setRenameTitle(thread.title);
          },
        },
        onTogglePinThread
          ? {
              id: 'pin',
              title: isPinned ? 'Unpin' : 'Pin to Top',
              icon: <PinIcon size={12} filled={isPinned} />,
              action: () => onTogglePinThread(thread.id, !isPinned),
            }
          : null,
      ].filter(Boolean) as MenuItem[],
      [
        onDeleteThread
          ? {
              id: 'archive',
              title: 'Archive',
              role: 'destructive',
              icon: <ArchiveIcon size={12} />,
              action: () => onDeleteThread(thread.id),
            }
          : null,
      ].filter(Boolean) as MenuItem[],
    ];

    openMenu({
      x: e.clientX,
      y: e.clientY,
      header: {
        title: thread.title,
        subtitle: thread.provider?.toUpperCase() || 'CHAT',
      },
      sections,
      targetId: thread.id,
    });
  };

  const renderRow = (thread: ChatThreadSummary, nested = false, folderName?: string) => {
    const isSelected = thread.id === selectedThreadId;
    const isPinned = thread.isPinned || thread.pinned;
    const isMenuOpen = menuTargetId === thread.id;
    const trailingText = formatThreadTrailing(thread);
    const trailingMod = getTrailingModifier(thread.status);

    if (renamingThreadId === thread.id) {
      return (
        <form
          key={thread.id}
          aria-label={`Rename ${thread.title}`}
          className="chat-rail-rename"
          onSubmit={handleCommitRename}
        >
          <label className="sr-only" htmlFor={`rename-${thread.id}`}>
            Thread title
          </label>
          <input
            id={`rename-${thread.id}`}
            maxLength={1024}
            ref={renameInputRef}
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setRenamingThreadId(null);
              }
            }}
          />
          <button
            aria-label="Save thread title"
            disabled={renameTitle.trim().length === 0}
            type="submit"
          >
            <CheckIcon size={12} />
          </button>
          <button
            aria-label="Cancel thread rename"
            type="button"
            onClick={() => setRenamingThreadId(null)}
          >
            <CloseIcon size={12} />
          </button>
        </form>
      );
    }

    return (
      <div
        key={thread.id}
        className={`chat-thread-row${isSelected ? ' chat-thread-row--selected' : ''}${
          nested ? ' chat-thread-row--nested' : ''
        }${isMenuOpen ? ' chat-thread-row--menu-open' : ''}`}
        data-thread-id={thread.id}
      >
        <button
          type="button"
          aria-current={isSelected ? 'page' : undefined}
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          aria-label={`${thread.title}, ${trailingText}`}
          className="chat-thread-row__select"
          onClick={() => onSelectThread?.(thread.id)}
          onContextMenu={(e) => handleOpenThreadMenu(thread, e)}
          title={folderName ? `${thread.title} · ${folderName}` : thread.title}
        >
          <i aria-hidden="true" className={getStatusDotClass(thread.status)} />
          <span className="chat-thread-row__title">{thread.title}</span>
          {thread.unread && <i aria-hidden="true" className="chat-thread-row__unread" />}
          <span
            aria-hidden="true"
            className={`chat-thread-row__trailing${trailingMod}`}
          >
            {trailingText}
          </span>
        </button>

        <span className="chat-thread-row__actions">
          <button
            type="button"
            aria-label={isPinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePinThread?.(thread.id, !isPinned);
            }}
            title={isPinned ? 'Unpin' : 'Pin to Top'}
          >
            <PinIcon size={12} filled={isPinned} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <nav aria-label="Threads" className="chat-rail">
      {/* 1. Pinned threads */}
      {pinnedThreads.length > 0 && (
        <section className="chat-rail__band chat-rail__band--pinned">
          <h3 className="chat-rail__band-title">Pinned threads</h3>
          <section aria-label="Pinned threads" className="chat-thread-list">
            {pinnedThreads.map((t) => renderRow(t, false))}
          </section>
        </section>
      )}

      {/* 2. Empty state when workspaces.length === 0 */}
      {workspaces.length === 0 && (
        <div className="sidebar-empty sidebar-empty--chat">
          <p>
            Thread mode works without a folder. Add one and every thread you start there is a coding session in it.
          </p>
          <button
            type="button"
            className="sidebar-empty__primary"
            onClick={onAddWorkspace}
          >
            <PlusIcon size={12} strokeWidth={2.5} />
            Add a folder
          </button>
        </div>
      )}

      {/* 3. Folder list with nested threads */}
      {workspaces.map((ws) => {
        const wsThreads = threads.filter(
          (t) => !(t.isPinned || t.pinned) && t.workspaceId === ws.id
        );
        const isExpanded = expandedWorkspaces.has(ws.id);
        const hasSelected = selectedThreadId ? wsThreads.some((t) => t.id === selectedThreadId) : false;

        return (
          <div key={ws.id} className="chat-rail__workspace-branch">
            <div
              className={`workspace-item${hasSelected ? ' workspace-item--dimmed' : ''}`}
              style={{ display: 'flex', alignItems: 'center', width: '100%', minHeight: '27px', padding: '0 8px' }}
            >
              <button
                type="button"
                className="workspace-item__toggle"
                onClick={() => toggleWorkspace(ws.id)}
                aria-expanded={isExpanded}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  flex: 1,
                  textAlign: 'left',
                  fontSize: '12px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  padding: 0,
                }}
              >
                <ChevronRightIcon
                  size={10}
                  className={`chat-chevron${isExpanded ? ' chat-chevron--expanded' : ''}`}
                  style={{
                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 120ms ease',
                    flexShrink: 0,
                  }}
                />
                <FolderOpenIcon size={13} style={{ flexShrink: 0, opacity: 0.8 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ws.displayName}
                </span>
              </button>
              <button
                type="button"
                className="workspace-item__action"
                onClick={() => (onNewChatInWorkspace ? onNewChatInWorkspace(ws.id) : onNewChat?.())}
                title={`New thread in ${ws.displayName}`}
                aria-label={`New thread in ${ws.displayName}`}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '3px',
                }}
              >
                <PlusIcon size={12} />
              </button>
            </div>

            {isExpanded && wsThreads.length > 0 && (
              <section
                aria-label={`${ws.displayName} threads`}
                className="chat-thread-list chat-thread-list--nested"
              >
                {wsThreads.map((t) => renderRow(t, true, ws.displayName))}
              </section>
            )}
          </div>
        );
      })}

      {/* 4. Other threads */}
      {otherThreads.length > 0 && (
        <section className="chat-rail__band">
          <h3 className="chat-rail__band-title">Other threads</h3>
          <section aria-label="Other threads" className="chat-thread-list">
            {otherThreads.map((t) => renderRow(t, false))}
          </section>
        </section>
      )}

      {/* 5. Archived threads button */}
      <button
        type="button"
        aria-label="Archived threads"
        className="chat-rail__more"
        onClick={onOpenArchivedChats}
      >
        <ArchiveIcon size={12} />
        <span>Archived threads</span>
      </button>
    </nav>
  );
};
