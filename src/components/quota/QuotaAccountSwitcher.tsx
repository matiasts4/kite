import React, { useState } from 'react';
import type { AntigravityAuthTelemetry, SavedAccountProfile } from '../../types';
import {
  canonicalVaultProvider,
  formatSplitBrainDetail,
  isSplitBrainActive,
  type FailedSwitchState,
} from '../../lib/accounts/accountVaultStore';
import {
  AccountSwitchErrorActions,
  PencilIcon,
  resolveAuthModeLabel,
  resolveCredentialHealthBadge,
} from '../accounts/AccountVaultUI';

export interface QuotaAccountSwitcherProps {
  isAccountsExpanded: boolean;
  accountsDropdownRef: React.RefObject<HTMLDivElement | null>;
  unregisteredLiveSession: {
    email: string;
    planName?: string | null;
  } | null;
  authTelemetry?: AntigravityAuthTelemetry | null;
  switchFeedback: string | null;
  isErrorFeedback?: boolean;
  loadingAccounts: boolean;
  savedAccounts: SavedAccountProfile[];
  switchingAccountId: string | null;
  saving?: boolean;
  renamingId?: string | null;
  closingProcesses?: boolean;
  lastFailedSwitch?: FailedSwitchState | null;
  onSwitchAccount: (profileId: string) => Promise<void>;
  onSaveCurrent?: (label?: string) => Promise<boolean>;
  onRenameProfile?: (profileId: string, label: string) => Promise<boolean>;
  onCloseResidualProcesses?: () => void | Promise<unknown>;
  onAlignIde?: () => Promise<void>;
  onReauth?: () => void;
  onOpenSettings: (providerId: string) => void;
  selectedProvider: string;
  onToggleAccounts: () => void;
}

