import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './ComposerVoiceGlow.css';
import {
  DEFAULT_VOICE_GLOW_PALETTE,
  VoiceGlowWebGLRenderer,
  type VoiceGlowPalette,
} from './composerVoiceGlowShader';

export { DEFAULT_VOICE_GLOW_PALETTE, type VoiceGlowPalette };

export interface ComposerVoiceGlowProps {
  active: boolean;
  muted: boolean;
  micLevel: number;
  speakerLevel: number;
  palette?: VoiceGlowPalette;
  dark?: boolean;
  containerRef?: React.RefObject<HTMLElement | null>;
}

export type GlowSpeakerFocus = 'user' | 'assistant' | 'idle';

export const VOICE_GLOW_WIDTH = 980;
export const VOICE_GLOW_HEIGHT = 360;
export const VOICE_GLOW_PUSH_THRESHOLD_PX = 140;
export const USER_SPEECH_HOLD_MS = 650;
export const ASSISTANT_SPEECH_HOLD_MS = 450;
export const USER_SPEECH_THRESHOLD = 0.04;
export const ASSISTANT_SPEECH_THRESHOLD = 0.05;

const CALM_FRAME_INTERVAL_MS = 33;
const CALM_TRANSITION_EPSILON = 0.008;
const CALM_SETTLE_DELAY_MS = 1800;
const IDLE_POLL_SEQUENCE_MS = [120, 240, 480, 960] as const;

const USER_CYAN_CORE: [number, number, number] = [0.14, 0.76, 0.96];

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function resolveIsDarkTheme(darkProp?: boolean): boolean {
  if (typeof darkProp === 'boolean') return darkProp;
  return typeof document === 'undefined' || document.documentElement.getAttribute('data-theme') !== 'light';
}

export function isVoiceGlowMotionReduced(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

const isWindowPaused = (): boolean =>
  typeof document !== 'undefined' &&
  (document.hidden || document.documentElement.getAttribute('data-window-state') === 'minimized');

function findTranscriptElement(
  rootEl: HTMLElement | null,
  containerRef?: React.RefObject<HTMLElement | null>,
): HTMLElement | null {
  const selector = '.chat-transcript, [data-testid="conversation-view"]';
  const refEl = containerRef?.current;
  if (refEl) {
    if (refEl.matches(selector)) return refEl;
    return refEl.querySelector<HTMLElement>(selector) ?? refEl.closest<HTMLElement>(selector) ?? refEl;
  }
  let cursor = rootEl?.parentElement ?? null;
  for (let depth = 0; depth < 7 && cursor; depth += 1) {
    if (cursor.matches(selector)) return cursor;
    const match = cursor.querySelector<HTMLElement>(selector);
    if (match) return match;
    cursor = cursor.parentElement;
  }
  return null;
}

function findLatestVisibleMessageRect(transcriptEl: HTMLElement, wrapperEl: HTMLElement): DOMRect | null {
  const transcriptRect = transcriptEl.getBoundingClientRect();
  const tagged = Array.from(
    transcriptEl.querySelectorAll<HTMLElement>(
      '.chat-turn, article, [data-testid="chat-message"], [data-message-id], [data-role="message"]',
    ),
  );
  const host = transcriptEl.querySelector<HTMLElement>('.chat-transcript__column') ?? transcriptEl;
  const candidates =
    tagged.length > 0
      ? tagged
      : Array.from(host.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            !child.classList.contains('chat-transcript__earlier') &&
            child !== wrapperEl &&
            !child.contains(wrapperEl),
        );

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const node = candidates[i];
    if (node.offsetParent === null && getComputedStyle(node).display === 'none') continue;
    const rect = node.getBoundingClientRect();
    if (transcriptRect.height > 0 && (rect.bottom <= transcriptRect.top || rect.top >= transcriptRect.bottom)) {
      continue;
    }
    return rect;
  }
  return null;
}

