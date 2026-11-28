import React from 'react';
import type { ProviderQuotaStatus } from '../../../lib/quota/types';
import { PROVIDER_LABELS } from '../../../lib/quota/types';
import { BrandLogo } from '../../views/agents/engineMetadata';
import { QuotaProgressRing } from '../QuotaProgressRing';
import { QuotaAccountSwitcher } from '../QuotaAccountSwitcher';
import { formatDetailedReset } from '../../../lib/quota/useResetCountdownClock';
import { getQuotaRefreshNotice, type QuotaRefreshNotice } from '../../../lib/quota/providerState';
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ClockIcon,
  LayersIcon,
  PlusIcon,
  SettingsGearIcon,
  UserVaultIcon,
} from '../../titlebar/TopbarPopoverIcons';
import type {
  AntigravityAuthTelemetry,
  AutoSwitchPolicy,
  AutoSwitchRuntimeStatus,
  PendingAutoSwitchConfirmation,
  SavedAccountProfile,
} from '../../../types';
import type { FailedSwitchState } from '../../../lib/accounts/accountVaultStore';
import { AutoSwitchStatusBanner } from '../../accounts/AutoSwitchSettingsPanel';

const QuotaStaleBanner: React.FC<{ notice: QuotaRefreshNotice | null }> = ({ notice }) => {
  if (!notice) return null;
  return (
    <div
      data-testid="quota-stale-notice"
      role="status"
      title={notice.detail}
      className="qt-stale-banner"
    >
      <AlertTriangleIcon size={13} />
      <span>{notice.message}</span>
    </div>
  );
};

export interface QuotaPopoverContentProps {
  activeIdsCount: number;
  selectedProvider: string;
  currentQuota: ProviderQuotaStatus | null;
  diagnostic: {
    state: 'ok' | 'detected' | 'signed_out' | 'error' | 'not_installed';
    statusLabel: string;
    detail?: string | null;
  };
  remPct: number | null;
  resetCountdown: string | null;
  savedAccounts: SavedAccountProfile[];
  unregisteredLiveSession: { email: string; planName?: string | null } | null;
  authTelemetry?: AntigravityAuthTelemetry | null;
  isAccountsExpanded: boolean;
  accountsDropdownRef: React.RefObject<HTMLDivElement | null>;
  switchFeedback: string | null;
  isErrorFeedback?: boolean;
  loadingAccounts: boolean;
  switchingAccountId: string | null;
  saving?: boolean;
  renamingId?: string | null;
  closingProcesses?: boolean;
  lastFailedSwitch?: FailedSwitchState | null;
  autoSwitchPolicy?: AutoSwitchPolicy;
  autoSwitchRuntimeStatus?: AutoSwitchRuntimeStatus;
  pendingAutoSwitchConfirmations?: PendingAutoSwitchConfirmation[];
  autoSwitchResuming?: boolean;
  onSwitchAccount: (profileId: string) => Promise<void>;
  onSaveCurrent?: (label?: string) => Promise<boolean>;
  onRenameProfile?: (profileId: string, label: string) => Promise<boolean>;
  onCloseResidualProcesses?: () => void | Promise<unknown>;
  onResumeAutoSwitch?: () => void | Promise<unknown>;
  onAlignIde?: () => Promise<void>;
  onReauth?: () => void;
  onOpenSettings: (providerId?: string) => void;
  onToggleAccounts: () => void;
}

