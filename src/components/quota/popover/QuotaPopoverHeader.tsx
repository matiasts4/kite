import React from 'react';
import type { ProviderQuotaStatus } from '../../../lib/quota/types';
import {
  PROVIDER_LABELS,
  SHORT_PROVIDER_LABELS,
} from '../../../lib/quota/types';
import { BrandLogo } from '../../views/agents/engineMetadata';
import { diagnoseProvider, getQuotaRefreshNotice } from '../../../lib/quota/providerState';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  RefreshIcon,
  SettingsGearIcon,
  UserVaultIcon,
} from '../../titlebar/TopbarPopoverIcons';

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
  isAccountsExpanded?: boolean;
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
  isAccountsExpanded = false,
  onOpenAccounts,
  onOpenSettings,
  onClose,
}) => {
  const showScrollButtons = canScrollLeft || canScrollRight;

  return (
    <div className="qt-pop-header">
      <div className="qt-provider-rail">
        {showScrollButtons && (
          <button
            type="button"
            className="tp-icon-btn"
            aria-label="Proveedores anteriores"
            title="Proveedores anteriores"
            disabled={!canScrollLeft}
            onClick={() => onScrollTabs(-1)}
          >
            <ChevronLeftIcon size={12} />
          </button>
        )}

        <div
          ref={tabsRef}
          className="qt-provider-tabs"
          onWheel={(e) => {
            const el = tabsRef.current;
            if (!el || el.scrollWidth <= el.clientWidth) return;
            el.scrollLeft += e.deltaY;
          }}
        >
          {activeIds.map((id) => {
            const shortLabel = SHORT_PROVIDER_LABELS[id] || PROVIDER_LABELS[id] || id;
            const fullLabel = PROVIDER_LABELS[id] || id;
            const q = allQuotas[id];
            const d = diagnoseProvider(q);
            const staleNotice = getQuotaRefreshNotice(q);
            const isActive = id === selectedProvider;
            const isWarn = Boolean(staleNotice) || d.state === 'signed_out' || d.state === 'error';

            return (
              <button
                key={id}
                type="button"
                data-provider-tab={id}
                onClick={() => onSelectProvider(id)}
                className={`qt-provider-tab${isActive ? ' qt-provider-tab--active' : ''}${
                  isWarn ? ' qt-provider-tab--warn' : ''
                }`}
                title={
                  staleNotice
                    ? `${fullLabel} (Sin respuesta · ${staleNotice.lastUpdatedLabel})`
                    : `${fullLabel} (${d.statusLabel})`
                }
              >
                <BrandLogo engine={id} size={13} />
                <span>{shortLabel}</span>
                {d.state === 'ok' && (
                  <span
                    className={`qt-provider-dot ${
                      staleNotice ? 'qt-provider-dot--warn' : 'qt-provider-dot--ok'
                    }`}
                    aria-hidden="true"
                  />
                )}
                {(d.state === 'signed_out' || d.state === 'error') && (
                  <span className="qt-provider-dot qt-provider-dot--warn" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>

        {showScrollButtons && (
          <button
            type="button"
            className="tp-icon-btn"
            aria-label="Proveedores siguientes"
            title="Proveedores siguientes"
            disabled={!canScrollRight}
            onClick={() => onScrollTabs(1)}
          >
            <ChevronRightIcon size={12} />
          </button>
        )}
      </div>

      {/* Action icons */}
      <div className="tp-popover__actions">
        <button
          type="button"
          className="tp-icon-btn"
          onClick={onRefresh}
          title="Actualizar cuotas"
          aria-label="Actualizar cuotas"
        >
          <RefreshIcon size={13} className={isRefreshing ? 'tp-spin' : undefined} />
        </button>

        <button
          type="button"
          className={`tp-icon-btn${isAccountsExpanded ? ' tp-icon-btn--active' : ''}`}
          onClick={onOpenAccounts}
          title="Cambiar cuentas / Bóveda multi-cuenta"
          aria-label="Cambiar cuentas / Bóveda multi-cuenta"
          aria-expanded={isAccountsExpanded}
        >
          <UserVaultIcon size={14} />
        </button>

        <button
          type="button"
          className="tp-icon-btn"
          onClick={() => onOpenSettings(selectedProvider)}
          title="Configuración de proveedores y cuotas"
          aria-label="Configuración de proveedores y cuotas"
        >
          <SettingsGearIcon size={13} />
        </button>

        <button
          type="button"
          className="tp-icon-btn"
          onClick={onClose}
          title="Cerrar"
          aria-label="Cerrar"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
};
