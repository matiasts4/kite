import type {
  ExtendedChatThread,
  LiveChatRun,
} from '../../components/views/chat/types';
import type { ChatThreadSummary } from '../../components/sidebar/types';
import type { RoutineCollection, NotificationsSnapshot } from '../../types';
import { invokeCommand } from './core';

export async function loadChatThread(threadId: string): Promise<ExtendedChatThread> {
  return invokeCommand<ExtendedChatThread>('load_chat_thread', { supportedSchemaVersion: 1, threadId });
}

export async function createGeneralChat(
  provider = 'claude',
  workspaceId?: string | null,
  mode = 'readOnly'
): Promise<ExtendedChatThread> {
  return invokeCommand<ExtendedChatThread>('create_general_chat', {
    supportedSchemaVersion: 1,
    provider,
    workspaceId: workspaceId ?? null,
    mode,
  });
}

export async function updateChatConfiguration(
  threadId: string,
  provider: string,
  mode: string,
  model?: string | null
): Promise<ExtendedChatThread> {
  return invokeCommand<ExtendedChatThread>('update_chat_configuration', {
    supportedSchemaVersion: 1,
    threadId,
    provider,
    mode,
    model,
  });
}

export async function startChatTurn(
  threadId: string,
  prompt: string,
  mode = 'readOnly',
  provider = 'claude',
  attachments: unknown[] = []
): Promise<{ schemaVersion: number; runId: string; thread: ExtendedChatThread }> {
  return invokeCommand('start_chat_turn', {
    supportedSchemaVersion: 1,
    threadId,
    prompt,
    mode,
    provider,
    attachments,
  });
}

export async function startAgentChatTurn(
  agentId: string,
  threadId: string,
  prompt: string,
  mode = 'readOnly',
  provider = 'claude',
  attachments: unknown[] = []
): Promise<{ schemaVersion: number; runId: string; thread: ExtendedChatThread }> {
  return invokeCommand('start_agent_chat_turn', {
    agentId,
    threadId,
    prompt,
    mode,
    provider,
    attachments,
  });
}

// Routines
export async function listRoutines(): Promise<RoutineCollection> {
  return invokeCommand<RoutineCollection>('list_routines', { supportedSchemaVersion: 1 });
}

export async function runRoutineNow(routineId: string): Promise<{ ok: boolean; threadId?: string }> {
  return invokeCommand<{ ok: boolean; threadId?: string }>('run_routine_now', { supportedSchemaVersion: 1, routineId });
}

export async function setRoutineEnabled(routineId: string, enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
  return invokeCommand<{ ok: boolean; enabled: boolean }>('set_routine_enabled', { supportedSchemaVersion: 1, routineId, enabled });
}

// Notifications
export async function getNotificationsSnapshot(): Promise<NotificationsSnapshot> {
  return invokeCommand<NotificationsSnapshot>('notifications_snapshot', { supportedSchemaVersion: 1 });
}

export async function markNotificationRead(recordId: string): Promise<NotificationsSnapshot> {
  return invokeCommand<NotificationsSnapshot>('notifications_mark_read', { recordId });
}

export async function markAllNotificationsRead(): Promise<NotificationsSnapshot> {
  return invokeCommand<NotificationsSnapshot>('notifications_mark_all_read');
}

// Live Chat & Grid Helpers
export async function listLiveChatRuns(): Promise<LiveChatRun[]> {
  return invokeCommand<LiveChatRun[]>('list_live_chat_runs');
}

export async function saveThreadGrid(grid: {
  schemaVersion: number;
  threadIds: string[];
  focusedThreadId: string;
}): Promise<void> {
  return invokeCommand<void>('save_thread_grid', { grid });
}

export async function loadThreadGrid(): Promise<{ schemaVersion: number; threadIds: string[]; focusedThreadId: string } | null> {
  return invokeCommand('load_thread_grid');
}

export async function respondChatApproval(
  threadId: string,
  decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
  requestId: string
): Promise<ExtendedChatThread> {
  return invokeCommand<ExtendedChatThread>('respond_chat_approval', { threadId, decision, requestId });
}

