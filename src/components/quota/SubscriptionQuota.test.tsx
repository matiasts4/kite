import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubscriptionQuotaBadge } from './SubscriptionQuotaBadge';
import { SubscriptionQuotaPopover } from './SubscriptionQuotaPopover';
import { resetAccountVaultStoreForTest } from '../../lib/accounts/accountVaultStore';
import { DEFAULT_QUOTA_PREFERENCES, PROVIDERS, QUOTA_SETUP_VERSION } from '../../lib/quota/types';

const PREFS_STORAGE_KEY = 'kite_quota_preferences';

function seedQuotaPreferences(enabledProviders: string[]) {
  localStorage.setItem(
    PREFS_STORAGE_KEY,
    JSON.stringify({
      ...DEFAULT_QUOTA_PREFERENCES,
      setupVersion: QUOTA_SETUP_VERSION,
      enabledProviders,
    })
  );
}

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
  listSavedAccountsFull: vi.fn().mockResolvedValue({
    profiles: [],
    unregisteredLiveSession: null,
    authTelemetry: null,
  }),
  saveCurrentAccountProfile: vi.fn().mockResolvedValue({
    success: true,
    profile: {
      id: 'saved-live',
      provider: 'antigravity',
      label: 'personal@kite.local',
      email: 'personal@kite.local',
      isActive: true,
      credentialStatus: 'valid',
      hasRefreshToken: true,
    },
  }),
  switchAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  renameAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  deleteAccountProfile: vi.fn().mockResolvedValue({ success: true }),
}));

