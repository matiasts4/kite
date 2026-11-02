import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { TerminalCanvasSurface, measureTerminalCanvasGrid } from './TerminalCanvasSurface';
import { invokeCommand } from '../../lib/ipc';

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

describe('TerminalCanvasSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders canvas and hidden input without throwing', () => {
    (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 0 });

    const { container } = render(<TerminalCanvasSurface sessionId="test-session-1" />);

    expect(container.querySelector('canvas.terminal-canvas-surface')).toBeInTheDocument();
    expect(container.querySelector('textarea.terminal-canvas-surface__input')).toBeInTheDocument();
  });

  it('polls snapshot and sends input upon Enter, Shift+Tab, Alt+Enter, and applicationCursor arrows', async () => {
    (invokeCommand as any).mockImplementation((cmd: string) => {
      if (cmd === 'poll_terminal_snapshot') {
        return Promise.resolve({
          kind: 'snapshot',
          snapshot: {
            seq: 1,
            cols: 80,
            rows: 24,
            alternateScreen: false,
            applicationCursor: true,
            bracketedPaste: true,
            cursor: { visible: true, col: 0, row: 0, shape: 'bar' },
            dirtyRows: [
              {
                rowIdx: 0,
                cells: [
                  {
                    ch: 'H',
                    width: 1,
                    fg: [250, 250, 250],
                    bg: [10, 10, 10],
                    hasBg: false,
                    bold: false,
                    italic: false,
                    underline: false,
                    inverse: false,
                    dim: false,
                  },
                ],
              },
            ],
            full: true,
          },
        });
      }
      return Promise.resolve(null);
    });

    const { container } = render(<TerminalCanvasSurface sessionId="test-session-1" />);

    const textarea = container.querySelector('textarea.terminal-canvas-surface__input')!;
    expect(textarea).toBeInTheDocument();

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('poll_terminal_snapshot', expect.any(Object));
    });

    // Enter -> \r
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(invokeCommand).toHaveBeenCalledWith('write_terminal', {
      sessionId: 'test-session-1',
      input: '\r',
    });

    // Shift+Tab -> \x1b[Z
    fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });
    expect(invokeCommand).toHaveBeenCalledWith('write_terminal', {
      sessionId: 'test-session-1',
      input: '\x1b[Z',
    });

    // Alt+Enter -> \x1b\r
    fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });
    expect(invokeCommand).toHaveBeenCalledWith('write_terminal', {
      sessionId: 'test-session-1',
      input: '\x1b\r',
    });

    // ArrowUp with applicationCursor=true -> \x1bOA
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(invokeCommand).toHaveBeenCalledWith('write_terminal', {
      sessionId: 'test-session-1',
      input: '\x1bOA',
    });
  });

  it('computes positive fractional cell metrics in measureTerminalCanvasGrid', () => {
    const metrics = measureTerminalCanvasGrid(null);
    expect(metrics.cols).toBe(80);
    expect(metrics.rows).toBe(24);
    expect(metrics.cellW).toBeGreaterThan(2);
    expect(metrics.cellH).toBeGreaterThanOrEqual(12);
  });
});
