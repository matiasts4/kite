import React from 'react';
import type { SavedAccountProfile } from '../../types';

export interface QuotaAccountSwitcherProps {
  isAccountsExpanded: boolean;
  accountsDropdownRef: React.RefObject<HTMLDivElement | null>;
  unregisteredLiveSession: {
    email: string;
    planName?: string | null;
  } | null;
  switchFeedback: string | null;
  loadingAccounts: boolean;
  savedAccounts: SavedAccountProfile[];
  switchingAccountId: string | null;
  onSwitchAccount: (profileId: string) => Promise<void>;
  onOpenSettings: (providerId: string) => void;
  selectedProvider: string;
  onToggleAccounts: () => void;
}

export const QuotaAccountSwitcher: React.FC<QuotaAccountSwitcherProps> = ({
  isAccountsExpanded,
  accountsDropdownRef,
  unregisteredLiveSession,
  switchFeedback,
  loadingAccounts,
  savedAccounts,
  switchingAccountId,
  onSwitchAccount,
  onOpenSettings,
  selectedProvider,
  onToggleAccounts,
}) => {
  return (
    <>
      <button
        type="button"
        className="subscription-quota-account-toggle"
        onClick={onToggleAccounts}
        style={{
          background: 'none',
          border: '1px solid var(--accent-tint-strong)',
          backgroundColor: isAccountsExpanded ? 'var(--accent-tint-strong)' : 'var(--accent-tint)',
          color: 'var(--accent, #5c8fff)',
          padding: '3px 8px',
          borderRadius: 'var(--vl-radius-xs, 4px)',
          fontSize: '11px',
          fontWeight: 500,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          flexShrink: 0,
        }}
        title={isAccountsExpanded ? 'Ocultar cuentas' : 'Ver cuentas para cambiar'}
      >
        <span>{isAccountsExpanded ? 'Cerrar' : 'Cambiar cuenta'}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: isAccountsExpanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 150ms ease',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Floating Accounts Dropdown Menu */}
      {isAccountsExpanded && (
        <div
          ref={accountsDropdownRef as any}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 100,
            backgroundColor: 'var(--menu-glass, #161618)',
            backdropFilter: 'var(--menu-backdrop, blur(24px))',
            WebkitBackdropFilter: 'var(--menu-backdrop, blur(24px))',
            border: '1px solid var(--block-stroke)',
            borderRadius: 'var(--control-radius, 8px)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.05)',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            maxHeight: '230px',
            overflowY: 'auto',
          }}
        >
          {unregisteredLiveSession && (
            <div
              style={{
                fontSize: '11px',
                padding: '6px 8px',
                borderRadius: 'var(--vl-radius-xs, 4px)',
                backgroundColor: 'rgba(234, 179, 8, 0.15)',
                border: '1px solid rgba(234, 179, 8, 0.3)',
                color: 'var(--text-primary)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                marginBottom: '4px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600 }}>Sesión no guardada:</span>
                <button
                  type="button"
                  onClick={() => onOpenSettings(selectedProvider)}
                  style={{
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    padding: '2px 6px',
                    fontSize: '10px',
                    cursor: 'pointer',
                  }}
                >
                  Guardar
                </button>
              </div>
              <code style={{ fontSize: '10px' }}>{unregisteredLiveSession.email}</code>
            </div>
          )}

          {switchFeedback && (
            <div
              style={{
                fontSize: '10.5px',
                padding: '3px 6px',
                borderRadius: 'var(--vl-radius-xs, 4px)',
                backgroundColor: switchFeedback.includes('Error') ? 'rgba(239, 68, 68, 0.15)' : 'var(--accent-tint)',
                color: switchFeedback.includes('Error') ? 'var(--warning-text, #ef4444)' : 'var(--accent)',
              }}
            >
              {switchFeedback}
            </div>
          )}

          {loadingAccounts ? (
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '6px 2px' }}>
              Cargando cuentas guardadas...
            </div>
          ) : savedAccounts.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                No hay otras cuentas guardadas para este proveedor.
              </span>
              <button
                type="button"
                onClick={() => onOpenSettings(selectedProvider)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--accent)',
                  fontSize: '11px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Administrar bóveda en Configuración →
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '180px', overflowY: 'auto' }}>
              {savedAccounts.map((acc) => {
                const isCurrentActive = acc.isActive;
                const isSwitching = switchingAccountId === acc.id;

                return (
                  <div
                    key={acc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '5px 8px',
                      borderRadius: 'var(--vl-radius-xs, 4px)',
                      backgroundColor: isCurrentActive ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                      border: isCurrentActive ? '1px solid var(--block-stroke)' : '1px solid transparent',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: '11px',
                            color: isCurrentActive ? 'var(--accent)' : 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {acc.label || acc.email}
                        </span>
                        {isCurrentActive && (
                          <span
                            style={{
                              fontSize: '8px',
                              padding: '0 4px',
                              borderRadius: '3px',
                              backgroundColor: 'var(--accent-tint)',
                              color: 'var(--accent)',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                            }}
                          >
                            Activa
                          </span>
                        )}
                      </div>
                      {acc.email && acc.label && acc.email !== acc.label && (
                        <span style={{ fontSize: '9.5px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {acc.email}
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={isCurrentActive || isSwitching}
                      onClick={() => onSwitchAccount(acc.id)}
                      style={{
                        padding: '3px 7px',
                        borderRadius: 'var(--vl-radius-xs, 4px)',
                        fontSize: '10px',
                        fontWeight: 600,
                        backgroundColor: isCurrentActive
                          ? 'transparent'
                          : 'var(--accent-tint, rgba(92, 143, 255, 0.15))',
                        color: isCurrentActive ? 'var(--text-secondary)' : 'var(--accent, #5c8fff)',
                        border: isCurrentActive ? 'none' : '1px solid var(--accent-tint-strong)',
                        cursor: isCurrentActive || isSwitching ? 'default' : 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {isSwitching ? 'Cambiando...' : isCurrentActive ? 'En uso' : 'Usar'}
                    </button>
                  </div>
                );
              })}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingTop: '4px',
                  borderTop: '1px dashed var(--block-stroke)',
                  marginTop: '2px',
                }}
              >
                <button
                  type="button"
                  onClick={() => onOpenSettings(selectedProvider)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'var(--text-secondary)',
                    fontSize: '10.5px',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                  }}
                >
                  <span>Bóveda completa en Ajustes</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};
