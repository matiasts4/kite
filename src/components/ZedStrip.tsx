import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ZedOrb, type ZedOrbState } from './ZedOrb';
import { type OperatorBrainResponse } from '../lib/operator/operatorBrain';
import { ttsNarrator } from '../lib/operator/ttsNarrator';
import { loadOperatorConfig } from '../lib/operator/operatorConfig';
import { useOperatorTurn } from '../lib/operator/hooks/useOperatorTurn';
import { resolveZedOrbState } from '../lib/operator/hooks/useOperatorTurnLogic';
import { isBrowserTestLane } from '../lib/browserTestLane';
import { useOperatorVoice } from '../lib/operator/hooks/useOperatorVoice';
import { releaseOperatorCapture } from '../lib/operator/voice/zedVoice';
import './zedFloat.css';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ZedToolCallItem {
  id: string;
  name: string;
  summary: string;
  ok: boolean;
  latencyMs?: number;
}

export interface PendingConfirmation {
  id: string;
  summary: string;
  toolName: string;
}

export interface ZedCallState {
  isActive: boolean;
  status: string;
  orbState?: ZedOrbState;
  statusLine?: string;
  lastError?: string | null;
  muted?: boolean;
  speakerMuted?: boolean;
  toolCalls: ZedToolCallItem[];
  pendingConfirmation?: PendingConfirmation | null;
}

export interface ZedStripProps {
  call: ZedCallState;
  workspaceId?: string | null;
  getAudioLevel?: () => number;
  onToggleMute?: () => void;
  onToggleSpeaker?: () => void;
  onEndCall?: () => void;
  onApproveConfirmation?: () => void;
  onCancelConfirmation?: () => void;
  onOpenSettingsZed?: () => void;
  onExecuteCommand?: (input: string) => Promise<OperatorBrainResponse | void>;
}

// ── Constants & Helpers ──────────────────────────────────────────────────────

const FLOAT_POS_STORAGE_KEY = 'kite.assistant.floatPos.v5';
const DRAG_THRESHOLD_PX = 4;

interface FloatPoint {
  x: number;
  y: number;
}

function clampPoint(x: number, y: number): FloatPoint {
  const margin = 16;
  const topMin = 40;
  const orbSize = 72;
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const maxX = Math.max(margin, winW - orbSize - margin);
  const maxY = Math.max(topMin, winH - orbSize - margin - 50);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(topMin, y)),
  };
}

function loadSavedPoint(): FloatPoint {
  try {
    const raw = localStorage.getItem(FLOAT_POS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FloatPoint>;
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
        return clampPoint(parsed.x * winW, parsed.y * winH);
      }
    }
  } catch {
    // ignore
  }
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  return clampPoint(winW - 120, 64);
}

