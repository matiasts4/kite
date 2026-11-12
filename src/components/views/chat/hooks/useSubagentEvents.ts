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
      (r) => r.subagentId === payload.subagentId || r.parentToolCallId === payload.subagentId
    );
    if (idx < 0) return thread;
    const nextRuns = existingRuns.map((run, i) => {
      if (i !== idx) return run;
      const mergedItems = payload.items ? mergeRunItems(run.items ?? [], payload.items) : run.items ?? [];
      return {
        ...run,
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
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<ChatSubagentEventPayload>('chat-subagent-event', (event) => {
          if (!isMountedRef.current || !event.payload?.threadId) return;
          const payload = event.payload;
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
        })
      )
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setThreadsMap, isMountedRef]);
}
