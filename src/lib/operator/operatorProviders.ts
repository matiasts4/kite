import {
  invokeCommand,
  isTauriEnvironment,
  listConnections,
  type ConnectionSummary,
} from '../ipc';
import type { OperatorAction } from './operatorBrain';
import { resolveVerifiedModel } from './providers/resolvePlanner';
import {
  buildZedSystemInstructions,
  getActiveModelForProvider,
  getOrCreateOpenCodeSessionId,
  loadOperatorConfig,
  operatorHttpFetch,
  recordOperatorLatency,
  shouldUseGrokCli,
  shouldUseGrokHttpApi,
  type OperatorProviderConfig,
  type OperatorProviderId,
  type OperatorTaskType,
} from './operatorConfig';

/**
 * Chat endpoints the Zed operator can actually spawn, per driver. A verified
 * quota route for the same driver never qualifies, and an auth method with no
 * spawn in this surface (such as ACP today) does not either.
 */
const ZED_CHAT_ENDPOINTS_BY_DRIVER: Partial<Record<string, readonly string[]>> = {
  opencode: ['https://opencode.ai/inference/go/openai/v1/chat/completions'],
  antigravity: ['cli:agy -p'],
  grok: ['https://api.x.ai/v1/chat/completions'],
};

/** Drivers the Zed operator can call directly, mapped to the provider row the
 * settings surface shows. Other driver kinds may have verified endpoints but no
 * editor provider row. */
const ZED_PROVIDER_BY_DRIVER: Partial<Record<string, OperatorProviderId>> = {
  opencode: 'opencode',
  antigravity: 'antigravity',
  grok: 'grok',
};

const ZED_CHAT_ENDPOINT_IDS = new Set(
  Object.values(ZED_CHAT_ENDPOINTS_BY_DRIVER).flatMap((endpoints) => endpoints ?? [])
);

export function isVerifiedChatEndpoint(endpointId: string): boolean {
  return ZED_CHAT_ENDPOINT_IDS.has(endpointId.trim());
}

/**
 * Projects the shared connection registry onto the Zed chat surface. A
 * connection is listed only when one of its own chat endpoints is verified; the
 * driver id alone never qualifies it.
 */
export function zedChatConnections(connections: ConnectionSummary[]): ConnectionSummary[] {
  return connections.filter((connection) => {
    const chatEndpoints = ZED_CHAT_ENDPOINTS_BY_DRIVER[connection.driverKind];
    if (!chatEndpoints) return false;
    return connection.endpoints.some(
      (endpoint) => endpoint.ok && chatEndpoints.includes(endpoint.endpointId.trim())
    );
  });
}

export function zedChatProviderIdsForConnections(
  connections: ConnectionSummary[]
): OperatorProviderId[] {
  const providerIds: OperatorProviderId[] = [];
  for (const connection of zedChatConnections(connections)) {
    const providerId = ZED_PROVIDER_BY_DRIVER[connection.driverKind];
    if (providerId && !providerIds.includes(providerId)) {
      providerIds.push(providerId);
    }
  }
  return providerIds;
}

export async function listZedChatConnections(): Promise<ConnectionSummary[]> {
  try {
    return zedChatConnections(await listConnections());
  } catch {
    // A browser build, or a test double without the registry reader, shows no
    // rows instead of claiming a connection.
    return [];
  }
}

export interface ProviderExecutionResult {
  provider: OperatorProviderId;
  model: string;
  latencyMs: number;
  taskType: OperatorTaskType;
  actions: OperatorAction[];
  reply: string;
  usedFallbackLocal: boolean;
  rawContent?: string;
  error?: string;
}

export interface OperatorLLMQueryResult {
  success: boolean;
  text?: string;
  error?: string;
  provider: OperatorProviderId;
  model: string;
  latencyMs: number;
}

