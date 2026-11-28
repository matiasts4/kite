import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './VoiceTeleprompterDock.css';
import { prefersReducedMotion } from '../../../../motion/contract';
import {
  computeSpokenCharCount,
  selectTeleprompterTurnView,
  splitTeleprompterParagraphs,
  tokenizeTeleprompterParagraph,
  type LiveTeleprompterLine,
} from '../../../../lib/operator/voice/audioSpanSync';
import { VoiceCallBar } from './VoiceCallBar';
import { VoiceWaveRibbon } from './VoiceWaveRibbon';
import { DEFAULT_VOICE_GLOW_PALETTE, type VoiceGlowPalette } from './composerVoiceGlowShader';

export interface VoiceTeleprompterDockProps {
  open: boolean;
  lines: LiveTeleprompterLine[];
  showUserTurns?: boolean;
  isThinking?: boolean;
  isTranscribing?: boolean;
  isListening?: boolean;
  speakerMuted?: boolean;
  micMuted?: boolean;
  speakerLevel?: number;
  micLevel?: number;
  voicePalette?: VoiceGlowPalette;
  startedAt?: number;
  linkPhase?: 'connecting' | 'reconnecting';
  micPrompt?: boolean;
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  onToggleMicMuted?: () => void;
  onToggleSpeakerMuted?: () => void;
  onEndSession?: () => void;
  showCallActions?: boolean;
  getAudioTime?: () => number;
  statusHint?: string;
  className?: string;
}

const ENTER_MS = 460;
const EXIT_MS = 260;
const USER_POST_SPEECH_FADE_MS = 700;
const SCROLL_SPRING_DAMPING = 0.14;
const SCROLL_TARGET_RATIO = 0.45;
const SCROLL_REATTACH_THRESHOLD_PX = 16;

export const MIC_SPEECH_ENTER_THRESHOLD = 0.12;
export const MIC_SPEECH_EXIT_THRESHOLD = 0.05;
export const MIC_SPEECH_ENTER_DELAY_MS = 280;
export const MIC_SPEECH_HOLD_MS = 1600;
export const MIC_STARTUP_SETTLE_MS = 400;

function computeTeleprompterScrollHeight(contentHeight: number): number {
  const viewportHeight = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
  const maxHeight = Math.min(viewportHeight * 0.45, 340);
  return Math.round(Math.max(168, Math.min(maxHeight, contentHeight + 20)));
}

function cancelAnimations(animations: Array<Animation | undefined | null>) {
  for (const anim of animations) {
    if (!anim) continue;
    try {
      anim.cancel();
    } catch {
      // ignore partial WAAPI mock failures
    }
  }
}

function runElementAnimation(
  el: Element | null,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | undefined {
  if (!el || typeof el.animate !== 'function') return undefined;
  return el.animate(keyframes, options);
}

function clearWindowTimer(ref: React.MutableRefObject<number | null>) {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function areNumberMapsEqual(a: Record<number, number>, b: Record<number, number>): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => a[Number(k)] === b[Number(k)]);
}

function resolveCurrentAudioTime(
  getAudioTime: (() => number) | undefined,
  agentLines: LiveTeleprompterLine[],
  wallOriginBySeq: Map<number, { startPerfSec: number; baseStart: number }>,
): number {
  for (let i = agentLines.length - 1; i >= 0; i -= 1) {
    const line = agentLines[i];
    const hasAudioSpans = Array.isArray(line.audioSpans) && line.audioSpans.length > 0;
    const uStart = line.utteranceStart;
    if (!hasAudioSpans && typeof uStart === 'number' && Number.isFinite(uStart)) {
      if (uStart > 1_000_000_000_000) return Date.now();
      if (uStart > 1_000_000_000) return Date.now() / 1000;
    }
  }

  if (getAudioTime) {
    const t = getAudioTime();
    if (Number.isFinite(t)) return t;
  }

  for (let i = agentLines.length - 1; i >= 0; i -= 1) {
    const uStart = agentLines[i].utteranceStart;
    if (typeof uStart === 'number' && Number.isFinite(uStart)) {
      if (uStart > 1_000_000_000_000) return Date.now();
      if (uStart > 1_000_000_000) return Date.now() / 1000;
      const nowPerfSec =
        typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
      const existing = wallOriginBySeq.get(agentLines[i].seq);
      if (!existing || existing.baseStart !== uStart) {
        wallOriginBySeq.set(agentLines[i].seq, { startPerfSec: nowPerfSec, baseStart: uStart });
        return uStart;
      }
      return uStart + Math.max(0, nowPerfSec - existing.startPerfSec);
    }
  }

  return typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
}

