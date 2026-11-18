import { useState, useEffect, useRef, useCallback } from 'react';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';
import type { ChatItem } from '../../../../types';
import { invokeCommand } from '../../../../lib/ipc';
import type { ExtendedChatThread, ChatAttachment, LiveChatRun } from '../types';
import type { PlanActionPayload } from '../ChatPlanPanel';
import { expandCitations } from '../citationChip';
import { pollTurnUpdates } from '../turnPolling';
import { withTimeout } from '../chatSessionUtils';
import { readThreadSendBinding } from './useChatConnectionBindings';

export interface UseChatTurnActionsOptions {
  agentId?: string | null;
  threadsMap: Record<string, ExtendedChatThread>;
  setThreadsMap: Dispatch<SetStateAction<Record<string, ExtendedChatThread>>>;
  promptMap: Record<string, string>;
  setPromptMap: Dispatch<SetStateAction<Record<string, string>>>;
  attachmentsMap: Record<string, ChatAttachment[]>;
  writeAttachments: (threadId: string, attachments: ChatAttachment[]) => void;
  threadWithResolvedBinding: (thread: ExtendedChatThread) => ExtendedChatThread;
  notifyThreadsChanged: () => void;
  isMountedRef: MutableRefObject<boolean>;
  activePollRunsRef: MutableRefObject<Set<string>>;
  activePollThreadsRef?: MutableRefObject<Map<string, string>>;
  reconcileThread?: (threadId: string) => Promise<void> | void;
}

