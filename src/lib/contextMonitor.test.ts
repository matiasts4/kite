import { describe, expect, it, vi } from 'vitest';
import {
  formatContextFeatureLabel,
  parseContextMonitorEnvelope,
  refreshContextMonitor,
} from './contextMonitor';
import * as ipc from './ipc';

const fixture = {
  ok: true,
  engine_version: '0.2.0',
  active_session_id: 'sess-99',
  lifetime: {
    requests: 25,
    raw_tokens: 100000,
    compressed_tokens: 18000,
    tokens_saved: 79000,
    savings_percent: 79.0,
    cache_hits: 9,
    cache_hit_rate: 36.0,
    estimated_usd_saved: 0.24,
    gross_tokens_saved: 82000,
    ccr_retrieved_tokens: 3000,
    ccr_retrieve_calls: 2,
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
    gross_tokens_saved: 17500,
    ccr_retrieved_tokens: 0,
    ccr_retrieve_calls: 0,
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
  audit: {
    total_files: 6,
    total_tokens: 18400,
    wasted_tokens: 2200,
    duplicate_blocks: 1,
    stale_blocks: 1,
    oversized_files: 1,
    findings: [
      {
        kind: 'stale_tool_rules',
        agent: 'gemini',
        path: 'C:/Users/demo/.gemini/GEMINI.md',
        label: 'Tool Mapping',
        wasted_tokens: 1400,
        fixable: true,
        detail: 'References unregistered ctx_* MCP tools',
      },
    ],
  },
  recent_sparkline: [400, 1200, 3500],
  avg_overhead_ms: 3.2,
  ccr_entries: 6,
  ccr_retrieve_calls: 2,
  ccr_retrieve_tokens: 3000,
  shared_entries: 2,
  read_records: 14,
  kv_sessions: 3,
  kv_prefix_hits: 11,
  tool_cache_entries: 5,
  quota_preservation: {
    saved_tokens_30d: 79000,
    pro_equivalent_pct: 1.58,
    tier_5x_pct: 0.32,
    tier_20x_pct: 0.08,
  },
};

describe('parseContextMonitorEnvelope', () => {
  it('parses lifetime net/gross savings, engine health, audit, and quota preservation', () => {
    const state = parseContextMonitorEnvelope(fixture);
    expect(state.status).toBe('online');
    if (state.status !== 'online') return;

    expect(state.view.engineVersion).toBe('0.2.0');
    expect(state.view.lifetime.tokensSaved).toBe(79000);
    expect(state.view.lifetime.grossTokensSaved).toBe(82000);
    expect(state.view.lifetime.ccrRetrievedTokens).toBe(3000);
    expect(state.view.lifetime.ccrRetrieveCalls).toBe(2);
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
    expect(state.view.ccrRetrieveCalls).toBe(2);
    expect(state.view.ccrRetrieveTokens).toBe(3000);
    expect(state.view.kvSessions).toBe(3);
    expect(state.view.kvPrefixHits).toBe(11);
    expect(state.view.toolCacheEntries).toBe(5);
    expect(state.view.audit).toMatchObject({
      totalFiles: 6,
      totalTokens: 18400,
      wastedTokens: 2200,
      duplicateBlocks: 1,
      staleBlocks: 1,
      oversizedFiles: 1,
    });
    expect(state.view.audit.findings[0]).toMatchObject({
      kind: 'stale_tool_rules',
      agent: 'gemini',
      wastedTokens: 1400,
      fixable: true,
    });
    expect(state.view.quotaPreservation.proEquivalentPct).toBeCloseTo(1.58);
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
    expect(formatContextFeatureLabel('exec:json_crusher')).toBe('Compresor JSON · CLI');
    expect(formatContextFeatureLabel('cache:git log')).toBe('Caché de comandos · git log');
  });

  it('defaults v0.2 fields safely when older envelopes omit them', () => {
    const legacy = {
      ok: true,
      engine_version: '0.1.0',
      lifetime: {
        requests: 5,
        raw_tokens: 10000,
        compressed_tokens: 2000,
        tokens_saved: 8000,
        savings_percent: 80,
        cache_hits: 1,
        cache_hit_rate: 20,
        estimated_usd_saved: 0.02,
      },
      session: {},
    };
    const state = parseContextMonitorEnvelope(legacy);
    expect(state.status).toBe('online');
    if (state.status !== 'online') return;

    expect(state.view.lifetime.grossTokensSaved).toBe(8000);
    expect(state.view.lifetime.ccrRetrievedTokens).toBe(0);
    expect(state.view.kvSessions).toBe(0);
    expect(state.view.kvPrefixHits).toBe(0);
    expect(state.view.toolCacheEntries).toBe(0);
    expect(state.view.audit.totalFiles).toBe(0);
    expect(state.view.audit.findings).toEqual([]);
  });

  it('invokes refresh_context_monitor when refreshContextMonitor runs in Tauri', async () => {
    const isTauriSpy = vi.spyOn(ipc, 'isTauriEnvironment').mockReturnValue(true);
    const invokeSpy = vi.spyOn(ipc, 'invokeCommand').mockResolvedValue(fixture);

    try {
      const state = await refreshContextMonitor();
      expect(invokeSpy).toHaveBeenCalledWith('refresh_context_monitor');
      expect(state.status).toBe('online');
    } finally {
      isTauriSpy.mockRestore();
      invokeSpy.mockRestore();
    }
  });

  it('returns offline state when payload is missing or unsuccessful', () => {
    expect(parseContextMonitorEnvelope(null).status).toBe('offline');
    expect(parseContextMonitorEnvelope({ ok: false, error: 'db' }).status).toBe('offline');
  });
});
