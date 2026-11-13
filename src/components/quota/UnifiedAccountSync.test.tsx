import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetAccountVaultStoreForTest } from '../../lib/accounts/accountVaultStore';
import { DEFAULT_QUOTA_PREFERENCES, PROVIDERS, QUOTA_SETUP_VERSION } from '../../lib/quota/types';
import type { SavedAccountProfile } from '../../types';
import { AccountVault } from '../views/settings/AccountVault';
import { AccountTab } from '../views/settings/AccountTab';
import { QuotasTab } from '../views/settings/QuotasTab';
import { AccountSwitcherModal } from './AccountSwitcherModal';
import { SubscriptionQuotaPopover } from './SubscriptionQuotaPopover';
import { CodePaneHeader } from '../code/CodePaneHeader';
import type { PaneOccupantTerminal } from '../code/types';

vi.mock('../../lib/settingsNav', () => ({
  openSettingsTab: vi.fn(),
  SETTINGS_PROVIDER_STORAGE_KEY: 'kite_settings_provider',
}));

vi.mock('../../lib/agentUpdates', () => ({
  useAgentUpdates: () => ({ summary: null }),
}));

let mockProfiles: SavedAccountProfile[] = [];
let mockUnregistered: { provider: string; email: string; planName?: string | null } | null = null;
let mockTelemetry: any = null;
let mockCliEmail = 'personal@kite.local';

vi.mock('../../lib/ipc', () => ({
  isTauriEnvironment: vi.fn().mockReturnValue(false),
  invokeCommand: vi.fn().mockResolvedValue(null),
  listSavedAccountsFull: vi.fn(async () => ({
    profiles: mockProfiles.map((p) => ({ ...p })),
    unregisteredLiveSession: mockUnregistered ? { ...mockUnregistered } : null,
    authTelemetry: mockTelemetry ? { ...mockTelemetry } : null,
  })),
  switchAccountProfile: vi.fn(async (_provider: string, accountId: string) => {
    const target = mockProfiles.find((p) => p.id === accountId);
    if (!target) return { success: false, code: 'INVALID_TARGET_PROFILE', error: 'Sin perfil' };
    mockProfiles = mockProfiles.map((p) => ({ ...p, isActive: p.id === accountId }));
    mockCliEmail = target.email || mockCliEmail;
    mockTelemetry = { ...(mockTelemetry || { authMode: 'oauth' }), cliEmail: mockCliEmail };
    return {
      success: true,
      profile: { ...target, isActive: true },
      authTelemetry: mockTelemetry,
      terminalsRestarted: 1,
    };
  }),
  saveCurrentAccountProfile: vi.fn(async (_provider: string, label: string) => {
    const existing = mockProfiles.find(
      (p) => p.email?.toLowerCase() === mockCliEmail.toLowerCase()
    );
    const updated: SavedAccountProfile = existing
      ? { ...existing, label, isActive: true }
      : {
          id: `acc-${mockProfiles.length + 1}`,
          provider: 'antigravity',
          label,
          email: mockCliEmail,
          planName: null,
          lastUsedUnixMs: Date.now(),
          primaryRemainingPercent: null,
          primaryResetAt: null,
          timeUntilResetMs: null,
          isActive: true,
          credentialStatus: 'valid',
          hasRefreshToken: true,
        };
    mockProfiles = existing
      ? mockProfiles.map((p) => (p.id === existing.id ? updated : { ...p, isActive: false }))
      : [...mockProfiles.map((p) => ({ ...p, isActive: false })), updated];
    mockUnregistered = null;
    return { success: true, profile: updated };
  }),
  renameAccountProfile: vi.fn(async (_provider: string, accountId: string, label: string) => {
    let updated: SavedAccountProfile | undefined;
    mockProfiles = mockProfiles.map((p) => {
      if (p.id === accountId) {
        updated = { ...p, label };
        return updated;
      }
      return p;
    });
    return { success: true, profile: updated };
  }),
  deleteAccountProfile: vi.fn(async (_provider: string, accountId: string) => {
    mockProfiles = mockProfiles.filter((p) => p.id !== accountId);
    return { success: true };
  }),
  listDetectedCliAccounts: vi.fn(async () => [
    {
      provider: 'antigravity',
      displayName: 'Antigravity',
      authState: 'authenticated',
      accountLabel: mockCliEmail,
      email: mockCliEmail,
      planName: 'Google AI Pro',
    },
  ]),
  listQuotaConnections: vi.fn().mockResolvedValue([]),
  getSubscriptionQuotas: vi.fn(async () => ({
    antigravity: {
      providerId: 'antigravity',
      displayName: 'Antigravity',
      isAvailable: true,
      isAuth: true,
      primaryUsagePercent: 10,
      primaryRemainingPercent: 90,
      primaryResetAt: null,
      timeUntilResetMs: null,
      windows: [
        {
          name: 'Gemini Pro',
          usagePercent: 10,
          remainingFraction: 0.9,
          resetsAt: null,
          timeUntilResetMs: null,
          isExhausted: false,
        },
      ],
      metadata: { email: mockCliEmail, planType: 'Google AI Pro' },
      lastUpdatedMs: Date.now(),
      error: null,
    },
  })),
  listConnections: vi.fn().mockResolvedValue([]),
  startAccountLoginFlow: vi.fn().mockResolvedValue({ success: false }),
  probeLiveAccountLoginStatus: vi.fn().mockResolvedValue({ completed: false }),
  cancelAccountLoginFlow: vi.fn().mockResolvedValue({ success: true }),
  clearOpenCodeApiKey: vi.fn().mockResolvedValue(true),
  saveOpenCodeApiKey: vi.fn().mockResolvedValue(true),
}));

