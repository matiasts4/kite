import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getOperatorConfig,
  saveOperatorConfig,
  recordLatencyMetric,
  getLatencyHistory,
  clearLatencyHistory,
  getProviderLatencyStats,
  DEFAULT_OPERATOR_CONFIG,
} from './operatorConfig';
import {
  queryOperatorLLM,
  benchmarkAllProviders,
  isVerifiedChatEndpoint,
  zedChatConnections,
  zedChatProviderIdsForConnections,
} from './operatorProviders';
import { isVerifiedQuotaEndpoint, quotaConnections } from '../quota/quotaManager';
import { invokeCommand, type ConnectionSummary } from '../ipc';

vi.mock('../ipc', () => ({
  isTauriEnvironment: vi.fn(() => false),
  invokeCommand: vi.fn(),
  listConnections: vi.fn(async () => []),
}));

const OPENCODE_GO_USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_GO_CHAT_ENDPOINT =
  'https://opencode.ai/inference/go/openai/v1/chat/completions';

function connection(
  driverKind: string,
  endpoints: ConnectionSummary['endpoints'],
  overrides: Partial<ConnectionSummary> = {},
): ConnectionSummary {
  return {
    connectionId: `${driverKind}:api_key:email=|org=|account=`,
    driverKind,
    displayName: driverKind,
    authMethod: 'api_key',
    accountIdentity: {},
    credentialRef: 'vault',
    billingMode: null,
    endpoints,
    status: 'verified',
    lastCheckedMs: null,
    expiresMs: null,
    lastHttpStatus: null,
    ...overrides,
  };
}

