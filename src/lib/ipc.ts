import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  BootstrapResponse,
  Workspace,
  AgentProfile,
  FilesResourceResponse,
  FilesDirectoryResponse,
  FilesTextResponse,
  FilesPreviewResponse,
  BrowserSurfaceView,
  NotificationsSnapshot,
  RoutineCollection,
  SavedAccountProfile,
  ContinuationSuggestion,
} from '../types';
import type {
  ExtendedChatThread,
  LiveChatRun,
} from '../components/views/chat/types';
import type {
  AgentMindSnapshot,
  LearnedSkillDocument,
  StarterSummary,
} from '../components/views/agents/types';
import type {
  TicketSnapshot,
  TaskExecutionSnapshot,
  AutopilotDecision,
} from '../components/views/tickets/types';
import type { ChatThreadSummary } from '../components/sidebar/types';

export function isTauriEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
  );
}

export async function invokeCommand<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriEnvironment()) {
    throw new Error(
      `[IPC] Command '${cmd}' failed: Kite Code is running in a web browser. Launch Studio inside the native Tauri window via 'npm run tauri dev'.`
    );
  }
  // Only wrap non-empty arguments into `{ request: args }` per specification.
  // Zero-argument commands (like bootstrap and window controls) expect an empty payload.
  const hasArgs = args && Object.keys(args).length > 0;
  const payload = hasArgs ? { request: args } : {};
  try {
    return await tauriInvoke<T>(cmd, payload);
  } catch (err) {
    console.warn(`[IPC] Failed to invoke command ${cmd}:`, err);
    throw err;
  }
}

// Window controls
export const windowControls = {
  minimize: () => invokeCommand<void>('app_window_minimize'),
  toggleMaximize: () => invokeCommand<void>('app_window_toggle_maximize'),
  close: () => invokeCommand<void>('app_window_close'),
  startDragging: () => invokeCommand<void>('app_window_start_dragging'),
  isMaximized: () => invokeCommand<boolean>('app_window_is_maximized'),
};

// Bootstrap
export async function getBootstrap(): Promise<BootstrapResponse> {
  return invokeCommand<BootstrapResponse>('bootstrap');
}

export interface AuthBootstrapResponse {
  schemaVersion: number;
  revision: number;
  phase: { kind: string };
  access: { kind: string };
  user?: { name: string; email: string };
  subscriptionTier?: string;
  features?: Record<string, boolean>;
  includedCredits?: number;
}

export interface PromptSummary {
  id: string;
  title: string;
  content: string;
  createdAtUnixMs?: number;
}

export async function getCreditsBalance(): Promise<{ balance: number; cycleBalance: number } | null> {
  try {
    return await invokeCommand<{ balance: number; cycleBalance: number }>('credits_balance');
  } catch {
    return null;
  }
}

export async function getAuthBootstrap(): Promise<AuthBootstrapResponse | null> {
  try {
    return await invokeCommand<AuthBootstrapResponse>('auth_bootstrap');
  } catch {
    return null;
  }
}

export async function getSubscriptionQuotas(
  force: boolean = false,
  providers?: string[]
): Promise<Record<string, any>> {
  if (!isTauriEnvironment()) {
    try {
      const res = await fetch(`/api/quota${force ? '?force=1' : ''}`);
      if (res.ok) return await res.json();
    } catch (_) {}
    return {};
  }
  try {
    return await invokeCommand<Record<string, any>>('get_subscription_quotas', { force, providers });
  } catch (err) {
    console.warn('[IPC] Failed to fetch subscription quotas:', err);
    return {};
  }
}

