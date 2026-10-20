import { isTauriEnvironment, invokeCommand } from '../ipc';
import { legacyOperatorMemoryNotesStorageKey } from '../kiteLegacyIds';

export type OperatorProviderId = 'opencode' | 'vercel' | 'cloudflare' | 'antigravity' | 'grok' | 'local';

interface ProxyHttpResponse {
  success: boolean;
  status: number;
  body: string;
  latency_ms: number;
  error?: string | null;
}

export async function operatorHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauriEnvironment()) {
    try {
      const method = init?.method || 'GET';
      const headersRecord: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            headersRecord[k] = v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) {
            headersRecord[k] = v;
          }
        } else {
          Object.assign(headersRecord, init.headers);
        }
      }

      let bodyStr: string | null = null;
      if (typeof init?.body === 'string') {
        bodyStr = init.body;
      } else if (init?.body) {
        bodyStr = String(init.body);
      }

      const proxyRes = await invokeCommand<ProxyHttpResponse>('proxy_operator_http', {
        url,
        method,
        headers: headersRecord,
        body: bodyStr,
        timeoutSecs: 60,
      });

      if (proxyRes) {
        return new Response(proxyRes.body || '', {
          status: proxyRes.status || (proxyRes.success ? 200 : 500),
          statusText: proxyRes.error || (proxyRes.success ? 'OK' : 'Proxy Error'),
          headers: new Headers({
            'Content-Type': 'application/json',
            'X-Proxy-Latency-Ms': String(proxyRes.latency_ms || 0),
          }),
        });
      }
    } catch {
      // Fallback to standard fetch if proxy command encounters an issue
    }
  }

  return fetch(url, init);
}

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

export const OPENCODE_MODEL_CATALOG: OpenCodeModelOption[] = [
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash (via OpenCode)',
    badge: 'Ultra-Fast',
    tier: 'Ultra-Fast',
    description: 'Baja latencia ideal para abrir terminales, inyectar prompts y despachar tareas rápidas.',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro (via OpenCode)',
    badge: 'Pro Reasoning',
    tier: 'Pro Reasoning',
    description: 'Alta capacidad de razonamiento para arquitectura y planes complejos.',
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash (via OpenCode)',
    badge: 'Fast Multimodal',
    tier: 'Fast Multimodal',
    description: 'Velocidad balanceada y comprensión profunda de contexto de workspace.',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite (via OpenCode)',
    badge: 'Lightweight',
    tier: 'Lightweight',
    description: 'Extremadamente ligero y económico para acciones directas.',
  },
  {
    id: 'jev-1.13',
    label: 'Jev 1.13 (via OpenCode)',
    badge: 'Fast Agentic',
    tier: 'Fast Agentic',
    description: 'Optimizado para herramientas y ejecución estructurada de agentes.',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini (via OpenCode)',
    badge: 'Fast Precision',
    tier: 'Fast Precision',
    description: 'Excelente para formateo JSON estricto y parsing de intenciones.',
  },
  {
    id: 'qwen3.8-flash',
    label: 'Qwen 3.8 Flash (via OpenCode)',
    badge: 'Code & Logic',
    tier: 'Code & Logic',
    description: 'Especialista en código y generación de comandos CLI.',
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code (via OpenCode)',
    badge: 'Coding Agent',
    tier: 'Coding Agent',
    description: 'Modelo enfocado en programación y contexto extenso.',
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5 (via OpenCode)',
    badge: 'Premium Analysis',
    tier: 'Premium Analysis',
    description: 'Máxima precisión analítica y síntesis para planes de alto nivel.',
  },
  {
    id: 'grok-4.7',
    label: 'Grok 4.7 (via OpenCode)',
    badge: 'Direct & Fast',
    tier: 'Direct & Fast',
    description: 'Respuestas directas con alta fidelidad.',
  },
];