function savePoint(pos: FloatPoint): void {
  try {
    const x = window.innerWidth > 0 ? pos.x / window.innerWidth : 0;
    const y = window.innerHeight > 0 ? pos.y / window.innerHeight : 0;
    localStorage.setItem(FLOAT_POS_STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    // ignore
  }
}

// ── ZedStrip Component ───────────────────────────────────────────────────────

export const ZedStrip: React.FC<ZedStripProps> = ({
  call,
  workspaceId,
  getAudioLevel,
  onToggleMute,
  onToggleSpeaker,
  onEndCall,
  onApproveConfirmation,
  onCancelConfirmation,
  onExecuteCommand,
}) => {
  const rootRef = useRef<HTMLElement | null>(null);

  const [point, setPoint] = useState<FloatPoint>(loadSavedPoint);
  const pointRef = useRef<FloatPoint>(point);
  useEffect(() => {
    pointRef.current = point;
  }, [point]);

  const [isDragging, setIsDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [manualInputValue, setManualInputValue] = useState('');
  const [speakingTts, setSpeakingTts] = useState(false);
  const [orbAck, setOrbAck] = useState(false);

  useEffect(() => {
    let timer = 0;
    const onAck = () => {
      setOrbAck(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setOrbAck(false), 180);
    };
    window.addEventListener('kite:zed-orb-ack', onAck);
    return () => {
      window.removeEventListener('kite:zed-orb-ack', onAck);
      window.clearTimeout(timer);
    };
  }, []);
  const [manualCommandResult, setManualCommandResult] = useState<{
    reply: string;
    latencyMs?: number;
    ok?: boolean;
  } | null>(null);

  const browserTestUi = isBrowserTestLane();

  // Hook for unified turn execution & lifecycle
  const turn = useOperatorTurn(workspaceId ?? null);

  // Voice dictation hook (Grok Cloud / Native Speech Engine)
  const voice = useOperatorVoice({
    language: 'es-ES',
    onFinalTranscript: async (text) => {
      if (!text || text.trim().length === 0) return;
      if (onExecuteCommand) {
        const res = await onExecuteCommand(text);
        if (res) {
          setManualCommandResult({
            reply: res.reply,
            latencyMs: res.latencyMs,
            ok: true,
          });
        }
      } else {
        try {
          await turn.runTurn(text);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'No se pudo ejecutar la orden.';
          setManualCommandResult({ reply: message, ok: false });
        }
      }
    },
  });

  // When turn finishes with reply, auto-speak if TTS is enabled and not muted
  useEffect(() => {
    const reply = manualCommandResult?.reply || turn.lastTurn?.reply;
    if (turn.stage === 'done' && reply && !call.speakerMuted) {
      setSpeakingTts(true);
      const opConfig = loadOperatorConfig();
      ttsNarrator.speak(reply, {
        voiceName: opConfig.persona?.voice || 'Ara',
        rate: opConfig.ttsRate || 1.0,
        lang: opConfig.persona?.language === 'en' ? 'en-US' : 'es-ES',
        onEnd: () => setSpeakingTts(false),
        onError: () => setSpeakingTts(false),
      });
    }
  }, [turn.stage, turn.lastTurn, manualCommandResult, call.speakerMuted]);

  // Toggle voice dictation
  const handleToggleVoice = useCallback(async () => {
    // Unconditionally stop TTS on user interruption
    ttsNarrator.stop();
    setSpeakingTts(false);

    if (call.muted && onToggleMute) {
      onToggleMute();
    }
    if (voice.error) {
      voice.clearError();
    }
    if (voice.isListening) {
      voice.stopListening();
      return;
    }
    turn.resetStage();
    await voice.startListening();
  }, [voice, call.muted, onToggleMute, turn]);

  // Handle speaker toggle (TTS aloud narration)
  const handleToggleSpeaker = useCallback(() => {
    if (speakingTts) {
      ttsNarrator.stop();
      setSpeakingTts(false);
    }
    onToggleSpeaker?.();
  }, [speakingTts, onToggleSpeaker]);

  // Universal pointer drag handler with window-level listeners
  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't drag if clicking directly on a button
    if (target.tagName === 'BUTTON' || target.closest('button')) return;

    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const initialPos = { ...pointRef.current };
    let hasDragged = false;

    const isOrbHandle =
      target.classList.contains('zed-float__handle') ||
      !!target.closest('.zed-float__orb-container');

    let isHoldingToTalk = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const pressStartTime = Date.now();

    if (isOrbHandle && !voice.isListening) {
      if (voice.error) {
        voice.clearError();
      }
      turn.resetStage();
      holdTimer = setTimeout(async () => {
        if (!hasDragged) {
          isHoldingToTalk = true;
          ttsNarrator.stop();
          setSpeakingTts(false);
          if (call.muted && onToggleMute) {
            onToggleMute();
          }
          await voice.startListening();
        }
      }, 400);
    }

    const onPointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;

      if (!hasDragged) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        hasDragged = true;
        setIsDragging(true);

        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        if (isHoldingToTalk) {
          isHoldingToTalk = false;
          voice.stopListening();
        }
      }

      const nextPos = clampPoint(initialPos.x + dx, initialPos.y + dy);
      setPoint(nextPos);
      pointRef.current = nextPos;
    };

    const onPointerUp = async () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }

      if (hasDragged) {
        savePoint(pointRef.current);
      } else if (isHoldingToTalk) {
        isHoldingToTalk = false;
        const elapsed = Date.now() - pressStartTime;
        // A short press starts listening and stays open. Only a real hold sends.
        if (elapsed > 900) {
          voice.stopListening();
        }
      } else if (isOrbHandle) {
        // Clean tap on sphere (< 400ms) -> toggle voice dictation
        await handleToggleVoice();
      }

      setIsDragging(false);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // Global keyboard shortcuts while the floating assistant is visible
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent repeated firing when holding down key
      if (e.repeat) return;

      // Escape: Close/Hide assistant
      if (e.key === 'Escape') {
        e.preventDefault();
        ttsNarrator.stop();
        voice.stopListening();
        void releaseOperatorCapture();
        onEndCall?.();
        return;
      }

      // Ctrl+Shift+V or Alt+V: Toggle voice dictation
      const isVoiceShortcut =
        ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) ||
        (e.altKey && (e.key === 'v' || e.key === 'V'));

      if (isVoiceShortcut) {
        e.preventDefault();
        handleToggleVoice();
      }
    };

    const handleVoiceEvent = () => {
      handleToggleVoice();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('kite:toggle-voice', handleVoiceEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('kite:toggle-voice', handleVoiceEvent);
    };
  }, [handleToggleVoice, onEndCall, voice]);

  // Keep orb within bounds on window resize
  useEffect(() => {
    const onResize = () => setPoint((prev) => clampPoint(prev.x, prev.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Determine effective Orb visual state (electric cyan 'listening' when recording, violet plasma when thinking!)
  const effectiveOrbState: ZedOrbState = resolveZedOrbState({
    callLastError: call.lastError,
    turnStage: turn.stage,
    voiceError: voice.error,
    turnBusy: turn.busy,
    isListening: voice.isListening,
    isTranscribing: voice.isTranscribing,
    speakingTts,
    callOrbState: call.orbState,
    callMuted: call.muted,
  });

  const effectiveAudioLevel = voice.isListening
    ? () => voice.audioLevel
    : getAudioLevel;

  // Active status text note: returns null when idle so NO bottom bar appears!
  const displayedNote: string | null = (() => {
    if (voice.error) {
      return voice.error;
    }
    if (call.lastError) {
      return call.lastError;
    }
    if (turn.stage === 'error') {
      return turn.stageLabel || 'Ocurrió un error al procesar la acción';
    }
    if (voice.isListening) {
      return voice.interimTranscript
        ? `«${voice.interimTranscript}»`
        : '🎙️ Escuchando tu voz… (habla y espera o haz clic para enviar)';
    }
    if (voice.isTranscribing) {
      return 'Transcribiendo tu voz en la nube…';
    }
    if (turn.busy) {
      return turn.stageLabel || 'Procesando…';
    }
    if (manualCommandResult?.reply) {
      return manualCommandResult.reply;
    }
    if (turn.lastTurn?.reply) {
      return turn.lastTurn.reply;
    }
    if (call.statusLine) {
      return call.statusLine;
    }
    return null;
  })();

  // Latency to show in note badge
  const displayedLatency: number | undefined =
    manualCommandResult?.latencyMs ?? turn.lastTurn?.durationMs;

  // Handle command submission
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = manualInputValue.trim();
    if (!text) return;
    setManualInputValue('');
    if (onExecuteCommand) {
      const res = await onExecuteCommand(text);
      if (res) {
        setManualCommandResult({
          reply: res.reply,
          latencyMs: res.latencyMs,
          ok: true,
        });
      }
    } else {
      await turn.runTurn(text);
    }
  };

  return (
    <aside
      ref={rootRef}
      className={`zed-float ${isDragging ? 'zed-float--dragging' : ''} ${hovering ? 'zed-float--hovering' : ''}${browserTestUi ? ' zed-float--browser-test' : ''}`}
      data-testid="zed-card"
      style={{ left: `${point.x}px`, top: `${point.y}px` }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* 1. Pure 72px Spherical Orb Container (Mathematically Centered) */}
      <div className="zed-float__orb-container">
        <div className={`zed-float__orb${orbAck ? ' motion-orb-ack' : ''}`}>
          <ZedOrb
            state={effectiveOrbState}
            size={72}
            getLevel={effectiveAudioLevel}
            interactive={false}
          />
        </div>

        {/* Circular Drag Handle & Push-to-Talk / Click-to-Speak Trigger */}
        <div
          className="zed-float__handle"
          onPointerDown={handlePointerDown}
          role="button"
          tabIndex={0}
          title={
            voice.error
              ? voice.error
              : voice.isListening
                ? 'Escuchando voz… Suelta o haz clic para enviar (Ctrl+Shift+V)'
                : 'Mantén presionado para hablar, haz clic o arrastra (Ctrl+Shift+V)'
          }
          aria-label={
            voice.isListening
              ? 'Detener y enviar dictado de voz'
              : 'Iniciar dictado de voz'
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggleVoice();
            }
          }}
        />

        {/* Microphone Mute Pip */}
        {call.muted && !voice.isListening && (
          <span className="zed-float__mute-pip" title="Micrófono silenciado" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="2" y1="2" x2="22" y2="22" />
              <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
              <path d="M5 10v2a7 7 0 0 0 12 5" />
            </svg>
          </span>
        )}
      </div>

      {/* 2. Micro-Controls Dock Directly Below Sphere: 3 Buttons [Mic] [Speaker] [Close] */}
      <div
        className="zed-float__controls"
        data-shown="true"
        onPointerDown={handlePointerDown}
        title="Arrastra para mover el asistente"
      >
        {/* Button 1: Micrófono (Voice Dictation Toggle) */}
        <button
          type="button"
          className={`zed-float__control ${voice.isListening ? 'zed-float__control--active' : ''} ${call.muted && !voice.isListening ? 'zed-float__control--muted' : ''}`}
          onClick={handleToggleVoice}
          title={voice.isListening ? 'Escuchando voz… (clic para enviar)' : 'Hablar con Asistente (Ctrl+Shift+V)'}
          aria-label={voice.isListening ? 'Detener y enviar dictado de voz' : 'Dictar por voz al Asistente'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        </button>

        {/* Button 2: Parlante / Speaker (Toggle Agent Speaking Aloud via TTS) */}
        <button
          type="button"
          className={`zed-float__control ${call.speakerMuted ? 'zed-float__control--muted' : ''}`}
          onClick={handleToggleSpeaker}
          title={call.speakerMuted ? 'Activar voz en altavoz (TTS)' : 'Silenciar voz en altavoz (TTS)'}
          aria-label={call.speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
        >
          {call.speakerMuted ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="22" y1="9" x2="16" y2="15" />
              <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          )}
        </button>

        {/* Button 3: Cerrar (✕ Close Assistant) */}
        <button
          type="button"
          className="zed-float__control zed-float__control--end"
          onClick={() => {
            ttsNarrator.stop();
            voice.stopListening();
            void releaseOperatorCapture();
            onEndCall?.();
          }}
          title="Cerrar Asistente (Esc)"
          aria-label="Cerrar Asistente"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 3. Accessible Status Note (Screen readers & tests — NO visual bottom bar/pill below buttons) */}
      {(displayedNote || (browserTestUi && turn.stageLabel)) && (
        <div
          className={browserTestUi ? 'zed-float__browser-status' : 'sr-only'}
          data-testid="zed-status"
          role="status"
          aria-live="polite"
        >
          <span className="zed-float__note-text">
            {displayedNote || turn.stageLabel}
          </span>
          {typeof displayedLatency === 'number' && displayedLatency > 0 && (
            <span className="zed-float__latency-badge">{displayedLatency}ms</span>
          )}
        </div>
      )}

      {/* Action Confirmation Buttons (Rendered only when explicit confirmation is required) */}
      {call.pendingConfirmation && (
        <div className="zed-float__answers">
          <button
            type="button"
            className="zed-float__action-btn zed-float__action-btn--primary"
            onClick={onApproveConfirmation}
          >
            Aceptar
          </button>
          <button
            type="button"
            className="zed-float__action-btn zed-float__action-btn--secondary"
            onClick={onCancelConfirmation}
          >
            Cancelar
          </button>
        </div>
      )}

      {/* Accessible Command Form (Always available for programmatic input, tests, and assistive tech) */}
      <form
        onSubmit={handleFormSubmit}
        className={`zed-float__accessible-form${browserTestUi ? ' zed-float__accessible-form--visible' : ''}`}
        aria-hidden={browserTestUi ? undefined : true}
      >
        <input
          type="text"
          className="zed-float__accessible-input"
          data-testid="zed-input"
          placeholder="Ej: abre 2 terminales con grok y ejecuta los test"
          value={manualInputValue}
          onChange={(e) => setManualInputValue(e.target.value)}
          aria-label="Comando de texto para el Asistente"
          tabIndex={browserTestUi ? 0 : -1}
        />
        <button
          type="submit"
          className="zed-float__accessible-send"
          data-testid="zed-send"
          aria-label="Enviar comando accesible"
          tabIndex={browserTestUi ? 0 : -1}
        >
          Enviar
        </button>
      </form>
    </aside>
  );
};

// ── ZedStripHost Component ───────────────────────────────────────────────────

export interface ZedStripHostProps extends Omit<ZedStripProps, 'call'> {
  call?: ZedCallState | null;
}

export const ZedStripHost: React.FC<ZedStripHostProps> = ({ call, ...rest }) => {
  if (!call || !call.isActive) return null;
  return <ZedStrip call={call} {...rest} />;
};

export default ZedStripHost;