function resetScenario() {
  resetAccountVaultStoreForTest();
  localStorage.clear();
  localStorage.setItem(
    'kite_quota_preferences',
    JSON.stringify({
      ...DEFAULT_QUOTA_PREFERENCES,
      setupVersion: QUOTA_SETUP_VERSION,
      enabledProviders: [PROVIDERS.ANTIGRAVITY],
    })
  );
  mockCliEmail = 'personal@kite.local';
  mockUnregistered = null;
  mockTelemetry = {
    authMode: 'oauth',
    authModeLabel: 'OAuth CLI',
    cliEmail: 'personal@kite.local',
    ideEmail: 'personal@kite.local',
    splitBrainWarning: false,
    hasRefreshToken: true,
  };
  mockProfiles = [
    {
      id: 'acc-1',
      provider: 'antigravity',
      label: 'Personal',
      email: 'personal@kite.local',
      planName: 'Google AI Pro',
      lastUsedUnixMs: 1000,
      isActive: true,
      primaryRemainingPercent: 90,
      primaryResetAt: null,
      timeUntilResetMs: null,
      credentialStatus: 'valid',
      hasRefreshToken: true,
    },
    {
      id: 'acc-2',
      provider: 'antigravity',
      label: 'Work',
      email: 'work@kite.local',
      planName: 'Google AI Ultra',
      lastUsedUnixMs: 500,
      isActive: false,
      primaryRemainingPercent: null,
      primaryResetAt: null,
      timeUntilResetMs: null,
      credentialStatus: 'valid',
      hasRefreshToken: true,
    },
  ];
}

