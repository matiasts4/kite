// Thread Voice Mode footer bar: displays live voice status on the left without assistant/model pills,
// and keeps 32px call controls (or Send when typed draft exists) on the right.

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon } from '../ChatIcons';
import { useVoiceSession } from '../../../../lib/operator/voice/voiceSessionStore';
import { ttsNarrator } from '../../../../lib/operator/ttsNarrator';
import { formatVoicePlaybackSpeed } from '../../../../lib/operator/voice/callResilience';
import { loadOperatorConfig } from '../../../../lib/operator/operatorConfig';

export interface VoiceModeFooterBarProps {
  threadId?: string | null;
  hasDraftText?: boolean;
  onSendDraft?: () => void;
  onEndSession?: () => void;
  playbackSpeed?: number;
  onCyclePlaybackSpeed?: () => void;
  micFlatlined?: boolean;
  onReconnectMic?: () => void;
  className?: string;
}

const iconProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const VoiceModeFooterBar: React.FC<VoiceModeFooterBarProps> = ({
  threadId,
  hasDraftText = false,
  onSendDraft,
  onEndSession,
  playbackSpeed,
  onCyclePlaybackSpeed,
  micFlatlined = false,
  onReconnectMic,
  className = '',
}) => {
  const voice = useVoiceSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasObservedListeningRef = useRef(false);
  const [transportMode, setTransportMode] = useState<'cascaded' | 'realtime'>(
    () => loadOperatorConfig().voiceTransportMode ?? 'cascaded'
  );

  useEffect(() => {
    const syncTransport = () => {
      setTransportMode(loadOperatorConfig().voiceTransportMode ?? 'cascaded');
    };
    window.addEventListener('kite:operator-config-updated', syncTransport);
    return () => window.removeEventListener('kite:operator-config-updated', syncTransport);
  }, []);

  if (voice.phase === 'inactive') {
    hasObservedListeningRef.current = false;
  } else if (voice.isListening) {
    hasObservedListeningRef.current = true;
  }

  const isThinking =
    voice.activeTurnStage === 'planning' ||
    voice.activeTurnStage === 'executing' ||
    voice.activeTurnStage === 'verifying';
  const isSpeaking = Boolean(voice.isSpeaking) || voice.activeTurnStage === 'speaking';
  const isTransitioningMic =
    voice.phase === 'starting' ||
    voice.activeTurnStage === 'post_tts_guard' ||
    (!voice.isListening &&
      !voice.isTranscribing &&
      !isSpeaking &&
      !isThinking &&
      (voice.activeTurnStage === 'done' || hasObservedListeningRef.current));
  const isAwaitingConfirmation =
    voice.draftProposal?.status === 'awaiting_confirmation' &&
    !isTransitioningMic;
  const isInHandsFreeWindow =
    typeof voice.handsFreeReplyUntilMs === 'number' &&
    voice.handsFreeReplyUntilMs > Date.now() &&
    Boolean(voice.isListening);
  const showFlatlineWarning = Boolean(
    micFlatlined && !voice.micMuted && !voice.isPausedForDictation
  );
  const showSpeedControl = playbackSpeed !== undefined || Boolean(onCyclePlaybackSpeed);
  const formattedSpeed = formatVoicePlaybackSpeed(playbackSpeed ?? 1);

  const statusText = (() => {
    if (voice.micMuted) return 'Micrófono en pausa';
    if (voice.isPausedForDictation) return 'En pausa por dictado';
    if (showFlatlineWarning) return 'Sin señal de micrófono';
    if (isThinking) return voice.activeTurnDetail || 'Ejecutando en el espacio de trabajo…';
    if (isSpeaking) return 'Respondiendo en voz alta…';
    if (voice.isTranscribing) return 'Transcribiendo tu orden…';
    if (isTransitioningMic) return 'Preparando micrófono…';
    if (isAwaitingConfirmation) return 'Esperando tu confirmación…';
    if (isInHandsFreeWindow) return 'Esperando tu respuesta…';
    return 'Escuchando en vivo';
  })();

  const statusTone = voice.micMuted
    ? 'muted'
    : voice.isPausedForDictation || showFlatlineWarning
    ? 'paused'
    : isThinking
    ? 'thinking'
    : isSpeaking
    ? 'speaking'
    : voice.isTranscribing || isTransitioningMic
    ? 'transcribing'
    : 'listening';

  // Live audio-reactive waveform animation on canvas (28px × 12px), throttled to conserve CPU
  useEffect(() => {
    let animId = 0;
    let tick = 0;
    let lastDraw = 0;
    const barShapes = [0.62, 0.92, 1.0, 0.84, 0.58];

    const render = (now: number) => {
      if (typeof document !== 'undefined' && document.hidden) {
        animId = requestAnimationFrame(render);
        return;
      }

      const level = Math.max(0, Math.min(1, voice.liveAudioLevel || 0));
      const speakingActive = Boolean(voice.isSpeaking) || voice.activeTurnStage === 'speaking';
      const activeSignal =
        voice.phase === 'active' &&
        !voice.micMuted &&
        !voice.isPausedForDictation &&
        (speakingActive || level >= 0.03);
      const minInterval = activeSignal ? 20 : 48;
      if (lastDraw && now - lastDraw < minInterval) {
        animId = requestAnimationFrame(render);
        return;
      }
      lastDraw = now;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      tick += 0.14;
      const barCount = 5;
      const barWidth = 3;
      const gap = 2;
      const totalWidth = barCount * barWidth + (barCount - 1) * gap;
      const startX = (width - totalWidth) / 2;

      const computedColor =
        typeof window !== 'undefined' ? window.getComputedStyle(canvas).color : '';
      ctx.fillStyle = computedColor || '#5c8fff';

      for (let i = 0; i < barCount; i++) {
        const x = startX + i * (barWidth + gap);
        let factor = 0.24;

        if (voice.phase === 'active' && !voice.micMuted && !voice.isPausedForDictation) {
          if (speakingActive) {
            factor = Math.min(1, 0.34 + 0.52 * Math.abs(Math.sin(tick * 1.15 + i * 0.9)));
          } else if (level >= 0.03) {
            const waveMod = 0.78 + 0.22 * Math.sin(tick * 1.4 + i * 1.1);
            factor = Math.min(1, 0.26 + level * 0.74 * barShapes[i] * waveMod);
          } else {
            factor = 0.22 + 0.08 * Math.abs(Math.sin(tick * 0.45 + i * 0.9));
          }
        }

        const barHeight = Math.max(3, Math.min(height, height * factor));
        const y = (height - barHeight) / 2;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x, y, barWidth, barHeight, 1.5);
        } else {
          ctx.rect(x, y, barWidth, barHeight);
        }
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [voice.phase, voice.micMuted, voice.isPausedForDictation, voice.liveAudioLevel, voice.isSpeaking, voice.activeTurnStage]);

  const handleToggleSpeaker = () => {
    if (!voice.speakerMuted) {
      if (typeof ttsNarrator.stopWithRamp === 'function') {
        ttsNarrator.stopWithRamp(20);
      } else {
        ttsNarrator.stop();
      }
    }
    voice.toggleSpeakerMuted();
  };

  const handleEnd = () => {
    if (typeof ttsNarrator.stopWithRamp === 'function') {
      ttsNarrator.stopWithRamp(20);
    } else {
      ttsNarrator.stop();
    }
    ttsNarrator.closePersistentTtsSocket?.();
    voice.stopSession();
    onEndSession?.();
  };

  return (
    <div
      data-testid="voice-mode-footer-bar"
      data-thread-id={threadId || undefined}
      data-transport={transportMode}
      className={`kite-composer-footer kite-voice-footer ${className}`.trim()}
    >
      {/* Left cluster — clean live voice status without Zed or technical badges */}
      <div className="kite-composer-footer-left flex items-center gap-1.5">
        <span
          data-testid="voice-live-status-pill"
          className="kite-voice-status"
          data-tone={statusTone}
          data-flatlined={showFlatlineWarning || undefined}
          role="status"
          aria-live="polite"
        >
          <span className="kite-voice-status__dot" aria-hidden="true" />
          <span className="kite-voice-status__bars" aria-hidden="true">
            <span className="kite-voice-status__bar" />
            <span className="kite-voice-status__bar" />
            <span className="kite-voice-status__bar" />
          </span>
          <span className="kite-voice-status__text">{statusText}</span>
        </span>
        {showFlatlineWarning && onReconnectMic ? (
          <button
            type="button"
            onClick={onReconnectMic}
            data-testid="voice-reconnect-mic-btn"
            aria-label="Reconectar micrófono"
            title="Reconectar micrófono"
            className="h-8 rounded-control px-2.5 text-xs font-medium inline-flex items-center justify-center border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors shrink-0 cursor-pointer"
          >
            Reconectar
          </button>
        ) : null}
      </div>

      {/* Right cluster — 32px call controls, or Send while a draft is typed */}
      <div className="kite-composer-footer-right">
        {hasDraftText ? (
          <button
            type="button"
            onClick={onSendDraft}
            aria-label="Enviar a la sesión de voz"
            title="Enviar a la sesión de voz (Enter)"
            className="kite-composer-action-btn kite-composer-action-btn--send"
          >
            <ArrowUpIcon size={16} />
          </button>
        ) : (
          <div className="kite-voice-call-controls" data-testid="voice-call-controls">
            <button
              type="button"
              onClick={() => voice.toggleMicMuted()}
              title={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
              aria-label={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
              aria-pressed={voice.micMuted}
              className="kite-voice-ctrl-btn"
              data-muted={voice.micMuted || undefined}
            >
              {voice.micMuted ? (
                <svg {...iconProps}>
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                  <path d="M5 10v2a7 7 0 0 0 12 5" />
                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              ) : (
                <svg {...iconProps}>
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={handleToggleSpeaker}
              title={voice.speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
              aria-label={voice.speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
              aria-pressed={voice.speakerMuted}
              className="kite-voice-ctrl-btn"
              data-muted={voice.speakerMuted || undefined}
            >
              {voice.speakerMuted ? (
                <svg {...iconProps}>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="22" y1="9" x2="16" y2="15" />
                  <line x1="16" y1="9" x2="22" y2="15" />
                </svg>
              ) : (
                <svg {...iconProps}>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
            </button>

            {showSpeedControl ? (
              <button
                type="button"
                onClick={onCyclePlaybackSpeed}
                disabled={!onCyclePlaybackSpeed}
                data-testid="voice-playback-speed-btn"
                title={`Velocidad de reproducción: ${formattedSpeed}`}
                aria-label={`Velocidad de reproducción ${formattedSpeed}`}
                className="kite-voice-ctrl-btn h-8 rounded-control text-xs font-medium tabular-nums"
                style={{
                  width: 'auto',
                  minWidth: 'var(--vl-control-md, 32px)',
                  paddingInline: '0.5rem',
                }}
              >
                {formattedSpeed}
              </button>
            ) : null}

            <button
              type="button"
              onClick={handleEnd}
              title="Finalizar sesión de voz"
              aria-label="Finalizar sesión de voz"
              className="kite-voice-end-pill"
            >
              <canvas
                ref={canvasRef}
                width={28}
                height={12}
                className="kite-voice-end-pill__wave"
                aria-hidden="true"
              />
              <span>Finalizar</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
