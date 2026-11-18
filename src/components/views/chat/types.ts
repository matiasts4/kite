import type {
  ChatThread,
  SubagentMeta,
  SwarmMeta,
  SubagentRun,
  SwarmMember,
  SwarmBoardPost,
  SwarmChannel,
  SwarmState,
} from '../../../types';
import type { ProposedPlan } from './ChatPlanPanel';

export type {
  SubagentMeta,
  SwarmMeta,
  SubagentRun,
  SwarmMember,
  SwarmBoardPost,
  SwarmChannel,
  SwarmState,
};

export type ChatProvider = 'claude' | 'codex' | 'cursor' | 'grok' | 'opencode' | 'antigravity' | 'gemini';
export type ChatMode = 'acceptEdits' | 'fullAccess' | 'readOnly';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  title: string;
  detail: string | null;
  risk: string;
  impact: string;
}

export interface DiffLine {
  kind: 'context' | 'added' | 'removed' | 'hunk' | 'meta';
  oldNumber?: number | null;
  newNumber?: number | null;
  text: string;
}

export interface DiffData {
  lines: DiffLine[];
  truncated?: boolean;
  rawPatch?: string | null;
}

export interface EffortChoice {
  id: string;
  label: string;
  detail?: string;
}

export const EFFORT_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Very High',
  'extra-high': 'Very High',
  'very-high': 'Very High',
  max: 'Max',
  ultra: 'Ultra',
};

export const EFFORT_DETAILS: Record<string, string> = {
  none: 'No extra reasoning budget',
  minimal: 'Fastest minimal reasoning for direct answers',
  low: 'Quick responses with focused reasoning',
  medium: 'Balanced reasoning for everyday tasks',
  high: 'Deep reasoning and thorough analysis',
  xhigh: 'Intensive multi-step reasoning and verification',
  'extra-high': 'Intensive multi-step reasoning and verification',
  'very-high': 'Intensive multi-step reasoning and verification',
  max: 'Maximum compute budget and formal verification',
  ultra: 'Ultra reasoning pushed to the model ceiling',
};

export const DEFAULT_EFFORT_CHOICES: EffortChoice[] = [
  { id: 'low', label: 'Low', detail: 'Quick responses with focused reasoning' },
  { id: 'medium', label: 'Medium', detail: 'Balanced reasoning for everyday tasks' },
  { id: 'high', label: 'High', detail: 'Deep reasoning and thorough analysis' },
];

export interface ExtendedChatThread extends ChatThread {
  hasContent?: boolean;
  pendingApproval?: ApprovalRequest | null;
  effort?: string | null;
  agent?: string | null;
  workMode?: string | null;
  diff?: DiffData | null;
  plans?: ProposedPlan[];
  activePlanId?: string | null;
  activePlan?: ProposedPlan | null;
  /** Connection the next send binds to, when that connection verified the
   * provider's local spawn endpoint. Both fields are set together or not at all. */
  connectionId?: string | null;
  supportedEndpoint?: string | null;
  /** Set when the user stopped the turn. Cleared when the next turn starts. */
  stoppedByBuilder?: boolean;
  turnFailure?: {
    kind: 'usageLimit' | 'authRequired' | 'cliUsageError' | 'processError';
    message: string;
    resetAtUnixMs?: number | null;
    provider?: string;
  } | null;
  snoozedUntil?: number | null;
  isolatedCheckout?: boolean;
  providerCanRewind?: boolean;
  parentThreadId?: string | null;
  startedByAgent?: boolean;
  sideChat?: boolean;
  usageReported?: boolean;
  contextWindowTokens?: number;
  queuedRuns?: QueuedRunItem[];
  pendingUserInput?: {
    requestId?: string;
    questions?: Array<{
      id: string;
      header: string;
      options: string[];
      allowCustomAnswer?: boolean;
      allowAttachments?: boolean;
      multiSelect?: boolean;
    }>;
  } | null;
}

