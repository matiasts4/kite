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
    defaultModel: 'gemini-4-argon',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    supportsEffort: true,
    isDynamic: true,
    models: [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', description: 'Frontier reasoning & agentic coding (Google DeepMind)', supportsEffort: true },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: 'Ultra-fast, lightweight agentic execution (Google DeepMind)', supportsEffort: true },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: 'Frontier reasoning for long-horizon agentic work (Anthropic)', supportsEffort: true },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', description: 'Balanced high-speed coding & design (Anthropic)', supportsEffort: true },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', description: 'Open-weights 120B parameter model hosted on Antigravity', supportsEffort: false },
    ],
  },
  claude: {
    label: 'Claude Code',
    vendor: 'Anthropic',
    engineId: 'claude-code',
    defaultModel: 'sonnet',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    supportsEffort: true,
    models: [
      { id: 'sonnet', name: 'Claude Sonnet 5', description: 'Balanced daily driver', supportsEffort: true },
      { id: 'opus', name: 'Claude Opus (latest)', description: 'Latest Opus release', supportsEffort: true },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: 'Long-running agentic work', supportsEffort: true },
      { id: 'fable', name: 'Claude Fable 5.1', description: 'Hardest problems', supportsEffort: true },
      { id: 'haiku', name: 'Claude Haiku 4.5', description: 'Fastest replies', supportsEffort: false },
    ],
  },
  codex: {
    label: 'Codex',
    vendor: 'OpenAI',
    engineId: 'codex',
    defaultModel: 'gpt-5.6-sol',
    modes: ['readOnly', 'acceptEdits'],
    supportsEffort: true,
    models: [
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', description: 'Most capable for complex work', supportsEffort: true },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol', description: 'Complex coding and agentic work', supportsEffort: true },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', description: 'Fast, efficient work', supportsEffort: false },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: 'Frontier agentic work', supportsEffort: true },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'Balanced agentic work', supportsEffort: true },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: 'Fast, efficient work', supportsEffort: false },
    ],
  },
  grok: {
    label: 'Grok Build',
    vendor: 'xAI',
    engineId: 'grok',
    defaultModel: 'grok-build',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    models: [
      { id: 'grok-4.7', name: 'Grok 4.7', description: 'xAI Grok default model', supportsEffort: true },
      { id: 'grok-4.7-build-fast', name: 'Grok 4.7 Build Fast', description: 'Fast agentic build model', supportsEffort: true },
      { id: 'grok-4.6', name: 'Grok 4.6', description: 'Previous Grok model', supportsEffort: true },
      { id: 'grok-4.5', name: 'Grok 4.5', description: 'Legacy Grok model', supportsEffort: true },
    ],
    isDynamic: true,
    supportsEffort: true,
  },
  opencode: {
    label: 'OpenCode',
    vendor: 'OpenCode',
    engineId: 'open-code',
    defaultModel: 'auto',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    models: [{ id: 'auto', name: 'Auto', description: 'OpenCode default model' }],
    isDynamic: true,
  },
  cursor: {
    label: 'Cursor Agent',
    vendor: 'Cursor',
    engineId: 'cursor',
    defaultModel: 'auto',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    models: [
      { id: 'auto', name: 'Auto', description: 'Cursor picks a model' },
    ],
    isDynamic: true,
  },
  gemini: {
    label: 'Gemini CLI',
    vendor: 'Google',
    engineId: 'gemini',
    defaultModel: 'gemini-2.5-pro',
    modes: ['readOnly', 'acceptEdits', 'fullAccess'],
    supportsEffort: true,
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Deep reasoning & coding', supportsEffort: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast agentic execution', supportsEffort: false },
    ],
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
