import type React from 'react';
import type { ChatItem } from '../../../types';
import { invokeCommand } from '../../../lib/ipc';
import { ExtendedChatThread } from './types';
import { withTimeout } from './chatSessionUtils';
import { playApprovalChime, playCompletionChime } from '../../../lib/notifications/audioCues';

export interface PollTurnOptions {
  runId: string;
  threadId: string;
  afterSeq: number;
  agentId?: string | null;
  isMountedRef: React.MutableRefObject<boolean>;
  activePollRunsRef: React.MutableRefObject<Set<string>>;
  setThreadsMap: React.Dispatch<React.SetStateAction<Record<string, ExtendedChatThread>>>;
  setIsRunning: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  notifyThreadsChanged: () => void;
}

export async function pollTurnUpdates({
  runId,
  threadId,
  afterSeq,
  agentId,
  isMountedRef,
  activePollRunsRef,
  setThreadsMap,
  setIsRunning,
  notifyThreadsChanged,
}: PollTurnOptions): Promise<void> {
  if (!isMountedRef.current || !activePollRunsRef.current.has(runId)) return;
  try {
    const pollPromise = invokeCommand<{
      schemaVersion: number;
      runId: string;
      nextSequence: number;
      events: Array<{
        sequence: number;
        kind: 'status' | 'upsert' | 'delta' | 'finished' | 'approvalOpened' | 'approvalResolved';
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

    const res = await withTimeout(pollPromise, 8000, `pollTurnUpdates(${runId})`);

    if (!isMountedRef.current || !activePollRunsRef.current.has(runId)) return;

    if (res && res.events) {
      let isDone = false;
      if (res.events.length > 0) {
        console.debug(
          `[ChatSession] Run ${runId} received ${res.events.length} events (nextSeq=${res.nextSequence})`
        );
      }

      setThreadsMap((prevMap) => {
        const target = prevMap[threadId];
        if (!target) return prevMap;
        let items = [...target.items];
        let status = target.status;
        let pendingApproval = target.pendingApproval;

        for (const ev of res.events) {
          if (ev.kind === 'status' && ev.status) {
            status = ev.status;
            if (ev.status === 'idle' || ev.status === 'error') {
              isDone = true;
              items = items.map((it) => (it.streaming ? { ...it, streaming: false } : it));
            }
          } else if (ev.kind === 'upsert' && ev.item) {
            const idx = items.findIndex((it) => it.id === ev.item!.id);
            if (idx >= 0) {
              items[idx] = ev.item;
            } else {
              items.push(ev.item);
            }
          } else if (ev.kind === 'delta' && ev.itemId && ev.text) {
            const idx = items.findIndex((it) => it.id === ev.itemId);
            if (idx >= 0) {
              items[idx] = {
                ...items[idx],
                text: items[idx].text + ev.text,
                streaming: true,
              };
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
            isDone = true;
            status = 'idle';
            items = items.map((it) => (it.streaming ? { ...it, streaming: false } : it));
            playCompletionChime(ev.ok !== false);
          }
        }

        return {
          ...prevMap,
          [threadId]: {
            ...target,
            items,
            status,
            pendingApproval,
          },
        };
      });

      if (isDone) {
        console.log(`[ChatSession] Run ${runId} completed. Removing poller.`);
        activePollRunsRef.current.delete(runId);
        setIsRunning((prev) => ({ ...prev, [threadId]: false }));
        notifyThreadsChanged();
      } else {
        setTimeout(() => {
          if (isMountedRef.current && activePollRunsRef.current.has(runId)) {
            void pollTurnUpdates({
              runId,
              threadId,
              afterSeq: res.nextSequence,
              agentId,
              isMountedRef,
              activePollRunsRef,
              setThreadsMap,
              setIsRunning,
              notifyThreadsChanged,
            });
          }
        }, 400);
      }
    } else {
      setTimeout(() => {
        if (isMountedRef.current && activePollRunsRef.current.has(runId)) {
          void pollTurnUpdates({
            runId,
            threadId,
            afterSeq,
            agentId,
            isMountedRef,
            activePollRunsRef,
            setThreadsMap,
            setIsRunning,
            notifyThreadsChanged,
          });
        }
      }, 500);
    }
  } catch (err) {
    console.warn('[ChatView] Polling updates finished or cancelled:', err);
    activePollRunsRef.current.delete(runId);
    if (isMountedRef.current) {
      setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      setThreadsMap((prev) => {
        const t = prev[threadId];
        if (!t) return prev;
        const cleanedItems = t.items.map((it) =>
          it.streaming ? { ...it, streaming: false } : it
        );
        return {
          ...prev,
          [threadId]: {
            ...t,
            items: cleanedItems,
            status: t.status === 'running' ? 'idle' : t.status,
          },
        };
      });
    }
  }
}
