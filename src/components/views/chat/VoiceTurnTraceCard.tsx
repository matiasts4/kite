// Kite Code — Voice Turn Trace Card
// Structured, inspectable timeline card displaying ActionReceipts, consultChats reach, and verified execution status.

import React, { useState } from 'react';
import type { ActionReceipt } from '../../../lib/operator/contract';
import { TerminalIcon, MessageSquareIcon, ChevronDownIcon, SearchIcon, SparklesIcon } from './ChatIcons';

export interface VoiceTurnTraceCardProps {
  turnId: string;
  strategy?: string;
  providerId?: string;
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
      className={`kite-voice-trace-card rounded-card border border-[var(--vl-border-subtle)] bg-[var(--vl-surface-glass-dim)] my-2 overflow-hidden text-xs transition-colors ${className}`}
    >
      {/* Header bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left bg-transparent hover:bg-[var(--vl-surface-glass)] cursor-pointer border-0 select-none transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`size-2 rounded-full shrink-0 ${
              overallSuccess ? 'bg-[var(--vl-accent-green,#10b981)]' : 'bg-[var(--vl-accent-red,#ef4444)]'
            }`}
          />
          <span className="font-medium text-[var(--vl-text-primary)]">
            Traza del Asistente Zed
          </span>
          <span className="text-[var(--vl-text-muted)] truncate">({summaryText})</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`px-1.5 py-0.5 rounded-sm text-2xs font-semibold uppercase tracking-wider ${
              overallSuccess
                ? 'bg-[var(--vl-accent-green-subtle,#10b98120)] text-[var(--vl-accent-green,#10b981)]'
                : 'bg-[var(--vl-accent-red-subtle,#ef444420)] text-[var(--vl-accent-red,#ef4444)]'
            }`}
          >
            {overallSuccess ? 'OK' : 'Error'}
          </span>
          <ChevronDownIcon
            size={12}
            className={`text-[var(--vl-text-muted)] transition-transform duration-150 ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {/* Expanded detail section */}
      {expanded && (
        <div className="border-t border-[var(--vl-border-subtle)] px-3 py-2.5 space-y-2 bg-[var(--vl-surface-glass)]">
          <div className="text-2xs text-[var(--vl-text-muted)]">
            Estrategia: <span className="font-mono text-[var(--vl-text-secondary)]">{strategy}</span> · Proveedor: <span className="font-mono text-[var(--vl-text-secondary)]">{providerId}</span>
          </div>

          {/* Chat / Memory Reach info */}
          {consultChatsInfo && (
            <div className="flex items-start gap-2 text-[var(--vl-text-secondary)]">
              <SearchIcon size={13} className="text-[var(--vl-text-muted)] mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="font-medium text-[var(--vl-text-primary)]">Alcance de conversaciones: </span>
                {consultChatsInfo.kind === 'read' ? (
                  <span>
                    Leído chat <strong className="text-[var(--vl-text-primary)]">«{consultChatsInfo.title}»</strong> ({consultChatsInfo.cli})
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
            <div className="space-y-1.5 pt-1">
              <div className="text-2xs font-semibold uppercase tracking-wider text-[var(--vl-text-muted)]">
                Acciones Ejecutadas
              </div>
              {receipts.map((receipt, idx) => (
                <div
                  key={`${turnId}-act-${idx}`}
                  className="flex items-start justify-between gap-2 p-1.5 rounded-sm bg-[var(--vl-surface-raised)] border border-[var(--vl-border-subtle)]"
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="mt-0.5">{getActionIcon(receipt.type)}</span>
                    <div className="min-w-0">
                      <div className="text-[var(--vl-text-primary)] font-medium truncate">
                        {receipt.summaryEs}
                      </div>
                      <div className="text-2xs text-[var(--vl-text-muted)]">
                        Tipo: <code className="font-mono">{receipt.type}</code>
                        {receipt.durationMs ? ` · ${receipt.durationMs} ms` : ''}
                      </div>
                    </div>
                  </div>

                  <span
                    className={`px-1 py-0.5 rounded-xs text-2xs font-medium shrink-0 ${
                      receipt.ok
                        ? 'text-[var(--vl-accent-green,#10b981)] bg-[var(--vl-accent-green-subtle,#10b98115)]'
                        : 'text-[var(--vl-accent-red,#ef4444)] bg-[var(--vl-accent-red-subtle,#ef444415)]'
                    }`}
                  >
                    {receipt.ok ? 'Verificado' : 'Fallo'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-2xs text-[var(--vl-text-muted)] italic">
              No se requirieron acciones operativas sobre terminales.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
