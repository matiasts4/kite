import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextTab } from './ContextTab';
import { formatTokenCount, parseContextMonitorEnvelope } from '../../../lib/contextMonitor';

const online = parseContextMonitorEnvelope({
  ok: true,
  engine_version: '0.1.0',
  active_session_id: 's1',
  lifetime: {
    requests: 12,
    raw_tokens: 50000,
    compressed_tokens: 10000,
    tokens_saved: 40000,
    savings_percent: 80.0,
    cache_hits: 5,
    cache_hit_rate: 41.67,
    estimated_usd_saved: 0.12,
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
  },
  agents: [{ agent: 'Orion', requests: 3, tokens_saved: 8500, savings_percent: 85.0, cache_hits: 1 }],
  models: [{ model: 'gemini-2.5-pro', requests: 12, tokens_saved: 40000, savings_usd: 0.12, savings_percent: 80.0 }],
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
  recent_sparkline: [500, 1200, 3000],
  avg_overhead_ms: 2.5,
  ccr_entries: 4,
  shared_entries: 1,
  read_records: 8,
  quota_preservation: {
    saved_tokens_30d: 40000,
    pro_equivalent_pct: 0.8,
    tier_5x_pct: 0.16,
    tier_20x_pct: 0.04,
  },
});

describe('ContextTab', () => {
  it('renders lifetime savings, agent/model breakdowns, and quota preservation', async () => {
    const load = vi.fn().mockResolvedValue(online);
    render(<ContextTab load={load} intervalMs={0} />);

    expect(await screen.findByText(/Ahorro acumulado/i)).toBeInTheDocument();
    expect(screen.getByText(`${formatTokenCount(40000)} tokens`)).toBeInTheDocument();
    expect(screen.getByText('Orion')).toBeInTheDocument();
    expect(screen.getByText('gemini-2.5-pro')).toBeInTheDocument();
    expect(screen.getByText(/Por funcionalidad/i)).toBeInTheDocument();
    expect(screen.getByText(/Lectura · Firmas/i)).toBeInTheDocument();
    expect(screen.getByText(/Auditoría de intercepción/i)).toBeInTheDocument();
    expect(screen.getByText(/↳ cargo test/i)).toBeInTheDocument();
    expect(screen.getByText(/kite-ctx v0.1.0/i)).toBeInTheDocument();
    expect(load).toHaveBeenCalled();
  });

  it('refreshes metrics when Actualizar is clicked and supports reset', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ status: 'offline', message: 'Sin registros.' })
      .mockResolvedValue(online);
    const onReset = vi.fn().mockResolvedValue(true);

    render(<ContextTab load={load} onReset={onReset} intervalMs={0} />);
    expect(await screen.findByText('Sin registros.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText(/Ahorro acumulado/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reiniciar' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
