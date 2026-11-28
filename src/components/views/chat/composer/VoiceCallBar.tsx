import React, { useEffect, useState } from 'react';
import { VoiceSpeedPopover } from './VoiceSpeedPopover';

export interface VoiceCallBarProps {
  activeSpeaker?: 'you' | 'agent';
  speakerLevel?: number;
  startedAt?: number;
  linkPhase?: 'connecting' | 'reconnecting';
  isThinking?: boolean;
  isListening?: boolean;
  playbackSpeed: number;
  onChangePlaybackSpeed: (speed: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  micMuted?: boolean;
  speakerMuted?: boolean;
  onToggleMicMuted?: () => void;
  onToggleSpeakerMuted?: () => void;
  onEndSession?: () => void;
  showCallActions?: boolean;
  className?: string;
}

export function formatCallDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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

const EQUALIZER_WEIGHTS = [0.62, 1.0, 0.72] as const;

export const VoiceCallBar: React.FC<VoiceCallBarProps> = ({
  activeSpeaker = 'agent',
  speakerLevel = 0,
  startedAt,
  linkPhase,
  isThinking = false,
  isListening = false,
  playbackSpeed,
  onChangePlaybackSpeed,
  collapsed,
  onToggleCollapse,
  micMuted = false,
  speakerMuted = false,
  onToggleMicMuted,
  onToggleSpeakerMuted,
  onEndSession,
  showCallActions = false,
  className = '',
}) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || linkPhase) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => window.clearInterval(timer);
  }, [startedAt, linkPhase]);

  const clampedLevel = Number.isFinite(speakerLevel)
    ? Math.max(0, Math.min(1, speakerLevel))
    : 0;
  const elapsedMs =
    typeof startedAt === 'number' && Number.isFinite(startedAt)
      ? Math.max(0, nowMs - startedAt)
      : 0;

  return (
    <header
      data-testid="voice-teleprompter-call-bar"
      className={`kite-voice-callbar ${className}`.trim()}
    >
      <div className="kite-voice-callbar__left">
        <span
          data-testid="live-turn-speaker"
          data-speaker={activeSpeaker}
          className="kite-voice-callbar__speaker"
        >
          <span
            className={`kite-voice-callbar__orb-dot${
              clampedLevel > 0.04 || isListening || isThinking
                ? ' kite-voice-callbar__orb-dot--live'
                : ''
            }`}
            aria-hidden="true"
          />
          {activeSpeaker === 'you' ? (
            <svg {...iconProps} className="kite-voice-callbar__mic-icon">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          ) : (
            <span
              className={`kite-voice-eq${clampedLevel > 0.04 ? ' kite-voice-eq--active' : ''}`}
              aria-hidden="true"
            >
              {EQUALIZER_WEIGHTS.map((weight, idx) => {
                const base = isThinking ? 0.42 : 0.28;
                const scale = Math.min(1, Math.max(0.24, base + clampedLevel * weight * 0.72));
                return (
                  <span
                    key={idx}
                    className="kite-voice-eq-bar"
                    style={{ '--eq-scale': scale.toFixed(3) } as React.CSSProperties}
                  />
                );
              })}
            </span>
          )}
          <span className="kite-voice-callbar__speaker-label">
            {activeSpeaker === 'you' ? 'Tú' : 'Argos'}
          </span>
        </span>

        {linkPhase ? (
          <span
            data-testid="voice-call-timer"
            data-link-phase={linkPhase}
            className="kite-voice-callbar__link-status"
          >
            {linkPhase === 'connecting' ? 'Conectando…' : 'Reconectando…'}
          </span>
        ) : (
          <span data-testid="voice-call-timer" className="kite-voice-callbar__timer">
            {formatCallDuration(elapsedMs)}
          </span>
        )}
      </div>

      <div className="kite-voice-callbar__right">
        <VoiceSpeedPopover
          playbackSpeed={playbackSpeed}
          onChangePlaybackSpeed={onChangePlaybackSpeed}
        />

        <button
          type="button"
          data-testid="voice-teleprompter-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expandir teleprompter' : 'Minimizar teleprompter'}
          title={collapsed ? 'Expandir teleprompter' : 'Minimizar teleprompter'}
          onClick={onToggleCollapse}
          className="kite-voice-callbar__collapse-btn rounded-control"
        >
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`kite-voice-callbar__chevron${collapsed ? ' kite-voice-callbar__chevron--collapsed' : ''}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {showCallActions ? (
          <>
            <button
              type="button"
              data-testid="voice-call-mic-toggle"
              aria-pressed={Boolean(micMuted)}
              aria-label={micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
              title={micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
              data-muted={micMuted ? 'true' : undefined}
              onClick={onToggleMicMuted}
              className="kite-voice-callbar__action-btn rounded-control"
            >
              {micMuted ? (
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
              data-testid="voice-call-speaker-toggle"
              aria-pressed={Boolean(speakerMuted)}
              aria-label={speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
              title={speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
              data-muted={speakerMuted ? 'true' : undefined}
              onClick={onToggleSpeakerMuted}
              className="kite-voice-callbar__action-btn rounded-control"
            >
              {speakerMuted ? (
                <svg {...iconProps}>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="22" y1="9" x2="16" y2="15" />
                  <line x1="16" y1="9" x2="22" y2="15" />
                </svg>
              ) : (
                <svg {...iconProps}>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </button>

            <span className="kite-voice-callbar__divider" aria-hidden="true" />

            <button
              type="button"
              data-testid="voice-call-end"
              aria-label="Finalizar sesión de voz"
              title="Finalizar sesión de voz"
              onClick={onEndSession}
              className="kite-voice-callbar__end-btn rounded-pill"
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
              <span className="kite-voice-callbar__end-label">Finalizar</span>
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
};
