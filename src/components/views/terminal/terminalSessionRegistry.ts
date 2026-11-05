import { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand, isTauriEnvironment } from '../../../lib/ipc';
import { delayUntilNextPull, shouldScheduleFollowUp } from './canvas/outputClock';
import { markTerminalExited } from '../../../lib/terminalRegistry';
import { disposeTerminalRefreshTracking } from '../../../lib/terminalSyncOutput';
import { getTerminalAppearancePrefs } from '../../../lib/terminalAppearancePrefs';

export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export type LiveTerminal = {
  term: Terminal;
  fit: FitAddon;
  cleanupDomBlockFill?: () => void;
};

export const liveTerms = new Map<string, LiveTerminal>();
export const restartedSessions = new Map<string, string>();
export const activeMountedSessions = new Set<string>();
export const parkedPollers = new Map<string, number>();

export function isAgentEngine(engine: string): boolean {
  return engine !== '' && engine !== 'powershell' && engine !== 'terminal';
}

export function terminalOwner(workspaceId: string | null | undefined, paneId: string, agentId: string) {
  if (workspaceId) {
    return { kind: 'workspace' as const, workspaceId, profile: { kind: 'default' as const } };
  }
  return { kind: 'agent' as const, agentId, paneId };
}

export function terminalParking(): HTMLElement {
  let node = document.getElementById('terminal-parking');
  if (!node) {
    node = document.createElement('div');
    node.id = 'terminal-parking';
    node.setAttribute('hidden', '');
    document.body.appendChild(node);
  }
  return node;
}

export function isLiveTerminalVisible(live: LiveTerminal): boolean {
  const el = live.term.element;
  if (!el || !el.isConnected) return false;
  if (el.closest('#terminal-parking')) return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  return true;
}

const parkedClocks = new Map<
  string,
  { inFlight: boolean; pending: boolean; lastPullAt: number; timer: number | null }
>();
let parkedListenStarted = false;

function parkedStillWanted(sessionId: string): boolean {
  return (
    getTerminalAppearancePrefs().renderer !== 'canvas' &&
    !activeMountedSessions.has(sessionId) &&
    liveTerms.has(sessionId)
  );
}

function ensureParkedActivityListener() {
  if (parkedListenStarted || !isTauriEnvironment()) return;
  parkedListenStarted = true;
  void listen<{ sessionId?: string; exited?: boolean; exitCode?: number | null }>(
    'terminal://activity',
    (event) => {
      const sessionId = event.payload.sessionId;
      if (!sessionId || !parkedPollers.has(sessionId)) return;
      if (event.payload.exited) {
        markTerminalExited(sessionId);
        const code = event.payload.exitCode ?? 0;
        liveTerms
          .get(sessionId)
          ?.term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
        stopParkedPolling(sessionId);
        return;
      }
      void pullParked(sessionId, false);
    }
  );
}

async function pullParked(sessionId: string, immediate: boolean) {
  if (!parkedStillWanted(sessionId)) {
    stopParkedPolling(sessionId);
    return;
  }
  const clock = parkedClocks.get(sessionId);
  if (!clock) return;
  const wait = delayUntilNextPull(clock.lastPullAt, performance.now(), immediate);
  if (wait > 0) {
    clock.pending = true;
    if (clock.timer === null) {
      clock.timer = window.setTimeout(() => {
        clock.timer = null;
        void pullParked(sessionId, false);
      }, wait);
    }
    return;
  }
  if (clock.inFlight) {
    clock.pending = true;
    return;
  }
  clock.inFlight = true;
  clock.pending = false;
  clock.lastPullAt = performance.now();
  try {
    const res: any = await invokeCommand('read_terminal_output', {
      sessionId,
      owner: 'user',
    });
    clock.inFlight = false;
    if (!parkedStillWanted(sessionId)) {
      stopParkedPolling(sessionId);
      return;
    }
    const live = liveTerms.get(sessionId);
    if (res?.kind === 'output' && res.bytesBase64) {
      live?.term.write(base64ToUint8Array(res.bytesBase64));
    } else if (res?.kind === 'exited') {
      markTerminalExited(sessionId);
      const code = res.status?.code ?? 0;
      live?.term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
      stopParkedPolling(sessionId);
      return;
    }
    if (shouldScheduleFollowUp(clock.pending)) {
      void pullParked(sessionId, false);
    }
  } catch {
    clock.inFlight = false;
    if (parkedStillWanted(sessionId) && shouldScheduleFollowUp(clock.pending)) {
      void pullParked(sessionId, false);
    }
  }
}

export function startParkedPolling(sessionId: string) {
  if (
    !sessionId ||
    getTerminalAppearancePrefs().renderer === 'canvas' ||
    parkedPollers.has(sessionId) ||
    activeMountedSessions.has(sessionId)
  ) {
    return;
  }

  parkedPollers.set(sessionId, 0);
  parkedClocks.set(sessionId, { inFlight: false, pending: false, lastPullAt: 0, timer: null });
  ensureParkedActivityListener();
  void pullParked(sessionId, true);
}

export function stopParkedPolling(sessionId: string) {
  const clock = parkedClocks.get(sessionId);
  if (clock?.timer !== null && clock?.timer !== undefined) {
    window.clearTimeout(clock.timer);
  }
  parkedClocks.delete(sessionId);
  parkedPollers.delete(sessionId);
}

export function syncParkedPollers() {
  if (getTerminalAppearancePrefs().renderer === 'canvas') {
    for (const sessionId of Array.from(parkedPollers.keys())) {
      stopParkedPolling(sessionId);
    }
    return;
  }
  for (const sessionId of liveTerms.keys()) {
    if (!activeMountedSessions.has(sessionId)) {
      startParkedPolling(sessionId);
    } else {
      stopParkedPolling(sessionId);
    }
  }
}

/** Kill the PTY and drop the screen. Only an explicit close or Restart should call this. */
export function releaseTerminal(sessionId: string) {
  markTerminalExited(sessionId);
  const ids = new Set([sessionId, restartedSessions.get(sessionId) ?? sessionId]);
  for (const id of ids) {
    markTerminalExited(id);
    stopParkedPolling(id);
    activeMountedSessions.delete(id);
    const live = liveTerms.get(id);
    if (live) {
      disposeTerminalRefreshTracking(live.term);
      live.cleanupDomBlockFill?.();
      live.term.dispose();
      liveTerms.delete(id);
    }
    if (!id) continue;
    void invokeCommand('terminate_terminal', {
      sessionId: id,
      owner: 'user',
    }).catch(() => {});
  }
  restartedSessions.delete(sessionId);
}
