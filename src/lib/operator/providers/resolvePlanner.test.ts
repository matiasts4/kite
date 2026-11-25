import { describe, expect, it } from 'vitest';
import { DEFAULT_OPERATOR_CONFIG } from '../config/storage';
import {
  resolvePlannerProvider,
  resolveTieredPlannerProviders,
  resolveVerifiedModel,
} from './resolvePlanner';

describe('resolvePlanner — Tiered L1 (fast) & L2 (diagnosis) Routing (S3/T3)', () => {
  it('resolves fast tier by default and promotes to diagnosis tier when forceTierModel=true', () => {
    const fast = resolveVerifiedModel('opencode', 'deepseek-v4.1-flash', 'fast');
    const diagnosis = resolveVerifiedModel('opencode', 'deepseek-v4.1-flash', 'diagnosis', {
      forceTierModel: true,
    });
    expect(fast).toBe('deepseek-v4.1-flash');
    expect(diagnosis).toBe('deepseek-v4-pro');

    const explicitCustom = resolveVerifiedModel('opencode', 'kimi-k3', 'diagnosis');
    expect(explicitCustom).toBe('kimi-k3');
  });

  it('builds distinct L1 fast and L2 diagnosis providers with canEscalate=true when tier models differ', () => {
    const cfg = {
      ...DEFAULT_OPERATOR_CONFIG,
      activeProvider: 'opencode' as const,
      opencodeApiKey: 'test-key',
      opencodeModel: 'deepseek-v4.1-flash',
    };
    const tiered = resolveTieredPlannerProviders(cfg);
    expect(tiered.l1Provider.id).toBe('opencode');
    expect(tiered.l2Provider.id).toBe('opencode');
    expect(tiered.canEscalate).toBe(true);

    const localTiered = resolveTieredPlannerProviders({
      ...cfg,
      activeProvider: 'local',
    });
    expect(localTiered.l1Provider.id).toBe('local');
    expect(localTiered.canEscalate).toBe(false);
    expect(resolvePlannerProvider(cfg, 'fast').id).toBe('opencode');
  });
});