export async function saveOpenCodeCookie(cookie: string, workspaceId?: string): Promise<boolean> {
  if (!isTauriEnvironment()) {
    try {
      localStorage.setItem('opencode_go_auth_cookie', cookie);
      if (workspaceId) localStorage.setItem('opencode_go_workspace_id', workspaceId);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return await invokeCommand<boolean>('save_opencode_cookie', { cookie, workspaceId: workspaceId || null });
  } catch (err) {
    console.warn('[IPC] Failed to save OpenCode cookie:', err);
    return false;
  }
}

export async function clearOpenCodeCookie(): Promise<boolean> {
  if (!isTauriEnvironment()) {
    try {
      localStorage.removeItem('opencode_go_auth_cookie');
      localStorage.removeItem('opencode_go_workspace_id');
      return true;
    } catch {
      return false;
    }
  }
  try {
    return await invokeCommand<boolean>('clear_opencode_cookie', {});
  } catch (err) {
    console.warn('[IPC] Failed to clear OpenCode cookie:', err);
    return false;
  }
}

// Workspaces
export async function addWorkspace(): Promise<Workspace | null> {
  return invokeCommand<Workspace | null>('add_workspace', { supportedSchemaVersion: 1 });
}

export async function copyWorkspacePath(workspaceId: string): Promise<string> {
  return invokeCommand<string>('copy_workspace_path', { supportedSchemaVersion: 1, workspaceId });
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('rename_workspace', { supportedSchemaVersion: 1, workspaceId, name });
}

export async function setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('set_workspace_pinned', { supportedSchemaVersion: 1, workspaceId, pinned });
}

export async function removeWorkspace(workspaceId: string): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('remove_workspace_from_list', { supportedSchemaVersion: 1, workspaceId });
}

export async function moveWorkspace(workspaceId: string, toIndex: number): Promise<Workspace[]> {
  return invokeCommand<Workspace[]>('move_workspace', { supportedSchemaVersion: 1, workspaceId, toIndex });
}

// Agents
export async function listAgents(): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('list_agent_profiles');
}

export async function setAgentPinned(agentId: string, pinned: boolean): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('set_agent_pinned', { agentId, pinned });
}

export async function moveAgent(agentId: string, toIndex: number): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('move_agent', { supportedSchemaVersion: 1, agentId, toIndex });
}

export async function deleteAgentProfile(agentId: string): Promise<void> {
  return invokeCommand<void>('delete_agent_profile', { supportedSchemaVersion: 1, agentId });
}

export async function updateAgentProfile(
  agentId: string,
  name: string,
  brief: string,
  engine?: string
): Promise<AgentProfile> {
  return invokeCommand<AgentProfile>('update_agent_profile', {
    agentId,
    name,
    brief,
    engine,
  });
}

// Files
export async function ensureFilesResource(workspaceId: string, resourceId?: string | null): Promise<FilesResourceResponse> {
  return invokeCommand<FilesResourceResponse>('ensure_files_resource', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId: resourceId ?? null,
  });
}

export async function listFilesDirectory(
  workspaceId: string,
  resourceId: string,
  parentEntryId: string
): Promise<FilesDirectoryResponse> {
  return invokeCommand<FilesDirectoryResponse>('list_files_directory', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    parentEntryId,
  });
}

export async function readFilesText(
  workspaceId: string,
  resourceId: string,
  entryId: string
): Promise<FilesTextResponse> {
  return invokeCommand<FilesTextResponse>('read_files_text', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    entryId,
  });
}

export async function saveFilesText(
  workspaceId: string,
  resourceId: string,
  entryId: string,
  revision: string,
  text: string
): Promise<FilesTextResponse> {
  return invokeCommand<FilesTextResponse>('save_files_text', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    entryId,
    expectedRevision: revision,
    text,
  });
}

export async function readFilesPreview(
  workspaceId: string,
  resourceId: string,
  entryId: string
): Promise<FilesPreviewResponse> {
  return invokeCommand<FilesPreviewResponse>('read_files_preview', {
    supportedSchemaVersion: 1,
    workspaceId,
    resourceId,
    entryId,
  });
}

export async function closeFilesResource(resourceId: string): Promise<{ closed: boolean }> {
  return invokeCommand<{ closed: boolean }>('close_files_resource', { resourceId });
}

// Browser Surface
export interface BrowserOwnerRef {
  workspaceId: string;
  paneId: string;
  descriptorId: string;
}

export interface BrowserTargetRef extends BrowserOwnerRef {
  surfaceId: string;
}

export interface BrowserBoundsInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserControlAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'openExternal'
  | 'startDesignMode'
  | 'stopDesignMode';

