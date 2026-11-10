// Kite Code — Voice Mode Footer Bar for Thread Composer
// Replaces standard model/effort pickers with a locked Assistant model badge and live call controls.

import React, { useEffect, useRef } from 'react';
import { LockIcon, ArrowUpIcon } from '../ChatIcons';
import { loadOperatorConfig } from '../../../../lib/operator/operatorConfig';
import { useVoiceSession } from '../../../../lib/operator/voice/voiceSessionStore';
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

  // Load configured assistant model & TTS info
  const opConfig = loadOperatorConfig();
  const providerLabel = (opConfig.activeProvider || 'grok').toUpperCase();
  const ttsLabel = opConfig.ttsEngine === 'elevenlabs' ? 'ElevenLabs' : 'Voz Nativa';
  const assistantLabel = `${opConfig.persona?.name || 'Zed'} · ${providerLabel} · ${ttsLabel}`;

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
        // Sinusoidal wave motion scaled by audio level if active
        const dynamicFactor = voice.phase === 'active' ? (voice.micMuted ? 0.2 : 0.4 + 0.6 * Math.sin(tick + i * 1.2)) : 0.3;
        const barHeight = Math.max(3, Math.min(height, height * dynamicFactor));
        const y = (height - barHeight) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 1.5);
        ctx.fill();
      }

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [voice.phase, voice.micMuted]);

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
      className={`kite-voice-mode-footer flex items-center gap-2 px-2 py-1 min-h-[32px] w-full border-t border-[var(--vl-border-subtle)] bg-[var(--vl-surface-glass-dim)] ${className}`}
    >
      {/* 1. Left slot: Disabled attach button + spacer */}
      <button
        type="button"
        disabled
        title="Adjuntos no disponibles durante llamada de voz"
        aria-label="Adjuntos desactivados"
        className="size-8 rounded-control flex items-center justify-center opacity-40 cursor-not-allowed text-[var(--vl-text-muted)]"
      >
        <span className="text-base leading-none font-medium">+</span>
      </button>

      <div className="min-w-0 flex-1" />

      {/* 2. Middle slot: Locked Assistant Model Badge (non-editable as per S2) */}
      <div
        data-testid="voice-locked-assistant-badge"
        title="Modelo y motor de voz del Asistente Zed (bloqueado para esta sesión)"
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-control border border-[var(--vl-border-subtle)] bg-[var(--vl-surface-glass)] text-xs font-medium text-[var(--vl-text-secondary)] select-none shrink-0"
      >
        <LockIcon size={12} className="text-[var(--vl-text-muted)] shrink-0" />
        <span className="truncate max-w-[200px]">{assistantLabel}</span>
      </div>

      {/* 3. Right slot: Call Controls Cluster or Dynamic Send Swap */}
      {hasDraftText ? (
        <button
          type="button"
          onClick={onSendDraft}
          aria-label="Enviar a la sesión de voz"
          title="Enviar a la sesión de voz (Enter)"
          className="kite-composer-action-btn kite-composer-action-btn--send size-8 rounded-control flex items-center justify-center bg-[var(--vl-accent-blue,#339cff)] text-white hover:brightness-110 active:brightness-95 transition-all shadow-sm"
        >
          <ArrowUpIcon size={16} />
        </button>
      ) : (
        <div className="flex items-center gap-1.5 shrink-0" data-testid="voice-call-controls">
          {/* Button 1: Mic Mute */}
          <button
            type="button"
            onClick={() => voice.toggleMicMuted()}
            title={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
            aria-label={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
            aria-pressed={voice.micMuted}
            className={`size-8 rounded-control flex items-center justify-center border transition-colors ${
              voice.micMuted
                ? 'border-[var(--vl-accent-red,#ef4444)] bg-[var(--vl-surface-raised)] text-[var(--vl-accent-red,#ef4444)]'
                : 'border-[var(--vl-border-subtle)] bg-[var(--vl-surface-glass)] text-[var(--vl-text-secondary)] hover:text-[var(--vl-text-primary)] hover:border-[var(--vl-border-hover)]'
            }`}
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
            className={`size-8 rounded-control flex items-center justify-center border transition-colors ${
              voice.speakerMuted
                ? 'border-[var(--vl-border-subtle)] bg-[var(--vl-surface-raised)] text-[var(--vl-text-muted)]'
                : 'border-[var(--vl-border-subtle)] bg-[var(--vl-surface-glass)] text-[var(--vl-text-secondary)] hover:text-[var(--vl-text-primary)] hover:border-[var(--vl-border-hover)]'
            }`}
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
            className="h-8 min-w-[104px] rounded-pill px-3 flex items-center justify-center gap-2 text-xs font-semibold text-white shadow-sm transition-all select-none bg-[#339cff] hover:bg-[#2b8beb] active:brightness-95"
          >
            <canvas
              ref={canvasRef}
              width={28}
              height={12}
              className="w-7 h-3 shrink-0"
              aria-hidden="true"
            />
            <span>Finalizar</span>
          </button>
        </div>
      )}
    </div>
  );
};
