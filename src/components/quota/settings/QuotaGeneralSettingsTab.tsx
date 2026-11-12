import React from 'react';
import type { QuotaPreferences } from '../../../lib/quota/types';
import { PROVIDER_LABELS } from '../../../lib/quota/types';
import { BrandLogo } from '../../views/agents/engineMetadata';
import { ChevronUpIcon, ChevronDownIcon } from '../../views/settings/icons';

export interface QuotaGeneralSettingsTabProps {
  prefs: QuotaPreferences;
  enabledSet: Set<string>;
  onToggleMaster: () => void;
  onToggleAutoDetect: () => void;
  onSetDisplayMode: (mode: 'percent_remaining' | 'percent_used' | 'compact') => void;
  onMoveProviderOrder: (id: string, direction: 'up' | 'down') => void;
}

export const QuotaGeneralSettingsTab: React.FC<QuotaGeneralSettingsTabProps> = ({
  prefs,
  enabledSet,
  onToggleMaster,
  onToggleAutoDetect,
  onSetDisplayMode,
  onMoveProviderOrder,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h3 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: '#fafafa' }}>
          Preferencias de Visualización y Detección
        </h3>
        <p style={{ margin: 0, fontSize: '11px', color: '#a1a1aa' }}>
          Personaliza cómo se integran las cuotas de IA en la cabecera de la aplicación
        </p>
      </div>

      <div
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 'var(--card-radius, 12px)',
          overflow: 'hidden',
        }}
      >
        {/* Row 1: Master enable */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          <div>
            <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
              Mostrar medidor de cuota en barra superior
            </div>
            <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
              Pastilla en tiempo real en la cabecera con porcentaje y cuenta regresiva de reseteo.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={prefs.enabled}
            aria-label="Activar medidor de cuota"
            className="ui-switch"
            onClick={onToggleMaster}
            style={{ cursor: 'pointer' }}
          >
            <span aria-hidden="true" className="ui-switch__knob" />
          </button>
        </div>

        {/* Row 2: Auto-detect */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          <div>
            <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
              Detección automática del agente activo
            </div>
            <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
              Alterna automáticamente la pastilla para reflejar el modelo que esté respondiendo en el chat.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={prefs.autoDetectActive}
            aria-label="Activar detección automática"
            className="ui-switch"
            onClick={onToggleAutoDetect}
            style={{ cursor: 'pointer' }}
          >
            <span aria-hidden="true" className="ui-switch__knob" />
          </button>
        </div>

        {/* Row 3: Display Mode */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
          }}
        >
          <div>
            <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
              Formato del texto en la pastilla
            </div>
            <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px' }}>
              Estilo numérico que se mostrará junto al logo en la barra superior.
            </div>
          </div>
          <div
            style={{
              display: 'inline-flex',
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              borderRadius: 'var(--control-radius, 8px)',
              padding: '2px',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            {[
              { id: 'percent_remaining', label: '% Restante' },
              { id: 'percent_used', label: '% Usado' },
              { id: 'compact', label: 'Compacto' },
            ].map((opt) => {
              const isSel = prefs.displayMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onSetDisplayMode(opt.id as any)}
                  style={{
                    background: isSel ? 'rgba(255, 255, 255, 0.12)' : 'none',
                    border: 'none',
                    padding: '4px 9px',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    color: isSel ? '#fafafa' : '#a1a1aa',
                    fontSize: '11px',
                    fontWeight: isSel ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Priority / Order management */}
      <div
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 'var(--card-radius, 12px)',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 500, color: '#fafafa' }}>
          Prioridad de Proveedores en la Barra Superior
        </div>
        <div style={{ fontSize: '11px', color: '#a1a1aa' }}>
          Cuando no hay un modelo activo en el chat, el sistema mostrará el primer proveedor disponible en este orden:
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
          {prefs.providerOrder.map((id, index) => {
            const label = PROVIDER_LABELS[id] || id;
            const isEnabled = enabledSet.has(id);
            return (
              <div
                key={id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 8px',
                  borderRadius: 'var(--control-radius, 8px)',
                  backgroundColor: isEnabled ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  fontSize: '11px',
                  color: isEnabled ? '#e4e4e7' : '#71717a',
                }}
              >
                <span style={{ fontSize: '10px', color: '#71717a' }}>{index + 1}.</span>
                <BrandLogo engine={id} size={12} />
                <span>{label}</span>

                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => onMoveProviderOrder(id, 'up')}
                      title="Mover arriba"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '1px 3px',
                        color: '#a1a1aa',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <ChevronUpIcon size={12} strokeWidth={2.5} />
                    </button>
                  )}
                  {index < prefs.providerOrder.length - 1 && (
                    <button
                      type="button"
                      onClick={() => onMoveProviderOrder(id, 'down')}
                      title="Mover abajo"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '1px 3px',
                        color: '#a1a1aa',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <ChevronDownIcon size={12} strokeWidth={2.5} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '11px',
          color: '#71717a',
          lineHeight: 1.5,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span>
          Para configurar autenticación, comandos o tokens de un proveedor específico, selecciónalo en la lista de la izquierda.
        </span>
      </div>
    </div>
  );
};
