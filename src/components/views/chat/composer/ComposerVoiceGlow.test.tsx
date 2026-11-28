import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ComposerVoiceGlow } from './ComposerVoiceGlow';

function createMockWebGLContext() {
  const uniformLocations = new Map<string, { name: string }>();
  const uniform1fCalls = new Map<string, number[]>();
  const uniform2fCalls = new Map<string, Array<[number, number]>>();
  const uniform3fvCalls = new Map<string, Array<Float32Array | number[]>>();

  const gl = {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLES: 4,
    COLOR_BUFFER_BIT: 16384,
    BLEND: 3042,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 771,
    createShader: vi.fn((type: number) => ({ type })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({ id: 'prog' })),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({ id: 'buf' })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    deleteBuffer: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn((_prog: unknown, name: string) => {
      const loc = { name };
      uniformLocations.set(name, loc);
      return loc;
    }),
    uniform1f: vi.fn((loc: { name: string } | null, v: number) => {
      if (!loc) return;
      const arr = uniform1fCalls.get(loc.name) ?? [];
      arr.push(v);
      uniform1fCalls.set(loc.name, arr);
    }),
    uniform2f: vi.fn((loc: { name: string } | null, x: number, y: number) => {
      if (!loc) return;
      const arr = uniform2fCalls.get(loc.name) ?? [];
      arr.push([x, y]);
      uniform2fCalls.set(loc.name, arr);
    }),
    uniform3fv: vi.fn((loc: { name: string } | null, vec: Float32Array | number[]) => {
      if (!loc) return;
      const arr = uniform3fvCalls.get(loc.name) ?? [];
      arr.push(Array.from(vec));
      uniform3fvCalls.set(loc.name, arr);
    }),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    useProgram: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    drawArrays: vi.fn(),
    __uniformLocations: uniformLocations,
    __uniform1fCalls: uniform1fCalls,
    __uniform2fCalls: uniform2fCalls,
    __uniform3fvCalls: uniform3fvCalls,
  };
  return gl;
}

