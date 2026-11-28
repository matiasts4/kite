export type OperatorProviderId = 'opencode' | 'vercel' | 'cloudflare' | 'antigravity' | 'grok' | 'local';
export type RealtimeProviderId = 'xai' | 'gemini_live' | 'openai';

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

export type ArgosTone = 'calm' | 'crisp' | 'warm' | 'direct' | 'chill';
export type ArgosBrevity = 'one-breath' | 'normal' | 'thorough' | 'tight' | 'detailed';
export type ArgosAfterCallMode =
  | 'summary+decisions'
  | 'decisions'
  | 'transcript'
  | 'summary'
  | 'nothing';

export type ArgosFigureId =
  | 'plasma-orb'
  | 'ferrofluid'
  | 'frosted-sphere'
  | 'eclipse-halo'
  | 'silk-wave'
  | 'crystal-prism'
  | 'orbital-gyro'
  | 'chromatic-pearl';

export interface ArgosFigureDescriptor {
  id: ArgosFigureId;
  label: string;
  blurb: string;
  shaderMode: number;
  resourceTier: 'optimized' | 'balanced';
  resourceLabel: string;
}

// Backward-compatible Zed* type aliases
export type ZedTone = ArgosTone;
export type ZedBrevity = ArgosBrevity;
export type ZedAfterCallMode = ArgosAfterCallMode;
export type ZedFigureId = ArgosFigureId;
export type ZedFigureDescriptor = ArgosFigureDescriptor;

export interface OpenCodeModelOption {
  id: string;
  label: string;
  badge: string;
  tier: string;
  description: string;
}

export interface ArgosPersonaConfig {
  name: string;
  voice: string;
  tone: ArgosTone;
  brevity: ArgosBrevity;
  language: string;
  builderCallMe: string;
  standingInstructions: string;
  rememberBetweenCalls: boolean;
  afterCallMode: ArgosAfterCallMode;
  figure?: ArgosFigureId;
}

export type ZedPersonaConfig = ArgosPersonaConfig;

export interface OperatorProviderConfig {
  updatedAtMs?: number;
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
  // Offline STT & Realtime Transport
  offlineSttEngine?: 'auto' | 'whisper' | 'parakeet' | 'disabled';
  offlineSttModelPath?: string;
  voiceTransportMode?: 'cascaded' | 'realtime';
  realtimeProvider?: RealtimeProviderId;
  realtimeEndpoint?: string;
  geminiLiveApiKey?: string;
  openaiRealtimeApiKey?: string;
  voiceIdleTimeoutSec?: number;
  voiceVolume?: number;
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

export interface ArgosMemoryNote {
  id: string;
  content: string;
  createdAt: string;
  workspace?: string;
}

export type ZedMemoryNote = ArgosMemoryNote;

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

export type ModelCatalogProvider = 'opencode' | 'vercel' | 'cloudflare' | 'antigravity';

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