export const VERCEL_MODEL_CATALOG: OpenCodeModelOption[] = [
  {
    id: 'deepseek/deepseek-chat',
    label: 'DeepSeek Chat (via Vercel AI)',
    badge: 'Ultra-Fast',
    tier: 'Ultra-Fast',
    description: 'Baja latencia y alta eficiencia a traves de Vercel AI Gateway.',
  },
  {
    id: 'deepseek/deepseek-reasoner',
    label: 'DeepSeek Reasoner (via Vercel AI)',
    badge: 'Pro Reasoning',
    tier: 'Pro Reasoning',
    description: 'Capacidad avanzada de razonamiento y desglose de tareas complejas.',
  },
  {
    id: 'google/gemini-2.0-flash',
    label: 'Gemini 2.0 Flash (via Vercel AI)',
    badge: 'Fast Multimodal',
    tier: 'Fast Multimodal',
    description: 'Respuesta instantanea para despacho de comandos y herramientas.',
  },
  {
    id: 'openai/gpt-4o-mini',
    label: 'GPT-4o Mini (via Vercel AI)',
    badge: 'Fast Precision',
    tier: 'Fast Precision',
    description: 'Alta precision y estructuracion rapida de respuestas.',
  },
  {
    id: 'anthropic/claude-3-5-haiku',
    label: 'Claude 3.5 Haiku (via Vercel AI)',
    badge: 'Fast Agentic',
    tier: 'Fast Agentic',
    description: 'Excelente para flujos agenticos ligeros y directos.',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B (via Vercel AI)',
    badge: 'Open Weights',
    tier: 'Open Weights',
    description: 'Modelo potente y versatil en la infraestructura de Vercel.',
  },
];

export const CLOUDFLARE_MODEL_CATALOG: OpenCodeModelOption[] = [
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8',
    label: 'Llama 3.1 8B Instruct FP8 (Cloudflare Edge)',
    badge: 'Ultra-Fast Edge',
    tier: 'Ultra-Fast Edge',
    description: 'Inferencia edge ultrarrápida (sub-250ms) y costo mínimo en la red global de Cloudflare Workers AI.',
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    label: 'Llama 3.2 3B Instruct (Cloudflare)',
    badge: 'Micro-Edge',
    tier: 'Micro-Edge',
    description: 'Modelo ultraligero y de mínima latencia para despacho inmediato de acciones directas.',
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B Instruct Fast (Cloudflare)',
    badge: 'Pro Reasoning',
    tier: 'Pro Reasoning',
    description: 'Alta capacidad de razonamiento y planificación estructurada con cuantización optimizada FP8.',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    label: 'DeepSeek R1 Distill Qwen 32B (Cloudflare)',
    badge: 'Reasoning Agent',
    tier: 'Reasoning Agent',
    description: 'Excelente para deducción paso a paso y desgloses complejos de tareas de desarrollo.',
  },
  {
    id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
    label: 'DeepSeek V4 Flash (Cloudflare)',
    badge: 'Next-Gen Fast',
    tier: 'Next-Gen Fast',
    description: 'Arquitectura DeepSeek V4 optimizada para respuestas instantáneas con contexto de programación.',
  },
  {
    id: '@cf/moonshotai/kimi-k2.7-code',
    label: 'Kimi K2.7 Code (Cloudflare)',
    badge: 'Coding Specialist',
    tier: 'Coding Specialist',
    description: 'Especializado en generación de código, herramientas CLI y comandos de terminal.',
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Cloudflare)',
    badge: 'Frontier Open',
    tier: 'Frontier Open',
    description: 'Modelo insignia open-weights de 120B parámetros con máxima fidelidad analítica.',
  },
];

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
  // OpenCode Multi-Model Gateway (Base API Key + selectable models including DeepSeek, Gemini, Jev)
  opencodeApiKey: string;
  opencodeBaseUrl: string;
  opencodeModel: string;
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
  successRate: number; // 0..1 ratio
}

const CONFIG_STORAGE_KEY = 'kite.operator.providerConfig.v2';
const LEGACY_CONFIG_STORAGE_KEY = 'kite.operator.providerConfig.v1';
const LATENCY_STORAGE_KEY = 'kite.operator.latencyRecords.v2';
const MEMORY_NOTES_STORAGE_KEY = 'kite.zed.memoryNotes.v1';
const MAX_LATENCY_RECORDS = 150;

export const DEFAULT_ZED_PERSONA: ZedPersonaConfig = {
  name: 'Zed',
  voice: 'Ara',
  tone: 'crisp',
  brevity: 'one-breath',
  language: 'es',
  builderCallMe: '',
  standingInstructions: '',
  rememberBetweenCalls: true,
  afterCallMode: 'summary+decisions',
};