export async function createBrowserSurface(
  url: string,
  bounds: { x: number; y: number; width: number; height: number },
  visible = true,
  workspaceId: string | null = null,
  surfaceId = 'b0000000-0000-4000-8000-000000000001',
  descriptorId = 'browser-main'
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('create_browser_surface', {
    supportedSchemaVersion: 1,
    owner: {
      scope: 'workspace',
      workspaceId,
      windowLabel: 'main',
      descriptorId,
      surfaceId,
    },
    target: {
      surfaceId,
      descriptorId,
    },
    surfaceId,
    descriptorId,
    url,
    bounds,
    visible,
    designMode: false,
    confirmedByBuilder: true,
  });
}

export async function navigateBrowserSurface(
  surfaceId: string,
  descriptorId: string,
  url: string
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('navigate_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
    url,
  });
}

export async function controlBrowserSurface(
  surfaceId: string,
  descriptorId: string,
  action: string
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('control_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
    action,
  });
}

export async function closeBrowserSurface(
  surfaceId: string,
  descriptorId = 'browser-main'
): Promise<{ closed: true }> {
  return invokeCommand<{ closed: true }>('close_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
  });
}

export async function readBrowserSurface(
  surfaceId: string,
  descriptorId: string
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('read_browser_surface', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
  });
}

export async function updateBrowserSurfacePresentation(
  surfaceId: string,
  descriptorId: string,
  bounds: BrowserBoundsInput,
  visible: boolean
): Promise<BrowserSurfaceView> {
  return invokeCommand<BrowserSurfaceView>('update_browser_surface_presentation', {
    supportedSchemaVersion: 1,
    target: { surfaceId, descriptorId },
    bounds,
    visible,
  });
}

export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

// Chat
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

// Tickets & Tasks
export async function getTicketSnapshot(): Promise<TicketSnapshot> {
  return invokeCommand<TicketSnapshot>('ticket_snapshot');
}

export async function getTaskExecutionSnapshot(): Promise<TaskExecutionSnapshot> {
  return invokeCommand<TaskExecutionSnapshot>('task_execution_snapshot');
}

export async function autopilotNext(ticketId?: string): Promise<AutopilotDecision> {
  return invokeCommand<AutopilotDecision>('autopilot_next', { ticketId });
}

export async function cancelAutopilot(): Promise<{ ok: boolean }> {
  return invokeCommand<{ ok: boolean }>('cancel_autopilot');
}

