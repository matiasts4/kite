export interface Workspace {
  id: string;
  displayName: string;
  createdAtUnixMs: number;
  lastOpenedAtUnixMs: number;
  pinned: boolean;
  available: boolean;
}

export interface AgentProfile {
  id: string;
  name: string;
  engine: string;
  purpose: string;
  avatar: string | null;
  createdAtUnixMs: number;
  pinned: boolean;
  order: number;
  disabledPluginIds?: string[];
}

export interface BootstrapResponse {
  browserDocumentToken: string;
  schemaVersion: number;
  persistenceReadOnly: boolean;
  recoveryNotices: string[];
  preferences: {
    schemaVersion: number;
    workMode: string;
    route: { kind: string };
    selectedWorkspaceId: string;
    selectedAgentId: string;
    sidebarVisible: boolean;
    appearance: string;
    zoomPercent: number;
    terminalPreference: { kind: string };
    usageMeter: {
      showPlanUsage: boolean;
      showPaneContext: boolean;
    };
    darkTheme: string;
    lightTheme: string;
    quitBehavior: string;
  };
  workspaces: Workspace[];
  agents: AgentProfile[];
}

export interface FilesEntry {
  entryId: string;
  displayName: string;
  kind: 'directory' | 'file';
  byteSize?: number;
}

export interface FilesDirectoryResponse {
  schemaVersion: number;
  resourceId: string;
  parentEntryId: string;
  entries: FilesEntry[];
}

export interface FilesResourceResponse {
  schemaVersion: number;
  resourceId: string;
  root: FilesEntry;
}

export interface FilesTextResponse {
  schemaVersion: number;
  resourceId: string;
  entryId: string;
  revision?: string;
  encoding?: string;
  lineEnding?: string;
  editable?: boolean;
  text: string;
}

export interface FilesPreviewResponse {
  schemaVersion: number;
  resourceId: string;
  entryId: string;
  mime: string;
  base64: string;
}

export interface BrowserSurfaceView {
  schemaVersion: number;
  surfaceId: string;
  descriptorId: string;
  revision: number;
  displayUrl: string;
  transportSecurity: 'secure' | 'local' | 'insecure';
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  designMode: boolean;
}

export interface SubagentMeta {
  subagentId: string;
  action: 'spawn' | 'define' | 'message' | 'manage' | string;
  role: string;
  typeName?: string | null;
  provider?: string | null;
  model?: string | null;
  workspaceMode?: 'inherit' | 'share' | 'branch' | string | null;
  prompt?: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | string;
  transcriptUri?: string | null;
  childThreadId?: string | null;
  swarmMemberName?: string | null;
  latestActivity?: string | null;
  stepCount: number;
}

export interface SwarmMeta {
  swarmId?: string | null;
  action: 'title' | 'add' | 'post_message' | 'read_board' | 'wait' | 'status' | 'model' | 'kill' | 'channel' | string;
  swarmTitle?: string | null;
  channel?: string | null;
  memberName?: string | null;
  memberNames?: string[];
  model?: string | null;
  workspaceMode?: 'inherit' | 'share' | 'branch' | string | null;
  brief?: string | null;
  postText?: string | null;
  seq?: number | null;
  mentions?: string[];
}

export interface SubagentRun {
  subagentId: string;
  parentThreadId: string;
  parentToolCallId: string;
  role: string;
  typeName?: string | null;
  provider?: string | null;
  model?: string | null;
  workspaceMode?: 'inherit' | 'share' | 'branch' | string | null;
  prompt?: string | null;
  status: string;
  transcriptUri?: string | null;
  childThreadId?: string | null;
  swarmMemberName?: string | null;
  latestActivity?: string | null;
  stepCount: number;
  items: ChatItem[];
  startedAtUnixMs: number;
  updatedAtUnixMs: number;
  completedAtUnixMs?: number | null;
}

export interface SwarmMember {
  name: string;
  role: string;
  provider?: string | null;
  model?: string | null;
  workspaceMode?: 'inherit' | 'share' | 'branch' | string | null;
  state: 'waiting' | 'working' | 'stopped' | 'killed' | string;
  currentActivity?: string | null;
  channels: string[];
  subagentId?: string | null;
  childThreadId?: string | null;
  brief?: string | null;
}

export interface SwarmBoardPost {
  seq: number;
  author: string;
  channel: string;
  text: string;
  mentions: string[];
  createdAtUnixMs: number;
}

export interface SwarmChannel {
  name: string;
  topic?: string | null;
  archived?: boolean;
}

export interface SwarmState {
  swarmId: string;
  title: string;
  coordinatorModel?: string | null;
  members: SwarmMember[];
  posts: SwarmBoardPost[];
  channels: SwarmChannel[];
}

