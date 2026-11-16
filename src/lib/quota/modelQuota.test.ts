import { describe, expect, it } from 'vitest';
import type { ProviderQuotaStatus } from './types';
import {
  collectExhaustedModelWindows,
  isWindowExhausted,
  isWindowLow,
  resolveModelQuotaWindow,
} from './modelQuota';

function makeAntigravityStatus(argonRemaining = 0, gemini5hRemaining = 0.73): ProviderQuotaStatus {
  return {
    providerId: 'antigravity',
    displayName: 'Antigravity',
    isAvailable: true,
    isAuth: true,
    primaryUsagePercent: Math.round((1 - gemini5hRemaining) * 100),
    primaryRemainingPercent: Math.round(gemini5hRemaining * 100),
    primaryResetAt: '2026-11-16T23:07:38Z',
    timeUntilResetMs: 600_000,
    windows: [
      {
        name: 'Gemini Models (Weekly)',
        usagePercent: 82,
        remainingFraction: 0.18,
        resetsAt: '2026-11-22T00:52:58Z',
        timeUntilResetMs: 400_000_000,
        isExhausted: false,
      },
      {
        name: 'Gemini Models (Five Hour)',
        usagePercent: Math.round((1 - gemini5hRemaining) * 100),
        remainingFraction: gemini5hRemaining,
        resetsAt: '2026-11-16T23:07:38Z',
        timeUntilResetMs: 600_000,
        isExhausted: gemini5hRemaining <= 0,
      },
      {
        name: 'Claude and GPT models (Weekly)',
        usagePercent: 29,
        remainingFraction: 0.71,
        resetsAt: '2026-11-22T05:17:27Z',
        timeUntilResetMs: 450_000_000,
        isExhausted: false,
      },
      {
        name: 'Claude and GPT models (Five Hour)',
        usagePercent: 0,
        remainingFraction: 1,
        resetsAt: '2026-11-17T01:51:27Z',
        timeUntilResetMs: 1_000_000,
        isExhausted: false,
      },
      {
        name: 'Gemini 4 Argon (Gemini 4 Argon Weekly Limit)',
        usagePercent: Math.round((1 - argonRemaining) * 100),
        remainingFraction: argonRemaining,
        resetsAt: '2026-11-22T05:16:50Z',
        timeUntilResetMs: 463_708_020,
        isExhausted: argonRemaining <= 0,
      },
    ],
    metadata: {},
    lastUpdatedMs: Date.now(),
    error: null,
  };
}

describe('modelQuota', () => {
  it('matches gemini-4-argon strictly to the Argon bucket and keeps Hydrogen on Gemini Models', () => {
    const status = makeAntigravityStatus(0, 0.73);

    const argon = resolveModelQuotaWindow('antigravity', 'gemini-4-argon-high', status, 'Gemini 4 Argon');
    expect(argon?.name).toBe('Gemini 4 Argon (Gemini 4 Argon Weekly Limit)');
    expect(isWindowExhausted(argon)).toBe(true);

    const hydrogen = resolveModelQuotaWindow('agy', 'gemini-4-hydrogen', status, 'Gemini 4 Hydrogen');
    expect(hydrogen?.name).toBe('Gemini Models (Weekly)');
    expect(isWindowExhausted(hydrogen)).toBe(false);

    const claude = resolveModelQuotaWindow('antigravity', 'claude-opus-4-6-high', status, 'Claude Opus 4.6');
    expect(claude?.name).toBe('Claude and GPT models (Weekly)');
    expect(isWindowExhausted(claude)).toBe(false);
  });

  it('picks the most constrained matching pool window and marks low vs exhausted', () => {
    const lowArgon = makeAntigravityStatus(0.05, 0.8);
    const win = resolveModelQuotaWindow('antigravity', 'gemini-4-argon', lowArgon);
    expect(isWindowExhausted(win)).toBe(false);
    expect(isWindowLow(win)).toBe(true);

    const brokenPool = makeAntigravityStatus(0.5, 0);
    const hydro = resolveModelQuotaWindow('antigravity', 'gemini-4-hydrogen', brokenPool);
    expect(hydro?.name).toBe('Gemini Models (Five Hour)');
    expect(isWindowExhausted(hydro)).toBe(true);
  });

  it('collects exhausted model windows across available providers', () => {
    const exhausted = collectExhaustedModelWindows({
      antigravity: makeAntigravityStatus(0, 0.73),
    });
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.providerId).toBe('antigravity');
    expect(exhausted[0]?.window.name).toContain('Gemini 4 Argon');
  });
});