export const DEFAULT_OPERATOR_CONFIG: OperatorProviderConfig = {
  activeProvider: 'cloudflare',
  opencodeApiKey: '',
  opencodeBaseUrl: 'https://opencode.ai/inference/v1',
  opencodeModel: 'deepseek-v4.1-flash',
  vercelApiKey: '',
  vercelBaseUrl: 'https://ai-gateway.vercel.sh/v1',
  vercelModel: 'deepseek/deepseek-chat',
  cloudflareAccountId: '',
  cloudflareApiToken: '',
  cloudflareGatewaySlug: '',
  cloudflareBaseUrl: 'https://api.cloudflare.com/client/v4/accounts',
  cloudflareModel: '@cf/meta/llama-3.1-8b-instruct-fp8',
  antigravityModel: 'gemini-3.8-flash',
  antigravityCommand: 'agy',
  grokApiKey: '',
  grokBaseUrl: 'https://api.x.ai/v1',
  grokModel: 'grok-3-mini-fast',
  grokUseCliSubscription: true,
  grokTranscriptionApiKey: '',
  grokTranscriptionBaseUrl: 'https://api.x.ai/v1',
  grokTranscriptionModel: 'grok-voice-transcribe-2.0',
  ttsEnabled: true,
  ttsLanguage: 'es-ES',
  ttsRate: 1.05,
  persona: DEFAULT_ZED_PERSONA,
};

const SEED_VERSION_KEY = 'kite_operator_seed_v4';

export function loadOperatorConfig(): OperatorProviderConfig {
  try {
    const raw =
      localStorage.getItem(CONFIG_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_CONFIG_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_OPERATOR_CONFIG, persona: { ...DEFAULT_ZED_PERSONA } };
    const parsed = JSON.parse(raw) as Partial<OperatorProviderConfig>;
    let baseUrl = parsed.opencodeBaseUrl || DEFAULT_OPERATOR_CONFIG.opencodeBaseUrl;
    if (baseUrl === 'https://api.deepseek.com/v1' || baseUrl === 'https://api.opencode.ai/v1') {
      baseUrl = 'https://opencode.ai/inference/v1';
    }
    let model = parsed.opencodeModel || DEFAULT_OPERATOR_CONFIG.opencodeModel;
    if (model === 'deepseek-4.1-flash') {
      model = 'deepseek-v4.1-flash';
    } else if (model === 'jev') {
      model = 'jev-1.13';
    }

    const apiKey =
      typeof parsed.opencodeApiKey === 'string'
        ? parsed.opencodeApiKey
        : DEFAULT_OPERATOR_CONFIG.opencodeApiKey;

    const vercelKey =
      typeof parsed.vercelApiKey === 'string'
        ? parsed.vercelApiKey
        : DEFAULT_OPERATOR_CONFIG.vercelApiKey;

    const cfAccount =
      typeof parsed.cloudflareAccountId === 'string'
        ? parsed.cloudflareAccountId
        : DEFAULT_OPERATOR_CONFIG.cloudflareAccountId;
    const cfToken =
      typeof parsed.cloudflareApiToken === 'string'
        ? parsed.cloudflareApiToken
        : DEFAULT_OPERATOR_CONFIG.cloudflareApiToken;
    const cfModel = parsed.cloudflareModel || DEFAULT_OPERATOR_CONFIG.cloudflareModel;

    const activeProvider = parsed.activeProvider || DEFAULT_OPERATOR_CONFIG.activeProvider;

    return {
      ...DEFAULT_OPERATOR_CONFIG,
      ...parsed,
      activeProvider,
      opencodeApiKey: apiKey,
      opencodeBaseUrl: baseUrl,
      opencodeModel: model,
      vercelApiKey: vercelKey,
      vercelBaseUrl: parsed.vercelBaseUrl || DEFAULT_OPERATOR_CONFIG.vercelBaseUrl,
      vercelModel: parsed.vercelModel || DEFAULT_OPERATOR_CONFIG.vercelModel,
      cloudflareAccountId: cfAccount,
      cloudflareApiToken: cfToken,
      cloudflareGatewaySlug: typeof parsed.cloudflareGatewaySlug === 'string' ? parsed.cloudflareGatewaySlug : DEFAULT_OPERATOR_CONFIG.cloudflareGatewaySlug,
      cloudflareBaseUrl: parsed.cloudflareBaseUrl || DEFAULT_OPERATOR_CONFIG.cloudflareBaseUrl,
      cloudflareModel: cfModel,
      persona: {
        ...DEFAULT_ZED_PERSONA,
        ...(parsed.persona ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_OPERATOR_CONFIG, persona: { ...DEFAULT_ZED_PERSONA } };
  }
}

export const getOperatorConfig = loadOperatorConfig;

export function saveOperatorConfig(
  partialOrFull: Partial<OperatorProviderConfig>
): OperatorProviderConfig {
  const current = loadOperatorConfig();
  const merged: OperatorProviderConfig = {
    ...current,
    ...partialOrFull,
    persona: {
      ...current.persona,
      ...(partialOrFull.persona ?? {}),
    },
  };
  try {
    localStorage.setItem(SEED_VERSION_KEY, '1');
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(merged));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-config-updated', { detail: merged }));
      window.dispatchEvent(new CustomEvent('kite:operator-config-changed', { detail: merged }));
    }
  } catch {
    // ignore storage errors
  }
  return merged;
}

