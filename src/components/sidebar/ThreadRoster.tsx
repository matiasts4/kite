import React, { useState, useRef, useEffect } from 'react';
import { motion, MotionGlobalConfig } from 'motion/react';
import { springs } from '../../motion/standard/tokens';
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
  SearchIcon,
} from './sidebarIcons';
import { BrandLogo } from '../ui/BrandLogo';
import {
  isFailedThread,
  recordShelfUndo,
  shelfFor,
  shelfPlacement,
  SHELF_UNDO_MS,
  undoShelf,
  visibleRosterThreads,
  type Shelf,
  type ShelfAction,
  type ShelfThread,
  type ShelfUndo,
} from '../views/chat/threadInteraction';

export type RosterThread = ChatThreadSummary & {
  sideChat?: boolean;
  snoozedUntil?: number | null;
  model?: string | null;
};

export interface ThreadRosterProps {
  threads: RosterThread[];
  workspaces?: Workspace[];
  selectedThreadId?: string | null;
  onSelectThread?: (id: string) => void;
  onNewChat?: () => void;
  onNewChatInWorkspace?: (workspaceId: string) => void;
  onAddWorkspace?: () => void;
  onTogglePinThread?: (id: string, pinned: boolean) => void;
  onRenameThread?: (id: string, newTitle: string) => void;
  onDeleteThread?: (id: string) => void;
  onRestoreThread?: (id: string) => void;
  onRegenerateTitle?: (threadId: string) => void;
  titlePending?: boolean;
  onOpenArchivedChats?: () => void;
  onOpenMenu?: (menu: ContextMenuState) => void;
  onOpenContextMenu?: (menu: ContextMenuState) => void;
  contextMenuTargetId?: string | null;
  activeContextMenuTargetId?: string | null;
}

function getStatusDotClass(status?: string, sessionState?: string, isWarm?: boolean): string {
  if (status === 'running') {
    return 'chat-thread-row__dot chat-thread-row__dot--running';
  }
  if (status === 'waiting') {
    return 'chat-thread-row__dot chat-thread-row__dot--waiting';
  }
  if (isFailedThread({ status })) {
    return 'chat-thread-row__dot chat-thread-row__dot--failed';
  }
  if (isWarm || sessionState === 'warm') {
    return 'chat-thread-row__dot chat-thread-row__dot--warm';
  }
  return 'chat-thread-row__dot chat-thread-row__dot--settled';
}

export function isThreadSettled(thread: ChatThreadSummary): boolean {
  if (thread.isSettled !== undefined) return thread.isSettled;
  const isWarm = Boolean(thread.isWarm || thread.sessionState === 'warm');
  const isBusy = thread.status === 'running' || thread.status === 'waiting' || thread.status === 'error';
  return !isWarm && !isBusy;
}

function isPinnedThread(thread: RosterThread): boolean {
  return Boolean(thread.isPinned || thread.pinned);
}

function asShelfThread(thread: RosterThread, now: number): ShelfThread {
  const snoozed = typeof thread.snoozedUntil === 'number' && thread.snoozedUntil > now;
  return {
    id: thread.id,
    pinned: isPinnedThread(thread),
    status: thread.status,
    snoozedUntil: thread.snoozedUntil ?? null,
    settled:
      snoozed || thread.status === 'running' || thread.status === 'waiting'
        ? false
        : isThreadSettled(thread),
  };
}

function rosterShelf(thread: RosterThread, now: number): Shelf {
  return shelfFor(asShelfThread(thread, now), now);
}

function matchesThreadSearch(thread: RosterThread, query: string): boolean {
  if (!query) return true;
  return (
    thread.title.toLowerCase().includes(query) ||
    (thread.provider ?? '').toLowerCase().includes(query) ||
    (thread.model ?? '').toLowerCase().includes(query)
  );
}

