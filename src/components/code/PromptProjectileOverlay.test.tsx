import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import {
  PromptProjectileOverlay,
  computeInjectionPoint,
  promptCapsuleLabel,
  resolveSourcePosition,
  resolveTargetPosition,
  PROMPT_CAPSULE_MAX_CHARS,
  PROMPT_INJECTION_DURATION_MS,
  PROMPT_STAGGER_STEP_MS,
} from './PromptProjectileOverlay';

const REDUCED_MOTION_QUERY = 'prefers-reduced-motion';

type RectInput = { left: number; top: number; width: number; height: number };

function stubRect(el: Element, rect: RectInput): void {
  el.getBoundingClientRect = vi.fn(() => ({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => ({}),
  })) as unknown as () => DOMRect;
}

function addTerminalPane(paneId: string, sessionId: string, rect: RectInput) {
  const pane = document.createElement('section');
  pane.setAttribute('data-leaf-id', paneId);
  pane.setAttribute('data-pane-id', paneId);
  pane.setAttribute('data-session-id', sessionId);
  stubRect(pane, rect);

  const container = document.createElement('div');
  container.className = 'terminal-view-container';
  container.setAttribute('data-pane-id', paneId);
  container.setAttribute('data-session-id', sessionId);
  stubRect(container, rect);

  pane.appendChild(container);
  document.body.appendChild(pane);
  return { pane, container };
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: reduce && query.includes(REDUCED_MOTION_QUERY),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }))
  );
}

function dispatchProjectile(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('kite:dispatch-prompt-projectile', { detail }));
}

// Panes injected by one resolution test must never leak into the next lookup.
beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('computeInjectionPoint', () => {
  it('reaches target when rawT is 1', () => {
    const { x, y, done } = computeInjectionPoint(0, 0, 200, 100, 1);
    expect(done).toBe(true);
    expect(x).toBeCloseTo(200, 0);
    expect(y).toBeCloseTo(100, 0);
  });
});

describe('promptCapsuleLabel', () => {
  it('uses an explicit label verbatim', () => {
    expect(promptCapsuleLabel({ targetSessionId: 't', prompt: 'cualquier prompt', label: '⚡ ODD → claude' })).toBe(
      '⚡ ODD → claude'
    );
  });

  it('truncates a long prompt to a compact snippet', () => {
    const label = promptCapsuleLabel({
      targetSessionId: 't',
      prompt: 'Refactoriza el módulo de autenticación para soportar OAuth',
    });
    expect(label).toBe('Refactoriza el módulo de…');
    expect(label.length).toBeLessThanOrEqual(PROMPT_CAPSULE_MAX_CHARS + 1);
  });

  it('keeps a short prompt intact', () => {
    expect(promptCapsuleLabel({ targetSessionId: 't', prompt: '  fix auth  ' })).toBe('fix auth');
  });
});

describe('resolveTargetPosition', () => {
  it('resolves the exact target pane by data-session-id instead of the last pane', () => {
    addTerminalPane('pane-a', 'term-a', { left: 0, top: 0, width: 300, height: 200 });
    addTerminalPane('pane-b', 'term-b', { left: 600, top: 400, width: 300, height: 200 });
    addTerminalPane('pane-c', 'term-c', { left: 1200, top: 800, width: 300, height: 200 });

    const { targetX, targetY } = resolveTargetPosition({ targetSessionId: 'term-b', prompt: 'hola' });

    expect(targetX).toBe(675);
    expect(targetY).toBe(480);
  });

  it('resolves a target by data-pane-id when no session id matches', () => {
    addTerminalPane('pane-a', 'term-a', { left: 0, top: 0, width: 300, height: 200 });
    addTerminalPane('pane-b', 'term-b', { left: 600, top: 400, width: 300, height: 200 });

    const { targetX, targetY } = resolveTargetPosition({ targetPaneId: 'pane-a', prompt: 'hola' });

    expect(targetX).toBe(75);
    expect(targetY).toBe(80);
  });

  it('falls back to the last terminal pane when no identifiers are provided', () => {
    addTerminalPane('pane-a', 'term-a', { left: 0, top: 0, width: 300, height: 200 });
    const last = addTerminalPane('pane-z', 'term-z', { left: 500, top: 300, width: 300, height: 200 });

    const { targetX, targetY } = resolveTargetPosition({ prompt: 'hola' });

    expect(last.container).not.toBeNull();
    expect(targetX).toBe(575);
    expect(targetY).toBe(380);
  });
});