export async function ticketCall(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<{ ok: boolean; result?: unknown }> {
  return invokeCommand<{ ok: boolean; result?: unknown }>('ticket_call', { tool: action, arguments: payload, action, ...payload });
}

export async function ticketConnect(
  name: string,
  readOnly: boolean
): Promise<Record<string, unknown>> {
  try {
    return await invokeCommand<Record<string, unknown>>('ticket_connect', { name, readOnly });
  } catch {
    return {
      mcpServers: {
        'kite-tasks': {
          command: 'kite-code',
          args: [
            'mcp',
            'tasks',
            ...(readOnly ? ['--read-only'] : []),
            '--connection',
            name.trim() || 'My coding agent',
          ],
        },
      },
    };
  }
}

export async function ticketConfiguration(id: string): Promise<Record<string, unknown>> {
  try {
    return await invokeCommand<Record<string, unknown>>('ticket_configuration', { id });
  } catch {
    return {
      mcpServers: {
        'kite-tasks': {
          command: 'kite-code',
          args: ['mcp', 'tasks', '--connection-id', id],
        },
      },
    };
  }
}

export async function ticketRevoke(id: string): Promise<void> {
  try {
    await invokeCommand<void>('ticket_revoke', { id });
  } catch {
    // Fallback handled in local state
  }
}

export async function ticketRecover(): Promise<void> {
  try {
    await invokeCommand<void>('ticket_recover');
  } catch {
    // Fallback handled in local state
  }
}


// Prompts & Transcripts
export interface PromptItem {
  id: string;
  title: string;
  prompt: string;
  category?: string;
  description?: string;
  content?: string;
  createdAtUnixMs?: number;
}

export async function listPrompts(): Promise<PromptItem[]> {
  return invokeCommand<PromptItem[]>('list_prompts');
}

export async function searchTranscripts(query: string): Promise<{ ok: boolean; matches?: unknown[] }> {
  return invokeCommand<{ ok: boolean; matches?: unknown[] }>('search_transcripts', { query });
}

export async function saveShellState(state: Record<string, unknown>): Promise<{ saved: boolean }> {
  return invokeCommand<{ saved: boolean }>('save_shell_state', { state });
}

// Agents & Mind
export async function listAgentProfiles(): Promise<AgentProfile[]> {
  return invokeCommand<AgentProfile[]>('list_agent_profiles');
}

export async function loadAgentMind(agentId: string): Promise<AgentMindSnapshot> {
  return invokeCommand<AgentMindSnapshot>('load_agent_mind', { agentId });
}

export async function writeAgentMemory(
  agentId: string,
  target: 'memory' | 'user',
  text: string,
  editKind = 'structured',
  expectedRevision: string | null = null,
  confirmedByBuilder = true
): Promise<AgentMindSnapshot> {
  return invokeCommand<AgentMindSnapshot>('write_agent_memory', {
    agentId,
    target,
    text,
    editKind,
    expectedRevision,
    confirmedByBuilder,
  });
}

export async function loadAgentSkill(agentId: string, skillId: string): Promise<LearnedSkillDocument> {
  return invokeCommand<LearnedSkillDocument>('load_agent_skill', { agentId, skillId });
}

export async function writeAgentSkill(
  agentId: string,
  skillId: string,
  source: string,
  expectedRevision: string,
  confirmedByBuilder = true
): Promise<AgentMindSnapshot> {
  return invokeCommand<AgentMindSnapshot>('write_agent_skill', {
    agentId,
    skillId,
    source,
    expectedRevision,
    confirmedByBuilder,
  });
}

export async function removeAgentSkill(
  agentId: string,
  skillId: string,
  expectedRevision: string,
  confirmedByBuilder = true
): Promise<{ removed: boolean; mind: AgentMindSnapshot }> {
  return invokeCommand<{ removed: boolean; mind: AgentMindSnapshot }>('remove_agent_skill', {
    agentId,
    skillId,
    expectedRevision,
    confirmedByBuilder,
  });
}

export async function listAgentStarters(supportedCatalogVersion = 1): Promise<StarterSummary[]> {
  return invokeCommand<StarterSummary[]>('list_agent_starters', { supportedCatalogVersion });
}

export async function installAgentStarter(
  agentId: string,
  starterId: string,
  confirmedByBuilder = true
): Promise<{ installed: boolean; mind: AgentMindSnapshot }> {
  return invokeCommand<{ installed: boolean; mind: AgentMindSnapshot }>('install_agent_starter', {
    agentId,
    starterId,
    confirmedByBuilder,
  });
}

// ==========================================
// Git & Workspace Changes
// ==========================================

export type WorkspaceFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface WorkspaceFileChange {
  path: string;
  status: WorkspaceFileStatus;
  oldPath: string | null;
  staged: boolean;
  unstaged: boolean;
}

export interface WorkspaceChanges {
  isRepo: boolean;
  branch: string | null;
  files: WorkspaceFileChange[];
  workspacePrefix: string;
  upstream: { ahead: number; behind: number } | null;
}

export type DiffLineKind = 'context' | 'added' | 'removed' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

export interface WorkspaceFileDiff {
  lines: DiffLine[];
  truncated: boolean;
}

export async function readWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('read_workspace_changes', { workspaceId });
}

export async function readWorkspaceFileDiff(
  workspaceId: string,
  path: string,
  untracked = false
): Promise<WorkspaceFileDiff> {
  return invokeCommand<WorkspaceFileDiff>('read_workspace_file_diff', { workspaceId, path, untracked });
}

export async function stageWorkspaceChanges(
  workspaceId: string,
  paths: string[]
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('stage_workspace_changes', { workspaceId, paths });
}

export async function stageAllWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('stage_all_workspace_changes', { workspaceId });
}

export async function unstageWorkspaceChanges(
  workspaceId: string,
  paths: string[]
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('unstage_workspace_changes', { workspaceId, paths });
}

export async function discardWorkspaceChanges(
  workspaceId: string,
  paths: string[]
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('discard_workspace_changes', { workspaceId, paths });
}

export async function commitWorkspaceChanges(
  workspaceId: string,
  message: string,
  stageAll = false
): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('commit_workspace_changes', { workspaceId, message, stageAll });
}