export function getActivePlan(thread: ExtendedChatThread): ProposedPlan | null {
  if (thread.activePlan) return thread.activePlan;
  if (thread.plans && thread.activePlanId) {
    return thread.plans.find((p) => p.id === thread.activePlanId) ?? null;
  }
  return null;
}

export interface ChatAttachment {
  resourceId: string;
  displayName: string;
  isDirectory: boolean;
  byteSize: number | null;
  mimeType?: string | null;
  path?: string | null;
  previewDataUrl?: string | null;
}

export interface QueuedRunItem {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  createdAtUnixMs?: number;
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  supportsEffort?: boolean;
  effortLevels?: (EffortChoice | string)[];
  defaultEffort?: string | null;
}

export interface LiveChatRun {
  runId?: string;
  threadId: string;
  profileId: string | null;
  workspaceId: string | null;
  provider: string;
  title: string;
  needsYou: boolean;
  startedAtUnixMs: number;
  nextSequence?: number;
  line: string | null;
}

/** Sentinel row for "let the connected program choose". Never a CLI model id. */
export const AUTOMATIC_MODEL_ID = 'automatic';

export const PROVIDER_CATALOG: Record<
  ChatProvider,
  {
    label: string;
    vendor: string;
    engineId?: string;
    defaultModel: string;
    modes: ChatMode[];
    models: ModelOption[];
    isDynamic?: boolean;
    supportsEffort?: boolean;
  }
> = {
  antigravity: {
    label: 'Antigravity',
    vendor: 'Google DeepMind',
    engineId: 'antigravity',
    defaultModel: '',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    isDynamic: true,
    models: [],
  },
  claude: {
    label: 'Claude Code',
    vendor: 'Anthropic',
    engineId: 'claude-code',
    defaultModel: '',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    isDynamic: true,
    models: [],
  },
  codex: {
    label: 'Codex',
    vendor: 'OpenAI',
    engineId: 'codex',
    defaultModel: '',
    modes: ['readOnly', 'acceptEdits'],
    isDynamic: true,
    models: [],
  },
  grok: {
    label: 'Grok Build',
    vendor: 'xAI',
    engineId: 'grok',
    defaultModel: '',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    isDynamic: true,
    models: [],
  },
  opencode: {
    label: 'OpenCode',
    vendor: 'OpenCode',
    engineId: 'open-code',
    defaultModel: '',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    isDynamic: true,
    models: [],
  },
  cursor: {
    label: 'Cursor Agent',
    vendor: 'Cursor',
    engineId: 'cursor',
    defaultModel: '',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    isDynamic: true,
    models: [],
  },
  gemini: {
    label: 'Gemini CLI',
    vendor: 'Google',
    engineId: 'gemini',
    defaultModel: '',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    isDynamic: true,
    models: [],
  },
};

export function engineToChatProvider(engine?: string | null): ChatProvider {
  const raw = (engine || '').toLowerCase().trim();
  switch (raw) {
    case 'claude':
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'grok':
      return 'grok';
    case 'open-code':
    case 'opencode':
      return 'opencode';
    case 'cursor':
      return 'cursor';
    case 'gemini':
      return 'gemini';
    case 'antigravity':
    case 'agy':
    default:
      return 'antigravity';
  }
}

export const MODE_LABELS: Record<ChatMode, { title: string; detail: string; execution: string }> = {
  readOnly: { title: 'Plan (Read only)', detail: 'Reads and plans, changes nothing', execution: 'plan' },
  acceptEdits: { title: 'Auto-accept edits', detail: 'Edits apply; everything else asks', execution: 'acceptEdits' },
  fullAccess: { title: 'Full access', detail: 'A turn runs to the end without asking', execution: 'fullAccess' },
};

export function formatTokens(num: number): string {
  if (!num) return '0 tokens';
  if (num < 1000) return `${num} tokens`;
  return `${(num / 1000).toFixed(1)}k tokens`;
}

export function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
