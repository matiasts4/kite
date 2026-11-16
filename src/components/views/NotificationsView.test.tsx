import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsView } from './NotificationsView';
import { resetAccountVaultStoreForTest } from '../../lib/accounts/accountVaultStore';
import * as settingsNav from '../../lib/settingsNav';

// Mock ipc invokeCommand
vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

import { invokeCommand } from '../../lib/ipc';

describe('NotificationsView Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAccountVaultStoreForTest();
  });

  it('renders clean header and empty state when there are no notifications', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce({
      records: [],
      unreadCount: 0,
      openInputRequestCount: 0,
      authorization: 'authorized',
      preferences: {
        osNotificationsEnabled: true,
        finishSoundEnabled: true,
        inputRequestsEnabled: true,
      },
    });

    render(<NotificationsView />);

    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    expect(screen.getByText('Notification settings…')).toBeInTheDocument();

    // Verify clutter buttons (Volume, Clear, Close) are NOT present in header
    expect(screen.queryByTitle(/sound/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/clear/i)).not.toBeInTheDocument();
  });

  it('renders grouped notifications matching design and triggers navigation', async () => {
    const onNavigateMode = vi.fn();
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();

    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000 - 10 * 60 * 60 * 1000;

    vi.mocked(invokeCommand).mockResolvedValueOnce({
      records: [
        {
          id: 'notif-1',
          createdAtUnixMs: fiveDaysAgo,
          isRead: true,
          target: { source: 'codeThread', id: 'session-123' },
          kind: { kind: 'settled', outcome: 'completed' },
        },
      ],
      unreadCount: 0,
      openInputRequestCount: 0,
    });

    render(
      <NotificationsView
        onNavigateMode={onNavigateMode}
        onOpenSettings={onOpenSettings}
      />
    );

    // Header and section
    expect(await screen.findByText('Earlier')).toBeInTheDocument();
    expect(screen.getByText('Code thread')).toBeInTheDocument();
    expect(screen.getByText('Code thread closed')).toBeInTheDocument();

    // Click row navigates to code mode
    const row = screen.getByRole('button', { name: /Code thread, Code thread closed/i });
    await user.click(row);
    expect(onNavigateMode).toHaveBeenCalledWith('code');

    // Click settings triggers onOpenSettings
    const settingsBtn = screen.getByRole('button', { name: /Notification settings…/i });
    await user.click(settingsBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('renders sticky autoSwitchConfirm card with inline model picker, auto-continue toggle, confirm and dismiss without bubbling clicks', async () => {
    const user = userEvent.setup();
    const onNavigateThread = vi.fn();
    const pendingSnapshot = {
      records: [
        {
          id: 'autoswitch_conf-1',
          createdAtUnixMs: Date.now(),
          isRead: false,
          isWaitingForInput: true,
          resolution: null,
          target: { source: 'codeThread', id: 'thread-77' },
          kind: { kind: 'autoSwitchConfirm', requestKind: 'model_mismatch' },
          title: 'Model confirmation required to switch to Work',
          body: "Switching from Personal to Work (Free). Requested model 'claude-opus-4-6' is unavailable; suggested fallback: 'gemini-2.5-flash'.",
          confirmationId: 'conf-1',
          autoSwitchConfirm: {
            confirmationId: 'conf-1',
            provider: 'agy',
            fromAccountId: 'acc-1',
            fromAccountLabel: 'Personal',
            fromEmail: 'personal@kite.local',
            toAccountId: 'acc-2',
            toAccountLabel: 'Work',
            toEmail: 'work@kite.local',
            toPlanName: 'Free',
            sourcePlanName: 'Pro',
            requestedModel: 'claude-opus-4-6',
            suggestedFallbackModel: 'gemini-2.5-flash',
            availableTargetModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
            threadId: 'thread-77',
            busySessions: [],
            reason: 'model_mismatch',
            createdAtUnixMs: Date.now() - 1000,
            expiresAtUnixMs: Date.now() + 900000,
          },
        },
      ],
      unreadCount: 1,
      openInputRequestCount: 1,
    };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(pendingSnapshot)
      .mockResolvedValueOnce({
        success: true,
        confirmationId: 'conf-1',
        provider: 'agy',
        toAccountId: 'acc-2',
        toAccountLabel: 'Work',
        appliedModel: 'gemini-2.5-pro',
        modelAdjusted: true,
        resumedThreadId: 'thread-77',
      })
      .mockResolvedValueOnce({
        records: [],
        unreadCount: 0,
        openInputRequestCount: 0,
      });

    render(<NotificationsView onNavigateThread={onNavigateThread} />);

    expect(await screen.findByText('Needs you')).toBeInTheDocument();
    expect(screen.getByText(/Personal/i)).toBeInTheDocument();
    expect(screen.getByText(/Free/i)).toBeInTheDocument();

    const modelSelect = screen.getByLabelText(/Modelo destino/i) as HTMLSelectElement;
    expect(modelSelect.value).toBe('gemini-2.5-flash');

    await user.selectOptions(modelSelect, 'gemini-2.5-pro');
    expect(modelSelect.value).toBe('gemini-2.5-pro');

    const autoResumeToggle = screen.getByRole('checkbox', { name: /Reanudar turno/i });
    expect(autoResumeToggle).toBeChecked();
    await user.click(autoResumeToggle);
    expect(autoResumeToggle).not.toBeChecked();

    const confirmBtn = screen.getByRole('button', { name: /Confirmar cambio/i });
    await user.click(confirmBtn);

    expect(onNavigateThread).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('confirm_pending_auto_switch', {
        confirmationId: 'conf-1',
        selectedModelId: 'gemini-2.5-pro',
        autoResumeTurn: false,
      });
    });
  });

  it('supports dismissing autoSwitchConfirm and surfacing PROVIDER_BUSY residual process cleanup', async () => {
    const user = userEvent.setup();
    const busySnapshot = {
      records: [
        {
          id: 'autoswitch_conf-2',
          createdAtUnixMs: Date.now(),
          isRead: false,
          isWaitingForInput: true,
          resolution: null,
          target: { source: 'accountVault', id: 'agy' },
          kind: { kind: 'autoSwitchConfirm', requestKind: 'busy_terminals_ask' },
          title: 'Confirm switch to Work (1 busy terminal)',
          body: 'Switching from Personal to Work. 1 active terminal session may be interrupted.',
          confirmationId: 'conf-2',
          autoSwitchConfirm: {
            confirmationId: 'conf-2',
            provider: 'agy',
            fromAccountLabel: 'Personal',
            toAccountId: 'acc-2',
            toAccountLabel: 'Work',
            availableTargetModels: [],
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
            reason: 'busy_terminals_ask',
            createdAtUnixMs: Date.now() - 1000,
            expiresAtUnixMs: Date.now() + 900000,
          },
        },
      ],
      unreadCount: 1,
      openInputRequestCount: 1,
    };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(busySnapshot)
      .mockResolvedValueOnce({
        success: false,
        confirmationId: 'conf-2',
        code: 'PROVIDER_BUSY',
        error: 'Quedaron procesos residuales de Antigravity.',
        providerBusyKind: 'residual_only',
        canCloseProcesses: true,
        residualProcessCount: 2,
      })
      .mockResolvedValueOnce({
        success: true,
        dismissed: true,
        confirmationId: 'conf-2',
      })
      .mockResolvedValueOnce({
        records: [],
        unreadCount: 0,
        openInputRequestCount: 0,
      });

    render(<NotificationsView />);
    await screen.findByRole('button', { name: /Confirmar cambio/i });
    expect(screen.getByText(/1 terminal/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Confirmar cambio/i }));
    expect(await screen.findByText(/procesos residuales/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cerrar procesos Antigravity/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Descartar/i }));
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('dismiss_pending_auto_switch', {
        confirmationId: 'conf-2',
      });
    });
  });

  it('opens Settings -> Quotas when clicking a modelQuotaExhausted notification', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(settingsNav, 'openSettingsTab').mockImplementation(() => {});
    const onClose = vi.fn();
    const quotaSnap = {
      records: [
        {
          id: 'quota_antigravity:Gemini 4 Argon:2026-11-22T05:16:50Z',
          createdAtUnixMs: Date.now(),
          isRead: false,
          isWaitingForInput: false,
          target: { source: 'accountVault', id: 'antigravity' },
          kind: { kind: 'modelQuotaExhausted', requestKind: 'antigravity' },
          title: 'Cuota agotada: Gemini 4 Argon (Gemini 4 Argon Weekly Limit)',
          body: 'Antigravity llegó al 0% en «Gemini 4 Argon».',
        },
      ],
      unreadCount: 1,
      openInputRequestCount: 0,
    };

    vi.mocked(invokeCommand)
      .mockResolvedValueOnce(quotaSnap)
      .mockResolvedValueOnce({ ...quotaSnap, unreadCount: 0 });

    render(<NotificationsView onClose={onClose} />);
    const row = await screen.findByRole('button', { name: /Cuota agotada: Gemini 4 Argon/i });
    await user.click(row);

    expect(openSpy).toHaveBeenCalledWith('quotas', 'antigravity');
    expect(onClose).toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