export async function pullWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('pull_workspace_changes', { workspaceId });
}

export async function pushWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
  return invokeCommand<WorkspaceChanges>('push_workspace_changes', { workspaceId });
}

// ── Account Switcher & Agent Handoff IPC ─────────────────────────────

export async function listSavedAccounts(provider?: string): Promise<SavedAccountProfile[]> {
  try {
    const res = await invokeCommand<{ schemaVersion: number; profiles: SavedAccountProfile[] }>('list_saved_accounts', { provider });
    return res?.profiles || [];
  } catch (err) {
    console.warn('[IPC] listSavedAccounts failed:', err);
    return [];
  }
}

export async function saveCurrentAccountProfile(
  provider: string,
  label: string
): Promise<{ success: boolean; profile?: SavedAccountProfile; error?: string }> {
  try {
    return await invokeCommand('save_current_account_profile', { provider, label });
  } catch (err: any) {
    console.error('[IPC] saveCurrentAccountProfile failed:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

export async function switchAccountProfile(
  provider: string,
  accountId: string
): Promise<{ success: boolean; profile?: SavedAccountProfile; error?: string }> {
  try {
    return await invokeCommand('switch_account_profile', { provider, accountId });
  } catch (err) {
    console.error('[IPC] switchAccountProfile failed:', err);
    return { success: false, error: String(err) };
  }
}

export async function deleteAccountProfile(
  provider: string,
  accountId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return await invokeCommand('delete_account_profile', { provider, accountId });
  } catch (err) {
    console.error('[IPC] deleteAccountProfile failed:', err);
    return { success: false, error: String(err) };
  }
}

export async function getActiveAccountProfile(
  provider: string
): Promise<{ found: boolean; profile?: SavedAccountProfile }> {
  try {
    return await invokeCommand('get_active_account_profile', { provider });
  } catch (err) {
    console.warn('[IPC] getActiveAccountProfile failed:', err);
    return { found: false };
  }
}

export async function recommendContinuationTargets(
  currentProvider: string
): Promise<{ currentProvider: string; suggestions: ContinuationSuggestion[] }> {
  try {
    return await invokeCommand('recommend_continuation_targets', { currentProvider });
  } catch (err) {
    console.warn('[IPC] recommendContinuationTargets failed:', err);
    return { currentProvider, suggestions: [] };
  }
}

export async function getHandoffPreview(
  threadId: string,
  fromProvider: string,
  partialText?: string
): Promise<{ handoffPrompt: string }> {
  try {
    return await invokeCommand('get_handoff_preview', { threadId, fromProvider, partialText });
  } catch (err) {
    console.warn('[IPC] getHandoffPreview failed:', err);
    return { handoffPrompt: '' };
  }
}

export async function continueTurnWithHandoff(
  threadId: string,
  targetProvider: string,
  targetAccountId?: string,
  customHandoffPrompt?: string
): Promise<any> {
  return await invokeCommand('continue_turn_with_handoff', {
    threadId,
    targetProvider,
    targetAccountId,
    customHandoffPrompt,
  });
}

export async function getSystemMetrics(): Promise<Record<string, any> | null> {
  if (!isTauriEnvironment()) {
    try {
      const res = await fetch('/api/tauri/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'get_system_metrics', args: {} }),
      });
      if (res.ok) return await res.json();
    } catch (_) {}
    return null;
  }
  try {
    return await invokeCommand<Record<string, any>>('get_system_metrics');
  } catch (err) {
    console.warn('[IPC] getSystemMetrics failed:', err);
    return null;
  }
}

export async function listGoogleAccounts(): Promise<{ active: string | null; accounts: string[] }> {
  try {
    return await invokeCommand<{ active: string | null; accounts: string[] }>('antigravity_list_google_accounts');
  } catch (err) {
    console.warn('[IPC] listGoogleAccounts failed:', err);
    return { active: null, accounts: [] };
  }
}

export async function setActiveGoogleAccount(email: string): Promise<{ success: boolean; active: string; accounts: string[] }> {
  return await invokeCommand<{ success: boolean; active: string; accounts: string[] }>('antigravity_set_active_google_account', { email });
}
