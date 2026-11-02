import { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { invokeCommand } from '../../../lib/ipc';
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

export function startParkedPolling(sessionId: string) {
  if (
    !sessionId ||
    getTerminalAppearancePrefs().renderer === 'canvas' ||
    parkedPollers.has(sessionId) ||
    activeMountedSessions.has(sessionId)
  ) {
    return;
  }

  const pollParked = async () => {
    if (
      getTerminalAppearancePrefs().renderer === 'canvas' ||
      activeMountedSessions.has(sessionId) ||
      !liveTerms.has(sessionId)
    ) {
      stopParkedPolling(sessionId);
      return;
    }

    let nextDelay = 200;
    try {
      const res: any = await invokeCommand('read_terminal_output', {
        sessionId,
        owner: 'user',
      });

      if (
        getTerminalAppearancePrefs().renderer === 'canvas' ||
        activeMountedSessions.has(sessionId) ||
        !liveTerms.has(sessionId)
      ) {
        stopParkedPolling(sessionId);
        return;
      }

      const live = liveTerms.get(sessionId);
      if (res?.kind === 'output' && res.bytesBase64) {
        nextDelay = 80;
        const bytes = base64ToUint8Array(res.bytesBase64);
        if (live?.term) {
          live.term.write(bytes);
        }
      } else if (res?.kind === 'exited') {
        markTerminalExited(sessionId);
        const code = res.status?.code ?? 0;
        if (live?.term) {
          live.term.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
        }
        stopParkedPolling(sessionId);
        return;
      } else {
        nextDelay = 400;
      }
    } catch {
      nextDelay = 600;
    }

    if (
      getTerminalAppearancePrefs().renderer !== 'canvas' &&
      !activeMountedSessions.has(sessionId) &&
      liveTerms.has(sessionId)
    ) {
      const timer = window.setTimeout(pollParked, nextDelay);
      parkedPollers.set(sessionId, timer);
    } else {
      stopParkedPolling(sessionId);
    }
  };

  const timer = window.setTimeout(pollParked, 50);
  parkedPollers.set(sessionId, timer);
}

export function stopParkedPolling(sessionId: string) {
  const timer = parkedPollers.get(sessionId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    parkedPollers.delete(sessionId);
  }
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
