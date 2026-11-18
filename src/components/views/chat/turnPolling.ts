import type React from 'react';
import type { ChatItem } from '../../../types';
import { invokeCommand } from '../../../lib/ipc';
import { ExtendedChatThread } from './types';
import { isInternalDispatchItem } from './chatItemHelpers';
import { withTimeout } from './chatSessionUtils';
import { playApprovalChime } from '../../../lib/notifications/audioCues';

export interface PollTurnOptions {
  runId: string;
  threadId: string;
  afterSeq: number;
  agentId?: string | null;
  isMountedRef: React.MutableRefObject<boolean>;
  activePollRunsRef: React.MutableRefObject<Set<string>>;
  activePollThreadsRef?: React.MutableRefObject<Map<string, string>>;
  setThreadsMap: React.Dispatch<React.SetStateAction<Record<string, ExtendedChatThread>>>;
  setIsRunning: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  notifyThreadsChanged: () => void;
  reconcileThread?: (threadId: string) => Promise<void> | void;
  consecutiveErrors?: number;
}

const IN_FLIGHT_ITEM_STATUSES = new Set([
  'inProgress',
  'running',
  'pending',
  'in_progress',
  'started',
]);

const MAX_TRANSIENT_POLL_RETRIES = 5;

function settleInFlightItems(
  items: ChatItem[],
  finalItemStatus: 'completed' | 'failed'
): ChatItem[] {
  let changed = false;
  const next = items.map((it) => {
    const isStreaming = Boolean(it.streaming);
    const isInFlightStatus = IN_FLIGHT_ITEM_STATUSES.has(String(it.status ?? ''));
    if (!isStreaming && !isInFlightStatus) {
      return it;
    }
    changed = true;
    return {
      ...it,
      streaming: false,
      status: isInFlightStatus ? finalItemStatus : it.status,
    };
  });
  return changed ? next : items;
}

function stopPollingRun(
  runId: string,
  threadId: string,
  activePollRunsRef: React.MutableRefObject<Set<string>>,
  activePollThreadsRef: React.MutableRefObject<Map<string, string>> | undefined,
  setIsRunning: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
): void {
  activePollRunsRef.current.delete(runId);
  const currentThreadRunId = activePollThreadsRef?.current.get(threadId);
  if (currentThreadRunId && currentThreadRunId !== runId) {
    return;
  }
  if (currentThreadRunId === runId) {
    activePollThreadsRef?.current.delete(threadId);
  }
  setIsRunning((prev) => ({ ...prev, [threadId]: false }));
}

