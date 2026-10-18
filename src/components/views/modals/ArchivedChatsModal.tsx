import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import { Sheet } from '../../ui/Sheet';

export interface ArchivedChatSummary {
  schemaVersion?: number;
  id: string;
  profileId: string | null;
  title: string;
  revision: number;
  archivedAtUnixMs: number;
  expiresAtUnixMs: number;
}

export interface ArchivedChatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  profileId?: string | null;
  onRestored?: (threadId: string) => void;
}

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
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const reqSeqRef = useRef<number>(0);

  const fetchArchived = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    setConfirmDelete(null);

    try {
      const payload = profileId ? { profileId } : {};
      const results = await invokeCommand<ArchivedChatSummary[]>('list_archived_chats', payload);
      if (reqSeqRef.current === seq) {
        setChats(Array.isArray(results) ? results : []);
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
    }
  }, [isOpen, refreshKey, fetchArchived]);

  const handleRestore = async (chat: ArchivedChatSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invokeCommand<void>('restore_archived_chat', {
        threadId: chat.id,
        profileId: chat.profileId,
      });
      setChats((prev) => prev.filter((c) => c.id !== chat.id));
      if (confirmDelete?.id === chat.id) setConfirmDelete(null);
      if (onRestored) {
        onRestored(chat.id);
      }
    } catch (err: unknown) {
      console.error('[ArchivedChatsModal] restore error:', err);
      setError('The chat could not be changed. It may have changed or expired. Refresh and try again.');
    } finally {
      setBusy(false);
    }
  };

  const handlePurge = async (chat: ArchivedChatSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invokeCommand<void>('purge_archived_chat', {
        threadId: chat.id,
        profileId: chat.profileId,
      });
      setChats((prev) => prev.filter((c) => c.id !== chat.id));
      setConfirmDelete(null);
    } catch (err: unknown) {
      console.error('[ArchivedChatsModal] purge error:', err);
      setError('The chat could not be changed. It may have changed or expired. Refresh and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={isOpen}
      title="Archived chats"
      description="Archived conversations can be restored for 30 days."
      width={560}
      onCancel={onClose}
      secondary={{
        label: 'Done',
        onClick: onClose,
        disabled: busy,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && (
          <div className="ui-status-notice ui-status-notice--warning" role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{error}</span>
            <button
              type="button"
              className="secondary-button"
              style={{ height: '26px', fontSize: 'var(--text-meta)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              disabled={busy}
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              <RefreshIcon size={12} />
              <span>Refresh</span>
            </button>
          </div>
        )}

        {loading ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', padding: '24px 0', textAlign: 'center', margin: 0 }} role="status">
            Loading archived chats…
          </p>
        ) : chats.length === 0 && !error ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', padding: '24px 0', textAlign: 'center', margin: 0 }}>
            No archived chats. Conversations you archive will appear here for 30 days.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '50vh', overflowY: 'auto' }}>
            {chats.map((chat) => (
              <li
                key={chat.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-row)',
                  background: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                }}
              >
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <strong style={{ fontSize: 'var(--text-row)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)', display: 'block', wordBreak: 'break-word' }}>
                    {chat.title}
                  </strong>
                  <p style={{ fontSize: 'var(--text-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                    Expires {new Date(chat.expiresAtUnixMs).toLocaleDateString()}
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <button
                    type="button"
                    className="secondary-button"
                    style={{ height: '26px', fontSize: 'var(--text-meta)', padding: '0 10px' }}
                    disabled={busy}
                    aria-label={`Restore ${chat.title}`}
                    onClick={() => void handleRestore(chat)}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="chrome-button"
                    style={{ height: '26px', fontSize: 'var(--text-meta)', color: 'var(--status-failed)', padding: '0 8px' }}
                    disabled={busy}
                    aria-label={`Delete ${chat.title} permanently`}
                    onClick={() => setConfirmDelete(chat)}
                  >
                    Delete permanently…
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {confirmDelete && (
          <fieldset
            style={{
              padding: '14px',
              borderRadius: 'var(--radius-row)',
              border: '1px solid rgba(248, 81, 73, 0.4)',
              background: 'rgba(248, 81, 73, 0.1)',
              fontSize: 'var(--text-caption)',
              margin: 0,
            }}
            aria-label="Confirm permanent deletion"
          >
            <p style={{ margin: 0, color: 'var(--text-primary)', fontWeight: 'var(--weight-medium)' }}>
              Permanently delete &ldquo;{confirmDelete.title}&rdquo;? This cannot be undone.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
              <button
                type="button"
                className="secondary-button"
                style={{ height: '26px', fontSize: 'var(--text-meta)', padding: '0 10px' }}
                disabled={busy}
                onClick={() => setConfirmDelete(null)}
              >
                Keep chat
              </button>
              <button
                type="button"
                className="primary-button"
                style={{
                  height: '26px',
                  fontSize: 'var(--text-meta)',
                  padding: '0 10px',
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
          </fieldset>
        )}
      </div>
    </Sheet>
  );
};

export default ArchivedChatsModal;
