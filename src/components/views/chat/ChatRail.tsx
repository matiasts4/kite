import React, { useState, useMemo } from 'react';
import type { ExtendedChatThread } from './types';
import {
  PinIcon,
  ArchiveIcon,
  PlusIcon,
  CheckIcon,
  CloseIcon,
  SearchIcon,
} from './ChatIcons';
import { ArchivedChatsModal } from '../modals/ArchivedChatsModal';

export interface ChatRailProps {
  threads: ExtendedChatThread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onPinThread: (threadId: string, pinned: boolean) => void;
  onArchiveThread: (threadId: string) => void;
  onRenameThread: (threadId: string, newTitle: string) => void;
  onRestoredThread?: (threadId: string) => void;
  disabled?: boolean;
}

export function formatThreadTrailing(thread: ExtendedChatThread, now = Date.now()): string {
  if (thread.status === 'running') return 'Working';
  if (thread.status === 'waiting') return 'Needs you';
  if (thread.status === 'error') return 'Failed';
  const lastTime = thread.updatedAtUnixMs || thread.createdAtUnixMs || 0;
  if (!lastTime) return 'Draft';
  const elapsed = Math.max(0, now - lastTime);
  if (elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export const ChatRail: React.FC<ChatRailProps> = ({
  threads,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onPinThread,
  onArchiveThread,
  onRenameThread,
  onRestoredThread,
  disabled = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [showArchivedModal, setShowArchivedModal] = useState(false);

  const filteredThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.title?.toLowerCase().includes(q) ||
        t.provider?.toLowerCase().includes(q) ||
        t.model?.toLowerCase().includes(q)
    );
  }, [threads, searchQuery]);

  const pinnedThreads = useMemo(
    () => filteredThreads.filter((t) => t.pinned),
    [filteredThreads]
  );
  const recentThreads = useMemo(
    () => filteredThreads.filter((t) => !t.pinned),
    [filteredThreads]
  );

  const startRename = (thread: ExtendedChatThread, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(thread.id);
    setRenameInput(thread.title || '');
  };

  const handleSaveRename = (threadId: string, e: React.FormEvent) => {
    e.preventDefault();
    const clean = renameInput.trim();
    if (clean) {
      onRenameThread(threadId, clean);
    }
    setEditingId(null);
  };

  const renderThreadRow = (thread: ExtendedChatThread) => {
    const isSelected = thread.id === selectedThreadId;
    const trailingLabel = formatThreadTrailing(thread);

    if (editingId === thread.id) {
      return (
        <form
          key={thread.id}
          className="chat-rail-rename chat-rail-rename--row"
          onSubmit={(e) => handleSaveRename(thread.id, e)}
          onClick={(e) => e.stopPropagation()}
        >
          <label className="sr-only" htmlFor={`rename-${thread.id}`}>
            Thread title
          </label>
          <input
            id={`rename-${thread.id}`}
            value={renameInput}
            maxLength={1024}
            autoFocus
            onChange={(e) => setRenameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingId(null);
            }}
          />
          <button type="submit" disabled={!renameInput.trim()} aria-label="Save thread title">
            <CheckIcon size={12} />
          </button>
          <button type="button" onClick={() => setEditingId(null)} aria-label="Cancel thread rename">
            <CloseIcon size={12} />
          </button>
        </form>
      );
    }

    const dotClass =
      thread.status === 'running'
        ? 'chat-thread-row__dot chat-thread-row__dot--running'
        : thread.status === 'waiting'
        ? 'chat-thread-row__dot chat-thread-row__dot--waiting'
        : thread.status === 'error'
        ? 'chat-thread-row__dot chat-thread-row__dot--failed'
        : 'chat-thread-row__dot';

    const trailingClass =
      thread.status === 'running'
        ? 'chat-thread-row__trailing chat-thread-row__trailing--running'
        : thread.status === 'waiting'
        ? 'chat-thread-row__trailing chat-thread-row__trailing--waiting'
        : thread.status === 'error'
        ? 'chat-thread-row__trailing chat-thread-row__trailing--failed'
        : 'chat-thread-row__trailing';

    return (
      <div
        key={thread.id}
        className={`chat-thread-row ${isSelected ? 'chat-thread-row--selected' : ''}`}
        data-thread-id={thread.id}
      >
        <button
          type="button"
          aria-current={isSelected ? 'page' : undefined}
          className="chat-thread-row__select"
          onClick={() => onSelectThread(thread.id)}
          onDoubleClick={(e) => startRename(thread, e)}
          title={`${thread.title} (${thread.provider})`}
        >
          <i aria-hidden="true" className={dotClass} />
          <span className="chat-thread-row__title">{thread.title || 'Untitled'}</span>
          <span aria-hidden="true" className={trailingClass}>
            {trailingLabel}
          </span>
        </button>

        <span className="chat-thread-row__actions">
          <button
            type="button"
            aria-label={thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onPinThread(thread.id, !thread.pinned);
            }}
            title={thread.pinned ? 'Unpin' : 'Pin to Top'}
          >
            <PinIcon size={11} fill={thread.pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            aria-label={`Archive ${thread.title}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onArchiveThread(thread.id);
            }}
            title="Archive"
          >
            <ArchiveIcon size={11} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <>
      <nav aria-label="Threads" className="chat-rail">
        {/* Search / Filter input */}
        <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', gap: '6px', borderBottom: '1px solid var(--separator)' }}>
          <SearchIcon size={12} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search threads…"
            style={{ width: '100%', background: 'transparent', border: 0, outline: 'none', fontSize: 'var(--text-caption)', color: 'var(--text-primary)', padding: '2px 0' }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              <CloseIcon size={11} />
            </button>
          )}
        </div>

        {/* Empty state */}
        {threads.length === 0 ? (
          <div className="sidebar-empty sidebar-empty--chat" style={{ padding: 'var(--space-4)', textAlign: 'center' }}>
            <p style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', marginBottom: 'var(--space-3)' }}>
              Thread mode works without a folder. Add one and every thread you start there is a coding session in it.
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={onNewThread}
              disabled={disabled}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <PlusIcon size={12} strokeWidth={2.5} />
              <span>New thread</span>
            </button>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}>
            {/* Pinned Section */}
            {pinnedThreads.length > 0 && (
              <section className="chat-rail__band chat-rail__band--pinned" aria-label="Pinned threads">
                <h3 className="chat-rail__band-title">Pinned threads</h3>
                <section className="chat-thread-list" aria-label="Pinned threads">
                  {pinnedThreads.map(renderThreadRow)}
                </section>
              </section>
            )}

            {/* Recent / Other Section */}
            {recentThreads.length > 0 && (
              <section className="chat-rail__band" aria-label="Recent threads">
                {pinnedThreads.length > 0 && <h3 className="chat-rail__band-title">Recent threads</h3>}
                <section className="chat-thread-list" aria-label="Recent threads">
                  {recentThreads.map(renderThreadRow)}
                </section>
              </section>
            )}

            {filteredThreads.length === 0 && searchQuery && (
              <div style={{ padding: 'var(--space-4)', textAlign: 'center', fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>
                No threads matching "{searchQuery}"
              </div>
            )}
          </div>
        )}

        {/* Footer: Archived chats trigger */}
        <div style={{ marginTop: 'auto', padding: 'var(--space-2)', borderTop: '1px solid var(--separator)' }}>
          <button
            type="button"
            className="chat-rail__more"
            onClick={() => setShowArchivedModal(true)}
            aria-label="Archived threads"
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', background: 'none', border: 'none', borderRadius: 'var(--radius-chip)', cursor: 'pointer' }}
          >
            <ArchiveIcon size={12} />
            <span>Archived threads</span>
          </button>
        </div>
      </nav>

      {/* Archived Chats Modal */}
      {showArchivedModal && (
        <ArchivedChatsModal
          isOpen={showArchivedModal}
          onClose={() => setShowArchivedModal(false)}
          onRestored={(restoredId) => {
            setShowArchivedModal(false);
            onRestoredThread?.(restoredId);
          }}
        />
      )}
    </>
  );
};
