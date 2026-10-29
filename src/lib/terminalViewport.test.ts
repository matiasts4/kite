import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER,
  ZwjAwareUnicode11Provider,
  buildWindowsConptyOptions,
  clampPtyViewportDimensions,
  createUnicodePropertyValue,
  extractUnicodeKind,
  extractUnicodeWidth,
  hasMinimallyRenderableFitGeometry,
  reconcilePtySizeAfterSpawn,
  repairWebglCanvasForDevicePixelRatio,
  resolveBlockElementGradient,
  safeFitTerminal,
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
});
