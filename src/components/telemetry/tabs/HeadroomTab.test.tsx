import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeadroomTab } from './HeadroomTab';
import { formatTokenCount, parseHeadroomEnvelope } from '../../../lib/headroomMonitor';

const online = parseHeadroomEnvelope({
  ok: true,
  health: { version: '0.43.1', uptime_seconds: 120 },
  stats: {
    summary: { mode: 'cache' },
    requests: { failed: 1, cached: 4 },
    overhead: { average_ms: 40 },
    persistent_savings: {
      lifetime: {
        requests: 10,
        tokens_saved: 2500,
        compression_savings_usd: 1.5,
        savings_basis: 'unpriced',
        cache_read_tokens: 8000,
      },
      display_session: {
        requests: 2,
        tokens_saved: 400,
        compression_savings_usd: 0.2,
        savings_percent: 12.5,
      },
      by_model: {
        'grok-4.7': { tokens_saved: 2500, compression_savings_usd: 1.5, savings_percent: 12.5 },
      },
      recent_history: [{ total_tokens_saved: 100 }, { total_tokens_saved: 250 }, { total_tokens_saved: 400 }],
    },
    agent_usage: {
      agents: [{ label: 'Grok Build', requests: 2, tokens_saved: 400, savings_percent: 12.5 }],
    },
  },
});

describe('HeadroomTab', () => {
  it('shows lifetime savings and the session agent', async () => {
    const load = vi.fn().mockResolvedValue(online);
    render(<HeadroomTab load={load} intervalMs={0} />);

    expect(await screen.findByText(/Ahorro acumulado/i)).toBeInTheDocument();
    expect(screen.getByText(`${formatTokenCount(2500)} tokens`)).toBeInTheDocument();
    expect(screen.getAllByText(/1,50/).length).toBeGreaterThan(0);
    expect(screen.getByText('Grok Build')).toBeInTheDocument();
    expect(screen.getByText('grok-4.7')).toBeInTheDocument();
    expect(screen.getByText(/Estimado/i)).toBeInTheDocument();
    expect(load).toHaveBeenCalled();
  });

  it('shows the offline state when the proxy does not answer', async () => {
    render(
      <HeadroomTab
        intervalMs={0}
        load={vi.fn().mockResolvedValue({ status: 'offline', message: 'Headroom no responde.' })}
      />
    );

    expect(await screen.findByText('Headroom no responde.')).toBeInTheDocument();
  });

  it('reloads savings when Actualizar is pressed', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ status: 'offline', message: 'Headroom no responde.' })
      .mockResolvedValue(online);
    render(<HeadroomTab load={load} intervalMs={0} />);

    expect(await screen.findByText('Headroom no responde.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(await screen.findByText(/Ahorro acumulado/i)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
