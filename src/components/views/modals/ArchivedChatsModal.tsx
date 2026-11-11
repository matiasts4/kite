import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  listArchivedChats,
  restoreArchivedChat,
  purgeArchivedChat,
  type ArchivedChatSummary,
} from '../../../lib/ipc';
import { Sheet } from '../../ui/Sheet';
import { BrandLogo } from '../../ui/BrandLogo';
import './archivedChats.css';

export type { ArchivedChatSummary };

export interface ArchivedChatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  profileId?: string | null;
  onRestored?: (threadId: string) => void;
}

const SearchIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const RefreshIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

const TrashIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const ArchiveEmptyIcon: React.FC<{ size?: number; className?: string }> = ({ size = 20, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="4" rx="2" />
    <path d="M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </svg>
);

const CloseIcon: React.FC<{ size?: number; className?: string }> = ({ size = 11, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

function formatArchiveDate(unixMs: number): string {
  if (!unixMs) return '';
  const date = new Date(unixMs);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function formatExpiry(expiresAtUnixMs: number): { text: string; isExpired: boolean } {
  const diffMs = expiresAtUnixMs - Date.now();
  if (diffMs <= 0) {
    return { text: 'Expired', isExpired: true };
  }
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 1) {
    return { text: 'Expires today', isExpired: false };
  }
  return { text: `Expires in ${days} days`, isExpired: false };
}

export const ArchivedChatsModal: React.FC<ArchivedChatsModalProps> = ({
  isOpen,
  onClose,
  profileId = null,
  onRestored,
}) => {
  const [chats, setChats] = useState<ArchivedChatSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ArchivedChatSummary | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const reqSeqRef = useRef<number>(0);

  const fetchArchived = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    setConfirmDelete(null);

    try {
      const results = await listArchivedChats(profileId);
      if (reqSeqRef.current === seq) {
        setChats(results);
      }
    } catch (err: unknown) {
      if (reqSeqRef.current === seq) {
        console.error('[ArchivedChatsModal] list_archived_chats error:', err);
        setError('Archived chats could not be loaded. Try again.');
      }
    } finally {
      if (reqSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }, [profileId]);

  useEffect(() => {
    if (isOpen) {
      void fetchArchived();
    } else {
      setChats([]);
      setError(null);
      setConfirmDelete(null);
      setBusy(false);
      setSearchQuery('');
    }
  }, [isOpen, refreshKey, fetchArchived]);

  const handleRestore = async (chat: ArchivedChatSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await restoreArchivedChat(chat.id, chat.profileId);
      setChats((prev) => prev.filter((c) => c.id !== chat.id));
      if (confirmDelete?.id === chat.id) setConfirmDelete(null);
      window.dispatchEvent(new CustomEvent('kite:threads-changed'));
      if (onRestored) {
        onRestored(chat.id);
      }
    } catch (err: unknown) {
      console.error('[ArchivedChatsModal] restore error:', err);
      setError('The chat could not be restored. It may have expired. Refresh and try again.');
    } finally {
      setBusy(false);
    }
  };

  const handlePurge = async (chat: ArchivedChatSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await purgeArchivedChat(chat.id, chat.profileId);
      setChats((prev) => prev.filter((c) => c.id !== chat.id));
      setConfirmDelete(null);
      window.dispatchEvent(new CustomEvent('kite:threads-changed'));
    } catch (err: unknown) {
      console.error('[ArchivedChatsModal] purge error:', err);
      setError('The chat could not be deleted permanently. Refresh and try again.');
    } finally {
      setBusy(false);
    }
  };

  const filteredChats = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.provider ?? '').toLowerCase().includes(q) ||
        (c.model ?? '').toLowerCase().includes(q)
    );
  }, [chats, searchQuery]);

  return (
    <Sheet
      open={isOpen}
      title="Archived chats"
      description="Archived conversations are retained for 30 days before being permanently removed."
      width={580}
      onCancel={onClose}
      secondary={{
        label: 'Done',
        onClick: onClose,
        disabled: busy,
      }}
    >
      <div className="archived-chats">
        {error && (
          <div className="ui-status-notice ui-status-notice--warning rounded-control" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              <RefreshIcon size={12} />
              <span>Retry</span>
            </button>
          </div>
        )}

        <div className="archived-chats__header-bar">
          <div className="archived-chats__search-wrapper">
            <span className="archived-chats__search-icon" aria-hidden="true">
              <SearchIcon size={13} />
            </span>
            <input
              type="search"
              className="archived-chats__search-input"
              placeholder="Search archived chats…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search archived chats"
            />
            {searchQuery && (
              <button
                type="button"
                className="archived-chats__search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search query"
              >
                <CloseIcon size={10} />
              </button>
            )}
          </div>

          <button
            type="button"
            className="secondary-button archived-chats__refresh-btn"
            disabled={loading || busy}
            onClick={() => setRefreshKey((k) => k + 1)}
            title="Refresh archived chats list"
            aria-label="Refresh list"
          >
            <RefreshIcon size={12} />
            <span>Refresh</span>
          </button>

          {chats.length > 0 && (
            <span className="archived-chats__count-pill" aria-label={`${chats.length} archived chats`}>
              {searchQuery ? `${filteredChats.length} of ${chats.length}` : `${chats.length} chats`}
            </span>
          )}
        </div>

        {loading ? (
          <div className="archived-chats__empty" role="status">
            <p className="archived-chats__empty-desc">Loading archived conversations…</p>
          </div>
        ) : chats.length === 0 && !error ? (
          <div className="archived-chats__empty">
            <div className="archived-chats__empty-icon" aria-hidden="true">
              <ArchiveEmptyIcon size={20} />
            </div>
            <h4 className="archived-chats__empty-title">No archived conversations</h4>
            <p className="archived-chats__empty-desc">
              Conversations you archive will appear here and can be restored at any time within 30 days.
            </p>
          </div>
        ) : filteredChats.length === 0 ? (
          <div className="archived-chats__empty">
            <h4 className="archived-chats__empty-title">No matching conversations</h4>
            <p className="archived-chats__empty-desc">
              No archived conversations match &ldquo;{searchQuery}&rdquo;.
            </p>
          </div>
        ) : (
          <ul className="archived-chats__list" aria-label="Archived conversations list">
            {filteredChats.map((chat) => {
              const expiry = formatExpiry(chat.expiresAtUnixMs);
              const archiveDate = formatArchiveDate(chat.archivedAtUnixMs);

              return (
                <li key={chat.id} className="archived-chats__item">
                  <div className="archived-chats__item-main">
                    <div className="archived-chats__item-title-row">
                      <BrandLogo
                        engine={chat.provider || 'antigravity'}
                        size={14}
                        className="archived-chats__item-logo"
                      />
                      <span className="archived-chats__item-title" title={chat.title}>
                        {chat.title}
                      </span>
                    </div>
                    <div className="archived-chats__item-meta">
                      {archiveDate && <span>Archived {archiveDate}</span>}
                      {archiveDate && <span className="archived-chats__item-meta-dot" aria-hidden="true">·</span>}
                      <span
                        className={`archived-chats__expiry-badge${
                          expiry.isExpired ? ' archived-chats__expiry-badge--expired' : ''
                        }`}
                      >
                        {expiry.text}
                      </span>
                      {chat.model && (
                        <>
                          <span className="archived-chats__item-meta-dot" aria-hidden="true">·</span>
                          <span className="archived-chats__model-tag">{chat.model}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="archived-chats__item-actions">
                    <button
                      type="button"
                      className="secondary-button archived-chats__restore-btn"
                      disabled={busy}
                      aria-label={`Restore ${chat.title}`}
                      onClick={() => void handleRestore(chat)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="chrome-button archived-chats__delete-btn"
                      disabled={busy}
                      aria-label={`Delete ${chat.title} permanently`}
                      onClick={() => setConfirmDelete(chat)}
                      title="Delete permanently"
                    >
                      <TrashIcon size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {confirmDelete && (
          <div className="archived-chats__confirm-box" role="alertdialog" aria-label="Confirm permanent deletion">
            <p className="archived-chats__confirm-prompt">
              Permanently delete &ldquo;{confirmDelete.title}&rdquo;? This conversation will be removed forever and cannot be restored.
            </p>
            <div className="archived-chats__confirm-actions">
              <button
                type="button"
                className="secondary-button"
                style={{ height: '28px', padding: '0 12px' }}
                disabled={busy}
                onClick={() => setConfirmDelete(null)}
              >
                Keep conversation
              </button>
              <button
                type="button"
                className="primary-button"
                style={{
                  height: '28px',
                  padding: '0 12px',
                  background: 'var(--status-failed)',
                  borderColor: 'var(--status-failed)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
                disabled={busy}
                onClick={() => void handlePurge(confirmDelete)}
              >
                <TrashIcon size={12} />
                <span>{busy ? 'Deleting…' : 'Delete permanently'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default ArchivedChatsModal;
