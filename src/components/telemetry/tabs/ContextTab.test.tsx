import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextTab } from './ContextTab';
import { formatTokenCount, parseContextMonitorEnvelope } from '../../../lib/contextMonitor';

const online = parseContextMonitorEnvelope({
  ok: true,
  engine_version: '0.2.0',
  active_session_id: 's1',
  lifetime: {
    requests: 12,
    raw_tokens: 50000,
    compressed_tokens: 10000,
    tokens_saved: 38000,
    savings_percent: 76.0,
    cache_hits: 5,
    cache_hit_rate: 41.67,
    estimated_usd_saved: 0.11,
    gross_tokens_saved: 40000,
    ccr_retrieved_tokens: 2000,
    ccr_retrieve_calls: 3,
  },
  session: {
    requests: 3,
    raw_tokens: 10000,
    compressed_tokens: 1500,
    tokens_saved: 8500,
    savings_percent: 85.0,
    cache_hits: 1,
    cache_hit_rate: 33.33,
    estimated_usd_saved: 0.03,
    gross_tokens_saved: 8500,
    ccr_retrieved_tokens: 0,
    ccr_retrieve_calls: 0,
  },
  agents: [{ agent: 'Orion', requests: 3, tokens_saved: 8500, savings_percent: 85.0, cache_hits: 1 }],
  models: [{ model: 'gemini-2.5-pro', requests: 12, tokens_saved: 38000, savings_usd: 0.11, savings_percent: 76.0 }],
  categories: [{ category: 'read', requests: 6, tokens_saved: 20000, savings_percent: 85.0 }],
  features: [
    {
      feature: 'read:signatures',
      category: 'read',
      requests: 6,
      raw_tokens: 24000,
      compressed_tokens: 4000,
      tokens_saved: 20000,
      savings_percent: 83.3,
      cache_hits: 2,
      avg_overhead_ms: 1.2,
    },
  ],
  discovery: {
    scanned_commands: 20,
    already_optimized: 18,
    missed_commands: 2,
    estimated_missed_tokens: 1800,
    top_candidates: [{ command: 'cargo test', count: 2, estimated_missed_tokens: 1800 }],
  },
  audit: {
    total_files: 5,
    total_tokens: 14200,
    wasted_tokens: 1650,
    duplicate_blocks: 1,
    stale_blocks: 1,
    oversized_files: 0,
    findings: [
      {
        kind: 'stale_tool_rules',
        agent: 'gemini',
        path: 'C:/Users/demo/.gemini/GEMINI.md',
        label: 'Tool Mapping',
        wasted_tokens: 1650,
        fixable: true,
        detail: 'References unregistered ctx_* tools',
      },
    ],
  },
  recent_sparkline: [500, 1200, 3000],
  avg_overhead_ms: 2.5,
  ccr_entries: 4,
  ccr_retrieve_calls: 3,
  ccr_retrieve_tokens: 2000,
  shared_entries: 1,
  read_records: 8,
  kv_sessions: 2,
  kv_prefix_hits: 7,
  tool_cache_entries: 5,
  quota_preservation: {
    saved_tokens_30d: 38000,
    pro_equivalent_pct: 0.76,
    tier_5x_pct: 0.15,
    tier_20x_pct: 0.04,
  },
});

describe('ContextTab', () => {
  it('renders lifetime net/gross savings, engine health grid, Turn-0 audit, and quota preservation', async () => {
    const load = vi.fn().mockResolvedValue(online);
    render(<ContextTab load={load} intervalMs={0} />);

    expect(await screen.findByText(/Ahorro acumulado/i)).toBeInTheDocument();
    expect(screen.getByText('Neto')).toBeInTheDocument();
    expect(screen.getByText(`${formatTokenCount(38000)} tokens`)).toBeInTheDocument();
    expect(
      screen.getByText(`Bruto ${formatTokenCount(40000)} − CCR ${formatTokenCount(2000)}`)
    ).toBeInTheDocument();

    expect(screen.getByText(/Salud del motor/i)).toBeInTheDocument();
    expect(screen.getByText('Caché real')).toBeInTheDocument();
    expect(screen.getByText('KV Prefix Hits')).toBeInTheDocument();
    expect(screen.getByText('CCR FTS5')).toBeInTheDocument();
    expect(screen.getByText('Tool Cache')).toBeInTheDocument();
    expect(screen.getByText('2 sesiones')).toBeInTheDocument();
    expect(screen.getByText('3 consultas')).toBeInTheDocument();

    expect(screen.getByText('Auditoría Turn-0')).toBeInTheDocument();
    expect(screen.getByText('kite ctx audit --fix')).toBeInTheDocument();

    expect(screen.getByText('Orion')).toBeInTheDocument();
    expect(screen.getByText('gemini-2.5-pro')).toBeInTheDocument();
    expect(screen.getByText(/Por funcionalidad/i)).toBeInTheDocument();
    expect(screen.getByText(/Lectura · Firmas/i)).toBeInTheDocument();
    expect(screen.getByText(/Auditoría de intercepción/i)).toBeInTheDocument();
    expect(screen.getByText(/↳ cargo test/i)).toBeInTheDocument();
    expect(screen.getByText(/kite-ctx v0.2.0/i)).toBeInTheDocument();
    expect(load).toHaveBeenCalled();
  });

  it('refreshes metrics with onRefresh when Actualizar is clicked and supports reset', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ status: 'offline', message: 'Sin registros.' })
      .mockResolvedValue(online);
    const onRefresh = vi.fn().mockResolvedValue(online);
    const onReset = vi.fn().mockResolvedValue(true);

    render(<ContextTab load={load} onRefresh={onRefresh} onReset={onReset} intervalMs={0} />);
    expect(await screen.findByText('Sin registros.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText(/Ahorro acumulado/i)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Reiniciar' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
