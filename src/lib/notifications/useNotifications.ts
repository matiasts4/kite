import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { NotificationsSnapshot, NotificationRecord } from '../../types';
import { invokeCommand } from '../ipc';
import { playCompletionChime, playApprovalChime } from './audioCues';
import { toast } from '../toast';
import {
  evaluateNotificationDelivery,
  type ActiveNotificationContext,
} from './deliveryPolicy';
import {
  getOsNotificationContent,
  resolveNotificationModule,
  type NotificationDisplayLookups,
} from './presentation';

export const NOTIFICATIONS_POLL_INTERVAL_MS = 15_000;

function isDocumentHidden(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.hidden) || document.visibilityState === 'hidden';
}

export interface UseNotificationsOptions {
  activeContext?: Omit<ActiveNotificationContext, 'isWindowFocused' | 'isWindowHidden'>;
  lookups?: NotificationDisplayLookups;
}

export interface UseNotificationsResult {
  snapshot: NotificationsSnapshot | null;
  unreadCount: number;
  openInputRequestCount: number;
  markRead: (recordId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function areNotificationsSnapshotsEqual(
  a: NotificationsSnapshot | null,
  b: NotificationsSnapshot | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.unreadCount !== b.unreadCount ||
    a.openInputRequestCount !== b.openInputRequestCount ||
    a.authorization !== b.authorization ||
    a.preferences?.osNotificationsEnabled !== b.preferences?.osNotificationsEnabled ||
    a.preferences?.finishSoundEnabled !== b.preferences?.finishSoundEnabled ||
    a.preferences?.inputRequestsEnabled !== b.preferences?.inputRequestsEnabled
  ) {
    return false;
  }
  const aRecs = a.records ?? [];
  const bRecs = b.records ?? [];
  if (aRecs.length !== bRecs.length) return false;
  for (let i = 0; i < aRecs.length; i += 1) {
    const ar = aRecs[i];
    const br = bRecs[i];
    if (
      ar.id !== br.id ||
      ar.isRead !== br.isRead ||
      ar.isWaitingForInput !== br.isWaitingForInput ||
      ar.title !== br.title ||
      ar.body !== br.body ||
      ar.actorName !== br.actorName ||
      ar.threadTitle !== br.threadTitle ||
      ar.module !== br.module ||
      ar.workspaceId !== br.workspaceId ||
      ar.resolution !== br.resolution ||
      ar.createdAtUnixMs !== br.createdAtUnixMs ||
      ar.kind?.kind !== br.kind?.kind ||
      ar.kind?.outcome !== br.kind?.outcome
    ) {
      return false;
    }
  }
  return true;
}

export function useNotifications(options?: UseNotificationsOptions): UseNotificationsResult {
  const [snapshot, setSnapshot] = useState<NotificationsSnapshot | null>(null);
  const latestSnapshotRef = useRef<NotificationsSnapshot | null>(null);
  const knownRecordIdsRef = useRef<Set<string>>(new Set());
  const activeApprovalToastsRef = useRef<
    Map<
      string,
      {
        toastId: string;
        module: ReturnType<typeof resolveNotificationModule>;
        targetId: string | null;
      }
    >
  >(new Map());
  const initialLoadDoneRef = useRef(false);

  const activeContextRef = useRef(options?.activeContext);
  activeContextRef.current = options?.activeContext;
  const lookupsRef = useRef(options?.lookups);
  lookupsRef.current = options?.lookups;

  const focusOverrideRef = useRef<boolean | null>(null);
  const tauriMinimizedRef = useRef<boolean>(false);

  const resolveWindowState = useCallback(() => {
    const domHidden = isDocumentHidden();
    const isWindowHidden = domHidden || tauriMinimizedRef.current;
    const domFocused =
      typeof document === 'undefined' || typeof document.hasFocus !== 'function'
        ? true
        : document.hasFocus();
    const isWindowFocused = isWindowHidden
      ? false
      : focusOverrideRef.current !== null
        ? focusOverrideRef.current
        : domFocused;
    return { isWindowFocused, isWindowHidden };
  }, []);

  const dismissApprovalToast = useCallback((recordId: string) => {
    const tracked = activeApprovalToastsRef.current.get(recordId);
    if (!tracked) return;
    activeApprovalToastsRef.current.delete(recordId);
    if (typeof toast.dismiss === 'function') {
      toast.dismiss(tracked.toastId);
    }
  }, []);

  const dismissToastsForActiveContext = useCallback(() => {
    const activeCtx = activeContextRef.current;
    if (!activeCtx || activeCtx.settingsOpen || activeCtx.routinesOpen) return;
    const { isWindowFocused, isWindowHidden } = resolveWindowState();
    if (!isWindowFocused || isWindowHidden) return;
    for (const [recId, entry] of Array.from(activeApprovalToastsRef.current.entries())) {
      const sameModule = entry.module !== null && entry.module === activeCtx.workMode;
      const sameThread =
        entry.targetId !== null &&
        (entry.targetId === activeCtx.selectedThreadId ||
          entry.targetId === activeCtx.selectedAgentThreadId);
      if (sameModule || sameThread) {
        dismissApprovalToast(recId);
      }
    }
  }, [dismissApprovalToast, resolveWindowState]);

  const processSnapshot = useCallback(
    (snap: NotificationsSnapshot) => {
      const soundEnabled = snap.preferences?.finishSoundEnabled ?? true;
      const { isWindowFocused, isWindowHidden } = resolveWindowState();
      const activeCtx = activeContextRef.current;
      const lookups = lookupsRef.current;

      if (Array.isArray(snap.records) && activeApprovalToastsRef.current.size > 0) {
        const recordsById = new Map<string, NotificationRecord>();
        for (const rec of snap.records as NotificationRecord[]) {
          recordsById.set(rec.id, rec);
        }
        for (const recId of Array.from(activeApprovalToastsRef.current.keys())) {
          const current = recordsById.get(recId);
          if (!current || current.isRead || current.isWaitingForInput !== true) {
            dismissApprovalToast(recId);
          }
        }
      }

      if (initialLoadDoneRef.current && Array.isArray(snap.records)) {
        for (const rec of snap.records as NotificationRecord[]) {
          if (!knownRecordIdsRef.current.has(rec.id) && !rec.isRead) {
            const deliveryContext: ActiveNotificationContext = activeCtx
              ? {
                  ...activeCtx,
                  isWindowFocused,
                  isWindowHidden,
                }
              : {
                  workMode: resolveNotificationModule(rec) ?? 'code',
                  isWindowFocused,
                  isWindowHidden,
                };

            const plan = evaluateNotificationDelivery(rec, deliveryContext, snap.preferences);

            if (plan.playSound === 'approval') {
              playApprovalChime(soundEnabled);
            } else if (plan.playSound === 'completion_success') {
              playCompletionChime(true, soundEnabled);
            } else if (plan.playSound === 'completion_error') {
              playCompletionChime(false, soundEnabled);
            }

            if (plan.showInAppToast) {
              if (rec.kind?.kind === 'needsInput') {
                const toastId = toast.agentApproval(rec, undefined, lookups);
                if (toastId) {
                  activeApprovalToastsRef.current.set(rec.id, {
                    toastId,
                    module: resolveNotificationModule(rec),
                    targetId: rec.target?.id ?? rec.runId ?? null,
                  });
                }
              } else if (rec.kind?.kind === 'settled') {
                toast.agentSettled(rec, undefined, lookups);
              }
            }

            if (plan.showOsNotification) {
              const osContent = getOsNotificationContent(rec, lookups);
              void Promise.resolve(
                invokeCommand('notifications_send_os', {
                  title: osContent.title,
                  body: osContent.body,
                  tag: rec.id,
                  silent: plan.osToastSilent,
                })
              ).catch((err) => {
                console.warn('[useNotifications] Failed to send OS notification:', err);
              });
            }
          }
        }
      }

      if (Array.isArray(snap.records)) {
        const nextIds = new Set<string>();
        for (const rec of snap.records as NotificationRecord[]) {
          nextIds.add(rec.id);
        }
        knownRecordIdsRef.current = nextIds;
      }

      initialLoadDoneRef.current = true;
      if (areNotificationsSnapshotsEqual(latestSnapshotRef.current, snap)) {
        return;
      }
      latestSnapshotRef.current = snap;
      setSnapshot(snap);
    },
    [dismissApprovalToast, resolveWindowState]
  );

  useEffect(() => {
    dismissToastsForActiveContext();
  }, [
    dismissToastsForActiveContext,
    options?.activeContext?.workMode,
    options?.activeContext?.selectedThreadId,
    options?.activeContext?.selectedAgentThreadId,
    options?.activeContext?.settingsOpen,
    options?.activeContext?.routinesOpen,
  ]);

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
        const res = await invokeCommand<NotificationsSnapshot>('notifications_mark_read', {
          recordId,
        });
        if (res) {
          processSnapshot(res);
        }
      } catch (err) {
        console.warn('[useNotifications] markRead failed, applying optimistic update:', err);
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
    } catch (err) {
      console.warn('[useNotifications] markAllRead failed, applying optimistic update:', err);
      setSnapshot((prev) => {
        if (!prev) return null;
        const updated = (prev.records || []).map((r: NotificationRecord) => ({
          ...r,
          isRead: true,
        }));
        return { ...prev, records: updated, unreadCount: 0 };
      });
    }
  }, [processSnapshot]);

  // Initial fetch, focus/visibility tracking, Tauri push sync, and fallback polling
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let wasHidden = isDocumentHidden();

    const stopPolling = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startPolling = () => {
      if (cancelled || pollTimer !== null || isDocumentHidden()) return;
      pollTimer = setInterval(() => {
        if (!cancelled && !isDocumentHidden()) {
          void refresh();
        }
      }, NOTIFICATIONS_POLL_INTERVAL_MS);
    };

    if (!wasHidden) {
      void refresh();
      startPolling();
    }

    const handleExternalRefresh = () => {
      void refresh();
    };
    const handleFocus = () => {
      tauriMinimizedRef.current = false;
      focusOverrideRef.current = true;
      dismissToastsForActiveContext();
    };
    const handleBlur = () => {
      focusOverrideRef.current = false;
    };
    const handleVisibility = () => {
      const hiddenNow = isDocumentHidden();
      if (!hiddenNow) {
        tauriMinimizedRef.current = false;
        if (wasHidden) {
          void refresh();
        }
        wasHidden = false;
        startPolling();
      } else {
        wasHidden = true;
        stopPolling();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('kite:notifications-refresh', handleExternalRefresh);
      window.addEventListener('focus', handleFocus);
      window.addEventListener('blur', handleBlur);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    const unlisteners: Array<() => void> = [];
    const registerUnlisten = (stop: () => void) => {
      if (cancelled) stop();
      else unlisteners.push(stop);
    };

    const host =
      typeof window !== 'undefined'
        ? (window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown })
        : null;
    if (host && (host.__TAURI_INTERNALS__ || host.__TAURI__)) {
      void listen<{ minimized?: boolean; focused?: boolean }>('kite:window-state', (ev) => {
        if (cancelled) return;
        tauriMinimizedRef.current = Boolean(ev.payload?.minimized);
        if (typeof ev.payload?.focused === 'boolean') {
          focusOverrideRef.current = ev.payload.focused;
        }
      })
        .then(registerUnlisten)
        .catch((err) => {
          console.warn('[useNotifications] Failed to subscribe to kite:window-state:', err);
        });

      void listen('kite://notifications-updated', () => {
        if (cancelled) return;
        void refresh();
      })
        .then(registerUnlisten)
        .catch((err) => {
          console.warn(
            '[useNotifications] Failed to subscribe to kite://notifications-updated:',
            err
          );
        });
    }

    return () => {
      cancelled = true;
      stopPolling();
      for (const stop of unlisteners) {
        stop();
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('kite:notifications-refresh', handleExternalRefresh);
        window.removeEventListener('focus', handleFocus);
        window.removeEventListener('blur', handleBlur);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
      for (const entry of activeApprovalToastsRef.current.values()) {
        if (typeof toast.dismiss === 'function') {
          toast.dismiss(entry.toastId);
        }
      }
      activeApprovalToastsRef.current.clear();
    };
  }, [dismissToastsForActiveContext, refresh]);

  return {
    snapshot,
    unreadCount: snapshot?.unreadCount ?? 0,
    openInputRequestCount: snapshot?.openInputRequestCount ?? 0,
    markRead,
    markAllRead,
    refresh,
  };
}
