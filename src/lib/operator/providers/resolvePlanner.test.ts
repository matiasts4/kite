import { describe, expect, it } from 'vitest';
import { resolvePlannerProvider, resolveVerifiedModel } from './resolvePlanner';
import { DEFAULT_OPERATOR_CONFIG } from '../operatorConfig';

describe('resolveVerifiedModel', () => {
  it('sends the model the user selected even when it is outside the short default list', () => {
    expect(
      resolveVerifiedModel('cloudflare', '@cf/deepseek-ai/deepseek-v4.1-flash-1017', 'fast')
    ).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
    expect(resolveVerifiedModel('vercel', 'google/gemini-2.5-flash', 'fast')).toBe(
      'google/gemini-2.5-flash'
    );
    expect(resolveVerifiedModel('grok', 'grok-4-fast', 'diagnosis')).toBe('grok-4-fast');
  });

  it('falls back to the tier default only when no model was selected', () => {
    expect(resolveVerifiedModel('cloudflare', '  ', 'fast')).toBe(
      '@cf/meta/llama-3.1-8b-instruct-fp8'
    );
    expect(resolveVerifiedModel('opencode', undefined, 'diagnosis')).toBe('deepseek-v4-pro');
  });
});

describe('resolvePlannerProvider', () => {
  it('builds the Cloudflare planner with the selected model id', () => {
    const provider = resolvePlannerProvider({
      ...DEFAULT_OPERATOR_CONFIG,
      activeProvider: 'cloudflare',
      cloudflareAccountId: 'acc',
      cloudflareApiToken: 'tok',
      cloudflareModel: '@cf/meta/llama-3.1-8b-instruct',
    });

    expect(provider.id).toBe('cloudflare');
    expect((provider as { model?: string }).model).toBe('@cf/meta/llama-3.1-8b-instruct');
  });
});
