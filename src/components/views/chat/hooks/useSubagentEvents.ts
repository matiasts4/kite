import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ChatItem, SubagentRun, SwarmState } from '../../../../types';
import type { ExtendedChatThread } from '../types';
import { dedupeSubagentRuns } from '../subagentRunHelpers';

export type ChatSubagentEventPayload =
  | {
      kind: 'subagentRunUpdated';
      threadId: string;
      subagentId?: string;
      run?: SubagentRun;
    }
  | {
      kind: 'subagentRunRemoved';
      threadId: string;
      subagentId?: string | null;
      parentToolCallId?: string | null;
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
const MAX_TRACKED_RUN_SIGNATURES = 256;

/**
 * When `seen` is provided, progress events that repeat a run's last known
 * `status|childThreadId` signature are ignored, so only creation and lifecycle
 * transitions fan out to the sidebar/dock/summary listeners. Without `seen`
 * the check is stateless (every lifecycle-bearing event qualifies).
 */
export function shouldDispatchThreadsChanged(
  payload: ChatSubagentEventPayload | undefined,
  seen?: Map<string, string>
): boolean {
  if (!payload?.threadId) return false;
  if (payload.kind === 'swarmStateUpdated') return true;
  if (payload.kind === 'subagentRunRemoved') {
    if (seen) {
      const sid = payload.subagentId?.trim();
      if (sid) seen.delete(`${payload.threadId}:${sid}`);
    }
    return true;
  }
  const isRunUpdate = payload.kind === 'subagentRunUpdated';
  if (!isRunUpdate && payload.kind !== 'subagentStepsUpdated') return false;
  if (!isRunUpdate && !(payload.status || payload.childThreadId)) return false;
  if (!seen) return true;

  const sid = isRunUpdate ? (payload.run?.subagentId ?? payload.subagentId) : payload.subagentId;
  if (!sid) return true;
  const status = isRunUpdate ? payload.run?.status : payload.status;
  const childThreadId = isRunUpdate ? payload.run?.childThreadId : payload.childThreadId;
  const signature = `${status ?? ''}|${childThreadId ?? ''}`;
  const key = `${payload.threadId}:${sid}`;
  if (seen.get(key) === signature) return false;
  if (seen.size >= MAX_TRACKED_RUN_SIGNATURES && !seen.has(key)) seen.clear();
  seen.set(key, signature);
  return true;
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

  if (payload.kind === 'subagentRunRemoved') {
    const existingRuns = thread.subagentRuns ?? [];
    const targetSid = payload.subagentId?.trim() || null;
    const targetCallId = payload.parentToolCallId?.trim() || null;
    if (!targetSid && !targetCallId) return thread;
    const nextRuns = existingRuns.filter(
      (r) =>
        !(
          (targetSid && r.subagentId === targetSid) ||
          (targetCallId && r.parentToolCallId === targetCallId)
        )
    );
    if (nextRuns.length === existingRuns.length) return thread;
    return {
      ...thread,
      subagentRuns: nextRuns,
    };
  }

  if (payload.kind === 'subagentRunUpdated' && payload.run) {
    const existingRuns = thread.subagentRuns ?? [];
    const incoming = payload.run;
    const incomingSid = (incoming.subagentId ?? '').trim();
    const incomingCid = (incoming.childThreadId ?? '').trim();
    const incomingCallId = (incoming.parentToolCallId ?? '').trim();

    let idx = existingRuns.findIndex(
      (r) =>
        (incomingSid && r.subagentId === incomingSid) ||
        (incomingCid && (r.childThreadId === incomingCid || r.subagentId === incomingCid)) ||
        (incomingSid && r.childThreadId === incomingSid)
    );
    if (idx < 0 && incomingCallId) {
      idx = existingRuns.findIndex((r) => {
        if (r.parentToolCallId !== incomingCallId) return false;
        const rCid = (r.childThreadId ?? '').trim();
        const rSid = (r.subagentId ?? '').trim();
        return !rCid && (!rSid || rSid === r.parentToolCallId);
      });
    }

    const mergedRuns =
      idx >= 0
        ? existingRuns.map((run, i) => {
            const sameIdentity =
              i === idx ||
              (incomingSid && run.subagentId === incomingSid) ||
              (incomingCid && Boolean(run.childThreadId) && run.childThreadId === incomingCid);
            if (!sameIdentity) return run;
            return {
              ...run,
              ...incoming,
              parentToolCallId:
                run.parentToolCallId && !run.parentToolCallId.startsWith('dispatch-subagent-')
                  ? run.parentToolCallId
                  : incoming.parentToolCallId ?? run.parentToolCallId,
              items: incoming.items?.length
                ? mergeRunItems(run.items ?? [], incoming.items)
                : run.items ?? [],
            };
          })
        : [...existingRuns, { ...incoming, items: incoming.items ?? [] }];
    return {
      ...thread,
      subagentRuns: mergedRuns,
    };
  }

  if (payload.kind === 'subagentStepsUpdated' && payload.subagentId) {
    const existingRuns = thread.subagentRuns ?? [];
    const targetSid = payload.subagentId.trim();
    const targetCid = (payload.childThreadId ?? '').trim();
    let idx = existingRuns.findIndex(
      (r) =>
        r.subagentId === targetSid ||
        (targetCid && (r.childThreadId === targetCid || r.subagentId === targetCid)) ||
        r.childThreadId === targetSid
    );
    if (idx < 0) {
      idx = existingRuns.findIndex((r) => {
        if (r.parentToolCallId !== targetSid) return false;
        const rCid = (r.childThreadId ?? '').trim();
        const rSid = (r.subagentId ?? '').trim();
        return !rCid && (!rSid || rSid === r.parentToolCallId);
      });
    }
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
      const sameIdentity =
        i === idx ||
        run.subagentId === targetSid ||
        (targetCid && Boolean(run.childThreadId) && run.childThreadId === targetCid);
      if (!sameIdentity) return run;
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
  const dedupedRuns = dedupeSubagentRuns(thread.subagentRuns);
  const activeRunCount = dedupedRuns.filter((run) => {
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
    const seenRunSignatures = new Map<string, string>();
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
      if (shouldDispatchThreadsChanged(payload, seenRunSignatures)) {
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