export async function cancelChatTurn(threadId: string): Promise<void> {
  return invokeCommand<void>('cancel_chat_turn', { threadId });
}

export interface ChatTurnUpdatesResponse {
  schemaVersion: number;
  runId: string;
  nextSequence: number;
  events: Array<{
    sequence: number;
    kind: 'status' | 'upsert' | 'delta' | 'finished' | 'approvalOpened' | 'approvalResolved';
    status?: 'idle' | 'running' | 'waiting' | 'error';
    item?: any;
    itemId?: string;
    text?: string;
    ok?: boolean;
    stoppedByBuilder?: boolean;
    approval?: any;
    requestId?: string;
  }>;
}

export async function readChatTurnUpdates(
  runId: string,
  threadId: string,
  afterSequence = 0,
  waitMs = 350
): Promise<ChatTurnUpdatesResponse> {
  return invokeCommand<ChatTurnUpdatesResponse>('read_chat_turn_updates', {
    runId,
    threadId,
    afterSequence,
    waitMs,
  });
}

export async function archiveChatThread(threadId: string): Promise<{ deleted: boolean }> {
  return invokeCommand<{ deleted: boolean }>('archive_chat_thread', { threadId });
}

export interface ArchivedChatSummary {
  schemaVersion?: number;
  id: string;
  profileId: string | null;
  title: string;
  revision: number | string;
  archivedAtUnixMs: number;
  expiresAtUnixMs: number;
  provider?: string | null;
  model?: string | null;
}

export async function listArchivedChats(profileId?: string | null): Promise<ArchivedChatSummary[]> {
  const payload = profileId ? { profileId } : {};
  const res = await invokeCommand<ArchivedChatSummary[]>('list_archived_chats', payload);
  return Array.isArray(res) ? res : [];
}

export async function restoreArchivedChat(threadId: string, profileId?: string | null): Promise<void> {
  return invokeCommand<void>('restore_archived_chat', { threadId, profileId: profileId ?? null });
}

export async function purgeArchivedChat(threadId: string, profileId?: string | null): Promise<void> {
  return invokeCommand<void>('purge_archived_chat', { threadId, profileId: profileId ?? null });
}

export async function listChatSummaries(): Promise<ChatThreadSummary[]> {
  try {
    const res = await invokeCommand<{ summaries?: ChatThreadSummary[] }>('list_chat_summaries');
    return res?.summaries ?? [];
  } catch {
    return [];
  }
}

export async function renameChatThread(threadId: string, title: string): Promise<void> {
  return invokeCommand<void>('rename_chat_thread', { supportedSchemaVersion: 1, threadId, title });
}

export async function setChatThreadPinned(threadId: string, pinned: boolean): Promise<void> {
  return invokeCommand<void>('set_chat_thread_pinned', { supportedSchemaVersion: 1, threadId, pinned });
}

export async function deleteChatThread(threadId: string): Promise<void> {
  return invokeCommand<void>('delete_chat_thread', { supportedSchemaVersion: 1, threadId });
}

export async function rewindThreadTranscript(
  threadId: string,
  messageId: string
): Promise<{ text: string | null; thread: ExtendedChatThread | null; error: string | null }> {
  return invokeCommand('rewind_thread_transcript', { threadId, messageId });
}

export async function restoreThreadCheckpoint(
  threadId: string
): Promise<{ restored: boolean; error: string | null }> {
  return invokeCommand('restore_thread_checkpoint', { threadId });
}

export async function getThreadSubagentDetail(
  threadId: string,
  subagentId: string
): Promise<import('../../types').SubagentRun | null> {
  return invokeCommand<import('../../types').SubagentRun | null>('get_thread_subagent_detail', {
    threadId,
    subagentId,
  });
}

export async function getThreadSwarmState(
  threadId: string
): Promise<import('../../types').SwarmState | null> {
  return invokeCommand<import('../../types').SwarmState | null>('get_thread_swarm_state', {
    threadId,
  });
}
