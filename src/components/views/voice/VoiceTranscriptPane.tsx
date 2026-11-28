import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getVoiceCallReceipt,
  listVoiceCallReceipts,
  type RealtimeVoiceProvider,
  type VoiceCallReceipt,
} from '../../../lib/operator/voice/voiceCallReceipts';
import { CheckIcon, ChevronRightIcon, CopyIcon, MicIcon } from '../chat/ChatIcons';
import { formatWorkedForLabel } from '../chat/voiceTranscript';
import './VoiceTranscriptPane.css';

export interface VoiceTranscriptPaneProps {
  callId?: string | null;
  threadId?: string | null;
  className?: string;
}

function formatTransportBadge(
  transport: 'cascaded' | 'realtime',
  realtimeProvider?: RealtimeVoiceProvider
): string {
  if (transport === 'realtime') {
    if (realtimeProvider === 'gemini_live') return 'Realtime · Gemini Live';
    if (realtimeProvider === 'xai') return 'Realtime · xAI';
    if (realtimeProvider === 'openai') return 'Realtime · OpenAI';
    return 'Realtime';
  }
  return 'Cascaded';
}

function formatDurationBadge(durationMs: number): string {
  const totalSec = Math.max(0, Math.round((Number.isFinite(durationMs) ? durationMs : 0) / 1000));
  if (totalSec < 60) return `${totalSec} s`;
  const mins = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return rem > 0 ? `${mins} m ${rem} s` : `${mins} m`;
}

function formatTurnTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  try {
    return new Intl.DateTimeFormat('es', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestampMs));
  } catch {
    return '';
  }
}