describe('ComposerVoiceGlow — Ambient Horizon WebGL Glow & Concentric Ring (S1)', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let nowMs: number;
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalRaf: typeof window.requestAnimationFrame;
  let originalCancelRaf: typeof window.cancelAnimationFrame;
  let originalMatchMedia: typeof window.matchMedia;
  let originalDpr: number;

  const flushRaf = (stepMs = 16) => {
    nowMs += stepMs;
    const pending = Array.from(rafCallbacks.entries());
    rafCallbacks.clear();
    for (const [, cb] of pending) {
      cb(nowMs);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 1000;
    nextRafId = 1;
    rafCallbacks = new Map();

    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    originalRaf = window.requestAnimationFrame;
    originalCancelRaf = window.cancelAnimationFrame;
    originalMatchMedia = window.matchMedia;
    originalDpr = window.devicePixelRatio;

    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    window.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-motion');
    document.documentElement.removeAttribute('data-window-state');
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(window, 'devicePixelRatio', { value: originalDpr, configurable: true });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-motion');
    document.documentElement.removeAttribute('data-window-state');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays unmounted with zero cost when active is false initially, and unmounts after fade-out when deactivated', () => {
    const { rerender } = render(
      <ComposerVoiceGlow active={false} muted={false} micLevel={0} speakerLevel={0} />,
    );
    expect(screen.queryByTestId('voice-speaking-glow')).not.toBeInTheDocument();
    expect(rafCallbacks.size).toBe(0);

    rerender(<ComposerVoiceGlow active={true} muted={false} micLevel={0.3} speakerLevel={0} />);
    const glow = screen.getByTestId('voice-speaking-glow');
    expect(glow).toBeInTheDocument();
    expect(glow).toHaveAttribute('data-active', 'true');

    rerender(<ComposerVoiceGlow active={false} muted={false} micLevel={0} speakerLevel={0} />);
    expect(screen.getByTestId('voice-speaking-glow')).toHaveAttribute('data-active', 'false');

    // Step frames/timers until fade-out settles cleanly
    for (let i = 0; i < 40; i += 1) {
      act(() => {
        flushRaf(24);
        vi.advanceTimersByTime(24);
      });
    }
    expect(screen.queryByTestId('voice-speaking-glow')).not.toBeInTheDocument();
  });

  it('renders fallback canvas and concentric ring when WebGL is unavailable and updates CSS glow vars', () => {
    render(
      <ComposerVoiceGlow active={true} muted={false} micLevel={0.4} speakerLevel={0} dark={true} />,
    );

    const glow = screen.getByTestId('voice-speaking-glow');
    expect(glow).toHaveAttribute('data-theme', 'dark');
    expect(glow).toHaveAttribute('data-pushed-down', 'false');

    const canvas = glow.querySelector('canvas.kite-composer-voice-glow__canvas') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute('data-renderer', 'fallback');
    expect(glow.querySelector('.kite-composer-voice-ring')).not.toBeNull();

    act(() => {
      flushRaf(16);
    });
    expect(canvas.style.getPropertyValue('--glow-x')).not.toBe('');
    expect(canvas.style.getPropertyValue('--glow-color')).not.toBe('');
    expect(canvas.style.getPropertyValue('--glow-alpha')).not.toBe('');
  });

  it('initializes WebGL shader uniforms, caps DPR at 2, and respects dark/light + custom palette', () => {
    const gl = createMockWebGLContext();
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    HTMLCanvasElement.prototype.getContext = vi.fn((kind: string) =>
      kind === 'webgl2' || kind === 'webgl' ? gl : null,
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const palette = {
      deep: [0.2, 0.1, 0.6] as [number, number, number],
      core: [0.5, 0.3, 0.9] as [number, number, number],
      glint: [0.9, 0.7, 1.0] as [number, number, number],
    };

    const { rerender, unmount } = render(
      <ComposerVoiceGlow
        active={true}
        muted={false}
        micLevel={0}
        speakerLevel={0.6}
        palette={palette}
        dark={true}
      />,
    );

    const glow = screen.getByTestId('voice-speaking-glow');
    const canvas = glow.querySelector('canvas.kite-composer-voice-glow__canvas') as HTMLCanvasElement;
    expect(canvas).toHaveAttribute('data-renderer', 'webgl');
    expect(canvas.width).toBe(1960);
    expect(canvas.height).toBe(720);

    const expectedUniforms = [
      'uRes',
      'uDpr',
      'uTime',
      'uLevel',
      'uActivity',
      'uMix',
      'uPresence',
      'uDark',
      'uAgentDeep',
      'uAgentCore',
      'uAgentGlint',
    ];
    for (const name of expectedUniforms) {
      expect(gl.__uniformLocations.has(name)).toBe(true);
    }

    act(() => {
      flushRaf(16);
    });
    expect(gl.__uniform1fCalls.get('uDpr')?.slice(-1)[0]).toBe(2);
    expect(gl.__uniform1fCalls.get('uDark')?.slice(-1)[0]).toBe(1);
    expect(gl.__uniform3fvCalls.get('uAgentCore')?.slice(-1)[0]).toEqual([0.5, 0.3, 0.9]);
    expect(gl.drawArrays).toHaveBeenCalled();

    // Switch to light mode via prop
    rerender(
      <ComposerVoiceGlow
        active={true}
        muted={false}
        micLevel={0}
        speakerLevel={0.6}
        palette={palette}
        dark={false}
      />,
    );
    expect(glow).toHaveAttribute('data-theme', 'light');
    for (let i = 0; i < 20; i += 1) {
      act(() => {
        flushRaf(16);
      });
    }
    expect(gl.__uniform1fCalls.get('uDark')?.slice(-1)[0]).toBeLessThan(0.2);

    unmount();
    expect(gl.deleteProgram).toHaveBeenCalled();
  });

  it('steers directional lean left for user (650ms hold) and right for assistant (450ms hold)', () => {
    const { rerender } = render(
      <ComposerVoiceGlow active={true} muted={false} micLevel={0.35} speakerLevel={0} />,
    );
    const glow = screen.getByTestId('voice-speaking-glow');
    const canvas = glow.querySelector('canvas.kite-composer-voice-glow__canvas') as HTMLCanvasElement;

    for (let i = 0; i < 10; i += 1) {
      act(() => {
        flushRaf(16);
      });
    }
    const leftX = parseFloat(canvas.style.getPropertyValue('--glow-x'));
    expect(leftX).toBeLessThan(45);
    expect(glow).toHaveAttribute('data-speaker', 'user');

    // Drop micLevel below threshold; hold lasts 650ms
    rerender(<ComposerVoiceGlow active={true} muted={false} micLevel={0.01} speakerLevel={0} />);
    act(() => {
      flushRaf(300);
    });
    expect(glow).toHaveAttribute('data-speaker', 'user');

    // Past 650ms hold without assistant speech -> returns toward idle center
    act(() => {
      flushRaf(450);
    });
    expect(glow).toHaveAttribute('data-speaker', 'idle');

    // Assistant speaks (speakerLevel > 0.05) -> leans RIGHT with 450ms hold
    rerender(<ComposerVoiceGlow active={true} muted={false} micLevel={0} speakerLevel={0.45} />);
    for (let i = 0; i < 15; i += 1) {
      act(() => {
        flushRaf(16);
      });
    }
    const rightX = parseFloat(canvas.style.getPropertyValue('--glow-x'));
    expect(rightX).toBeGreaterThan(55);
    expect(glow).toHaveAttribute('data-speaker', 'assistant');

    rerender(<ComposerVoiceGlow active={true} muted={false} micLevel={0} speakerLevel={0.01} />);
    act(() => {
      flushRaf(200);
    });
    expect(glow).toHaveAttribute('data-speaker', 'assistant');

    act(() => {
      flushRaf(350);
    });
    expect(glow).toHaveAttribute('data-speaker', 'idle');
  });

  it('activates data-pushed-down when latest visible message bottom is within 140px of glow top', () => {
    let msgBottom = 380;
    const glowTop = 500;

    const Host = ({ withMsg }: { withMsg: boolean }) => {
      const containerRef = React.useRef<HTMLDivElement>(null);
      return (
        <div ref={containerRef}>
          <div data-testid="conversation-view">
            {withMsg ? <article data-testid="msg-latest">Hello</article> : null}
          </div>
          <div className="kite-composer-main">
            <ComposerVoiceGlow
              active={true}
              muted={false}
              micLevel={0.2}
              speakerLevel={0}
              containerRef={containerRef}
            />
          </div>
        </div>
      );
    };

    const { rerender } = render(<Host withMsg={true} />);
    const glow = screen.getByTestId('voice-speaking-glow');
    const transcript = screen.getByTestId('conversation-view');
    const msg = screen.getByTestId('msg-latest');

    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500 }) as DOMRect,
    );
    vi.spyOn(glow, 'getBoundingClientRect').mockImplementation(
      () => ({ top: glowTop, bottom: glowTop + 120, left: 0, right: 800, width: 800, height: 120 }) as DOMRect,
    );
    vi.spyOn(msg, 'getBoundingClientRect').mockImplementation(
      () => ({ top: msgBottom - 40, bottom: msgBottom, left: 0, right: 600, width: 600, height: 40 }) as DOMRect,
    );

    // 500 - 380 = 120 < 140 => pushed down
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(glow).toHaveAttribute('data-pushed-down', 'true');

    // Scroll message up so bottom is 340 => 500 - 340 = 160 >= 140 => cleared
    msgBottom = 340;
    act(() => {
      transcript.dispatchEvent(new Event('scroll'));
    });
    expect(glow).toHaveAttribute('data-pushed-down', 'false');

    // Bring back inside 140px and rerender
    msgBottom = 420;
    rerender(<Host withMsg={true} />);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(glow).toHaveAttribute('data-pushed-down', 'true');
  });

  it('throttles calm RAF >= 33ms, pauses RAF when settled or muted, and wakes on exponential poll or prop change', () => {
    const gl = createMockWebGLContext();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => gl) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const { rerender } = render(
      <ComposerVoiceGlow active={true} muted={false} micLevel={0.3} speakerLevel={0} />,
    );

    // Active speech -> 60fps draws every 16ms
    const drawsBefore = gl.drawArrays.mock.calls.length;
    act(() => {
      flushRaf(16);
      flushRaf(16);
    });
    expect(gl.drawArrays.mock.calls.length - drawsBefore).toBeGreaterThanOrEqual(2);

    // Drop speech to calm; wait past 650ms hold until calm settle
    rerender(<ComposerVoiceGlow active={true} muted={false} micLevel={0} speakerLevel={0} />);
    for (let i = 0; i < 65; i += 1) {
      act(() => {
        flushRaf(16);
      });
    }

    // In calm state, two 16ms ticks only draw at >= 33ms cadence
    const calmBefore = gl.drawArrays.mock.calls.length;
    act(() => {
      flushRaf(16);
      flushRaf(16);
      flushRaf(16);
    });
    const calmRendered = gl.drawArrays.mock.calls.length - calmBefore;
    expect(calmRendered).toBeLessThanOrEqual(2);

    // Continue advancing calm until settled -> RAF pauses completely
    for (let i = 0; i < 80; i += 1) {
      act(() => {
        flushRaf(34);
      });
    }
    expect(rafCallbacks.size).toBe(0);

    // Exponential idle poll schedules 120ms -> 240ms -> 480ms -> 960ms without spinning RAF
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    rerender(<ComposerVoiceGlow active={true} muted={true} micLevel={0.4} speakerLevel={0} />);
    for (let i = 0; i < 20; i += 1) {
      act(() => {
        flushRaf(20);
      });
    }
    expect(rafCallbacks.size).toBe(0);

    // Advance through idle poll delays and confirm backoff increases up to 960ms
    act(() => {
      vi.advanceTimersByTime(120);
      vi.advanceTimersByTime(240);
      vi.advanceTimersByTime(480);
      vi.advanceTimersByTime(960);
    });
    const scheduledDelays = setTimeoutSpy.mock.calls.map((c) => Number(c[1]));
    expect(scheduledDelays).toEqual(expect.arrayContaining([120, 240, 480, 960]));

    // Unmute with speech wakes RAF immediately
    rerender(<ComposerVoiceGlow active={true} muted={false} micLevel={0.5} speakerLevel={0} />);
    expect(rafCallbacks.size).toBeGreaterThan(0);
  });

  it('renders a single static frame with zero continuous RAF when reduced motion is enabled', () => {
    document.documentElement.dataset.motion = 'reduce';
    const gl = createMockWebGLContext();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => gl) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    render(<ComposerVoiceGlow active={true} muted={false} micLevel={0.5} speakerLevel={0} />);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.size).toBe(0);

    // Also verify matchMedia prefers-reduced-motion: reduce
    document.documentElement.removeAttribute('data-motion');
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })) as unknown as typeof window.matchMedia;

    gl.drawArrays.mockClear();
    render(<ComposerVoiceGlow active={true} muted={false} micLevel={0.5} speakerLevel={0} />);
    expect(gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.size).toBe(0);
  });
});
