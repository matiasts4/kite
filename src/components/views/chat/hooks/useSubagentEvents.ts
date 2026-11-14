import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ChatItem, SubagentRun, SwarmState } from '../../../../types';
import type { ExtendedChatThread } from '../types';

export type ChatSubagentEventPayload =
  | {
      kind: 'subagentRunUpdated';
      threadId: string;
      subagentId?: string;
      run?: SubagentRun;
    }
  | {
      kind: 'subagentStepsUpdated';
      threadId: string;
      subagentId: string;
      childThreadId?: string | null;
      role?: string | null;
      model?: string | null;
      provider?: string | null;
      items?: ChatItem[];
      stepCount?: number;
      latestActivity?: string | null;
      status?: string;
      updatedAtUnixMs?: number;
    }
  | {
      kind: 'swarmStateUpdated';
      threadId: string;
      swarmState: SwarmState;
    };

function mergeRunItems(existing: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  const byId = new Map<string, number>();
  const next = existing.map((item, idx) => {
    byId.set(item.id, idx);
    return item;
  });
  for (const item of incoming) {
    const idx = byId.get(item.id);
    if (idx !== undefined) {
      next[idx] = { ...next[idx], ...item };
    } else {
      byId.set(item.id, next.length);
      next.push(item);
    }
  }
  return next;
}

/**
 * Returns whether a subagent or swarm event introduces or updates child thread
 * lifecycle state that the sidebar and known-threads summary list should sync.
 */
export function shouldDispatchThreadsChanged(
  payload: ChatSubagentEventPayload | undefined
): boolean {
  if (!payload?.threadId) return false;
  if (payload.kind === 'subagentRunUpdated' || payload.kind === 'swarmStateUpdated') {
    return true;
  }
  return (
    payload.kind === 'subagentStepsUpdated' &&
    Boolean(payload.status || payload.childThreadId)
  );
}

export function applySubagentEvent(
  thread: ExtendedChatThread,
  payload: ChatSubagentEventPayload
): ExtendedChatThread {
  if (!payload || payload.threadId !== thread.id) return thread;

  if (payload.kind === 'swarmStateUpdated' && payload.swarmState) {
    return {
      ...thread,
      swarmId: payload.swarmState.swarmId || thread.swarmId || null,
      swarmState: payload.swarmState,
    };
  }

  if (payload.kind === 'subagentRunUpdated' && payload.run) {
    const existingRuns = thread.subagentRuns ?? [];
    const idx = existingRuns.findIndex(
      (r) =>
        r.subagentId === payload.run!.subagentId ||
        (payload.run!.parentToolCallId && r.parentToolCallId === payload.run!.parentToolCallId)
    );
    const mergedRuns =
      idx >= 0
        ? existingRuns.map((run, i) =>
            i === idx
              ? {
                  ...run,
                  ...payload.run!,
                  items: payload.run!.items?.length ? mergeRunItems(run.items ?? [], payload.run!.items) : run.items ?? [],
                }
              : run
          )
        : [...existingRuns, { ...payload.run, items: payload.run.items ?? [] }];
    return {
      ...thread,
      subagentRuns: mergedRuns,
    };
  }

  if (payload.kind === 'subagentStepsUpdated' && payload.subagentId) {
    const existingRuns = thread.subagentRuns ?? [];
    const idx = existingRuns.findIndex(
      (r) =>
        r.subagentId === payload.subagentId ||
        r.parentToolCallId === payload.subagentId ||
        (payload.childThreadId && r.childThreadId === payload.childThreadId)
    );
    if (idx < 0) {
      const synthesizedItems = payload.items ?? [];
      const synthesizedRun: SubagentRun = {
        subagentId: payload.subagentId,
        parentThreadId: thread.id,
        parentToolCallId: payload.subagentId,
        childThreadId: payload.childThreadId ?? null,
        role: payload.role ?? payload.subagentId,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        status: payload.status ?? 'running',
        stepCount: payload.stepCount ?? synthesizedItems.length,
        latestActivity: payload.latestActivity ?? null,
        startedAtUnixMs: payload.updatedAtUnixMs ?? Date.now(),
        updatedAtUnixMs: payload.updatedAtUnixMs ?? Date.now(),
        items: synthesizedItems,
      };
      return {
        ...thread,
        subagentRuns: [...existingRuns, synthesizedRun],
      };
    }
    const nextRuns = existingRuns.map((run, i) => {
      if (i !== idx) return run;
      const mergedItems = payload.items ? mergeRunItems(run.items ?? [], payload.items) : run.items ?? [];
      return {
        ...run,
        childThreadId: payload.childThreadId ?? run.childThreadId,
        model: payload.model ?? run.model,
        provider: payload.provider ?? run.provider,
        items: mergedItems,
        stepCount: Math.max(run.stepCount ?? 0, payload.stepCount ?? mergedItems.length),
        latestActivity: payload.latestActivity !== undefined ? payload.latestActivity : run.latestActivity,
        status: payload.status ?? run.status,
        updatedAtUnixMs: payload.updatedAtUnixMs ?? run.updatedAtUnixMs,
      };
    });
    return {
      ...thread,
      subagentRuns: nextRuns,
    };
  }

  return thread;
}

