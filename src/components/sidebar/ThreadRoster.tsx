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
  SearchIcon,
  TrashIcon,
  RefreshIcon,
} from './sidebarIcons';
import { BrandLogo } from '../ui/BrandLogo';
import { AgentStatusIndicator } from '../ui/AgentStatusIndicator';
import { ActiveChildRows } from './ActiveChildRows';
import {
  groupActiveChildrenByParent,
  isFailedThread,
  parentThreadRollupStatus,
  recordShelfUndo,
  shelfFor,
  shelfPlacement,
  SHELF_UNDO_MS,
  sortThreadsChronologically,
  undoShelf,
  visibleRosterThreads,
  type Shelf,
  type ShelfAction,
  type ShelfThread,
  type ShelfUndo,
} from '../views/chat/threadInteraction';

export const MAX_COLLAPSED_WORKSPACE_THREADS = 6;

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
  onArchiveThread?: (id: string) => void;
  onDeleteThread?: (id: string) => void;
  onRestoreThread?: (id: string) => void;
  onRegenerateTitle?: (threadId: string) => void;
  titlePending?: boolean;
  onOpenArchivedChats?: () => void;
  archivedCount?: number;
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

const ThreadRosterInner: React.FC<ThreadRosterProps> = ({
  threads,
  workspaces = [],
  selectedThreadId,
  onSelectThread,
  onNewChat,
  onNewChatInWorkspace,
  onAddWorkspace,
  onTogglePinThread,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
  onRestoreThread,
  onRegenerateTitle,
  titlePending = false,
  onOpenArchivedChats,
  archivedCount,
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
  const [expandedWorkspaceThreadLists, setExpandedWorkspaceThreadLists] = useState<Set<string>>(
    () => new Set()
  );
  const [collapsedChildGroups, setCollapsedChildGroups] = useState<Set<string>>(() => new Set());
  const workingAnchorRef = useRef<Map<string, number>>(new Map());
  const activeChildrenByParent = React.useMemo(
    () => groupActiveChildrenByParent(threads),
    [threads]
  );
  const effectiveThreadForShelf = (thread: RosterThread): RosterThread => {
    const activeChildren = activeChildrenByParent.get(thread.id) ?? [];
    if (activeChildren.length === 0) return thread;
    const rollup = parentThreadRollupStatus(thread, activeChildren);
    return {
      ...thread,
      status: (rollup.effectiveStatus as RosterThread['status']) ?? thread.status,
      isSettled: false,
    };
  };

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

  const lastRevealedSelectionRef = useRef<{ threadId: string | null; workspaceId: string | null }>({
    threadId: null,
    workspaceId: null,
  });

  useEffect(() => {
    const onWorkspaceAssigned = (e: Event) => {
      const wsId = (e as CustomEvent<{ threadId?: string; workspaceId?: string | null }>).detail
        ?.workspaceId;
      if (!wsId) return;
      setExpandedWorkspaces((prev) => {
        if (prev.has(wsId)) return prev;
        const next = new Set(prev);
        next.add(wsId);
        return next;
      });
    };
    window.addEventListener('kite:thread-workspace-assigned', onWorkspaceAssigned);
    return () => {
      window.removeEventListener('kite:thread-workspace-assigned', onWorkspaceAssigned);
    };
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      lastRevealedSelectionRef.current = { threadId: null, workspaceId: null };
      return;
    }
    const active = threads.find((t) => t.id === selectedThreadId);
    const nextWsId = active?.workspaceId ?? null;
    const prevRevealed = lastRevealedSelectionRef.current;
    if (
      prevRevealed.threadId === selectedThreadId &&
      prevRevealed.workspaceId === nextWsId
    ) {
      return;
    }
    lastRevealedSelectionRef.current = { threadId: selectedThreadId, workspaceId: nextWsId };
    if (!nextWsId) return;
    setExpandedWorkspaces((prev) => {
      if (prev.has(nextWsId)) return prev;
      const next = new Set(prev);
      next.add(nextWsId);
      return next;
    });
    const nowTs = Date.now();
    const siblingsInWs = sortThreadsChronologically(
      visibleRosterThreads(threads).filter((t) => {
        if (t.workspaceId !== nextWsId) return false;
        const shelf = rosterShelf(effectiveThreadForShelf(t), nowTs);
        return shelf !== 'pinned' && shelf !== 'snoozed';
      }),
      (id) => workingAnchorRef.current.get(id),
    );
    const selectedIndex = siblingsInWs.findIndex((t) => t.id === selectedThreadId);
    if (selectedIndex >= MAX_COLLAPSED_WORKSPACE_THREADS) {
      setExpandedWorkspaceThreadLists((prev) => {
        if (prev.has(nextWsId)) return prev;
        const next = new Set(prev);
        next.add(nextWsId);
        return next;
      });
    }
  }, [selectedThreadId, threads]);

  useEffect(() => {
    if (renamingThreadId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingThreadId]);

  const openMenu = onOpenMenu ?? onOpenContextMenu;
  const menuTargetId = contextMenuTargetId ?? activeContextMenuTargetId;
  const query = searchQuery.trim().toLowerCase();
  const listedThreads = React.useMemo(() => visibleRosterThreads(threads), [threads]);
  const {
    pinnedThreads,
    snoozedThreads,
    activeOtherThreads,
    settledOtherThreads,
    workspaceThreadsById,
  } = React.useMemo(() => {
    const now = Date.now();
    const visibleThreads = listedThreads.filter((thread) => matchesThreadSearch(thread, query));
    const shelfOf = (thread: RosterThread) => rosterShelf(effectiveThreadForShelf(thread), now);

    const nextWorkingIds = new Set<string>();
    for (const thread of visibleThreads) {
      const eff = effectiveThreadForShelf(thread);
      const isWorking = eff.status === 'running' || eff.status === 'waiting';
      if (isWorking && thread.lastTurnAtUnixMs == null) {
        nextWorkingIds.add(thread.id);
        if (!workingAnchorRef.current.has(thread.id)) {
          workingAnchorRef.current.set(
            thread.id,
            thread.updatedAtUnixMs ?? thread.createdAtUnixMs ?? now,
          );
        }
      }
    }
    for (const existingId of Array.from(workingAnchorRef.current.keys())) {
      if (!nextWorkingIds.has(existingId)) {
        workingAnchorRef.current.delete(existingId);
      }
    }
    const getWorkingAnchor = (id: string) => workingAnchorRef.current.get(id);

    const workspaceIds = new Set(workspaces.map((w) => w.id));
    const pinnedRaw: RosterThread[] = [];
    const snoozedRaw: RosterThread[] = [];
    const activeOtherRaw: RosterThread[] = [];
    const settledOtherRaw: RosterThread[] = [];
    const byWsRaw = new Map<string, RosterThread[]>();
    for (const ws of workspaces) {
      byWsRaw.set(ws.id, []);
    }

    for (const thread of visibleThreads) {
      const shelf = shelfOf(thread);
      if (shelf === 'pinned') {
        pinnedRaw.push(thread);
        continue;
      }
      if (shelf === 'snoozed') {
        snoozedRaw.push(thread);
        continue;
      }
      if (thread.workspaceId && workspaceIds.has(thread.workspaceId)) {
        byWsRaw.get(thread.workspaceId)!.push(thread);
      } else if (shelf === 'active' || shelf === 'working') {
        activeOtherRaw.push(thread);
      } else if (shelf === 'settled') {
        settledOtherRaw.push(thread);
      }
    }

    const byWsSorted = new Map<string, RosterThread[]>();
    for (const [wsId, list] of byWsRaw.entries()) {
      byWsSorted.set(wsId, sortThreadsChronologically(list, getWorkingAnchor));
    }

    return {
      pinnedThreads: sortThreadsChronologically(pinnedRaw, getWorkingAnchor),
      snoozedThreads: sortThreadsChronologically(snoozedRaw, getWorkingAnchor),
      activeOtherThreads: sortThreadsChronologically(activeOtherRaw, getWorkingAnchor),
      settledOtherThreads: sortThreadsChronologically(settledOtherRaw, getWorkingAnchor),
      workspaceThreadsById: byWsSorted,
    };
  }, [listedThreads, workspaces, query]);

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

  const toggleWorkspaceThreadList = (wsId: string) => {
    setExpandedWorkspaceThreadLists((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const rememberUndo = (action: ShelfAction, thread: RosterThread) => {
    const now = Date.now();
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
    if (!onArchiveThread && !onDeleteThread) return;
    rememberUndo('Archive', thread);
    if (onArchiveThread) {
      onArchiveThread(thread.id);
    } else {
      onDeleteThread?.(thread.id);
    }
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
        onArchiveThread || onDeleteThread
          ? {
              id: 'archive',
              title: 'Archive',
              icon: <ArchiveIcon size={12} />,
              action: () => archiveThread(thread),
            }
          : null,
        onDeleteThread
          ? {
              id: 'delete',
              title: 'Delete chat',
              role: 'destructive',
              icon: <TrashIcon size={12} />,
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
    const activeChildren = activeChildrenByParent.get(thread.id) ?? [];
    const rollup = parentThreadRollupStatus(thread, activeChildren);
    const effectiveStatus = (rollup.effectiveStatus as ChatThreadSummary['status']) ?? thread.status;
    const trailingText =
      rollup.rollupBadge ?? formatThreadTrailing({ ...thread, status: effectiveStatus });
    const trailingMod = getTrailingModifier(effectiveStatus);
    const childrenExpanded = activeChildren.length > 0 && !collapsedChildGroups.has(thread.id);

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

    const isSettled = activeChildren.length > 0 ? false : isThreadSettled(thread);

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
          {effectiveStatus === 'running' ? (
            <AgentStatusIndicator status="running" size={12} />
          ) : (
            <i
              aria-hidden="true"
              className={getStatusDotClass(effectiveStatus, thread.sessionState, thread.isWarm)}
            />
          )}
          <BrandLogo engine={thread.provider || 'antigravity'} size={14} className="chat-thread-row__logo" />
          <span className="chat-thread-row__title">{thread.title}</span>
          {thread.unread && <i aria-hidden="true" className="chat-thread-row__unread" />}
          {(rollup.rollupBadge || effectiveStatus !== 'running') && (
            <span
              aria-hidden="true"
              className={`chat-thread-row__trailing${trailingMod}${
                effectiveStatus === 'running' ? ' chat-working-live' : ''
              }`}
            >
              {trailingText}
            </span>
          )}
        </button>

        {activeChildren.length > 0 && (
          <button
            type="button"
            className="chat-thread-row__children-toggle"
            aria-expanded={childrenExpanded}
            aria-label={
              childrenExpanded
                ? `Collapse subagents for ${thread.title}`
                : `Expand subagents for ${thread.title}`
            }
            title={childrenExpanded ? 'Hide active subagents' : 'Show active subagents'}
            onClick={(event) => {
              event.stopPropagation();
              setCollapsedChildGroups((prev) => {
                const next = new Set(prev);
                if (next.has(thread.id)) next.delete(thread.id);
                else next.add(thread.id);
                return next;
              });
            }}
          >
            <ChevronRightIcon
              size={11}
              style={{
                transform: childrenExpanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 120ms ease',
              }}
            />
          </button>
        )}

        <span className="chat-thread-row__actions">
          {onRegenerateTitle && isSelected ? (
            <button
              type="button"
              aria-label="Regenerate title"
              title="Regenerate title"
              disabled={titlePending}
              onClick={(event) => {
                event.stopPropagation();
                if (titlePending) return;
                onRegenerateTitle(thread.id);
              }}
            >
              <RefreshIcon size={11} />
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
          {onArchiveThread || onDeleteThread ? (
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

    const nestedChildrenList = childrenExpanded ? (
      <ActiveChildRows
        parentId={thread.id}
        parentTitle={thread.title}
        workspaceId={thread.workspaceId}
        childrenList={activeChildren}
        selectedThreadId={selectedThreadId}
        onSelectParent={onSelectThread}
      />
    ) : null;

    return (
      <div key={thread.id} className="chat-thread-item">
        <div className={rowClassName} data-thread-id={thread.id}>
          {row}
        </div>
        {nestedChildrenList}
      </div>
    );
  };

  return (
    <nav aria-label="Threads" className="chat-rail">
      <div className="chat-rail__search">
        <SearchIcon size={12} />
        <input
          type="text"
          aria-label="Search threads"
          className="chat-rail__search-input"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          placeholder="Search threads…"
        />
        {searchQuery ? (
          <button
            type="button"
            className="chat-rail__search-clear"
            aria-label="Clear search"
            onClick={() => setSearchQuery('')}
          >
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
        const wsThreads = workspaceThreadsById.get(ws.id) ?? [];
        const isExpanded = expandedWorkspaces.has(ws.id);
        const isThreadListExpanded = expandedWorkspaceThreadLists.has(ws.id);
        const hasOverflow = !query && wsThreads.length > MAX_COLLAPSED_WORKSPACE_THREADS;
        const visibleWsThreads =
          hasOverflow && !isThreadListExpanded
            ? wsThreads.slice(0, MAX_COLLAPSED_WORKSPACE_THREADS)
            : wsThreads;
        const hiddenCount = wsThreads.length - visibleWsThreads.length;
        const hasSelected = selectedThreadId ? wsThreads.some((t) => t.id === selectedThreadId) : false;

        return (
          <div key={ws.id} className="chat-rail__workspace-branch">
            <div className={`workspace-item${hasSelected ? ' workspace-item--dimmed' : ''}`}>
              <button
                type="button"
                className="workspace-item__toggle"
                onClick={() => toggleWorkspace(ws.id)}
                aria-expanded={isExpanded}
              >
                <ChevronRightIcon
                  size={10}
                  className={`chat-chevron workspace-item__chevron${isExpanded ? ' chat-chevron--expanded' : ''}`}
                />
                <FolderOpenIcon size={13} className="workspace-item__folder-icon" />
                <span className="workspace-item__label">{ws.displayName}</span>
              </button>
              <button
                type="button"
                className="workspace-item__action"
                onClick={() => (onNewChatInWorkspace ? onNewChatInWorkspace(ws.id) : onNewChat?.())}
                title={`New thread in ${ws.displayName}`}
                aria-label={`New thread in ${ws.displayName}`}
              >
                <PlusIcon size={12} />
              </button>
            </div>

            {isExpanded && wsThreads.length > 0 && (
              <section
                aria-label={`${ws.displayName} threads`}
                className="chat-thread-list chat-thread-list--nested"
              >
                {visibleWsThreads.map((t) => renderRow(t, true, ws.displayName))}
                {hasOverflow && (
                  <button
                    type="button"
                    className="chat-thread-workspace__more"
                    aria-expanded={isThreadListExpanded}
                    onClick={() => toggleWorkspaceThreadList(ws.id)}
                  >
                    {isThreadListExpanded ? 'Show less' : `+${hiddenCount} more`}
                  </button>
                )}
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
            <ChevronRightIcon size={10} className="chat-rail__settled-chevron" />
            <span className="chat-rail__band-title chat-rail__settled-title">Settled</span>
            <span className="chat-rail__settled-count">{settledOtherThreads.length}</span>
          </button>
          {isSettledExpanded && (
            <section aria-label="Settled threads" className="chat-thread-list">
              {settledOtherThreads.map((t) => renderRow(t, false))}
            </section>
          )}
        </section>
      )}

      {shelfUndo ? (
        <div className="chat-rail__undo rounded-card" role="status">
          <span>{shelfUndo.action}</span>
          <button type="button" className="chrome-button" onClick={runUndo}>
            Undo
          </button>
        </div>
      ) : null}

      {/* 6. Archived threads button */}
      <button
        type="button"
        aria-label={
          typeof archivedCount === 'number' && archivedCount > 0
            ? `Archived threads, ${archivedCount} archived`
            : 'Archived threads'
        }
        className="chat-rail__more"
        onClick={onOpenArchivedChats}
      >
        <ArchiveIcon size={12} />
        <span>Archived threads</span>
        {typeof archivedCount === 'number' && archivedCount > 0 && (
          <span className="chat-rail__badge" aria-hidden="true">
            {archivedCount}
          </span>
        )}
      </button>
    </nav>
  );
};

export const ThreadRoster = React.memo(ThreadRosterInner);
