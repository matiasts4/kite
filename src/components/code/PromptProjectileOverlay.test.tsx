import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import {
  PromptProjectileOverlay,
  computeInjectionPoint,
  PROMPT_INJECTION_DURATION_MS,
} from './PromptProjectileOverlay';

describe('computeInjectionPoint', () => {
  it('reaches target when rawT is 1', () => {
    const { x, y, done } = computeInjectionPoint(0, 0, 200, 100, 1);
    expect(done).toBe(true);
    expect(x).toBeCloseTo(200, 0);
    expect(y).toBeCloseTo(100, 0);
  });
});

describe('PromptProjectileOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders null initially when no injection is active', () => {
    const { container } = render(<PromptProjectileOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the injection slip when kite:dispatch-prompt-projectile is received', () => {
    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:dispatch-prompt-projectile', {
          detail: {
            targetPaneId: 'pane-1',
            targetSessionId: 'term-123',
            agentName: 'Orion',
            engine: 'grok',
            prompt: 'Analizar arquitectura',
          },
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const overlay = container.querySelector('.prompt-projectile-overlay');
    expect(overlay).not.toBeNull();
    expect(container.querySelector('.prompt-injection-dot')).not.toBeNull();
    expect(container.querySelector('.prompt-injection-slip')).toBeNull();
  });

  it('dispatches kite:terminal-staged-prompt upon arrival at destination', async () => {
    render(<PromptProjectileOverlay />);

    const stagedPromptListener = vi.fn();
    window.addEventListener('kite:terminal-staged-prompt', stagedPromptListener);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:dispatch-prompt-projectile', {
          detail: {
            targetPaneId: 'pane-42',
            targetSessionId: 'term-999',
            agentName: 'Nova',
            engine: 'claude',
            prompt: 'Revisa documentación de errores',
          },
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    await act(async () => {
      vi.advanceTimersByTime(PROMPT_INJECTION_DURATION_MS + 80);
      await Promise.resolve();
    });

    expect(stagedPromptListener).toHaveBeenCalledTimes(1);
    const event = stagedPromptListener.mock.calls[0][0] as CustomEvent;
    expect(event.detail.sessionId).toBe('term-999');
    expect(event.detail.agentName).toBe('Nova');
    expect(event.detail.prompt).toBe('Revisa documentación de errores');

    window.removeEventListener('kite:terminal-staged-prompt', stagedPromptListener);
  });

  it('starts flight from sourcePaneId when that leaf exists in the DOM', () => {
    const source = document.createElement('div');
    source.setAttribute('data-leaf-id', 'parent-pane');
    source.getBoundingClientRect = vi.fn(() => ({
      x: 40,
      y: 60,
      width: 120,
      height: 80,
      top: 60,
      left: 40,
      right: 160,
      bottom: 140,
      toJSON: () => ({}),
    }));
    document.body.appendChild(source);

    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:dispatch-prompt-projectile', {
          detail: {
            sourcePaneId: 'parent-pane',
            targetSessionId: 'child-term',
            prompt: 'Handoff prompt',
          },
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(container.querySelector('.prompt-injection-dot')).not.toBeNull();
  });

  it('dispatches staged prompt immediately with reduced motion and no slip', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      }))
    );

    const stagedPromptListener = vi.fn();
    window.addEventListener('kite:terminal-staged-prompt', stagedPromptListener);

    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:dispatch-prompt-projectile', {
          detail: {
            targetSessionId: 'term-instant',
            prompt: 'Sin animación',
          },
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(stagedPromptListener).toHaveBeenCalledTimes(1);
    expect(stagedPromptListener.mock.calls[0][0].detail.sessionId).toBe('term-instant');
    expect(container.querySelector('.prompt-injection-dot')).toBeNull();

    window.removeEventListener('kite:terminal-staged-prompt', stagedPromptListener);
  });
});
