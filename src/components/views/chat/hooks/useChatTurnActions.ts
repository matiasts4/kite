import { useState, useEffect } from 'react';
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
}: UseChatTurnActionsOptions) {
  const [isRunning, setIsRunning] = useState<Record<string, boolean>>({});
  const [liveRuns, setLiveRuns] = useState<LiveChatRun[]>([]);

  const checkLiveRuns = async () => {
    try {
      const runs = await withTimeout(
        invokeCommand<LiveChatRun[]>('list_live_chat_runs'),
        3000,
        'list_live_chat_runs'
      );
      if (isMountedRef.current && Array.isArray(runs)) {
        setLiveRuns(runs);
      }
    } catch {
      // Ignore background failure or timeout
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

  const handleCancelTurn = async (threadId: string) => {
    try {
      activePollRunsRef.current.clear();
      if (agentId) {
        await invokeCommand<void>('cancel_agent_chat_turn', { threadId });
      } else {
        await invokeCommand<void>('cancel_chat_turn', { threadId });
      }
      if (!isMountedRef.current) return;
      setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      setThreadsMap((prev) => {
        const t = prev[threadId];
        return t ? { ...prev, [threadId]: { ...t, status: 'idle' } } : prev;
      });
    } catch (err) {
      console.error('[ChatView] cancel_chat_turn error:', err);
    }
  };

  const handleSendPrompt = async (
    threadId: string,
    overridePrompt?: string,
    overrideThread?: ExtendedChatThread,
    planAction?: PlanActionPayload
  ): Promise<boolean> => {
    const thread = overrideThread || threadsMap[threadId];
    const rawPrompt = (overridePrompt !== undefined ? overridePrompt : promptMap[threadId] || '').trim();
    const promptText = expandCitations(rawPrompt);
    const currentAttachments = attachmentsMap[threadId] || [];

    if (promptText.length > 120_000) return false;
    if ((!promptText && currentAttachments.length === 0) || !thread || isRunning[threadId]) return false;

    setPromptMap((prev) => ({ ...prev, [threadId]: '' }));
    writeAttachments(threadId, []);

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
      activePollRunsRef.current.add(res.runId);
      setThreadsMap((prev) => ({ ...prev, [threadId]: res.thread }));
      if (res.thread?.status === 'idle') {
        setIsRunning((prev) => ({ ...prev, [threadId]: false }));
      }
      notifyThreadsChanged();
      void pollTurnUpdates({
        runId: res.runId,
        threadId,
        afterSeq: 0,
        agentId,
        isMountedRef,
        activePollRunsRef,
        setThreadsMap,
        setIsRunning,
        notifyThreadsChanged,
      });
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
    setIsRunning,
    liveRuns,
    checkLiveRuns,
    handleApproval,
    handleCancelTurn,
    handleSendPrompt,
    handleUserInputResponse,
  };
}
