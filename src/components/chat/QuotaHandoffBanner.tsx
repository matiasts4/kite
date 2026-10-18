import React, { useState } from 'react';
import type { QuotaHandoffOffer, ContinuationSuggestion } from '../../types';
import { continueTurnWithHandoff } from '../../lib/ipc';

export interface QuotaHandoffBannerProps {
  offer: QuotaHandoffOffer;
  threadId: string;
  onContinueSuccess?: () => void;
}

export const QuotaHandoffBanner: React.FC<QuotaHandoffBannerProps> = ({
  offer,
  threadId,
  onContinueSuccess,
}) => {
  const [selectedSuggestion, setSelectedSuggestion] = useState<ContinuationSuggestion | null>(() => {
    return offer.suggestions.find((s) => s.isRecommended) || offer.suggestions[0] || null;
  });
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [customPrompt, setCustomPrompt] = useState(offer.handoffPrompt);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleContinue = async () => {
    if (!selectedSuggestion || isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const targetAccountId = selectedSuggestion.kind === 'account' ? selectedSuggestion.id : undefined;
      await continueTurnWithHandoff(
        threadId,
        selectedSuggestion.provider,
        targetAccountId,
        customPrompt.trim() !== offer.handoffPrompt.trim() ? customPrompt : undefined
      );
      if (onContinueSuccess) {
        onContinueSuccess();
      }
    } catch (err: any) {
      console.error('[QuotaHandoffBanner] Failed to continue turn:', err);
      setErrorMsg(typeof err === 'string' ? err : err?.message || 'Error al lanzar el agente de relevo');
      setIsSubmitting(false);
    }
  };

  const getPercentageColor = (pct: number) => {
    if (pct >= 50) return '#10b981'; // Green
    if (pct >= 20) return '#f59e0b'; // Amber
    return '#ef4444'; // Red
  };

  return (
    <div
      className="quota-handoff-banner"
      style={{
        margin: '12px 0',
        padding: '16px',
        borderRadius: '12px',
        backgroundColor: 'rgba(28, 20, 14, 0.75)',
        border: '1px solid rgba(245, 158, 11, 0.4)',
        boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.04)',
        backdropFilter: 'blur(16px)',
        color: '#f4f4f5',
        fontSize: '13px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '12px' }}>
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '8px',
            backgroundColor: 'rgba(245, 158, 11, 0.15)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fbbf24',
            flexShrink: 0,
            fontSize: '14px',
          }}
        >
          ⚡
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: '#fbbf24', fontSize: '14px' }}>
              Cuota agotada en {offer.failedProvider}
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '2px 6px',
                borderRadius: '4px',
                backgroundColor: 'rgba(239, 68, 68, 0.2)',
                color: '#fca5a5',
                border: '1px solid rgba(239, 68, 68, 0.3)',
              }}
            >
              Interrupción por cuota
            </span>
          </div>
          <p style={{ margin: '4px 0 0', color: '#d4d4d8', fontSize: '12px', lineHeight: '1.4' }}>
            {offer.reason}
          </p>
          <p style={{ margin: '4px 0 0', color: '#a1a1aa', fontSize: '12px' }}>
            ¿Deseas transferir esta tarea de inmediato a otra cuenta o a otro agente con cuota disponible?
          </p>
        </div>
      </div>

      {/* Suggestions List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#a1a1aa' }}>
          Opciones sugeridas con cuota activa:
        </div>
        {offer.suggestions.length === 0 ? (
          <div style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'rgba(0,0,0,0.2)', color: '#a1a1aa', fontSize: '12px' }}>
            No se detectaron otras cuentas con cuota disponible en este momento.
          </div>
        ) : (
          offer.suggestions.map((sug) => {
            const isSelected = selectedSuggestion?.id === sug.id && selectedSuggestion?.kind === sug.kind;
            const barColor = getPercentageColor(sug.remainingPercent);

            return (
              <div
                key={`${sug.kind}-${sug.id}`}
                onClick={() => setSelectedSuggestion(sug)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: isSelected
                    ? '1px solid rgba(52, 211, 153, 0.7)'
                    : '1px solid rgba(255, 255, 255, 0.08)',
                  backgroundColor: isSelected
                    ? 'rgba(16, 185, 129, 0.12)'
                    : 'rgba(255, 255, 255, 0.03)',
                  cursor: 'pointer',
                  transition: 'all 120ms ease',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: isSelected ? 600 : 500, color: isSelected ? '#34d399' : '#f4f4f5' }}>
                      {sug.title}
                    </span>
                    {sug.isRecommended && (
                      <span
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          padding: '1px 5px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(52, 211, 153, 0.25)',
                          color: '#6ee7b7',
                        }}
                      >
                        ★ Recomendado
                      </span>
                    )}
                    {sug.kind === 'account' && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(96, 165, 250, 0.2)',
                          color: '#93c5fd',
                        }}
                      >
                        Misma herramienta
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: '11px', color: '#a1a1aa' }}>
                    {sug.subtitle}
                  </span>
                </div>

                {/* Quota Indicator */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', marginLeft: '12px', flexShrink: 0 }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: barColor }}>
                    {Math.round(sug.remainingPercent)}%
                  </span>
                  <div
                    style={{
                      width: '60px',
                      height: '4px',
                      borderRadius: '2px',
                      backgroundColor: 'rgba(255, 255, 255, 0.1)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, Math.max(0, sug.remainingPercent))}%`,
                        height: '100%',
                        backgroundColor: barColor,
                        borderRadius: '2px',
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Accordion: Context Handoff Preview */}
      <div style={{ marginBottom: '14px' }}>
        <button
          type="button"
          onClick={() => setIsCustomizing((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            padding: '4px 0',
            color: '#93c5fd',
            fontSize: '12px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <span>{isCustomizing ? '▾ Ocultar contexto de relevo' : '▸ Ver y editar contexto que se transferirá'}</span>
        </button>

        {isCustomizing && (
          <div style={{ marginTop: '8px' }}>
            <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#a1a1aa' }}>
              Esta cápsula empaqueta el objetivo original, turnos recientes, el avance que alcanzó a hacer el agente anterior y el estado git real del workspace. Puedes editarlo antes de transferir:
            </p>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={9}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: '8px',
                backgroundColor: 'rgba(0, 0, 0, 0.45)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: '#e4e4e7',
                fontSize: '11px',
                fontFamily: 'monospace',
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}
      </div>

      {errorMsg && (
        <div style={{ color: '#f87171', fontSize: '12px', marginBottom: '10px' }}>
          {errorMsg}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px' }}>
        <button
          type="button"
          disabled={!selectedSuggestion || isSubmitting}
          onClick={handleContinue}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 18px',
            borderRadius: '8px',
            backgroundColor: '#10b981',
            color: '#09090b',
            fontWeight: 600,
            fontSize: '13px',
            border: 'none',
            cursor: !selectedSuggestion || isSubmitting ? 'not-allowed' : 'pointer',
            opacity: !selectedSuggestion || isSubmitting ? 0.6 : 1,
            transition: 'all 120ms ease',
            boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
          }}
        >
          {isSubmitting ? (
            <span>Transfiriendo tarea...</span>
          ) : (
            <span>Continuar tarea con {selectedSuggestion ? selectedSuggestion.title.replace('Cambiar a ', '').replace('Continuar con ', '') : 'agente'}</span>
          )}
        </button>
      </div>
    </div>
  );
};
