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
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../titlebar/TopbarPopoverIcons';

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
        className={`subscription-quota-account-toggle tp-btn tp-btn--sm ${
          isAccountsExpanded ? 'tp-btn--accent' : 'tp-btn--secondary'
        }`}
        onClick={onToggleAccounts}
        title={isAccountsExpanded ? 'Ocultar cuentas' : 'Ver cuentas para cambiar'}
      >
        <span>{isAccountsExpanded ? 'Cerrar' : 'Cambiar cuenta'}</span>
        <ChevronDownIcon
          size={11}
          className={`qt-chevron${isAccountsExpanded ? ' qt-chevron--open' : ''}`}
        />
      </button>

      {/* Floating Accounts Dropdown Menu */}
      {isAccountsExpanded && (
        <div ref={accountsDropdownRef as any} className="qt-vault-drawer scroll-quiet">
          {splitBrain && (
            <div className="qt-vault-banner qt-vault-banner--warn">
              <div className="qt-account-bar__id">
                <AlertTriangleIcon size={13} />
                <span>IDE desincronizada: {splitBrainDetail}</span>
              </div>
              {onAlignIde && (
                <button
                  type="button"
                  className="tp-btn tp-btn--sm tp-btn--secondary"
                  disabled={Boolean(switchingAccountId)}
                  onClick={() => void onAlignIde()}
                >
                  Alinear IDE
                </button>
              )}
            </div>
          )}

          {unregisteredLiveSession && (
            <div className="qt-vault-unreg">
              <div className="qt-vault-unreg__head">
                <strong>Sesión no guardada:</strong>
                <button
                  type="button"
                  className="tp-btn tp-btn--sm tp-btn--primary"
                  disabled={saving}
                  onClick={() => void handleSaveUnregistered()}
                >
                  {saving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
              <code className="qt-vault-unreg__code">{unregisteredLiveSession.email}</code>
            </div>
          )}

          {switchFeedback && (
            <div
              role={isErrorFeedback ? 'alert' : undefined}
              className={`qt-vault-banner ${
                isErrorFeedback || switchFeedback.includes('Error')
                  ? 'qt-vault-banner--danger'
                  : 'qt-vault-banner--info'
              }`}
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
            <div className="qt-vault-empty">Cargando cuentas guardadas...</div>
          ) : savedAccounts.length === 0 ? (
            <div className="qt-vault-empty">
              <span>No hay otras cuentas guardadas para este proveedor.</span>
              {onSaveCurrent && (
                <form onSubmit={(e) => void handleManualSave(e)} className="qt-vault-form">
                  <div className="tp-field tp-field--md">
                    <input
                      type="text"
                      className="tp-field__input"
                      placeholder="Nombre del perfil..."
                      value={saveLabel}
                      onChange={(e) => setSaveLabel(e.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="tp-btn tp-btn--md tp-btn--primary"
                    disabled={saving}
                  >
                    {saving ? 'Guardando...' : 'Guardar sesión'}
                  </button>
                </form>
              )}
              <button
                type="button"
                className="qt-text-link"
                onClick={() => onOpenSettings(selectedProvider)}
              >
                <span>Administrar bóveda en Configuración</span>
                <ArrowRightIcon size={11} />
              </button>
            </div>
          ) : (
            <div className="qt-vault-list scroll-quiet">
              {savedAccounts.map((acc) => {
                const isCurrentActive = acc.isActive;
                const isSwitching = switchingAccountId === acc.id;
                const isEditing = editingId === acc.id;
                const health = resolveCredentialHealthBadge(acc);

                return (
                  <div
                    key={acc.id}
                    className={`qt-vault-row${isCurrentActive ? ' qt-vault-row--active' : ''}`}
                  >
                    <div className="qt-vault-row__info">
                      {isEditing ? (
                        <form
                          onSubmit={(e) => void handleCommitRename(acc.id, e)}
                          className="qt-vault-form"
                        >
                          <div className="tp-field">
                            <input
                              type="text"
                              className="tp-field__input"
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
                            />
                          </div>
                          <button
                            type="submit"
                            className="tp-btn tp-btn--sm tp-btn--primary"
                            disabled={renamingId === acc.id}
                          >
                            Guardar
                          </button>
                        </form>
                      ) : (
                        <div className="qt-vault-row__head">
                          <span className="qt-vault-row__name">{acc.label || acc.email}</span>
                          {isCurrentActive && (
                            <span className="tp-pill tp-pill--chip tp-pill--accent">Activa</span>
                          )}
                          {health && (
                            <span
                              className={`tp-pill tp-pill--chip ${
                                health.tone === 'ok' ? 'tp-pill--success' : 'tp-pill--danger'
                              }`}
                            >
                              {health.label}
                            </span>
                          )}
                          {isCurrentActive && authModeLabel && (
                            <span className="tp-pill tp-pill--chip">{authModeLabel}</span>
                          )}
                        </div>
                      )}
                      {acc.email && acc.label && acc.email !== acc.label && (
                        <span className="qt-vault-row__email">{acc.email}</span>
                      )}
                    </div>

                    <div className="qt-vault-row__actions">
                      {onRenameProfile && !isEditing && (
                        <button
                          type="button"
                          className="tp-icon-btn"
                          aria-label={`Renombrar perfil ${acc.label}`}
                          title="Renombrar perfil"
                          onClick={() => {
                            setEditingId(acc.id);
                            setEditingLabel(acc.label);
                          }}
                        >
                          <PencilIcon size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`tp-btn tp-btn--sm ${
                          isCurrentActive ? 'tp-btn--ghost' : 'tp-btn--secondary'
                        }`}
                        disabled={isCurrentActive || isSwitching || Boolean(switchingAccountId)}
                        onClick={() => void onSwitchAccount(acc.id)}
                      >
                        {isSwitching ? 'Cambiando y verificando...' : isCurrentActive ? 'En uso' : 'Usar'}
                      </button>
                    </div>
                  </div>
                );
              })}

              {onSaveCurrent && showSaveRow && (
                <form onSubmit={(e) => void handleManualSave(e)} className="qt-vault-form">
                  <div className="tp-field tp-field--md">
                    <input
                      type="text"
                      className="tp-field__input"
                      placeholder="Nombre del perfil..."
                      value={saveLabel}
                      onChange={(e) => setSaveLabel(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <button
                    type="submit"
                    className="tp-btn tp-btn--md tp-btn--primary"
                    disabled={saving}
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                </form>
              )}

              <div className="qt-vault-footer">
                {onSaveCurrent ? (
                  <button
                    type="button"
                    className="qt-text-link"
                    onClick={() => setShowSaveRow((prev) => !prev)}
                  >
                    {showSaveRow ? 'Cancelar' : '+ Guardar sesión actual'}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="qt-text-link qt-text-link--muted"
                  onClick={() => onOpenSettings(selectedProvider)}
                >
                  <span>Bóveda completa en Ajustes</span>
                  <ChevronRightIcon size={11} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};
