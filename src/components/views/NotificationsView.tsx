import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { NotificationsSnapshot } from '../../types';
import { invokeCommand } from '../../lib/ipc';
import './notifications.css';

export interface NotificationsViewProps {
  onUnreadCountChange?: (count: number) => void;
  onNavigateAgent?: (agentId: string) => void;
  onNavigateMode?: (mode: 'agent' | 'code' | 'chat') => void;
  onClose?: () => void;
  onOpenSettings?: () => void;
}

export interface NotificationRecord {
  id: string;
  runId?: string;
  target?: {
    source: 'agentChat' | 'codeThread' | 'codeTerminal' | 'task' | string;
    id: string;
  };
  profileId?: string | null;
  routineId?: string | null;
  kind?: {
    kind: 'settled' | 'needsInput' | string;
    outcome?: 'completed' | 'failed' | 'cancelled' | string;
    requestKind?: 'toolApproval' | 'question' | 'unknown' | string;
  };
  resolution?: 'answered' | 'attended' | 'runSettled' | 'abandoned' | string | null;
  createdAtUnixMs: number;
  isRead: boolean;
  isWaitingForInput?: boolean;
}

const DISMISSED_STORAGE_KEY = 'kite_dismissed_notifications';

function getDismissedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (_) {}
  return new Set();
}

// Relative time formatting
function formatPlural(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSec < 1) return 'now';
  if (diffSec < 60) return `${diffSec} sec`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    const remMin = diffMin % 60;
    return remMin > 0 ? `${diffHr} hr, ${remMin} min` : `${diffHr} hr`;
  }
  const diffDays = Math.floor(diffHr / 24);
  const remHr = diffHr % 24;
  return remHr > 0 ? `${formatPlural(diffDays, 'day', 'days')}, ${remHr} hr` : formatPlural(diffDays, 'day', 'days');
}

function getActorName(rec: NotificationRecord): string {
  if (rec.routineId) return 'Routine Automation';
  if (rec.target?.source === 'agentChat') return 'Agent chat';
  if (rec.target?.source === 'codeThread') return 'Code thread';
  if (rec.target?.source === 'codeTerminal') return 'Terminal runner';
  if (rec.target?.source === 'task') return 'Background task';
  return 'Kite';
}

function getDetailMessage(rec: NotificationRecord): string {
  const kind = rec.kind;
  if (!kind) return 'System notice updated.';
  if (kind.kind === 'needsInput') {
    const isWaiting = rec.isWaitingForInput ?? !rec.isRead;
    switch (kind.requestKind) {
      case 'toolApproval':
        return isWaiting ? 'Waiting for your approval' : 'Asked for your approval';
      case 'question':
        return isWaiting ? 'Waiting on your answer' : 'Asked you a question';
      case 'unknown':
      default:
        return isWaiting ? 'Waiting for your input' : 'Asked for your input';
    }
  }
  if (kind.kind === 'settled') {
    if (kind.outcome === 'failed') return 'needs attention';
    if (kind.outcome === 'cancelled') return 'cancelled';
    if (rec.target?.source === 'codeThread') return 'Code thread closed';
    return 'finished';
  }
  return 'System notification record.';
}

function isWaitingForInput(rec: NotificationRecord): boolean {
  return rec.isWaitingForInput === true || (rec.kind?.kind === 'needsInput' && !rec.isRead);
}

// SVG icon definitions
const HandIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 15, strokeWidth = 1.8 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
    <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
    <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </svg>
);

const CircleAlertIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 15, strokeWidth = 1.8 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </svg>
);

const CircleCheckIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 15, strokeWidth = 1.8 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const BellIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 24, strokeWidth = 1.4 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

const SettingsIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 14, strokeWidth = 1.8 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  onUnreadCountChange,
  onNavigateAgent,
  onNavigateMode,
  onClose: _onClose,
  onOpenSettings,
}) => {
  const [snapshot, setSnapshot] = useState<NotificationsSnapshot | null>(null);
  const [dismissedIds] = useState<Set<string>>(() => getDismissedSet());

  const syncSnapshot = useCallback(
    (snap: NotificationsSnapshot) => {
      const dismissed = getDismissedSet();
      const filteredRecords = (snap.records || []).filter(
        (r: NotificationRecord) => !dismissed.has(r.id)
      );
      const unreadCount = filteredRecords.filter((r: NotificationRecord) => !r.isRead).length;
      const waitingCount = filteredRecords.filter(isWaitingForInput).length;

      const cleanSnapshot: NotificationsSnapshot = {
        ...snap,
        records: filteredRecords,
        unreadCount,
        openInputRequestCount: waitingCount,
      };

      setSnapshot(cleanSnapshot);
      if (onUnreadCountChange) {
        onUnreadCountChange(unreadCount);
      }
    },
    [onUnreadCountChange]
  );

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await invokeCommand<NotificationsSnapshot>('notifications_snapshot');
      if (res) syncSnapshot(res);
    } catch (err) {
      console.warn('[NotificationsView] Error loading snapshot:', err);
    }
  }, [syncSnapshot]);

  useEffect(() => {
    loadSnapshot();
    const interval = setInterval(() => {
      void invokeCommand<NotificationsSnapshot>('notifications_poll')
        .then((res) => {
          if (res) syncSnapshot(res);
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [loadSnapshot, syncSnapshot]);

  const handleMarkRead = async (recordId: string) => {
    try {
      const res = await invokeCommand<NotificationsSnapshot>('notifications_mark_read', { recordId });
      if (res) syncSnapshot(res);
    } catch {
      // Optimistic fallback
      setSnapshot((prev) => {
        if (!prev) return null;
        const updated = (prev.records || []).map((r: NotificationRecord) =>
          r.id === recordId ? { ...r, isRead: true } : r
        );
        const unread = updated.filter((r: NotificationRecord) => !r.isRead).length;
        if (onUnreadCountChange) onUnreadCountChange(unread);
        return { ...prev, records: updated, unreadCount: unread };
      });
    }
  };

  const handleMarkAllRead = async () => {
    try {
      const res = await invokeCommand<NotificationsSnapshot>('notifications_mark_all_read');
      if (res) syncSnapshot(res);
    } catch {
      // Optimistic fallback
      setSnapshot((prev) => {
        if (!prev) return null;
        const updated = (prev.records || []).map((r: NotificationRecord) => ({ ...r, isRead: true }));
        if (onUnreadCountChange) onUnreadCountChange(0);
        return { ...prev, records: updated, unreadCount: 0 };
      });
    }
  };

  const handleRowClick = (rec: NotificationRecord) => {
    if (!rec.isRead) {
      handleMarkRead(rec.id);
    }
    if (rec.target?.source === 'agentChat' && rec.profileId && onNavigateAgent) {
      onNavigateAgent(rec.profileId);
    } else if (
      (rec.target?.source === 'codeThread' || rec.target?.source === 'codeTerminal') &&
      onNavigateMode
    ) {
      onNavigateMode('code');
    }
  };

  const handleSettingsClick = () => {
    if (onOpenSettings) {
      onOpenSettings();
    }
  };

  // Grouping into 'Needs you', 'Today', and 'Earlier'
  const groupedSections = useMemo(() => {
    const records = ((snapshot?.records || []) as NotificationRecord[]).filter(
      (r) => !dismissedIds.has(r.id)
    );

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayMs = startOfToday.getTime();

    const needsYou = records.filter(isWaitingForInput);
    const notWaiting = records.filter((r) => !isWaitingForInput(r));
    const today = notWaiting.filter((r) => r.createdAtUnixMs >= startOfTodayMs);
    const earlier = notWaiting.filter((r) => r.createdAtUnixMs < startOfTodayMs);

    return [
      { title: 'Needs you', isNeedsYou: true, records: needsYou },
      { title: 'Today', isNeedsYou: false, records: today },
      { title: 'Earlier', isNeedsYou: false, records: earlier },
    ].filter((g) => g.records.length > 0);
  }, [snapshot, dismissedIds]);

  const allRecords = useMemo(
    () => ((snapshot?.records || []) as NotificationRecord[]).filter((r) => !dismissedIds.has(r.id)),
    [snapshot, dismissedIds]
  );

  const unreadCount = snapshot?.unreadCount ?? allRecords.filter((r) => !r.isRead).length;

  const renderIcon = (rec: NotificationRecord) => {
    if (rec.kind?.kind === 'needsInput') {
      return <HandIcon size={15} strokeWidth={1.8} />;
    }
    if (rec.kind?.kind === 'settled' && rec.kind.outcome === 'failed') {
      return <CircleAlertIcon size={15} strokeWidth={1.8} />;
    }
    return <CircleCheckIcon size={15} strokeWidth={1.8} />;
  };

  const getIconClass = (rec: NotificationRecord) => {
    if (rec.kind?.kind === 'needsInput') {
      return isWaitingForInput(rec)
        ? 'notification-row__icon--waiting'
        : 'notification-row__icon--quiet';
    }
    if (rec.kind?.kind === 'settled' && rec.kind.outcome === 'failed') {
      return 'notification-row__icon--failed';
    }
    return 'notification-row__icon--done';
  };

  return (
    <div className="notification-center">
      {/* Notifications Header */}
      <header className="notification-center__header">
        <strong>Notifications</strong>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            className="notification-center__mark-read"
          >
            Mark all read
          </button>
        )}
      </header>

      <div className="notification-center__divider" />

      {/* Notifications List or Empty State */}
      {allRecords.length === 0 ? (
        <div className="notification-center__empty">
          <BellIcon aria-hidden="true" size={24} strokeWidth={1.4} />
          <strong>No notifications yet</strong>
          <p>Agent updates land here when work finishes or an agent needs you.</p>
        </div>
      ) : (
        <div className="notification-center__list scroll-quiet">
          {groupedSections.map((group) => (
            <section key={group.title}>
              <h2
                className={`ui-eyebrow notification-center__section${
                  group.isNeedsYou ? ' notification-center__section--needs-you' : ''
                }`}
              >
                {group.title}
              </h2>

              {group.records.map((rec) => {
                const actor = getActorName(rec);
                const detail = getDetailMessage(rec);
                const statusStr = isWaitingForInput(rec) ? 'unanswered' : rec.isRead ? 'read' : 'unread';

                return (
                  <button
                    key={rec.id}
                    aria-label={`${actor}, ${detail}, ${statusStr}`}
                    className="notification-row"
                    onClick={() => handleRowClick(rec)}
                    type="button"
                  >
                    <span className={`notification-row__icon ${getIconClass(rec)}`}>
                      {renderIcon(rec)}
                    </span>

                    <span className="notification-row__copy">
                      <span className="notification-row__topline">
                        <span
                          className={
                            rec.isRead
                              ? 'notification-row__actor'
                              : 'notification-row__actor notification-row__actor--unread'
                          }
                        >
                          {actor}
                        </span>
                        <time dateTime={new Date(rec.createdAtUnixMs).toISOString()}>
                          {formatRelativeTime(rec.createdAtUnixMs)}
                        </time>
                      </span>
                      <span className="notification-row__detail">{detail}</span>
                    </span>

                    {!rec.isRead && (
                      <span aria-hidden="true" className="notification-row__unread" />
                    )}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}

      <div className="notification-center__divider" />

      {/* Footer Settings Button */}
      <button
        className="notification-center__settings"
        onClick={handleSettingsClick}
        type="button"
      >
        <SettingsIcon aria-hidden="true" size={13} strokeWidth={1.8} />
        Notification settings…
      </button>
    </div>
  );
};
