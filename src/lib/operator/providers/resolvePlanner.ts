import {
  getOrCreateOpenCodeSessionId,
  shouldUseGrokCli,
  shouldUseGrokHttpApi,
  type OperatorProviderConfig,
} from '../operatorConfig';
import type { PlannerProvider } from './types';
import { LocalPlannerProvider } from './local';
import { OpenAiCompatPlannerProvider } from './openaiCompat';
import { CliPlannerProvider } from './cli';

export const VERIFIED_PROVIDER_MODELS: Record<string, { fast: string; diagnosis: string; verified: string[] }> = {
  opencode: {
    fast: 'deepseek-v4.1-flash',
    diagnosis: 'deepseek-v4-pro',
    verified: [
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'kimi-k3',
      'kimi-k2.7-code',
      'minimax-m3',
      'minimax-m3.1-flash',
      'glm-5.3',
      'glm-5.3-flash',
      'qwen3.8-flash',
      'qwen3.8-max',
      'mimo-v2.6-flash',
      'mimo-v2.6-pro',
      'hy3',
      'step-5-preview',
    ],
  },
  vercel: {
    fast: 'deepseek/deepseek-chat',
    diagnosis: 'anthropic/claude-3-5-sonnet',
    verified: ['deepseek/deepseek-chat', 'anthropic/claude-3-5-sonnet', 'openai/gpt-4o-mini', 'openai/gpt-4o'],
  },
  cloudflare: {
    fast: '@cf/meta/llama-3.1-8b-instruct-fp8',
    diagnosis: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    verified: ['@cf/meta/llama-3.1-8b-instruct-fp8', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
  },
  grok: {
    fast: 'grok-4.7',
    diagnosis: 'grok-4.7',
    verified: ['grok-4.7', 'grok-beta', 'grok-2'],
  },
  antigravity: {
    fast: 'gemini-3.8-flash',
    diagnosis: 'gemini-3.8-pro',
    verified: ['gemini-3.8-flash', 'gemini-3.8-pro', 'claude-3-7-sonnet'],
  },
  local: {
    fast: 'deterministic-heuristic',
    diagnosis: 'deterministic-heuristic',
    verified: ['deterministic-heuristic'],
  },
};

export function resolveVerifiedModel(
  provider: string,
  requestedModel?: string,
  tier: 'fast' | 'diagnosis' = 'fast'
): string {
  const catalog = VERIFIED_PROVIDER_MODELS[provider];
  if (!catalog) return (requestedModel && requestedModel.trim()) || 'unknown';

  const requested = requestedModel?.trim();
  if (requested) {
    // The settings catalog is the source of truth. Replacing an explicit id
    // with the fast default sent a different model than the one the user picked.
    return requested;
  }

  return catalog[tier];
}

export function resolvePlannerProvider(
  config: OperatorProviderConfig,
  tier: 'fast' | 'diagnosis' = 'fast'
): PlannerProvider {
  if (config.activeProvider === 'local') {
    return new LocalPlannerProvider();
  }
  if (config.activeProvider === 'opencode') {
    const model = resolveVerifiedModel('opencode', config.opencodeModel, tier);
    return new OpenAiCompatPlannerProvider({
      id: 'opencode',
      baseUrl: config.opencodeBaseUrl || 'https://opencode.ai/inference/go/openai/v1',
      apiKey: config.opencodeApiKey || '',
      model,
      credentialProvider: 'opencode',
      sessionId: getOrCreateOpenCodeSessionId(config),
    });
  }
  if (config.activeProvider === 'vercel') {
    const model = resolveVerifiedModel('vercel', config.vercelModel, tier);
    return new OpenAiCompatPlannerProvider({
      id: 'vercel',
      baseUrl: config.vercelBaseUrl || 'https://ai-gateway.vercel.app/v1',
      apiKey: config.vercelApiKey || '',
      model,
    });
  }
  if (config.activeProvider === 'cloudflare') {
    let cfBase = config.cloudflareBaseUrl || 'https://api.cloudflare.com/client/v4/accounts';
    const accountId = (config.cloudflareAccountId || '').trim();
    const gatewaySlug = (config.cloudflareGatewaySlug || '').trim();

    if (gatewaySlug && accountId) {
      cfBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewaySlug}/workers-ai`;
    } else if (accountId && !cfBase.includes(accountId)) {
      cfBase = `${cfBase.replace(/\/+$/, '')}/${accountId}/ai/v1`;
    }

    const model = resolveVerifiedModel('cloudflare', config.cloudflareModel, tier);
    return new OpenAiCompatPlannerProvider({
      id: 'cloudflare',
      baseUrl: cfBase,
      apiKey: config.cloudflareApiToken || '',
      model,
    });
  }
  if (config.activeProvider === 'grok') {
    const model = resolveVerifiedModel('grok', config.grokModel, tier);
    if (shouldUseGrokHttpApi(config)) {
      return new OpenAiCompatPlannerProvider({
        id: 'grok',
        baseUrl: config.grokBaseUrl || 'https://api.x.ai/v1',
        apiKey: config.grokApiKey,
        model,
      });
    }
    if (shouldUseGrokCli(config)) {
      return new CliPlannerProvider({
        engine: 'grok',
        model,
      });
    }
    return new LocalPlannerProvider();
  }
  if (config.activeProvider === 'antigravity') {
    const model = resolveVerifiedModel('antigravity', config.antigravityModel, tier);
    return new CliPlannerProvider({
      engine: 'antigravity',
      model,
    });
  }
  return new LocalPlannerProvider();
}
