import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuotasTab } from './QuotasTab';
import { DEFAULT_QUOTA_PREFERENCES, PROVIDERS, QUOTA_SETUP_VERSION } from '../../../lib/quota/types';

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

vi.mock('../../../lib/ipc', () => ({
  listQuotaConnections: vi.fn().mockResolvedValue([]),
  getSubscriptionQuotas: vi.fn().mockResolvedValue({
    antigravity: {
      providerId: 'antigravity',
      displayName: 'Antigravity',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 10,
      primaryRemainingPercent: 90,
      primaryResetAt: '2026-10-25T20:00:00Z',
      timeUntilResetMs: 7200000,
      windows: [
        {
          name: 'Gemini 3.8 Flash',
          usagePercent: 10,
          remainingFraction: 0.9,
          resetsAt: '2026-10-25T20:00:00Z',
          timeUntilResetMs: 7200000,
          isExhausted: false,
        },
      ],
      metadata: { email: 'developer@kite.local', planType: 'Pro' },
      lastUpdatedMs: Date.now(),
      error: null,
    },
    claude: {
      providerId: 'claude',
      displayName: 'Claude Code',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 25,
      primaryRemainingPercent: 75,
      primaryResetAt: null,
      timeUntilResetMs: null,
      windows: [],
      metadata: {},
      lastUpdatedMs: Date.now(),
      error: null,
    },
  }),
  listSavedAccounts: vi.fn().mockResolvedValue([]),
  listDetectedCliAccounts: vi.fn().mockResolvedValue([
    {
      provider: 'antigravity',
      displayName: 'Antigravity',
      authState: 'authenticated',
      email: 'developer@kite.local',
      planName: 'Google Cloud AI / Gemini',
      details: 'Sesión OAuth detectada en ~/.gemini/oauth_creds.json',
    },
  ]),
  saveCurrentAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  switchAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  deleteAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  getProviderCredentials: vi.fn().mockResolvedValue({
    success: true,
    credentials: [],
  }),
  saveProviderCredential: vi.fn().mockResolvedValue({ success: true, preview: '••••1234' }),
  deleteProviderCredential: vi.fn().mockResolvedValue({ success: true }),
  saveOpenCodeApiKey: vi.fn().mockResolvedValue(true),
  clearOpenCodeApiKey: vi.fn().mockResolvedValue(true),
  isTauriEnvironment: vi.fn().mockReturnValue(true),
}));

describe('QuotasTab Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    seedQuotaPreferences([PROVIDERS.ANTIGRAVITY, PROVIDERS.CLAUDE]);
  });

  it('renders the Providers section at the top, followed by Usage Providers', () => {
    render(<QuotasTab />);

    // Section 1: Providers is at the top
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings[0]).toHaveTextContent('Proveedores');

    // Section 2: Usage Providers is below
    expect(headings[1]).toHaveTextContent('Límites y consumo de proveedores');

    // Section 3 & 4
    expect(headings[2]).toHaveTextContent('Medidor de la barra superior');
    expect(headings[3]).toHaveTextContent('Bóveda de cuentas conectadas');
  });

  it('displays the connected providers list with "+ Agregar proveedor" row at the bottom', () => {
    render(<QuotasTab />);

    // The add provider button row inside the sidebar
    const addTriggers = screen.getAllByRole('button', { name: /agregar proveedor/i });
    expect(addTriggers.length).toBeGreaterThanOrEqual(1);

    // Connected providers are shown
    expect(screen.getAllByText('Antigravity').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
  });

  it('inspects the selected provider details on the right pane', async () => {
    const user = userEvent.setup();
    render(<QuotasTab />);

    // Click on Claude Code to inspect it
    const claudeButtons = screen.getAllByRole('button', { name: /claude code/i });
    await user.click(claudeButtons[0]);

    // Right pane shows actions and details for Claude Code
    expect(screen.getAllByText(/Anthropic/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /fijar en barra/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /quitar/i })).toBeInTheDocument();
  });

  it('opens AddProviderModal when clicking the add provider button', async () => {
    const user = userEvent.setup();
    render(<QuotasTab />);

    const addBtn = screen.getByRole('button', { name: /\+ agregar proveedor/i });
    await user.click(addBtn);

    // AddProviderModal is rendered
    expect(screen.getByText('Agregar proveedores de IA')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/buscar por nombre, proveedor o modelo/i)
    ).toBeInTheDocument();
  });

  it('displays detected session status and plan details for active CLI providers', async () => {
    render(<QuotasTab />);

    // Antigravity is selected by default; verify detected CLI status
    expect(await screen.findByText('● Sesión CLI detectada')).toBeInTheDocument();
    expect(screen.getByText('Google Cloud AI / Gemini')).toBeInTheDocument();
    expect(screen.getAllByText('developer@kite.local').length).toBeGreaterThanOrEqual(1);
  });

  it('renders collapsible model sub-windows in usage cards without vertical explosion', async () => {
    const user = userEvent.setup();
    render(<QuotasTab />);

    // Model window toggle is present for Antigravity (which has 1 window in mock)
    const toggleBtn = await screen.findByRole('button', { name: /ver desglose por modelo \(1\)/i });
    expect(toggleBtn).toBeInTheDocument();

    // Model window is collapsed initially
    expect(screen.queryByText('Gemini 3.8 Flash')).not.toBeInTheDocument();

    // Click to expand
    await user.click(toggleBtn);

    // Model window is now visible inside scroll container
    expect(screen.getByText('Gemini 3.8 Flash')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ocultar desglose de modelos/i })).toBeInTheDocument();

    // Click to collapse again
    await user.click(screen.getByRole('button', { name: /ocultar desglose de modelos/i }));
    expect(screen.queryByText('Gemini 3.8 Flash')).not.toBeInTheDocument();
  });
});