export const QuotaPopoverContent: React.FC<QuotaPopoverContentProps> = ({
  activeIdsCount,
  selectedProvider,
  currentQuota,
  diagnostic,
  remPct,
  resetCountdown,
  savedAccounts,
  unregisteredLiveSession,
  authTelemetry = null,
  isAccountsExpanded,
  accountsDropdownRef,
  switchFeedback,
  isErrorFeedback = false,
  loadingAccounts,
  switchingAccountId,
  saving = false,
  renamingId = null,
  closingProcesses = false,
  lastFailedSwitch = null,
  autoSwitchPolicy,
  autoSwitchRuntimeStatus,
  pendingAutoSwitchConfirmations = [],
  autoSwitchResuming = false,
  onSwitchAccount,
  onSaveCurrent,
  onRenameProfile,
  onCloseResidualProcesses,
  onResumeAutoSwitch,
  onAlignIde,
  onReauth,
  onOpenSettings,
  onToggleAccounts,
}) => {
  const resolvedActiveEmail =
    savedAccounts.find((a) => a.isActive)?.email ||
    unregisteredLiveSession?.email ||
    authTelemetry?.cliEmail ||
    authTelemetry?.credEmail ||
    (currentQuota?.metadata?.email ? String(currentQuota.metadata.email) : null) ||
    'Sesión nativa activa';

  const staleNotice = getQuotaRefreshNotice(currentQuota);

  const hasAutoSwitchStrip = Boolean(
    autoSwitchPolicy?.enabled ||
      autoSwitchRuntimeStatus?.paused ||
      pendingAutoSwitchConfirmations.length > 0
  );

  const heroTone =
    remPct != null && remPct < 20
      ? 'danger'
      : remPct != null && remPct < 45
        ? 'warn'
        : 'ok';

  const accountSwitcherBar = (
    <div className="qt-account-bar">
      <div className="qt-account-bar__row">
        <div className="qt-account-bar__id">
          <UserVaultIcon size={13} />
          <span className="qt-account-bar__label">Cuenta activa:</span>
          <span className="qt-account-bar__email" title={resolvedActiveEmail}>
            {resolvedActiveEmail}
          </span>
        </div>
        <QuotaAccountSwitcher
          isAccountsExpanded={isAccountsExpanded}
          accountsDropdownRef={accountsDropdownRef}
          unregisteredLiveSession={unregisteredLiveSession}
          authTelemetry={authTelemetry}
          switchFeedback={switchFeedback}
          isErrorFeedback={isErrorFeedback}
          loadingAccounts={loadingAccounts}
          savedAccounts={savedAccounts}
          switchingAccountId={switchingAccountId}
          saving={saving}
          renamingId={renamingId}
          closingProcesses={closingProcesses}
          lastFailedSwitch={lastFailedSwitch}
          onSwitchAccount={onSwitchAccount}
          onSaveCurrent={onSaveCurrent}
          onRenameProfile={onRenameProfile}
          onCloseResidualProcesses={onCloseResidualProcesses}
          onAlignIde={onAlignIde}
          onReauth={onReauth}
          onOpenSettings={onOpenSettings}
          selectedProvider={selectedProvider}
          onToggleAccounts={onToggleAccounts}
        />
      </div>

      {hasAutoSwitchStrip ? (
        <div className="qt-autoswitch-strip">
          <div className="qt-autoswitch-strip__head">
            <span
              className="qt-chip"
              data-tone={
                autoSwitchRuntimeStatus?.paused
                  ? 'warn'
                  : pendingAutoSwitchConfirmations.length > 0
                    ? 'warn'
                    : 'ok'
              }
            >
              {autoSwitchRuntimeStatus?.paused
                ? 'Auto 0%: Pausado'
                : pendingAutoSwitchConfirmations.length > 0
                  ? 'Auto 0%: Confirmar'
                  : 'Auto 0%: Activo'}
            </span>
            <button
              type="button"
              className="qt-text-link"
              onClick={() => onOpenSettings(selectedProvider)}
            >
              Configurar
            </button>
          </div>
          {autoSwitchRuntimeStatus ? (
            <AutoSwitchStatusBanner
              status={autoSwitchRuntimeStatus}
              resuming={autoSwitchResuming}
              closingProcesses={closingProcesses}
              pendingCount={pendingAutoSwitchConfirmations.length}
              compact
              onResume={onResumeAutoSwitch}
              onCloseResidualProcesses={onCloseResidualProcesses}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const showHeroMeta = Boolean(
    currentQuota?.metadata?.planType ||
      currentQuota?.metadata?.email ||
      resolvedActiveEmail !== 'Sesión nativa activa'
  );

  return (
    <div className="qt-pop-body scroll-quiet">
      {activeIdsCount === 0 ? (
        <div className="tp-empty">
          <span className="tp-empty__halo" aria-hidden="true">
            <LayersIcon size={18} />
          </span>
          <strong className="tp-empty__title">No agregaste ningún proveedor</strong>
          <p className="tp-empty__desc">
            Elegí qué cuotas querés monitorear. Tus claves y sesiones existentes siguen
            guardadas; solo se muestran los proveedores que agregues manualmente.
          </p>
          <button
            type="button"
            className="tp-btn tp-btn--primary"
            onClick={() => onOpenSettings()}
          >
            <PlusIcon size={13} />
            <span>Agregar proveedor</span>
          </button>
        </div>
      ) : (
        <>
          {/* Case 1: Active with real live quota windows */}
          {diagnostic.state === 'ok' && currentQuota && (
            <>
              <div className="qt-hero-card" data-tone={heroTone}>
                <div className="qt-hero-card__top">
                  <div className="qt-hero-identity">
                    <div className="qt-hero-ring">
                      <QuotaProgressRing
                        percentage={remPct ?? 100}
                        size={44}
                        strokeWidth={3.5}
                      />
                      <div className="qt-hero-ring__logo">
                        <BrandLogo engine={selectedProvider} size={17} />
                      </div>
                    </div>

                    <div className="qt-hero-copy">
                      <div className="qt-hero-title-row">
                        <span className="qt-hero-name">{currentQuota.displayName}</span>
                        <span
                          className={`tp-pill ${
                            staleNotice ? 'tp-pill--warning' : 'tp-pill--accent'
                          }`}
                        >
                          {staleNotice ? 'Sin respuesta' : 'En línea'}
                        </span>
                      </div>
                      <div className="qt-hero-reset">
                        <ClockIcon size={11} />
                        <span>
                          {resetCountdown
                            ? `Resetea en ${resetCountdown}`
                            : formatDetailedReset(currentQuota.timeUntilResetMs)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="qt-hero-metric">
                    <div className="qt-hero-pct">{remPct}%</div>
                    <div className="qt-hero-window-label">
                      {currentQuota.metadata?.primaryWindowLabel
                        ? String(currentQuota.metadata.primaryWindowLabel)
                        : currentQuota.metadata?.primaryWindow === '5h'
                          ? 'Límite de 5 horas'
                          : 'Restante'}
                    </div>
                  </div>
                </div>

                {showHeroMeta && (
                  <div className="qt-hero-meta">
                    {currentQuota.metadata?.planType && (
                      <span className="tp-pill tp-pill--chip tp-pill--accent">
                        Plan: {currentQuota.metadata.planType}
                      </span>
                    )}
                    {(currentQuota.metadata?.email || resolvedActiveEmail !== 'Sesión nativa activa') && (
                      <span className="qt-hero-email">
                        {resolvedActiveEmail !== 'Sesión nativa activa'
                          ? resolvedActiveEmail
                          : String(currentQuota.metadata?.email)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <QuotaStaleBanner notice={staleNotice} />

              {/* Account Switcher Bar */}
              {accountSwitcherBar}

              {/* Individual windows breakdown */}
              {currentQuota.windows && currentQuota.windows.length > 0 && (
                <div className="qt-windows">
                  <div className="tp-eyebrow">Ventanas y Límites de Modelos</div>

                  {currentQuota.windows.map((win, idx) => {
                    const rem = Math.round(win.remainingFraction * 100);
                    const used = Math.round(win.usagePercent);
                    const statClass =
                      rem < 20
                        ? 'qt-window-row__stat qt-window-row__stat--danger'
                        : rem < 45
                          ? 'qt-window-row__stat qt-window-row__stat--warn'
                          : 'qt-window-row__stat';
                    const fillClass =
                      used > 80
                        ? 'tp-meter__fill qt-window-fill--danger'
                        : used > 55
                          ? 'tp-meter__fill qt-window-fill--warn'
                          : 'tp-meter__fill qt-window-fill--ok';

                    return (
                      <div key={idx} className="qt-window-row">
                        <div className="qt-window-row__head">
                          <span className="qt-window-row__name" title={win.name}>
                            {win.name}
                          </span>
                          <span className={statClass}>
                            {rem}% restante ({used}% usado)
                          </span>
                        </div>

                        <div className="tp-meter">
                          <div className={fillClass} style={{ width: `${used}%` }} />
                        </div>

                        {win.timeUntilResetMs != null && win.timeUntilResetMs > 0 && (
                          <div className="qt-window-row__reset">
                            <ClockIcon size={10} />
                            <span>{formatDetailedReset(win.timeUntilResetMs)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Case 2: Detected locally */}
          {diagnostic.state === 'detected' && (
            <div className="qt-diag-card" data-tone="info">
              <div className="qt-diag-card__head">
                <div className="qt-diag-card__pedestal">
                  <BrandLogo engine={selectedProvider} size={18} />
                </div>
                <div className="qt-diag-card__copy">
                  <div className="qt-hero-title-row">
                    <span className="qt-hero-name">
                      {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                    </span>
                    <span className="tp-pill tp-pill--accent">Sesión local activa</span>
                  </div>
                  <div className="tp-popover__subtitle">
                    {currentQuota?.metadata?.source
                      ? String(currentQuota.metadata.source)
                      : 'Herramienta CLI detectada'}
                  </div>
                </div>
              </div>

              <div className="qt-diag-card__callout">
                Este proveedor no expone cuotas ni créditos mediante una API de facturación en vivo. Está listo para ser usado directamente por los agentes de Kite.
              </div>

              <QuotaStaleBanner notice={staleNotice} />

              <button
                type="button"
                className="qt-text-link"
                onClick={() => onOpenSettings(selectedProvider)}
              >
                <span>Ver detalles de configuración</span>
                <ArrowRightIcon size={12} />
              </button>
            </div>
          )}

          {/* Case 3: Error / Session Required / Not configured */}
          {(diagnostic.state === 'signed_out' ||
            diagnostic.state === 'error' ||
            diagnostic.state === 'not_installed') && (
            <div
              className="qt-diag-card"
              data-tone={
                diagnostic.state === 'error'
                  ? 'danger'
                  : diagnostic.state === 'signed_out'
                    ? 'warn'
                    : 'neutral'
              }
            >
              <div className="qt-diag-card__head">
                <div className="qt-diag-card__pedestal">
                  <BrandLogo engine={selectedProvider} size={18} />
                </div>

                <div className="qt-diag-card__copy">
                  <div className="qt-hero-title-row">
                    <span className="qt-hero-name">
                      {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                    </span>
                    <span
                      className={`tp-pill ${
                        diagnostic.state === 'error'
                          ? 'tp-pill--danger'
                          : diagnostic.state === 'signed_out'
                            ? 'tp-pill--warning'
                            : ''
                      }`}
                    >
                      {diagnostic.statusLabel}
                    </span>
                  </div>

                  <p className="qt-diag-card__detail">{diagnostic.detail}</p>
                </div>
              </div>

              <div>
                <button
                  type="button"
                  className="tp-btn tp-btn--primary"
                  onClick={() => onOpenSettings(selectedProvider)}
                >
                  <SettingsGearIcon size={12} />
                  <span>Configurar {PROVIDER_LABELS[selectedProvider] || selectedProvider}</span>
                </button>
              </div>
            </div>
          )}

          {diagnostic.state !== 'ok' &&
            (savedAccounts.length > 0 || Boolean(unregisteredLiveSession)) &&
            accountSwitcherBar}
        </>
      )}
    </div>
  );
};