export async function pollTurnUpdates({
  runId,
  threadId,
  afterSeq,
  agentId,
  isMountedRef,
  activePollRunsRef,
  activePollThreadsRef,
  setThreadsMap,
  setIsRunning,
  notifyThreadsChanged,
  reconcileThread,
  consecutiveErrors = 0,
}: PollTurnOptions): Promise<void> {
  if (!isMountedRef.current || !activePollRunsRef.current.has(runId)) return;
  try {
    const pollPromise = invokeCommand<{
      schemaVersion: number;
      runId: string;
      nextSequence: number;
      finished?: boolean;
      hasMore?: boolean;
      resyncRequired?: boolean;
      error?: string;
      events: Array<{
        sequence: number;
        kind: 'status' | 'upsert' | 'delta' | 'remove' | 'finished' | 'approvalOpened' | 'approvalResolved';
        status?: 'idle' | 'running' | 'waiting' | 'error';
        item?: ChatItem;
        itemId?: string;
        text?: string;
        ok?: boolean;
        stoppedByBuilder?: boolean;
        approval?: any;
        requestId?: string;
      }>;
    }>(
      agentId ? 'read_agent_chat_turn_updates' : 'read_chat_turn_updates',
      agentId
        ? {
            agentId,
            threadId,
            runId,
            afterSequence: afterSeq,
            waitMs: 350,
          }
        : {
            runId,
            threadId,
            afterSequence: afterSeq,
            waitMs: 350,
          }
    );

    const res = await withTimeout(pollPromise, 15000, `pollTurnUpdates(${runId})`);

    if (!isMountedRef.current || !activePollRunsRef.current.has(runId)) return;

    if (res && typeof res.error === 'string' && res.error.trim().length > 0) {
      throw new Error(res.error);
    }

    if (res && res.events) {
      const events = res.events;
      const hasMore = Boolean(res.hasMore);
      const hasFinishedEvent = events.some(
        (ev) =>
          ev.kind === 'finished' ||
          (ev.kind === 'status' && (ev.status === 'idle' || ev.status === 'error'))
      );
      const resyncRequired = Boolean(res.resyncRequired);
      const isTerminal = !hasMore && Boolean(res.finished || hasFinishedEvent);

      if (events.length > 0) {
        console.debug(
          `[ChatSession] Run ${runId} received ${events.length} events (nextSeq=${res.nextSequence}, finished=${Boolean(res.finished)}, resync=${resyncRequired})`
        );
      }

      if (events.length > 0 || isTerminal) {
        setThreadsMap((prevMap) => {
          const target = prevMap[threadId];
          if (!target) return prevMap;
          let items = [...target.items];
          let status = target.status;
          let pendingApproval = target.pendingApproval;
          let stoppedByBuilder = Boolean(target.stoppedByBuilder);

          for (const ev of events) {
            if (ev.kind === 'status' && ev.status) {
              status = ev.status;
              if (ev.status === 'running') stoppedByBuilder = false;
              if (ev.status === 'idle' || ev.status === 'error') {
                items = settleInFlightItems(
                  items,
                  ev.status === 'error' ? 'failed' : 'completed'
                );
              }
            } else if (ev.kind === 'upsert' && ev.item) {
              const idx = items.findIndex((it) => it.id === ev.item!.id);
              if (idx >= 0) {
                const prev = items[idx];
                const prevText = prev.text ?? '';
                const nextText = ev.item.text ?? '';
                const hasToolsAfter = items
                  .slice(idx + 1)
                  .some((later) => later.kind === 'tool' || later.kind === 'command');
                const isContentUpdate =
                  nextText.length > prevText.length ||
                  (hasToolsAfter &&
                    nextText.trim().length > 0 &&
                    (Boolean(ev.item.streaming) || nextText !== prevText));
                const moveToTail =
                  ev.item.kind === 'assistant' &&
                  isContentUpdate &&
                  idx + 1 < items.length &&
                  !items
                    .slice(idx + 1)
                    .some((later) => later.kind === 'user' && !isInternalDispatchItem(later));
                items[idx] =
                  prev.createdAtUnixMs && prev.createdAtUnixMs > 0
                    ? { ...ev.item, createdAtUnixMs: prev.createdAtUnixMs }
                    : ev.item;
                if (moveToTail) {
                  const [moved] = items.splice(idx, 1);
                  items.push(moved);
                }
              } else {
                items.push(ev.item);
              }
            } else if (ev.kind === 'remove' && ev.itemId) {
              items = items.filter((it) => it.id !== ev.itemId);
            } else if (ev.kind === 'delta' && ev.itemId && ev.text) {
              const idx = items.findIndex((it) => it.id === ev.itemId);
              if (idx >= 0) {
                const moveToTail =
                  items[idx].kind === 'assistant' &&
                  idx + 1 < items.length &&
                  !items
                    .slice(idx + 1)
                    .some((later) => later.kind === 'user' && !isInternalDispatchItem(later));
                items[idx] = {
                  ...items[idx],
                  text: items[idx].text + ev.text,
                  streaming: true,
                };
                if (moveToTail) {
                  const [moved] = items.splice(idx, 1);
                  items.push(moved);
                }
              } else {
                items.push({
                  id: ev.itemId,
                  kind: 'assistant',
                  text: ev.text,
                  title: null,
                  detail: null,
                  status: 'inProgress',
                  streaming: true,
                  exitCode: null,
                  createdAtUnixMs: Date.now(),
                  attachments: [],
                });
              }
            } else if (ev.kind === 'approvalOpened' && ev.approval) {
              pendingApproval = ev.approval;
              status = 'waiting';
              playApprovalChime();
            } else if (ev.kind === 'approvalResolved') {
              pendingApproval = null;
            } else if (ev.kind === 'finished') {
              status = ev.ok === false ? 'error' : 'idle';
              stoppedByBuilder = Boolean(ev.stoppedByBuilder);
              items = settleInFlightItems(
                items,
                ev.ok === false && !ev.stoppedByBuilder ? 'failed' : 'completed'
              );
            }
          }

          if (isTerminal) {
            if (status === 'running') {
              status = 'idle';
            }
            if (status !== 'waiting') {
              items = settleInFlightItems(
                items,
                status === 'error' || stoppedByBuilder ? 'failed' : 'completed'
              );
            }
          }

          return {
            ...prevMap,
            [threadId]: {
              ...target,
              items,
              status,
              pendingApproval,
              stoppedByBuilder,
            },
          };
        });
      }

      if (isTerminal) {
        console.log(`[ChatSession] Run ${runId} completed. Removing poller.`);
        stopPollingRun(
          runId,
          threadId,
          activePollRunsRef,
          activePollThreadsRef,
          setIsRunning
        );
        void reconcileThread?.(threadId);
        notifyThreadsChanged();
      } else {
        if (resyncRequired) {
          void reconcileThread?.(threadId);
        }
        setTimeout(() => {
          if (isMountedRef.current && activePollRunsRef.current.has(runId)) {
            void pollTurnUpdates({
              runId,
              threadId,
              afterSeq: res.nextSequence,
              agentId,
              isMountedRef,
              activePollRunsRef,
              activePollThreadsRef,
              setThreadsMap,
              setIsRunning,
              notifyThreadsChanged,
              reconcileThread,
              consecutiveErrors: 0,
            });
          }
        }, hasMore ? 0 : 400);
      }
    } else if (res?.finished) {
      console.log(`[ChatSession] Run ${runId} finished without events. Removing poller.`);
      stopPollingRun(
        runId,
        threadId,
        activePollRunsRef,
        activePollThreadsRef,
        setIsRunning
      );
      setThreadsMap((prev) => {
        const t = prev[threadId];
        if (!t) return prev;
        const settledStatus = t.status === 'running' ? 'idle' : t.status;
        return {
          ...prev,
          [threadId]: {
            ...t,
            items:
              settledStatus === 'waiting'
                ? t.items
                : settleInFlightItems(
                    t.items,
                    settledStatus === 'error' ? 'failed' : 'completed'
                  ),
            status: settledStatus,
          },
        };
      });
      void reconcileThread?.(threadId);
      notifyThreadsChanged();
    } else {
      if (res?.resyncRequired) {
        void reconcileThread?.(threadId);
      }
      setTimeout(() => {
        if (isMountedRef.current && activePollRunsRef.current.has(runId)) {
          void pollTurnUpdates({
            runId,
            threadId,
            afterSeq,
            agentId,
            isMountedRef,
            activePollRunsRef,
            activePollThreadsRef,
            setThreadsMap,
            setIsRunning,
            notifyThreadsChanged,
            reconcileThread,
            consecutiveErrors: 0,
          });
        }
      }, 500);
    }
  } catch (err) {
    if (!isMountedRef.current || !activePollRunsRef.current.has(runId)) return;
    const nextErrors = consecutiveErrors + 1;
    if (nextErrors <= MAX_TRANSIENT_POLL_RETRIES) {
      const backoffMs = Math.min(8000, 1000 * Math.pow(2, nextErrors - 1));
      console.warn(
        `[ChatView] Polling attempt ${nextErrors}/${MAX_TRANSIENT_POLL_RETRIES} failed for run ${runId}; retrying in ${backoffMs}ms:`,
        err
      );
      setTimeout(() => {
        if (isMountedRef.current && activePollRunsRef.current.has(runId)) {
          void pollTurnUpdates({
            runId,
            threadId,
            afterSeq,
            agentId,
            isMountedRef,
            activePollRunsRef,
            activePollThreadsRef,
            setThreadsMap,
            setIsRunning,
            notifyThreadsChanged,
            reconcileThread,
            consecutiveErrors: nextErrors,
          });
        }
      }, backoffMs);
      return;
    }

    console.warn('[ChatView] Polling updates exhausted retries:', err);
    stopPollingRun(
      runId,
      threadId,
      activePollRunsRef,
      activePollThreadsRef,
      setIsRunning
    );
    setThreadsMap((prev) => {
      const t = prev[threadId];
      if (!t) return prev;
      const settledStatus = t.status === 'running' ? 'idle' : t.status;
      return {
        ...prev,
        [threadId]: {
          ...t,
          items: settleInFlightItems(t.items, 'failed'),
          status: settledStatus,
        },
      };
    });
    void reconcileThread?.(threadId);
    notifyThreadsChanged();
  }
}
