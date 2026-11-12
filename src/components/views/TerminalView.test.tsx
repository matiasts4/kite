import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { TerminalView } from './TerminalView';
import { AccountSwitcherModal } from '../quota/AccountSwitcherModal';
import { invokeCommand, isTauriEnvironment, listSavedAccountsFull, switchAccountProfile } from '../../lib/ipc';
import { measureTerminalCanvasGrid } from './TerminalCanvasSurface';
import { useTerminalSnapshotPoller } from './terminal/canvas/useTerminalSnapshotPoller';

const { tauriListeners, mockListen } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: { payload: any }) => void>>();
  const listenFn = vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
    const arr = listeners.get(eventName) ?? [];
    arr.push(handler);
    listeners.set(eventName, arr);
    return () => {
      const next = (listeners.get(eventName) ?? []).filter((h) => h !== handler);
      listeners.set(eventName, next);
    };
  });
  return { tauriListeners: listeners, mockListen: listenFn };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({ attachedToExisting: true }),
  isTauriEnvironment: vi.fn(() => false),
  switchAccountProfile: vi.fn().mockResolvedValue({
    success: true,
    profile: { id: 'acc-2', provider: 'antigravity', label: 'Google Work', isActive: true },
    terminalsRestarted: 1,
    targetedSessionIds: ['sid-agy'],
    skippedUnaffectedCount: 4,
  }),
  listSavedAccountsFull: vi.fn().mockResolvedValue({
    profiles: [
      { id: 'acc-1', provider: 'antigravity', label: 'Google Personal', email: 'personal@gmail.com', isActive: true, lastUsedUnixMs: 1, primaryRemainingPercent: 80, primaryResetAt: null, timeUntilResetMs: null },
      { id: 'acc-2', provider: 'antigravity', label: 'Google Work', email: 'work@company.com', isActive: false, lastUsedUnixMs: 1, primaryRemainingPercent: 95, primaryResetAt: null, timeUntilResetMs: null },
    ],
    unregisteredLiveSession: null,
  }),
  saveCurrentAccountProfile: vi.fn(),
  deleteAccountProfile: vi.fn(),
  prepareNewAccountLogin: vi.fn(),
}));

