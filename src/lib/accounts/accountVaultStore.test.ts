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
  getAutoSwitchPolicy: vi.fn(),
  saveAutoSwitchPolicy: vi.fn(),
  resumeAutoSwitch: vi.fn(),
  listPendingAutoSwitches: vi.fn(),
  confirmPendingAutoSwitch: vi.fn(),
  dismissPendingAutoSwitch: vi.fn(),
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
    ipcMocks.getAutoSwitchPolicy.mockResolvedValue({
      provider: 'agy',
      policy: {
        enabled: false,
        triggerThresholdPercent: 0,
        selectionStrategy: 'highest_quota',
        priorityOrder: [],
        excludedAccountIds: [],
        modelMismatchPolicy: 'confirm_notification',
        busyTerminalsPolicy: 'wait_idle',
        autoContinueChatTurn: true,
        cooldownSeconds: 120,
        maxConsecutiveSwitches: 3,
      },
      status: {
        paused: false,
        pauseReason: null,
        cooldownUntilMs: null,
        recentSwitchCount: 0,
        nextResetAt: null,
        nextResetMs: null,
        lastErrorCode: null,
      },
    });
    ipcMocks.listPendingAutoSwitches.mockResolvedValue({
      success: true,
      confirmations: [],
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

  it('syncs autoSwitchPolicy, eligibility/priority ordering, resume, and kite:auto-switch-changed across surfaces', async () => {
    const autoSwitchEvents: unknown[] = [];
    const onAutoSwitchChanged = (e: Event) => autoSwitchEvents.push((e as CustomEvent).detail);
    window.addEventListener('kite:auto-switch-changed', onAutoSwitchChanged);

    ipcMocks.saveAutoSwitchPolicy.mockImplementation(async (_prov, policy) => ({
      success: true,
      provider: 'agy',
      policy,
      status: {
        paused: false,
        pauseReason: null,
        cooldownUntilMs: null,
        recentSwitchCount: 0,
      },
    }));
    ipcMocks.resumeAutoSwitch.mockResolvedValue({
      success: true,
      provider: 'agy',
      status: {
        paused: false,
        pauseReason: null,
        cooldownUntilMs: null,
        recentSwitchCount: 0,
      },
    });

    const hookA = renderHook(() => useAccountVault('antigravity'));
    const hookB = renderHook(() => useAccountVault('agy'));
    await waitFor(() => expect(hookA.result.current.profiles).toHaveLength(2));

    expect(hookA.result.current.autoSwitchPolicy.enabled).toBe(false);

    await act(async () => {
      await hookA.result.current.updateAutoSwitchPolicy({
        enabled: true,
        selectionStrategy: 'priority_order',
      });
    });

    expect(ipcMocks.saveAutoSwitchPolicy).toHaveBeenCalledWith(
      'antigravity',
      expect.objectContaining({
        enabled: true,
        selectionStrategy: 'priority_order',
      })
    );
    expect(hookB.result.current.autoSwitchPolicy.enabled).toBe(true);
    expect(autoSwitchEvents.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await hookA.result.current.toggleAccountAutoSwitchEligibility('acc-2');
    });
    expect(hookB.result.current.autoSwitchPolicy.excludedAccountIds).toContain('acc-2');

    await act(async () => {
      await hookA.result.current.moveAccountAutoSwitchPriority('acc-2', 'up');
    });
    expect(hookB.result.current.autoSwitchPolicy.priorityOrder[0]).toBe('acc-2');

    act(() => {
      accountVaultStore.applyAutoSwitchStatusEvent('agy', {
        paused: true,
        pauseReason: 'ALL_ACCOUNTS_EXHAUSTED',
        cooldownUntilMs: null,
        recentSwitchCount: 1,
        nextResetAt: '2026-11-15T05:00:00Z',
        nextResetMs: 3600000,
        lastErrorCode: null,
      });
    });
    expect(hookB.result.current.autoSwitchRuntimeStatus.paused).toBe(true);

    await act(async () => {
      await hookA.result.current.resumeAutoSwitch();
    });
    expect(ipcMocks.resumeAutoSwitch).toHaveBeenCalledWith('antigravity');
    expect(hookB.result.current.autoSwitchRuntimeStatus.paused).toBe(false);

    window.removeEventListener('kite:auto-switch-changed', onAutoSwitchChanged);
  });

  it('confirms and dismisses pending auto-switch confirmations cleanly', async () => {
    const sampleConf = {
      confirmationId: 'conf-42',
      provider: 'agy',
      fromAccountId: 'acc-1',
      fromAccountLabel: 'Personal Pro',
      fromEmail: 'personal@gmail.com',
      toAccountId: 'acc-2',
      toAccountLabel: 'Trabajo Team',
      toEmail: 'work@company.com',
      toPlanName: 'Google AI Ultra',
      sourcePlanName: 'Google AI Pro',
      requestedModel: 'claude-opus-4-6',
      suggestedFallbackModel: 'gemini-2.5-flash',
      availableTargetModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      threadId: 'thread-7',
      busySessions: [],
      reason: 'model_mismatch',
      createdAtUnixMs: 1000,
      expiresAtUnixMs: 901000,
    };
    ipcMocks.listPendingAutoSwitches.mockResolvedValue({
      success: true,
      confirmations: [sampleConf],
    });
    ipcMocks.confirmPendingAutoSwitch.mockResolvedValueOnce({
      success: true,
      confirmationId: 'conf-42',
      provider: 'agy',
      toAccountId: 'acc-2',
      toAccountLabel: 'Trabajo Team',
      appliedModel: 'gemini-2.5-pro',
      modelAdjusted: true,
      resumedThreadId: 'thread-7',
    });

    const threadEvents: Event[] = [];
    const notifEvents: Event[] = [];
    const onThreads = (e: Event) => threadEvents.push(e);
    const onNotif = (e: Event) => notifEvents.push(e);
    window.addEventListener('kite:threads-changed', onThreads);
    window.addEventListener('kite:notifications-refresh', onNotif);

    const { result } = renderHook(() => useAccountVault('antigravity'));
    await waitFor(() =>
      expect(result.current.pendingAutoSwitchConfirmations).toHaveLength(1)
    );

    await act(async () => {
      await result.current.confirmPendingAutoSwitch({
        confirmationId: 'conf-42',
        selectedModelId: 'gemini-2.5-pro',
      });
    });

    expect(ipcMocks.confirmPendingAutoSwitch).toHaveBeenCalledWith({
      confirmationId: 'conf-42',
      selectedModelId: 'gemini-2.5-pro',
    });
    expect(result.current.pendingAutoSwitchConfirmations).toHaveLength(0);
    expect(threadEvents).toHaveLength(1);
    expect(notifEvents.length).toBeGreaterThanOrEqual(1);

    window.removeEventListener('kite:threads-changed', onThreads);
    window.removeEventListener('kite:notifications-refresh', onNotif);
  });
});
