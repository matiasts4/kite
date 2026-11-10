// Kite Code — Voice Turn Trace Card
// Structured, inspectable timeline card displaying ActionReceipts, consultChats reach, and verified execution status.

import React, { useState } from 'react';
import type { ActionReceipt } from '../../../lib/operator/contract';
import { TerminalIcon, MessageSquareIcon, ChevronDownIcon, SearchIcon, SparklesIcon } from './ChatIcons';

export interface VoiceTurnTraceCardProps {
  turnId: string;
  strategy?: string;
  providerId?: string;
  modelId?: string;
  durationMs?: number;
  overallSuccess?: boolean;
  receipts?: ActionReceipt[];
  consultChatsInfo?: {
    kind: string;
    text?: string;
    title?: string;
    cli?: string;
  };
  className?: string;
}

export const VoiceTurnTraceCard: React.FC<VoiceTurnTraceCardProps> = ({
  turnId,
  strategy = 'llm',
  providerId = 'grok',
  modelId,
  durationMs = 0,
  overallSuccess = true,
  receipts = [],
  consultChatsInfo,
  className = '',
}) => {
  const [expanded, setExpanded] = useState(false);

  const actionCount = receipts.length;
  const hasConsult = Boolean(consultChatsInfo && consultChatsInfo.kind !== 'none');
  const summaryParts: string[] = [];

  if (actionCount > 0) {
    summaryParts.push(`${actionCount} ${actionCount > 1 ? 'acciones' : 'acción'}`);
  }
  if (hasConsult) {
    summaryParts.push('1 consulta');
  }
  if (durationMs > 0) {
    summaryParts.push(`${durationMs} ms`);
  }

  const summaryText = summaryParts.join(' · ') || 'Turno del Asistente';

  const getActionIcon = (type: string) => {
    switch (type) {
      case 'open_terminals':
      case 'close_terminals':
      case 'inject_prompt':
        return <TerminalIcon size={13} className="text-[var(--vl-accent-cyan,#06b6d4)] shrink-0" />;
      case 'launch_thread':
      case 'narrate_summary':
        return <MessageSquareIcon size={13} className="text-[var(--vl-accent-purple,#a855f7)] shrink-0" />;
      default:
        return <SparklesIcon size={13} className="text-[var(--vl-accent-blue,#3b82f6)] shrink-0" />;
    }
  };

  return (
    <div
      data-testid="voice-turn-trace-card"
      className={`kite-voice-trace-card ${className}`}
    >
      {/* Header bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="kite-voice-trace-card__header"
      >
        <div className="kite-voice-trace-card__header-left">
          <span
            className={`kite-voice-trace-card__dot ${
              overallSuccess ? 'kite-voice-trace-card__dot--ok' : 'kite-voice-trace-card__dot--err'
            }`}
          />
          <span style={{ fontWeight: 600 }}>
            Traza del Asistente Zed
          </span>
          <span style={{ color: 'var(--secondary-label, #a1a1aa)' }}>({summaryText})</span>
        </div>

        <div className="kite-voice-trace-card__header-right">
          <span
            className={`kite-voice-trace-card__status-badge ${
              overallSuccess
                ? 'kite-voice-trace-card__status-badge--ok'
                : 'kite-voice-trace-card__status-badge--err'
            }`}
          >
            {overallSuccess ? 'OK' : 'Error'}
          </span>
          <ChevronDownIcon
            size={12}
            style={{
              color: 'var(--secondary-label, #a1a1aa)',
              transform: expanded ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease',
            }}
          />
        </div>
      </button>

      {/* Expanded detail section */}
      {expanded && (
        <div className="kite-voice-trace-card__body">
          <div style={{ fontSize: '0.6875rem', color: 'var(--secondary-label, #a1a1aa)' }}>
            Estrategia: <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary, #ffffff)' }}>{strategy}</span> · Proveedor: <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary, #ffffff)' }}>{providerId}{modelId ? ` (${modelId})` : ''}</span>
          </div>

          {/* Chat / Memory Reach info */}
          {consultChatsInfo && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', color: 'var(--secondary-label, #a1a1aa)' }}>
              <SearchIcon size={13} style={{ marginTop: '2px', flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary, #ffffff)' }}>Alcance de conversaciones: </span>
                {consultChatsInfo.kind === 'read' ? (
                  <span>
                    Leído chat <strong style={{ color: 'var(--text-primary, #ffffff)' }}>«{consultChatsInfo.title}»</strong> ({consultChatsInfo.cli})
                  </span>
                ) : consultChatsInfo.kind === 'index' ? (
                  <span>Consultado índice de conversaciones del proyecto</span>
                ) : (
                  <span>{consultChatsInfo.text || 'Sin coincidencia en chats anteriores'}</span>
                )}
              </div>
            </div>
          )}

          {/* Action Receipts */}
          {receipts.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', paddingTop: '0.25rem' }}>
              <div style={{ fontSize: '0.625rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--secondary-label, #a1a1aa)' }}>
                Acciones Ejecutadas
              </div>
              {receipts.map((receipt, idx) => (
                <div
                  key={`${turnId}-act-${idx}`}
                  className="kite-voice-trace-card__action-row"
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', minWidth: 0 }}>
                    <span style={{ marginTop: '2px' }}>{getActionIcon(receipt.type)}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: 'var(--text-primary, #ffffff)', fontWeight: 500 }}>
                        {receipt.summaryEs}
                      </div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--secondary-label, #a1a1aa)' }}>
                        Tipo: <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{receipt.type}</code>
                        {receipt.durationMs ? ` · ${receipt.durationMs} ms` : ''}
                      </div>
                    </div>
                  </div>

                  <span
                    className={`kite-voice-trace-card__status-badge ${
                      receipt.ok
                        ? 'kite-voice-trace-card__status-badge--ok'
                        : 'kite-voice-trace-card__status-badge--err'
                    }`}
                  >
                    {receipt.ok ? 'Verificado' : 'Fallo'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: '0.6875rem', color: 'var(--secondary-label, #a1a1aa)', fontStyle: 'italic' }}>
              No se requirieron acciones operativas sobre terminales.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