export function loadZedMemoryNotes(): ZedMemoryNote[] {
  try {
    let raw = localStorage.getItem(MEMORY_NOTES_STORAGE_KEY);
    if (!raw) {
      const legacyKey = legacyOperatorMemoryNotesStorageKey();
      raw = localStorage.getItem(legacyKey);
      if (raw) {
        localStorage.setItem(MEMORY_NOTES_STORAGE_KEY, raw);
        localStorage.removeItem(legacyKey);
      }
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, idx): ZedMemoryNote | null => {
        if (typeof item === 'string') {
          return {
            id: `mem-legacy-${idx}`,
            content: item,
            createdAt: new Date().toISOString(),
          };
        }
        if (item && typeof item === 'object' && typeof item.content === 'string') {
          return {
            id: typeof item.id === 'string' ? item.id : `mem-${idx}-${Date.now()}`,
            content: item.content,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
            workspace: typeof item.workspace === 'string' ? item.workspace : undefined,
          };
        }
        return null;
      })
      .filter((n): n is ZedMemoryNote => n !== null);
  } catch {
    return [];
  }
}

export function saveZedMemoryNotes(notes: ZedMemoryNote[]): void {
  try {
    localStorage.setItem(MEMORY_NOTES_STORAGE_KEY, JSON.stringify(notes.slice(0, 50)));
  } catch {
    // ignore storage errors
  }
}

export function buildZedOpeningPreview(persona: ZedPersonaConfig): string {
  const assistantName = persona.name.trim() || 'Zed';
  const callMe = persona.builderCallMe.trim();
  const isEs = persona.language === 'es' || persona.language === 'auto';

  if (isEs) {
    const greeting = callMe ? `Listo, ${callMe}.` : 'Listo.';
    if (persona.tone === 'warm' || persona.tone === 'chill') {
      return `Hola${callMe ? ` ${callMe}` : ''}, soy ${assistantName}. Tengo el contexto del proyecto activo, ¿qué desplegamos ahora?`;
    }
    if (persona.tone === 'direct') {
      return `${greeting} ${assistantName} en línea. Indica la acción o subagente a lanzar.`;
    }
    if (persona.tone === 'calm') {
      return `${greeting} ${assistantName} conectado al workspace. Dime qué terminales o tareas quieres coordinar.`;
    }
    return `${greeting} Soy ${assistantName}. ¿Qué terminales, prompts o agentes ejecutamos?`;
  }

  const greetingEn = callMe ? `Ready, ${callMe}.` : 'Ready.';
  if (persona.tone === 'warm' || persona.tone === 'chill') {
    return `Hey${callMe ? ` ${callMe}` : ''}, ${assistantName} here. I have the active project context—what are we shipping next?`;
  }
  if (persona.tone === 'direct') {
    return `${greetingEn} ${assistantName} online. State the action or subagent to dispatch.`;
  }
  return `${greetingEn} ${assistantName} connected. Which terminals, prompts, or subagents should we run?`;
}

