import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER,
  StableCellFitAddon,
  TERMINAL_SCROLLBAR_WIDTH_PX,
  ZwjAwareUnicode11Provider,
  buildWindowsConptyOptions,
  clampPtyViewportDimensions,
  createUnicodePropertyValue,
  extractUnicodeKind,
  extractUnicodeWidth,
  hasMinimallyRenderableFitGeometry,
  reconcilePtySizeAfterSpawn,
  repairWebglCanvasForDevicePixelRatio,
  resizeConptyViewport,
  resolveBlockElementGradient,
  safeFitTerminal,
  scheduleStabilizedFit,
  terminalGridDriftedFromFit,
} from './terminalViewport';

describe('terminalViewport', () => {
  it('configures Windows ConPTY backend options for modern Windows builds', () => {
    expect(buildWindowsConptyOptions(DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER)).toEqual({
      backend: 'conpty',
      buildNumber: 22631,
    });
    expect(buildWindowsConptyOptions(19045)).toEqual({ backend: 'conpty' });
    expect(buildWindowsConptyOptions(undefined)).toEqual({ backend: 'conpty' });
  });

  it('clamps PTY viewport dimensions to safe positive integers', () => {
    expect(clampPtyViewportDimensions(0, -4)).toEqual({ cols: 20, rows: 8 });
    expect(clampPtyViewportDimensions(120.8, 36.2)).toEqual({ cols: 120, rows: 36 });
  });

  it('rejects hidden or unmeasured host boxes before fitting', () => {
    expect(hasMinimallyRenderableFitGeometry({ width: 0, height: 400, cols: 80, rows: 24 })).toBe(false);
    expect(hasMinimallyRenderableFitGeometry({ width: 300, height: 12, cols: 80, rows: 24 })).toBe(false);
    expect(hasMinimallyRenderableFitGeometry({ width: 300, height: 200, cols: 4, rows: 24 })).toBe(false);
    expect(hasMinimallyRenderableFitGeometry({ width: 300, height: 200, cols: 80, rows: 24 })).toBe(true);
  });

  it('joins ZWJ emoji sequences into a single wide cluster in ZwjAwareUnicode11Provider', () => {
    const baseProvider = {
      version: '11',
      wcwidth: (num: number): 0 | 1 | 2 => (num >= 0x1f300 ? 2 : 1),
      charProperties: (num: number, _preceding: number) =>
        createUnicodePropertyValue(num, num >= 0x1f300 ? 2 : 1, false),
    };
    const provider = new ZwjAwareUnicode11Provider(baseProvider);
    expect(provider.version).toBe('11-zwj');

    const firstEmoji = provider.charProperties(0x1f468, 0);
    const zwjProps = provider.charProperties(0x200d, firstEmoji);
    expect(extractUnicodeKind(zwjProps)).toBe(0x200d);
    expect(extractUnicodeWidth(zwjProps)).toBe(2);
    expect(zwjProps & 1).toBe(1);

    const joinedComponent = provider.charProperties(0x1f4bb, zwjProps);
    expect(extractUnicodeWidth(joinedComponent)).toBe(2);
    expect(joinedComponent & 1).toBe(1);

    const warningSign = provider.charProperties(0x26a0, 0);
    expect(extractUnicodeWidth(warningSign)).toBe(1);
    const vs16Props = provider.charProperties(0xfe0f, warningSign);
    expect(extractUnicodeKind(vs16Props)).toBe(0xfe0f);
    expect(extractUnicodeWidth(vs16Props)).toBe(2);
    expect(vs16Props & 1).toBe(1);
  });

  it('maps runs of identical Unicode block elements to exact CSS linear-gradients', () => {
    expect(resolveBlockElementGradient('████')).toBe(
      'linear-gradient(to bottom, transparent 0%, var(--kite-block-fg) 0%)',
    );
    expect(resolveBlockElementGradient('▀▀▀▀')).toBe(
      'linear-gradient(to bottom, var(--kite-block-fg) 50%, transparent 50%)',
    );
    expect(resolveBlockElementGradient('▄▄▄▄')).toBe(
      'linear-gradient(to bottom, transparent 50%, var(--kite-block-fg) 50%)',
    );
    expect(resolveBlockElementGradient('▀▄')).toBeNull();
    expect(resolveBlockElementGradient('hello')).toBeNull();
  });

  it('detects when the live terminal grid has drifted from FitAddon.proposeDimensions()', () => {
    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 500,
      top: 0,
      left: 0,
      bottom: 500,
      right: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const term = { cols: 28, rows: 33 } as any;
    const fit = {
      proposeDimensions: () => ({ cols: 110, rows: 33 }),
      fit: vi.fn(() => {
        term.cols = 110;
        term.rows = 33;
      }),
    } as any;

    expect(terminalGridDriftedFromFit(term, fit, host)).toBe(true);
    const next = safeFitTerminal(term, fit, host);
    expect(next).toEqual({ cols: 110, rows: 33 });
    expect(terminalGridDriftedFromFit(term, fit, host)).toBe(false);
  });

  it('reconciles post-spawn layout changes across animation frames', () => {
    const callbacks: FrameRequestCallback[] = [];
    let measured = { cols: 28, rows: 33 };
    let appliedSize = { cols: 28, rows: 33 };
    const applied: { cols: number; rows: number }[] = [];

    reconcilePtySizeAfterSpawn({
      isCancelled: () => false,
      fitAndMeasure: () => measured,
      getAppliedSize: () => appliedSize,
      applySize: (dims) => {
        appliedSize = dims;
        applied.push(dims);
      },
      requestFrame: (cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
      cancelFrame: () => {},
    });

    measured = { cols: 110, rows: 33 };
    while (callbacks.length > 0) {
      const next = callbacks.shift()!;
      next(performance.now());
    }

    expect(applied).toEqual([{ cols: 110, rows: 33 }]);
  });

  it('repairs WebGL backing canvas dimensions when devicePixelRatio scales up', () => {
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
      width: 600,
      height: 400,
      top: 0,
      left: 0,
      bottom: 400,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    screen.appendChild(canvas);

    const root = document.createElement('div');
    root.appendChild(screen);

    const refresh = vi.fn();
    const handleDevicePixelRatioChange = vi.fn();
    const repaired = repairWebglCanvasForDevicePixelRatio(
      {
        element: root,
        rows: 24,
        refresh,
        _core: {
          _renderService: {
            handleDevicePixelRatioChange,
          },
        },
      } as any,
      1.5,
    );

    expect(repaired).toBe(true);
    expect(handleDevicePixelRatioChange).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(0, 23);
  });

  it('computes stable cell dimensions with 5px scrollbar width and clears render service on resize', () => {
    const parent = document.createElement('div');
    parent.style.width = '805px';
    parent.style.height = '480px';
    const element = document.createElement('div');
    parent.appendChild(element);

    const resize = vi.fn();
    const clearRenderService = vi.fn();
    const term = {
      cols: 80,
      rows: 24,
      element,
      options: {
        scrollback: 5000,
        scrollbar: { width: TERMINAL_SCROLLBAR_WIDTH_PX },
      },
      dimensions: {
        device: { cell: { width: 12, height: 24 } },
        css: { cell: { width: 8.4, height: 16.4 } },
      },
      _core: {
        _renderService: {
          clear: clearRenderService,
        },
      },
      resize,
    } as any;

    Object.defineProperty(window, 'devicePixelRatio', {
      value: 1.5,
      configurable: true,
    });

    const addon = new StableCellFitAddon();
    addon.activate(term);
    const proposed = addon.proposeDimensions();
    // (805 - 5px scrollbar) / (12 / 1.5 = 8px) = 100 cols; 480 / (24 / 1.5 = 16px) = 30 rows
    expect(proposed).toEqual({ cols: 100, rows: 30 });

    addon.fit();
    expect(clearRenderService).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it('waits for two consecutive matching proposed grids in scheduleStabilizedFit', () => {
    const callbacks: FrameRequestCallback[] = [];
    const sequence = [
      { cols: 92, rows: 30 },
      { cols: 98, rows: 30 },
      { cols: 98, rows: 30 },
    ];
    let idx = 0;
    const onSettled = vi.fn();

    scheduleStabilizedFit({
      propose: () => sequence[Math.min(idx++, sequence.length - 1)],
      onSettled,
      requestFrame: (cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
      cancelFrame: () => {},
    });

    callbacks.shift()!(0);
    expect(onSettled).not.toHaveBeenCalled();
    callbacks.shift()!(16);
    expect(onSettled).not.toHaveBeenCalled();
    callbacks.shift()!(32);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('keeps the top viewport line anchored across normal-buffer ConPTY resize reflow', () => {
    const preLines = [
      { isWrapped: false },
      { isWrapped: true },
      { isWrapped: false }, // ybase = 2 (logical line #2 is at top of viewport)
      { isWrapped: false },
      { isWrapped: false },
    ];
    const postLines = [
      { isWrapped: false },
      { isWrapped: false }, // logical line #2 is now at index 1 after wider reflow rejoined line 0+1
      { isWrapped: false },
      { isWrapped: false },
    ];
    const normalBuffer = {
      ybase: 2,
      ydisp: 2,
      lines: {
        get length() {
          return normalBuffer === currentBuffer ? preLines.length : postLines.length;
        },
        get(index: number) {
          return (normalBuffer === currentBuffer ? preLines : postLines)[index];
        },
      },
    };
    let currentBuffer = normalBuffer;
    const term = {
      cols: 80,
      rows: 3,
      buffer: { active: { type: 'normal' } },
      _core: {
        _bufferService: {
          buffers: {
            get normal() {
              return currentBuffer;
            },
          },
        },
      },
      resize: vi.fn((cols: number, rows: number) => {
        term.cols = cols;
        term.rows = rows;
        currentBuffer = {
          ybase: 2,
          ydisp: 2,
          lines: {
            length: postLines.length,
            get: (index: number) => postLines[index],
          },
        };
      }),
    } as any;

    resizeConptyViewport(term, 120, 3);
    expect(term.resize).toHaveBeenCalledWith(120, 3);
    expect(currentBuffer.ybase).toBe(1);
    expect(currentBuffer.ydisp).toBe(1);
  });
});
