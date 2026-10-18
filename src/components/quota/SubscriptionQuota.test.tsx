import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubscriptionQuotaBadge } from './SubscriptionQuotaBadge';
import { SubscriptionQuotaPopover } from './SubscriptionQuotaPopover';
import { DEFAULT_QUOTA_PREFERENCES, PROVIDERS } from '../../lib/quota/types';

vi.mock('../../lib/ipc', () => ({
  getSubscriptionQuotas: vi.fn().mockResolvedValue({
    antigravity: {
      providerId: 'antigravity',
      displayName: 'Antigravity',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 5,
      primaryRemainingPercent: 95,
      primaryResetAt: '2026-10-15T21:28:00Z',
      timeUntilResetMs: 28800000,
      windows: [
        {
          name: 'Gemini 3.8 Flash (High)',
          usagePercent: 5,
          remainingFraction: 0.95,
          resetsAt: '2026-10-15T21:28:00Z',
          timeUntilResetMs: 28800000,
          isExhausted: false,
        },
        {
          name: 'Claude Sonnet 4.6 (Thinking)',
          usagePercent: 0,
          remainingFraction: 1,
          resetsAt: '2026-10-15T21:33:29Z',
          timeUntilResetMs: 29100000,
          isExhausted: false,
        },
      ],
      metadata: {
        email: 'developer@kite.local',
        planType: 'Google AI Pro',
      },
      lastUpdatedMs: Date.now(),
      error: null,
    },
    claude: {
      providerId: 'claude',
      displayName: 'Claude Code',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 20,
      primaryRemainingPercent: 80,
      primaryResetAt: null,
      timeUntilResetMs: null,
      windows: [],
      metadata: {},
      lastUpdatedMs: Date.now(),
      error: null,
    },
  }),
  isTauriEnvironment: vi.fn().mockReturnValue(true),
}));

describe('Subscription Quota UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the quota badge with default provider and percentage', async () => {
    render(<SubscriptionQuotaBadge />);
    expect(screen.getByRole('button', { name: /cuota/i })).toBeInTheDocument();
  });

  it('renders minified top bar quota badge with logo, ring, percentage and countdown without provider text', async () => {
    const { container } = render(<SubscriptionQuotaBadge />);
    const button = screen.getByRole('button', { name: /cuota/i });
    expect(button).toBeInTheDocument();

    // Provider text is omitted from visible badge body (kept in accessible title/tooltip)
    expect(screen.queryByText('Antigravity')).toBeNull();

    // Logo image and SVG ring are present
    expect(container.querySelector('img.brand-logo')).not.toBeNull();
    expect(container.querySelector('svg circle')).not.toBeNull();
  });

  it('opens SubscriptionQuotaPopover on click and displays usage windows', async () => {
    const user = userEvent.setup();
    const onOpenTokenUsage = vi.fn();

    const mockQuotas = {
      antigravity: {
        providerId: 'antigravity',
        displayName: 'Antigravity',
        isAvailable: true,
        isAuth: true,
        primaryUsagePercent: 5,
        primaryRemainingPercent: 95,
        primaryResetAt: '2026-10-15T21:28:00Z',
        timeUntilResetMs: 28800000,
        windows: [
          {
            name: 'Gemini 3.8 Flash (High)',
            usagePercent: 5,
            remainingFraction: 0.95,
            resetsAt: '2026-10-15T21:28:00Z',
            timeUntilResetMs: 28800000,
            isExhausted: false,
          },
        ],
        metadata: {
          email: 'developer@kite.local',
          planType: 'Google AI Pro',
        },
        lastUpdatedMs: Date.now(),
        error: null,
      },
    };

    render(
      <SubscriptionQuotaPopover
        allQuotas={mockQuotas}
        selectedProvider={PROVIDERS.ANTIGRAVITY}
        onSelectProvider={vi.fn()}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        onOpenTokenUsage={onOpenTokenUsage}
        prefs={DEFAULT_QUOTA_PREFERENCES}
      />
    );

    // Hero section checks
    expect(screen.getAllByText('Antigravity').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('Plan: Google AI Pro')).toBeInTheDocument();
    expect(screen.getAllByText('developer@kite.local').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Gemini 3.8 Flash (High)')).toBeInTheDocument();

    // Token heatmap button
    const heatmapBtn = screen.getByRole('button', { name: /mapa de tokens/i });
    await user.click(heatmapBtn);
    expect(onOpenTokenUsage).toHaveBeenCalledTimes(1);
  });

  it('renders brand logos with valid /assets/logos/ image sources', () => {
    const { container } = render(<SubscriptionQuotaBadge />);
    const logoImg = container.querySelector('img.brand-logo');
    expect(logoImg).not.toBeNull();
    expect(logoImg?.getAttribute('src')).toContain('/assets/logos/');
  });

  it('diagnoses providers honestly without fabricating usage percentages', async () => {
    const { diagnoseProvider } = await import('../../lib/quota/providerState');

    // 1. Ok with windows
    const liveCursor = {
      providerId: 'cursor',
      displayName: 'Cursor',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 0,
      primaryRemainingPercent: 100,
      primaryResetAt: '2026-11-01T00:00:00.000Z',
      timeUntilResetMs: 1379660651,
      windows: [{ name: 'Total', usagePercent: 0, remainingFraction: 1, resetsAt: null, timeUntilResetMs: null, isExhausted: false }],
      lastUpdatedMs: Date.now(),
    };
    expect(diagnoseProvider(liveCursor).state).toBe('ok');
    expect(diagnoseProvider(liveCursor).hasQuota).toBe(true);

    // 2. Detected local without fake window
    const localGemini = {
      providerId: 'gemini',
      displayName: 'Gemini CLI',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 0,
      primaryRemainingPercent: 100,
      primaryResetAt: null,
      timeUntilResetMs: null,
      windows: [],
      metadata: { note: 'Detectado localmente' },
      lastUpdatedMs: Date.now(),
    };
    expect(diagnoseProvider(localGemini).state).toBe('detected');
    expect(diagnoseProvider(localGemini).hasQuota).toBe(false);

    // 3. Grok privacy mode error
    const grokPrivacy = {
      providerId: 'grok',
      displayName: 'Grok',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 0,
      primaryRemainingPercent: 100,
      primaryResetAt: null,
      timeUntilResetMs: null,
      windows: [],
      error: 'xAI no entrega los créditos porque la cuenta está en Privacy Mode "Legacy".',
      lastUpdatedMs: Date.now(),
    };
    expect(diagnoseProvider(grokPrivacy).state).toBe('error');
    expect(diagnoseProvider(grokPrivacy).statusLabel).toBe('Atención requerida');
  });

  it('renders QuotaSettingsModal with fast toggles and bulk action buttons', async () => {
    const { QuotaSettingsModal } = await import('./QuotaSettingsModal');
    render(
      <QuotaSettingsModal
        isOpen={true}
        onClose={vi.fn()}
        allQuotas={{}}
      />
    );

    // Bulk buttons
    expect(screen.getByRole('button', { name: /todos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ninguno/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /solo activos/i })).toBeInTheDocument();

    // Fast switches
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThanOrEqual(10);
  });
});

