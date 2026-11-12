import React from 'react';
import {
  type ProviderQuotaStatus,
  PROVIDER_LABELS,
} from '../../../lib/quota/types';
import { BrandLogo } from '../../views/agents/engineMetadata';
import { diagnoseProvider } from '../../../lib/quota/providerState';

export interface QuotaSidebarListProps {
  selectedTab: string;
  onSelectTab: (tab: string) => void;
  searchFilter: string;
  onSearchFilterChange: (val: string) => void;
  filteredProviders: string[];
  enabledSet: Set<string>;
  pinnedProvider: string | null;
  allQuotas: Record<string, ProviderQuotaStatus>;
  onEnableAll: () => void;
  onDisableAll: () => void;
  onEnableConnectedOnly: () => void;
  onToggleProvider: (id: string, e: React.MouseEvent) => void;
}

export const QuotaSidebarList: React.FC<QuotaSidebarListProps> = ({
  selectedTab,
  onSelectTab,
  searchFilter,
  onSearchFilterChange,
  filteredProviders,
  enabledSet,
  pinnedProvider,
  allQuotas,
  onEnableAll,
  onDisableAll,
  onEnableConnectedOnly,
  onToggleProvider,
}) => {
  return (
    <div
      style={{
        width: '280px',
        borderRight: '1px solid var(--dock-border, rgba(255, 255, 255, 0.08))',
        backgroundColor: 'rgba(0, 0, 0, 0.25)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* General item */}
      <div style={{ padding: '10px 12px 6px' }}>
        <button
          type="button"
          onClick={() => onSelectTab('general')}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderRadius: 'var(--control-radius, 8px)',
            border: selectedTab === 'general' ? '1px solid rgba(52, 211, 153, 0.3)' : '1px solid transparent',
            background: selectedTab === 'general' ? 'rgba(52, 211, 153, 0.12)' : 'rgba(255, 255, 255, 0.04)',
            color: selectedTab === 'general' ? '#34d399' : '#d4d4d8',
            textAlign: 'left',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 120ms ease',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>Preferencias Generales</span>
        </button>
      </div>

      {/* Quick Filter & Bulk Actions */}
      <div style={{ padding: '0 12px 8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder="Buscar proveedor..."
            value={searchFilter}
            onChange={(e) => onSearchFilterChange(e.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '5px 10px 5px 26px',
              fontSize: '11px',
              backgroundColor: '#0a0a0c',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: 'var(--control-radius, 8px)',
              color: '#fafafa',
            }}
          />
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ position: 'absolute', left: '8px', top: '7px', color: '#71717a' }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        {/* Bulk action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            type="button"
            onClick={onEnableAll}
            style={{
              flex: 1,
              padding: '3px 4px',
              fontSize: '10px',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 'var(--vl-radius-xs, 4px)',
              color: '#a1a1aa',
              cursor: 'pointer',
            }}
            title="Habilitar todos los proveedores"
          >
            Todos
          </button>
          <button
            type="button"
            onClick={onDisableAll}
            style={{
              flex: 1,
              padding: '3px 4px',
              fontSize: '10px',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 'var(--vl-radius-xs, 4px)',
              color: '#a1a1aa',
              cursor: 'pointer',
            }}
            title="Deshabilitar todos los proveedores"
          >
            Ninguno
          </button>
          <button
            type="button"
            onClick={onEnableConnectedOnly}
            style={{
              flex: 1.4,
              padding: '3px 4px',
              fontSize: '10px',
              backgroundColor: 'rgba(52, 211, 153, 0.1)',
              border: '1px solid rgba(52, 211, 153, 0.2)',
              borderRadius: 'var(--vl-radius-xs, 4px)',
              color: '#34d399',
              cursor: 'pointer',
            }}
            title="Habilitar solo los proveedores con sesión activa o detectada"
          >
            Solo activos
          </button>
        </div>
      </div>

      <div
        style={{
          padding: '6px 12px 4px',
          fontSize: '10px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#71717a',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Proveedores</span>
        <span>{enabledSet.size} activos</span>
      </div>

      {/* Providers list with FAST TOGGLES IN EVERY ROW */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 6px 10px' }}>
        {filteredProviders.map((id) => {
          const label = PROVIDER_LABELS[id] || id;
          const isSelected = selectedTab === id;
          const isEnabled = enabledSet.has(id);
          const isPinned = pinnedProvider === id;
          const q = allQuotas[id];
          const d = diagnoseProvider(q);

          return (
            <div
              key={id}
              onClick={() => onSelectTab(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 8px',
                marginBottom: '2px',
                borderRadius: 'var(--control-radius, 8px)',
                background: isSelected
                  ? 'rgba(255, 255, 255, 0.08)'
                  : 'transparent',
                borderLeft: isSelected ? '3px solid #34d399' : '3px solid transparent',
                color: isSelected ? '#fafafa' : isEnabled ? '#d4d4d8' : '#71717a',
                cursor: 'pointer',
                transition: 'all 100ms ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    overflow: 'hidden',
                  }}
                >
                  <BrandLogo engine={id} size={14} />
                </span>

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: '11px',
                      fontWeight: isSelected ? 600 : 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </div>
                </div>

                {/* State dot */}
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    flexShrink: 0,
                    backgroundColor:
                      d.state === 'ok'
                        ? '#10b981'
                        : d.state === 'detected'
                        ? '#38bdf8'
                        : d.state === 'signed_out' || d.state === 'error'
                        ? '#f59e0b'
                        : 'rgba(255, 255, 255, 0.2)',
                  }}
                  title={d.statusLabel}
                />
              </div>

              {/* Actions right: Pin & FAST TOGGLE SWITCH */}
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginLeft: '6px' }}
                onClick={(e) => e.stopPropagation()}
              >
                {isPinned && (
                  <span title="Fijado como predeterminado" style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="#fbbf24"
                      stroke="#fbbf24"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </span>
                )}

                {/* Fast Switch on the row */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  aria-label={`Alternar ${label}`}
                  className="ui-switch"
                  onClick={(e) => onToggleProvider(id, e)}
                  style={{
                    cursor: 'pointer',
                    transform: 'scale(0.85)',
                    transformOrigin: 'right center',
                  }}
                >
                  <span aria-hidden="true" className="ui-switch__knob" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
