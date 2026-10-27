import { useState, useEffect, useCallback, useRef } from 'react';
import type { NotificationsSnapshot, NotificationRecord } from '../../types';
import { invokeCommand } from '../ipc';
import { playCompletionChime, playApprovalChime } from './audioCues';
import { toast } from '../toast';

export interface UseNotificationsResult {
  snapshot: NotificationsSnapshot | null;
  unreadCount: number;
  openInputRequestCount: number;
  markRead: (recordId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useNotifications(): UseNotificationsResult {
  const [snapshot, setSnapshot] = useState<NotificationsSnapshot | null>(null);
  const knownRecordIdsRef = useRef<Set<string>>(new Set());
  const initialLoadDoneRef = useRef(false);

  const processSnapshot = useCallback((snap: NotificationsSnapshot) => {
    const soundEnabled = snap.preferences?.finishSoundEnabled ?? true;

    // Check for newly arrived unread notifications to trigger audio cue and ambient toast
    if (initialLoadDoneRef.current && Array.isArray(snap.records)) {
      for (const rec of snap.records as NotificationRecord[]) {
        if (!knownRecordIdsRef.current.has(rec.id) && !rec.isRead) {
          if (rec.kind?.kind === 'needsInput' && rec.isWaitingForInput) {
            playApprovalChime(soundEnabled);
            toast.agentApproval(rec);
          } else if (rec.kind?.kind === 'settled') {
            playCompletionChime(rec.kind.outcome !== 'failed', soundEnabled);
            toast.agentSettled(rec);
          }
        }
      }
    }

    // Update known set
    if (Array.isArray(snap.records)) {
      const nextIds = new Set<string>();
      for (const rec of snap.records as NotificationRecord[]) {
        nextIds.add(rec.id);
      }
      knownRecordIdsRef.current = nextIds;
    }

    initialLoadDoneRef.current = true;
    setSnapshot(snap);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await invokeCommand<NotificationsSnapshot>('notifications_poll');
      if (res) {
        processSnapshot(res);
      }
    } catch (err) {
      console.warn('[useNotifications] Poll error:', err);
    }
  }, [processSnapshot]);

  const markRead = useCallback(
    async (recordId: string) => {
      try {
        const res = await invokeCommand<NotificationsSnapshot>('notifications_mark_read', { recordId });
        if (res) {
          processSnapshot(res);
        }
      } catch {
        // Optimistic update
        setSnapshot((prev) => {
          if (!prev) return null;
          const updated = (prev.records || []).map((r: NotificationRecord) =>
            r.id === recordId ? { ...r, isRead: true } : r
          );
          const unread = updated.filter((r: NotificationRecord) => !r.isRead).length;
          return { ...prev, records: updated, unreadCount: unread };
        });
      }
    },
    [processSnapshot]
  );

  const markAllRead = useCallback(async () => {
    try {
      const res = await invokeCommand<NotificationsSnapshot>('notifications_mark_all_read');
      if (res) {
        processSnapshot(res);
      }
    } catch {
      // Optimistic update
      setSnapshot((prev) => {
        if (!prev) return null;
        const updated = (prev.records || []).map((r: NotificationRecord) => ({ ...r, isRead: true }));
        return { ...prev, records: updated, unreadCount: 0 };
      });
    }
  }, [processSnapshot]);

  // Initial fetch and focus-aware polling
  useEffect(() => {
    void refresh();

    const interval = setInterval(() => {
      // Only poll when the window is focused (or every 15s if blurred)
      const isFocused = typeof document !== 'undefined' ? document.hasFocus() : true;
      if (isFocused) {
        void refresh();
      }
    }, 4000);

    const blurredInterval = setInterval(() => {
      const isFocused = typeof document !== 'undefined' ? document.hasFocus() : true;
      if (!isFocused) {
        void refresh();
      }
    }, 15000);

    return () => {
      clearInterval(interval);
      clearInterval(blurredInterval);
    };
  }, [refresh]);

  return {
    snapshot,
    unreadCount: snapshot?.unreadCount ?? 0,
    openInputRequestCount: snapshot?.openInputRequestCount ?? 0,
    markRead,
    markAllRead,
    refresh,
  };
}
