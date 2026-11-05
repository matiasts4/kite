import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { TerminalCanvasSurface } from './TerminalCanvasSurface';
import { invokeCommand } from '../../lib/ipc';
import { getActiveAgentTerminals, markTerminalExited } from '../../lib/terminalRegistry';

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
  isTauriEnvironment: () => false,
}));

/** Snapshot shaped like what a mouse-tracking alt-screen TUI agent produces. */
function agentSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'snapshot',
    snapshot: {
      seq: 1,
      cols: 80,
      rows: 24,
      alternateScreen: true,
      applicationCursor: false,
      bracketedPaste: true,
      mouseMode: 'any',
      sgrMouse: true,
      focusReporting: true,
      win32InputMode: true,
      kittyKeyboardFlags: 1,
      cursor: { visible: true, col: 0, row: 0, shape: 'bar' },
      dirtyRows: [],
      full: true,
      ...overrides,
    },
  };
}

function writes(): string[] {
  return (invokeCommand as any).mock.calls
    .filter((c: unknown[]) => c[0] === 'write_terminal')
    .map((c: any[]) => c[1].input as string);
}

describe('TerminalCanvasSurface with a mouse-tracking alt-screen agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (invokeCommand as any).mockImplementation((cmd: string) => {
      if (cmd === 'poll_terminal_snapshot') return Promise.resolve(agentSnapshot());
      return Promise.resolve(null);
    });
  });

  async function mountAndSettle() {
    const utils = render(<TerminalCanvasSurface sessionId="agent-1" />);
    const textarea = utils.container.querySelector('textarea')!;
    const canvas = utils.container.querySelector('canvas')!;
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('poll_terminal_snapshot', expect.any(Object));
    });
    // Let the first snapshot be applied.
    await new Promise((r) => setTimeout(r, 30));
    return { ...utils, textarea, canvas };
  }

  it('forwards typed characters to the PTY', async () => {
    const { textarea } = await mountAndSettle();
    fireEvent.keyDown(textarea, { key: 'h' });
    fireEvent.input(textarea, { target: { value: 'h' } });
    expect(writes()).toContain('h');
  });

  it('focuses the hidden input when the canvas is clicked', async () => {
    const { textarea, canvas } = await mountAndSettle();
    fireEvent.mouseDown(canvas, { button: 0, clientX: 20, clientY: 20 });
    expect(document.activeElement).toBe(textarea);
  });

  it('reports wheel events as SGR mouse wheel when the TUI tracks the mouse', async () => {
    const { canvas } = await mountAndSettle();
    fireEvent.wheel(canvas, { deltaY: 100, deltaMode: 0, clientX: 20, clientY: 20 });
    await waitFor(() => {
      expect(writes().join('')).toMatch(/\x1b\[<65;\d+;\d+M/);
    });
  });

  it('reports clicks as SGR mouse press/release when the TUI tracks the mouse', async () => {
    const { canvas } = await mountAndSettle();
    fireEvent.mouseDown(canvas, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseUp(canvas, { button: 0, clientX: 20, clientY: 20 });
    const out = writes().join('');
    expect(out).toMatch(/\x1b\[<0;\d+;\d+M/);
    expect(out).toMatch(/\x1b\[<0;\d+;\d+m/);
  });
});

describe('TerminalCanvasSurface scroll routing', () => {
  function mockSnapshot(overrides: Record<string, unknown>) {
    (invokeCommand as any).mockImplementation((cmd: string) => {
      if (cmd === 'poll_terminal_snapshot') return Promise.resolve(agentSnapshot(overrides));
      if (cmd === 'scroll_terminal_viewport') return Promise.resolve(null);
      return Promise.resolve(null);
    });
  }

  async function mount() {
    const utils = render(<TerminalCanvasSurface sessionId="agent-2" />);
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('poll_terminal_snapshot', expect.any(Object));
    });
    await new Promise((r) => setTimeout(r, 30));
    return { ...utils, canvas: utils.container.querySelector('canvas')! };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls the Rust viewport on the primary screen without mouse tracking', async () => {
    mockSnapshot({ alternateScreen: false, mouseMode: 'none' });
    const { canvas } = await mount();
    fireEvent.wheel(canvas, { deltaY: -100, deltaMode: 0 });
    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith(
        'scroll_terminal_viewport',
        expect.objectContaining({ sessionId: 'agent-2', deltaLines: expect.any(Number) })
      );
    });
  });

  it('translates wheel into arrow keys on the alternate screen without mouse tracking', async () => {
    mockSnapshot({ alternateScreen: true, mouseMode: 'none' });
    const { canvas } = await mount();
    fireEvent.wheel(canvas, { deltaY: 100, deltaMode: 0 });
    await waitFor(() => {
      expect(writes().join('')).toContain('\x1b[B');
    });
  });
});
describe('TerminalCanvasSurface agent observation', () => {
  it('records PTY text from the snapshot poll into the agent registry', async () => {
    const sessionId = 'ghostgrid-observe-opencode';
    (invokeCommand as any).mockImplementation((cmd: string) => {
      if (cmd === 'poll_terminal_snapshot') {
        return Promise.resolve({
          kind: 'unchanged',
          seq: 1,
          exited: false,
          observedBytesBase64: btoa('OpenCode v0.2.0\n'),
        });
      }
      return Promise.resolve(null);
    });

    render(<TerminalCanvasSurface sessionId={sessionId} engine="terminal" />);

    try {
      await waitFor(() => {
        const found = getActiveAgentTerminals().find((term) => term.sessionId === sessionId);
        expect(found?.engine).toBe('open-code');
      });
    } finally {
      markTerminalExited(sessionId);
    }
  });
});

describe('TerminalCanvasSurface focus', () => {
  it('automatically focuses the hidden input on mount with a sessionId', () => {
    (invokeCommand as any).mockImplementation(() => Promise.resolve(null));
    const { container } = render(<TerminalCanvasSurface sessionId="agent-mount-focus" />);
    const textarea = container.querySelector('textarea')!;
    expect(document.activeElement).toBe(textarea);
  });

  it('focuses the hidden input when isFocused prop becomes true', () => {
    (invokeCommand as any).mockImplementation(() => Promise.resolve(null));
    const { container, rerender } = render(<TerminalCanvasSurface sessionId="agent-prop-focus" isFocused={false} />);
    const textarea = container.querySelector('textarea')!;
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).not.toBe(textarea);

    rerender(<TerminalCanvasSurface sessionId="agent-prop-focus" isFocused={true} />);
    expect(document.activeElement).toBe(textarea);
  });

  it('returns focus to the hidden input after a click on the canvas (local selection path)', async () => {
    (invokeCommand as any).mockImplementation((cmd: string) =>
      cmd === 'poll_terminal_snapshot'
        ? Promise.resolve(agentSnapshot({ alternateScreen: false, mouseMode: 'none' }))
        : Promise.resolve(null)
    );
    const { container } = render(<TerminalCanvasSurface sessionId="agent-3" />);
    const canvas = container.querySelector('canvas')!;
    const textarea = container.querySelector('textarea')!;
    // Simulate the browser moving focus to <body> on mousedown of a non-focusable canvas.
    (document.activeElement as HTMLElement | null)?.blur?.();
    fireEvent.click(canvas);
    expect(document.activeElement).toBe(textarea);
  });
});