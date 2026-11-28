import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VoiceWaveRibbon } from './VoiceWaveRibbon';
import { getVoicePalette, normalizeVoiceRgb } from '../../../../lib/operator/config/voicePalettes';

function createMock2dContext() {
  const linearGradient = { addColorStop: vi.fn() };
  return {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    createLinearGradient: vi.fn(() => linearGradient),
    globalCompositeOperation: 'source-over',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowColor: '',
    shadowBlur: 0,
  };
}

describe('VoiceWaveRibbon', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-motion');
  });

  it('renders hero and compact horizon modes with DPR-scaled backing dimensions', () => {
    const ctx = createMock2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const palette = normalizeVoiceRgb(getVoicePalette('Fenrir').palette);

    const { rerender } = render(
      <VoiceWaveRibbon
        active
        level={0.62}
        speaking
        speaker="agent"
        palette={palette}
      />,
    );

    const canvas = screen.getByTestId('voice-wave-ribbon') as HTMLCanvasElement;
    expect(canvas.getAttribute('data-mode')).toBe('hero');
    expect(canvas.getAttribute('data-speaker')).toBe('agent');
    expect(canvas.style.height).toBe('68px');
    expect(ctx.stroke).toHaveBeenCalledTimes(3);

    rerender(
      <VoiceWaveRibbon
        active
        compact
        level={0.45}
        speaking
        speaker="you"
        palette={palette}
      />,
    );

    expect(canvas.getAttribute('data-mode')).toBe('horizon');
    expect(canvas.getAttribute('data-speaker')).toBe('you');
    expect(canvas.style.height).toBe('22px');
  });

  it('draws a single calm frame without scheduling an animation loop when reduced motion is enabled', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
    const ctx = createMock2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    render(<VoiceWaveRibbon active level={0.2} speaking={false} muted />);

    const canvas = screen.getByTestId('voice-wave-ribbon');
    expect(canvas.getAttribute('data-muted')).toBe('true');
    expect(ctx.stroke).toHaveBeenCalled();
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('degrades gracefully without throwing when Canvas 2D context is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    expect(() => {
      render(<VoiceWaveRibbon active level={0.5} speaking />);
    }).not.toThrow();
    expect(screen.getByTestId('voice-wave-ribbon')).toBeTruthy();
  });
});