describe('Unified Multi-Account Lifecycle & Cross-Surface Sync (S6.1 & S6.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetScenario();
  });

  it('synchronizes AccountVault, SubscriptionQuotaPopover, QuotasTab, AccountTab, and CodePaneHeader after switching', async () => {
    const user = userEvent.setup();
    const occupant: PaneOccupantTerminal = {
      kind: 'terminal',
      sessionId: 'sess-agy',
      label: 'Orion',
      engine: 'antigravity',
      runtime: { engine: 'antigravity', displayName: 'Antigravity', agentName: 'Orion' },
    };

    render(
      <div>
        <div data-testid="quotas-tab-wrap">
          <QuotasTab />
        </div>
        <div data-testid="account-tab-wrap">
          <AccountTab />
        </div>
        <SubscriptionQuotaPopover
          allQuotas={{
            antigravity: {
              providerId: 'antigravity',
              displayName: 'Antigravity',
              isAvailable: true,
              isAuth: true,
              primaryUsagePercent: 10,
              primaryRemainingPercent: 90,
              primaryResetAt: null,
              timeUntilResetMs: null,
              windows: [
                {
                  name: 'Gemini Pro',
                  usagePercent: 10,
                  remainingFraction: 0.9,
                  resetsAt: null,
                  timeUntilResetMs: null,
                  isExhausted: false,
                },
              ],
              metadata: { email: 'personal@kite.local', planType: 'Google AI Pro' },
              lastUpdatedMs: Date.now(),
              error: null,
            },
          }}
          selectedProvider="antigravity"
          onSelectProvider={vi.fn()}
          onRefresh={vi.fn()}
          onClose={vi.fn()}
          prefs={{
            ...DEFAULT_QUOTA_PREFERENCES,
            setupVersion: QUOTA_SETUP_VERSION,
            enabledProviders: [PROVIDERS.ANTIGRAVITY],
          }}
        />
        <CodePaneHeader
          nodeId="leaf-1"
          occupant={occupant}
          displayName="Orion"
          workspaceName="Kite"
          canSwap={false}
          isFullscreen={false}
          isMenuOpen={false}
          paneMenuKind={null}
          renamingLeafId={null}
          renameValue=""
          availableEngines={[]}
          onOpenMenu={vi.fn()}
          onCloseMenu={vi.fn()}
          onToggleFullscreen={vi.fn()}
          onClosePane={vi.fn()}
          onSplit={vi.fn()}
          onSwap={vi.fn()}
          onExtractToTab={vi.fn()}
          onEqualize={vi.fn()}
          onStartRename={vi.fn()}
          onChangeRename={vi.fn()}
          onCommitRename={vi.fn()}
          onCancelRename={vi.fn()}
          onLaunchTerminal={vi.fn()}
          onLaunchAgent={vi.fn()}
          onNewTab={vi.fn()}
          onNewSession={vi.fn()}
          onPointerDownHeader={vi.fn()}
          onTerminalCommand={vi.fn()}
        />
      </div>
    );

    const quotasWrap = screen.getByTestId('quotas-tab-wrap');
    const accountWrap = screen.getByTestId('account-tab-wrap');

    expect(await within(quotasWrap).findByText('Personal')).toBeInTheDocument();
    expect(screen.getByTestId('pane-account-pill')).toHaveTextContent('Personal');
    expect(await within(accountWrap).findByText('personal@kite.local')).toBeInTheDocument();

    // Inactive card in AccountVault does NOT copy active account's 90% quota
    expect(
      within(quotasWrap).getByText(/Activa esta cuenta para consultar su cuota en vivo/i)
    ).toBeInTheDocument();

    // Activate Work account from QuotasTab's AccountVault
    const activateBtn = within(quotasWrap).getByRole('button', { name: /^Activar$/i });
    await user.click(activateBtn);

    await waitFor(() => {
      expect(screen.getByTestId('pane-account-pill')).toHaveTextContent('Work');
    });
    expect(await within(accountWrap).findByText('work@kite.local')).toBeInTheDocument();
    expect(within(quotasWrap).getAllByText('work@kite.local').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('work@kite.local').length).toBeGreaterThanOrEqual(3);
  });

  it('never flips Activa optimistically, handles CONFIRM_BUSY_TERMINALS & failure cleanly', async () => {
    const user = userEvent.setup();
    const ipc = await import('../../lib/ipc');

    let resolvePendingSwitch!: (val: any) => void;
    vi.mocked(ipc.switchAccountProfile)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePendingSwitch = resolve;
          })
      )
      .mockImplementationOnce(async (_provider: string, accountId: string) => {
        const target = mockProfiles.find((p) => p.id === accountId)!;
        mockProfiles = mockProfiles.map((p) => ({ ...p, isActive: p.id === accountId }));
        return { success: true, profile: { ...target, isActive: true } };
      })
      .mockResolvedValueOnce({
        success: false,
        code: 'INVALID_TARGET_PROFILE',
        error: 'El perfil seleccionado no tiene tokens OAuth válidos.',
      });

    render(<AccountVault />);
    await screen.findByText('Personal');

    const activateBtn = screen.getByRole('button', { name: /^Activar$/i });
    await user.click(activateBtn);

    // While pending: button shows verification label and Activa has NOT moved to Work
    expect(screen.getByRole('button', { name: /Cambiando y verificando/i })).toBeInTheDocument();
    const workCard = screen.getByText('Work').closest('article')!;
    expect(within(workCard).queryByText('Activa')).toBeNull();

    // Backend responds with CONFIRM_BUSY_TERMINALS -> custom accessible dialog opens
    resolvePendingSwitch({
      success: false,
      code: 'CONFIRM_BUSY_TERMINALS',
      busySessions: [
        {
          sessionId: 'term-1',
          engine: 'antigravity',
          cwd: '/repo/kite',
          busy: true,
          reasons: ['output_recent'],
          presentationLive: true,
        },
      ],
      managedIdleCount: 1,
      unaffectedTerminalsCount: 2,
    });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Confirmar cambio con sesiones activas/i)).toBeInTheDocument();
    expect(within(dialog).getByText('/repo/kite')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Cambiar de todas formas/i }));
    await waitFor(() => {
      expect(ipc.switchAccountProfile).toHaveBeenLastCalledWith('antigravity', 'acc-2', {
        force: true,
      });
    });

    // Now Work is active. Attempting to switch back to Personal fails cleanly without moving Activa.
    const activatePersonalBtn = await screen.findByRole('button', { name: /^Activar$/i });
    await user.click(activatePersonalBtn);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/tokens OAuth válidos/i);
    expect(within(alert).getByRole('button', { name: /Reautenticar/i })).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: /Reintentar/i })).toBeInTheDocument();
    expect(within(screen.getByText('Work').closest('article')!).getByText('Activa')).toBeInTheDocument();
  });

  it('supports inline rename, save overwrite guard, split-brain align button, and custom delete dialog without window.confirm', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockProfiles[1] = {
      ...mockProfiles[1],
      credentialStatus: 'expired_no_refresh',
      hasRefreshToken: false,
    };
    mockTelemetry = {
      authMode: 'oauth',
      authModeLabel: 'OAuth CLI',
      cliEmail: 'personal@kite.local',
      ideEmail: 'work@kite.local',
      splitBrainWarning: true,
    };

    const ipc = await import('../../lib/ipc');
    render(
      <div>
        <AccountVault />
        <AccountSwitcherModal
          provider="antigravity"
          providerLabel="Antigravity"
          isOpen={false}
          onClose={vi.fn()}
        />
      </div>
    );

    await screen.findByText('Personal');

    // Health & split-brain badges
    expect(screen.getByText('Lista')).toBeInTheDocument();
    expect(screen.getByText('Sin token / Reautenticar')).toBeInTheDocument();
    expect(screen.getByText('OAuth CLI')).toBeInTheDocument();
    expect(screen.getByText('IDE desincronizada')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alinear IDE/i })).toBeInTheDocument();

    // Inline rename
    await user.click(screen.getByRole('button', { name: /Renombrar perfil Personal/i }));
    const renameInput = screen.getByLabelText(/Nuevo nombre para Personal/i);
    await user.clear(renameInput);
    await user.type(renameInput, 'Principal');
    await user.click(screen.getByRole('button', { name: /^Guardar$/i }));
    expect(ipc.renameAccountProfile).toHaveBeenCalledWith('antigravity', 'acc-1', 'Principal');
    expect(await screen.findByText('Principal')).toBeInTheDocument();

    // Save overwrite guard when typing a new label for already-saved email
    const labelInput = screen.getByPlaceholderText(/Nombre de la cuenta/i);
    await user.type(labelInput, 'Alias Nuevo');
    await user.click(screen.getByRole('button', { name: /^Guardar sesión$/i }));

    const overwriteDialog = await screen.findByRole('dialog');
    expect(overwriteDialog).toHaveTextContent(/Esta cuenta ya está guardada como «Principal»/i);
    await user.click(within(overwriteDialog).getByRole('button', { name: /Actualizar credenciales/i }));
    expect(ipc.saveCurrentAccountProfile).toHaveBeenCalledWith('antigravity', 'Principal');

    // Custom delete dialog (NEVER calls window.confirm)
    const deleteButtons = screen.getAllByRole('button', { name: /^Eliminar$/i });
    await user.click(deleteButtons[1]);
    const deleteDialog = await screen.findByRole('dialog');
    expect(within(deleteDialog).getByText(/Eliminar perfil guardado/i)).toBeInTheDocument();
    await user.click(within(deleteDialog).getByRole('button', { name: /Eliminar perfil/i }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ipc.deleteAccountProfile).toHaveBeenCalledWith('antigravity', 'acc-2');
    confirmSpy.mockRestore();
  });
});
