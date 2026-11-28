import React from 'react';
import type { VoiceCallReceipt } from '../../../lib/operator/voice/voiceCallReceipts';
import { MicIcon } from './ChatIcons';
import './VoiceTranscriptCard.css';

export interface VoiceTranscriptCardProps {
  receipt: VoiceCallReceipt;
  onOpen?: (receipt: VoiceCallReceipt) => void;
  className?: string;
}

export interface PendingVoiceTranscriptRequest {
  callId?: string | null;
  threadId?: string | null;
}

let pendingVoiceTranscriptRequest: PendingVoiceTranscriptRequest | null = null;

/** Reads and clears any pending RightDock voice transcript open request staged before lazy dock mount. */
export function consumePendingVoiceTranscriptRequest(): PendingVoiceTranscriptRequest | null {
  const req = pendingVoiceTranscriptRequest;
  pendingVoiceTranscriptRequest = null;
  return req;
}

function formatStartedTime(startedAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '';
  try {
    return new Intl.DateTimeFormat('es', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(startedAt));
  } catch {
    return '';
  }
}

function formatCallDuration(durationMs: number): string {
  const totalSec = Math.max(0, Math.round((Number.isFinite(durationMs) ? durationMs : 0) / 1000));
  if (totalSec < 60) return `${totalSec} s`;
  const mins = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return rem > 0 ? `${mins} m ${rem} s` : `${mins} m`;
}

export const VoiceTranscriptCard: React.FC<VoiceTranscriptCardProps> = ({
  receipt,
  onOpen,
  className = '',
}) => {
  const startedLabel = formatStartedTime(receipt.startedAt);
  const durationLabel = formatCallDuration(receipt.durationMs);
  const hasStructuredSummary = Boolean(
    receipt.summaryLead || (receipt.summaryPoints && receipt.summaryPoints.length > 0)
  );
  const showPending = Boolean(receipt.summaryPending && !hasStructuredSummary);

  const handleOpen = () => {
    const detail: PendingVoiceTranscriptRequest = {
      callId: receipt.callId,
      threadId: receipt.boundThreadId ?? null,
    };
    pendingVoiceTranscriptRequest = detail;
    onOpen?.(receipt);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kite:open-voice-transcript', {
          detail,
        })
      );
    }
  };

  return (
    <button
      type="button"
      data-testid="voice-transcript-card"
      className={`kite-voice-transcript-card${className ? ` ${className}` : ''}`}
      onClick={handleOpen}
      aria-label={`Abrir transcripción de voz${startedLabel ? ` de las ${startedLabel}` : ''}`}
    >
      <div className="kite-voice-transcript-card__header">
        <div className="kite-voice-transcript-card__identity">
          <span className="kite-voice-transcript-card__icon-badge" aria-hidden="true">
            <MicIcon size={14} />
          </span>
          <div className="kite-voice-transcript-card__title-group">
            <span className="kite-voice-transcript-card__title">Transcripción de voz</span>
            {startedLabel && (
              <span className="kite-voice-transcript-card__timestamp">{startedLabel}</span>
            )}
            <span className="kite-voice-transcript-card__duration">{durationLabel}</span>
          </div>
        </div>
        <span className="kite-voice-transcript-card__open-chip">Abrir</span>
      </div>

      <div className="kite-voice-transcript-card__body">
        {showPending ? (
          <span
            data-testid="voice-transcript-summary-pending"
            className="kite-voice-transcript-card__shimmer"
          >
            Resumiendo llamada…
          </span>
        ) : hasStructuredSummary ? (
          <>
            {receipt.summaryLead && (
              <p className="kite-voice-transcript-card__lead">{receipt.summaryLead}</p>
            )}
            {receipt.summaryPoints && receipt.summaryPoints.length > 0 && (
              <ul className="kite-voice-transcript-card__points">
                {receipt.summaryPoints.map((point, idx) => (
                  <li
                    key={`${receipt.callId}-pt-${idx}`}
                    data-testid="voice-transcript-summary-point"
                    className="kite-voice-transcript-card__point"
                  >
                    {point}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : receipt.summary ? (
          <p className="kite-voice-transcript-card__fallback">{receipt.summary}</p>
        ) : (
          <p className="kite-voice-transcript-card__fallback">
            {receipt.turnCount === 1
              ? '1 turno de conversación registrado'
              : `${receipt.turnCount} turnos de conversación registrados`}
          </p>
        )}
      </div>
    </button>
  );
};
