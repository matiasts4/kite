import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AgentAutoPilot } from './AgentAutoPilot';

type EventHandler = (event: { payload: any }) => void;

const listeners = new Map<string, Set<EventHandler>>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, cb: EventHandler) => {
    let set = listeners.get(eventName);
    if (!set) {
      set = new Set();
      listeners.set(eventName, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }),
}));

const invokeMock = vi.fn();

vi.mock('../../../lib/ipc', () => ({
  invokeCommand: (...args: any[]) => invokeMock(...args),
  isTauriEnvironment: () => true,
}));

function emitTauriEvent(eventName: string, payload: any) {
  const set = listeners.get(eventName);
  if (!set) return;
  for (const cb of Array.from(set)) {
    cb({ payload });
  }
}

describe('AgentAutoPilot multi-turn continuation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures terminal output into transcript and drives prompt -> settled -> complete loop', async () => {
    const autopilotRequests: any[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'autopilot_next') {
        autopilotRequests.push(args.request);
        if (autopilotRequests.length === 1) {
          return { action: 'prompt', prompt: 'Run tests', reason: 'Turn 1' };
        }
        return { action: 'complete', reason: 'All tests passed' };
      }
      if (cmd === 'write_terminal') {
        return null;
      }
      if (cmd === 'read_terminal_transcript') {
        return { transcript: '' };
      }
      if (cmd === 'cancel_autopilot') {
        return null;
      }
      return null;
    });

    render(
      <AgentAutoPilot
        profile={{ id: 'agent-1', name: 'Builder', engine: 'claude' }}
        paneId="pane-1"
        sessionId="sess-1"
        phase="running"
      />
    );

    // Open menu and engage Complete mode
    fireEvent.click(screen.getByRole('button', { name: /auto/i }));
    await act(async () => {
      fireEvent.click(screen.getByText('Complete'));
      await Promise.resolve();
    });

    expect(autopilotRequests).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith('write_terminal', {
      sessionId: 'sess-1',
      data: 'Run tests\r',
    });

    // Stream terminal output for sess-1
    await act(async () => {
      emitTauriEvent('terminal-output', {
        sessionId: 'sess-1',
        paneId: 'pane-1',
        data: 'Running vitest...\nAll tests passed\n',
      });
    });

    // Advance past idle settle debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(autopilotRequests).toHaveLength(2);
    expect(autopilotRequests[1].turn.transcript).toContain('All tests passed');
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('handles wait re-check without rewriting prompt and advance to continue next turn', async () => {
    const autopilotRequests: any[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'autopilot_next') {
        autopilotRequests.push(args.request);
        if (autopilotRequests.length === 1) {
          return { action: 'prompt', prompt: 'Step 1', reason: 'Turn 1' };
        }
        if (autopilotRequests.length === 2) {
          return { action: 'wait', reason: 'Still compiling...' };
        }
        if (autopilotRequests.length === 3) {
          return { action: 'advance', prompt: 'Step 2', reason: 'Advancing' };
        }
        return { action: 'complete', reason: 'Finished' };
      }
      if (cmd === 'read_terminal_transcript') {
        return { transcript: 'Compiling crate...' };
      }
      return null;
    });

    render(
      <AgentAutoPilot
        profile={{ id: 'agent-1', name: 'Builder', engine: 'claude' }}
        paneId="pane-1"
        sessionId="sess-2"
        phase="running"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /auto/i }));
    await act(async () => {
      fireEvent.click(screen.getByText('Dream'));
      await Promise.resolve();
    });

    // Trigger activity and settle -> turn 2 returns "wait"
    await act(async () => {
      emitTauriEvent('terminal://activity', { sessionId: 'sess-2', seq: 1, exited: false });
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(autopilotRequests).toHaveLength(2);
    expect(autopilotRequests[1].turn.transcript).toContain('Compiling crate...');
    // Only 1 write_terminal so far (wait must NOT rewrite prompt)
    expect(invokeMock.mock.calls.filter(([c]) => c === 'write_terminal')).toHaveLength(1);

    // Advance past wait re-check timer -> turn 3 returns "advance" with Step 2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });

    expect(autopilotRequests).toHaveLength(3);
    expect(invokeMock).toHaveBeenCalledWith('write_terminal', {
      sessionId: 'sess-2',
      data: 'Step 2\r',
    });
  });

  it('cleans up timers and listeners on stop and unmount', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'autopilot_next') {
        return { action: 'prompt', prompt: 'Long task', reason: 'Turn 1' };
      }
      return null;
    });

    const { unmount } = render(
      <AgentAutoPilot
        profile={{ id: 'agent-1', name: 'Builder', engine: 'claude' }}
        paneId="pane-1"
        sessionId="sess-3"
        phase="running"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /auto/i }));
    await act(async () => {
      fireEvent.click(screen.getByText('Complete'));
      await Promise.resolve();
    });

    // Stop AutoPilot
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop auto/i }));
    });

    const countBefore = invokeMock.mock.calls.filter(([c]) => c === 'autopilot_next').length;
    await act(async () => {
      emitTauriEvent('terminal-output', { sessionId: 'sess-3', data: 'late output' });
      await vi.advanceTimersByTimeAsync(5000);
    });
    const countAfter = invokeMock.mock.calls.filter(([c]) => c === 'autopilot_next').length;
    expect(countAfter).toBe(countBefore);

    unmount();
  });
});