interface GlowAnimState {
  startTimeMs: number;
  lastTickMs: number;
  lastRenderMs: number;
  lastUserSpeechAt: number;
  lastAssistantSpeechAt: number;
  calmSinceMs: number | null;
  level: number;
  activity: number;
  mix: number;
  presence: number;
  dark: number;
}

interface GlowTargets {
  focus: GlowSpeakerFocus;
  isSpeakingOrHeld: boolean;
  isSpeakingNow: boolean;
  targetLevel: number;
  targetActivity: number;
  targetMix: number;
  targetPresence: number;
  targetDark: number;
}

function computeGlowTargets(
  p: { active: boolean; muted: boolean; micLevel: number; speakerLevel: number; isDark: boolean },
  st: GlowAnimState,
  now: number,
): GlowTargets {
  const effectiveMic = p.muted ? 0 : clamp01(p.micLevel);
  const effectiveSpeaker = clamp01(p.speakerLevel);
  const userActiveNow = effectiveMic > USER_SPEECH_THRESHOLD;
  const assistantActiveNow = effectiveSpeaker > ASSISTANT_SPEECH_THRESHOLD;
  if (userActiveNow) st.lastUserSpeechAt = now;
  if (assistantActiveNow) st.lastAssistantSpeechAt = now;

  const userHold = now - st.lastUserSpeechAt <= USER_SPEECH_HOLD_MS;
  const assistantHold = now - st.lastAssistantSpeechAt <= ASSISTANT_SPEECH_HOLD_MS;
  let focus: GlowSpeakerFocus = 'idle';
  let targetMix = 0.5;
  if (userHold && assistantHold) {
    focus = st.lastUserSpeechAt >= st.lastAssistantSpeechAt ? 'user' : 'assistant';
    targetMix = focus === 'user' ? 0.0 : 1.0;
  } else if (userHold) {
    focus = 'user';
    targetMix = 0.0;
  } else if (assistantHold) {
    focus = 'assistant';
    targetMix = 1.0;
  }

  const speechLevel = Math.max(effectiveMic, effectiveSpeaker);
  const isSpeakingOrHeld = focus !== 'idle';
  const mutedCalm = p.muted && !assistantActiveNow;
  return {
    focus,
    isSpeakingOrHeld,
    isSpeakingNow: userActiveNow || assistantActiveNow,
    targetLevel: !p.active ? 0 : mutedCalm ? 0.02 : isSpeakingOrHeld ? clamp01(0.36 + speechLevel * 0.64) : 0.24,
    targetActivity: !p.active ? 0 : mutedCalm ? 0 : isSpeakingOrHeld ? clamp01(0.52 + speechLevel * 0.48) : 0.34,
    targetMix,
    targetPresence: !p.active ? 0 : mutedCalm ? 0.35 : 1.0,
    targetDark: p.isDark ? 1.0 : 0.0,
  };
}