export function buildZedSystemInstructions(config: OperatorProviderConfig): string {
  const p = config.persona ?? DEFAULT_ZED_PERSONA;
  const name = p.name.trim() || 'Zed';
  const toneDesc: Record<ZedTone, string> = {
    calm: 'Steady, unhurried, and composed.',
    crisp: 'Concise, sharp, and technical with zero fluff.',
    warm: 'Collaborative, approachable, and supportive.',
    direct: 'Blunt, immediate, and action-first.',
    chill: 'Relaxed, conversational, and helpful.',
  };
  const brevityDesc: Record<ZedBrevity, string> = {
    'one-breath': 'Keep spoken/text replies to one short sentence (under 20 words) whenever possible.',
    tight: 'Keep spoken/text replies to one short sentence (under 20 words) whenever possible.',
    normal: 'Keep replies to 1-2 short sentences.',
    thorough: 'Provide complete context and step breakdowns when helpful.',
    detailed: 'Provide complete context and step breakdowns when helpful.',
  };

  const memoryNotes = p.rememberBetweenCalls ? loadZedMemoryNotes() : [];
  const memoryBlock =
    memoryNotes.length > 0
      ? `\nShared Memory Notes:\n${memoryNotes.map((n) => `- ${n.content}`).join('\n')}`
      : '';

  return [
    `You are ${name}, the voice & command operator inside Kite Code.`,
    `Tone: ${toneDesc[p.tone] || toneDesc.crisp}`,
    `Brevity: ${brevityDesc[p.brevity] || brevityDesc['one-breath']}`,
    p.builderCallMe.trim() ? `Address the builder as "${p.builderCallMe.trim()}".` : '',
    p.language && p.language !== 'auto' ? `Preferred response language: ${p.language}.` : '',
    p.standingInstructions.trim()
      ? `Standing Instructions from Builder:\n${p.standingInstructions.trim().slice(0, 600)}`
      : '',
    memoryBlock,
  ]
    .filter(Boolean)
    .join('\n');
}

