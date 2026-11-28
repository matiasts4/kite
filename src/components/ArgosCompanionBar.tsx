import React, { useEffect, useState } from 'react';
import { ttsNarrator } from '../lib/operator/ttsNarrator';
import {
  attachContextSnapshotToVoiceTurn,
  captureVisualContextSnapshot,
  COMPANION_GLOBAL_HOTKEY_EVENT,
  getCurrentCompanionWindowId,
  loadCompanionGlobalShortcut,
  matchesCompanionHotkey,
  releaseVoiceHostClaim,
  transferVoiceCallSurface,
  type CompanionHotkeyConfig,
  type VisualContextSnapshot,
} from '../lib/operator/voice/companionTransfer';
import {
  useVoiceSession,
  voiceSessionStore,
} from '../lib/operator/voice/voiceSessionStore';

export interface ArgosCompanionBarProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  enableGlobalHotkey?: boolean;
  hotkey?: CompanionHotkeyConfig | string;
  threadId?: string | null;
  windowId?: string;
  onSendText?: (text: string, snapshot?: VisualContextSnapshot | null) => void | Promise<void>;
  onTransferToThread?: (threadId: string | null) => void;
  onEndSession?: () => void;
  className?: string;
}

const WAVE_BAR_FACTORS = [0.42, 0.78, 1.0, 0.72, 0.48];

