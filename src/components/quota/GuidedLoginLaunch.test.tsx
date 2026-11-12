import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useRef, useState } from 'react';
import { useWorkspaceEventListeners } from '../code/useWorkspaceEventListeners';
import { AccountVault } from '../views/settings/AccountVault';
import { AccountSwitcherModal } from './AccountSwitcherModal';
import { guidedLoginCoordinator, GUIDED_LOGIN_POLL_MS } from '../../lib/accounts/guidedLoginCoordinator';

const ipcMocks = vi.hoisted(() => ({
  invokeCommand: vi.fn().mockResolvedValue(undefined),
  listSavedAccountsFull: vi.fn().mockResolvedValue({
    profiles: [
      {
        id: 'acc-1',
        provider: 'agy',
        label: 'Personal Pro',
        email: 'prev@example.com',
        isActive: true,
        lastUsedUnixMs: 1000,
      },
    ],
    unregisteredLiveSession: null,
  }),
  saveCurrentAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  switchAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  deleteAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  startAccountLoginFlow: vi.fn().mockResolvedValue({
    success: true,
    flowId: 'flow-vault-1',
    previousEmail: 'prev@example.com',
    previousEmailSaved: 'prev@example.com',
    engine: 'agy',
    loginArgv: ['C:\\Tools\\agy.exe', 'acp', '--login'],
    loginCommand: 'agy acp --login',
  }),
  cancelAccountLoginFlow: vi.fn().mockResolvedValue({ success: true, restored: true, restoredEmail: 'prev@example.com' }),
  probeLiveAccountLoginStatus: vi.fn().mockResolvedValue({
    provider: 'agy',
    authenticated: false,
    credentialStatus: 'missing_file',
    email: null,
    hasRefreshToken: false,
    sameAsPrevious: false,
  }),
}));

vi.mock('../../lib/ipc', () => ipcMocks);
vi.mock('../../lib/quota/quotaManager', () => ({
  subscriptionQuotaManager: { fetchAll: vi.fn().mockResolvedValue({}) },
}));

const WorkspaceListenerHarness: React.FC = () => {
  const latestLayoutRef = useRef({
    tabs: [
      {
        id: 'tab-1',
        title: 'Main',
        root: {
          id: 'leaf-1',
          type: 'leaf' as const,
          occupant: { kind: 'terminal' as const, sessionId: 'existing-shell' },
        },
      },
    ],
    activeTabId: 'tab-1',
  });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const spotlightRef = useRef<unknown>(null);
  const [, setFocused] = useState<string | null>('leaf-1');

  useWorkspaceEventListeners({
    selectedWorkspace: { id: 'ws-1', name: 'Kite', path: 'C:\\repo', createdAt: 0 } as any,
    latestLayoutRef: latestLayoutRef as any,
    persistLayout: vi.fn().mockResolvedValue(undefined),
    canvasRef,
    onSelectWorkspace: vi.fn(),
    focusedLeafId: 'leaf-1',
    setFocusedLeafId: setFocused,
    setSpotlightLeafId: vi.fn(),
    spotlightTimerRef: spotlightRef,
    paneMenuOpenLeafId: null,
    setPaneMenuOpenLeafId: vi.fn(),
    setPaneMenuKind: vi.fn(),
    headerMenuOpen: false,
    setHeaderMenuOpen: vi.fn(),
    renamingLeafId: null,
    setRenamingLeafId: vi.fn(),
    handleCloseLeaf: vi.fn(),
    handleCloseTab: vi.fn(),
    handleEqualize: vi.fn(),
    handleSplitLeaf: vi.fn(),
    handleToggleFullscreen: vi.fn(),
    fullscreenLeafId: null,
    handleLaunchTerminal: vi.fn(),
    handleLaunchAgent: vi.fn(),
  });

  return <div ref={canvasRef} style={{ width: 900, height: 600 }} />;
};

describe('Guided login workspace argv & AccountVault integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guidedLoginCoordinator.reset();
    (window as unknown as { __kiteCodeWorkspaceMounted?: boolean }).__kiteCodeWorkspaceMounted = true;
  });

  afterEach(() => {
    guidedLoginCoordinator.reset();
    vi.useRealTimers();
  });

  it('forwards optional argv from kite:spawn-agent-terminal to start_terminal', async () => {
    render(<WorkspaceListenerHarness />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kite:spawn-agent-terminal', {
          detail: {
            sessionId: 'login-sess-1',
            engine: 'agy',
            argv: ['C:\\Tools\\agy.exe', 'acp', '--login'],
            autoApprove: false,
          },
        })
      );
    });

    await waitFor(() => {
      expect(ipcMocks.invokeCommand).toHaveBeenCalledWith(
        'start_terminal',
        expect.objectContaining({
          sessionId: 'login-sess-1',
          engine: 'agy',
          argv: ['C:\\Tools\\agy.exe', 'acp', '--login'],
          autoApprove: false,
        })
      );
    });
  });

  it('launches guided login from AccountVault without emitting dead launch-cli command', async () => {
    const user = userEvent.setup();
    const legacyCmds: unknown[] = [];
    const spawns: unknown[] = [];
    const onLegacy = (e: Event) => legacyCmds.push((e as CustomEvent).detail);
    const onSpawn = (e: Event) => spawns.push((e as CustomEvent).detail);
    window.addEventListener('kite:terminal-command', onLegacy);
    window.addEventListener('kite:spawn-agent-terminal', onSpawn);

    const { unmount } = render(<AccountVault />);
    await screen.findByText('Personal Pro');

    const btn = screen.getByRole('button', { name: /\+ Conectar nueva cuenta/i });
    await user.click(btn);

    expect(ipcMocks.startAccountLoginFlow).toHaveBeenCalledWith('antigravity', { force: undefined });
    expect(legacyCmds).toHaveLength(0);
    expect(spawns).toHaveLength(1);
    expect((spawns[0] as any).argv).toEqual(['C:\\Tools\\agy.exe', 'acp', '--login']);

    unmount();
    window.removeEventListener('kite:terminal-command', onLegacy);
    window.removeEventListener('kite:spawn-agent-terminal', onSpawn);
  });

  it('stops coordinator polling immediately when AccountSwitcherModal closes without banner mounted', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <AccountSwitcherModal
        provider="antigravity"
        providerLabel="Antigravity"
        isOpen={true}
        onClose={vi.fn()}
      />
    );

    await act(async () => {
      await guidedLoginCoordinator.start('antigravity');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS);
    });
    expect(ipcMocks.probeLiveAccountLoginStatus).toHaveBeenCalledTimes(1);

    rerender(
      <AccountSwitcherModal
        provider="antigravity"
        providerLabel="Antigravity"
        isOpen={false}
        onClose={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GUIDED_LOGIN_POLL_MS * 4);
    });
    expect(ipcMocks.probeLiveAccountLoginStatus).toHaveBeenCalledTimes(1);
  });
});
