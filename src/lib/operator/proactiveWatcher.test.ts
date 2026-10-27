import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invokeCommandMock } = vi.hoisted(() => ({
  invokeCommandMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../ipc', () => ({
  invokeCommand: invokeCommandMock,
  isTauriEnvironment: () => true,
}));

import {
  PROACTIVE_COOLDOWN_MS,
  resetProactiveWatcherForTests,
  startProactiveAgentWatcher,
  stopProactiveAgentWatcher,
  suppressProactiveAnnouncement,
} from './proactiveWatcher';
import { markTerminalExited, registerSpawnedTerminal } from '../terminalRegistry';

function emitTerminalUpdate(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('kite:terminal-agent-update', { detail }));
}

let clock = 0;
let speak: ReturnType<typeof vi.fn>;

function startWatcher() {
  return startProactiveAgentWatcher({ speak, now: () => clock });
}

beforeEach(() => {
  clock = 1_000_000;
  speak = vi.fn();
  invokeCommandMock.mockClear();
  resetProactiveWatcherForTests();
  sessionStorage.clear();
});

afterEach(() => {
  stopProactiveAgentWatcher();
  resetProactiveWatcherForTests();
});

describe('proactiveWatcher — agent completion voice & notifications', () => {
  it('speaks a Spanish completion summary and reports attention exactly once for working -> done', () => {
    startWatcher();

    emitTerminalUpdate({
      sessionId: 'sess-orion',
      state: 'working',
      engine: 'antigravity',
      who: 'Orion',
      latestLine: 'Analyzing repository structure',
    });
    emitTerminalUpdate({
      sessionId: 'sess-orion',
      state: 'done',
      engine: 'antigravity',
      who: 'Orion',
      latestLine: '\x1b[32m✔ Compilé los cambios sin errores\x1b[0m',
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      'El agente Orion terminó en la terminal: Compilé los cambios sin errores.'
    );

    expect(invokeCommandMock).toHaveBeenCalledTimes(1);
    expect(invokeCommandMock).toHaveBeenCalledWith('notifications_report_attention', {
      payload: {
        kind: 'settled',
        title: 'Orion terminó',
        body: 'Compilé los cambios sin errores',
        sessionId: 'sess-orion',
      },
    });

    // Repeated done announcements inside the cooldown window stay silent.
    clock += 500;
    emitTerminalUpdate({ sessionId: 'sess-orion', state: 'working', engine: 'antigravity', who: 'Orion' });
    emitTerminalUpdate({
      sessionId: 'sess-orion',
      state: 'done',
      engine: 'antigravity',
      who: 'Orion',
      latestLine: 'Compilé los cambios sin errores',
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(invokeCommandMock).toHaveBeenCalledTimes(1);

    // Once the cooldown expires a genuinely new completion is announced again.
    clock += PROACTIVE_COOLDOWN_MS;
    emitTerminalUpdate({ sessionId: 'sess-orion', state: 'working', engine: 'antigravity', who: 'Orion' });
    emitTerminalUpdate({
      sessionId: 'sess-orion',
      state: 'done',
      engine: 'antigravity',
      who: 'Orion',
      latestLine: 'Actualicé las pruebas',
    });

    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenLastCalledWith(
      'El agente Orion terminó en la terminal: Actualicé las pruebas.'
    );
    expect(invokeCommandMock).toHaveBeenCalledTimes(2);
  });

  it('speaks a confirmation request and reports needs_input for working -> waitingForYou', () => {
    startWatcher();

    emitTerminalUpdate({ sessionId: 'sess-nova', state: 'working', engine: 'claude', who: 'Nova' });
    emitTerminalUpdate({
      sessionId: 'sess-nova',
      state: 'waitingForYou',
      engine: 'claude',
      who: 'Nova',
      latestLine: 'Do you want to continue? (y/n)',
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('El agente Nova necesita tu confirmación.');
    expect(invokeCommandMock).toHaveBeenCalledTimes(1);
    expect(invokeCommandMock).toHaveBeenCalledWith('notifications_report_attention', {
      payload: {
        kind: 'needs_input',
        title: 'Nova necesita tu confirmación',
        body: 'Do you want to continue? (y/n)',
        sessionId: 'sess-nova',
      },
    });
  });

  it('speaks an error only when a terminal stops after a failing run', () => {
    startWatcher();

    emitTerminalUpdate({ sessionId: 'sess-atlas', state: 'working', engine: 'codex', who: 'Atlas' });
    emitTerminalUpdate({
      sessionId: 'sess-atlas',
      state: 'exited',
      engine: 'codex',
      who: 'Atlas',
      latestLine: 'Error: cannot find module "vite"',
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('La terminal de Atlas se detuvo con un error.');
    expect(invokeCommandMock).toHaveBeenCalledWith('notifications_report_attention', {
      payload: expect.objectContaining({
        kind: 'error',
        title: 'Atlas se detuvo con un error',
        body: 'Error: cannot find module "vite"',
        sessionId: 'sess-atlas',
      }),
    });

    // A clean exit without an error line is not an alert.
    emitTerminalUpdate({ sessionId: 'sess-vega', state: 'working', engine: 'claude', who: 'Vega' });
    emitTerminalUpdate({
      sessionId: 'sess-vega',
      state: 'exited',
      engine: 'claude',
      who: 'Vega',
      latestLine: 'Session closed by the user',
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(invokeCommandMock).toHaveBeenCalledTimes(1);
  });

  it('ignores plain shell sessions (powershell/terminal) by default', () => {
    startWatcher();

    emitTerminalUpdate({ sessionId: 'sess-shell', state: 'working', engine: 'powershell', who: 'PowerShell' });
    emitTerminalUpdate({
      sessionId: 'sess-shell',
      state: 'done',
      engine: 'powershell',
      who: 'PowerShell',
      latestLine: 'npm run build finished',
    });

    emitTerminalUpdate({ sessionId: 'sess-cmd', state: 'working', engine: 'terminal', who: 'Terminal' });
    emitTerminalUpdate({
      sessionId: 'sess-cmd',
      state: 'done',
      engine: 'terminal',
      who: 'Terminal',
      latestLine: 'git status',
    });

    expect(speak).not.toHaveBeenCalled();
    expect(invokeCommandMock).not.toHaveBeenCalled();
  });

  it('announces plain shell sessions only when explicitly configured', () => {
    startProactiveAgentWatcher({ speak, now: () => clock, includeShellSessions: true });

    emitTerminalUpdate({ sessionId: 'sess-shell-on', state: 'working', engine: 'powershell', who: 'Build shell' });
    emitTerminalUpdate({
      sessionId: 'sess-shell-on',
      state: 'done',
      engine: 'powershell',
      who: 'Build shell',
      latestLine: 'Build finished',
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      'El agente Build shell terminó en la terminal: Build finished.'
    );
  });

  it('stays silent when a session is intentionally closed via suppressProactiveAnnouncement', () => {
    startWatcher();

    emitTerminalUpdate({ sessionId: 'sess-falcon', state: 'working', engine: 'grok', who: 'Falcon' });
    suppressProactiveAnnouncement('sess-falcon');
    emitTerminalUpdate({
      sessionId: 'sess-falcon',
      state: 'exited',
      engine: 'grok',
      who: 'Falcon',
      latestLine: 'Fatal error: process aborted',
    });

    expect(speak).not.toHaveBeenCalled();
    expect(invokeCommandMock).not.toHaveBeenCalled();
  });

  it('resolves the agent identity from the terminal registry when the update is sparse', () => {
    registerSpawnedTerminal('sess-registry', {
      engine: 'grok',
      who: 'Lyra',
      title: 'Grok',
    });

    startWatcher();

    emitTerminalUpdate({ sessionId: 'sess-registry', state: 'working' });
    emitTerminalUpdate({ sessionId: 'sess-registry', state: 'done', latestLine: 'Terminé la migración' });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('El agente Lyra terminó en la terminal: Terminé la migración.');

    markTerminalExited('sess-registry');
  });

  it('detaches from terminal updates when stopped', () => {
    const stop = startWatcher();
    stop();

    emitTerminalUpdate({ sessionId: 'sess-echo', state: 'working', engine: 'grok', who: 'Echo' });
    emitTerminalUpdate({
      sessionId: 'sess-echo',
      state: 'done',
      engine: 'grok',
      who: 'Echo',
      latestLine: 'Listo',
    });

    expect(speak).not.toHaveBeenCalled();
    expect(invokeCommandMock).not.toHaveBeenCalled();
  });
});
