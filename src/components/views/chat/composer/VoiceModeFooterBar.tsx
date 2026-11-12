// Kite Code — Voice Mode Footer Bar for Thread Composer
// Same footer geometry as the standard composer: the editable pickers become a locked Assistant
// brain/voice summary on the left, and the call controls take the right-hand action slot.

import React, { useEffect, useRef } from 'react';
import { LockIcon, ArrowUpIcon } from '../ChatIcons';
import {
  useVoiceSession,
  getConfiguredAssistantDisplay,
} from '../../../../lib/operator/voice/voiceSessionStore';
import { ttsNarrator } from '../../../../lib/operator/ttsNarrator';
import { ComposerControlSeparator } from './ComposerControl';

export interface VoiceModeFooterBarProps {
  threadId?: string | null;
  hasDraftText?: boolean;
  onSendDraft?: () => void;
  onEndSession?: () => void;
  className?: string;
}

const iconProps = {
  width: 14,
  height: 14,
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
  className = '',
}) => {
  const voice = useVoiceSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Brain model and voice engine come straight from the Zed Assistant settings.
  const assistant = getConfiguredAssistantDisplay();

  const isThinking =
    voice.activeTurnStage === 'planning' ||
    voice.activeTurnStage === 'executing' ||
    voice.activeTurnStage === 'verifying';
  const isSpeaking = Boolean(voice.isSpeaking) || voice.activeTurnStage === 'speaking';

  const statusText = (() => {
    if (voice.micMuted) return 'Micrófono silenciado';
    if (voice.isPausedForDictation) return 'Pausado por dictado';
    if (isThinking) return voice.activeTurnDetail || 'Pensando…';
    if (isSpeaking) return 'Hablando…';
    if (voice.isTranscribing) return 'Transcribiendo…';
    return 'Escuchando…';
  })();

  const statusTone = voice.micMuted
    ? 'muted'
    : isThinking
    ? 'thinking'
    : isSpeaking
    ? 'speaking'
    : 'listening';

  // Live waveform animation on canvas (28px × 12px)
  useEffect(() => {
    let animId = 0;
    let tick = 0;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      tick += 0.15;
      const barCount = 5;
      const barWidth = 3;
      const gap = 2;
      const totalWidth = barCount * barWidth + (barCount - 1) * gap;
      const startX = (width - totalWidth) / 2;

      ctx.fillStyle = '#ffffff';

      for (let i = 0; i < barCount; i++) {
        const x = startX + i * (barWidth + gap);
        const levelBoost = Math.max(0, Math.min(1, voice.liveAudioLevel || 0)) * 0.45;
        const factor =
          voice.phase === 'active'
            ? voice.micMuted
              ? 0.2
              : Math.min(1, 0.38 + levelBoost + 0.55 * Math.abs(Math.sin(tick + i * 1.1)))
            : 0.3;
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

    render();
    return () => cancelAnimationFrame(animId);
  }, [voice.phase, voice.micMuted, voice.liveAudioLevel]);

  const handleToggleSpeaker = () => {
    if (!voice.speakerMuted) {
      ttsNarrator.stop();
    }
    voice.toggleSpeakerMuted();
  };

  const handleEnd = () => {
    ttsNarrator.stop();
    voice.stopSession();
    onEndSession?.();
  };

  return (
    <div
      data-testid="voice-mode-footer-bar"
      data-thread-id={threadId || undefined}
      className={`kite-composer-footer kite-voice-footer ${className}`.trim()}
    >
      {/* Left cluster — same slot as the model / effort / permission pickers */}
      <div className="kite-composer-footer-left">
        <span
          data-testid="voice-locked-assistant-badge"
          title={`${assistant.personaName} · ${assistant.providerLabel} (${assistant.modelId}). Bloqueado durante la sesión de voz.`}
          className="kite-composer-control-pill kite-voice-pill--static"
        >
          <LockIcon size={12} className="kite-voice-pill__icon" />
          <span className="kite-composer-control-label">
            {assistant.personaName} · {assistant.modelId}
          </span>
        </span>

        <ComposerControlSeparator />

        <span
          data-testid="voice-engine-badge"
          title={`Voz: ${assistant.ttsLabel} (${assistant.voiceName})`}
          className="kite-composer-control-pill kite-voice-pill--static"
        >
          <svg {...iconProps} width={12} height={12} className="kite-voice-pill__icon">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
          <span className="kite-composer-control-label">{assistant.ttsLabel}</span>
        </span>

        <ComposerControlSeparator />

        <span
          data-testid="voice-live-status-pill"
          className="kite-voice-status"
          data-tone={statusTone}
          role="status"
          aria-live="polite"
        >
          <span className="kite-voice-status__dot" aria-hidden="true" />
          <span className="kite-voice-status__text">{statusText}</span>
        </span>
      </div>

      {/* Right cluster — call controls, or Send while a draft is typed */}
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