export function loadLatencyRecords(): LatencyRecord[] {
  try {
    const raw = localStorage.getItem(LATENCY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const getLatencyHistory = loadLatencyRecords;

export function saveLatencyRecords(records: LatencyRecord[]): void {
  try {
    localStorage.setItem(LATENCY_STORAGE_KEY, JSON.stringify(records.slice(0, MAX_LATENCY_RECORDS)));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-latency-updated'));
    }
  } catch {
    // ignore storage errors
  }
}

export function recordOperatorLatency(entry: Omit<LatencyRecord, 'id' | 'timestamp'>): LatencyRecord {
  const fullRecord: LatencyRecord = {
    ...entry,
    id: `lat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
  };
  try {
    const existing = loadLatencyRecords();
    const updated = [fullRecord, ...existing].slice(0, MAX_LATENCY_RECORDS);
    localStorage.setItem(LATENCY_STORAGE_KEY, JSON.stringify(updated));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-latency-updated', { detail: fullRecord }));
    }
  } catch {
    // ignore storage errors
  }
  return fullRecord;
}

export function recordProviderLatency(input: {
  providerId: OperatorProviderId;
  taskType: string;
  latencyMs: number;
  ok: boolean;
  modelLabel?: string;
}): LatencyRecord {
  const config = loadOperatorConfig();
  return recordOperatorLatency({
    provider: input.providerId,
    model: input.modelLabel || getActiveModelForProvider(config, input.providerId),
    taskType: input.taskType,
    latencyMs: input.latencyMs,
    success: input.ok,
  });
}

export function recordLatencyMetric(input: {
  provider: OperatorProviderId;
  model: string;
  command?: string;
  taskType?: OperatorTaskType | string;
  latencyMs: number;
  success: boolean;
  error?: string;
}): LatencyRecord {
  return recordOperatorLatency({
    provider: input.provider,
    model: input.model,
    taskType: input.taskType || 'chat_response',
    latencyMs: input.latencyMs,
    success: input.success,
    notes: input.error || input.command,
  });
}

export function clearLatencyRecords(): void {
  try {
    localStorage.removeItem(LATENCY_STORAGE_KEY);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:operator-latency-updated'));
    }
  } catch {
    // ignore
  }
}

export const clearLatencyHistory = clearLatencyRecords;

export function getActiveModelForProvider(
  config: OperatorProviderConfig,
  provider: OperatorProviderId = config.activeProvider
): string {
  switch (provider) {
    case 'opencode':
      return config.opencodeModel || 'deepseek-v4.1-flash';
    case 'vercel':
      return config.vercelModel || 'deepseek/deepseek-chat';
    case 'cloudflare':
      return config.cloudflareModel || '@cf/meta/llama-3.1-8b-instruct-fp8';
    case 'antigravity':
      return config.antigravityModel || 'gemini-3.8-flash';
    case 'grok':
      return config.grokModel || 'grok-3-mini-fast';
    case 'local':
      return 'local-heuristic-v1';
  }
}

export function computeLatencySummaries(
  records: LatencyRecord[] = loadLatencyRecords()
): TaskLatencySummaryRow[] {
  const groups = new Map<string, LatencyRecord[]>();

  for (const r of records) {
    const key = `${r.provider}::${r.taskType}`;
    const list = groups.get(key);
    if (list) {
      list.push(r);
    } else {
      groups.set(key, [r]);
    }
  }

  const rows: TaskLatencySummaryRow[] = [];
  for (const [, list] of groups.entries()) {
    const first = list[0];
    const latencies = list.map((item) => item.latencyMs);
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    const okCount = list.filter((item) => item.success).length;
    rows.push({
      providerId: first.provider,
      taskType: String(first.taskType),
      count: list.length,
      lastMs: Math.round(first.latencyMs),
      avgMs: Math.round(sum / list.length),
      minMs: Math.round(Math.min(...latencies)),
      maxMs: Math.round(Math.max(...latencies)),
      successRate: okCount / list.length,
    });
  }

  return rows;
}

export function getProviderLatencyStats(
  config: OperatorProviderConfig = loadOperatorConfig()
): Record<OperatorProviderId, ProviderLatencySummary> {
  const records = loadLatencyRecords();
  const providers: OperatorProviderId[] = ['opencode', 'vercel', 'cloudflare', 'antigravity', 'grok', 'local'];

  const result = {} as Record<OperatorProviderId, ProviderLatencySummary>;

  for (const provider of providers) {
    const providerRecords = records.filter((r) => r.provider === provider);
    const successful = providerRecords.filter((r) => r.success);

    if (providerRecords.length === 0) {
      result[provider] = {
        provider,
        model: getActiveModelForProvider(config, provider),
        sampleCount: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        lastMs: 0,
        successRate: 100,
        byTask: {},
      };
      continue;
    }

    const latencies = providerRecords.map((r) => r.latencyMs);
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    const avgMs = Math.round(sum / latencies.length);
    const minMs = Math.round(Math.min(...latencies));
    const maxMs = Math.round(Math.max(...latencies));
    const lastMs = Math.round(providerRecords[0].latencyMs);
    const successRate = Math.round((successful.length / providerRecords.length) * 100);

    const byTask: ProviderLatencySummary['byTask'] = {};
    for (const rec of providerRecords) {
      const taskKey = String(rec.taskType);
      const prev = byTask[taskKey];
      if (!prev) {
        byTask[taskKey] = {
          count: 1,
          avgMs: Math.round(rec.latencyMs),
          lastMs: Math.round(rec.latencyMs),
        };
      } else {
        const nextCount = prev.count + 1;
        byTask[taskKey] = {
          count: nextCount,
          avgMs: Math.round((prev.avgMs * prev.count + rec.latencyMs) / nextCount),
          lastMs: prev.lastMs,
        };
      }
    }

    result[provider] = {
      provider,
      model: providerRecords[0].model || getActiveModelForProvider(config, provider),
      sampleCount: providerRecords.length,
      avgMs,
      minMs,
      maxMs,
      lastMs,
      successRate,
      byTask,
    };
  }

  return result;
}

const MODEL_CATALOG_KEYS = {
  opencode: 'kite.operator.modelCatalog.opencode.v1',
  vercel: 'kite.operator.modelCatalog.vercel.v1',
  cloudflare: 'kite.operator.modelCatalog.cloudflare.v1',
} as const;

const MAX_CACHED_MODELS = 2000;

export type ModelCatalogProvider = keyof typeof MODEL_CATALOG_KEYS;

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

function isModelOption(value: unknown): value is OpenCodeModelOption {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<OpenCodeModelOption>;
  return typeof row.id === 'string' && row.id.trim().length > 0 && typeof row.label === 'string';
}

export function loadModelCatalog(provider: ModelCatalogProvider): ModelCatalogSnapshot | null {
  try {
    const raw = localStorage.getItem(MODEL_CATALOG_KEYS[provider]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { models?: unknown; savedAt?: unknown };
    if (!Array.isArray(parsed.models)) return null;
    const models = parsed.models.filter(isModelOption).slice(0, MAX_CACHED_MODELS);
    if (models.length === 0) return null;
    return {
      models,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveModelCatalog(
  provider: ModelCatalogProvider,
  models: OpenCodeModelOption[]
): ModelCatalogSnapshot {
  const snapshot: ModelCatalogSnapshot = {
    models: models.filter(isModelOption).slice(0, MAX_CACHED_MODELS),
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(MODEL_CATALOG_KEYS[provider], JSON.stringify(snapshot));
  } catch {
    // The last list is still usable in memory if storage is full.
  }
  return snapshot;
}

function keptCatalog(
  provider: ModelCatalogProvider,
  fallback: OpenCodeModelOption[],
  detail: string
): ModelCatalogFetchResult {
  const cached = loadModelCatalog(provider);
  if (cached) {
    return {
      models: cached.models,
      fresh: false,
      savedAt: cached.savedAt,
      detail: `${detail} Se mantiene la última lista.`,
    };
  }
  return {
    models: fallback,
    fresh: false,
    savedAt: null,
    detail: `${detail} Mostrando la lista incluida.`,
  };
}

async function readRemoteModelList(
  url: string,
  apiKey: string
): Promise<Array<{ id: string; name?: string; description?: string }>> {
  const res = await operatorHttpFetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.result)) {
    return data.result.map((item: any) => ({
      id: item.name || item.id,
      name: item.name || item.id,
      description: item.description,
    }));
  }
  if (Array.isArray(data)) return data;
  return [];
}

export async function fetchOpenCodeModels(
  apiKey?: string,
  baseUrl?: string
): Promise<ModelCatalogFetchResult> {
  const cfg = loadOperatorConfig();
  const key = (apiKey ?? cfg.opencodeApiKey)?.trim();
  const base =
    (baseUrl ?? cfg.opencodeBaseUrl)?.replace(/\/+$/, '') || 'https://opencode.ai/inference/v1';

  if (!key) {
    return keptCatalog(
      'opencode',
      OPENCODE_MODEL_CATALOG,
      'Falta la API key de OpenCode.'
    );
  }

  try {
    const list = await readRemoteModelList(`${base}/models`, key);
    if (!list.length) {
      return keptCatalog(
        'opencode',
        OPENCODE_MODEL_CATALOG,
        'El catálogo de OpenCode llegó vacío.'
      );
    }

    const dynamic: OpenCodeModelOption[] = list
      .filter((m) => typeof m.id === 'string' && !m.id.endsWith('-free'))
      .map((m) => {
        const id = m.id;
        const known = OPENCODE_MODEL_CATALOG.find((k) => k.id === id);
        if (known) return known;

        const label = m.name || id;
        return {
          id,
          label: `${label} (via OpenCode)`,
          badge: id.includes('flash') || id.includes('mini') ? 'Fast' : 'Standard',
          tier: 'OpenCode Gateway',
          description: m.description || `Modelo ${id} disponible en el gateway OpenCode.`,
        };
      });

    if (!dynamic.length) {
      return keptCatalog(
        'opencode',
        OPENCODE_MODEL_CATALOG,
        'OpenCode no devolvió modelos utilizables.'
      );
    }

    const saved = saveModelCatalog('opencode', dynamic);
    return {
      models: saved.models,
      fresh: true,
      savedAt: saved.savedAt,
      detail: '',
    };
  } catch {
    return keptCatalog(
      'opencode',
      OPENCODE_MODEL_CATALOG,
      'No se pudo consultar OpenCode.'
    );
  }
}

export async function fetchVercelModels(
  apiKey?: string,
  baseUrl?: string
): Promise<ModelCatalogFetchResult> {
  const cfg = loadOperatorConfig();
  const key = (apiKey ?? cfg.vercelApiKey)?.trim();
  const base =
    (baseUrl ?? cfg.vercelBaseUrl)?.replace(/\/+$/, '') || 'https://ai-gateway.vercel.sh/v1';

  if (!key) {
    return keptCatalog(
      'vercel',
      VERCEL_MODEL_CATALOG,
      'Falta la API key de Vercel.'
    );
  }

  try {
    const list = await readRemoteModelList(`${base}/models`, key);
    if (!list.length) {
      return keptCatalog(
        'vercel',
        VERCEL_MODEL_CATALOG,
        'El catálogo de Vercel llegó vacío.'
      );
    }

    const dynamic: OpenCodeModelOption[] = list
      .filter((m) => typeof m.id === 'string')
      .map((m) => {
        const id = m.id;
        const known = VERCEL_MODEL_CATALOG.find((k) => k.id === id);
        if (known) return known;

        const label = m.name || id;
        return {
          id,
          label: `${label} (via Vercel AI)`,
          badge: id.includes('flash') || id.includes('mini') || id.includes('haiku') ? 'Fast' : 'Standard',
          tier: 'Vercel AI Gateway',
          description: m.description || `Modelo ${id} disponible en Vercel AI Gateway.`,
        };
      });

    if (!dynamic.length) {
      return keptCatalog(
        'vercel',
        VERCEL_MODEL_CATALOG,
        'Vercel no devolvió modelos utilizables.'
      );
    }

    const saved = saveModelCatalog('vercel', dynamic);
    return {
      models: saved.models,
      fresh: true,
      savedAt: saved.savedAt,
      detail: '',
    };
  } catch {
    return keptCatalog(
      'vercel',
      VERCEL_MODEL_CATALOG,
      'No se pudo consultar Vercel.'
    );
  }
}

export async function fetchCloudflareModels(
  apiToken?: string,
  accountId?: string,
  baseUrl?: string
): Promise<ModelCatalogFetchResult> {
  const cfg = loadOperatorConfig();
  const token = (apiToken ?? cfg.cloudflareApiToken)?.trim();
  const account = (accountId ?? cfg.cloudflareAccountId)?.trim();
  const base =
    (baseUrl ?? cfg.cloudflareBaseUrl)?.replace(/\/+$/, '') ||
    'https://api.cloudflare.com/client/v4/accounts';

  if (!token || !account) {
    return keptCatalog(
      'cloudflare',
      CLOUDFLARE_MODEL_CATALOG,
      'Falta el Account ID o API Token de Cloudflare.'
    );
  }

  try {
    let list: Array<{ id: string; name?: string; description?: string }> = [];
    try {
      list = await readRemoteModelList(`${base}/${account}/ai/v1/models`, token);
    } catch {
      list = await readRemoteModelList(
        `${base}/${account}/ai/models/search?task=Text%20Generation`,
        token
      );
    }

    if (!list.length) {
      return keptCatalog(
        'cloudflare',
        CLOUDFLARE_MODEL_CATALOG,
        'El catálogo de Cloudflare llegó vacío.'
      );
    }

    const dynamic: OpenCodeModelOption[] = list
      .filter((m) => typeof m.id === 'string')
      .map((m) => {
        const id = m.id;
        const known = CLOUDFLARE_MODEL_CATALOG.find((k) => k.id === id);
        if (known) return known;

        const label = m.name || id;
        return {
          id,
          label: `${label} (via Cloudflare)`,
          badge:
            id.includes('flash') || id.includes('8b') || id.includes('3b') || id.includes('1b')
              ? 'Fast'
              : 'Edge',
          tier: 'Cloudflare Workers AI',
          description: m.description || `Modelo ${id} disponible en Cloudflare Workers AI.`,
        };
      });

    if (!dynamic.length) {
      return keptCatalog(
        'cloudflare',
        CLOUDFLARE_MODEL_CATALOG,
        'Cloudflare no devolvió modelos utilizables.'
      );
    }

    const saved = saveModelCatalog('cloudflare', dynamic);
    return {
      models: saved.models,
      fresh: true,
      savedAt: saved.savedAt,
      detail: '',
    };
  } catch {
    return keptCatalog(
      'cloudflare',
      CLOUDFLARE_MODEL_CATALOG,
      'No se pudo consultar Cloudflare.'
    );
  }
}



