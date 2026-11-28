import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { TerminalCanvasSurface, measureTerminalCanvasGrid } from './TerminalCanvasSurface';
import {
  MAX_TERMINAL_CANVAS_DPR,
  releaseCanvasBackingStore,
  renderCanvasGrid,
} from './terminal/canvas/canvasGridRenderer';
import { DEFAULT_TERMINAL_APPEARANCE_PREFS } from '../../lib/terminalAppearancePrefs';
import { invokeCommand } from '../../lib/ipc';
import {
  DEFAULT_THEME_CUSTOMIZATIONS,
  sanitizeThemeCustomizations,
  writeThemeCustomizations,
} from '../../lib/themeCustomizations';

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

  it('updates terminal container background and theme live when kite:theme-changed fires', () => {
    localStorage.clear();
    (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 0 });
    const { container } = render(<TerminalCanvasSurface sessionId="theme-sync-1" />);
    const wrapper = container.querySelector('.terminal-canvas-surface-container') as HTMLElement;
    expect(wrapper.style.backgroundColor).toBe('rgb(10, 11, 14)');

    const solarized = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'light',
      lightThemeId: 'solarized-light',
    });
    writeThemeCustomizations(solarized);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:theme-changed', {
          detail: {
            theme: 'light',
            palette: 'solarized-light',
            customizations: solarized,
          },
        })
      );
    });

    expect(wrapper.style.backgroundColor).toBe('rgb(253, 246, 227)');
  });

  it('uses a transparent container background when frosted glass / backdrop translucency is enabled', () => {
    const frosted = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'dark',
      darkThemeId: 'aurora-studio',
      surface: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.surface,
        translucent: true,
      },
    });
    writeThemeCustomizations(frosted);
    (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 0 });

    const { container } = render(<TerminalCanvasSurface sessionId="theme-glass-1" />);
    const wrapper = container.querySelector('.terminal-canvas-surface-container') as HTMLElement;
    expect(wrapper.getAttribute('data-transparent-bg')).toBe('true');
    expect(wrapper.style.backgroundColor).toBe('transparent');
  });

  it('toggles terminal live presentation when an ancestor mode-layer updates aria-hidden', async () => {
    localStorage.clear();
    (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 0 });

    const { container, rerender } = render(
      <div className="mode-layer mode-layer--visible" aria-hidden="false">
        <TerminalCanvasSurface sessionId="visibility-aria-1" />
      </div>
    );

    const layer = container.querySelector('.mode-layer') as HTMLElement;
    expect(layer).not.toBeNull();

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('set_terminal_presentation', {
        sessionId: 'visibility-aria-1',
        live: true,
      });
    });

    rerender(
      <div className="mode-layer" aria-hidden="true">
        <TerminalCanvasSurface sessionId="visibility-aria-1" />
      </div>
    );

    await waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith('set_terminal_presentation', {
        sessionId: 'visibility-aria-1',
        live: false,
      });
    });
  });

  it('stops 166ms replenish_terminal_credit polling while hidden and catches up once when visible again', async () => {
    vi.useFakeTimers();
    const prevVisibilityDesc = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const prevHiddenDesc = Object.getOwnPropertyDescriptor(document, 'hidden');
    let visState: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visState,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => visState === 'hidden',
    });

    try {
      (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 0 });
      render(<TerminalCanvasSurface sessionId="hidden-heartbeat-1" />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });

      vi.mocked(invokeCommand).mockClear();

      visState = 'hidden';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(2_000);
      });

      const hiddenCreditCalls = vi
        .mocked(invokeCommand)
        .mock.calls.filter(([cmd]) => cmd === 'replenish_terminal_credit');
      expect(hiddenCreditCalls).toHaveLength(0);
      expect(invokeCommand).toHaveBeenCalledWith('set_terminal_presentation', {
        sessionId: 'hidden-heartbeat-1',
        live: false,
      });

      vi.mocked(invokeCommand).mockClear();
      visState = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(20);
      });

      expect(invokeCommand).toHaveBeenCalledWith('set_terminal_presentation', {
        sessionId: 'hidden-heartbeat-1',
        live: true,
      });
      const resumeCreditCalls = vi
        .mocked(invokeCommand)
        .mock.calls.filter(([cmd]) => cmd === 'replenish_terminal_credit');
      expect(resumeCreditCalls).toHaveLength(1);
      expect(resumeCreditCalls[0]?.[1]).toEqual({ sessionId: 'hidden-heartbeat-1', amount: 1 });
      expect(invokeCommand).toHaveBeenCalledWith(
        'poll_terminal_snapshot',
        expect.objectContaining({ sessionId: 'hidden-heartbeat-1', sinceSeq: 0 }),
      );
    } finally {
      if (prevVisibilityDesc) Object.defineProperty(document, 'visibilityState', prevVisibilityDesc);
      else delete (document as any).visibilityState;
      if (prevHiddenDesc) Object.defineProperty(document, 'hidden', prevHiddenDesc);
      else delete (document as any).hidden;
      vi.useRealTimers();
    }
  });

  it('caps backing store DPR at 1.5 and releases/reallocates hidden canvas backing store after 5000ms grace', async () => {
    const prevDprDesc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    const prevGetContext = HTMLCanvasElement.prototype.getContext;
    const prevCanvasRect = HTMLCanvasElement.prototype.getBoundingClientRect;
    const prevDivRect = HTMLDivElement.prototype.getBoundingClientRect;

    const fakeRect = {
      width: 200,
      height: 100,
      top: 0,
      left: 0,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;

    const mockCtx = {
      fillStyle: '',
      font: '',
      textBaseline: 'alphabetic',
      textAlign: 'left',
      imageSmoothingEnabled: true,
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: () => ({ width: 8 }),
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      strokeRect: vi.fn(),
    };

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => 2.5,
    });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx as any);
    HTMLCanvasElement.prototype.getBoundingClientRect = () => fakeRect;
    HTMLDivElement.prototype.getBoundingClientRect = () => fakeRect;

    vi.useFakeTimers();
    try {
      expect(MAX_TERMINAL_CANVAS_DPR).toBe(1.5);

      const directCanvas = document.createElement('canvas');
      renderCanvasGrid({
        canvas: directCanvas,
        prefs: DEFAULT_TERMINAL_APPEARANCE_PREFS,
        matrix: [],
        cursor: { visible: true, col: 0, row: 0, shape: 'bar', blink: false },
        selection: { start: null, end: null },
        hoveredLink: null,
        isFocused: true,
        scrollbackOffset: 0,
        cellW: 8,
        cellH: 16,
        baseline: 12,
        gridRows: 4,
        gridCols: 20,
        dirtyRows: null,
      });
      expect(directCanvas.width).toBe(300);
      expect(directCanvas.height).toBe(150);
      expect(releaseCanvasBackingStore(directCanvas)).toBe(true);
      expect(directCanvas.width).toBe(0);
      expect(directCanvas.height).toBe(0);
      expect(releaseCanvasBackingStore(directCanvas)).toBe(false);

      (invokeCommand as any).mockResolvedValue({ kind: 'unchanged', seq: 0 });
      const { container, rerender } = render(
        <div className="mode-layer mode-layer--visible" aria-hidden="false">
          <TerminalCanvasSurface sessionId="backing-release-1" />
        </div>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });

      const canvas = container.querySelector('canvas.terminal-canvas-surface') as HTMLCanvasElement;
      expect(canvas.width).toBe(300);
      expect(canvas.height).toBe(150);

      rerender(
        <div className="mode-layer" aria-hidden="true">
          <TerminalCanvasSurface sessionId="backing-release-1" />
        </div>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_500);
      });
      expect(canvas.width).toBe(300);
      expect(canvas.height).toBe(150);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);

      rerender(
        <div className="mode-layer mode-layer--visible" aria-hidden="false">
          <TerminalCanvasSurface sessionId="backing-release-1" />
        </div>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(canvas.width).toBe(300);
      expect(canvas.height).toBe(150);
    } finally {
      vi.useRealTimers();
      HTMLCanvasElement.prototype.getContext = prevGetContext;
      HTMLCanvasElement.prototype.getBoundingClientRect = prevCanvasRect;
      HTMLDivElement.prototype.getBoundingClientRect = prevDivRect;
      if (prevDprDesc) Object.defineProperty(window, 'devicePixelRatio', prevDprDesc);
      else delete (window as any).devicePixelRatio;
    }
  });

  it('updates aria-live region directly in DOM without triggering React re-renders during streaming', async () => {
    vi.useFakeTimers();
    try {
      let pollSeq = 0;
      const makeSnapshot = (seq: number, line: string) => ({
        kind: 'snapshot',
        snapshot: {
          seq,
          cols: 20,
          rows: 2,
          alternateScreen: false,
          applicationCursor: false,
          bracketedPaste: false,
          cursor: { visible: true, col: 0, row: 0, shape: 'bar' },
          dirtyRows: [
            {
              rowIdx: 0,
              cells: Array.from(line).map((ch) => ({
                ch,
                width: 1,
                fg: [250, 250, 250],
                bg: [10, 10, 10],
                hasBg: false,
                bold: false,
                italic: false,
                underline: false,
                inverse: false,
                dim: false,
              })),
            },
          ],
          full: true,
        },
      });

      (invokeCommand as any).mockImplementation((cmd: string) => {
        if (cmd === 'poll_terminal_snapshot') {
          pollSeq += 1;
          return Promise.resolve(makeSnapshot(pollSeq, pollSeq === 1 ? 'First output' : 'Stream chunk 2'));
        }
        return Promise.resolve(null);
      });

      const onProfilerRender = vi.fn();
      const { container } = render(
        <React.Profiler id="terminal-live-region" onRender={onProfilerRender}>
          <TerminalCanvasSurface sessionId="live-dom-1" />
        </React.Profiler>
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });

      const liveRegion = container.querySelector('.terminal-canvas-live') as HTMLElement;
      expect(liveRegion.textContent).toContain('First output');

      const rendersBeforeSecondChunk = onProfilerRender.mock.calls.length;
      const textarea = container.querySelector('textarea.terminal-canvas-surface__input')!;

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'a' });
        await vi.advanceTimersByTimeAsync(350);
      });

      expect(liveRegion.textContent).toContain('Stream chunk 2');
      expect(onProfilerRender.mock.calls.length).toBe(rendersBeforeSecondChunk);
    } finally {
      vi.useRealTimers();
    }
  });
});
