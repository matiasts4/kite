import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TerminalView } from './TerminalView';
import { AccountSwitcherModal } from '../quota/AccountSwitcherModal';
import { invokeCommand, listSavedAccountsFull, switchAccountProfile } from '../../lib/ipc';
import { measureTerminalCanvasGrid } from './TerminalCanvasSurface';

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({ attachedToExisting: true }),
  isTauriEnvironment: () => false,
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
    TerminalCanvasSurface: ReactMod.forwardRef(function MockSurface(_props: any, _ref: any) {
      return ReactMod.createElement('div', { 'data-testid': 'mock-terminal-surface' });
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
});