export function classifyTaskType(actions: OperatorAction[]): OperatorTaskType {
  if (actions.length === 0) return 'chat_response';
  if (actions.length > 1) return 'multi_action';
  const first = actions[0];
  switch (first.type) {
    case 'open_terminals':
      return 'open_terminals';
    case 'close_terminals':
      return 'close_terminals';
    case 'inject_prompt':
      return 'inject_prompt';
    case 'spawn_subagent':
      return 'spawn_subagent';
    case 'open_browser':
      return 'open_browser';
    case 'narrate_summary':
      return 'narrate_summary';
    case 'verify_odd':
      return 'verify_odd';
    default:
      return 'chat_response';
  }
}

function buildOperatorSystemPrompt(
  config: OperatorProviderConfig,
  workspaceContext?: string
): string {
  const personaInstructions = buildZedSystemInstructions(config);
  return `${personaInstructions}

REGLAS CRÍTICAS DE OPERACIÓN:
1. Responde SIEMPRE en ESPAÑOL neutro y conciso. La clave "reply" DEBE estar en español para que el usuario la entienda y escuche claramente.
2. Analiza detenidamente la solicitud del usuario para planificar y emitir las acciones exactas requeridas.
3. Transcripción fonética por voz (STT en español): Ten en cuenta que palabras como "sierra", "sierre", "serrar" son transcripciones fonéticas de "cierra", "cierre", "cerrar". Si el usuario dice "Sierra Orion", significa CERRAR el agente o terminal "Orion".
4. Si el usuario pide cerrar un agente o terminal por su nombre o rol (ej. "Orion", "agente 2", "terminal codex"), usa el nombre o identificador directamente en el campo "target" de "close_terminals".
5. Si el usuario pide abrir terminales o agentes (ej. "abre dos terminales con grok y corre los tests", "abrí 2 terminales en ellas abre grok y ejecuta los test"):
   - Usa "open_terminals" con "count" (número de terminales a abrir), "engine" ("grok" | "claude" | "codex" | "powershell" | "antigravity" | "opencode") y "prompts" (arreglo de strings con las instrucciones o tareas que cada terminal ejecutará).
6. Responde ÚNICAMENTE con un objeto JSON válido con este esquema exacto (sin bloques de código markdown, sin texto extra fuera del JSON):
{
  "reply": "Respuesta o confirmación breve en español",
  "actions": [
    // Tipos de acciones permitidas:
    // { "type": "open_terminals", "count": 2, "engine": "grok" | "claude" | "codex" | "powershell" | "antigravity" | "opencode", "prompts": ["ejecuta los test"] }
    // { "type": "close_terminals", "target": "all" | "finished" | "idle" | "active" | "last" | "<nombre_agente_o_id>" | number }
    // { "type": "inject_prompt", "target": "<nombre_agente_o_id>" | number, "prompt": "comando o instrucción" }
    // { "type": "spawn_subagent", "cli": "grok" | "claude" | "codex" | "agy" | "opencode", "task": "descripción de la tarea" }
    // { "type": "open_browser", "url": "https://..." }
    // { "type": "narrate_summary", "target": "active" | "last" | "<nombre_o_id>" }
    // { "type": "verify_odd" }
  ]
}
${workspaceContext ? `\nContexto del Espacio de Trabajo y Terminales Activas:\n${workspaceContext}` : ''}`;
}

function parseProviderJsonOutput(rawText: string): { reply: string; actions: OperatorAction[] } | null {
  if (!rawText || !rawText.trim()) return null;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    if (parsed && Array.isArray(parsed.actions)) {
      return {
        reply: typeof parsed.reply === 'string' ? parsed.reply : 'Acción procesada.',
        actions: parsed.actions as OperatorAction[],
      };
    }
  } catch {
    // ignore parse failure
  }
  return null;
}

