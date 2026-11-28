import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invokeCommandMock, suppressProactiveMock } = vi.hoisted(() => ({
  invokeCommandMock: vi.fn(async () => ({ ok: true })),
  suppressProactiveMock: vi.fn(),
}));

vi.mock('../ipc', () => ({
  invokeCommand: invokeCommandMock,
  isTauriEnvironment: () => true,
}));

vi.mock('../operator/proactiveWatcher', () => ({
  suppressProactiveAnnouncement: suppressProactiveMock,
}));

import {
  TERMINAL_NOTIFICATION_COOLDOWN_MS,
  startTerminalNotificationBridge,
  stopTerminalNotificationBridge,
  suppressTerminalNotification,
  peekPendingTerminalFocus,
  clearPendingTerminalFocus,
  resetTerminalNotificationBridgeForTests,
} from './terminalNotificationBridge';
import { markTerminalExited, registerSpawnedTerminal } from '../terminalRegistry';

function emitTerminalUpdate(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('kite:terminal-agent-update', { detail }));
}

describe('terminalNotificationBridge', () => {
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    invokeCommandMock.mockClear();
    suppressProactiveMock.mockClear();
    resetTerminalNotificationBridgeForTests();
    sessionStorage.clear();
  });

  afterEach(() => {
    stopTerminalNotificationBridge();
    resetTerminalNotificationBridgeForTests();
  });

  it('reports working -> done with characteristic actor name and triggers kite:notifications-refresh', async () => {
    const refreshSpy = vi.fn();
    window.addEventListener('kite:notifications-refresh', refreshSpy);
    startTerminalNotificationBridge({ now: () => clock });

    emitTerminalUpdate({
      sessionId: 'sess-orion',
      state: 'working',
      engine: 'codex',
      who: 'Orion · Codex',
      workspaceId: 'ws-kite',
    });
    emitTerminalUpdate({
      sessionId: 'sess-orion',
      state: 'done',
      engine: 'codex',
      who: 'Orion · Codex',
      workspaceId: 'ws-kite',
      latestLine: '\x1b[32m✔ Built and verified all packages\x1b[0m',
    });

    await Promise.resolve();

    expect(invokeCommandMock).toHaveBeenCalledTimes(1);
    expect(invokeCommandMock).toHaveBeenCalledWith('notifications_report_attention', {
      payload: {
        kind: 'settled',
        source: 'terminal',
        module: 'code',
        actorName: 'Orion · Codex',
        title: 'Orion · Codex',
        body: 'Built and verified all packages',
        sessionId: 'sess-orion',
        workspaceId: 'ws-kite',
      },
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Cooldown suppresses immediate repeat announcements
    clock += 1000;
    emitTerminalUpdate({ sessionId: 'sess-orion', state: 'working', engine: 'codex', who: 'Orion · Codex' });
    emitTerminalUpdate({ sessionId: 'sess-orion', state: 'done', engine: 'codex', who: 'Orion · Codex' });
    await Promise.resolve();
    expect(invokeCommandMock).toHaveBeenCalledTimes(1);

    // After cooldown expires, new completion notifies again
    clock += TERMINAL_NOTIFICATION_COOLDOWN_MS;
    emitTerminalUpdate({ sessionId: 'sess-orion', state: 'working', engine: 'codex', who: 'Orion · Codex' });
    emitTerminalUpdate({
      sessionId: 'sess-orion',
      state: 'done',
      engine: 'codex',
      who: 'Orion · Codex',
      latestLine: 'Completed follow-up patch',
    });
    await Promise.resolve();
    expect(invokeCommandMock).toHaveBeenCalledTimes(2);

    window.removeEventListener('kite:notifications-refresh', refreshSpy);
  });

  it('reports waitingForYou and error exits while ignoring plain shells and clean exits', async () => {
    startTerminalNotificationBridge({ now: () => clock });

    emitTerminalUpdate({ sessionId: 'sess-nova', state: 'working', engine: 'claude-code', who: 'Nova' });
    emitTerminalUpdate({
      sessionId: 'sess-nova',
      state: 'waitingForYou',
      engine: 'claude-code',
      who: 'Nova',
      latestLine: 'Apply migration? (y/n)',
    });

    emitTerminalUpdate({ sessionId: 'sess-err', state: 'working', engine: 'codex', who: 'Atlas' });
    emitTerminalUpdate({
      sessionId: 'sess-err',
      state: 'exited',
      engine: 'codex',
      who: 'Atlas',
      latestLine: 'Fatal error: build failed',
    });

    emitTerminalUpdate({ sessionId: 'sess-clean', state: 'working', engine: 'claude-code', who: 'Vega' });
    emitTerminalUpdate({
      sessionId: 'sess-clean',
      state: 'exited',
      engine: 'claude-code',
      who: 'Vega',
      latestLine: 'Session closed cleanly',
    });

    emitTerminalUpdate({ sessionId: 'sess-shell', state: 'working', engine: 'powershell', who: 'PowerShell' });
    emitTerminalUpdate({
      sessionId: 'sess-shell',
      state: 'done',
      engine: 'powershell',
      who: 'PowerShell',
      latestLine: 'Done',
    });

    await Promise.resolve();

    expect(invokeCommandMock).toHaveBeenCalledTimes(2);
    expect(invokeCommandMock).toHaveBeenNthCalledWith(1, 'notifications_report_attention', {
      payload: expect.objectContaining({
        kind: 'needs_input',
        source: 'terminal',
        module: 'code',
        actorName: 'Nova',
        body: 'Apply migration? (y/n)',
        sessionId: 'sess-nova',
      }),
    });
    expect(invokeCommandMock).toHaveBeenNthCalledWith(2, 'notifications_report_attention', {
      payload: expect.objectContaining({
        kind: 'error',
        source: 'terminal',
        module: 'code',
        actorName: 'Atlas',
        body: 'Fatal error: build failed',
        sessionId: 'sess-err',
      }),
    });
  });

  it('resolves identity from terminalRegistry and respects suppressTerminalNotification', async () => {
    registerSpawnedTerminal('sess-reg', {
      engine: 'grok',
      who: 'Lyra',
      title: 'Grok',
      workspaceId: 'ws-2',
    });

    startTerminalNotificationBridge({ now: () => clock });
    emitTerminalUpdate({ sessionId: 'sess-reg', state: 'working' });
    emitTerminalUpdate({ sessionId: 'sess-reg', state: 'done', latestLine: 'Refactored store' });
    await Promise.resolve();

    expect(invokeCommandMock).toHaveBeenCalledWith('notifications_report_attention', {
      payload: expect.objectContaining({
        actorName: 'Lyra',
        workspaceId: 'ws-2',
        sessionId: 'sess-reg',
      }),
    });

    invokeCommandMock.mockClear();
    emitTerminalUpdate({ sessionId: 'sess-suppressed', state: 'working', engine: 'codex', who: 'Falcon' });
    suppressTerminalNotification('sess-suppressed');
    expect(suppressProactiveMock).toHaveBeenCalledWith('sess-suppressed');

    emitTerminalUpdate({
      sessionId: 'sess-suppressed',
      state: 'exited',
      engine: 'codex',
      who: 'Falcon',
      latestLine: 'Fatal error: stopped',
    });
    await Promise.resolve();
    expect(invokeCommandMock).not.toHaveBeenCalled();

    markTerminalExited('sess-reg');
  });

  it('buffers pending terminal focus events for lazy CodeWorkspace mount and clears when consumed', () => {
    startTerminalNotificationBridge({ now: () => clock });
    expect(peekPendingTerminalFocus()).toBeNull();

    window.dispatchEvent(
      new CustomEvent('kite:focus-terminal-session', {
        detail: { sessionId: 'sess-lazy-1', workspaceId: 'ws-lazy' },
      })
    );

    const pending = peekPendingTerminalFocus();
    expect(pending).toEqual(
      expect.objectContaining({
        sessionId: 'sess-lazy-1',
        workspaceId: 'ws-lazy',
      })
    );

    clearPendingTerminalFocus('other-session');
    expect(peekPendingTerminalFocus()).not.toBeNull();

    clearPendingTerminalFocus('sess-lazy-1');
    expect(peekPendingTerminalFocus()).toBeNull();
  });
});
