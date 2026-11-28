import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArgosOrb } from '../../../ArgosOrb';
import {
  VOICE_PRESETS,
  getVoicePalette,
  type VoicePreset,
} from '../../../../lib/operator/config/voicePalettes';
import './VoicePickerModal.css';

export interface VoicePickerModalProps {
  isOpen: boolean;
  initialVoice?: string | null;
  volume?: number;
  onClose: () => void;
  onSelectVoice: (voiceName: string) => void;
}

type SlideDirection = 'next' | 'prev' | null;

const PREVIEW_DURATION_MS = 640;

const VOICE_PREVIEW_CHORDS: Record<string, readonly number[]> = {
  ara: [293.66, 369.99, 440.0, 554.37],
  vega: [261.63, 329.63, 392.0, 493.88],
  orion: [196.0, 246.94, 293.66, 369.99],
  lyra: [329.63, 415.3, 493.88, 622.25],
  nova: [349.23, 440.0, 523.25, 659.25],
  cael: [220.0, 261.63, 329.63, 392.0],
  sora: [392.0, 493.88, 587.33, 739.99],
  taro: [246.94, 293.66, 369.99, 440.0],
  luma: [277.18, 349.23, 415.3, 523.25],
};

function resolveInitialIndex(voiceName?: string | null): number {
  const matched = getVoicePalette(voiceName);
  const idx = VOICE_PRESETS.findIndex((preset) => preset.id === matched.id);
  return idx >= 0 ? idx : 0;
}

function normalizePreviewVolume(volume?: number): number {
  if (volume === undefined || !Number.isFinite(volume)) return 1;
  if (volume <= 0) return 0;
  if (volume <= 1) return volume;
  return Math.min(1, volume / 100);
}

function resolveAudioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
  return typeof ctor === 'function' ? ctor : null;
}

const CloseIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const ChevronLeftIcon: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const ChevronRightIcon: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const VoicePickerModal: React.FC<VoicePickerModalProps> = ({
  isOpen,
  initialVoice,
  volume = 1,
  onClose,
  onSelectVoice,
}) => {
  const titleId = useId();
  const subtitleId = useId();

  const [activeIndex, setActiveIndex] = useState<number>(() =>
    resolveInitialIndex(initialVoice)
  );
  const [slideDirection, setSlideDirection] = useState<SlideDirection>(null);
  const [slideCycle, setSlideCycle] = useState(0);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [previewLevel, setPreviewLevel] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeOscillatorsRef = useRef<OscillatorNode[]>([]);
  const activeGainRef = useRef<GainNode | null>(null);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRafRef = useRef<number>(0);

  const stopPreview = useCallback(() => {
    if (previewTimeoutRef.current !== null) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    if (previewRafRef.current) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = 0;
    }

    for (const osc of activeOscillatorsRef.current) {
      try {
        osc.stop();
      } catch {
        // oscillator may already be stopped
      }
      try {
        osc.disconnect();
      } catch {
        // ignore disconnected oscillator
      }
    }
    activeOscillatorsRef.current = [];

    if (activeGainRef.current) {
      try {
        activeGainRef.current.disconnect();
      } catch {
        // ignore disconnected gain
      }
      activeGainRef.current = null;
    }

    setIsPlayingPreview(false);
    setPreviewLevel(0);
  }, []);

  const closeAudioContext = useCallback(() => {
    stopPreview();
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
      try {
        void Promise.resolve(ctx.close()).catch((err) => {
          console.warn('[VoicePickerModal] Failed to close preview AudioContext:', err);
        });
      } catch (err) {
        console.warn('[VoicePickerModal] Preview AudioContext close error:', err);
      }
    }
  }, [stopPreview]);

  const playChordPreview = useCallback(
    (preset: VoicePreset) => {
      stopPreview();

      const AudioCtx = resolveAudioContextCtor();
      if (!AudioCtx) return;

      const normalizedVolume = normalizePreviewVolume(volume);
      if (normalizedVolume <= 0) return;

      try {
        let ctx = audioCtxRef.current;
        if (!ctx || ctx.state === 'closed') {
          ctx = new AudioCtx();
          audioCtxRef.current = ctx;
        }
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          void ctx.resume().catch((err) => {
            console.warn('[VoicePickerModal] AudioContext resume failed:', err);
          });
        }

        const now = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
        const durationSec = PREVIEW_DURATION_MS / 1000;
        const masterGain = ctx.createGain();
        const peakGain = 0.08 * normalizedVolume;

        if (typeof masterGain.gain.setValueAtTime === 'function') {
          masterGain.gain.setValueAtTime(0.0001, now);
        }
        if (typeof masterGain.gain.linearRampToValueAtTime === 'function') {
          masterGain.gain.linearRampToValueAtTime(peakGain, now + 0.035);
          masterGain.gain.linearRampToValueAtTime(0.0001, now + durationSec);
        } else {
          masterGain.gain.value = peakGain;
        }
        masterGain.connect(ctx.destination);
        activeGainRef.current = masterGain;

        const chord = VOICE_PREVIEW_CHORDS[preset.id] ?? VOICE_PREVIEW_CHORDS.ara;
        const oscillators: OscillatorNode[] = [];

        for (let idx = 0; idx < chord.length; idx += 1) {
          const osc = ctx.createOscillator();
          osc.type = idx === 0 ? 'triangle' : 'sine';
          const noteStart = now + idx * 0.018;
          if (typeof osc.frequency.setValueAtTime === 'function') {
            osc.frequency.setValueAtTime(chord[idx], noteStart);
          } else {
            osc.frequency.value = chord[idx];
          }
          osc.connect(masterGain);
          osc.start(noteStart);
          oscillators.push(osc);
        }

        activeOscillatorsRef.current = oscillators;
        setIsPlayingPreview(true);
        setPreviewLevel(Math.min(1, 0.55 * normalizedVolume));

        const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const animateEnvelope = (frameTime: number) => {
          const progress = Math.min(1, (frameTime - startedAt) / PREVIEW_DURATION_MS);
          if (progress >= 1) {
            setPreviewLevel(0);
            return;
          }
          const envelope = Math.sin(progress * Math.PI) * 0.72 * normalizedVolume;
          setPreviewLevel(Math.max(0, Math.min(1, envelope)));
          if (typeof requestAnimationFrame === 'function') {
            previewRafRef.current = requestAnimationFrame(animateEnvelope);
          }
        };

        if (typeof requestAnimationFrame === 'function') {
          previewRafRef.current = requestAnimationFrame(animateEnvelope);
        }

        previewTimeoutRef.current = setTimeout(() => {
          stopPreview();
        }, PREVIEW_DURATION_MS);
      } catch (err) {
        console.warn('[VoicePickerModal] Web Audio preview failed:', err);
        stopPreview();
      }
    },
    [stopPreview, volume]
  );

  // Sync initial voice when opening and clean up Web Audio cleanly when closing/unmounting.
  useEffect(() => {
    if (isOpen) {
      setActiveIndex(resolveInitialIndex(initialVoice));
      setSlideDirection(null);
      return;
    }
    closeAudioContext();
  }, [isOpen, initialVoice, closeAudioContext]);

  useEffect(() => {
    return () => {
      closeAudioContext();
    };
  }, [closeAudioContext]);

  const activePreset = VOICE_PRESETS[activeIndex] ?? VOICE_PRESETS[0];

  const selectIndex = useCallback(
    (nextIdx: number, direction: SlideDirection) => {
      const total = VOICE_PRESETS.length;
      const wrapped = ((nextIdx % total) + total) % total;
      const targetPreset = VOICE_PRESETS[wrapped];
      setActiveIndex(wrapped);
      setSlideDirection(direction);
      setSlideCycle((prev) => prev + 1);
      playChordPreview(targetPreset);
    },
    [playChordPreview]
  );

  const handleConfirm = useCallback(() => {
    closeAudioContext();
    onSelectVoice(activePreset.name);
    onClose();
  }, [activePreset.name, closeAudioContext, onClose, onSelectVoice]);

  const handleDismiss = useCallback(() => {
    closeAudioContext();
    onClose();
  }, [closeAudioContext, onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        handleDismiss();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectIndex(activeIndex - 1, 'prev');
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectIndex(activeIndex + 1, 'next');
        return;
      }
      if (event.key === 'Enter') {
        const target = event.target as HTMLElement | null;
        if (target && target.tagName === 'BUTTON') {
          return;
        }
        event.preventDefault();
        handleConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, activeIndex, selectIndex, handleConfirm, handleDismiss]);

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  const paletteStyle = {
    '--voice-deep': activePreset.palette.deep.join(', '),
    '--voice-core': activePreset.palette.core.join(', '),
    '--voice-glint': activePreset.palette.glint.join(', '),
  } as React.CSSProperties;

  const slideClass =
    slideDirection === 'next'
      ? 'voice-picker__identity--slide-next'
      : slideDirection === 'prev'
      ? 'voice-picker__identity--slide-prev'
      : '';

  return createPortal(
    <div
      className="voice-picker-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          handleDismiss();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        data-testid="voice-picker"
        className="voice-picker"
        style={paletteStyle}
      >
        <div className="voice-picker__header">
          <div className="voice-picker__heading">
            <h2 id={titleId} className="voice-picker__title">
              Elegir voz de Argos
            </h2>
            <p id={subtitleId} className="voice-picker__subtitle">
              Desliza con las flechas para escuchar la cadencia y color de cada perfil.
            </p>
          </div>
          <button
            type="button"
            className="voice-picker__close"
            onClick={handleDismiss}
            aria-label="Cerrar selector de voz"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="voice-picker__body">
          <div className="voice-picker__stage">
            <button
              type="button"
              className="voice-picker__nav-btn"
              data-testid="voice-picker-prev"
              aria-label="Voz anterior"
              onClick={() => selectIndex(activeIndex - 1, 'prev')}
            >
              <ChevronLeftIcon />
            </button>

            <div className="voice-picker__orb-wrap">
              <ArgosOrb
                figure="plasma-orb"
                size={140}
                state={isPlayingPreview ? 'speaking' : 'listening'}
                level={previewLevel}
                ariaLabel={`Vista previa de voz ${activePreset.name}`}
              />
            </div>

            <button
              type="button"
              className="voice-picker__nav-btn"
              data-testid="voice-picker-next"
              aria-label="Siguiente voz"
              onClick={() => selectIndex(activeIndex + 1, 'next')}
            >
              <ChevronRightIcon />
            </button>
          </div>

          <div className="voice-picker__identity-viewport">
            <div
              key={slideCycle}
              className={['voice-picker__identity', slideClass].filter(Boolean).join(' ')}
            >
              <h3 data-testid="voice-picker-name" className="voice-picker__name">
                {activePreset.name}
              </h3>
              <p className="voice-picker__tone">{activePreset.toneEs}</p>
            </div>
          </div>

          <div className="voice-picker__dots" role="group" aria-label="Voces disponibles">
            {VOICE_PRESETS.map((preset, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`voice-picker-dot-${preset.id}`}
                  aria-label={`Seleccionar voz ${preset.name}`}
                  aria-pressed={isSelected}
                  className={[
                    'voice-picker__dot',
                    isSelected ? 'voice-picker__dot--active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() =>
                    selectIndex(idx, idx >= activeIndex ? 'next' : 'prev')
                  }
                />
              );
            })}
          </div>
        </div>

        <div className="voice-picker__footer">
          <span className="voice-picker__hint">← / → para explorar · Enter para usar</span>
          <div className="voice-picker__actions">
            <button
              type="button"
              className="secondary-button voice-picker__cancel-btn"
              onClick={handleDismiss}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="primary-button voice-picker__use-btn"
              data-testid="voice-picker-use"
              onClick={handleConfirm}
            >
              {`Usar ${activePreset.name}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default VoicePickerModal;
