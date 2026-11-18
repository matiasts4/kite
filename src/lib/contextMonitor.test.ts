import { describe, expect, it } from 'vitest';
import {
  formatContextFeatureLabel,
  parseContextMonitorEnvelope,
} from './contextMonitor';

const fixture = {
  ok: true,
  engine_version: '0.1.0',
  active_session_id: 'sess-99',
  lifetime: {
    requests: 25,
    raw_tokens: 100000,
    compressed_tokens: 18000,
    tokens_saved: 82000,
    savings_percent: 82.0,
    cache_hits: 9,
    cache_hit_rate: 36.0,
    estimated_usd_saved: 0.25,
  },
  session: {
    requests: 4,
    raw_tokens: 20000,
    compressed_tokens: 2500,
    tokens_saved: 17500,
    savings_percent: 87.5,
    cache_hits: 2,
    cache_hit_rate: 50.0,
    estimated_usd_saved: 0.05,
  },
  agents: [
    { agent: 'Orion', requests: 4, tokens_saved: 17500, savings_percent: 87.5, cache_hits: 2 },
  ],
  models: [
    { model: 'gemini-2.5-pro', requests: 15, tokens_saved: 60000, savings_usd: 0.18, savings_percent: 80.0 },
  ],
  categories: [
    { category: 'exec', requests: 10, tokens_saved: 50000, savings_percent: 88.0 },
  ],
  features: [
    {
      feature: 'read:signatures',
      category: 'read',
      requests: 8,
      raw_tokens: 18000,
      compressed_tokens: 2200,
      tokens_saved: 15800,
      savings_percent: 87.8,
      cache_hits: 3,
      avg_overhead_ms: 1.5,
    },
  ],
  discovery: {
    scanned_commands: 42,
    already_optimized: 38,
    missed_commands: 4,
    estimated_missed_tokens: 3400,
    top_candidates: [
      { command: 'cargo test', count: 3, estimated_missed_tokens: 2800 },
    ],
  },
  recent_sparkline: [400, 1200, 3500],
  avg_overhead_ms: 3.2,
  ccr_entries: 6,
  shared_entries: 2,
  read_records: 14,
  quota_preservation: {
    saved_tokens_30d: 82000,
    pro_equivalent_pct: 1.64,
    tier_5x_pct: 0.33,
    tier_20x_pct: 0.08,
  },
};

describe('parseContextMonitorEnvelope', () => {
  it('parses lifetime, session, agent/model breakdowns, and quota preservation', () => {
    const state = parseContextMonitorEnvelope(fixture);
    expect(state.status).toBe('online');
    if (state.status !== 'online') return;

    expect(state.view.engineVersion).toBe('0.1.0');
    expect(state.view.lifetime.tokensSaved).toBe(82000);
    expect(state.view.lifetime.cacheHitRate).toBe(36.0);
    expect(state.view.session.savingsPercent).toBe(87.5);
    expect(state.view.agents[0]).toMatchObject({ agent: 'Orion', cacheHits: 2 });
    expect(state.view.models[0]).toMatchObject({ model: 'gemini-2.5-pro', tokensSaved: 60000 });
    expect(state.view.categories[0]).toMatchObject({ category: 'exec', tokensSaved: 50000 });
    expect(state.view.features[0]).toMatchObject({
      feature: 'read:signatures',
      tokensSaved: 15800,
      cacheHits: 3,
    });
    expect(state.view.sparkline).toEqual([400, 1200, 3500]);
    expect(state.view.ccrEntries).toBe(6);
    expect(state.view.quotaPreservation.proEquivalentPct).toBeCloseTo(1.64);
    expect(state.view.discovery).toMatchObject({
      scannedCommands: 42,
      alreadyOptimized: 38,
      missedCommands: 4,
      estimatedMissedTokens: 3400,
    });
    expect(state.view.discovery.topCandidates[0]).toMatchObject({
      command: 'cargo test',
      count: 3,
      estimatedMissedTokens: 2800,
    });
    expect(formatContextFeatureLabel('mcp:context7')).toBe('Proxy MCP · context7');
    expect(formatContextFeatureLabel('runtime:thread_history')).toBe('Runtime · Historial de hilo');
  });

  it('returns offline state when payload is missing or unsuccessful', () => {
    expect(parseContextMonitorEnvelope(null).status).toBe('offline');
    expect(parseContextMonitorEnvelope({ ok: false, error: 'db' }).status).toBe('offline');
  });
});