describe('resolveSourcePosition', () => {
  it('resolves the source terminal center for terminal-to-terminal flight', () => {
    addTerminalPane('pane-a', 'term-a', { left: 100, top: 100, width: 200, height: 200 });
    addTerminalPane('pane-b', 'term-b', { left: 700, top: 100, width: 200, height: 200 });

    const origin = resolveSourcePosition({ sourceSessionId: 'term-a', targetSessionId: 'term-b', prompt: 'hola' });

    expect(origin.startX).toBe(200);
    expect(origin.startY).toBe(200);
  });
});

describe('PromptProjectileOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    stubReducedMotion(false);
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
      dispatchProjectile({
        targetPaneId: 'pane-1',
        targetSessionId: 'term-123',
        agentName: 'Orion',
        engine: 'grok',
        prompt: 'Analizar arquitectura',
      });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const overlay = container.querySelector('.prompt-projectile-overlay');
    expect(overlay).not.toBeNull();
    expect(container.querySelector('.prompt-injection-dot')).not.toBeNull();
    expect(container.querySelector('.prompt-injection-slip')).toBeNull();
  });

  it('renders the prompt preview capsule with the dispatcher label during flight', () => {
    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      dispatchProjectile({
        targetSessionId: 'term-label',
        prompt: 'Implementa la fase dos del ODD',
        label: '⚡ ODD → claude',
      });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const capsule = container.querySelector('.prompt-injection-capsule');
    expect(capsule).not.toBeNull();
    expect(capsule?.textContent).toBe('⚡ ODD → claude');
  });

  it('renders a shortened prompt snippet in the capsule when no label is given', () => {
    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      dispatchProjectile({
        targetSessionId: 'term-snippet',
        prompt: 'Refactoriza el módulo de autenticación para soportar OAuth',
      });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const text = container.querySelector('.prompt-injection-capsule')?.textContent ?? '';
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(PROMPT_CAPSULE_MAX_CHARS + 1);
  });

  it('pulses the Zed orb when the throw originates from Zed', () => {
    render(<PromptProjectileOverlay />);

    const orbAck = vi.fn();
    window.addEventListener('kite:zed-orb-ack', orbAck);

    act(() => {
      dispatchProjectile({ targetSessionId: 'term-zed', prompt: 'Desde el orbe' });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(orbAck).toHaveBeenCalledTimes(1);

    window.removeEventListener('kite:zed-orb-ack', orbAck);
  });

  it('spawns a departure pulse at the source terminal instead of the Zed orb', () => {
    addTerminalPane('pane-a', 'term-a', { left: 100, top: 100, width: 200, height: 200 });
    addTerminalPane('pane-b', 'term-b', { left: 700, top: 100, width: 200, height: 200 });

    const { container } = render(<PromptProjectileOverlay />);

    const orbAck = vi.fn();
    window.addEventListener('kite:zed-orb-ack', orbAck);

    act(() => {
      dispatchProjectile({
        sourceSessionId: 'term-a',
        targetSessionId: 'term-b',
        prompt: 'Handoff de terminal a terminal',
      });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(container.querySelectorAll('.prompt-injection-ring--launch')).toHaveLength(1);
    expect(orbAck).not.toHaveBeenCalled();

    window.removeEventListener('kite:zed-orb-ack', orbAck);
  });

  it('flies terminal-to-terminal from the source terminal coordinates', () => {
    addTerminalPane('pane-a', 'term-a', { left: 100, top: 100, width: 200, height: 200 });
    addTerminalPane('pane-b', 'term-b', { left: 700, top: 100, width: 200, height: 200 });

    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      dispatchProjectile({
        sourceSessionId: 'term-a',
        targetSessionId: 'term-b',
        prompt: 'Pasa el ODD al agente',
      });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const dot = container.querySelector<HTMLElement>('.prompt-injection-dot');
    expect(dot).not.toBeNull();
    expect(dot?.style.transform).toContain('translate3d(200px, 200px, 0)');
  });

  it('dispatches kite:terminal-staged-prompt and kite:prompt-landed upon arrival', async () => {
    render(<PromptProjectileOverlay />);

    const stagedPromptListener = vi.fn();
    const landedListener = vi.fn();
    window.addEventListener('kite:terminal-staged-prompt', stagedPromptListener);
    window.addEventListener('kite:prompt-landed', landedListener);

    act(() => {
      dispatchProjectile({
        targetPaneId: 'pane-42',
        targetSessionId: 'term-999',
        agentName: 'Nova',
        engine: 'claude',
        prompt: 'Revisa documentación de errores',
      });
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

    expect(landedListener).toHaveBeenCalledTimes(1);
    const landed = (landedListener.mock.calls[0][0] as CustomEvent).detail;
    expect(landed.sessionId).toBe('term-999');
    expect(landed.targetPaneId).toBe('pane-42');
    expect(landed.prompt).toBe('Revisa documentación de errores');

    window.removeEventListener('kite:terminal-staged-prompt', stagedPromptListener);
    window.removeEventListener('kite:prompt-landed', landedListener);
  });

  it('staggers multi-shot volleys that arrive within the same burst', () => {
    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      dispatchProjectile({ targetSessionId: 'term-1', prompt: 'Uno' });
      dispatchProjectile({ targetSessionId: 'term-2', prompt: 'Dos' });
      dispatchProjectile({ targetSessionId: 'term-3', prompt: 'Tres' });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(container.querySelectorAll('.prompt-injection-dot')).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(PROMPT_STAGGER_STEP_MS);
    });
    expect(container.querySelectorAll('.prompt-injection-dot')).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(PROMPT_STAGGER_STEP_MS);
    });
    expect(container.querySelectorAll('.prompt-injection-dot')).toHaveLength(3);
  });

  it('starts flight from sourcePaneId when that leaf exists in the DOM', () => {
    const source = document.createElement('div');
    source.setAttribute('data-leaf-id', 'parent-pane');
    stubRect(source, { left: 40, top: 60, width: 120, height: 80 });
    document.body.appendChild(source);

    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      dispatchProjectile({
        sourcePaneId: 'parent-pane',
        targetSessionId: 'child-term',
        prompt: 'Handoff prompt',
      });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(container.querySelector('.prompt-injection-dot')).not.toBeNull();
  });

  it('dispatches staged prompt immediately with reduced motion and no slip', () => {
    stubReducedMotion(true);

    const stagedPromptListener = vi.fn();
    const landedListener = vi.fn();
    window.addEventListener('kite:terminal-staged-prompt', stagedPromptListener);
    window.addEventListener('kite:prompt-landed', landedListener);

    const { container } = render(<PromptProjectileOverlay />);

    act(() => {
      dispatchProjectile({
        targetSessionId: 'term-instant',
        prompt: 'Sin animación',
      });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(stagedPromptListener).toHaveBeenCalledTimes(1);
    expect(stagedPromptListener.mock.calls[0][0].detail.sessionId).toBe('term-instant');
    expect(container.querySelector('.prompt-injection-dot')).toBeNull();
    expect(container.querySelector('.prompt-injection-capsule')).toBeNull();

    window.removeEventListener('kite:terminal-staged-prompt', stagedPromptListener);
    window.removeEventListener('kite:prompt-landed', landedListener);
  });
});
