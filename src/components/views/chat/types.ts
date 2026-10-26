import type { ChatThread } from '../../../types';
import type { ProposedPlan } from './ChatPlanPanel';

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
}

export interface EffortChoice {
  id: string;
  label: string;
  detail?: string;
}

export const DEFAULT_EFFORT_CHOICES: EffortChoice[] = [
  { id: 'low', label: 'Low', detail: 'Faster replies with focused thinking' },
  { id: 'medium', label: 'Medium', detail: 'Balanced reasoning for everyday coding' },
  { id: 'high', label: 'High', detail: 'Deep multi-step reasoning and verification' },
];

export interface ExtendedChatThread extends ChatThread {
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
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  supportsEffort?: boolean;
}

export interface LiveChatRun {
  threadId: string;
  profileId: string | null;
  workspaceId: string | null;
  provider: string;
  title: string;
  needsYou: boolean;
  startedAtUnixMs: number;
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
