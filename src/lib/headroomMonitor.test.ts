import { describe, expect, it } from 'vitest';
import { parseHeadroomEnvelope } from './headroomMonitor';

const fixture = {
  ok: true,
  health: { status: 'healthy', version: '0.43.1', uptime_seconds: 3600 },
  stats: {
    summary: { mode: 'cache' },
    requests: { total: 12, cached: 12, failed: 0 },
    tokens: { saved: 5638, savings_percent: 1.02 },
    overhead: { average_ms: 42.5 },
    latency: { average_ms: 180 },
    agent_usage: {
      agents: [
        {
          agent: 'grok-build',
          label: 'Grok Build',
          requests: 11,
          tokens_saved: 5638,
          savings_percent: 0.99,
        },
      ],
    },
    persistent_savings: {
      lifetime: {
        requests: 1143,
        tokens_saved: 1391469,
        compression_savings_usd: 4.16607,
        savings_basis: 'unpriced',
        cache_read_tokens: 115321216,
        total_input_cost_usd: 374.43,
        total_output_cost_usd: 5.95,
      },
      display_session: {
        requests: 12,
        tokens_saved: 5638,
        compression_savings_usd: 0.016914,
        savings_percent: 1.02,
        total_input_tokens: 544878,
      },
      by_model: {
        'grok-4.7': {
          requests: 670,
          tokens_saved: 791057,
          compression_savings_usd: 2.373171,
          savings_percent: 0.92,
        },
        'grok-4.6': {
          requests: 477,
          tokens_saved: 600412,
          compression_savings_usd: 1.801236,
          savings_percent: 1.5,
        },
      },
      recent_history: [
        { total_tokens_saved: 1000 },
        { total_tokens_saved: 2130 },
        { total_tokens_saved: 2130 },
      ],
    },
  },
};

describe('parseHeadroomEnvelope', () => {
  it('reads lifetime savings, the live session, and recent deltas', () => {
    const state = parseHeadroomEnvelope(fixture);

    expect(state.status).toBe('online');
    if (state.status !== 'online') return;

    expect(state.view.version).toBe('0.43.1');
    expect(state.view.mode).toBe('cache');
    expect(state.view.lifetime.tokensSaved).toBe(1391469);
    expect(state.view.lifetime.savingsUsd).toBeCloseTo(4.16607);
    expect(state.view.lifetime.requests).toBe(1143);
    expect(state.view.lifetime.estimatedUsd).toBe(true);
    expect(state.view.session.tokensSaved).toBe(5638);
    expect(state.view.session.savingsPercent).toBeCloseTo(1.02);
    expect(state.view.agents[0]).toMatchObject({ label: 'Grok Build', tokensSaved: 5638 });
    expect(state.view.models.map((row) => row.model)).toEqual(['grok-4.7', 'grok-4.6']);
    expect(state.view.sparkline).toEqual([1130, 0]);
    expect(state.view.overheadMs).toBeCloseTo(42.5);
    expect(state.view.requestsFailed).toBe(0);
  });

  it('reports the proxy as offline when the snapshot is missing or rejected', () => {
    expect(parseHeadroomEnvelope(null).status).toBe('offline');
    expect(parseHeadroomEnvelope({ ok: false, error: 'connection refused' }).status).toBe('offline');
    expect(parseHeadroomEnvelope({ ok: true, stats: {} }).status).toBe('offline');
  });
});