vi.mock('../../lib/terminalHostSize', () => ({
  waitForStableHost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./TerminalCanvasSurface', async () => {
  const ReactMod = await import('react');
  return {
    TerminalCanvasSurface: ReactMod.forwardRef(function MockSurface(props: any, _ref: any) {
      return ReactMod.createElement('div', {
        'data-testid': `mock-surface-${props.sessionId}`,
        onDoubleClick: () => props.onProcessExit?.(0),
      });
    }),
    measureTerminalCanvasGrid: vi.fn(() => ({
      cols: 120,
      rows: 36,
      cellW: 8,
      cellH: 18,
      baselineOffset: 14,
    })),
  };
});

describe('TerminalView provider-scoped command bus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriListeners.clear();
    vi.mocked(isTauriEnvironment).mockReturnValue(false);
    (invokeCommand as any).mockResolvedValue({ attachedToExisting: true });
    vi.mocked(measureTerminalCanvasGrid).mockReturnValue({
      cols: 120,
      rows: 36,
      cellW: 8,
      cellH: 18,
      baselineOffset: 14,
    });
  });

  it('ignores unscoped restart-agent broadcasts and never restarts non-Antigravity terminals on Antigravity switch', async () => {
    render(
      <>
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-agy" sessionId="sid-agy" initialEngine="agy" />
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-claude" sessionId="sid-claude" initialEngine="claude-code" />
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-codex" sessionId="sid-codex" initialEngine="codex" />
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-ps" sessionId="sid-ps" initialEngine="powershell" />
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-gem" sessionId="sid-gem" initialEngine="gemini" />
      </>
    );

    await waitFor(() => {
      const attachCalls = vi.mocked(invokeCommand).mock.calls.filter(([cmd]) => cmd === 'attach_terminal');
      expect(attachCalls.length).toBe(5);
    });

    vi.mocked(invokeCommand).mockClear();

    // 1. Unscoped restart-agent broadcast MUST NOT trigger attach/start on ANY terminal
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kite:terminal-command', {
          detail: { command: 'restart-agent' },
        })
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(
      vi.mocked(invokeCommand).mock.calls.filter(
        ([cmd]) => cmd === 'attach_terminal' || cmd === 'start_terminal'
      )
    ).toHaveLength(0);

    // 2. Provider-scoped restart-agent for antigravity MUST ONLY touch sid-agy and preserve real cols/rows
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('kite:terminal-command', {
          detail: { command: 'restart-agent', targetProviders: ['antigravity'] },
        })
      );
    });

    await waitFor(() => {
      const calls = vi.mocked(invokeCommand).mock.calls.filter(([cmd]) => cmd === 'attach_terminal');
      expect(calls).toHaveLength(1);
    });

    const attachCallsAfter = vi
      .mocked(invokeCommand)
      .mock.calls.filter(([cmd]) => cmd === 'attach_terminal');
    expect(attachCallsAfter[0][1]).toMatchObject({
      sessionId: 'sid-agy',
      columns: 120,
      rows: 36,
    });
    const touchedIds = attachCallsAfter.map(([, args]: any) => args.sessionId);
    expect(touchedIds).not.toContain('sid-claude');
    expect(touchedIds).not.toContain('sid-codex');
    expect(touchedIds).not.toContain('sid-ps');
    expect(touchedIds).not.toContain('sid-gem');
  });

  it('switching Antigravity in AccountSwitcherModal emits zero global restart-agent events and leaves non-Antigravity terminals untouched', async () => {
    const cmdEvents: any[] = [];
    const listener = (e: Event) => cmdEvents.push((e as CustomEvent).detail);
    window.addEventListener('kite:terminal-command', listener);

    render(
      <>
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-claude" sessionId="sid-claude" initialEngine="claude-code" />
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-codex" sessionId="sid-codex" initialEngine="codex" />
        <AccountSwitcherModal
          provider="antigravity"
          providerLabel="Antigravity"
          isOpen={true}
          onClose={vi.fn()}
        />
      </>
    );

    await waitFor(() => {
      expect(vi.mocked(listSavedAccountsFull)).toHaveBeenCalled();
    });
    const activateBtn = await screen.findByRole('button', { name: /activar/i });
    vi.mocked(invokeCommand).mockClear();

    fireEvent.click(activateBtn);

    await waitFor(() => {
      expect(vi.mocked(switchAccountProfile)).toHaveBeenCalledWith('antigravity', 'acc-2');
    });

    window.removeEventListener('kite:terminal-command', listener);
    expect(cmdEvents.filter((d) => d?.command === 'restart-agent')).toHaveLength(0);
    expect(
      vi.mocked(invokeCommand).mock.calls.filter(
        ([cmd]) => cmd === 'attach_terminal' || cmd === 'start_terminal'
      )
    ).toHaveLength(0);
  });

  it('clears exit banner without restarting when terminal://account-rotated arrives for that session', async () => {
    vi.mocked(isTauriEnvironment).mockReturnValue(true);

    render(
      <>
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-agy" sessionId="sid-agy" initialEngine="agy" />
        <TerminalView chrome="pane" workspaceId="ws-1" paneId="p-codex" sessionId="sid-codex" initialEngine="codex" />
      </>
    );

    await waitFor(() => {
      const rotationListeners = tauriListeners.get('terminal://account-rotated') ?? [];
      expect(rotationListeners.length).toBeGreaterThanOrEqual(2);
    });

    // Simulate process exit bar appearing on sid-agy
    fireEvent.doubleClick(screen.getByTestId('mock-surface-sid-agy'));
    expect(await screen.findByText(/Process exited with code 0/i)).toBeTruthy();

    vi.mocked(invokeCommand).mockClear();

    // Emitting rotation for sid-codex must NOT clear sid-agy exit bar
    await act(async () => {
      for (const listener of tauriListeners.get('terminal://account-rotated') ?? []) {
        listener({
          payload: {
            sessionId: 'sid-codex',
            provider: 'antigravity',
            accountLabel: 'Google Work',
            email: 'work@company.com',
          },
        });
      }
    });
    expect(screen.queryByText(/Process exited with code 0/i)).toBeTruthy();

    // Emitting rotation for sid-agy clears exit banner and restores running without calling attach/start
    await act(async () => {
      for (const listener of tauriListeners.get('terminal://account-rotated') ?? []) {
        listener({
          payload: {
            sessionId: 'sid-agy',
            provider: 'antigravity',
            accountLabel: 'Google Work',
            email: 'work@company.com',
          },
        });
      }
    });

    await waitFor(() => {
      expect(screen.queryByText(/Process exited with code 0/i)).toBeNull();
    });
    expect(
      vi.mocked(invokeCommand).mock.calls.filter(
        ([cmd]) => cmd === 'attach_terminal' || cmd === 'start_terminal'
      )
    ).toHaveLength(0);
  });

  it('useTerminalSnapshotPoller resets exit state, seq, and polls immediately on terminal://account-rotated', async () => {
    vi.mocked(isTauriEnvironment).mockReturnValue(true);
    (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 42 });

    const matrixRef = { current: [] as any[][] };
    const cursorRef = { current: { row: 0, col: 0, visible: true } as any };
    const boolRef = () => ({ current: false });
    const numRef = (v: number) => ({ current: v });
    const lastSeqRef = { current: 42 };
    const hasNotifiedExitRef = { current: false };
    const onProcessExit = vi.fn();

    renderHook(() =>
      useTerminalSnapshotPoller({
        sessionId: 'sid-agy-poll',
        matrixRef,
        cursorRef,
        alternateScreenRef: boolRef(),
        applicationCursorRef: boolRef(),
        bracketedPasteRef: boolRef(),
        mouseModeRef: { current: 'none' as any },
        sgrMouseRef: boolRef(),
        sgrPixelsMouseRef: boolRef(),
        focusReportingRef: boolRef(),
        win32InputModeRef: boolRef(),
        kittyKeyboardFlagsRef: numRef(0),
        scrollbackOffsetRef: numRef(0),
        appliedPtyColsRef: numRef(120),
        appliedPtyRowsRef: numRef(36),
        isFocusedRef: { current: true },
        lastSeqRef,
        hasNotifiedExitRef,
        onProcessExit,
        scheduleRender: vi.fn(),
        preferBinarySnapshot: false,
      })
    );

    await waitFor(() => {
      expect((tauriListeners.get('terminal://activity') ?? []).length).toBe(1);
      expect((tauriListeners.get('terminal://account-rotated') ?? []).length).toBe(1);
    });

    // Simulate exited event -> marks hasNotifiedExitRef = true
    await act(async () => {
      for (const listener of tauriListeners.get('terminal://activity') ?? []) {
        listener({ payload: { sessionId: 'sid-agy-poll', exited: true, exitCode: 0 } });
      }
    });
    expect(hasNotifiedExitRef.current).toBe(true);
    expect(onProcessExit).toHaveBeenCalledTimes(1);

    vi.mocked(invokeCommand).mockClear();

    // Planned rotation event resets exit flag & seq and forces snapshot pull
    await act(async () => {
      for (const listener of tauriListeners.get('terminal://account-rotated') ?? []) {
        listener({
          payload: {
            sessionId: 'sid-agy-poll',
            provider: 'antigravity',
            accountLabel: 'Google Work',
            email: 'work@company.com',
          },
        });
      }
    });

    expect(hasNotifiedExitRef.current).toBe(false);
    expect(lastSeqRef.current).toBe(0);
    await waitFor(() => {
      expect(
        vi.mocked(invokeCommand).mock.calls.filter(([cmd]) => cmd === 'poll_terminal_snapshot').length
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