function buildClipboardTranscript(receipt: VoiceCallReceipt): string {
  const lines: string[] = [
    `Transcripción de voz (${formatTransportBadge(receipt.transport, receipt.realtimeProvider)} · ${formatDurationBadge(receipt.durationMs)})`,
  ];

  if (receipt.summaryLead) {
    lines.push('', receipt.summaryLead);
  }
  if (receipt.summaryPoints && receipt.summaryPoints.length > 0) {
    for (const point of receipt.summaryPoints) {
      lines.push(`- ${point}`);
    }
  }

  const turns = [...(receipt.turnsSnapshot ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  if (turns.length > 0) {
    lines.push('');
    for (const turn of turns) {
      const timeLabel = formatTurnTime(turn.createdAt);
      const prefix = timeLabel ? `[${timeLabel}] ` : '';
      if (turn.userPrompt) {
        lines.push(`${prefix}Tú: ${turn.userPrompt}`);
      }
      if (turn.tools && turn.tools.length > 0) {
        lines.push(`Herramientas: ${turn.tools.join(', ')}`);
      }
      if (turn.reply) {
        lines.push(`${prefix}Asistente: ${turn.reply}`);
      }
    }
  }

  return lines.join('\n');
}

export const VoiceTranscriptPane: React.FC<VoiceTranscriptPaneProps> = ({
  callId = null,
  threadId = null,
  className = '',
}) => {
  const [targetCallId, setTargetCallId] = useState<string | null>(callId);
  const [targetThreadId, setTargetThreadId] = useState<string | null>(threadId);
  const [receipt, setReceipt] = useState<VoiceCallReceipt | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTargetCallId(callId ?? null);
  }, [callId]);

  useEffect(() => {
    setTargetThreadId(threadId ?? null);
  }, [threadId]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const loadReceipt = useCallback(
    async (
      requestedCallId: string | null,
      requestedThreadId: string | null,
      isCancelled: () => boolean
    ) => {
      setLoading(true);
      try {
        if (requestedCallId) {
          const direct = await getVoiceCallReceipt(requestedCallId);
          if (isCancelled()) return;
          if (direct) {
            setReceipt(direct);
            return;
          }
        }

        if (requestedThreadId) {
          const all = await listVoiceCallReceipts(50);
          if (isCancelled()) return;
          const match = all.find((item) => item.boundThreadId === requestedThreadId) ?? null;
          setReceipt(match);
          return;
        }

        if (!requestedCallId && !requestedThreadId) {
          const latest = await listVoiceCallReceipts(1);
          if (isCancelled()) return;
          setReceipt(latest[0] ?? null);
          return;
        }

        if (!isCancelled()) {
          setReceipt(null);
        }
      } catch (err) {
        console.warn('[VoiceTranscriptPane] Failed to load voice receipt:', err);
        if (!isCancelled()) {
          setReceipt(null);
        }
      } finally {
        if (!isCancelled()) {
          setLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    void loadReceipt(targetCallId, targetThreadId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [targetCallId, targetThreadId, loadReceipt]);

  useEffect(() => {
    const handleUpdated = (event: Event) => {
      const updated = (event as CustomEvent<VoiceCallReceipt | undefined>).detail;
      if (!updated || !updated.callId) return;

      const matchesCall = Boolean(targetCallId && updated.callId === targetCallId);
      const matchesThread = Boolean(
        !targetCallId && targetThreadId && updated.boundThreadId === targetThreadId
      );
      const matchesUnscoped = !targetCallId && !targetThreadId;

      if (matchesCall || matchesThread || matchesUnscoped || receipt?.callId === updated.callId) {
        setReceipt(updated);
        setLoading(false);
      }
    };

    const handleOpenTranscript = (event: Event) => {
      const detail = (
        event as CustomEvent<{ callId?: string | null; threadId?: string | null } | undefined>
      ).detail;
      if (!detail) return;
      if (detail.callId !== undefined) {
        setTargetCallId(detail.callId ?? null);
      }
      if (detail.threadId !== undefined) {
        setTargetThreadId(detail.threadId ?? null);
      }
    };

    window.addEventListener('kite:voice-receipt-updated', handleUpdated);
    window.addEventListener('kite:open-voice-transcript', handleOpenTranscript);
    return () => {
      window.removeEventListener('kite:voice-receipt-updated', handleUpdated);
      window.removeEventListener('kite:open-voice-transcript', handleOpenTranscript);
    };
  }, [targetCallId, targetThreadId, receipt?.callId]);

  const sortedTurns = useMemo(() => {
    if (!receipt?.turnsSnapshot) return [];
    return [...receipt.turnsSnapshot].sort((a, b) => a.createdAt - b.createdAt);
  }, [receipt?.turnsSnapshot]);

  const handleCopy = async () => {
    if (!receipt) return;
    const text = buildClipboardTranscript(receipt);
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1800);
    } catch (err) {
      console.warn('[VoiceTranscriptPane] Failed to copy transcript to clipboard:', err);
    }
  };

  const handleSelectThread = (delegatedThreadId: string) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kite:select-thread', {
          detail: { threadId: delegatedThreadId },
        })
      );
    }
  };

  const rootClass = `kite-voice-transcript-pane${className ? ` ${className}` : ''}`;

  if (!loading && !receipt) {
    return (
      <section data-testid="voice-transcript-pane" className={rootClass}>
        <header className="kite-voice-transcript-pane__header">
          <div className="kite-voice-transcript-pane__header-info">
            <div className="kite-voice-transcript-pane__title-row">
              <MicIcon size={14} />
              <h2 className="kite-voice-transcript-pane__title">Transcripción de voz</h2>
            </div>
          </div>
        </header>
        <div data-testid="voice-transcript-empty" className="kite-voice-transcript-pane__empty">
          <span className="kite-voice-transcript-pane__empty-icon" aria-hidden="true">
            <MicIcon size={16} />
          </span>
          <p className="kite-voice-transcript-pane__empty-title">
            No hay transcripciones de voz todavía
          </p>
          <p className="kite-voice-transcript-pane__empty-detail">
            Cuando finalices una sesión de voz con turnos hablados, verás aquí el resumen y cada
            intervención.
          </p>
        </div>
      </section>
    );
  }

  const hasStructuredSummary = Boolean(
    receipt?.summaryLead || (receipt?.summaryPoints && receipt.summaryPoints.length > 0)
  );
  const showPendingSummary = Boolean(receipt?.summaryPending && !hasStructuredSummary);

  return (
    <section data-testid="voice-transcript-pane" className={rootClass}>
      <header className="kite-voice-transcript-pane__header">
        <div className="kite-voice-transcript-pane__header-info">
          <div className="kite-voice-transcript-pane__title-row">
            <MicIcon size={14} />
            <h2 className="kite-voice-transcript-pane__title">Transcripción de voz</h2>
          </div>
          {receipt && (
            <div className="kite-voice-transcript-pane__meta">
              <span className="kite-voice-transcript-pane__meta-pill">
                {formatTransportBadge(receipt.transport, receipt.realtimeProvider)}
              </span>
              <span className="kite-voice-transcript-pane__meta-pill">
                {formatDurationBadge(receipt.durationMs)}
              </span>
            </div>
          )}
        </div>

        {receipt && (
          <button
            type="button"
            className="kite-voice-transcript-pane__copy-btn"
            data-copied={copied ? 'true' : undefined}
            onClick={() => void handleCopy()}
            aria-label={copied ? 'Copiado' : 'Copiar transcripción'}
          >
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            <span>{copied ? 'Copiado' : 'Copiar transcripción'}</span>
          </button>
        )}
      </header>

      {receipt && (
        <div className="kite-voice-transcript-pane__scroll">
          {(showPendingSummary || hasStructuredSummary) && (
            <div className="kite-voice-transcript-pane__summary-card">
              {showPendingSummary ? (
                <span className="kite-voice-transcript-pane__shimmer">Resumiendo llamada…</span>
              ) : (
                <>
                  {receipt.summaryLead && (
                    <p className="kite-voice-transcript-pane__summary-lead">
                      {receipt.summaryLead}
                    </p>
                  )}
                  {receipt.summaryPoints && receipt.summaryPoints.length > 0 && (
                    <ul className="kite-voice-transcript-pane__summary-points">
                      {receipt.summaryPoints.map((point, idx) => (
                        <li key={`${receipt.callId}-pane-pt-${idx}`}>{point}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}

          {sortedTurns.length > 0 && (
            <div className="kite-voice-transcript-pane__turns">
              {sortedTurns.map((turn) => {
                const workedLabel = formatWorkedForLabel(turn.durationMs);
                const turnTime = formatTurnTime(turn.createdAt);
                return (
                  <article
                    key={turn.turnId}
                    data-testid="voice-transcript-turn"
                    className="kite-voice-transcript-pane__turn"
                  >
                    <div className="kite-voice-transcript-pane__turn-head">
                      <span className="kite-voice-transcript-pane__turn-time">{turnTime}</span>
                      {workedLabel && (
                        <span className="kite-voice-transcript-pane__worked">{workedLabel}</span>
                      )}
                    </div>

                    {turn.userPrompt && (
                      <div className="kite-voice-transcript-pane__speaker-block">
                        <span className="kite-voice-transcript-pane__speaker-label">Tú</span>
                        <p className="kite-voice-transcript-pane__turn-text">{turn.userPrompt}</p>
                      </div>
                    )}

                    {((turn.tools && turn.tools.length > 0) || turn.delegatedThreadId) && (
                      <div className="kite-voice-transcript-pane__tools-row">
                        {(turn.tools ?? []).map((tool) => (
                          <span key={tool} className="kite-voice-transcript-pane__tool-badge">
                            {tool}
                          </span>
                        ))}
                        {turn.delegatedThreadId && (
                          <button
                            type="button"
                            className="kite-voice-transcript-pane__thread-btn"
                            onClick={() => handleSelectThread(turn.delegatedThreadId!)}
                          >
                            <span>Abrir hilo</span>
                            <ChevronRightIcon size={11} />
                          </button>
                        )}
                      </div>
                    )}

                    {turn.reply && (
                      <div className="kite-voice-transcript-pane__speaker-block">
                        <span className="kite-voice-transcript-pane__speaker-label kite-voice-transcript-pane__speaker-label--assistant">
                          Argos
                        </span>
                        <p className="kite-voice-transcript-pane__turn-text">{turn.reply}</p>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
