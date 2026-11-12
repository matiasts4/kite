import React from 'react';
import type { ProviderQuotaStatus } from '../../../lib/quota/types';
import { PROVIDER_LABELS } from '../../../lib/quota/types';
import { BrandLogo } from '../../views/agents/engineMetadata';
import { QuotaProgressRing } from '../QuotaProgressRing';
import { QuotaAccountSwitcher } from '../QuotaAccountSwitcher';
import { formatDetailedReset } from '../../../lib/quota/useResetCountdownClock';
import type { SavedAccountProfile } from '../../../types';

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
  isAccountsExpanded: boolean;
  accountsDropdownRef: React.RefObject<HTMLDivElement | null>;
  switchFeedback: string | null;
  loadingAccounts: boolean;
  switchingAccountId: string | null;
  onSwitchAccount: (profileId: string) => Promise<void>;
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
  isAccountsExpanded,
  accountsDropdownRef,
  switchFeedback,
  loadingAccounts,
  switchingAccountId,
  onSwitchAccount,
  onOpenSettings,
  onToggleAccounts,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto' }}>
      {activeIdsCount === 0 ? (
        <div
          style={{
            padding: '18px 14px',
            backgroundColor: 'var(--block-fill)',
            border: '1px dashed var(--block-stroke)',
            borderRadius: 'var(--control-radius, 8px)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
            No agregaste ningún proveedor
          </div>
          <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            Elegí qué cuotas querés monitorear. Tus claves y sesiones existentes siguen
            guardadas; solo se muestran los proveedores que agregues manualmente.
          </p>
          <button
            type="button"
            onClick={() => onOpenSettings()}
            style={{
              backgroundColor: 'var(--accent-tint)',
              border: '1px solid var(--accent-tint-strong)',
              borderRadius: 'var(--vl-radius-xs, 4px)',
              padding: '6px 12px',
              color: 'var(--accent)',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Agregar proveedor
          </button>
        </div>
      ) : (
        <>
          {/* Case 1: Active with real live quota windows */}
          {diagnostic.state === 'ok' && currentQuota && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                  borderRadius: 'var(--control-radius, 8px)',
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      position: 'relative',
                      width: 36,
                      height: 36,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <QuotaProgressRing
                      percentage={remPct ?? 100}
                      size={36}
                      strokeWidth={3}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                      }}
                    >
                      <BrandLogo engine={selectedProvider} size={16} />
                    </div>
                  </div>

                  <div>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: '13px',
                        color: 'var(--text-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      {currentQuota.displayName}
                      <span
                        style={{
                          fontSize: '9px',
                          fontWeight: 500,
                          padding: '1px 5px',
                          borderRadius: 'var(--vl-radius-xs, 4px)',
                          backgroundColor: 'var(--accent-tint)',
                          color: 'var(--accent)',
                          border: '1px solid var(--accent-tint-strong)',
                        }}
                      >
                        En línea
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {resetCountdown
                        ? `Resetea en ${resetCountdown}`
                        : formatDetailedReset(currentQuota.timeUntilResetMs)}
                    </div>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontSize: '18px',
                      fontWeight: 700,
                      lineHeight: 1,
                      color:
                        remPct != null && remPct < 20
                          ? 'var(--status-failed)'
                          : remPct != null && remPct < 45
                          ? 'var(--warning-text)'
                          : 'var(--accent)',
                    }}
                  >
                    {remPct}%
                  </div>
                  <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {currentQuota.metadata?.primaryWindowLabel
                      ? String(currentQuota.metadata.primaryWindowLabel)
                      : currentQuota.metadata?.primaryWindow === '5h'
                        ? 'Límite de 5 horas'
                        : 'Restante'}
                  </div>
                </div>
              </div>

              {/* Badges / Metadata row */}
              {currentQuota.metadata && Object.keys(currentQuota.metadata).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                  {currentQuota.metadata.planType && (
                    <span
                      style={{
                        fontSize: '10px',
                        padding: '2px 6px',
                        borderRadius: 'var(--vl-radius-xs, 4px)',
                        backgroundColor: 'var(--accent-tint)',
                        color: 'var(--accent)',
                        border: '1px solid var(--accent-tint-strong)',
                      }}
                    >
                      Plan: {currentQuota.metadata.planType}
                    </span>
                  )}
                  {currentQuota.metadata.email && (
                    <span
                      style={{
                        fontSize: '10px',
                        padding: '2px 6px',
                        borderRadius: 'var(--vl-radius-xs, 4px)',
                        backgroundColor: 'var(--block-fill)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--block-stroke)',
                      }}
                    >
                      {currentQuota.metadata.email}
                    </span>
                  )}
                </div>
              )}

              {/* Account Switcher Bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 10px',
                  borderRadius: 'var(--control-radius, 8px)',
                  backgroundColor: 'var(--block-fill)',
                  border: '1px solid var(--block-stroke)',
                  marginTop: '4px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    width: '100%',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', flexShrink: 0 }}>Cuenta activa:</span>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={(() => {
                        const emailDisplay =
                          savedAccounts.find((a) => a.isActive)?.email ??
                          unregisteredLiveSession?.email ??
                          (currentQuota.metadata?.email ? String(currentQuota.metadata.email) : null);
                        return emailDisplay || 'Sesión nativa activa';
                      })()}
                    >
                      {currentQuota.metadata?.email ? String(currentQuota.metadata.email) : 'Sesión nativa activa'}
                    </span>
                  </div>
                  <QuotaAccountSwitcher
                    isAccountsExpanded={isAccountsExpanded}
                    accountsDropdownRef={accountsDropdownRef}
                    unregisteredLiveSession={unregisteredLiveSession}
                    switchFeedback={switchFeedback}
                    loadingAccounts={loadingAccounts}
                    savedAccounts={savedAccounts}
                    switchingAccountId={switchingAccountId}
                    onSwitchAccount={onSwitchAccount}
                    onOpenSettings={onOpenSettings}
                    selectedProvider={selectedProvider}
                    onToggleAccounts={onToggleAccounts}
                  />
                </div>
              </div>

              {/* Individual windows breakdown */}
              {currentQuota.windows && currentQuota.windows.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-secondary)',
                      marginTop: '2px',
                    }}
                  >
                    Ventanas y Límites de Modelos
                  </div>

                  {currentQuota.windows.map((win, idx) => {
                    const rem = Math.round(win.remainingFraction * 100);
                    const used = Math.round(win.usagePercent);

                    return (
                      <div
                        key={idx}
                        style={{
                          backgroundColor: 'var(--chip-fill)',
                          border: '1px solid var(--block-stroke)',
                          borderRadius: 'var(--control-radius, 8px)',
                          padding: '7px 9px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'baseline',
                            gap: '8px',
                            fontSize: '11px',
                          }}
                        >
                          <span
                            style={{
                              color: 'var(--text-primary)',
                              fontWeight: 500,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={win.name}
                          >
                            {win.name}
                          </span>
                          <span
                            style={{
                              fontSize: '10px',
                              color: rem < 20 ? 'var(--status-failed)' : rem < 45 ? 'var(--warning-text)' : 'var(--text-secondary)',
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                              flexShrink: 0,
                            }}
                          >
                            {rem}% restante ({used}% usado)
                          </span>
                        </div>

                        <div
                          style={{
                            height: '4px',
                            width: '100%',
                            backgroundColor: 'var(--block-stroke)',
                            borderRadius: '2px',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${used}%`,
                              backgroundColor:
                                used > 80
                                  ? 'var(--status-failed)'
                                  : used > 55
                                  ? 'var(--warning-text)'
                                  : 'var(--status-running)',
                              borderRadius: '2px',
                              transition: 'width 300ms ease',
                            }}
                          />
                        </div>

                        {win.timeUntilResetMs != null && win.timeUntilResetMs > 0 && (
                          <div style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                            {formatDetailedReset(win.timeUntilResetMs)}
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
            <div
              style={{
                padding: '16px 14px',
                backgroundColor: 'var(--block-fill)',
                borderRadius: 'var(--control-radius, 8px)',
                border: '1px solid var(--block-stroke)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: 'var(--control-radius, 8px)',
                    backgroundColor: 'var(--accent-tint)',
                    border: '1px solid var(--accent-tint-strong)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <BrandLogo engine={selectedProvider} size={18} />
                </div>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                    <span
                      style={{
                        fontSize: '9px',
                        fontWeight: 500,
                        padding: '1px 5px',
                        borderRadius: 'var(--vl-radius-xs, 4px)',
                        backgroundColor: 'var(--accent-tint)',
                        color: 'var(--accent)',
                        border: '1px solid var(--accent-tint-strong)',
                      }}
                    >
                      Sesión local activa
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {currentQuota?.metadata?.source ? String(currentQuota.metadata.source) : 'Herramienta CLI detectada'}
                  </div>
                </div>
              </div>

              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  backgroundColor: 'var(--chip-fill)',
                  padding: '8px 10px',
                  borderRadius: 'var(--control-radius, 8px)',
                  border: '1px solid var(--block-fill)',
                  lineHeight: 1.4,
                }}
              >
                Este proveedor no expone cuotas ni créditos mediante una API de facturación en vivo. Está listo para ser usado directamente por los agentes de Kite.
              </div>

              <button
                type="button"
                onClick={() => onOpenSettings(selectedProvider)}
                style={{
                  alignSelf: 'flex-start',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--accent)',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <span>Ver detalles de configuración</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          )}

          {/* Case 3: Error / Session Required / Not configured */}
          {(diagnostic.state === 'signed_out' || diagnostic.state === 'error' || diagnostic.state === 'not_installed') && (
            <div
              style={{
                padding: '16px 14px',
                backgroundColor:
                  diagnostic.state === 'error'
                    ? 'var(--danger-fill)'
                    : diagnostic.state === 'signed_out'
                    ? 'var(--warning-tint)'
                    : 'var(--block-fill)',
                borderRadius: 'var(--control-radius, 8px)',
                border: `1px solid ${
                  diagnostic.state === 'error'
                    ? 'var(--danger-fill)'
                    : diagnostic.state === 'signed_out'
                    ? 'var(--warning-tint)'
                    : 'var(--block-stroke)'
                }`,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: 'var(--control-radius, 8px)',
                    backgroundColor: 'var(--block-fill)',
                    border: '1px solid var(--block-stroke)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <BrandLogo engine={selectedProvider} size={18} />
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                    <span
                      style={{
                        fontSize: '9px',
                        fontWeight: 500,
                        padding: '1px 5px',
                        borderRadius: 'var(--vl-radius-xs, 4px)',
                        backgroundColor:
                          diagnostic.state === 'error'
                            ? 'var(--danger-fill)'
                            : diagnostic.state === 'signed_out'
                            ? 'var(--warning-tint)'
                            : 'var(--block-stroke)',
                        color:
                          diagnostic.state === 'error'
                            ? 'var(--status-failed)'
                            : diagnostic.state === 'signed_out'
                            ? 'var(--warning-text)'
                            : 'var(--text-secondary)',
                        border: `1px solid ${
                          diagnostic.state === 'error'
                            ? 'var(--danger-fill)'
                            : diagnostic.state === 'signed_out'
                            ? 'var(--warning-tint)'
                            : 'var(--block-stroke)'
                        }`,
                      }}
                    >
                      {diagnostic.statusLabel}
                    </span>
                  </div>

                  <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                    {diagnostic.detail}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onOpenSettings(selectedProvider)}
                style={{
                  marginTop: '2px',
                  backgroundColor: 'var(--accent-tint)',
                  border: '1px solid var(--accent-tint-strong)',
                  borderRadius: 'var(--vl-radius-xs, 4px)',
                  padding: '6px 12px',
                  color: 'var(--accent)',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  alignSelf: 'flex-start',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span>Configurar {PROVIDER_LABELS[selectedProvider] || selectedProvider}</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