export function useChatTurnActions({
  agentId,
  threadsMap,
  setThreadsMap,
  promptMap,
  setPromptMap,
  attachmentsMap,
  writeAttachments,
  threadWithResolvedBinding,
  notifyThreadsChanged,
  isMountedRef,
  activePollRunsRef,
  activePollThreadsRef,
  reconcileThread,
}: UseChatTurnActionsOptions) {
  const [isRunning, setIsRunningState] = useState<Record<string, boolean>>({});
  const isRunningRef = useRef<Record<string, boolean>>(isRunning);
  const [liveRuns, setLiveRuns] = useState<LiveChatRun[]>([]);
  const [hasCheckedLiveRuns, setHasCheckedLiveRuns] = useState(false);
  const isCheckingLiveRunsRef = useRef(false);

  const setIsRunning: Dispatch<SetStateAction<Record<string, boolean>>> = useCallback(
    (updater) => {
      const next =
        typeof updater === 'function' ? updater(isRunningRef.current) : updater;
      isRunningRef.current = next;
      setIsRunningState(next);
    },
    []
  );

  const attachPollRun = (
    threadId: string,
    runId: string,
    afterSeq = 0,
    markRunning = true
  ) => {
    if (!isMountedRef.current || !runId || activePollRunsRef.current.has(runId)) return;
    activePollRunsRef.current.add(runId);
    activePollThreadsRef?.current.set(threadId, runId);
    if (markRunning) {
      setIsRunning((prev) => (prev[threadId] ? prev : { ...prev, [threadId]: true }));
    }
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
    });
  };

  const checkLiveRuns = async () => {
    if (isCheckingLiveRunsRef.current) return;
    isCheckingLiveRunsRef.current = true;
    try {
      const runs = await withTimeout(
        invokeCommand<LiveChatRun[]>('list_live_chat_runs'),
        5000,
        'list_live_chat_runs'
      );
      if (isMountedRef.current && Array.isArray(runs)) {
        setLiveRuns(runs);
        setHasCheckedLiveRuns(true);
      }
    } catch {
      // Ignore background failure or timeout
    } finally {
      isCheckingLiveRunsRef.current = false;
    }
  };

  // Periodic poll for live chat runs
  useEffect(() => {
    const timer = setInterval(() => {
      void checkLiveRuns();
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  const handleApproval = async (
    threadId: string,
    decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
    requestId: string
  ) => {
    try {
      const updated = await invokeCommand<ExtendedChatThread>('respond_chat_approval', {
        threadId,
        decision,
        requestId,
      });
      if (isMountedRef.current) {
        setThreadsMap((prev) => ({ ...prev, [threadId]: updated }));
      }
    } catch (err) {
      console.error('[ChatView] respond_chat_approval error:', err);
    }
  };

  const handleCancelTurn = async (threadId: string): Promise<boolean> => {
    try {
      if (agentId) {
        await invokeCommand<void>('cancel_agent_chat_turn', { threadId });
      } else {
        await invokeCommand<void>('cancel_chat_turn', { threadId });
      }
      if (activePollThreadsRef) {
        const trackedRunId = activePollThreadsRef.current.get(threadId);
        if (trackedRunId) {
          activePollRunsRef.current.delete(trackedRunId);
          activePollThreadsRef.current.delete(threadId);
        }
      } else {
        activePollRunsRef.current.clear();
      }
      if (!isMountedRef.current) return true;
      setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      setThreadsMap((prev) => {
        const t = prev[threadId];
        return t ? { ...prev, [threadId]: { ...t, status: 'idle', stoppedByBuilder: true } } : prev;
      });
      return true;
    } catch (err) {
      console.error('[ChatView] cancel_chat_turn error:', err);
      return false;
    }
  };

  const handleSendPrompt = async (
    threadId: string,
    overridePrompt?: string,
    overrideThread?: ExtendedChatThread,
    planAction?: PlanActionPayload,
    overrideAttachments?: ChatAttachment[]
  ): Promise<boolean> => {
    const thread = overrideThread || threadsMap[threadId];
    const rawPrompt = (overridePrompt !== undefined ? overridePrompt : promptMap[threadId] || '').trim();
    const promptText = expandCitations(rawPrompt);
    const currentAttachments =
      overrideAttachments !== undefined ? overrideAttachments : (attachmentsMap[threadId] || []);

    if (
      !promptText &&
      currentAttachments.length === 0 &&
      thread &&
      !isRunningRef.current[threadId]
    ) {
      if ((thread.queuedRuns?.length ?? 0) > 0) {
        const [nextQueued, ...restQueue] = thread.queuedRuns!;
        const updatedThread: ExtendedChatThread = {
          ...thread,
          queuedRuns: restQueue,
          stoppedByBuilder: false,
        };
        setThreadsMap((prev) => ({
          ...prev,
          [threadId]: {
            ...(prev[threadId] || updatedThread),
            queuedRuns: restQueue,
            stoppedByBuilder: false,
          },
        }));
        void invokeCommand('update_chat_configuration', {
          threadId,
          queuedRuns: restQueue,
        });
        return handleSendPrompt(
          threadId,
          nextQueued.text,
          updatedThread,
          planAction,
          nextQueued.attachments ?? []
        );
      }
      if (thread.stoppedByBuilder || thread.turnFailure?.kind === 'usageLimit') {
        const resumedThread: ExtendedChatThread = {
          ...thread,
          stoppedByBuilder: false,
          turnFailure: undefined,
        };
        return handleSendPrompt(threadId, 'Continue', resumedThread, planAction, []);
      }
    }

    if (promptText.length > 120_000) return false;
    if ((!promptText && currentAttachments.length === 0) || !thread || isRunningRef.current[threadId]) return false;

    if (overridePrompt === undefined) {
      setPromptMap((prev) => ({ ...prev, [threadId]: '' }));
    }
    if (overrideAttachments === undefined) {
      writeAttachments(threadId, []);
    }

    const userItem: ChatItem = {
      id: `u-${Date.now()}`,
      kind: 'user',
      text: promptText,
      title: null,
      detail: null,
      status: 'completed',
      streaming: false,
      exitCode: null,
      createdAtUnixMs: Date.now(),
      attachments: currentAttachments,
    };

    const boundThread = threadWithResolvedBinding(thread);
    const sendBinding = readThreadSendBinding(boundThread);

    setThreadsMap((prev) => {
      const t = prev[threadId] || boundThread;
      return {
        ...prev,
        [threadId]: {
          ...t,
          items: [...t.items, userItem],
          status: 'running',
          stoppedByBuilder: false,
          turnFailure: undefined,
          ...readThreadSendBinding(boundThread),
        },
      };
    });
    setIsRunning((prev) => ({ ...prev, [threadId]: true }));

    try {
      let res: { schemaVersion: number; runId: string; thread: ExtendedChatThread };

      if (agentId) {
        res = await invokeCommand('start_agent_chat_turn', {
          agentId,
          threadId,
          prompt: promptText,
          mode: thread.mode,
          provider: thread.provider,
          attachments: currentAttachments,
          planAction,
          ...sendBinding,
        });
      } else {
        res = await invokeCommand('start_chat_turn', {
          threadId,
          prompt: promptText,
          mode: thread.mode,
          provider: thread.provider,
          model: thread.model ?? null,
          effort: thread.effort ?? null,
          attachments: currentAttachments,
          planAction,
          ...sendBinding,
        });
      }

      if (!isMountedRef.current) return true;
      setThreadsMap((prev) => {
        const existing = prev[threadId];
        const preservedQueue =
          existing?.queuedRuns !== undefined ? existing.queuedRuns : res.thread?.queuedRuns;
        return {
          ...prev,
          [threadId]:
            preservedQueue !== undefined
              ? { ...res.thread, queuedRuns: preservedQueue }
              : res.thread,
        };
      });
      if (res.thread?.status === 'idle') {
        setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      }
      notifyThreadsChanged();
      attachPollRun(threadId, res.runId, 0, res.thread?.status !== 'idle');
      return true;
    } catch (err: any) {
      for (const item of currentAttachments) {
        void invokeCommand('release_chat_attachment', { threadId, resourceId: item.resourceId });
      }
      console.error('[ChatView] start turn error:', err);
      if (!isMountedRef.current) return false;
      setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      const errItem: ChatItem = {
        id: `err-${Date.now()}`,
        kind: 'error',
        text: err?.message || 'Failed to start chat turn. Ensure provider CLI is installed.',
        title: 'Execution Error',
        detail: null,
        status: 'failed',
        streaming: false,
        exitCode: 1,
        createdAtUnixMs: Date.now(),
        attachments: [],
      };
      setThreadsMap((prev) => {
        const t = prev[threadId];
        return t ? { ...prev, [threadId]: { ...t, items: [...t.items, errItem], status: 'error' } } : prev;
      });
      return false;
    }
  };

  const handleUserInputResponse = async (
    threadId: string,
    answers: Record<string, string | string[]>
  ) => {
    try {
      await invokeCommand('respond_chat_user_input', {
        threadId,
        answers,
      });
    } catch (err) {
      console.error('[ChatView] respond_chat_user_input error:', err);
    }
  };

  return {
    isRunning,
    isRunningRef,
    setIsRunning,
    liveRuns,
    hasCheckedLiveRuns,
    checkLiveRuns,
    attachPollRun,
    handleApproval,
    handleCancelTurn,
    handleSendPrompt,
    handleUserInputResponse,
  };
}