export interface ChatThread {
  schemaVersion: number;
  revision: string;
  id: string;
  profileId: string | null;
  provider: 'claude' | 'codex' | 'cursor' | 'grok' | 'opencode' | 'antigravity' | 'gemini';
  providerSessionId?: string | null;
  title: string;
  items: ChatItem[];
  mode: 'acceptEdits' | 'fullAccess' | 'readOnly';
  plan: boolean;
  model: string | null;
  status: 'idle' | 'running' | 'waiting' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationSeconds?: number;
  };
  workspaceId: string | null;
  pinned: boolean;
  parentThreadId?: string | null;
  parentToolCallId?: string | null;
  startedByAgent?: boolean;
  sideChat?: boolean;
  subagentRole?: string | null;
  workspaceMode?: 'inherit' | 'share' | 'branch' | string | null;
  swarmId?: string | null;
  swarmMemberName?: string | null;
  subagentRuns?: SubagentRun[];
  swarmState?: SwarmState | null;
  quotaHandoffOffer?: QuotaHandoffOffer | null;
  sessionState?: string;
  isWarm?: boolean;
  isSettled?: boolean;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface ChatItem {
  id: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'command' | 'error' | 'note' | 'quotaHandoff';
  text: string;
  title: string | null;
  detail: string | null;
  status: 'inProgress' | 'running' | 'pending' | 'completed' | 'failed' | 'ready' | null;
  streaming: boolean;
  exitCode: number | null;
  createdAtUnixMs: number;
  attachments: unknown[];
  handoffOffer?: QuotaHandoffOffer;
  toolName?: string | null;
  toolKind?: 'commandExecution' | 'fileChange' | 'mcpToolCall' | 'webSearch' | 'dynamicToolCall' | 'planUpdate' | 'subagent' | 'swarm' | string | null;
  serverName?: string | null;
  command?: string | null;
  filePath?: string | null;
  addedLines?: number | null;
  removedLines?: number | null;
  durationSeconds?: number | null;
  subagentMeta?: SubagentMeta | null;
  swarmMeta?: SwarmMeta | null;
  parentToolUseId?: string | null;
}

export interface NotificationRecord {
  id: string;
  runId?: string;
  target?: {
    source: 'agentChat' | 'codeThread' | 'codeTerminal' | 'task' | string;
    id: string;
  };
  profileId?: string | null;
  routineId?: string | null;
  kind?: {
    kind: 'settled' | 'needsInput' | string;
    outcome?: 'completed' | 'failed' | 'cancelled' | string;
    requestKind?: 'toolApproval' | 'question' | 'unknown' | string;
  };
  resolution?: 'answered' | 'attended' | 'runSettled' | 'abandoned' | string | null;
  createdAtUnixMs: number;
  isRead: boolean;
  isWaitingForInput?: boolean;
}

export interface NotificationsSnapshot {
  schemaVersion: number;
  revision: number;
  records: NotificationRecord[];
  unreadCount: number;
  openInputRequestCount: number;
  authorization: string;
  preferences: {
    schemaVersion: number;
    osNotificationsEnabled: boolean;
    finishSoundEnabled: boolean;
    inputRequestsEnabled: boolean;
  };
  archiveReadOnly: boolean;
  openRecordId: string | null;
}

export type RoutineCadence =
  | { kind: 'interval'; seconds: number }
  | { kind: 'clock'; hour: number; minute: number; weekdays: number[] | null };

export interface RoutineItem {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cadence: RoutineCadence;
  enabled: boolean;
  author: 'builder' | 'agent';
  workspaceId: string | null;
  createdAtUnixMs: number;
  nextRunAtUnixMs: number;
  lastRunAtUnixMs: number | null;
  lastRunThreadId: string | null;
  lastError: string | null;
}

export interface RoutineCollection {
  schemaVersion: number;
  routines: RoutineItem[];
  agentRevisions: Array<{ agentId: string; revision: string }>;
  runNowAvailability: {
    available: boolean;
    reason: string;
  };
}

export interface SavedAccountProfile {
  id: string;
  provider: string;
  label: string;
  email: string | null;
  planName: string | null;
  isActive: boolean;
  lastUsedUnixMs: number;
  primaryRemainingPercent: number | null;
  primaryResetAt: string | null;
  timeUntilResetMs: number | null;
}

export interface ContinuationSuggestion {
  kind: 'account' | 'provider';
  id: string;
  provider: string;
  title: string;
  subtitle: string;
  remainingPercent: number;
  resetAt: string | null;
  isRecommended: boolean;
}

export interface QuotaHandoffOffer {
  failedProvider: string;
  reason: string;
  partialOutput: string;
  handoffPrompt: string;
  suggestions: ContinuationSuggestion[];
  offeredAtUnixMs: number;
}

