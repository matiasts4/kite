import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listAllSubagentRuns,
  type GlobalSubagentEntry,
  type GlobalSubagentRunsSnapshot,
} from '../../../lib/ipc/chat';
import type { ChatSubagentEventPayload } from '../chat/hooks/useSubagentEvents';
import { runStatusPriority } from './subagentInspectorHelpers';

const EMPTY_SNAPSHOT: GlobalSubagentRunsSnapshot = {
  runs: [],
  totalCount: 0,
  activeCount: 0,
  waitingCount: 0,
};

function recomputeSnapshotStats(entries: GlobalSubagentEntry[]): GlobalSubagentRunsSnapshot {
  let activeCount = 0;
  let waitingCount = 0;
  for (const entry of entries) {
    const p = runStatusPriority(entry.run.status, entry.hasPendingApproval);
    if (p === 0) {
      waitingCount += 1;
      activeCount += 1;
    } else if (p === 1) {
      activeCount += 1;
    }
  }
  return {
    runs: entries,
    totalCount: entries.length,
    activeCount,
    waitingCount,
  };
}

function patchGlobalEntries(
  snapshot: GlobalSubagentRunsSnapshot,
  payload: ChatSubagentEventPayload,
): { next: GlobalSubagentRunsSnapshot; matched: boolean } {
  if (!payload.threadId) return { next: snapshot, matched: false };

  let matched = false;
  const updated = snapshot.runs.map((entry) => {
    if (entry.threadId !== payload.threadId) return entry;

    if (payload.kind === 'subagentRunUpdated' && payload.run) {
      const incoming = payload.run;
      if (
        entry.run.subagentId === incoming.subagentId ||
        (incoming.parentToolCallId &&
          entry.run.parentToolCallId === incoming.parentToolCallId) ||
        (incoming.childThreadId && entry.run.childThreadId === incoming.childThreadId)
      ) {
        matched = true;
        return {
          ...entry,
          run: {
            ...entry.run,
            ...incoming,
            items: [],
          },
        };
      }
    }

    if (payload.kind === 'subagentStepsUpdated' && payload.subagentId) {
      if (
        entry.run.subagentId === payload.subagentId ||
        entry.run.parentToolCallId === payload.subagentId ||
        (payload.childThreadId && entry.run.childThreadId === payload.childThreadId)
      ) {
        matched = true;
        return {
          ...entry,
          run: {
            ...entry.run,
            status: payload.status ?? entry.run.status,
            stepCount: Math.max(entry.run.stepCount ?? 0, payload.stepCount ?? 0),
            latestActivity:
              payload.latestActivity !== undefined
                ? payload.latestActivity
                : entry.run.latestActivity,
            model: payload.model ?? entry.run.model,
            provider: payload.provider ?? entry.run.provider,
            updatedAtUnixMs: payload.updatedAtUnixMs ?? entry.run.updatedAtUnixMs,
          },
        };
      }
    }

    return entry;
  });

  if (!matched) {
    return { next: snapshot, matched: false };
  }
  return { next: recomputeSnapshotStats(updated), matched: true };
}

/** Loads and live-syncs subagent runs across all non-archived threads. */
export function useGlobalSubagents() {
  const [snapshot, setSnapshot] = useState<GlobalSubagentRunsSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const refreshTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (typeof listAllSubagentRuns !== 'function') return;
    try {
      const next = await listAllSubagentRuns({ limit: 120 });
      if (mountedRef.current && next) {
        setSnapshot(next);
      }
    } catch {
      // Non-fatal in unit tests or transient reloads.
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh();
    }, 150);
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    if (typeof listAllSubagentRuns === 'function') {
      setLoading(true);
      void listAllSubagentRuns({ limit: 120 })
        .then((next) => {
          if (!cancelled && mountedRef.current && next) {
            setSnapshot(next);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled && mountedRef.current) {
            setLoading(false);
          }
        });
    }

    const onThreadsChanged = () => {
      scheduleRefresh();
    };
    window.addEventListener('kite:threads-changed', onThreadsChanged);

    let unlistenSub: (() => void) | undefined;
    let unlistenSwarm: (() => void) | undefined;
    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const stopSub = await listen<ChatSubagentEventPayload>('chat-subagent-event', (ev) => {
            const payload = ev.payload;
            if (!payload || !mountedRef.current) return;
            setSnapshot((prev) => {
              const { next, matched } = patchGlobalEntries(prev, payload);
              if (!matched || payload.kind === 'subagentRunUpdated') {
                scheduleRefresh();
              }
              return next;
            });
          });
          if (cancelled) {
            stopSub();
            return;
          }
          unlistenSub = stopSub;

          const stopSwarm = await listen<ChatSubagentEventPayload>('chat-swarm-event', () => {
            scheduleRefresh();
          });
          if (cancelled) {
            stopSwarm();
            return;
          }
          unlistenSwarm = stopSwarm;
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
      mountedRef.current = false;
      window.removeEventListener('kite:threads-changed', onThreadsChanged);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unlistenSub?.();
      unlistenSwarm?.();
    };
  }, [refresh, scheduleRefresh]);

  return {
    snapshot,
    loading,
    refresh,
  };
}
