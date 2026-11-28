import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VoiceTeleprompterDock } from './VoiceTeleprompterDock';
import type { LiveTeleprompterLine } from '../../../../lib/operator/voice/audioSpanSync';

describe('VoiceTeleprompterDock (S2)', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let resizeCallbacks: ResizeObserverCallback[] = [];
  const OriginalResizeObserver = globalThis.ResizeObserver;
  const originalAnimate = Element.prototype.animate;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    document.documentElement.removeAttribute('data-motion');
    rafQueue = [];
    resizeCallbacks = [];

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    globalThis.ResizeObserver = class MockResizeObserver {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      trigger(target: Element, height: number) {
        this.cb(
          [
            {
              target,
              contentRect: { height } as DOMRectReadOnly,
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
    Element.prototype.animate = originalAnimate;
    document.documentElement.removeAttribute('data-motion');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const flushRaf = (ts = 16) => {
    const batch = rafQueue.splice(0, rafQueue.length);
    for (const cb of batch) cb(ts);
  };

  it('mounts safely when Element.prototype.animate is absent and stays mounted during 260ms exit', () => {
    // @ts-expect-error simulating jsdom without WAAPI
    delete Element.prototype.animate;

    const { rerender } = render(
      <VoiceTeleprompterDock
        open={true}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    const dock = screen.getByTestId('voice-teleprompter-dock');
    expect(dock).toBeInTheDocument();
    expect(dock).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByTestId('live-docked-scroll')).toHaveTextContent(
      'Escuchando. Habla cuando quieras.',
    );

    rerender(
      <VoiceTeleprompterDock
        open={false}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    // Still mounted while leaving over 260ms
    expect(screen.getByTestId('voice-teleprompter-dock')).toHaveAttribute('data-leaving', 'true');

    act(() => {
      vi.advanceTimersByTime(259);
    });
    expect(screen.getByTestId('voice-teleprompter-dock')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('voice-teleprompter-dock')).not.toBeInTheDocument();
  });

  it('invokes WAAPI animations when available and exits immediately in reduced motion', () => {
    const cancelSpy = vi.fn();
    const animateSpy = vi.fn().mockReturnValue({ cancel: cancelSpy, onfinish: null });
    Element.prototype.animate = animateSpy;

    const { rerender } = render(
      <VoiceTeleprompterDock
        open={true}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    expect(animateSpy).toHaveBeenCalled();

    document.documentElement.setAttribute('data-motion', 'reduce');
    rerender(
      <VoiceTeleprompterDock
        open={false}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('voice-teleprompter-dock')).not.toBeInTheDocument();
  });

  it('toggles collapse state via VoiceCallBar button and resizes scroll area via ResizeObserver', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    render(
      <VoiceTeleprompterDock
        open={true}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    const dock = screen.getByTestId('voice-teleprompter-dock');
    const scrollEl = screen.getByTestId('live-docked-scroll');
    const collapseBtn = screen.getByTestId('voice-teleprompter-collapse');

    // Initial min height 168px
    expect(scrollEl.style.height).toBe('168px');

    // Trigger ResizeObserver with contentHeight = 250 -> clamped to min(800*0.45=360, 340) = 340 vs 270
    act(() => {
      for (const cb of resizeCallbacks) {
        cb(
          [
            {
              target: scrollEl,
              contentRect: { height: 250 } as DOMRectReadOnly,
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
    });
    expect(scrollEl.style.height).toBe('270px');

    // Trigger huge contentHeight -> capped at 340px
    act(() => {
      for (const cb of resizeCallbacks) {
        cb(
          [
            {
              target: scrollEl,
              contentRect: { height: 600 } as DOMRectReadOnly,
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
    });
    expect(scrollEl.style.height).toBe('340px');

    fireEvent.click(collapseBtn);
    expect(dock).toHaveAttribute('data-collapsed', 'true');
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(collapseBtn);
    expect(dock).toHaveAttribute('data-collapsed', 'false');
    expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
  });

  it('handles user turn 700ms post-speech fade into Pensando and cross-fades to agent reply', () => {
    const userSpeaking: LiveTeleprompterLine = {
      seq: 1,
      kind: 'user',
      text: 'Revisame los tests del proyecto',
      timeMs: 1000,
      interim: true,
    };

    const { rerender } = render(
      <VoiceTeleprompterDock
        open={true}
        showUserTurns={true}
        lines={[userSpeaking]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    expect(screen.getByTestId('live-user-turn')).toHaveTextContent('Revisame los tests del proyecto');
    expect(screen.getByTestId('live-user-turn')).toHaveAttribute('data-leaving', 'false');

    // User finishes speaking
    rerender(
      <VoiceTeleprompterDock
        open={true}
        showUserTurns={true}
        lines={[{ ...userSpeaking, interim: false }]}
        isThinking={true}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    // Held 700ms during fade-out
    expect(screen.getByTestId('live-user-turn')).toHaveAttribute('data-leaving', 'true');

    act(() => {
      vi.advanceTimersByTime(700);
    });

    const thinking = screen.getByTestId('live-thinking-turn');
    expect(thinking).toHaveTextContent('Pensando');
    expect(thinking.querySelectorAll('.kite-voice-teleprompter__dot')).toHaveLength(3);

    // Assistant reply starts
    rerender(
      <VoiceTeleprompterDock
        open={true}
        lines={[
          { ...userSpeaking, interim: false },
          {
            seq: 2,
            kind: 'voice',
            text: 'Listo, revisé la carpeta. Todos los tests pasaron.',
            timeMs: 2000,
            audioSpans: [{ startAt: 0, endAt: 4, talkerDur: 4 }],
            talkerDuration: 4,
          },
        ]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );

    expect(screen.getByTestId('live-agent-turn')).toBeInTheDocument();
  });

  it('syncs word karaoke with getAudioTime and freezes at spokenChars on barge-in', () => {
    let audioTime = 0;
    const line: LiveTeleprompterLine = {
      seq: 10,
      kind: 'voice',
      text: 'Hola mundo. Seguimos trabajando hoy.',
      timeMs: 1000,
      audioSpans: [{ startAt: 0, endAt: 4, talkerDur: 4 }],
      talkerDuration: 4,
    };

    const { rerender } = render(
      <VoiceTeleprompterDock
        open={true}
        lines={[line]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => audioTime}
      />,
    );

    const agentTurn = screen.getByTestId('live-agent-turn');
    expect(agentTurn.querySelector('.kite-voice-teleprompter__paragraph--lead')).toHaveTextContent(
      'Hola mundo.',
    );
    expect(agentTurn.querySelector('.kite-voice-teleprompter__paragraph--body')).toHaveTextContent(
      'Seguimos trabajando hoy.',
    );

    // At t=0: first word carries live cursor
    let cursorWord = agentTurn.querySelector('[data-live-cursor="true"]');
    expect(cursorWord).toHaveTextContent('Hola');

    // Advance audio time to halfway (~18 chars spoken: "Hola mundo. Seguim")
    audioTime = 2.0;
    act(() => {
      flushRaf(16);
    });

    const spokenWords = Array.from(
      agentTurn.querySelectorAll('.kite-voice-teleprompter__word--spoken'),
    ).map((el) => el.textContent);
    expect(spokenWords).toEqual(['Hola', 'mundo.', 'Seguimos']);
    cursorWord = agentTurn.querySelector('[data-live-cursor="true"]');
    expect(cursorWord).toHaveTextContent('trabajando');

    // Barge-in freezes spokenChars at 5 ("Hola ")
    audioTime = 4.0;
    rerender(
      <VoiceTeleprompterDock
        open={true}
        lines={[{ ...line, spokenChars: 5 }]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => audioTime}
      />,
    );

    act(() => {
      flushRaf(32);
    });

    const frozenSpoken = Array.from(
      agentTurn.querySelectorAll('.kite-voice-teleprompter__word--spoken'),
    ).map((el) => el.textContent);
    expect(frozenSpoken).toEqual(['Hola']);
  });

  it('auto-scrolls smoothly toward live cursor, yields on wheel, and re-attaches within 16px of bottom', () => {
    let audioTime = 2.0;
    const line: LiveTeleprompterLine = {
      seq: 20,
      kind: 'voice',
      text: 'Uno dos tres cuatro cinco seis.',
      timeMs: 1000,
      audioSpans: [{ startAt: 0, endAt: 4, talkerDur: 4 }],
      talkerDuration: 4,
    };

    render(
      <VoiceTeleprompterDock
        open={true}
        lines={[line]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => audioTime}
      />,
    );

    const scrollEl = screen.getByTestId('live-docked-scroll');
    Object.defineProperty(scrollEl, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(scrollEl, 'scrollHeight', { configurable: true, value: 600 });
    scrollEl.scrollTop = 50;

    scrollEl.getBoundingClientRect = () =>
      ({ top: 100, bottom: 300, left: 0, right: 400, width: 400, height: 200 } as DOMRect);

    const cursorEl = scrollEl.querySelector('[data-live-cursor="true"]') as HTMLElement;
    expect(cursorEl).not.toBeNull();
    // target = 200 * 0.45 = 90 below scroll top (100 + 90 = 190). Cursor at 290 -> delta = +100
    cursorEl.getBoundingClientRect = () =>
      ({ top: 290, bottom: 308, left: 10, right: 60, width: 50, height: 18 } as DOMRect);

    act(() => {
      flushRaf(16);
    });
    // 50 + 100 * 0.14 = 64
    expect(scrollEl.scrollTop).toBeCloseTo(64, 2);

    // User wheel yields auto-scroll immediately
    fireEvent.wheel(scrollEl, { deltaY: -40 });
    act(() => {
      flushRaf(32);
    });
    expect(scrollEl.scrollTop).toBeCloseTo(64, 2);

    // User scrolls back within 16px of bottom (600 - 200 - 10 = 390) -> re-attaches
    scrollEl.scrollTop = 390;
    fireEvent.scroll(scrollEl);

    // Move cursor to simulate continuing speech
    scrollEl.scrollTop = 100;
    act(() => {
      flushRaf(48);
    });
    expect(scrollEl.scrollTop).toBeCloseTo(114, 2);

    // Also yields on touchMove
    fireEvent.touchMove(scrollEl);
    act(() => {
      flushRaf(64);
    });
    expect(scrollEl.scrollTop).toBeCloseTo(114, 2);
  });

  it('supports wall-clock fallback without getAudioTime and renders linkPhase/statusHint idle states', () => {
    const { rerender } = render(
      <VoiceTeleprompterDock
        open={true}
        lines={[]}
        linkPhase="connecting"
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('live-docked-scroll')).toHaveTextContent('Conectando…');

    rerender(
      <VoiceTeleprompterDock
        open={true}
        lines={[]}
        statusHint="Micrófono silenciado temporalmente"
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('live-docked-scroll')).toHaveTextContent(
      'Micrófono silenciado temporalmente',
    );

    const nowSec = Date.now() / 1000;
    rerender(
      <VoiceTeleprompterDock
        open={true}
        lines={[
          {
            seq: 99,
            kind: 'voice',
            text: 'Uno dos tres cuatro.',
            timeMs: Date.now(),
            utteranceStart: nowSec - 2,
            utteranceEnd: nowSec + 2,
          },
        ]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    const agentTurn = screen.getByTestId('live-agent-turn');
    expect(agentTurn.querySelectorAll('.kite-voice-teleprompter__word--spoken').length).toBeGreaterThan(0);

    // Wall-clock epoch utteranceStart advances even when getAudioTime() returns 0 (cascaded fallback)
    rerender(
      <VoiceTeleprompterDock
        open={true}
        lines={[
          {
            seq: 100,
            kind: 'voice',
            text: 'Uno dos tres cuatro.',
            timeMs: Date.now(),
            utteranceStart: nowSec - 2,
            talkerDuration: 2,
          },
        ]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );
    expect(screen.getByTestId('live-agent-turn').querySelectorAll('.kite-voice-teleprompter__word--spoken')).toHaveLength(4);

    // Explicit spokenChars marks full cascaded text as spoken immediately (e.g. muted / TTS off)
    rerender(
      <VoiceTeleprompterDock
        open={true}
        lines={[
          {
            seq: 101,
            kind: 'voice',
            text: 'Respuesta directa completa.',
            timeMs: Date.now(),
            spokenChars: 'Respuesta directa completa.'.length,
          },
        ]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );
    expect(screen.getByTestId('live-agent-turn').querySelectorAll('.kite-voice-teleprompter__word--spoken')).toHaveLength(3);
  });

  it('renders agent-only mic hint, transcribing, and Thinking states without duplicating user speech', () => {
    const { rerender } = render(
      <VoiceTeleprompterDock
        open={true}
        isListening={true}
        micMuted={false}
        micLevel={0.18}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );

    const dock = screen.getByTestId('voice-teleprompter-dock');
    // Stays calm during startup settle before committing to sustained user speech
    expect(screen.getByText('Escuchando. Habla cuando quieras.')).toBeInTheDocument();
    expect(screen.getByTestId('live-turn-speaker')).toHaveTextContent('Argos');

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(dock).toHaveAttribute('data-speaker', 'you');
    expect(screen.getByText('Escuchando tu voz…')).toBeInTheDocument();
    // Agent-only box speaker badge stays stably Argos when showUserTurns is disabled
    expect(screen.getByTestId('live-turn-speaker')).toHaveTextContent('Argos');

    // Default showUserTurns=false keeps spoken user text strictly inside the bottom composer input
    rerender(
      <VoiceTeleprompterDock
        open={true}
        isListening={true}
        isTranscribing={true}
        micMuted={false}
        micLevel={0.18}
        lines={[
          {
            seq: 200,
            kind: 'user',
            text: 'Abre el panel',
            interim: true,
            timeMs: Date.now(),
          },
        ]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );

    expect(screen.queryByTestId('live-user-turn')).toBeNull();
    expect(screen.queryByTestId('live-user-echo')).toBeNull();
    expect(screen.getByText('Escuchando tu voz…')).toBeInTheDocument();
    expect(screen.getByTestId('voice-teleprompter-dock')).toHaveAttribute('data-speaker', 'you');

    // Waiting on post-capture STT shows live-transcribing-turn without user text echo
    rerender(
      <VoiceTeleprompterDock
        open={true}
        isTranscribing={true}
        micLevel={0.04}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );

    const transcribingTurn = screen.getByTestId('live-transcribing-turn');
    expect(transcribingTurn).toBeInTheDocument();
    expect(transcribingTurn).toHaveTextContent('Transcribiendo tu voz');
    expect(screen.queryByTestId('live-user-echo')).toBeNull();

    // Once user speech commits and agent thinks before replying, show Pensando without duplicating user speech
    rerender(
      <VoiceTeleprompterDock
        open={true}
        isTranscribing={false}
        isThinking={true}
        micLevel={0.01}
        lines={[
          {
            seq: 201,
            kind: 'user',
            text: 'Abre el panel de agentes',
            interim: false,
            timeMs: Date.now(),
          },
        ]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );

    const thinkingTurn = screen.getByTestId('live-thinking-turn');
    expect(thinkingTurn).toHaveTextContent('Pensando');
    expect(screen.queryByTestId('live-user-echo')).toBeNull();
    expect(screen.queryByTestId('live-user-turn')).toBeNull();

    // Explicit opt-in showUserTurns={true} preserves live-user-echo compatibility
    rerender(
      <VoiceTeleprompterDock
        open={true}
        showUserTurns={true}
        isTranscribing={false}
        isThinking={true}
        micLevel={0.01}
        lines={[
          {
            seq: 201,
            kind: 'user',
            text: 'Abre el panel de agentes',
            interim: false,
            timeMs: Date.now(),
          },
        ]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
        getAudioTime={() => 0}
      />,
    );

    const echo = screen.getByTestId('live-user-echo');
    expect(echo).toBeInTheDocument();
    expect(echo).toHaveTextContent('Abre el panel de agentes');
  });

  it('eliminates startup idle-copy flicker across rapid micLevel spikes and holds active speech smoothly', () => {
    const observedIdleTexts: string[] = [];
    const { rerender } = render(
      <VoiceTeleprompterDock
        open={true}
        isListening={true}
        micMuted={false}
        micLevel={0.02}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );

    const readIdleText = () =>
      document.querySelector('.kite-voice-teleprompter__idle')?.textContent ?? '';

    observedIdleTexts.push(readIdleText());

    // Simulate 12 rapid AGC/noise oscillations (0.14 <-> 0.02 every 150ms across 1.8s)
    for (let step = 0; step < 12; step += 1) {
      const nextLevel = step % 2 === 0 ? 0.14 : 0.02;
      rerender(
        <VoiceTeleprompterDock
          open={true}
          isListening={true}
          micMuted={false}
          micLevel={nextLevel}
          lines={[]}
          playbackSpeed={1}
          onChangePlaybackSpeed={vi.fn()}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(150);
      });
      observedIdleTexts.push(readIdleText());
    }

    const distinctAtStartup = new Set(observedIdleTexts);
    expect(Array.from(distinctAtStartup)).toEqual(['Escuchando. Habla cuando quieras.']);
    expect(screen.getByTestId('live-turn-speaker')).toHaveTextContent('Argos');

    // Sustained speech (0.16 >= enter threshold for 300ms after startup settle) switches cleanly once
    rerender(
      <VoiceTeleprompterDock
        open={true}
        isListening={true}
        micMuted={false}
        micLevel={0.16}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(280);
    });
    expect(readIdleText()).toBe('Escuchando tu voz…');

    // Brief 800ms pause keeps Escuchando tu voz… without dropping back prematurely
    rerender(
      <VoiceTeleprompterDock
        open={true}
        isListening={true}
        micMuted={false}
        micLevel={0.02}
        lines={[]}
        playbackSpeed={1}
        onChangePlaybackSpeed={vi.fn()}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(readIdleText()).toBe('Escuchando tu voz…');

    // Completing the 1600ms hold transitions calmly back to idle prompt
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(readIdleText()).toBe('Escuchando. Habla cuando quieras.');
  });
});
