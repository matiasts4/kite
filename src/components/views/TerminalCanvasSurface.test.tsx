import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { TerminalCanvasSurface, measureTerminalCanvasGrid } from './TerminalCanvasSurface';
import { invokeCommand } from '../../lib/ipc';

vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
  isTauriEnvironment: () => false,
}));

describe('TerminalCanvasSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders canvas and hidden input without throwing', () => {
    (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 0 });

    const { container } = render(<TerminalCanvasSurface sessionId="test-session-1" />);

    const canvas = container.querySelector('canvas.terminal-canvas-surface');
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveStyle({ cursor: 'default' });
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

  it('maintains selection across scrollback and copies multi-screen text via get_terminal_selection_text', async () => {
    const makeRow = (rowIdx: number, text: string) => ({
      rowIdx,
      cells: Array.from({ length: 20 }, (_, i) => ({
        ch: text[i] ?? ' ',
        width: 1,
        fg: [250, 250, 250] as [number, number, number],
        bg: [10, 10, 10] as [number, number, number],
        hasBg: false,
        bold: false,
        italic: false,
        underline: false,
        inverse: false,
        dim: false,
      })),
    });

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    (invokeCommand as any).mockImplementation((cmd: string, args: any) => {
      if (cmd === 'poll_terminal_snapshot') {
        return Promise.resolve({
          kind: 'snapshot',
          snapshot: {
            seq: 1,
            cols: 20,
            rows: 4,
            alternateScreen: false,
            applicationCursor: false,
            bracketedPaste: false,
            scrollbackOffset: 0,
            scrollbackDepth: 4,
            cursor: { visible: true, col: 0, row: 3, shape: 'block' },
            dirtyRows: [
              makeRow(0, 'Line 05'),
              makeRow(1, 'Line 06'),
              makeRow(2, 'Line 07'),
              makeRow(3, 'Line 08'),
            ],
            full: true,
          },
        });
      }
      if (cmd === 'scroll_terminal_viewport') {
        return Promise.resolve({
          seq: 2,
          cols: 20,
          rows: 4,
          alternateScreen: false,
          applicationCursor: false,
          bracketedPaste: false,
          scrollbackOffset: 4,
          scrollbackDepth: 4,
          cursor: { visible: false, col: 0, row: 3, shape: 'block' },
          dirtyRows: [
            makeRow(0, 'Line 01'),
            makeRow(1, 'Line 02'),
            makeRow(2, 'Line 03'),
            makeRow(3, 'Line 04'),
          ],
          full: true,
        });
      }
      if (cmd === 'get_terminal_selection_text') {
        expect(args).toMatchObject({
          sessionId: 'scroll-sel-1',
          startRow: -4,
          endRow: 3,
        });
        return Promise.resolve({
          text: 'Line 01\nLine 02\nLine 03\nLine 04\nLine 05\nLine 06\nLine 07\nLine 08',
        });
      }
      return Promise.resolve(null);
    });

    const { container } = render(<TerminalCanvasSurface sessionId="scroll-sel-1" />);
    const canvas = container.querySelector('canvas.terminal-canvas-surface') as HTMLCanvasElement;
    const textarea = container.querySelector('textarea.terminal-canvas-surface__input') as HTMLTextAreaElement;

    canvas.getBoundingClientRect = () =>
      ({
        width: 200,
        height: 80,
        top: 0,
        left: 0,
        right: 200,
        bottom: 80,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('poll_terminal_snapshot', expect.any(Object));
    });

    // 1. Start selection at bottom-right while scrollbackOffset = 0 (row 3 -> relRow 3)
    fireEvent.mouseDown(canvas, { button: 0, clientX: 180, clientY: 70, detail: 3 });

    // 2. Scroll up 4 lines into scrollback while holding mouse button at top of viewport
    fireEvent.wheel(canvas, { deltaY: -120, deltaMode: 0, clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith(
        'scroll_terminal_viewport',
        expect.objectContaining({ sessionId: 'scroll-sel-1' }),
      );
    });

    // 3. Move mouse to top-left at scrollbackOffset = 4 (row 0 -> relRow -4) and release
    fireEvent.mouseMove(window, { clientX: 10, clientY: 5 });
    fireEvent.mouseUp(window);

    // 4. Press Ctrl+C to copy full conversation across scrollback (-4..3)
    fireEvent.keyDown(textarea, { key: 'c', ctrlKey: true });

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith(
        'get_terminal_selection_text',
        expect.objectContaining({
          sessionId: 'scroll-sel-1',
          startRow: -4,
          endRow: 3,
        }),
      );
      expect(writeTextMock).toHaveBeenLastCalledWith(
        'Line 01\nLine 02\nLine 03\nLine 04\nLine 05\nLine 06\nLine 07\nLine 08',
      );
    });
  });
});
