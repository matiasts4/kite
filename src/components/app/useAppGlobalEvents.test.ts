import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useAppGlobalEvents } from './useAppGlobalEvents';
import { OPEN_RIGHT_DOCK_SUBAGENT_EVENT } from '../../lib/subagentNav';
import {
  accountVaultStore,
  resetAccountVaultStoreForTest,
} from '../../lib/accounts/accountVaultStore';

const tauriMocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: { payload: any }) => void>>();
  const listen = vi.fn(async (name: string, handler: (event: { payload: any }) => void) => {
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

const ipcMocks = vi.hoisted(() => ({
  confirmPendingAutoSwitch: vi.fn(),
  dismissPendingAutoSwitch: vi.fn(),
  closeResidualProviderProcesses: vi.fn(),
  listSavedAccountsFull: vi.fn().mockResolvedValue({ profiles: [], unregisteredLiveSession: null }),
  getAutoSwitchPolicy: vi.fn().mockResolvedValue({
    provider: 'agy',
    policy: {
      enabled: true,
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
    status: { paused: false, recentSwitchCount: 0 },
  }),
  listPendingAutoSwitches: vi.fn().mockResolvedValue({ success: true, confirmations: [] }),
  getSubscriptionQuotas: vi.fn().mockResolvedValue({}),
  listConnections: vi.fn().mockResolvedValue([]),
}));

const toastMocks = vi.hoisted(() => ({
  registerToastNavigator: vi.fn(() => () => {}),
  toast: {
    action: vi.fn(() => 'toast-action-1'),
    success: vi.fn(() => 'toast-success-1'),
    error: vi.fn(() => 'toast-error-1'),
    warning: vi.fn(() => 'toast-warn-1'),
    dismiss: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauriMocks.listen,
}));
vi.mock('../../lib/ipc', () => ipcMocks);
vi.mock('../../lib/toast', () => toastMocks);

describe('useAppGlobalEvents Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.listeners.clear();
    resetAccountVaultStoreForTest();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    resetAccountVaultStoreForTest();
  });

  it('handles kite:navigate-mode event with aliases', () => {
    const setWorkMode = vi.fn();
    const setSettingsOpen = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode,
        setSettingsOpen,
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'threads' }));
    });

    expect(setWorkMode).toHaveBeenCalledWith('chat');
    expect(setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('handles kite:open-settings event', () => {
    const setSettingsOpen = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen,
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:open-settings'));
    });

    expect(setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('handles kite:open-command-palette event', () => {
    const setIsCommandPaletteOpen = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen,
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:open-command-palette'));
    });

    expect(setIsCommandPaletteOpen).toHaveBeenCalledWith(true);
  });

  it('opens RightDock and selects workspace when kite:open-right-dock-subagent fires', () => {
    const setRightDockVisible = vi.fn();
    const setSelectedWorkspaceId = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId,
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible,
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, {
          detail: { threadId: 't-1', subagentId: 'sub-1', workspaceId: 'ws-9' },
        })
      );
    });

    expect(setRightDockVisible).toHaveBeenCalledWith(true);
    expect(setSelectedWorkspaceId).toHaveBeenCalledWith('ws-9');
  });

  it('opens RightDock on kite:open-right-dock-diffs, kite:open-diffs, and Ctrl+Alt+S', () => {
    const setRightDockVisible = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible,
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:open-right-dock-diffs'));
      window.dispatchEvent(new CustomEvent('kite:open-diffs'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, altKey: true }));
    });

    expect(setRightDockVisible).toHaveBeenCalledTimes(3);
    expect(setRightDockVisible).toHaveBeenNthCalledWith(1, true);
    expect(setRightDockVisible).toHaveBeenNthCalledWith(2, true);
    expect(setRightDockVisible).toHaveBeenNthCalledWith(3, true);
  });

  it('triggers toast.action on kite://auto-switch-confirmation and confirms with suggested model', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    const loadThreads = vi.fn().mockResolvedValue(undefined);
    const notifEvents: Event[] = [];
    const onNotif = (e: Event) => notifEvents.push(e);
    window.addEventListener('kite:notifications-refresh', onNotif);

    ipcMocks.confirmPendingAutoSwitch.mockResolvedValueOnce({
      success: true,
      confirmationId: 'conf-99',
      provider: 'agy',
      toAccountId: 'acc-2',
      toAccountLabel: 'Work (Free)',
      appliedModel: 'gemini-2.5-flash',
      modelAdjusted: true,
      resumedThreadId: 'thread-5',
    });

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads,
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    await waitFor(() => {
      expect(tauriMocks.listeners.get('kite://auto-switch-confirmation')?.length).toBeGreaterThan(0);
    });

    const confirmationPayload = {
      confirmationId: 'conf-99',
      provider: 'agy',
      fromAccountId: 'acc-1',
      fromAccountLabel: 'Personal',
      fromEmail: 'personal@kite.local',
      toAccountId: 'acc-2',
      toAccountLabel: 'Work (Free)',
      toEmail: 'work@kite.local',
      toPlanName: 'Free',
      sourcePlanName: 'Google AI Pro',
      requestedModel: 'claude-opus-4-6',
      suggestedFallbackModel: 'gemini-2.5-flash',
      availableTargetModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      threadId: 'thread-5',
      busySessions: [],
      reason: 'model_mismatch',
      createdAtUnixMs: 1000,
      expiresAtUnixMs: 901000,
    };

    act(() => {
      for (const h of tauriMocks.listeners.get('kite://auto-switch-confirmation') ?? []) {
        h({ payload: confirmationPayload });
      }
    });

    expect(notifEvents.length).toBeGreaterThanOrEqual(1);
    expect(accountVaultStore.getSnapshot('antigravity').pendingAutoSwitchConfirmations).toHaveLength(1);
    expect(toastMocks.toast.action).toHaveBeenCalledTimes(1);

    const [title, button] = toastMocks.toast.action.mock.calls[0] as unknown as [
      string,
      { title: string; onClick: () => Promise<void> | void }
    ];
    expect(title).toContain('Personal');
    expect(button.title).toContain('gemini-2.5-flash');

    await act(async () => {
      await button.onClick();
    });

    expect(ipcMocks.confirmPendingAutoSwitch).toHaveBeenCalledWith({
      confirmationId: 'conf-99',
      selectedModelId: 'gemini-2.5-flash',
    });
    expect(toastMocks.toast.dismiss).toHaveBeenCalledWith('toast-action-1');

    act(() => {
      for (const h of tauriMocks.listeners.get('kite://auto-switch-executed') ?? []) {
        h({
          payload: {
            provider: 'agy',
            confirmationId: 'conf-99',
            fromAccountId: 'acc-1',
            fromAccountLabel: 'Personal',
            toAccountId: 'acc-2',
            toAccountLabel: 'Work (Free)',
            appliedModel: 'gemini-2.5-flash',
            modelAdjusted: true,
            autoContinueChatTurn: true,
            compatibility: 'model_adjusted',
            triggerSource: 'confirmation',
            threadId: 'thread-5',
            resumedThreadId: 'thread-5',
          },
        });
      }
    });

    expect(loadThreads).toHaveBeenCalled();
    expect(toastMocks.toast.success).toHaveBeenCalled();

    act(() => {
      for (const h of tauriMocks.listeners.get('kite://auto-switch-status') ?? []) {
        h({
          payload: {
            provider: 'agy',
            status: {
              paused: true,
              pauseReason: 'ALL_ACCOUNTS_EXHAUSTED',
              cooldownUntilMs: null,
              recentSwitchCount: 2,
              nextResetMs: 1800000,
            },
          },
        });
      }
    });

    expect(accountVaultStore.getSnapshot('antigravity').autoSwitchRuntimeStatus.paused).toBe(true);
    expect(accountVaultStore.getSnapshot('antigravity').autoSwitchRuntimeStatus.pauseReason).toBe(
      'ALL_ACCOUNTS_EXHAUSTED'
    );

    window.removeEventListener('kite:notifications-refresh', onNotif);
  });

  it('surfaces PROVIDER_BUSY cleanly from toast.action without overlapping flows', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    ipcMocks.confirmPendingAutoSwitch
      .mockResolvedValueOnce({
        success: false,
        confirmationId: 'conf-busy',
        code: 'PROVIDER_BUSY',
        error: 'Quedaron procesos residuales de Antigravity.',
        providerBusyKind: 'residual_only',
        canCloseProcesses: true,
        residualProcessCount: 1,
      })
      .mockResolvedValueOnce({
        success: true,
        confirmationId: 'conf-busy',
        provider: 'agy',
        toAccountId: 'acc-2',
        toAccountLabel: 'Work',
        appliedModel: 'gemini-2.5-flash',
      });
    ipcMocks.closeResidualProviderProcesses.mockResolvedValueOnce({
      success: true,
      closedCount: 1,
      closedPids: [99],
    });

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    await waitFor(() => {
      expect(tauriMocks.listeners.get('kite://auto-switch-confirmation')?.length).toBeGreaterThan(0);
    });

    act(() => {
      for (const h of tauriMocks.listeners.get('kite://auto-switch-confirmation') ?? []) {
        h({
          payload: {
            confirmationId: 'conf-busy',
            provider: 'agy',
            fromAccountLabel: 'Personal',
            toAccountId: 'acc-2',
            toAccountLabel: 'Work',
            requestedModel: 'claude-opus-4-6',
            suggestedFallbackModel: 'gemini-2.5-flash',
            availableTargetModels: ['gemini-2.5-flash'],
            busySessions: [],
            reason: 'model_mismatch',
            createdAtUnixMs: 1000,
            expiresAtUnixMs: 901000,
          },
        });
      }
    });

    const firstButton = (toastMocks.toast.action.mock.calls[0] as unknown as [
      string,
      { title: string; onClick: () => Promise<void> }
    ])?.[1];
    await act(async () => {
      await firstButton.onClick();
    });

    expect(toastMocks.toast.action).toHaveBeenCalledTimes(2);
    const secondButton = (toastMocks.toast.action.mock.calls[1] as unknown as [
      string,
      { title: string; onClick: () => Promise<void> }
    ])?.[1];
    expect(secondButton.title).toContain('Cerrar procesos Antigravity');

    await act(async () => {
      await secondButton.onClick();
    });

    expect(ipcMocks.closeResidualProviderProcesses).toHaveBeenCalledWith('agy');
    expect(ipcMocks.confirmPendingAutoSwitch).toHaveBeenCalledTimes(2);
  });
});