export function countRunningSubagents(
  thread: Pick<ExtendedChatThread, 'subagentRuns' | 'swarmState'> | null | undefined
): number {
  if (!thread) return 0;
  const activeRunCount = (thread.subagentRuns ?? []).filter((run) => {
    const status = (run.status ?? '').toLowerCase();
    return status === 'running' || status === 'queued' || status === 'pending' || status === 'waiting';
  }).length;
  const workingSwarmCount = (thread.swarmState?.members ?? []).filter(
    (m) => (m.state ?? '').toLowerCase() === 'working'
  ).length;
  return activeRunCount + workingSwarmCount;
}

export function useSubagentEvents({
  setThreadsMap,
  isMountedRef,
}: {
  setThreadsMap: Dispatch<SetStateAction<Record<string, ExtendedChatThread>>>;
  isMountedRef: MutableRefObject<boolean>;
}) {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return;
    }
    let unlistenSubagent: (() => void) | undefined;
    let unlistenSwarm: (() => void) | undefined;
    let cancelled = false;
    let threadsSyncTimer: number | null = null;
    const scheduleThreadsChanged = () => {
      if (threadsSyncTimer !== null) return;
      threadsSyncTimer = window.setTimeout(() => {
        threadsSyncTimer = null;
        if (!cancelled && isMountedRef.current && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('kite:threads-changed'));
        }
      }, 120);
    };
    const handlePayload = (payload: ChatSubagentEventPayload | undefined) => {
      if (!isMountedRef.current || !payload?.threadId) return;
      if (shouldDispatchThreadsChanged(payload)) {
        scheduleThreadsChanged();
      }
      setThreadsMap((prev) => {
        const current = prev[payload.threadId];
        if (!current) return prev;
        const next = applySubagentEvent(current, payload);
        if (next !== current && typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('kite:subagent-activity-count', {
              detail: { threadId: payload.threadId, count: countRunningSubagents(next) },
            })
          );
        }
        return next === current ? prev : { ...prev, [payload.threadId]: next };
      });
    };

    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const stopSub = await listen<ChatSubagentEventPayload>('chat-subagent-event', (event) => {
          handlePayload(event.payload);
        });
        if (cancelled) {
          stopSub();
          return;
        }
        unlistenSubagent = stopSub;
        const stopSwarm = await listen<ChatSubagentEventPayload>('chat-swarm-event', (event) => {
          handlePayload(event.payload);
        });
        if (cancelled) {
          stopSwarm();
          return;
        }
        unlistenSwarm = stopSwarm;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (threadsSyncTimer !== null) {
        window.clearTimeout(threadsSyncTimer);
        threadsSyncTimer = null;
      }
      unlistenSubagent?.();
      unlistenSwarm?.();
    };
  }, [setThreadsMap, isMountedRef]);
}
