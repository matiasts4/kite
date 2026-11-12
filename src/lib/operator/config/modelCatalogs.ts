import type { OpenCodeModelOption } from './types';

/**
 * OpenCode Go is a subscription, not the pay-as-you-go Console balance.
 * The OpenAI-compatible chat endpoint lives under /inference/go/openai/v1 and
 * requires the x-opencode-session header on every request.
 */
export const OPENCODE_GO_CHAT_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';

/**
 * OpenCode pay-as-you-go inference roots. An OpenCode Go API key is rejected
 * there (HTTP 402), so a stored value that points at one is migrated to the Go
 * chat base instead of being sent as-is.
 */
const OPENCODE_PAYG_BASE_URLS = [
  'https://api.deepseek.com/v1',
  'https://api.opencode.ai/v1',
  'https://opencode.ai/inference/v1',
  'https://opencode.ai/inference/openai/v1',
];

function canonicalOpenCodeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '');
}

/**
 * Returns the base the OpenCode driver may send a Go key to. Pay-as-you-go
 * inference routes are replaced by the Go subscription base, including when the
 * stored value carries a trailing slash or a full /chat/completions path.
 */
export function normalizeOpenCodeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) return OPENCODE_GO_CHAT_BASE_URL;
  const canonical = canonicalOpenCodeBaseUrl(trimmed).toLowerCase();
  if (OPENCODE_PAYG_BASE_URLS.includes(canonical)) {
    return OPENCODE_GO_CHAT_BASE_URL;
  }
  return trimmed;
}

/** True when the base is the OpenCode Go Chat Completions gateway. */
export function isOpenCodeGoChatBaseUrl(baseUrl: string | undefined): boolean {
  return canonicalOpenCodeBaseUrl(baseUrl ?? '') === OPENCODE_GO_CHAT_BASE_URL;
}

/**
 * Only models served through the OpenAI Chat Completions API can be used by
 * the Zed HTTP provider. GPT/Grok use the Responses API; Claude/Gemini use
 * their native APIs and are intentionally excluded from this list.
 */
const OPENCODE_GO_NON_CHAT_PREFIXES = ['gpt-', 'grok-', 'claude-', 'gemini-', 'muse-'];

export function isOpenCodeGoChatCompatibleModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  return !OPENCODE_GO_NON_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export const OPENCODE_MODEL_CATALOG: OpenCodeModelOption[] = [
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash (OpenCode Go)',
    badge: 'Ultra-Fast',
    tier: 'Go · Fast',
    description: 'Baja latencia ideal para el planificador de Zed y acciones rápidas.',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro (OpenCode Go)',
    badge: 'Pro Reasoning',
    tier: 'Go · Pro',
    description: 'Mayor capacidad de razonamiento para planes y diagnóstico complejo.',
  },
  {
    id: 'kimi-k3',
    label: 'Kimi K3 (OpenCode Go)',
    badge: 'Coding Agent',
    tier: 'Go · Coding',
    description: 'Modelo agéntico para código, herramientas y contexto extenso.',
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code (OpenCode Go)',
    badge: 'Coding Agent',
    tier: 'Go · Coding',
    description: 'Especializado en programación y generación de comandos.',
  },
  {
    id: 'minimax-m3',
    label: 'MiniMax M3 (OpenCode Go)',
    badge: 'Balanced',
    tier: 'Go · Balanced',
    description: 'Equilibrio entre razonamiento, velocidad y costo.',
  },
  {
    id: 'minimax-m3.1-flash',
    label: 'MiniMax M3.1 Flash (OpenCode Go)',
    badge: 'Fast',
    tier: 'Go · Fast',
    description: 'Variante rápida para respuestas cortas y despacho de acciones.',
  },
  {
    id: 'glm-5.3',
    label: 'GLM 5.3 (OpenCode Go)',
    badge: 'Pro',
    tier: 'Go · Pro',
    description: 'Razonamiento sólido con buen desempeño en herramientas.',
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash (OpenCode Go)',
    badge: 'Fast',
    tier: 'Go · Fast',
    description: 'Versión liviana para planificación de baja latencia.',
  },
  {
    id: 'qwen3.8-flash',
    label: 'Qwen 3.8 Flash (OpenCode Go)',
    badge: 'Code & Logic',
    tier: 'Go · Fast',
    description: 'Rápido en código y estructuración de comandos CLI.',
  },
  {
    id: 'qwen3.8-max',
    label: 'Qwen 3.8 Max (OpenCode Go)',
    badge: 'Pro',
    tier: 'Go · Pro',
    description: 'Mayor capacidad analítica dentro de la suscripción Go.',
  },
  {
    id: 'mimo-v2.6-flash',
    label: 'MiMo V2.6 Flash (OpenCode Go)',
    badge: 'Fast',
    tier: 'Go · Fast',
    description: 'Modelo liviano para turnos cortos y de baja latencia.',
  },
  {
    id: 'mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro (OpenCode Go)',
    badge: 'Pro',
    tier: 'Go · Pro',
    description: 'Mayor profundidad para tareas de planificación.',
  },
  {
    id: 'hy3',
    label: 'Hy3 (OpenCode Go)',
    badge: 'Open',
    tier: 'Go · Open',
    description: 'Modelo open-weights incluido en el plan Go.',
  },
  {
    id: 'step-5-preview',
    label: 'Step 5 Preview (OpenCode Go)',
    badge: 'Preview',
    tier: 'Go · Preview',
    description: 'Modelo en preview para evaluar calidad y latencia.',
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

export const ELEVENLABS_TTS_MODELS = [
  { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo — Ultrarrápido (~100ms, agentes de voz)' },
  { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5 — Mínima latencia (~75ms)' },
  { id: 'eleven_v4', label: 'Eleven v4 — Máxima fidelidad expresiva (narración)' },
  { id: 'eleven_multilingual_v2', label: 'Eleven Multilingual v2 — Estándar previo' },
] as const;

export const ELEVENLABS_CURATED_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel — Serena y profesional' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — Firme y técnico' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni — Expresivo y dinámico' },
  { id: 'IKne3meq5aSn9XLyUdCD', label: 'Charlie — Directo y analítico' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George — Cálido y reflexivo' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah — Ágil y conversacional' },
] as const;

export const GROK_CHAT_MODEL_OPTIONS = [
  { id: 'grok-4.7', label: 'Grok 4.7 (flagship)' },
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'grok-4.5', label: 'Grok 4.5' },
  { id: 'grok-3-mini-fast', label: 'Grok 3 Mini Fast (legacy)' },
] as const;