describe('Subscription Quota UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAccountVaultStoreForTest();
    localStorage.clear();
    seedQuotaPreferences([PROVIDERS.ANTIGRAVITY]);
  });

  it('renders the quota badge with default provider and percentage', async () => {
    render(<SubscriptionQuotaBadge />);
    expect(screen.getByRole('button', { name: /cuota/i })).toBeInTheDocument();
  });

  it('renders minified top bar quota badge with logo, ring and percentage but no reset clock', async () => {
    const { container } = render(<SubscriptionQuotaBadge />);
    const button = screen.getByRole('button', { name: /cuota/i });
    expect(button).toBeInTheDocument();

    // Provider text is omitted from visible badge body (kept in accessible title/tooltip)
    expect(screen.queryByText('Antigravity')).toBeNull();

    // Logo image and SVG ring are present
    expect(container.querySelector('img.brand-logo')).not.toBeNull();
    expect(container.querySelector('svg circle')).not.toBeNull();

    // Only icon + ring + percentage remain: the reset clock is gone from the pill
    expect(container.querySelector('svg polyline')).toBeNull();
    expect(button.textContent).not.toMatch(/\d+\s*[hm]\b/i);
    expect(button.textContent).toMatch(/%|--/);
  });

  it('keeps the quota pill visible and offers the add-provider state when none are enabled', async () => {
    seedQuotaPreferences([]);
    const user = userEvent.setup();
    render(<SubscriptionQuotaBadge />);

    const button = screen.getByRole('button', { name: /cuotas/i });
    expect(button).toBeInTheDocument();
    expect(button.textContent).toContain('Cuotas');

    await user.click(button);
    expect(screen.getByText('No agregaste ningún proveedor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /agregar proveedor/i })).toBeInTheDocument();
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
        prefs={{
          ...DEFAULT_QUOTA_PREFERENCES,
          setupVersion: QUOTA_SETUP_VERSION,
          enabledProviders: [PROVIDERS.ANTIGRAVITY],
        }}
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

  it('only lists providers the user added and shows an empty state when none are enabled', () => {
    const { rerender } = render(
      <SubscriptionQuotaPopover
        allQuotas={{}}
        selectedProvider={PROVIDERS.ANTIGRAVITY}
        onSelectProvider={vi.fn()}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        prefs={{
          ...DEFAULT_QUOTA_PREFERENCES,
          setupVersion: QUOTA_SETUP_VERSION,
          enabledProviders: [PROVIDERS.ANTIGRAVITY],
        }}
      />
    );

    expect(screen.queryByText('Grok')).toBeNull();
    expect(screen.queryByText('Qoder')).toBeNull();

    rerender(
      <SubscriptionQuotaPopover
        allQuotas={{}}
        selectedProvider={PROVIDERS.ANTIGRAVITY}
        onSelectProvider={vi.fn()}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        prefs={{
          ...DEFAULT_QUOTA_PREFERENCES,
          setupVersion: QUOTA_SETUP_VERSION,
          enabledProviders: [],
        }}
      />
    );

    expect(screen.getByText('No agregaste ningún proveedor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /agregar proveedor/i })).toBeInTheDocument();
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

  it('proactively loads saved accounts, syncs active email identity, and supports 1-click save in popover', async () => {
    const user = userEvent.setup();
    const ipc = await import('../../lib/ipc');
    vi.mocked(ipc.listSavedAccountsFull).mockResolvedValueOnce({
      profiles: [],
      unregisteredLiveSession: {
        provider: 'antigravity',
        email: 'personal@kite.local',
        planName: 'Google AI Pro',
      },
      authTelemetry: {
        authMode: 'oauth',
        cliEmail: 'personal@kite.local',
      },
    });

    render(
      <SubscriptionQuotaPopover
        allQuotas={{
          antigravity: {
            providerId: 'antigravity',
            displayName: 'Antigravity',
            isAvailable: true,
            isAuth: true,
            primaryUsagePercent: 15,
            primaryRemainingPercent: 85,
            primaryResetAt: null,
            timeUntilResetMs: null,
            windows: [
              {
                name: 'Gemini Pro',
                usagePercent: 15,
                remainingFraction: 0.85,
                resetsAt: null,
                timeUntilResetMs: null,
                isExhausted: false,
              },
            ],
            metadata: {
              email: 'stale@kite.local',
            },
            lastUpdatedMs: Date.now(),
            error: null,
          },
        }}
        selectedProvider={PROVIDERS.ANTIGRAVITY}
        onSelectProvider={vi.fn()}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        prefs={{
          ...DEFAULT_QUOTA_PREFERENCES,
          setupVersion: QUOTA_SETUP_VERSION,
          enabledProviders: [PROVIDERS.ANTIGRAVITY],
        }}
      />
    );

    // Proactively loaded without needing to click "Cambiar cuenta"
    expect(ipc.listSavedAccountsFull).toHaveBeenCalledWith('antigravity');
    expect((await screen.findAllByText('personal@kite.local')).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('stale@kite.local')).toBeNull();

    // Expanding switcher lets the user save directly in 1 click instead of navigating to Settings
    await user.click(screen.getByRole('button', { name: /^cambiar cuenta$/i }));
    const saveBtn = await screen.findByRole('button', { name: /^Guardar$/i });
    await user.click(saveBtn);
    expect(ipc.saveCurrentAccountProfile).toHaveBeenCalledWith(
      'antigravity',
      'personal@kite.local'
    );
  });

  it('shows a partial-exhaustion warning indicator when primary quota > 0% but a model window hit 0%', async () => {
    const { subscriptionQuotaManager } = await import('../../lib/quota/quotaManager');
    render(<SubscriptionQuotaBadge />);

    act(() => {
      subscriptionQuotaManager.applyExternalQuotas({
        antigravity: {
          providerId: 'antigravity',
          displayName: 'Antigravity',
          isAvailable: true,
          isAuth: true,
          primaryUsagePercent: 27,
          primaryRemainingPercent: 73,
          primaryResetAt: '2026-11-16T23:00:00Z',
          timeUntilResetMs: 600_000,
          windows: [
            {
              name: 'Gemini Models (Five Hour)',
              usagePercent: 27,
              remainingFraction: 0.73,
              resetsAt: '2026-11-16T23:00:00Z',
              timeUntilResetMs: 600_000,
              isExhausted: false,
            },
            {
              name: 'Gemini 4 Argon (Gemini 4 Argon Weekly Limit)',
              usagePercent: 100,
              remainingFraction: 0,
              resetsAt: '2026-11-22T05:16:50Z',
              timeUntilResetMs: 463_708_020,
              isExhausted: true,
            },
          ],
          metadata: { primaryWindowLabel: '5h' },
          lastUpdatedMs: Date.now() + 5000,
          error: null,
        },
      });
    });

    const badge = await screen.findByRole('button', { name: /Gemini 4 Argon/i });
    expect(badge).toHaveTextContent('73%');
    expect(screen.getByTestId('quota-partial-exhausted-dot')).toBeInTheDocument();
  });

  it('keeps displaying last stored quota silently on recent refresh failure and shows inline stale notice after 30 minutes', async () => {
    const { subscriptionQuotaManager } = await import('../../lib/quota/quotaManager');
    render(<SubscriptionQuotaBadge />);

    // 1. Recent refresh error (< 30 min since last successful update): keep 82% silently without warning dot
    act(() => {
      subscriptionQuotaManager.applyExternalQuotas({
        antigravity: {
          providerId: 'antigravity',
          displayName: 'Antigravity',
          isAvailable: true,
          isAuth: true,
          primaryUsagePercent: 18,
          primaryRemainingPercent: 82,
          primaryResetAt: '2026-11-17T23:00:00Z',
          timeUntilResetMs: 3_600_000,
          windows: [
            {
              name: 'Gemini Models (Five Hour)',
              usagePercent: 18,
              remainingFraction: 0.82,
              resetsAt: '2026-11-17T23:00:00Z',
              timeUntilResetMs: 3_600_000,
              isExhausted: false,
            },
          ],
          metadata: {
            lastRefreshError: 'CLI no respondió',
            lastRefreshErrorAtMs: Date.now(),
          },
          lastUpdatedMs: Date.now() - 5 * 60 * 1000,
          error: null,
        },
      });
    });

    const recentBadge = await screen.findByRole('button', { name: /82%/i });
    expect(recentBadge).toHaveTextContent('82%');
    expect(screen.queryByTestId('quota-stale-warning-dot')).toBeNull();

    // 2. Prolonged refresh error (>= 30 min): keep 82% visible AND show subtle warning dot + accessible notice
    act(() => {
      subscriptionQuotaManager.applyExternalQuotas({
        antigravity: {
          providerId: 'antigravity',
          displayName: 'Antigravity',
          isAvailable: true,
          isAuth: true,
          primaryUsagePercent: 18,
          primaryRemainingPercent: 82,
          primaryResetAt: '2026-11-17T23:00:00Z',
          timeUntilResetMs: 3_600_000,
          windows: [
            {
              name: 'Gemini Models (Five Hour)',
              usagePercent: 18,
              remainingFraction: 0.82,
              resetsAt: '2026-11-17T23:00:00Z',
              timeUntilResetMs: 3_600_000,
              isExhausted: false,
            },
          ],
          metadata: {
            lastRefreshError: 'CLI no respondió',
            lastRefreshErrorAtMs: Date.now(),
          },
          lastUpdatedMs: Date.now() - 35 * 60 * 1000,
          error: null,
        },
      });
    });

    const staleBadge = await screen.findByRole('button', { name: /82%.*no se pudo actualizar/i });
    expect(staleBadge).toHaveTextContent('82%');
    expect(screen.getByTestId('quota-stale-warning-dot')).toBeInTheDocument();

    // 3. Subsequent raw failure update must preserve 82% and warning dot rather than showing "--"
    act(() => {
      subscriptionQuotaManager.applyExternalQuotas({
        antigravity: {
          providerId: 'antigravity',
          displayName: 'Antigravity',
          isAvailable: false,
          isAuth: false,
          primaryUsagePercent: 0,
          primaryRemainingPercent: 100,
          primaryResetAt: null,
          timeUntilResetMs: null,
          windows: [],
          metadata: {},
          lastUpdatedMs: Date.now(),
          error: 'CLI no respondió',
        },
      });
    });

    expect(await screen.findByRole('button', { name: /82%/i })).toHaveTextContent('82%');
    expect(screen.getByTestId('quota-stale-warning-dot')).toBeInTheDocument();
  });

  it('shows inline stale-refresh notice inside SubscriptionQuotaPopover after 30 minutes while keeping windows visible', () => {
    const staleQuota = {
      antigravity: {
        providerId: 'antigravity',
        displayName: 'Antigravity',
        isAvailable: true,
        isAuth: true,
        primaryUsagePercent: 18,
        primaryRemainingPercent: 82,
        primaryResetAt: '2026-11-17T23:00:00Z',
        timeUntilResetMs: 3_600_000,
        windows: [
          {
            name: 'Gemini Models (Five Hour)',
            usagePercent: 18,
            remainingFraction: 0.82,
            resetsAt: '2026-11-17T23:00:00Z',
            timeUntilResetMs: 3_600_000,
            isExhausted: false,
          },
        ],
        metadata: {
          email: 'developer@kite.local',
          lastRefreshError: 'CLI de Antigravity (agy) no respondió',
          lastRefreshErrorAtMs: Date.now(),
        },
        lastUpdatedMs: Date.now() - 40 * 60 * 1000,
        error: null,
      },
    };

    render(
      <SubscriptionQuotaPopover
        allQuotas={staleQuota}
        selectedProvider={PROVIDERS.ANTIGRAVITY}
        onSelectProvider={vi.fn()}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        prefs={{
          ...DEFAULT_QUOTA_PREFERENCES,
          setupVersion: QUOTA_SETUP_VERSION,
          enabledProviders: [PROVIDERS.ANTIGRAVITY],
        }}
      />
    );

    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('Gemini Models (Five Hour)')).toBeInTheDocument();
    const notice = screen.getByTestId('quota-stale-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/40 min/i);
  });
});