export const VoiceTeleprompterDock: React.FC<VoiceTeleprompterDockProps> = ({
  open,
  lines,
  showUserTurns = false,
  isThinking = false,
  isTranscribing = false,
  isListening = false,
  speakerMuted = false,
  micMuted = false,
  speakerLevel = 0,
  micLevel = 0,
  voicePalette,
  startedAt,
  linkPhase,
  micPrompt = false,
  playbackSpeed,
  onChangePlaybackSpeed,
  onToggleMicMuted,
  onToggleSpeakerMuted,
  onEndSession,
  showCallActions = false,
  getAudioTime,
  statusHint,
  className = '',
}) => {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [scrollHeightPx, setScrollHeightPx] = useState<number>(() =>
    computeTeleprompterScrollHeight(0),
  );
  const [leavingUserLine, setLeavingUserLine] = useState<LiveTeleprompterLine | null>(null);
  const [spokenBySeq, setSpokenBySeq] = useState<Record<number, number>>({});
  const [sustainedMicSpeech, setSustainedMicSpeech] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const prevOpenRef = useRef(open);
  const exitTimerRef = useRef<number | null>(null);
  const activeAnimationsRef = useRef<Array<Animation | undefined>>([]);
  const prevSpeakingUserRef = useRef<LiveTeleprompterLine | null>(null);
  const userFadeTimerRef = useRef<number | null>(null);
  const micEnterTimerRef = useRef<number | null>(null);
  const micExitTimerRef = useRef<number | null>(null);
  const prevMicOpenRef = useRef(open);
  const dockOpenedAtRef = useRef<number>(open ? Date.now() : 0);
  const monotonicSpokenRef = useRef<Map<number, number>>(new Map());
  const wallOriginRef = useRef<Map<number, { startPerfSec: number; baseStart: number }>>(new Map());
  const userScrolledRef = useRef(false);
  const programmaticTargetTopRef = useRef<number | null>(null);

  const turnView = useMemo(() => selectTeleprompterTurnView(lines), [lines]);
  const { speakingUserLine, lastUserLine, agentLines } = turnView;
  const hasActiveUserSpeech = Boolean(speakingUserLine);
  const showTranscribingTurn =
    !(showUserTurns && (speakingUserLine ?? leavingUserLine)) &&
    !hasActiveUserSpeech &&
    agentLines.length === 0 &&
    Boolean(isTranscribing);
  const showThinkingTurn =
    !(showUserTurns && (speakingUserLine ?? leavingUserLine)) &&
    !hasActiveUserSpeech &&
    !showTranscribingTurn &&
    agentLines.length === 0 &&
    (isThinking || Boolean(lastUserLine));

  // Hysteresized speech presence prevents 60 fps RAF mic-level jitter / AGC spikes
  // from flickering idle copy and wave state at session startup.
  useEffect(() => {
    const justOpened = open && !prevMicOpenRef.current;
    prevMicOpenRef.current = open;
    if (justOpened || (open && dockOpenedAtRef.current === 0)) {
      dockOpenedAtRef.current = Date.now();
    } else if (!open) {
      dockOpenedAtRef.current = 0;
    }

    const canTrackMic =
      open &&
      !micMuted &&
      isListening &&
      !micPrompt &&
      !linkPhase &&
      agentLines.length === 0 &&
      !showTranscribingTurn &&
      !showThinkingTurn;

    if (!canTrackMic) {
      clearWindowTimer(micEnterTimerRef);
      clearWindowTimer(micExitTimerRef);
      if (sustainedMicSpeech) {
        setSustainedMicSpeech(false);
      }
      return;
    }

    if (hasActiveUserSpeech) {
      clearWindowTimer(micEnterTimerRef);
      clearWindowTimer(micExitTimerRef);
      if (!sustainedMicSpeech) {
        setSustainedMicSpeech(true);
      }
      return;
    }

    const level = micLevel ?? 0;
    if (!sustainedMicSpeech) {
      clearWindowTimer(micExitTimerRef);
      if (level >= MIC_SPEECH_ENTER_THRESHOLD) {
        if (micEnterTimerRef.current === null) {
          const elapsedSinceOpen = Math.max(0, Date.now() - dockOpenedAtRef.current);
          const settleRemaining = Math.max(0, MIC_STARTUP_SETTLE_MS - elapsedSinceOpen);
          const delayMs = Math.max(MIC_SPEECH_ENTER_DELAY_MS, settleRemaining);
          micEnterTimerRef.current = window.setTimeout(() => {
            micEnterTimerRef.current = null;
            setSustainedMicSpeech(true);
          }, delayMs);
        }
      } else {
        clearWindowTimer(micEnterTimerRef);
      }
      return;
    }

    clearWindowTimer(micEnterTimerRef);
    if (level >= MIC_SPEECH_EXIT_THRESHOLD) {
      clearWindowTimer(micExitTimerRef);
    } else if (micExitTimerRef.current === null) {
      micExitTimerRef.current = window.setTimeout(() => {
        micExitTimerRef.current = null;
        setSustainedMicSpeech(false);
      }, MIC_SPEECH_HOLD_MS);
    }
  }, [
    open,
    micMuted,
    isListening,
    micPrompt,
    linkPhase,
    agentLines.length,
    showTranscribingTurn,
    showThinkingTurn,
    hasActiveUserSpeech,
    micLevel,
    sustainedMicSpeech,
  ]);

  // Mount & WAAPI enter / exit lifecycle
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    clearWindowTimer(exitTimerRef);

    if (open) {
      cancelAnimations(activeAnimationsRef.current);
      activeAnimationsRef.current = [];
      setLeaving(false);
      setMounted(true);
      return;
    }

    if (!wasOpen && !mounted) return;
    userScrolledRef.current = false;

    if (prefersReducedMotion()) {
      cancelAnimations(activeAnimationsRef.current);
      activeAnimationsRef.current = [];
      setLeaving(false);
      setMounted(false);
      return;
    }

    setLeaving(true);
    const startHeight = wrapperRef.current?.offsetHeight ?? 0;
    const exitTiming: KeyframeAnimationOptions = {
      duration: EXIT_MS,
      easing: 'cubic-bezier(0.4, 0, 1, 1)',
      fill: 'forwards',
    };

    activeAnimationsRef.current = [
      runElementAnimation(
        wrapperRef.current,
        [
          { height: `${startHeight}px`, overflow: 'hidden' },
          { height: '0px', overflow: 'hidden' },
        ],
        exitTiming,
      ),
      runElementAnimation(
        cardRef.current,
        [
          { opacity: 1, transform: 'translateY(0) scale(1)' },
          { opacity: 0, transform: 'translateY(20px) scale(0.98)' },
        ],
        exitTiming,
      ),
    ];

    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      cancelAnimations(activeAnimationsRef.current);
      activeAnimationsRef.current = [];
      setLeaving(false);
      setMounted(false);
    }, EXIT_MS);
  }, [open, mounted]);

  useLayoutEffect(() => {
    if (!mounted || !open || leaving || prefersReducedMotion()) return;
    const targetHeight = wrapperRef.current?.offsetHeight ?? 0;
    const enterAnims = [
      runElementAnimation(
        wrapperRef.current,
        [
          { height: '0px', overflow: 'hidden' },
          { height: `${targetHeight}px`, overflow: 'hidden' },
        ],
        { duration: ENTER_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'none' },
      ),
      runElementAnimation(
        cardRef.current,
        [
          { opacity: 0, transform: 'translateY(28px) scale(0.98)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        { duration: ENTER_MS, delay: 40, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' },
      ),
    ];
    activeAnimationsRef.current = enterAnims;
    return () => cancelAnimations(enterAnims);
  }, [mounted, open, leaving]);

  useEffect(() => {
    return () => {
      clearWindowTimer(exitTimerRef);
      clearWindowTimer(userFadeTimerRef);
      clearWindowTimer(micEnterTimerRef);
      clearWindowTimer(micExitTimerRef);
      cancelAnimations(activeAnimationsRef.current);
    };
  }, []);

  // User speech 700ms post-speech fade state (only when opt-in showUserTurns is enabled)
  useEffect(() => {
    if (!open || !showUserTurns || speakingUserLine || agentLines.length > 0 || isTranscribing) {
      clearWindowTimer(userFadeTimerRef);
      prevSpeakingUserRef.current = showUserTurns ? (speakingUserLine ?? null) : null;
      setLeavingUserLine(null);
      return;
    }

    if (prevSpeakingUserRef.current) {
      const ended =
        lastUserLine && lastUserLine.seq === prevSpeakingUserRef.current.seq
          ? lastUserLine
          : prevSpeakingUserRef.current;
      prevSpeakingUserRef.current = null;

      if (prefersReducedMotion()) {
        setLeavingUserLine(null);
        return;
      }

      setLeavingUserLine(ended);
      userFadeTimerRef.current = window.setTimeout(() => {
        userFadeTimerRef.current = null;
        setLeavingUserLine(null);
      }, USER_POST_SPEECH_FADE_MS);
    }
  }, [open, showUserTurns, speakingUserLine, lastUserLine, agentLines.length, isTranscribing]);

  // ResizeObserver auto-sizing between 168px and min(45vh, 340px)
  useEffect(() => {
    if (!mounted) return;
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const updateHeight = (measured?: number) => {
      const nextContentHeight =
        typeof measured === 'number' && Number.isFinite(measured) && measured > 0
          ? measured
          : contentEl.scrollHeight || contentEl.getBoundingClientRect().height || 0;
      setScrollHeightPx(computeTeleprompterScrollHeight(nextContentHeight));
    };

    updateHeight();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const entryHeight = entries[0]?.contentRect?.height;
        updateHeight(entryHeight);
      });
      observer.observe(contentEl);
    }

    const handleResize = () => updateHeight();
    window.addEventListener('resize', handleResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [mounted, lines, collapsed]);

  // Compute spoken char cursors synchronously and keep synced at 60fps via RAF
  const computeSpokenMap = useCallback((): {
    nextMap: Record<number, number>;
    hasActiveLine: boolean;
  } => {
    const activeSeqs = new Set<number>();
    const currentTime = resolveCurrentAudioTime(getAudioTime, agentLines, wallOriginRef.current);
    const nextMap: Record<number, number> = {};
    let hasActiveLine = false;

    for (const line of agentLines) {
      activeSeqs.add(line.seq);
      const prev = monotonicSpokenRef.current.get(line.seq) ?? 0;
      const computed = computeSpokenCharCount(currentTime, line, prev);
      monotonicSpokenRef.current.set(line.seq, computed);
      nextMap[line.seq] = computed;
      if (line.spokenChars === undefined && computed < line.text.length) {
        hasActiveLine = true;
      }
    }

    for (const seq of Array.from(monotonicSpokenRef.current.keys())) {
      if (!activeSeqs.has(seq)) monotonicSpokenRef.current.delete(seq);
    }
    for (const seq of Array.from(wallOriginRef.current.keys())) {
      if (!activeSeqs.has(seq)) wallOriginRef.current.delete(seq);
    }

    return { nextMap, hasActiveLine };
  }, [agentLines, getAudioTime]);

  const scrollTowardLiveCursor = useCallback(() => {
    if (collapsed || userScrolledRef.current) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const cursorEl = scrollEl.querySelector<HTMLElement>('[data-live-cursor="true"]');
    if (!cursorEl) return;

    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (maxScroll <= 0) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const cursorRect = cursorEl.getBoundingClientRect();
    const targetOffset = scrollEl.clientHeight * SCROLL_TARGET_RATIO;
    const delta = cursorRect.top - scrollRect.top - targetOffset;

    if (Math.abs(delta) <= 0.5) return;
    const nextTop = Math.max(0, Math.min(maxScroll, scrollEl.scrollTop + delta * SCROLL_SPRING_DAMPING));
    if (Math.abs(nextTop - scrollEl.scrollTop) > 0.05) {
      programmaticTargetTopRef.current = nextTop;
      scrollEl.scrollTop = nextTop;
    }
  }, [collapsed]);

  useEffect(() => {
    if (!mounted || !open || agentLines.length === 0) {
      return;
    }

    const initial = computeSpokenMap();
    setSpokenBySeq((prev) => (areNumberMapsEqual(prev, initial.nextMap) ? prev : initial.nextMap));

    let rafId = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const { nextMap, hasActiveLine } = computeSpokenMap();
      setSpokenBySeq((prev) => (areNumberMapsEqual(prev, nextMap) ? prev : nextMap));
      scrollTowardLiveCursor();
      if (hasActiveLine || (!collapsed && !userScrolledRef.current)) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [mounted, open, agentLines, collapsed, computeSpokenMap, scrollTowardLiveCursor]);

  const handleManualScrollIntent = useCallback(() => {
    programmaticTargetTopRef.current = null;
    userScrolledRef.current = true;
  }, []);

  const handleScroll = useCallback(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    if (
      programmaticTargetTopRef.current !== null &&
      Math.abs(scrollEl.scrollTop - programmaticTargetTopRef.current) < 1
    ) {
      programmaticTargetTopRef.current = null;
      return;
    }
    programmaticTargetTopRef.current = null;
    const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    userScrolledRef.current = distanceFromBottom > SCROLL_REATTACH_THRESHOLD_PX;
  }, []);

  if (!mounted) {
    return null;
  }

  const activeUserLine = showUserTurns ? (speakingUserLine ?? leavingUserLine) : null;
  const isLeavingUser = showUserTurns && !speakingUserLine && Boolean(leavingUserLine);
  const isUserSpeaking = hasActiveUserSpeech;
  const showTranscribing = showTranscribingTurn;
  const showThinking = showThinkingTurn;
  const userSpeechActive = Boolean(isUserSpeaking || sustainedMicSpeech);
  const activeSpeaker: 'you' | 'agent' =
    showUserTurns && (activeUserLine || isUserSpeaking || showTranscribing) ? 'you' : 'agent';
  const hasLyrics = Boolean(
    activeUserLine || agentLines.length > 0 || showTranscribing || showThinking,
  );
  const resolvedPalette = voicePalette ?? DEFAULT_VOICE_GLOW_PALETTE;
  const toRgbTriplet = (tuple: [number, number, number]) =>
    `${Math.round(tuple[0] * 255)}, ${Math.round(tuple[1] * 255)}, ${Math.round(tuple[2] * 255)}`;
  const paletteVars = {
    '--voice-deep-rgb': toRgbTriplet(resolvedPalette.deep),
    '--voice-core-rgb': toRgbTriplet(resolvedPalette.core),
    '--voice-glint-rgb': toRgbTriplet(resolvedPalette.glint),
  } as React.CSSProperties;
  const waveLevel =
    activeUserLine || userSpeechActive || showTranscribing
      ? Math.max(micLevel ?? 0, 0.38)
      : agentLines.length > 0
        ? Math.max(speakerLevel, 0.42)
        : Math.max(micLevel ?? 0, speakerLevel);
  const waveSpeaking = Boolean(
    userSpeechActive ||
      showTranscribing ||
      agentLines.length > 0 ||
      speakerLevel > 0.05,
  );
  const waveSpeaker: 'you' | 'agent' | 'idle' =
    activeUserLine || userSpeechActive || showTranscribing
      ? 'you'
      : agentLines.length > 0
        ? 'agent'
        : 'idle';

  const idleMessage =
    linkPhase === 'connecting'
      ? 'Conectando…'
      : linkPhase === 'reconnecting'
        ? 'Reconectando…'
        : statusHint ||
          (micPrompt
            ? 'Permite el acceso al micrófono para hablar.'
            : userSpeechActive
              ? 'Escuchando tu voz…'
              : 'Escuchando. Habla cuando quieras.');

  let cursorAssigned = false;

  return (
    <div
      ref={wrapperRef}
      data-leaving={leaving ? 'true' : undefined}
      style={paletteVars}
      className={`kite-voice-teleprompter-wrap ${className}`.trim()}
    >
      <section
        ref={cardRef}
        data-testid="voice-teleprompter-dock"
        data-collapsed={collapsed ? 'true' : 'false'}
        data-has-lyrics={hasLyrics ? 'true' : 'false'}
        data-speaker={waveSpeaker}
        data-leaving={leaving ? 'true' : undefined}
        aria-label="Teleprompter de voz"
        className="kite-voice-teleprompter"
      >
        <VoiceCallBar
          activeSpeaker={activeSpeaker}
          speakerLevel={speakerLevel}
          startedAt={startedAt}
          linkPhase={linkPhase}
          isThinking={showThinking || showTranscribing || isThinking}
          isListening={isListening}
          playbackSpeed={playbackSpeed}
          onChangePlaybackSpeed={onChangePlaybackSpeed}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((prev) => !prev)}
          micMuted={micMuted}
          speakerMuted={speakerMuted}
          onToggleMicMuted={onToggleMicMuted}
          onToggleSpeakerMuted={onToggleSpeakerMuted}
          onEndSession={onEndSession}
          showCallActions={showCallActions}
        />

        <div className="kite-voice-teleprompter__collapse">
          <div className="kite-voice-teleprompter__collapse-inner">
            <div
              ref={scrollRef}
              data-testid="live-docked-scroll"
              className={`kite-voice-teleprompter__scroll${
                hasLyrics ? ' kite-voice-teleprompter__scroll--lyrics' : ''
              }`}
              style={{ height: `${scrollHeightPx}px` }}
              onWheel={handleManualScrollIntent}
              onTouchMove={handleManualScrollIntent}
              onScroll={handleScroll}
            >
              <div ref={contentRef} className="kite-voice-teleprompter__content">
                {activeUserLine ? (
                  <div
                    data-testid="live-user-turn"
                    data-leaving={isLeavingUser ? 'true' : 'false'}
                    className="kite-voice-teleprompter__user-turn"
                  >
                    {activeUserLine.text}
                    {!isLeavingUser ? (
                      <span
                        className="kite-voice-teleprompter__user-cursor"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                ) : agentLines.length > 0 ? (
                  <div
                    data-testid="live-agent-turn"
                    className="kite-voice-teleprompter__agent-turn"
                  >
                    {agentLines.map((line, lineIdx) => {
                      const fallbackSpoken = computeSpokenCharCount(
                        resolveCurrentAudioTime(getAudioTime, agentLines, wallOriginRef.current),
                        line,
                        monotonicSpokenRef.current.get(line.seq) ?? 0,
                      );
                      const spokenCharCount =
                        line.spokenChars !== undefined
                          ? Math.max(0, Math.min(line.text.length, Math.floor(line.spokenChars)))
                          : (spokenBySeq[line.seq] ?? fallbackSpoken);

                      const paragraphs = splitTeleprompterParagraphs(line.text, lineIdx === 0);

                      return paragraphs.map((para, paraIdx) => {
                        const tokens = tokenizeTeleprompterParagraph(para.text);
                        return (
                          <p
                            key={`${line.seq}-${paraIdx}`}
                            className={`kite-voice-teleprompter__paragraph kite-voice-teleprompter__paragraph--${para.kind}`}
                          >
                            {tokens.map((tok, tokIdx) => {
                              if (!tok.isWord) {
                                return tok.text;
                              }
                              const globalStart = para.start + tok.start;
                              const isSpoken = globalStart < spokenCharCount;
                              const isCursor = !isSpoken && !cursorAssigned;
                              if (isCursor) {
                                cursorAssigned = true;
                              }
                              return (
                                <span
                                  key={`${paraIdx}-${tokIdx}`}
                                  data-live-cursor={isCursor ? 'true' : undefined}
                                  className={`kite-voice-teleprompter__word ${
                                    isSpoken
                                      ? 'kite-voice-teleprompter__word--spoken'
                                      : 'kite-voice-teleprompter__word--unspoken'
                                  }`}
                                >
                                  {tok.text}
                                </span>
                              );
                            })}
                          </p>
                        );
                      });
                    })}
                  </div>
                ) : showTranscribing ? (
                  <div
                    data-testid="live-transcribing-turn"
                    className="kite-voice-teleprompter__thinking"
                  >
                    {showUserTurns && lastUserLine?.text ? (
                      <p
                        data-testid="live-user-echo"
                        className="kite-voice-teleprompter__user-echo"
                      >
                        {lastUserLine.text}
                      </p>
                    ) : null}
                    <div className="kite-voice-teleprompter__thinking-row">
                      <span>Transcribiendo tu voz</span>
                      <span className="kite-voice-teleprompter__dots" aria-hidden="true">
                        <span className="kite-voice-teleprompter__dot" />
                        <span className="kite-voice-teleprompter__dot" />
                        <span className="kite-voice-teleprompter__dot" />
                      </span>
                    </div>
                  </div>
                ) : showThinking ? (
                  <div
                    data-testid="live-thinking-turn"
                    className="kite-voice-teleprompter__thinking"
                  >
                    {showUserTurns && lastUserLine?.text ? (
                      <p
                        data-testid="live-user-echo"
                        className="kite-voice-teleprompter__user-echo"
                      >
                        {lastUserLine.text}
                      </p>
                    ) : null}
                    <div className="kite-voice-teleprompter__thinking-row">
                      <span>Pensando</span>
                      <span className="kite-voice-teleprompter__dots" aria-hidden="true">
                        <span className="kite-voice-teleprompter__dot" />
                        <span className="kite-voice-teleprompter__dot" />
                        <span className="kite-voice-teleprompter__dot" />
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="kite-voice-teleprompter__idle-stage">
                    <VoiceWaveRibbon
                      active={!collapsed && !leaving}
                      level={waveLevel}
                      speaking={waveSpeaking}
                      speaker={waveSpeaker}
                      muted={micMuted}
                      palette={resolvedPalette}
                    />
                    <div className="kite-voice-teleprompter__idle">{idleMessage}</div>
                  </div>
                )}
              </div>
            </div>
            {hasLyrics ? (
              <div className="kite-voice-teleprompter__horizon" aria-hidden="true">
                <VoiceWaveRibbon
                  active={!collapsed && !leaving}
                  compact
                  level={waveLevel}
                  speaking={waveSpeaking}
                  speaker={waveSpeaker}
                  muted={micMuted}
                  palette={resolvedPalette}
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
};
