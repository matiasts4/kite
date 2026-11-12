import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuidedLoginBanner } from './GuidedLoginBanner';
import { guidedLoginCoordinator, GUIDED_LOGIN_TIMEOUT_MS } from '../../lib/accounts/guidedLoginCoordinator';

const ipcMocks = vi.hoisted(() => ({
  startAccountLoginFlow: vi.fn(),
  cancelAccountLoginFlow: vi.fn(),
  probeLiveAccountLoginStatus: vi.fn(),
  saveCurrentAccountProfile: vi.fn(),
}));

const quotaMocks = vi.hoisted(() => ({
  fetchAll: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../lib/ipc', () => ipcMocks);
vi.mock('../../lib/quota/quotaManager', () => ({
  subscriptionQuotaManager: quotaMocks,
}));

describe('GuidedLoginBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guidedLoginCoordinator.reset();
    (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;
    ipcMocks.startAccountLoginFlow.mockResolvedValue({
      success: true,
      flowId: 'flow-banner-1',
      previousEmail: 'prev@example.com',
      previousEmailSaved: 'prev@example.com',
      engine: 'agy',
      loginArgv: ['C:\\Tools\\agy.exe', 'acp', '--login'],
      loginCommand: 'agy acp --login',
    });
    ipcMocks.probeLiveAccountLoginStatus.mockResolvedValue({
      provider: 'agy',
      authenticated: false,
      credentialStatus: 'missing_file',
      email: null,
      hasRefreshToken: false,
      sameAsPrevious: false,
    });
    ipcMocks.cancelAccountLoginFlow.mockResolvedValue({
      success: true,
      restored: true,
      restoredEmail: 'prev@example.com',
    });
  });

  afterEach(() => {
    guidedLoginCoordinator.reset();
    vi.useRealTimers();
  });

  it('renders nothing when idle and shows waiting status + Cancelar y restaurar during guided login', async () => {
    const user = userEvent.setup();
    const { container } = render(<GuidedLoginBanner />);
    expect(container).toBeEmptyDOMElement();

    await act(async () => {
      await guidedLoginCoordinator.start('antigravity');
    });

    expect(await screen.findByText(/Esperando inicio de sesión \(agy acp --login\)/i)).toBeInTheDocument();
    const cancelBtn = screen.getByRole('button', { name: /Cancelar y restaurar/i });
    await user.click(cancelBtn);

    expect(ipcMocks.cancelAccountLoginFlow).toHaveBeenCalledWith('antigravity', 'flow-banner-1');
    expect(await screen.findByText(/Se restauró tu sesión anterior \(prev@example\.com\)/i)).toBeInTheDocument();
  });

  it('shows 120s timeout message and cleans up interval on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<GuidedLoginBanner />);

    await act(async () => {
      await guidedLoginCoordinator.start('antigravity');
    });
    expect(screen.getByText(/Esperando inicio de sesión \(agy acp --login\)/i)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_TIMEOUT_MS);
    });
    expect(screen.getByText(/No se completó el inicio de sesión en 120s/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancelar y restaurar/i })).toBeInTheDocument();

    const probeCountAtUnmount = ipcMocks.probeLiveAccountLoginStatus.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ipcMocks.probeLiveAccountLoginStatus).toHaveBeenCalledTimes(probeCountAtUnmount);
  });
});
