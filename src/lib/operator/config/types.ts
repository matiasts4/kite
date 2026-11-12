export type OperatorProviderId = 'opencode' | 'vercel' | 'cloudflare' | 'antigravity' | 'grok' | 'local';

export type OperatorTaskType =
  | 'open_terminals'
  | 'close_terminals'
  | 'inject_prompt'
  | 'spawn_subagent'
  | 'open_browser'
  | 'narrate_summary'
  | 'verify_odd'
  | 'multi_action'
  | 'chat_response'
  | 'healthcheck';

export type ZedTone = 'calm' | 'crisp' | 'warm' | 'direct' | 'chill';
export type ZedBrevity = 'one-breath' | 'normal' | 'thorough' | 'tight' | 'detailed';
export type ZedAfterCallMode =
  | 'summary+decisions'
  | 'decisions'
  | 'transcript'
  | 'summary'
  | 'nothing';

export interface OpenCodeModelOption {
  id: string;
  label: string;
  badge: string;
  tier: string;
  description: string;
}

export interface ZedPersonaConfig {
  name: string;
  voice: string;
  tone: ZedTone;
  brevity: ZedBrevity;
  language: string;
  builderCallMe: string;
  standingInstructions: string;
  rememberBetweenCalls: boolean;
  afterCallMode: ZedAfterCallMode;
}

export interface OperatorProviderConfig {
  activeProvider: OperatorProviderId;
  // OpenCode Go subscription (HTTP OpenAI-compatible gateway)
  opencodeApiKey: string;
  opencodeBaseUrl: string;
  opencodeModel: string;
  /** Stable x-opencode-session value used by the Go inference gateway. */
  opencodeSessionId: string;
  // Vercel AI Gateway / SDK
  vercelApiKey: string;
  vercelBaseUrl: string;
  vercelModel: string;
  // Cloudflare Workers AI / AI Gateway
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  cloudflareGatewaySlug: string;
  cloudflareBaseUrl: string;
  cloudflareModel: string;
  // Antigravity subscription CLI / local relay
  antigravityModel: string;
  antigravityCommand: string;
  // Grok subscription CLI / API
  grokApiKey: string;
  grokBaseUrl: string;
  grokModel: string;
  grokUseCliSubscription: boolean;
  // Grok Cloud Voice Transcription
  grokTranscriptionApiKey?: string;
  grokTranscriptionBaseUrl?: string;
  grokTranscriptionModel?: string;
  // Voice & TTS preferences
  ttsEnabled: boolean;
  ttsLanguage: string;
  ttsRate: number;
  ttsEngine?: 'browser' | 'elevenlabs';
  elevenlabsApiKey?: string;
  elevenlabsModel?: string;
  elevenlabsVoiceId?: string;
  elevenlabsStability?: number;
  elevenlabsSimilarity?: number;
  // Zed Persona & Memory settings
  persona: ZedPersonaConfig;
}

export type OperatorConfig = OperatorProviderConfig;

export interface ZedMemoryNote {
  id: string;
  content: string;
  createdAt: string;
  workspace?: string;
}

export interface LatencyRecord {
  id: string;
  provider: OperatorProviderId;
  model: string;
  taskType: OperatorTaskType | string;
  latencyMs: number;
  timestamp: number;
  success: boolean;
  notes?: string;
}

export interface ProviderLatencySummary {
  provider: OperatorProviderId;
  model: string;
  sampleCount: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  successRate: number;
  byTask: Partial<Record<string, { count: number; avgMs: number; lastMs: number }>>;
}

export interface TaskLatencySummaryRow {
  providerId: OperatorProviderId;
  taskType: string;
  count: number;
  lastMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  successRate: number;
}

export type ModelCatalogProvider = 'opencode' | 'vercel' | 'cloudflare';

export interface ModelCatalogSnapshot {
  models: OpenCodeModelOption[];
  savedAt: string;
}

export interface ModelCatalogFetchResult {
  models: OpenCodeModelOption[];
  fresh: boolean;
  savedAt: string | null;
  detail: string;
}