function applyFallbackAndRingStyles(
  canvas: HTMLCanvasElement | null,
  wrapper: HTMLDivElement | null,
  st: GlowAnimState,
  pal: VoiceGlowPalette,
): void {
  if (!canvas || !wrapper) return;
  const xPercent = (50 + (st.mix - 0.5) * 52).toFixed(1);
  const r = Math.round(lerp(USER_CYAN_CORE[0], pal.core[0], st.mix) * 255);
  const g = Math.round(lerp(USER_CYAN_CORE[1], pal.core[1], st.mix) * 255);
  const b = Math.round(lerp(USER_CYAN_CORE[2], pal.core[2], st.mix) * 255);
  const alpha = clamp01((st.dark > 0.5 ? 0.34 + st.level * 0.42 : 0.24 + st.level * 0.3) * st.presence);
  const ringAlpha = clamp01((0.35 + st.level * 0.55) * st.presence);

  canvas.style.setProperty('--glow-x', `${xPercent}%`);
  canvas.style.setProperty('--glow-color', `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
  canvas.style.setProperty('--glow-alpha', alpha.toFixed(3));
  wrapper.style.setProperty('--glow-wrapper-alpha', st.presence.toFixed(3));
  wrapper.style.setProperty('--glow-ring-alpha', ringAlpha.toFixed(3));
  wrapper.style.setProperty('--glow-ring-border', `rgba(${r}, ${g}, ${b}, ${(ringAlpha * 0.58).toFixed(3)})`);
  wrapper.style.setProperty('--glow-ring-shadow', `rgba(${r}, ${g}, ${b}, ${(ringAlpha * 0.45).toFixed(3)})`);
}

const maxTargetDelta = (st: GlowAnimState, t: GlowTargets): number =>
  Math.max(
    Math.abs(st.level - t.targetLevel),
    Math.abs(st.activity - t.targetActivity),
    Math.abs(st.mix - t.targetMix),
    Math.abs(st.presence - t.targetPresence),
    Math.abs(st.dark - t.targetDark),
  );

export const ComposerVoiceGlow: React.FC<ComposerVoiceGlowProps> = ({
  active,
  muted,
  micLevel,
  speakerLevel,
  palette = DEFAULT_VOICE_GLOW_PALETTE,
  dark,
  containerRef,
}) => {
  const [mounted, setMounted] = useState<boolean>(active);
  const [rendererKind, setRendererKind] = useState<'webgl' | 'fallback'>('fallback');
  const [pushedDown, setPushedDown] = useState<boolean>(false);
  const [speakerFocus, setSpeakerFocus] = useState<GlowSpeakerFocus>('idle');
  const [isDark, setIsDark] = useState<boolean>(() => resolveIsDarkTheme(dark));

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<VoiceGlowWebGLRenderer | null>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const speakerFocusRef = useRef<GlowSpeakerFocus>('idle');
  const hasMountedWakeEffectRef = useRef(false);

  const propsRef = useRef({ active, muted, micLevel, speakerLevel, palette, isDark });
  propsRef.current = { active, muted, micLevel, speakerLevel, palette, isDark };

  const animRef = useRef<GlowAnimState>({
    startTimeMs: performance.now(),
    lastTickMs: performance.now(),
    lastRenderMs: 0,
    lastUserSpeechAt: -Infinity,
    lastAssistantSpeechAt: -Infinity,
    calmSinceMs: null,
    level: 0,
    activity: 0,
    mix: 0.5,
    presence: active ? 1 : 0,
    dark: resolveIsDarkTheme(dark) ? 1 : 0,
  });

  useEffect(() => {
    if (active) {
      setMounted(true);
      wakeRef.current?.();
      return;
    }
    if (!mounted) return;
    if (isVoiceGlowMotionReduced()) {
      setMounted(false);
      return;
    }
    wakeRef.current?.();
    const safetyTimer = setTimeout(() => setMounted(false), 650);
    return () => clearTimeout(safetyTimer);
  }, [active, mounted]);

  useEffect(() => {
    setIsDark(resolveIsDarkTheme(dark));
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (typeof dark !== 'boolean') setIsDark(resolveIsDarkTheme(undefined));
      wakeRef.current?.();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    return () => observer.disconnect();
  }, [dark]);

  useEffect(() => {
    if (!mounted || !canvasRef.current) return;
    const renderer = new VoiceGlowWebGLRenderer(canvasRef.current);
    if (renderer.isReady()) {
      renderer.resize(VOICE_GLOW_WIDTH, VOICE_GLOW_HEIGHT, window.devicePixelRatio || 1);
      rendererRef.current = renderer;
      setRendererKind('webgl');
    } else {
      renderer.dispose();
      rendererRef.current = null;
      setRendererKind('fallback');
    }
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [mounted]);

  useLayoutEffect(() => {
    if (!mounted || !wrapperRef.current) {
      setPushedDown(false);
      return;
    }
    const wrapperEl = wrapperRef.current;
    const measure = () => {
      const transcriptEl = findTranscriptElement(wrapperEl, containerRef);
      const msgRect = transcriptEl ? findLatestVisibleMessageRect(transcriptEl, wrapperEl) : null;
      if (!msgRect) {
        setPushedDown(false);
        return;
      }
      const glowRect = wrapperEl.getBoundingClientRect();
      const hasMetrics = glowRect.top !== 0 || glowRect.bottom !== 0 || msgRect.bottom !== 0 || msgRect.height !== 0;
      setPushedDown(hasMetrics && glowRect.top - msgRect.bottom < VOICE_GLOW_PUSH_THRESHOLD_PX);
    };

    measure();
    const transcriptEl = findTranscriptElement(wrapperEl, containerRef);
    const mutationObserver =
      transcriptEl && typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null;
    if (mutationObserver && transcriptEl) {
      mutationObserver.observe(transcriptEl, { childList: true, subtree: true, characterData: true });
    }
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(wrapperEl);
    if (transcriptEl) resizeObserver?.observe(transcriptEl);

    transcriptEl?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure, { passive: true });
    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      transcriptEl?.removeEventListener('scroll', measure);
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [mounted, containerRef]);

  useEffect(() => {
    if (!mounted) return;
    let disposed = false, rafId = 0, isRunning = false, idlePollIndex = 0;
    let idleTimerId: ReturnType<typeof setTimeout> | null = null;

    const clearIdlePoll = () => {
      if (idleTimerId !== null) {
        clearTimeout(idleTimerId);
        idleTimerId = null;
      }
    };

    const syncTargets = (now: number) => {
      const targets = computeGlowTargets(propsRef.current, animRef.current, now);
      if (targets.focus !== speakerFocusRef.current) {
        speakerFocusRef.current = targets.focus;
        setSpeakerFocus(targets.focus);
      }
      return targets;
    };

    const stepAndRender = (now: number, snap = false) => {
      const st = animRef.current;
      const dtSec = Math.min(Math.max((now - st.lastTickMs) * 0.001, 0.001), 0.1);
      st.lastTickMs = now;
      const targets = syncTargets(now);
      if (snap) {
        st.level = targets.targetLevel;
        st.activity = targets.targetActivity;
        st.mix = targets.targetMix;
        st.presence = targets.targetPresence;
        st.dark = targets.targetDark;
      } else {
        const fastRate = 1 - Math.exp(-dtSec * 14);
        const mixRate = 1 - Math.exp(-dtSec * 12);
        const fadeRate = propsRef.current.muted ? fastRate : 1 - Math.exp(-dtSec * 10);
        st.level = lerp(st.level, targets.targetLevel, fastRate);
        st.activity = lerp(st.activity, targets.targetActivity, fastRate);
        st.mix = lerp(st.mix, targets.targetMix, mixRate);
        st.presence = lerp(st.presence, targets.targetPresence, fadeRate);
        st.dark = lerp(st.dark, targets.targetDark, fastRate);
      }

      const pal = propsRef.current.palette ?? DEFAULT_VOICE_GLOW_PALETTE;
      const renderer = rendererRef.current;
      if (renderer && renderer.isReady()) {
        renderer.resize(VOICE_GLOW_WIDTH, VOICE_GLOW_HEIGHT, window.devicePixelRatio || 1);
        renderer.render({
          time: (now - st.startTimeMs) * 0.001,
          level: st.level,
          activity: st.activity,
          mix: st.mix,
          presence: st.presence,
          dark: st.dark,
          palette: pal,
        });
      }
      applyFallbackAndRingStyles(canvasRef.current, wrapperRef.current, st, pal);
      st.lastRenderMs = now;
      return { targets, delta: maxTargetDelta(st, targets) };
    };

    const scheduleIdlePoll = () => {
      clearIdlePoll();
      if (disposed || isVoiceGlowMotionReduced() || isWindowPaused() || !propsRef.current.active) return;
      const delay = IDLE_POLL_SEQUENCE_MS[Math.min(idlePollIndex, IDLE_POLL_SEQUENCE_MS.length - 1)];
      idleTimerId = setTimeout(() => {
        idleTimerId = null;
        if (disposed || isRunning) return;
        const p = propsRef.current;
        if ((!p.muted && p.micLevel > USER_SPEECH_THRESHOLD) || p.speakerLevel > ASSISTANT_SPEECH_THRESHOLD) {
          idlePollIndex = 0;
          startLoop();
          return;
        }
        idlePollIndex = Math.min(idlePollIndex + 1, IDLE_POLL_SEQUENCE_MS.length - 1);
        scheduleIdlePoll();
      }, delay);
    };

    const tick = (now: number) => {
      if (disposed) return;
      if (isWindowPaused()) {
        isRunning = false;
        return;
      }
      if (isVoiceGlowMotionReduced()) {
        isRunning = false;
        stepAndRender(now, true);
        return;
      }

      const st = animRef.current;
      const preTargets = syncTargets(now);
      const isHighFreq = !propsRef.current.active || preTargets.isSpeakingOrHeld || maxTargetDelta(st, preTargets) > CALM_TRANSITION_EPSILON;
      if (!isHighFreq && st.lastRenderMs > 0 && now - st.lastRenderMs < CALM_FRAME_INTERVAL_MS) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }

      const { targets, delta } = stepAndRender(now, false);
      if (!propsRef.current.active && st.presence <= 0.004) {
        isRunning = false;
        setMounted(false);
        return;
      }
      if (propsRef.current.muted && !targets.isSpeakingNow && !targets.isSpeakingOrHeld && delta <= 0.004) {
        isRunning = false;
        scheduleIdlePoll();
        return;
      }
      if (propsRef.current.active && !targets.isSpeakingOrHeld && delta <= CALM_TRANSITION_EPSILON) {
        if (st.calmSinceMs === null) st.calmSinceMs = now;
        if (now - st.calmSinceMs >= CALM_SETTLE_DELAY_MS && delta <= 0.004) {
          isRunning = false;
          scheduleIdlePoll();
          return;
        }
      } else {
        st.calmSinceMs = null;
      }
      rafId = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (disposed || isWindowPaused()) return;
      clearIdlePoll();
      if (isVoiceGlowMotionReduced()) {
        stepAndRender(performance.now(), true);
        if (!propsRef.current.active) setMounted(false);
        return;
      }
      if (isRunning) return;
      isRunning = true;
      animRef.current.lastTickMs = performance.now();
      rafId = window.requestAnimationFrame(tick);
    };

    wakeRef.current = () => {
      idlePollIndex = 0;
      animRef.current.calmSinceMs = null;
      startLoop();
    };
    const onVisibilityChange = () => {
      if (!isWindowPaused()) wakeRef.current?.();
    };

    if (isVoiceGlowMotionReduced()) {
      stepAndRender(performance.now(), true);
    } else {
      startLoop();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      isRunning = false;
      wakeRef.current = null;
      clearIdlePoll();
      window.cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted) {
      hasMountedWakeEffectRef.current = false;
      return;
    }
    if (!hasMountedWakeEffectRef.current) {
      hasMountedWakeEffectRef.current = true;
      return;
    }
    wakeRef.current?.();
  }, [mounted, active, muted, micLevel, speakerLevel, palette, isDark]);

  if (!mounted) return null;

  return (
    <div
      ref={wrapperRef}
      data-testid="voice-speaking-glow"
      data-active={active ? 'true' : 'false'}
      data-theme={isDark ? 'dark' : 'light'}
      data-pushed-down={pushedDown ? 'true' : 'false'}
      data-speaker={speakerFocus}
      className="kite-composer-voice-glow"
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        data-renderer={rendererKind}
        className="kite-composer-voice-glow__canvas"
      />
      <div className="kite-composer-voice-ring" />
    </div>
  );
};
