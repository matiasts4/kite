// Kite Code — Voice Mode Footer Bar for Thread Composer
// Replaces standard model/effort pickers with a locked Assistant model badge on the left and live call controls on the right.

import React, { useEffect, useRef } from 'react';
import { LockIcon, ArrowUpIcon, PaperclipIcon } from '../ChatIcons';
import {
  useVoiceSession,
  getConfiguredAssistantDisplay,
} from '../../../../lib/operator/voice/voiceSessionStore';
import { ttsNarrator } from '../../../../lib/operator/ttsNarrator';

export interface VoiceModeFooterBarProps {
  threadId?: string | null;
  hasDraftText?: boolean;
  onSendDraft?: () => void;
  onEndSession?: () => void;
  className?: string;
}

export const VoiceModeFooterBar: React.FC<VoiceModeFooterBarProps> = ({
  threadId,
  hasDraftText = false,
  onSendDraft,
  onEndSession,
  className = '',
}) => {
  const voice = useVoiceSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Resolve configured assistant brain model & TTS info from Zed Assistant settings
  const assistantDisplay = getConfiguredAssistantDisplay();
  const assistantLabel = `${assistantDisplay.personaName} · ${assistantDisplay.providerId.toUpperCase()} · ${assistantDisplay.ttsLabel}`;

  // Determine live voice status indicator
  const isThinkingStage =
    voice.activeTurnStage === 'planning' ||
    voice.activeTurnStage === 'executing' ||
    voice.activeTurnStage === 'verifying';
  const isSpeakingStage =
    Boolean(voice.isSpeaking) || voice.activeTurnStage === 'speaking';

  const statusText = (() => {
    if (voice.micMuted) return 'Micrófono silenciado';
    if (voice.isPausedForDictation) return 'Pausado por dictado…';
    if (isThinkingStage) return voice.activeTurnDetail || 'Pensando…';
    if (isSpeakingStage) return 'Hablando…';
    if (voice.isTranscribing) return 'Transcribiendo…';
    if (voice.interimTranscript) return `«${voice.interimTranscript}»`;
    return 'Escuchando…';
  })();

  const statusDotClass = voice.micMuted
    ? 'kite-voice-status-dot kite-voice-status-dot--muted'
    : isThinkingStage
    ? 'kite-voice-status-dot kite-voice-status-dot--thinking'
    : isSpeakingStage
    ? 'kite-voice-status-dot kite-voice-status-dot--speaking'
    : 'kite-voice-status-dot';

  // Live waveform animation on canvas (28px × 12px)
  useEffect(() => {
    let animId: number;
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
        const dynamicFactor =
          voice.phase === 'active'
            ? voice.micMuted
              ? 0.2
              : Math.min(1, 0.38 + levelBoost + 0.55 * Math.abs(Math.sin(tick + i * 1.1)))
            : 0.3;
        const barHeight = Math.max(3, Math.min(height, height * dynamicFactor));
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
      className={`kite-voice-mode-footer ${className}`}
    >
      {/* 1. Left Cluster: Locked Assistant & Brain Model Badge + Live Status Pill */}
      <div className="kite-composer-footer-left">
        <div
          data-testid="voice-locked-assistant-badge"
          title={`Configuración del Asistente ${assistantDisplay.personaName}: ${assistantDisplay.providerLabel} (${assistantDisplay.modelId}) · ${assistantDisplay.ttsLabel} (${assistantDisplay.voiceName})`}
          className="kite-voice-locked-badge"
        >
          <LockIcon size={11} className="kite-voice-lock-icon" />
          <span className="kite-voice-badge-main">{assistantLabel}</span>
          <span className="kite-voice-badge-model">{assistantDisplay.modelId}</span>
        </div>

        <span className="kite-composer-control-separator" aria-hidden="true" />

        <div
          data-testid="voice-live-status-pill"
          className="kite-voice-status-pill"
          role="status"
          aria-live="polite"
        >
          <span className={statusDotClass} aria-hidden="true" />
          <span className="kite-voice-status-text">{statusText}</span>
        </div>
      </div>

      {/* 2. Right Cluster: Disabled Attach + Call Controls or Send Button */}
      <div className="kite-composer-footer-right">
        <button
          type="button"
          disabled
          title="Adjuntos no disponibles durante llamada de voz"
          aria-label="Adjuntos desactivados"
          className="kite-voice-ctrl-btn kite-voice-ctrl-btn--disabled"
        >
          <PaperclipIcon size={14} />
        </button>

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
            {/* Button 1: Mic Mute */}
            <button
              type="button"
              onClick={() => voice.toggleMicMuted()}
              title={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
              aria-label={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
              aria-pressed={voice.micMuted}
              className={`kite-voice-ctrl-btn ${voice.micMuted ? 'kite-voice-ctrl-btn--muted' : ''}`}
            >
              {voice.micMuted ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                  <path d="M5 10v2a7 7 0 0 0 12 5" />
                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              )}
            </button>

            {/* Button 2: Speaker Mute */}
            <button
              type="button"
              onClick={handleToggleSpeaker}
              title={voice.speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
              aria-label={voice.speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
              aria-pressed={voice.speakerMuted}
              className={`kite-voice-ctrl-btn ${voice.speakerMuted ? 'kite-voice-ctrl-btn--muted' : ''}`}
            >
              {voice.speakerMuted ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="22" y1="9" x2="16" y2="15" />
                  <line x1="16" y1="9" x2="22" y2="15" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
            </button>

            {/* Button 3: Active Waveform & End Stadium Pill */}
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
                style={{ width: '28px', height: '12px', flexShrink: 0 }}
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
