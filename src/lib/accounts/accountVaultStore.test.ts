import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  accountVaultStore,
  resetAccountVaultStoreForTest,
} from './accountVaultStore';
import { useAccountVault } from './useAccountVault';

const ipcMocks = vi.hoisted(() => ({
  listSavedAccountsFull: vi.fn(),
  switchAccountProfile: vi.fn(),
  closeResidualProviderProcesses: vi.fn(),
  saveCurrentAccountProfile: vi.fn(),
  renameAccountProfile: vi.fn(),
  deleteAccountProfile: vi.fn(),
  isTauriEnvironment: vi.fn(() => false),
}));

const quotaMocks = vi.hoisted(() => ({
  fetchAll: vi.fn().mockResolvedValue({}),
  invalidateAndMarkRefreshing: vi.fn(),
}));

const tauriMocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: { payload: unknown }) => void>>();
  const listen = vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const arr = listeners.get(name) ?? [];
    arr.push(handler);
    listeners.set(name, arr);
    return () => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((fn) => fn !== handler)
      );
    };
  });
  return { listeners, listen };
});

vi.mock('../ipc', () => ipcMocks);
vi.mock('../quota/quotaManager', () => ({
  subscriptionQuotaManager: quotaMocks,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}));

const baseProfiles = [
  {
    id: 'acc-1',
    provider: 'agy',
    label: 'Personal Pro',
    email: 'personal@gmail.com',
    planName: 'Google AI Pro',
    isActive: true,
    lastUsedUnixMs: 1000,
    primaryRemainingPercent: 80,
    primaryResetAt: null,
    timeUntilResetMs: null,
    credentialStatus: 'valid',
    hasRefreshToken: true,
  },
  {
    id: 'acc-2',
    provider: 'agy',
    label: 'Trabajo Team',
    email: 'work@company.com',
    planName: 'Google AI Ultra',
    isActive: false,
    lastUsedUnixMs: 500,
    primaryRemainingPercent: 95,
    primaryResetAt: null,
    timeUntilResetMs: null,
    credentialStatus: 'valid',
    hasRefreshToken: true,
  },
];