async function callOpenAICompatibleEndpoint(
  baseUrl: string,
  apiKey: string,
  model: string,
  userInput: string,
  config: OperatorProviderConfig,
  workspaceContext?: string,
  options?: { sessionId?: string; credentialProvider?: 'opencode' }
): Promise<{ reply: string; actions: OperatorAction[]; rawContent: string }> {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const endpoint = normalizedBase.endsWith('/chat/completions')
    ? normalizedBase
    : `${normalizedBase}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const key = apiKey.trim();
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  const sessionId = options?.sessionId?.trim();
  if (sessionId) {
    headers['x-opencode-session'] = sessionId;
  }

  const response = await operatorHttpFetch(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 450,
        messages: [
          { role: 'system', content: buildOperatorSystemPrompt(config, workspaceContext) },
          { role: 'user', content: userInput },
        ],
      }),
    },
    { credentialProvider: options?.credentialProvider }
  );

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
    } catch {
      try {
        errorDetail = await response.text();
      } catch {
        // ignore
      }
    }
    const suffix = errorDetail ? `: ${errorDetail}` : '';
    throw new Error(`API Gateway error HTTP ${response.status} from ${endpoint}${suffix}`);
  }

  const data = await response.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  const parsed = parseProviderJsonOutput(content);
  if (parsed) {
    return { ...parsed, rawContent: content };
  }
  return {
    reply: content.trim() || 'Acción procesada.',
    actions: [],
    rawContent: content,
  };
}

async function callCliSubscriptionProvider(
  cliEngine: string,
  model: string,
  userInput: string,
  config: OperatorProviderConfig,
  workspaceContext?: string
): Promise<{ reply: string; actions: OperatorAction[]; rawContent: string }> {
  const prompt = `${buildOperatorSystemPrompt(config, workspaceContext)}\n\nUser request: ${userInput}`;
  const res = await invokeCommand<{
    success?: boolean;
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    model?: string;
  }>('query_operator_agent', {
    engine: cliEngine,
    prompt,
    model,
    timeoutSecs: 15,
  });

  const output = res?.stdout || '';
  const parsed = parseProviderJsonOutput(output);
  if (parsed) {
    return { ...parsed, rawContent: output };
  }
  if (output.trim()) {
    return {
      reply: output.trim(),
      actions: [],
      rawContent: output.trim(),
    };
  }
  throw new Error(`CLI subscription (${cliEngine}) did not return valid output`);
}

export async function queryOperatorLLM(
  prompt: string,
  providerOverride?: OperatorProviderId,
  configOverride?: OperatorProviderConfig
): Promise<OperatorLLMQueryResult> {
  const config = configOverride ?? loadOperatorConfig();
  const provider = providerOverride ?? config.activeProvider;
  const rawModel = getActiveModelForProvider(config, provider);
  // OpenCode Go accepts the live catalog ids; other providers keep their
  // existing verified-model behavior.
  const model =
    provider === 'opencode'
      ? resolveVerifiedModel('opencode', rawModel, 'fast')
      : rawModel;
  const startTime = performance.now();

  if (provider === 'local') {
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    recordOperatorLatency({
      provider: 'local',
      model,
      taskType: 'chat_response',
      latencyMs,
      success: true,
      notes: prompt,
    });
    return {
      success: true,
      text: `Comando procesado localmente: ${prompt}`,
      provider: 'local',
      model,
      latencyMs,
    };
  }

  try {
    if (provider === 'opencode') {
      // Inside Tauri the native proxy can read the Go token from the local
      // OpenCode CLI store, so an empty field is valid. Browser/dev builds
      // still need an explicit key.
      if (!config.opencodeApiKey.trim() && !isTauriEnvironment()) {
        const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
        const errMsg = 'Falta la API Key de OpenCode Go en Configuraciones -> Asistente Zed.';
        recordOperatorLatency({
          provider: 'opencode',
          model,
          taskType: 'chat_response',
          latencyMs,
          success: false,
          notes: errMsg,
        });
        return {
          success: false,
          error: errMsg,
          provider: 'opencode',
          model,
          latencyMs,
        };
      }

      const res = await callOpenAICompatibleEndpoint(
        config.opencodeBaseUrl,
        config.opencodeApiKey.trim(),
        model,
        prompt,
        config,
        undefined,
        {
          sessionId: getOrCreateOpenCodeSessionId(config),
          credentialProvider: 'opencode',
        }
      );
      const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
      recordOperatorLatency({
        provider: 'opencode',
        model,
        taskType: classifyTaskType(res.actions),
        latencyMs,
        success: true,
      });
      return {
        success: true,
        text: res.reply,
        provider: 'opencode',
        model,
        latencyMs,
      };
    }

    if (provider === 'vercel') {
      if (!config.vercelApiKey.trim()) {
        const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
        const errMsg = 'Falta la API Key de Vercel AI en Configuraciones -> Asistente Zed.';
        recordOperatorLatency({
          provider: 'vercel',
          model,
          taskType: 'chat_response',
          latencyMs,
          success: false,
          notes: errMsg,
        });
        return {
          success: false,
          error: errMsg,
          provider: 'vercel',
          model,
          latencyMs,
        };
      }

      const res = await callOpenAICompatibleEndpoint(
        config.vercelBaseUrl,
        config.vercelApiKey.trim(),
        model,
        prompt,
        config
      );
      const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
      recordOperatorLatency({
        provider: 'vercel',
        model,
        taskType: classifyTaskType(res.actions),
        latencyMs,
        success: true,
      });
      return {
        success: true,
        text: res.reply,
        provider: 'vercel',
        model,
        latencyMs,
      };
    }

    if (provider === 'cloudflare') {
      if (!config.cloudflareAccountId.trim() || !config.cloudflareApiToken.trim()) {
        const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
        const errMsg = 'Falta el Account ID o API Token de Cloudflare en Configuraciones -> Asistente Zed.';
        recordOperatorLatency({
          provider: 'cloudflare',
          model,
          taskType: 'chat_response',
          latencyMs,
          success: false,
          notes: errMsg,
        });
        return {
          success: false,
          error: errMsg,
          provider: 'cloudflare',
          model,
          latencyMs,
        };
      }

      const endpoint = config.cloudflareGatewaySlug?.trim()
        ? `https://gateway.ai.cloudflare.com/v1/${config.cloudflareAccountId.trim()}/${config.cloudflareGatewaySlug.trim()}/workers-ai/chat/completions`
        : `${config.cloudflareBaseUrl.replace(/\/+$/, '')}/${config.cloudflareAccountId.trim()}/ai/v1/chat/completions`;

      const res = await callOpenAICompatibleEndpoint(
        endpoint,
        config.cloudflareApiToken.trim(),
        model,
        prompt,
        config
      );
      const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
      recordOperatorLatency({
        provider: 'cloudflare',
        model,
        taskType: classifyTaskType(res.actions),
        latencyMs,
        success: true,
      });
      return {
        success: true,
        text: res.reply,
        provider: 'cloudflare',
        model,
        latencyMs,
      };
    }

    if (provider === 'grok') {
      if (shouldUseGrokHttpApi(config)) {
        try {
          const res = await callOpenAICompatibleEndpoint(
            config.grokBaseUrl,
            config.grokApiKey.trim(),
            model,
            prompt,
            config
          );
          const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
          recordOperatorLatency({
            provider: 'grok',
            model,
            taskType: classifyTaskType(res.actions),
            latencyMs,
            success: true,
          });
          return {
            success: true,
            text: res.reply,
            provider: 'grok',
            model,
            latencyMs,
          };
        } catch (err) {
          const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
          const message =
            err instanceof Error ? err.message : 'Error al consultar la API de xAI.';
          recordOperatorLatency({
            provider: 'grok',
            model,
            taskType: 'chat_response',
            latencyMs,
            success: false,
            notes: message,
          });
          return {
            success: false,
            error: message,
            provider: 'grok',
            model,
            latencyMs,
          };
        }
      }

      if (!shouldUseGrokCli(config)) {
        const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
        const errMsg =
          'Falta la API Key de xAI (console.x.ai) o activa la suscripción CLI local de Grok.';
        recordOperatorLatency({
          provider: 'grok',
          model,
          taskType: 'chat_response',
          latencyMs,
          success: false,
          notes: errMsg,
        });
        return {
          success: false,
          error: errMsg,
          provider: 'grok',
          model,
          latencyMs,
        };
      }

      const res = await invokeCommand<{
        success?: boolean;
        stdout?: string;
        stderr?: string;
        model?: string;
      }>('query_operator_agent', {
        engine: 'grok',
        prompt,
        model,
        timeoutSecs: 15,
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
      const text = res?.stdout?.trim() || '';
      const ok = Boolean(res?.success !== false && text);
      recordOperatorLatency({
        provider: 'grok',
        model,
        taskType: 'chat_response',
        latencyMs,
        success: ok,
      });
      return {
        success: ok,
        text: ok ? text : undefined,
        error: ok ? undefined : res?.stderr || 'Sin respuesta de Grok CLI',
        provider: 'grok',
        model,
        latencyMs,
      };
    }

    // antigravity
    const res = await invokeCommand<{
      success?: boolean;
      stdout?: string;
      stderr?: string;
      model?: string;
    }>('query_operator_agent', {
      engine: 'antigravity',
      prompt,
      model,
      timeoutSecs: 15,
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    const text = res?.stdout?.trim() || '';
    const ok = Boolean(res?.success !== false && text);
    recordOperatorLatency({
      provider: 'antigravity',
      model,
      taskType: 'chat_response',
      latencyMs,
      success: ok,
    });
    return {
      success: ok,
      text: ok ? text : undefined,
      error: ok ? undefined : res?.stderr || 'Sin respuesta de Anti-Gravity CLI',
      provider: 'antigravity',
      model,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    const message = err instanceof Error ? err.message : String(err);
    recordOperatorLatency({
      provider,
      model,
      taskType: 'chat_response',
      latencyMs,
      success: false,
      notes: message,
    });
    return {
      success: false,
      error: message,
      provider,
      model,
      latencyMs,
    };
  }
}

export async function probeProviderLatency(
  providerId: OperatorProviderId,
  config: OperatorProviderConfig = loadOperatorConfig()
): Promise<{ ok: boolean; latencyMs: number; modelLabel: string; detail: string }> {
  const modelLabel = getActiveModelForProvider(config, providerId);
  const res = await queryOperatorLLM('Responde solo: OK', providerId, config);
  return {
    ok: res.success,
    latencyMs: res.latencyMs,
    modelLabel: res.model || modelLabel,
    detail: res.success ? res.text || 'OK' : res.error || 'Error en prueba de latencia',
  };
}

export async function benchmarkAllProviders(
  prompt = 'Ping'
): Promise<Record<OperatorProviderId, OperatorLLMQueryResult>> {
  const providers: OperatorProviderId[] = ['local', 'opencode', 'vercel', 'cloudflare', 'antigravity', 'grok'];
  const entries = await Promise.all(
    providers.map(async (p) => [p, await queryOperatorLLM(prompt, p)] as const)
  );
  return Object.fromEntries(entries) as Record<OperatorProviderId, OperatorLLMQueryResult>;
}

export async function dispatchOperatorWithProvider(
  userInput: string,
  localFallbackParser: (input: string) => { actions: OperatorAction[]; reply: string },
  workspaceContext?: string,
  overrideConfig?: OperatorProviderConfig
): Promise<ProviderExecutionResult> {
  const config = overrideConfig ?? loadOperatorConfig();
  const provider = config.activeProvider;
  const rawModel = getActiveModelForProvider(config, provider);
  const model = resolveVerifiedModel(provider, rawModel, 'fast');
  const startTime = performance.now();

  const localResult = localFallbackParser(userInput);
  const isDeterministic = localResult.actions.length > 0;

  if (provider === 'local' || isDeterministic) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    const taskType = classifyTaskType(localResult.actions);
    recordOperatorLatency({
      provider: 'local',
      model: 'deterministic-heuristic',
      taskType,
      latencyMs,
      success: true,
      notes: 'Instant local deterministic controller',
    });
    return {
      provider: 'local',
      model: 'deterministic-heuristic',
      latencyMs,
      taskType,
      actions: localResult.actions,
      reply: localResult.reply,
      usedFallbackLocal: false,
    };
  }

  try {
    let remoteResult: { reply: string; actions: OperatorAction[]; rawContent?: string };

    if (provider === 'opencode') {
      if (!config.opencodeApiKey.trim() && !isTauriEnvironment()) {
        throw new Error('Falta configurar la API Key de OpenCode Go en Configuraciones -> Asistente Zed.');
      }
      const verifiedModel = resolveVerifiedModel('opencode', config.opencodeModel, 'fast');
      remoteResult = await callOpenAICompatibleEndpoint(
        config.opencodeBaseUrl,
        config.opencodeApiKey.trim(),
        verifiedModel,
        userInput,
        config,
        workspaceContext,
        {
          sessionId: getOrCreateOpenCodeSessionId(config),
          credentialProvider: 'opencode',
        }
      );
    } else if (provider === 'vercel') {
      if (!config.vercelApiKey.trim()) {
        throw new Error('Falta configurar la API Key de Vercel AI en Configuraciones -> Asistente Zed.');
      }
      const verifiedModel = resolveVerifiedModel('vercel', config.vercelModel, 'fast');
      remoteResult = await callOpenAICompatibleEndpoint(
        config.vercelBaseUrl,
        config.vercelApiKey.trim(),
        verifiedModel,
        userInput,
        config,
        workspaceContext
      );
    } else if (provider === 'cloudflare') {
      if (!config.cloudflareAccountId.trim() || !config.cloudflareApiToken.trim()) {
        throw new Error('Falta configurar el Account ID o API Token de Cloudflare en Configuraciones -> Asistente Zed.');
      }
      const endpoint = config.cloudflareGatewaySlug?.trim()
        ? `https://gateway.ai.cloudflare.com/v1/${config.cloudflareAccountId.trim()}/${config.cloudflareGatewaySlug.trim()}/workers-ai/chat/completions`
        : `${config.cloudflareBaseUrl.replace(/\/+$/, '')}/${config.cloudflareAccountId.trim()}/ai/v1/chat/completions`;

      const verifiedModel = resolveVerifiedModel('cloudflare', config.cloudflareModel, 'fast');
      remoteResult = await callOpenAICompatibleEndpoint(
        endpoint,
        config.cloudflareApiToken.trim(),
        verifiedModel,
        userInput,
        config,
        workspaceContext
      );
    } else if (provider === 'grok') {
      const verifiedModel = resolveVerifiedModel('grok', config.grokModel, 'fast');
      if (shouldUseGrokHttpApi(config)) {
        remoteResult = await callOpenAICompatibleEndpoint(
          config.grokBaseUrl,
          config.grokApiKey.trim(),
          verifiedModel,
          userInput,
          config,
          workspaceContext
        );
      } else if (shouldUseGrokCli(config)) {
        remoteResult = await callCliSubscriptionProvider(
          'grok',
          verifiedModel,
          userInput,
          config,
          workspaceContext
        );
      } else {
        throw new Error(
          'Falta la API Key de xAI (console.x.ai) o activa la suscripción CLI local de Grok.'
        );
      }
    } else {
      const verifiedModel = resolveVerifiedModel('antigravity', config.antigravityModel, 'fast');
      remoteResult = await callCliSubscriptionProvider(
        config.antigravityCommand || 'antigravity',
        verifiedModel,
        userInput,
        config,
        workspaceContext
      );
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    const taskType = classifyTaskType(remoteResult.actions);

    recordOperatorLatency({
      provider,
      model,
      taskType,
      latencyMs,
      success: true,
    });

    return {
      provider,
      model,
      latencyMs,
      taskType,
      actions: remoteResult.actions,
      reply: remoteResult.reply,
      usedFallbackLocal: false,
      rawContent: remoteResult.rawContent,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const localResult = localFallbackParser(userInput);
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    const taskType = classifyTaskType(localResult.actions);

    recordOperatorLatency({
      provider,
      model,
      taskType,
      latencyMs,
      success: false,
      notes: errorMsg,
    });

    return {
      provider,
      model,
      latencyMs,
      taskType,
      actions: localResult.actions,
      reply: localResult.reply,
      usedFallbackLocal: true,
      error: errorMsg,
    };
  }
}