export const QuotaAccountSwitcher: React.FC<QuotaAccountSwitcherProps> = ({
  isAccountsExpanded,
  accountsDropdownRef,
  unregisteredLiveSession,
  authTelemetry,
  switchFeedback,
  isErrorFeedback = false,
  loadingAccounts,
  savedAccounts,
  switchingAccountId,
  saving = false,
  renamingId = null,
  closingProcesses = false,
  lastFailedSwitch = null,
  onSwitchAccount,
  onSaveCurrent,
  onRenameProfile,
  onCloseResidualProcesses,
  onAlignIde,
  onReauth,
  onOpenSettings,
  selectedProvider,
  onToggleAccounts,
}) => {
  const [saveLabel, setSaveLabel] = useState('');
  const [showSaveRow, setShowSaveRow] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');

  const canon = canonicalVaultProvider(selectedProvider);
  const splitBrain = canon === 'antigravity' && isSplitBrainActive(authTelemetry);
  const splitBrainDetail = splitBrain ? formatSplitBrainDetail(authTelemetry) : null;
  const authModeLabel = canon === 'antigravity' ? resolveAuthModeLabel(authTelemetry) : null;

  const handleSaveUnregistered = async () => {
    if (!unregisteredLiveSession) return;
    if (onSaveCurrent) {
      await onSaveCurrent(unregisteredLiveSession.email);
      return;
    }
    onOpenSettings(selectedProvider);
  };

  const handleManualSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSaveCurrent) return;
    const ok = await onSaveCurrent(saveLabel);
    if (ok) {
      setSaveLabel('');
      setShowSaveRow(false);
    }
  };

  const handleCommitRename = async (accountId: string, e: React.FormEvent) => {
    e.preventDefault();
    if (!onRenameProfile) return;
    const ok = await onRenameProfile(accountId, editingLabel);
    if (ok) {
      setEditingId(null);
      setEditingLabel('');
    }
  };

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
            backgroundColor: 'var(--menu-surface, #18181b)',
            border: '1px solid var(--block-stroke)',
            borderRadius: 'var(--control-radius, 8px)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.06)',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            maxHeight: '280px',
            overflowY: 'auto',
          }}
        >
          {splitBrain && (
            <div
              style={{
                fontSize: '10.5px',
                padding: '6px 8px',
                borderRadius: 'var(--vl-radius-sm, 6px)',
                backgroundColor: 'var(--warning-tint)',
                color: 'var(--warning-text)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '6px',
              }}
            >
              <span>IDE desincronizada: {splitBrainDetail}</span>
              {onAlignIde && (
                <button
                  type="button"
                  disabled={Boolean(switchingAccountId)}
                  onClick={() => void onAlignIde()}
                  style={{
                    background: 'var(--chip-fill)',
                    border: '1px solid var(--block-stroke)',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    color: 'var(--text-primary)',
                    padding: '2px 7px',
                    fontSize: '10px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  Alinear IDE
                </button>
              )}
            </div>
          )}

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
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600 }}>Sesión no guardada:</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveUnregistered()}
                  style={{
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 'var(--vl-radius-xs, 4px)',
                    padding: '3px 8px',
                    fontSize: '10.5px',
                    fontWeight: 600,
                    cursor: saving ? 'default' : 'pointer',
                  }}
                >
                  {saving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
              <code style={{ fontSize: '10px' }}>{unregisteredLiveSession.email}</code>
            </div>
          )}

          {switchFeedback && (
            <div
              role={isErrorFeedback ? 'alert' : undefined}
              style={{
                fontSize: '10.5px',
                padding: '5px 7px',
                borderRadius: 'var(--vl-radius-xs, 4px)',
                backgroundColor:
                  isErrorFeedback || switchFeedback.includes('Error')
                    ? 'var(--danger-fill)'
                    : 'var(--accent-tint)',
                color:
                  isErrorFeedback || switchFeedback.includes('Error')
                    ? 'var(--danger-ink)'
                    : 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '6px',
              }}
            >
              <span>{switchFeedback}</span>
              {isErrorFeedback && (
                <AccountSwitchErrorActions
                  lastFailedSwitch={lastFailedSwitch}
                  closingProcesses={closingProcesses}
                  variant="compact"
                  onCloseResidualProcesses={onCloseResidualProcesses}
                  onReauth={onReauth}
                  onRetry={onSwitchAccount}
                />
              )}
            </div>
          )}

          {loadingAccounts && savedAccounts.length === 0 ? (
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '6px 2px' }}>
              Cargando cuentas guardadas...
            </div>
          ) : savedAccounts.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 0' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                No hay otras cuentas guardadas para este proveedor.
              </span>
              {onSaveCurrent && (
                <form onSubmit={(e) => void handleManualSave(e)} style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    placeholder="Nombre del perfil..."
                    value={saveLabel}
                    onChange={(e) => setSaveLabel(e.target.value)}
                    style={{
                      flex: 1,
                      height: '32px',
                      padding: '0 8px',
                      borderRadius: 'var(--control-radius, 8px)',
                      border: '1px solid var(--block-stroke)',
                      background: 'var(--composer, var(--block-fill))',
                      color: 'var(--text-primary)',
                      fontSize: '11px',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={saving}
                    style={{
                      height: '32px',
                      padding: '0 10px',
                      borderRadius: 'var(--control-radius, 8px)',
                      border: 'none',
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {saving ? 'Guardando...' : 'Guardar sesión'}
                  </button>
                </form>
              )}
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '190px', overflowY: 'auto' }}>
              {savedAccounts.map((acc) => {
                const isCurrentActive = acc.isActive;
                const isSwitching = switchingAccountId === acc.id;
                const isEditing = editingId === acc.id;
                const health = resolveCredentialHealthBadge(acc);

                return (
                  <div
                    key={acc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '5px 8px',
                      borderRadius: 'var(--vl-radius-sm, 6px)',
                      backgroundColor: isCurrentActive ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                      border: isCurrentActive ? '1px solid var(--block-stroke)' : '1px solid transparent',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                      {isEditing ? (
                        <form
                          onSubmit={(e) => void handleCommitRename(acc.id, e)}
                          style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                        >
                          <input
                            type="text"
                            aria-label={`Nuevo nombre para ${acc.label}`}
                            value={editingLabel}
                            autoFocus
                            onChange={(e) => setEditingLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                e.stopPropagation();
                                setEditingId(null);
                              }
                            }}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              height: '26px',
                              padding: '0 6px',
                              borderRadius: 'var(--vl-radius-xs, 4px)',
                              border: '1px solid var(--block-stroke)',
                              background: 'var(--composer, var(--block-fill))',
                              color: 'var(--text-primary)',
                              fontSize: '11px',
                            }}
                          />
                          <button
                            type="submit"
                            disabled={renamingId === acc.id}
                            style={{
                              height: '26px',
                              padding: '0 7px',
                              borderRadius: 'var(--vl-radius-xs, 4px)',
                              border: 'none',
                              background: 'var(--accent)',
                              color: '#fff',
                              fontSize: '10px',
                              cursor: 'pointer',
                            }}
                          >
                            Guardar
                          </button>
                        </form>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
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
                                borderRadius: 'var(--vl-radius-xs, 4px)',
                                backgroundColor: 'var(--accent-tint)',
                                color: 'var(--accent)',
                                fontWeight: 700,
                                textTransform: 'uppercase',
                              }}
                            >
                              Activa
                            </span>
                          )}
                          {health && (
                            <span
                              style={{
                                fontSize: '8.5px',
                                padding: '0 4px',
                                borderRadius: 'var(--vl-radius-xs, 4px)',
                                backgroundColor:
                                  health.tone === 'ok'
                                    ? 'color-mix(in srgb, var(--status-running) 18%, transparent)'
                                    : 'var(--danger-fill)',
                                color: health.tone === 'ok' ? 'var(--status-running)' : 'var(--danger-ink)',
                                fontWeight: 600,
                              }}
                            >
                              {health.label}
                            </span>
                          )}
                          {isCurrentActive && authModeLabel && (
                            <span
                              style={{
                                fontSize: '8.5px',
                                padding: '0 4px',
                                borderRadius: 'var(--vl-radius-xs, 4px)',
                                backgroundColor: 'var(--chip-fill)',
                                color: 'var(--text-secondary)',
                              }}
                            >
                              {authModeLabel}
                            </span>
                          )}
                        </div>
                      )}
                      {acc.email && acc.label && acc.email !== acc.label && (
                        <span style={{ fontSize: '9.5px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {acc.email}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      {onRenameProfile && !isEditing && (
                        <button
                          type="button"
                          aria-label={`Renombrar perfil ${acc.label}`}
                          title="Renombrar perfil"
                          onClick={() => {
                            setEditingId(acc.id);
                            setEditingLabel(acc.label);
                          }}
                          style={{
                            width: '26px',
                            height: '26px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: 'var(--vl-radius-xs, 4px)',
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                          }}
                        >
                          <PencilIcon size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isCurrentActive || isSwitching || Boolean(switchingAccountId)}
                        onClick={() => void onSwitchAccount(acc.id)}
                        style={{
                          height: '26px',
                          padding: '0 8px',
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
                        {isSwitching ? 'Cambiando y verificando...' : isCurrentActive ? 'En uso' : 'Usar'}
                      </button>
                    </div>
                  </div>
                );
              })}

              {onSaveCurrent && showSaveRow && (
                <form
                  onSubmit={(e) => void handleManualSave(e)}
                  style={{ display: 'flex', gap: '4px', marginTop: '4px' }}
                >
                  <input
                    type="text"
                    placeholder="Nombre del perfil..."
                    value={saveLabel}
                    onChange={(e) => setSaveLabel(e.target.value)}
                    autoFocus
                    style={{
                      flex: 1,
                      height: '32px',
                      padding: '0 8px',
                      borderRadius: 'var(--control-radius, 8px)',
                      border: '1px solid var(--block-stroke)',
                      background: 'var(--composer, var(--block-fill))',
                      color: 'var(--text-primary)',
                      fontSize: '11px',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={saving}
                    style={{
                      height: '32px',
                      padding: '0 10px',
                      borderRadius: 'var(--control-radius, 8px)',
                      border: 'none',
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                </form>
              )}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingTop: '4px',
                  borderTop: '1px dashed var(--block-stroke)',
                  marginTop: '2px',
                  gap: '8px',
                }}
              >
                {onSaveCurrent ? (
                  <button
                    type="button"
                    onClick={() => setShowSaveRow((prev) => !prev)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'var(--accent)',
                      fontSize: '10.5px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {showSaveRow ? 'Cancelar' : '+ Guardar sesión actual'}
                  </button>
                ) : <span />}
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
