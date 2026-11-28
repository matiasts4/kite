import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ZedOrb } from './ZedOrb';
import { sanitizeZedFigure, ZED_FIGURE_OPTIONS } from '../lib/operator/operatorConfig';
import type { OrbRenderParams } from './orbRenderer';

const orbRendererSpies = vi.hoisted(() => ({
  constructed: vi.fn(),
  dispose: vi.fn(),
  resize: vi.fn(),
  render: vi.fn<(params: OrbRenderParams) => void>(),
}));

vi.mock('./orbRenderer', () => ({
  OrbRenderer: class MockOrbRenderer {
    constructor(canvas: HTMLCanvasElement) {
      orbRendererSpies.constructed(canvas);
    }
    isReady() {
      return true;
    }
    resize(w: number, h: number) {
      orbRendererSpies.resize(w, h);
    }
    render(params: OrbRenderParams) {
      orbRendererSpies.render(params);
    }
    dispose() {
      orbRendererSpies.dispose();
    }
  },
}));

describe('ZedOrb — Interactive Multi-Mode Living Figures & Low-Resource Pacing', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-motion');
    vi.clearAllMocks();
  });

  it('supports all 8 volumetric interactive figure modes and maps legacy figure IDs cleanly', () => {
    expect(ZED_FIGURE_OPTIONS.map((o) => o.id)).toEqual([
      'plasma-orb',
      'ferrofluid',
      'frosted-sphere',
      'eclipse-halo',
      'silk-wave',
      'crystal-prism',
      'orbital-gyro',
      'chromatic-pearl',
    ]);
    expect(sanitizeZedFigure('theme-sync')).toBe('plasma-orb');
    expect(sanitizeZedFigure('aurora-ring')).toBe('orbital-gyro');
    expect(sanitizeZedFigure('acoustic-pulse')).toBe('silk-wave');
    expect(sanitizeZedFigure('kinetic-ring')).toBe('orbital-gyro');
    expect(sanitizeZedFigure('kite-crest')).toBe('crystal-prism');
    expect(sanitizeZedFigure('pixel-companion')).toBe('ferrofluid');
    expect(sanitizeZedFigure('editorial-botanical')).toBe('frosted-sphere');
    expect(sanitizeZedFigure('unknown')).toBe('plasma-orb');

    const { rerender } = render(<ZedOrb figure="plasma-orb" size={72} state="connected" />);
    expect(screen.getByTestId('zed-orb')).toHaveAttribute('data-figure', 'plasma-orb');
    expect(screen.getByTestId('zed-orb')).toHaveAttribute('data-shader-mode', '0');

    for (const opt of ZED_FIGURE_OPTIONS) {
      rerender(<ZedOrb figure={opt.id} size={72} state="listening" />);
      const orb = screen.getByTestId('zed-orb');
      expect(orb).toHaveAttribute('data-figure', opt.id);
      expect(orb).toHaveAttribute('data-shader-mode', String(opt.shaderMode));
    }
  });

  it('renders a single static frame with zero continuous RAF loop under reduced motion', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

    const lastRenderParams = () => {
      const calls = orbRendererSpies.render.mock.calls;
      return calls[calls.length - 1]?.[0];
    };

    const { rerender } = render(<ZedOrb figure="ferrofluid" size={72} state="connected" />);
    expect(rafSpy).not.toHaveBeenCalled();
    expect(orbRendererSpies.render).toHaveBeenCalled();
    expect(lastRenderParams()?.mode).toBe(1);

    rerender(<ZedOrb figure="crystal-prism" size={72} state="thinking" />);
    expect(lastRenderParams()?.mode).toBe(5);
    expect(lastRenderParams()?.thinking).toBe(1);
    rafSpy.mockRestore();
  });

  it('pauses continuous requestAnimationFrame in calm idle/connected state and wakes on hover or active voice states', () => {
    let rafCallback: FrameRequestCallback | null = null;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    try {
      const { rerender } = render(<ZedOrb figure="plasma-orb" size={72} state="idle" />);
      // Renders one crisp static frame on mount without scheduling a continuous RAF loop
      expect(orbRendererSpies.render).toHaveBeenCalledTimes(1);
      expect(rafSpy).toHaveBeenCalledTimes(0);

      // Entering an active voice state wakes the RAF loop immediately
      rerender(<ZedOrb figure="plasma-orb" size={72} state="thinking" />);
      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(rafCallback).not.toBeNull();
      rafCallback!(performance.now() + 32);
      expect(orbRendererSpies.render).toHaveBeenCalledTimes(2);
      expect(rafSpy).toHaveBeenCalledTimes(2);

      // Returning to calm idle stops scheduling new RAF frames after rendering the settled frame
      rerender(<ZedOrb figure="plasma-orb" size={72} state="idle" />);
      const rafCountBeforeSettle = rafSpy.mock.calls.length;
      rafCallback!(performance.now() + 64);
      expect(rafSpy).toHaveBeenCalledTimes(rafCountBeforeSettle);

      // Minimized window state blocks RAF scheduling even when hovered
      document.documentElement.setAttribute('data-window-state', 'minimized');
      const orb = screen.getByTestId('zed-orb');
      fireEvent.pointerEnter(orb);
      expect(rafSpy).toHaveBeenCalledTimes(rafCountBeforeSettle);

      document.documentElement.removeAttribute('data-window-state');
      fireEvent.pointerEnter(orb);
      expect(rafSpy).toHaveBeenCalledTimes(rafCountBeforeSettle + 1);
    } finally {
      document.documentElement.removeAttribute('data-window-state');
      rafSpy.mockRestore();
    }
  });

  it('forwards external pointerTargetRef hover, 3D tilt, and click ripple events into OrbRenderer', () => {
    let rafCallback: FrameRequestCallback | null = null;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallback = cb;
      return 1;
    });

    const HostHarness: React.FC = () => {
      const hostRef = React.useRef<HTMLDivElement | null>(null);
      return (
        <div ref={hostRef} data-testid="orb-host">
          <ZedOrb figure="orbital-gyro" size={72} state="connected" pointerTargetRef={hostRef} />
        </div>
      );
    };

    try {
      render(<HostHarness />);
      const host = screen.getByTestId('orb-host');
      vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      fireEvent.pointerMove(host, { clientX: 90, clientY: 20 });
      fireEvent.pointerDown(host, { clientX: 90, clientY: 20 });

      expect(rafCallback).not.toBeNull();
      rafCallback!(performance.now() + 80);

      const calls = orbRendererSpies.render.mock.calls;
      const lastCall = calls[calls.length - 1]?.[0];
      expect(lastCall).toBeDefined();
      expect(lastCall?.mode).toBe(6);
      expect(lastCall?.hover).toBeGreaterThan(0);
      expect(lastCall?.tiltX).toBeGreaterThan(0);
      expect(lastCall?.ripple).toBeGreaterThan(0);
    } finally {
      rafSpy.mockRestore();
    }
  });
});