export const ArgosCompanionBar: React.FC<ArgosCompanionBarProps> = ({
  open,
  defaultOpen = false,
  onOpenChange,
  enableGlobalHotkey = true,
  hotkey,
  threadId,
  windowId,
  onSendText,
  onTransferToThread,
  onEndSession,
  className = '',
}) => {
  const voice = useVoiceSession();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [inputText, setInputText] = useState('');
  const [attachedSnapshot, setAttachedSnapshot] = useState<VisualContextSnapshot | null>(null);

  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;

  const setOpenState = (next: boolean) => {
    if (!isControlled) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!enableGlobalHotkey) return;

    const effectiveHotkey = hotkey ?? loadCompanionGlobalShortcut();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesCompanionHotkey(event, effectiveHotkey)) return;
      event.preventDefault();
      setOpenState(!isOpen);
    };

    const handleGlobalSummon = () => {
      const effectiveThread = threadId ?? voiceSessionStore.getSnapshot().boundThreadId ?? null;
      const snap = captureVisualContextSnapshot({
        activeSurface: 'companion',
        boundThreadId: effectiveThread,
      });
      setAttachedSnapshot(snap);
      void attachContextSnapshotToVoiceTurn(snap, { threadId: effectiveThread });
      setOpenState(true);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(COMPANION_GLOBAL_HOTKEY_EVENT, handleGlobalSummon);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(COMPANION_GLOBAL_HOTKEY_EVENT, handleGlobalSummon);
    };
  }, [enableGlobalHotkey, hotkey, isOpen, isControlled, onOpenChange, threadId]);

  if (!isOpen) return null;

  const effectiveThreadId = threadId ?? voice.boundThreadId ?? null;
  const effectiveWindowId = windowId ?? getCurrentCompanionWindowId();

  const statusText = voice.micMuted
    ? 'Micrófono en pausa'
    : voice.draftProposal?.status === 'awaiting_confirmation'
      ? 'Esperando tu confirmación…'
      : 'Argos · En vivo';

  const handleAttachContext = async () => {
    const snapshot = captureVisualContextSnapshot({
      activeSurface: 'companion',
      boundThreadId: effectiveThreadId,
    });
    setAttachedSnapshot(snapshot);
    await attachContextSnapshotToVoiceTurn(snapshot, {
      threadId: effectiveThreadId,
    });
  };

  const handleClearContext = () => {
    setAttachedSnapshot(null);
  };

  const handleToggleSpeaker = () => {
    if (!voice.speakerMuted) {
      ttsNarrator.stop();
    }
    voice.toggleSpeakerMuted();
  };

  const handleTransferToThread = () => {
    const res = transferVoiceCallSurface('thread', {
      threadId: effectiveThreadId,
      windowId: effectiveWindowId,
    });
    onTransferToThread?.(res.threadId);
  };

  const handleEndSession = () => {
    ttsNarrator.stop();
    voiceSessionStore.stopSession();
    releaseVoiceHostClaim(effectiveWindowId);
    onEndSession?.();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = inputText.trim();
    if (!clean) return;

    const currentSnapshot = attachedSnapshot;
    setInputText('');

    if (onSendText) {
      await onSendText(clean, currentSnapshot);
      setAttachedSnapshot(null);
      return;
    }

    if (currentSnapshot && effectiveThreadId && voiceSessionStore.hasTextTurnExecutor()) {
      await attachContextSnapshotToVoiceTurn(currentSnapshot, {
        threadId: effectiveThreadId,
        promptText: clean,
        submit: true,
      });
      setAttachedSnapshot(null);
      return;
    }

    if (effectiveThreadId && voiceSessionStore.hasTextTurnExecutor()) {
      await voiceSessionStore.submitTextTurn(clean, effectiveThreadId);
    }
    setAttachedSnapshot(null);
  };

  const liveLevel = Math.max(0.2, Math.min(1, voice.liveAudioLevel || (voice.isListening ? 0.55 : 0.28)));

  return (
    <aside
      data-testid="argos-companion-bar"
      role="dialog"
      aria-label="Argos Companion Voice Bar"
      className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl rounded-dialog border border-border bg-surface/95 backdrop-blur-xl shadow-2xl p-3 flex flex-col gap-2.5 text-neutral-100 ${className}`.trim()}
    >
      {/* Top row: Status + Live Waveform Pill & Visual Context Attachment Chip */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div
          data-testid="argos-companion-status-pill"
          role="status"
          aria-live="polite"
          className="h-7 rounded-pill px-3 inline-flex items-center gap-2 bg-white/5 border border-white/10 text-xs font-medium text-neutral-100"
        >
          <span
            data-testid="argos-companion-waveform"
            aria-hidden="true"
            className="inline-flex items-center gap-0.5 h-3"
          >
            {WAVE_BAR_FACTORS.map((factor, idx) => {
              const barPct = voice.micMuted
                ? 25
                : Math.round(Math.max(25, Math.min(100, factor * liveLevel * 100)));
              return (
                <span
                  key={idx}
                  className={`w-0.5 rounded-pill transition-all ${
                    voice.micMuted ? 'bg-neutral-500' : 'bg-primary'
                  }`}
                  style={{ height: `${barPct}%` }}
                />
              );
            })}
          </span>
          <span data-testid="argos-companion-status">{statusText}</span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            data-testid="argos-companion-attach-context-btn"
            onClick={() => void handleAttachContext()}
            className="h-7 rounded-control px-2.5 text-xs font-medium inline-flex items-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/10 text-neutral-200 transition-colors cursor-pointer"
          >
            <span>Adjuntar vista actual</span>
          </button>

          {attachedSnapshot ? (
            <span
              data-testid="argos-companion-context-badge"
              className="h-7 rounded-control px-2.5 text-xs font-medium inline-flex items-center gap-1.5 bg-primary/15 border border-primary/30 text-primary max-w-60"
              title={attachedSnapshot.summaryText}
            >
              <span className="truncate">{attachedSnapshot.activeTitle}</span>
              <button
                type="button"
                onClick={handleClearContext}
                aria-label="Quitar vista adjunta"
                className="rounded-xs hover:text-white cursor-pointer"
              >
                ×
              </button>
            </span>
          ) : null}
        </div>
      </div>

      {/* Bottom row: Quick Hybrid Text/Voice Input + Call Controls */}
      <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
        <form onSubmit={(e) => void handleSubmit(e)} className="flex-1 flex items-center gap-1.5 min-w-0">
          <input
            type="text"
            data-testid="argos-companion-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Habla o escribe a Argos…"
            aria-label="Habla o escribe a Argos"
            className="h-8 flex-1 min-w-0 rounded-control px-3 text-xs bg-background/80 border border-border text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-primary"
          />
          <button
            type="submit"
            data-testid="argos-companion-send-btn"
            disabled={!inputText.trim()}
            className="h-8 rounded-control px-3 text-xs font-medium bg-primary text-neutral-950 hover:opacity-90 disabled:opacity-40 transition-opacity cursor-pointer shrink-0"
          >
            Enviar
          </button>
        </form>

        <div className="flex items-center gap-1.5 shrink-0" data-testid="argos-companion-controls">
          <button
            type="button"
            data-testid="argos-companion-mic-btn"
            onClick={() => voice.toggleMicMuted()}
            aria-pressed={voice.micMuted}
            aria-label={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
            title={voice.micMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
            className={`h-8 w-8 rounded-control inline-flex items-center justify-center border transition-colors cursor-pointer ${
              voice.micMuted
                ? 'bg-red-500/15 border-red-500/40 text-red-300'
                : 'bg-white/5 border-white/10 text-neutral-200 hover:bg-white/10'
            }`}
          >
            {voice.micMuted ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="2" y1="2" x2="22" y2="22" />
                <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                <path d="M5 10v2a7 7 0 0 0 12 5" />
                <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            )}
          </button>

          <button
            type="button"
            data-testid="argos-companion-speaker-btn"
            onClick={handleToggleSpeaker}
            aria-pressed={voice.speakerMuted}
            aria-label={voice.speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
            title={voice.speakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
            className={`h-8 w-8 rounded-control inline-flex items-center justify-center border transition-colors cursor-pointer ${
              voice.speakerMuted
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                : 'bg-white/5 border-white/10 text-neutral-200 hover:bg-white/10'
            }`}
          >
            {voice.speakerMuted ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="22" y1="9" x2="16" y2="15" />
                <line x1="16" y1="9" x2="22" y2="15" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            )}
          </button>

          <button
            type="button"
            data-testid="argos-companion-transfer-btn"
            onClick={handleTransferToThread}
            className="h-8 rounded-control px-2.5 text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/10 text-neutral-100 transition-colors cursor-pointer whitespace-nowrap"
          >
            Transferir al hilo
          </button>

          <button
            type="button"
            data-testid="argos-companion-end-btn"
            onClick={handleEndSession}
            aria-label="Finalizar sesión de voz"
            className="h-8 rounded-pill px-3 text-xs font-medium bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-200 transition-colors cursor-pointer whitespace-nowrap"
          >
            Finalizar
          </button>
        </div>
      </div>
    </aside>
  );
};

export default ArgosCompanionBar;