describe('accountVaultStore & useAccountVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.listeners.clear();
    resetAccountVaultStoreForTest();
    ipcMocks.isTauriEnvironment.mockReturnValue(false);
    ipcMocks.listSavedAccountsFull.mockResolvedValue({
      profiles: baseProfiles,
      unregisteredLiveSession: null,
      authTelemetry: {
        authMode: 'oauth',
        authModeLabel: 'OAuth (Google)',
        cliEmail: 'personal@gmail.com',
        ideEmail: 'personal@gmail.com',
        splitBrainWarning: false,
        hasRefreshToken: true,
      },
    });
  });

  afterEach(() => {
    resetAccountVaultStoreForTest();
  });

  it('unifies antigravity and agy consumers and deduplicates concurrent loads without stalling later refreshes', async () => {
    let resolveFirst!: (val: unknown) => void;
    ipcMocks.listSavedAccountsFull.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );

    const hookA = renderHook(() => useAccountVault('antigravity'));
    const hookB = renderHook(() => useAccountVault('agy'));

    expect(ipcMocks.listSavedAccountsFull).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        profiles: baseProfiles,
        unregisteredLiveSession: null,
        authTelemetry: { authMode: 'oauth', cliEmail: 'personal@gmail.com', splitBrainWarning: false },
      });
    });

    await waitFor(() => {
      expect(hookA.result.current.profiles).toHaveLength(2);
      expect(hookB.result.current.profiles).toHaveLength(2);
    });

    await act(async () => {
      await accountVaultStore.loadAccounts('antigravity');
    });
    expect(ipcMocks.listSavedAccountsFull).toHaveBeenCalledTimes(2);
  });

  it('performs non-optimistic switching and keeps active profile unchanged on backend failure', async () => {
    let resolveSwitch!: (val: unknown) => void;
    ipcMocks.switchAccountProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSwitch = resolve;
        })
    );

    const { result } = renderHook(() => useAccountVault('antigravity'));
    await waitFor(() => expect(result.current.profiles).toHaveLength(2));

    let switchPromise!: Promise<unknown>;
    act(() => {
      switchPromise = result.current.switchAccount('acc-2');
    });

    // While switch is pending, switchingId is set and isActive MUST NOT optimistically flip
    expect(result.current.switchingId).toBe('acc-2');
    expect(result.current.profiles.find((p) => p.id === 'acc-1')?.isActive).toBe(true);
    expect(result.current.profiles.find((p) => p.id === 'acc-2')?.isActive).toBe(false);

    await act(async () => {
      resolveSwitch({
        success: false,
        code: 'PROVIDER_BUSY',
        error: 'Antigravity IDE está abierto.',
      });
      await switchPromise;
    });

    expect(result.current.switchingId).toBeNull();
    expect(result.current.error).toContain('Antigravity IDE está abierto');
    expect(result.current.profiles.find((p) => p.id === 'acc-1')?.isActive).toBe(true);
    expect(result.current.profiles.find((p) => p.id === 'acc-2')?.isActive).toBe(false);
    expect(quotaMocks.fetchAll).not.toHaveBeenCalled();
  });

  it('captures CONFIRM_BUSY_TERMINALS into busyConfirm and completes verified switch when forced', async () => {
    const events: unknown[] = [];
    const onChanged = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('kite:accounts-changed', onChanged);

    ipcMocks.switchAccountProfile
      .mockResolvedValueOnce({
        success: false,
        code: 'CONFIRM_BUSY_TERMINALS',
        error: 'Hay terminales activas.',
        busySessions: [
          {
            sessionId: 'sid-1',
            engine: 'agy',
            cwd: 'C:\\repo',
            busy: true,
            reasons: ['streaming'],
            presentationLive: true,
          },
        ],
        managedIdleCount: 0,
        unaffectedTerminalsCount: 2,
      })
      .mockResolvedValueOnce({
        success: true,
        profile: { ...baseProfiles[1], isActive: true },
        terminalsRestarted: 1,
        targetedSessionIds: ['sid-1'],
        skippedUnaffectedCount: 2,
      });

    ipcMocks.listSavedAccountsFull
      .mockResolvedValueOnce({ profiles: baseProfiles, unregisteredLiveSession: null, authTelemetry: null })
      .mockResolvedValueOnce({
        profiles: [
          { ...baseProfiles[0], isActive: false },
          { ...baseProfiles[1], isActive: true },
        ],
        unregisteredLiveSession: null,
        authTelemetry: { authMode: 'oauth', cliEmail: 'work@company.com', splitBrainWarning: false },
      });

    const { result } = renderHook(() => useAccountVault('antigravity'));
    await waitFor(() => expect(result.current.profiles).toHaveLength(2));

    await act(async () => {
      await result.current.switchAccount('acc-2');
    });

    expect(result.current.busyConfirm).toMatchObject({
      accountId: 'acc-2',
      label: 'Trabajo Team',
      unaffectedTerminalsCount: 2,
    });
    expect(result.current.profiles.find((p) => p.id === 'acc-1')?.isActive).toBe(true);

    await act(async () => {
      await result.current.confirmBusySwitch();
    });

    expect(ipcMocks.switchAccountProfile).toHaveBeenLastCalledWith('antigravity', 'acc-2', { force: true });
    expect(result.current.busyConfirm).toBeNull();
    expect(result.current.profiles.find((p) => p.id === 'acc-2')?.isActive).toBe(true);
    expect(result.current.notice).toContain('Trabajo Team');
    expect(quotaMocks.invalidateAndMarkRefreshing).toHaveBeenCalledWith('antigravity');
    expect(quotaMocks.fetchAll).toHaveBeenCalledWith(true, ['antigravity']);
    expect(events.length).toBeGreaterThanOrEqual(1);

    window.removeEventListener('kite:accounts-changed', onChanged);
  });

  it('guards accidental overwrite on saveCurrentAccount and supports update vs rename', async () => {
    ipcMocks.saveCurrentAccountProfile.mockResolvedValue({
      success: true,
      profile: { ...baseProfiles[0], label: 'Personal Pro' },
    });
    ipcMocks.renameAccountProfile.mockResolvedValue({
      success: true,
      profile: { ...baseProfiles[0], label: 'Mi Cuenta Nueva' },
    });

    const { result } = renderHook(() => useAccountVault('antigravity'));
    await waitFor(() => expect(result.current.profiles).toHaveLength(2));

    // Trying to save current live email (personal@gmail.com) with a different label triggers overwritePrompt
    await act(async () => {
      await result.current.saveCurrentAccount('Mi Cuenta Nueva', { source: 'manual' });
    });

    expect(ipcMocks.saveCurrentAccountProfile).not.toHaveBeenCalled();
    expect(result.current.overwritePrompt).toMatchObject({
      pendingLabel: 'Mi Cuenta Nueva',
      existingProfile: expect.objectContaining({ id: 'acc-1', label: 'Personal Pro' }),
    });

    // Action 1: Update credentials keeping existing label
    await act(async () => {
      await result.current.confirmOverwriteUpdate();
    });
    expect(ipcMocks.saveCurrentAccountProfile).toHaveBeenCalledWith('antigravity', 'Personal Pro');
    expect(result.current.overwritePrompt).toBeNull();

    // Trigger overwrite prompt again and choose Rename
    await act(async () => {
      await result.current.saveCurrentAccount('Mi Cuenta Nueva', { source: 'manual' });
    });
    await act(async () => {
      await result.current.confirmOverwriteRename();
    });
    expect(ipcMocks.renameAccountProfile).toHaveBeenCalledWith('antigravity', 'acc-1', 'Mi Cuenta Nueva');
    expect(ipcMocks.saveCurrentAccountProfile).toHaveBeenLastCalledWith('antigravity', 'Mi Cuenta Nueva');
  });

  it('refreshes on terminal://account-rotated Tauri event when running in Tauri', async () => {
    ipcMocks.isTauriEnvironment.mockReturnValue(true);

    const { result } = renderHook(() => useAccountVault('antigravity'));
    await waitFor(() => expect(result.current.profiles).toHaveLength(2));
    expect(tauriMocks.listen).toHaveBeenCalledWith('terminal://account-rotated', expect.any(Function));

    ipcMocks.listSavedAccountsFull.mockResolvedValueOnce({
      profiles: [
        { ...baseProfiles[0], isActive: false },
        { ...baseProfiles[1], isActive: true },
      ],
      unregisteredLiveSession: null,
      authTelemetry: { authMode: 'oauth', cliEmail: 'work@company.com', splitBrainWarning: false },
    });

    await act(async () => {
      for (const handler of tauriMocks.listeners.get('terminal://account-rotated') ?? []) {
        handler({ payload: { provider: 'agy', sessionId: 'sid-1' } });
      }
    });

    await waitFor(() => {
      expect(result.current.profiles.find((p) => p.id === 'acc-2')?.isActive).toBe(true);
    });
  });

  it('closes residual processes and retries failed PROVIDER_BUSY switch when canCloseProcesses is true', async () => {
    ipcMocks.switchAccountProfile
      .mockResolvedValueOnce({
        success: false,
        code: 'PROVIDER_BUSY',
        error: 'Quedaron 2 procesos residuales de Antigravity.',
        providerBusyKind: 'residual_only',
        canCloseProcesses: true,
        residualProcessCount: 2,
      })
      .mockResolvedValueOnce({
        success: true,
        profile: { ...baseProfiles[1], isActive: true },
        terminalsRestarted: 1,
      });

    ipcMocks.closeResidualProviderProcesses.mockResolvedValueOnce({
      success: true,
      closedCount: 2,
      closedPids: [401, 402],
    });

    ipcMocks.listSavedAccountsFull
      .mockResolvedValueOnce({ profiles: baseProfiles, unregisteredLiveSession: null, authTelemetry: null })
      .mockResolvedValueOnce({ profiles: baseProfiles, unregisteredLiveSession: null, authTelemetry: null })
      .mockResolvedValueOnce({
        profiles: [
          { ...baseProfiles[0], isActive: false },
          { ...baseProfiles[1], isActive: true },
        ],
        unregisteredLiveSession: null,
        authTelemetry: null,
      });

    const { result } = renderHook(() => useAccountVault('antigravity'));
    await waitFor(() => expect(result.current.profiles).toHaveLength(2));

    await act(async () => {
      await result.current.switchAccount('acc-2');
    });
    expect(result.current.lastFailedSwitch?.canCloseProcesses).toBe(true);
    expect(result.current.lastFailedSwitch?.providerBusyKind).toBe('residual_only');

    await act(async () => {
      await result.current.closeResidualProcesses();
    });

    expect(ipcMocks.closeResidualProviderProcesses).toHaveBeenCalledWith('antigravity');
    expect(ipcMocks.switchAccountProfile).toHaveBeenLastCalledWith('antigravity', 'acc-2');
    expect(result.current.lastFailedSwitch).toBeNull();
    expect(result.current.profiles.find((p) => p.id === 'acc-2')?.isActive).toBe(true);
  });

  it('keeps canCloseProcesses=false when base IDE is open and updates state on cleanup failure', async () => {
    ipcMocks.switchAccountProfile.mockResolvedValueOnce({
      success: false,
      code: 'PROVIDER_BUSY',
      error: 'Antigravity IDE está abierto.',
      providerBusyKind: 'base_app_open',
      canCloseProcesses: false,
      residualProcessCount: 0,
    });

    const { result } = renderHook(() => useAccountVault('antigravity'));
    await waitFor(() => expect(result.current.profiles).toHaveLength(2));

    await act(async () => {
      await result.current.switchAccount('acc-2');
    });
    expect(result.current.lastFailedSwitch?.providerBusyKind).toBe('base_app_open');
    expect(result.current.lastFailedSwitch?.canCloseProcesses).toBe(false);

    ipcMocks.switchAccountProfile.mockResolvedValueOnce({
      success: false,
      code: 'PROVIDER_BUSY',
      error: 'Quedó 1 proceso residual.',
      providerBusyKind: 'residual_only',
      canCloseProcesses: true,
      residualProcessCount: 1,
    });
    await act(async () => {
      await result.current.switchAccount('acc-2');
    });

    ipcMocks.closeResidualProviderProcesses.mockResolvedValueOnce({
      success: false,
      code: 'BASE_APP_OPEN',
      providerBusyKind: 'base_app_open',
      canCloseProcesses: false,
      residualProcessCount: 0,
      error: 'Antigravity IDE está abierto.',
    });
    await act(async () => {
      const res = await result.current.closeResidualProcesses();
      expect(res.success).toBe(false);
    });

    expect(result.current.closingProcesses).toBe(false);
    expect(result.current.lastFailedSwitch?.canCloseProcesses).toBe(false);
    expect(result.current.lastFailedSwitch?.providerBusyKind).toBe('base_app_open');
  });
});
