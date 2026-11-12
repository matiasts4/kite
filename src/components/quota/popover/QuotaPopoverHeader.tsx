import React from 'react';
import type { ProviderQuotaStatus } from '../../../lib/quota/types';
import {
  PROVIDER_LABELS,
  SHORT_PROVIDER_LABELS,
} from '../../../lib/quota/types';
import { BrandLogo } from '../../views/agents/engineMetadata';
import { diagnoseProvider } from '../../../lib/quota/providerState';

export interface QuotaPopoverHeaderProps {
  activeIds: string[];
  selectedProvider: string;
  onSelectProvider: (providerId: string) => void;
  allQuotas: Record<string, ProviderQuotaStatus>;
  tabsRef: React.RefObject<any>;
  canScrollLeft: boolean;
  canScrollRight: boolean;
  onScrollTabs: (direction: number) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenAccounts: () => void;
  onOpenSettings: (providerId?: string) => void;
  onClose: () => void;
}

export const QuotaPopoverHeader: React.FC<QuotaPopoverHeaderProps> = ({
  activeIds,
  selectedProvider,
  onSelectProvider,
  allQuotas,
  tabsRef,
  canScrollLeft,
  canScrollRight,
  onScrollTabs,
  onRefresh,
  isRefreshing,
  onOpenAccounts,
  onOpenSettings,
  onClose,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--block-stroke)',
        paddingBottom: '10px',
        marginBottom: '12px',
        gap: '8px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
          flex: 1,
          minWidth: 0,
        }}
      >
        <button
          type="button"
          aria-label="Proveedores anteriores"
          title="Proveedores anteriores"
          disabled={!canScrollLeft}
          onClick={() => onScrollTabs(-1)}
          style={{
            flexShrink: 0,
            background: 'none',
            border: 'none',
            padding: '2px',
            borderRadius: 'var(--vl-radius-xs, 4px)',
            color: 'var(--text-secondary)',
            cursor: canScrollLeft ? 'pointer' : 'default',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            visibility: canScrollLeft ? 'visible' : 'hidden',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div
          ref={tabsRef}
          onWheel={(e) => {
            const el = tabsRef.current;
            if (!el || el.scrollWidth <= el.clientWidth) return;
            el.scrollLeft += e.deltaY;
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            overflowX: 'auto',
            scrollbarWidth: 'none',
            flex: 1,
            minWidth: 0,
            scrollBehavior: 'smooth',
          }}
        >
          {activeIds.map((id) => {
            const shortLabel = SHORT_PROVIDER_LABELS[id] || PROVIDER_LABELS[id] || id;
            const fullLabel = PROVIDER_LABELS[id] || id;
            const q = allQuotas[id];
            const d = diagnoseProvider(q);
            const isActive = id === selectedProvider;

            return (
              <button
                key={id}
                type="button"
                data-provider-tab={id}
                onClick={() => onSelectProvider(id)}
                title={`${fullLabel} (${d.statusLabel})`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '4px 8px',
                  borderRadius: 'var(--control-radius, 8px)',
                  fontSize: '11px',
                  fontWeight: isActive ? 600 : 400,
                  border: isActive
                    ? '1px solid var(--accent-tint-strong)'
                    : '1px solid transparent',
                  backgroundColor: isActive
                    ? 'var(--accent-tint)'
                    : d.state !== 'not_installed'
                    ? 'var(--block-fill)'
                    : 'transparent',
                  color: isActive
                    ? 'var(--accent)'
                    : d.state === 'ok'
                    ? 'var(--text-primary)'
                    : d.state === 'detected'
                    ? 'var(--text-secondary)'
                    : d.state === 'signed_out' || d.state === 'error'
                    ? 'var(--warning-text)'
                    : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'all 120ms ease',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                <BrandLogo engine={id} size={13} />
                <span>{shortLabel}</span>
                {d.state === 'ok' && (
                  <span
                    style={{
                      width: '5px',
                      height: '5px',
                      borderRadius: '50%',
                      backgroundColor: 'var(--status-running)',
                      display: 'inline-block',
                    }}
                  />
                )}
                {(d.state === 'signed_out' || d.state === 'error') && (
                  <span
                    style={{
                      width: '5px',
                      height: '5px',
                      borderRadius: '50%',
                      backgroundColor: 'var(--warning-text)',
                      display: 'inline-block',
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          aria-label="Proveedores siguientes"
          title="Proveedores siguientes"
          disabled={!canScrollRight}
          onClick={() => onScrollTabs(1)}
          style={{
            flexShrink: 0,
            background: 'none',
            border: 'none',
            padding: '2px',
            borderRadius: 'var(--vl-radius-xs, 4px)',
            color: 'var(--text-secondary)',
            cursor: canScrollRight ? 'pointer' : 'default',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            visibility: canScrollRight ? 'visible' : 'hidden',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Action icons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={onRefresh}
          title="Actualizar cuotas"
          style={{
            background: 'none',
            border: 'none',
            padding: '5px',
            borderRadius: 'var(--vl-radius-xs, 4px)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              animation: isRefreshing ? 'spin 1s linear infinite' : 'none',
            }}
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 21h5v-5" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onOpenAccounts}
          title="Cambiar cuentas / Bóveda multi-cuenta"
          style={{
            background: 'none',
            border: 'none',
            padding: '5px',
            borderRadius: 'var(--vl-radius-xs, 4px)',
            color: 'var(--accent)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => onOpenSettings(selectedProvider)}
          title="Configuración de proveedores y cuotas"
          style={{
            background: 'none',
            border: 'none',
            padding: '5px',
            borderRadius: 'var(--vl-radius-xs, 4px)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onClose}
          title="Cerrar"
          style={{
            background: 'none',
            border: 'none',
            padding: '5px',
            borderRadius: 'var(--vl-radius-xs, 4px)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
};
