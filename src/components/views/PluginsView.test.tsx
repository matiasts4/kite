import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PluginsView, sortPlugins, filterPlugins } from './PluginsView';
import { OFFICIAL_PLUGINS } from './plugins/catalog';
import { invoke } from '@tauri-apps/api/core';
import type { PluginConnection } from './plugins/types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('PluginsView Component', () => {
  const mockInvoke = vi.mocked(invoke);

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue([]);
  });

  it('renders all 29 canonical plugins from catalog', async () => {
    render(<PluginsView />);

    expect(screen.getByText('29 authentic integrations')).toBeInTheDocument();
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(29);
  });

  it('displays canonical footnote at the bottom', () => {
    render(<PluginsView />);

    const footnote = screen.getByText(
      'Connect once to Kite. Choose each agent’s plugins in Agent Settings. Its access mode controls approvals; Read only keeps plugins read-only.'
    );
    expect(footnote).toBeInTheDocument();
    expect(footnote).toHaveClass('plugin-pane__footnote');
  });

  it('filters live search across name, vendor, summary, and clears on Escape', async () => {
    const user = userEvent.setup();
    render(<PluginsView />);

    const searchInput = screen.getByPlaceholderText(/Search plugins by name, vendor, capabilities/i);

    // Search by name
    await user.type(searchInput, 'Stripe');
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(1);
    expect(screen.getByText('Stripe')).toBeInTheDocument();

    // Escape clears search
    await user.keyboard('{Escape}');
    expect(searchInput).toHaveValue('');
    expect(screen.getAllByRole('article')).toHaveLength(29);
  });

  it('displays empty state when search has 0 matches', async () => {
    const user = userEvent.setup();
    render(<PluginsView />);

    const searchInput = screen.getByPlaceholderText(/Search plugins by name, vendor, capabilities/i);
    await user.type(searchInput, 'nonexistentxyz123');

    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText('No plugins match “nonexistentxyz123”.')).toBeInTheDocument();
  });

  it('opens details drawer when a plugin card is clicked', async () => {
    const user = userEvent.setup();
    render(<PluginsView />);

    // Click on Stripe card
    const stripeCard = screen.getByRole('article', { name: /Stripe/i });
    await user.click(stripeCard);

    // Dialog should be visible
    expect(screen.getByRole('heading', { level: 2, name: 'Stripe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Configuración y Credenciales/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Proveedores/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Agentes/i })).toBeInTheDocument();
    expect(screen.getByText('Capacidades Otorgadas')).toBeInTheDocument();

    // Close button dismisses dialog
    const closeBtn = screen.getByRole('button', { name: /Cerrar/i });
    await user.click(closeBtn);

    expect(screen.queryByRole('heading', { level: 2, name: 'Stripe' })).not.toBeInTheDocument();
  });
});

describe('PluginsView - Sorting & Filtering Logic', () => {
  it('sorts active/pending connections first, then alphabetically by name', () => {
    const map = new Map<string, PluginConnection>([
      ['stripe', { id: 'stripe', state: 'connected', account: 'acct_1', message: null }],
      ['github', { id: 'github', state: 'needsReauth', account: 'octocat', message: null }],
      ['slack', { id: 'slack', state: 'disconnectPending', account: null, message: null }],
      ['apollo', { id: 'apollo', state: 'disconnected', account: null, message: null }],
      ['fal', { id: 'fal', state: 'disconnected', account: null, message: null }],
    ]);

    const sorted = sortPlugins(OFFICIAL_PLUGINS, map);

    // The first 3 should be github, slack, stripe (alphabetically among active/pending)
    const top3Ids = sorted.slice(0, 3).map((p) => p.id);
    expect(top3Ids).toContain('stripe');
    expect(top3Ids).toContain('github');
    expect(top3Ids).toContain('slack');

    // GitHub should be before Slack, Slack before Stripe
    expect(top3Ids).toEqual(['github', 'slack', 'stripe']);

    // The rest should be sorted alphabetically
    const rest = sorted.slice(3);
    for (let i = 0; i < rest.length - 1; i++) {
      expect(rest[i].name.localeCompare(rest[i + 1].name)).toBeLessThanOrEqual(0);
    }
  });

  it('filters by name, vendor, and summary', () => {
    const results = filterPlugins(OFFICIAL_PLUGINS, 'invoices');
    expect(results.length).toBeGreaterThan(0);
    // Stripe has invoices in summary
    expect(results.some((p) => p.id === 'stripe')).toBe(true);
  });
});