describe('Operator Providers & Latency Benchmarks', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLatencyHistory();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('operatorConfig store & stats aggregation', () => {
    it('returns default configuration initially', () => {
      const config = getOperatorConfig();
      expect(config.activeProvider).toBe(DEFAULT_OPERATOR_CONFIG.activeProvider);
      expect(config.opencodeModel).toBe('deepseek-v4.1-flash');
      expect(config.antigravityModel).toBe('gemini-3.8-flash');
      expect(config.grokModel).toBe('grok-4.7');
    });

    it('saves updated configuration and dispatches change event', () => {
      const eventSpy = vi.fn();
      window.addEventListener('kite:operator-config-changed', eventSpy);

      const updated = saveOperatorConfig({
        activeProvider: 'antigravity',
        antigravityModel: 'gemini-2.5-flash',
      });

      expect(updated.activeProvider).toBe('antigravity');
      expect(updated.antigravityModel).toBe('gemini-2.5-flash');
      expect(eventSpy).toHaveBeenCalledTimes(1);

      const reloaded = getOperatorConfig();
      expect(reloaded.activeProvider).toBe('antigravity');
      expect(reloaded.antigravityModel).toBe('gemini-2.5-flash');

      window.removeEventListener('kite:operator-config-changed', eventSpy);
    });

    it('records latency metrics and aggregates stats per provider', () => {
      recordLatencyMetric({
        provider: 'opencode',
        model: 'deepseek-4.1-flash',
        command: 'test command 1',
        latencyMs: 300,
        success: true,
      });

      recordLatencyMetric({
        provider: 'opencode',
        model: 'deepseek-4.1-flash',
        command: 'test command 2',
        latencyMs: 500,
        success: true,
      });

      recordLatencyMetric({
        provider: 'opencode',
        model: 'deepseek-4.1-flash',
        command: 'test command 3',
        latencyMs: 700,
        success: false,
        error: 'timeout',
      });

      const stats = getProviderLatencyStats();
      const opencodeStats = stats['opencode'];

      expect(opencodeStats.sampleCount).toBe(3);
      expect(opencodeStats.avgMs).toBe(500); // (300 + 500 + 700) / 3
      expect(opencodeStats.minMs).toBe(300);
      expect(opencodeStats.maxMs).toBe(700);
      expect(opencodeStats.successRate).toBe(67); // 2 of 3 rounded
      expect(opencodeStats.lastMs).toBe(700);

      // Local heuristic has no calls yet
      expect(stats['local'].sampleCount).toBe(0);
      expect(stats['local'].successRate).toBe(100);
    });
  });

  describe('queryOperatorLLM', () => {
    it('executes local provider instantly', async () => {
      const res = await queryOperatorLLM('prueba', 'local');

      expect(res.success).toBe(true);
      expect(res.provider).toBe('local');
      expect(res.model).toBe('local-heuristic-v1');
      expect(res.text).toContain('Comando procesado localmente');
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);

      const history = getLatencyHistory();
      expect(history.length).toBe(1);
      expect(history[0].provider).toBe('local');
    });

    it('returns error when opencode has no API key', async () => {
      saveOperatorConfig({
        activeProvider: 'opencode',
        opencodeApiKey: '',
      });

      const res = await queryOperatorLLM('hola', 'opencode');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Falta la API Key de OpenCode');
    });

    it('queries opencode gateway via direct fetch when API key is provided', async () => {
      saveOperatorConfig({
        activeProvider: 'opencode',
        opencodeApiKey: 'sk-test-key-1234',
        opencodeBaseUrl: 'https://opencode.ai/inference/v1',
        opencodeModel: 'deepseek-v4.1-flash',
      });

      const mockResponse = {
        choices: [
          {
            message: {
              content: 'Hola, soy el asistente Zed de Kite.',
            },
          },
        ],
        model: 'deepseek-v4.1-flash',
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const res = await queryOperatorLLM('hola', 'opencode');

      expect(res.success).toBe(true);
      expect(res.text).toBe('Hola, soy el asistente Zed de Kite.');
      expect(res.model).toBe('deepseek-v4.1-flash');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://opencode.ai/inference/go/openai/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key-1234',
            'x-opencode-session': expect.stringMatching(/^ses_kite_/),
          }),
        })
      );
    });

    it('handles opencode HTTP error gracefully', async () => {
      saveOperatorConfig({
        activeProvider: 'opencode',
        opencodeApiKey: 'sk-invalid-key',
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid API key provided',
      } as Response);

      const res = await queryOperatorLLM('hola', 'opencode');

      expect(res.success).toBe(false);
      expect(res.error).toContain('HTTP 401');
    });

    it('queries Anti-Gravity via Tauri IPC', async () => {
      saveOperatorConfig({
        activeProvider: 'antigravity',
        antigravityModel: 'gemini-3.8-flash',
      });

      const mockedInvoke = vi.mocked(invokeCommand).mockResolvedValueOnce({
        success: true,
        stdout: 'Respuesta generada por AntiGravity Gemini Flash.',
        model: 'gemini-3.8-flash',
      });

      const res = await queryOperatorLLM('Dame sugerencias', 'antigravity');

      expect(res.success).toBe(true);
      expect(res.text).toContain('Respuesta generada por AntiGravity');
      expect(mockedInvoke).toHaveBeenCalledWith('query_operator_agent', {
        engine: 'antigravity',
        prompt: 'Dame sugerencias',
        model: 'gemini-3.8-flash',
        timeoutSecs: 15,
      });
    });

    it('queries Grok via Tauri IPC when CLI subscription is enabled', async () => {
      saveOperatorConfig({
        activeProvider: 'grok',
        grokModel: 'grok-4.7',
        grokApiKey: '',
        grokUseCliSubscription: true,
      });

      const mockedInvoke = vi.mocked(invokeCommand).mockResolvedValueOnce({
        success: true,
        stdout: 'Respuesta generada por Grok xAI.',
        model: 'grok-4.7',
      });

      const res = await queryOperatorLLM('Dame estado', 'grok');

      expect(res.success).toBe(true);
      expect(res.text).toContain('Respuesta generada por Grok');
      expect(mockedInvoke).toHaveBeenCalledWith('query_operator_agent', {
        engine: 'grok',
        prompt: 'Dame estado',
        model: 'grok-4.7',
        timeoutSecs: 15,
      });
    });

    it('prefers Grok HTTP API when an API key is set (probe config override)', async () => {
      const draftConfig = {
        ...getOperatorConfig(),
        activeProvider: 'grok' as const,
        grokApiKey: 'xai-test-key',
        grokModel: 'grok-4.7',
        grokUseCliSubscription: true,
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK desde API' } }],
        }),
      } as Response);

      const res = await queryOperatorLLM('Ping', 'grok', draftConfig);

      expect(res.success).toBe(true);
      expect(res.text).toContain('OK desde API');
      expect(fetchSpy).toHaveBeenCalled();
      expect(invokeCommand).not.toHaveBeenCalled();
    });
    it('queries Vercel AI Gateway successfully', async () => {
      saveOperatorConfig({
        activeProvider: 'vercel',
        vercelApiKey: 'vck-test-key-1234',
        vercelModel: 'deepseek/deepseek-chat',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"reply": "Respuesta desde Vercel AI SDK", "actions": []}',
              },
            },
          ],
          model: 'deepseek/deepseek-chat',
        }),
      } as Response);

      const res = await queryOperatorLLM('hola vercel', 'vercel');

      expect(res.success).toBe(true);
      expect(res.text).toBe('Respuesta desde Vercel AI SDK');
      expect(res.model).toBe('deepseek/deepseek-chat');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://ai-gateway.vercel.sh/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer vck-test-key-1234',
          }),
        })
      );
    });

    it('handles vercel missing API key gracefully', async () => {
      saveOperatorConfig({
        activeProvider: 'vercel',
        vercelApiKey: '',
      });

      const res = await queryOperatorLLM('hola', 'vercel');

      expect(res.success).toBe(false);
      expect(res.error).toContain('Falta la API Key de Vercel AI');
    });

    it('queries cloudflare workers ai endpoint when credentials provided', async () => {
      saveOperatorConfig({
        activeProvider: 'cloudflare',
        cloudflareAccountId: 'cf-acc-123',
        cloudflareApiToken: 'cf-tok-456',
        cloudflareModel: '@cf/meta/llama-3.1-8b-instruct',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Respuesta desde Cloudflare Workers AI' } }],
          model: '@cf/meta/llama-3.1-8b-instruct',
        }),
      } as Response);

      const res = await queryOperatorLLM('hola cloudflare', 'cloudflare');

      expect(res.success).toBe(true);
      expect(res.text).toBe('Respuesta desde Cloudflare Workers AI');
      expect(res.model).toBe('@cf/meta/llama-3.1-8b-instruct');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/cf-acc-123/ai/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer cf-tok-456',
          }),
        })
      );
    });

    it('queries cloudflare AI Gateway when gateway slug is provided', async () => {
      saveOperatorConfig({
        activeProvider: 'cloudflare',
        cloudflareAccountId: 'cf-acc-123',
        cloudflareApiToken: 'cf-tok-456',
        cloudflareGatewaySlug: 'kite-edge-gateway',
        cloudflareModel: '@cf/meta/llama-3.1-8b-instruct',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Respuesta desde Cloudflare AI Gateway' } }],
        }),
      } as Response);

      const res = await queryOperatorLLM('hola gateway', 'cloudflare');

      expect(res.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://gateway.ai.cloudflare.com/v1/cf-acc-123/kite-edge-gateway/workers-ai/chat/completions',
        expect.anything()
      );
    });

    it('handles cloudflare missing credentials gracefully', async () => {
      saveOperatorConfig({
        activeProvider: 'cloudflare',
        cloudflareAccountId: '',
        cloudflareApiToken: '',
      });

      const res = await queryOperatorLLM('hola', 'cloudflare');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Falta el Account ID o API Token de Cloudflare');
    });
  });

  describe('benchmarkAllProviders', () => {
    it('benchmarks all providers and aggregates results', async () => {
      saveOperatorConfig({
        opencodeApiKey: 'sk-test',
        vercelApiKey: 'vck-test',
        cloudflareAccountId: 'cf-acc-123',
        cloudflareApiToken: 'cf-tok-456',
        grokApiKey: 'xai-test',
        grokModel: 'grok-4.7',
      });

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'OK OpenCode' } }],
            model: 'deepseek-v4.1-flash',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'OK Vercel' } }],
            model: 'deepseek/deepseek-chat',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'OK Cloudflare' } }],
            model: '@cf/meta/llama-3.1-8b-instruct',
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'OK Grok' } }],
            model: 'grok-4.7',
          }),
        } as Response);

      vi.mocked(invokeCommand).mockResolvedValueOnce({
        success: true,
        stdout: 'OK',
        model: 'gemini-3.8-flash',
      }); // antigravity

      const results = await benchmarkAllProviders('Ping');

      expect(results['local'].success).toBe(true);
      expect(results['opencode'].success).toBe(true);
      expect(results['vercel'].success).toBe(true);
      expect(results['cloudflare'].success).toBe(true);
      expect(results['antigravity'].success).toBe(true);
      expect(results['grok'].success).toBe(true);
    });
  });

  describe('shared connection registry projection', () => {
    it('lists a quota-only connection in quotas and omits it from the Zed chat list', () => {
      const quotaOnly = connection('opencode', [
        { endpointId: OPENCODE_GO_USAGE_ENDPOINT, ok: true },
      ]);
      const consoleStatus = connection(
        'opencode',
        [{ endpointId: 'https://opencode.ai/console/api/go/status', ok: true }],
        {
          authMethod: 'console_oauth',
          connectionId: 'opencode:console_oauth:email=|org=org-42|account=',
        },
      );

      expect(quotaConnections([quotaOnly, consoleStatus])).toEqual([quotaOnly, consoleStatus]);
      expect(zedChatConnections([quotaOnly, consoleStatus])).toEqual([]);
      expect(zedChatProviderIdsForConnections([quotaOnly, consoleStatus])).toEqual([]);
    });

    it('lists a connection with a verified chat endpoint in the Zed chat list', () => {
      const chat = connection('opencode', [
        { endpointId: OPENCODE_GO_CHAT_ENDPOINT, ok: true },
      ]);

      expect(zedChatConnections([chat])).toEqual([chat]);
      expect(zedChatProviderIdsForConnections([chat])).toEqual(['opencode']);
      expect(quotaConnections([chat])).toEqual([]);
    });

    it('ignores an endpoint that is present but not verified', () => {
      const unverified = connection('opencode', [
        { endpointId: OPENCODE_GO_CHAT_ENDPOINT, ok: false },
        { endpointId: OPENCODE_GO_USAGE_ENDPOINT, ok: false },
      ]);

      expect(zedChatConnections([unverified])).toEqual([]);
      expect(quotaConnections([unverified])).toEqual([]);
    });

    it('never derives a capability from the driver id alone', () => {
      const quotaOnly = connection('antigravity', [
        { endpointId: 'cli:agy -p /usage', ok: true },
      ]);
      const cliChat = connection('antigravity', [{ endpointId: 'cli:agy -p', ok: true }], {
        authMethod: 'cli_session',
        connectionId: 'antigravity:cli_session:email=|org=|account=',
      });
      const acpChat = connection(
        'antigravity',
        [{ endpointId: 'acp:session/new', ok: true }],
        { authMethod: 'acp', connectionId: 'antigravity:acp:email=|org=|account=' },
      );

      expect(zedChatProviderIdsForConnections([quotaOnly])).toEqual([]);
      expect(zedChatProviderIdsForConnections([cliChat])).toEqual(['antigravity']);
      // The Zed operator has no ACP spawn yet, so a verified ACP session does
      // not add a provider row.
      expect(zedChatProviderIdsForConnections([acpChat])).toEqual([]);
      expect(quotaConnections([quotaOnly])).toEqual([quotaOnly]);
      expect(quotaConnections([acpChat])).toEqual([]);
      expect(isVerifiedChatEndpoint('cli:agy -p /usage')).toBe(false);
      expect(isVerifiedChatEndpoint('acp:session/new')).toBe(false);
      expect(isVerifiedQuotaEndpoint('cli:agy -p /usage')).toBe(true);
    });

    it('drops drivers the Zed operator cannot call', () => {
      const claudeChat = connection('claude', [
        { endpointId: 'https://api.anthropic.com/v1/messages', ok: true },
      ]);

      expect(zedChatConnections([claudeChat])).toEqual([]);
      expect(zedChatProviderIdsForConnections([claudeChat])).toEqual([]);
    });
  });
});
