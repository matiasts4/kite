import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchOpenCodeModels,
  fetchOpenCodeGoModels,
  fetchVercelModels,
  fetchCloudflareModels,
  loadModelCatalog,
  saveModelCatalog,
} from './operatorConfig';

vi.mock('../ipc', () => ({
  isTauriEnvironment: vi.fn(() => false),
  invokeCommand: vi.fn(),
}));

const sample = {
  id: 'deepseek-custom',
  label: 'DeepSeek Custom',
  badge: 'Fast',
  tier: 'Fast',
  description: 'Modelo de prueba',
};

describe('Zed model catalog cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts empty and keeps the last saved list', () => {
    expect(loadModelCatalog('opencode')).toBeNull();

    const saved = saveModelCatalog('opencode', [sample]);

    expect(saved.models).toEqual([sample]);
    expect(saved.savedAt).toBeTruthy();
    expect(loadModelCatalog('opencode')?.models).toEqual([sample]);
    expect(loadModelCatalog('vercel')).toBeNull();
  });

  it('ignores a corrupt catalog and keeps the other provider', () => {
    saveModelCatalog('vercel', [sample]);
    localStorage.setItem('kite.operator.modelCatalog.opencode.v2', '{');

    expect(loadModelCatalog('opencode')).toBeNull();
    expect(loadModelCatalog('vercel')?.models[0].id).toBe('deepseek-custom');
  });

  it('stores a fresh OpenCode list and keeps it when the next refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'alpha-model', name: 'Alpha' }] }),
      })
    );

    const fresh = await fetchOpenCodeModels('test-key', 'https://example.test/v1');
    expect(fresh.fresh).toBe(true);
    expect(fresh.models.map((model) => model.id)).toContain('alpha-model');
    expect(loadModelCatalog('opencode')?.models.map((model) => model.id)).toContain('alpha-model');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      })
    );

    const kept = await fetchOpenCodeModels('test-key', 'https://example.test/v1');
    expect(kept.fresh).toBe(false);
    expect(kept.models.map((model) => model.id)).toContain('alpha-model');
    expect(kept.detail).toContain('última lista');
  });

  it('keeps only Chat Completions models from the OpenCode Go catalog', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'deepseek-v4.1-flash' },
          { id: 'kimi-k3' },
          { id: 'gpt-6-luna' },
          { id: 'claude-haiku-5-5' },
          { id: 'gemini-4-argon-contributor' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchOpenCodeGoModels('test-key');
    const ids = result.models.map((model) => model.id);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/models',
      expect.objectContaining({ method: 'GET' })
    );
    expect(ids).toContain('deepseek-v4.1-flash');
    expect(ids).toContain('kimi-k3');
    expect(ids).not.toContain('gpt-6-luna');
    expect(ids).not.toContain('claude-haiku-5-5');
    expect(ids).not.toContain('gemini-4-argon-contributor');
  });

  it('keeps the saved Vercel list when the gateway cannot be reached', async () => {
    saveModelCatalog('vercel', [sample]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const kept = await fetchVercelModels('test-key', 'https://example.test/v1');

    expect(kept.fresh).toBe(false);
    expect(kept.models).toEqual([sample]);
    expect(kept.savedAt).toBeTruthy();
  });

  it('stores a fresh Cloudflare list and keeps it when subsequent refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            { id: '@cf/meta/llama-3.1-8b-instruct', name: '@cf/meta/llama-3.1-8b-instruct', description: 'Fast 8B' },
          ],
        }),
      })
    );

    const fresh = await fetchCloudflareModels('test-token', 'test-account', 'https://example.test');
    expect(fresh.fresh).toBe(true);
    expect(fresh.models.map((m) => m.id)).toContain('@cf/meta/llama-3.1-8b-instruct');
    expect(loadModelCatalog('cloudflare')?.models.map((m) => m.id)).toContain('@cf/meta/llama-3.1-8b-instruct');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const kept = await fetchCloudflareModels('test-token', 'test-account', 'https://example.test');
    expect(kept.fresh).toBe(false);
    expect(kept.models.map((m) => m.id)).toContain('@cf/meta/llama-3.1-8b-instruct');
  });
});