function getTrailingModifier(status?: string): string {
  if (status === 'running') return ' chat-thread-row__trailing--running';
  if (status === 'waiting') return ' chat-thread-row__trailing--waiting';
  if (isFailedThread({ status })) return ' chat-thread-row__trailing--failed';
  return '';
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
  onRestoreThread,
  onRegenerateTitle,
  titlePending = false,
  onOpenArchivedChats,
  onOpenMenu,
  onOpenContextMenu,
  contextMenuTargetId,
  activeContextMenuTargetId,
}) => {
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [shelfUndo, setShelfUndo] = useState<ShelfUndo | null>(null);
  const undoRef = useRef<ShelfUndo | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    () => new Set(workspaces.map((w) => w.id))
  );

  useEffect(() => {
    setExpandedWorkspaces((prev) => {
      let changed = false;
      const next = new Set(prev);
      workspaces.forEach((w) => {
        if (!next.has(w.id)) {
          next.add(w.id);
          changed = true;
        }
      });
      return changed ? next : prev;
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
  const now = Date.now();
  const query = searchQuery.trim().toLowerCase();
  const visibleThreads = visibleRosterThreads(threads).filter((thread) => matchesThreadSearch(thread, query));
  const shelfOf = (thread: RosterThread) => rosterShelf(thread, now);

  const pinnedThreads = visibleThreads.filter((thread) => shelfOf(thread) === 'pinned');
  const workingThreads = visibleThreads.filter((thread) => shelfOf(thread) === 'working');
  const snoozedThreads = visibleThreads.filter((thread) => shelfOf(thread) === 'snoozed');
  const workspaceIds = new Set(workspaces.map((w) => w.id));
  const listedThreads = visibleRosterThreads(threads);
  const otherThreads = visibleThreads.filter((thread) => {
    const shelf = shelfOf(thread);
    return (
      (shelf === 'active' || shelf === 'settled') &&
      (!thread.workspaceId || !workspaceIds.has(thread.workspaceId))
    );
  });

  const activeOtherThreads = otherThreads.filter((thread) => shelfOf(thread) === 'active');
  const settledOtherThreads = otherThreads.filter((thread) => shelfOf(thread) === 'settled');

  const [settledOpen, setSettledOpen] = useState<boolean | null>(null);
  const isSelectedInSettled = selectedThreadId
    ? settledOtherThreads.some((t) => t.id === selectedThreadId)
    : false;
  const isSettledExpanded =
    settledOpen !== null
      ? settledOpen
      : activeOtherThreads.length === 0 || isSelectedInSettled;

  const toggleWorkspace = (wsId: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const rememberUndo = (action: ShelfAction, thread: RosterThread) => {
    const placement = shelfPlacement(
      listedThreads.map((item) => asShelfThread(item, now)),
      thread.id,
      now,
    );
    if (!placement) return;
    const next = recordShelfUndo(action, thread.id, placement, now);
    undoRef.current = next;
    setShelfUndo(next);
  };

  const runUndo = () => {
    const current = undoRef.current;
    const previous = undoShelf(current, Date.now());
    undoRef.current = null;
    setShelfUndo(null);
    if (!current || !previous) return;
    if (current.action === 'Archive') {
      onRestoreThread?.(current.threadId);
      if (previous.shelf === 'pinned') onTogglePinThread?.(current.threadId, true);
      return;
    }
    if (current.action === 'Pin' || current.action === 'Unpin') {
      onTogglePinThread?.(current.threadId, previous.shelf === 'pinned');
    }
  };

  useEffect(() => {
    if (!shelfUndo) return;
    const timer = window.setTimeout(() => {
      undoRef.current = null;
      setShelfUndo(null);
    }, SHELF_UNDO_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.shiftKey || event.altKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      runUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [shelfUndo]);

  const changePin = (thread: RosterThread, pinned: boolean) => {
    if (!onTogglePinThread) return;
    rememberUndo(pinned ? 'Pin' : 'Unpin', thread);
    onTogglePinThread(thread.id, pinned);
  };

  const archiveThread = (thread: RosterThread) => {
    if (!onDeleteThread) return;
    rememberUndo('Archive', thread);
    onDeleteThread(thread.id);
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
        onRegenerateTitle
          ? {
              id: 'regenerate-title',
              title: 'Regenerate title',
              disabled: titlePending,
              action: () => {
                if (titlePending) return;
                onRegenerateTitle(thread.id);
              },
            }
          : null,
        onTogglePinThread
          ? {
              id: 'pin',
              title: isPinned ? 'Unpin' : 'Pin to Top',
              icon: <PinIcon size={12} filled={isPinned} />,
              action: () => changePin(thread, !isPinned),
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
              action: () => archiveThread(thread),
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

    const isSettled = isThreadSettled(thread);

    const rowClassName = `chat-thread-row${isSelected ? ' chat-thread-row--selected' : ''}${
      nested ? ' chat-thread-row--nested' : ''
    }${isMenuOpen ? ' chat-thread-row--menu-open' : ''}${
      isSettled ? ' chat-thread-row--settled' : ''
    }`;
    const row = (
      <>
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
          <i aria-hidden="true" className={getStatusDotClass(thread.status, thread.sessionState, thread.isWarm)} />
          <BrandLogo engine={thread.provider || 'antigravity'} size={14} className="chat-thread-row__logo" />
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
          {onRegenerateTitle && isSelected ? (
            <button
              type="button"
              disabled={titlePending}
              onClick={(event) => {
                event.stopPropagation();
                if (titlePending) return;
                onRegenerateTitle(thread.id);
              }}
            >
              Regenerate title
            </button>
          ) : null}
          <button
            type="button"
            aria-label={isPinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
            onClick={(e) => {
              e.stopPropagation();
              changePin(thread, !isPinned);
            }}
            title={isPinned ? 'Unpin' : 'Pin to Top'}
          >
            <PinIcon size={12} filled={isPinned} />
          </button>
          {onDeleteThread ? (
            <button
              type="button"
              aria-label={`Archive ${thread.title}`}
              onClick={(event) => {
                event.stopPropagation();
                archiveThread(thread);
              }}
              title="Archive"
            >
              <ArchiveIcon size={12} />
            </button>
          ) : null}
        </span>
      </>
    );

    if (MotionGlobalConfig.skipAnimations) {
      return (
        <div key={thread.id} className={rowClassName} data-thread-id={thread.id}>
          {row}
        </div>
      );
    }

    return (
      <motion.div
        layout
        transition={springs.reflow}
        key={thread.id}
        className={rowClassName}
        data-thread-id={thread.id}
      >
        {row}
      </motion.div>
    );
  };

  return (
    <nav aria-label="Threads" className="chat-rail">
      <div
        className="chat-rail__search"
        style={{
          padding: '6px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          borderBottom: '1px solid var(--separator)',
        }}
      >
        <SearchIcon size={12} />
        <input
          type="text"
          aria-label="Search threads"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          placeholder="Search threads…"
          style={{
            width: '100%',
            background: 'transparent',
            border: 0,
            outline: 'none',
            fontSize: 'var(--text-caption)',
            color: 'var(--text-primary)',
            padding: '2px 0',
          }}
        />
        {searchQuery ? (
          <button type="button" aria-label="Clear search" onClick={() => setSearchQuery('')}>
            <CloseIcon size={11} />
          </button>
        ) : null}
      </div>

      {/* 1. Pinned threads */}
      {pinnedThreads.length > 0 && (
        <section className="chat-rail__band chat-rail__band--pinned">
          <h3 className="chat-rail__band-title">Pinned threads</h3>
          <section aria-label="Pinned threads" className="chat-thread-list">
            {pinnedThreads.map((t) => renderRow(t, false))}
          </section>
        </section>
      )}

      {workingThreads.length > 0 && (
        <section className="chat-rail__band" aria-label="Working">
          <h3 className="chat-rail__band-title">Working</h3>
          <section aria-label="Working threads" className="chat-thread-list">
            {workingThreads.map((thread) => renderRow(thread, false))}
          </section>
        </section>
      )}

      {snoozedThreads.length > 0 && (
        <section className="chat-rail__band" aria-label="Snoozed">
          <h3 className="chat-rail__band-title">Snoozed</h3>
          <section aria-label="Snoozed threads" className="chat-thread-list">
            {snoozedThreads.map((thread) => renderRow(thread, false))}
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
        const wsThreads = visibleThreads.filter((thread) => {
          const shelf = shelfOf(thread);
          return thread.workspaceId === ws.id && (shelf === 'active' || shelf === 'settled');
        });
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
      {activeOtherThreads.length > 0 && (
        <section className="chat-rail__band">
          <h3 className="chat-rail__band-title">Other threads</h3>
          <section aria-label="Other threads" className="chat-thread-list">
            {activeOtherThreads.map((t) => renderRow(t, false))}
          </section>
        </section>
      )}

      {/* 5. Settled threads */}
      {settledOtherThreads.length > 0 && (
        <section className="chat-rail__band chat-rail__band--settled">
          <button
            type="button"
            className="chat-rail__settled-toggle"
            onClick={() => setSettledOpen(!isSettledExpanded)}
            aria-expanded={isSettledExpanded}
          >
            <ChevronRightIcon
              size={10}
              style={{
                transform: isSettledExpanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 120ms ease',
                flexShrink: 0,
              }}
            />
            <span className="chat-rail__band-title" style={{ margin: 0, textTransform: 'none' }}>Settled</span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 'var(--text-badge)',
                color: 'var(--text-faint)',
                padding: '0 4px',
                borderRadius: 'var(--radius-chip)',
                background: 'var(--chip-fill)',
              }}
            >
              {settledOtherThreads.length}
            </span>
          </button>
          {isSettledExpanded && (
            <section aria-label="Settled threads" className="chat-thread-list">
              {settledOtherThreads.map((t) => renderRow(t, false))}
            </section>
          )}
        </section>
      )}

      {shelfUndo ? (
        <div
          className="chat-rail__undo rounded-card"
          role="status"
          style={{
            margin: '8px',
            padding: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            border: '1px solid var(--separator)',
          }}
        >
          <span>{shelfUndo.action}</span>
          <button type="button" className="chrome-button" onClick={runUndo}>
            Undo
          </button>
        </div>
      ) : null}

      {/* 6. Archived threads button */}
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
