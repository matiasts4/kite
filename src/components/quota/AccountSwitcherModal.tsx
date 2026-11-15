import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import '../views/settings/quotas-tab.css';
import type { SavedAccountProfile } from '../../types';
import {
  guidedLoginCoordinator,
  isSameAccountProvider,
  useGuidedLoginState,
} from '../../lib/accounts/guidedLoginCoordinator';
import {
  canonicalVaultProvider,
  formatSplitBrainDetail,
  isSplitBrainActive,
  quotaKeyForProvider,
} from '../../lib/accounts/accountVaultStore';
import { useAccountVault } from '../../lib/accounts/useAccountVault';
import { subscriptionQuotaManager } from '../../lib/quota/quotaManager';
import type { ProviderQuotaStatus } from '../../lib/quota/types';
import {
  AccountConfirmDialogs,
  AccountSwitchErrorActions,
  GuidedLoginErrorActions,
  PencilIcon,
  RefreshSmallIcon,
  resolveAuthModeLabel,
  resolveCredentialHealthBadge,
} from '../accounts/AccountVaultUI';
import { AutoSwitchSettingsPanel } from '../accounts/AutoSwitchSettingsPanel';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { springs, tweens } from '../../motion/standard/tokens';
import { BrandLogo } from '../ui/BrandLogo';
import { XIcon } from '../views/settings/icons';

export interface AccountSwitcherModalProps {
  provider: string;
  providerLabel: string;
  isOpen: boolean;
  onClose: () => void;
  onAccountSwitched?: (profile: SavedAccountProfile) => void;
}

export const AccountSwitcherModal: React.FC<AccountSwitcherModalProps> = ({
  provider,
  providerLabel,
  isOpen,
  onClose,
  onAccountSwitched,
}) => {
  const [newLabel, setNewLabel] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [liveQuotas, setLiveQuotas] = useState<Record<string, ProviderQuotaStatus>>(() =>
    typeof subscriptionQuotaManager?.getAllQuotas === 'function'
      ? subscriptionQuotaManager.getAllQuotas()
      : {}
  );

  const vault = useAccountVault(provider, { autoLoad: isOpen });
  const loginState = useGuidedLoginState(isOpen);
  const matchesLoginProvider = isSameAccountProvider(loginState.provider, provider);
  const isConnectingNew =
    matchesLoginProvider &&
    (loginState.phase === 'preparing' ||
      loginState.phase === 'waiting' ||
      loginState.phase === 'saving');

  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!isOpen) return;
    setShowAddForm(false);
    setNewLabel('');
    setEditingId(null);
    setEditingLabel('');
    vault.clearFeedback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, provider]);

  useEffect(() => {
    if (!isOpen || typeof subscriptionQuotaManager?.subscribe !== 'function') return;
    return subscriptionQuotaManager.subscribe((data) => setLiveQuotas(data));
  }, [isOpen]);

  const hasSubDialogOpen = Boolean(
    vault.deleteConfirmProfile || vault.busyConfirm || vault.overwritePrompt
  );

  const handleSwitch = async (id: string) => {
    const res = await vault.switchAccount(id);
    if (res.success && res.profile) {
      onAccountSwitched?.(res.profile);
    }
  };

  const handleCloseResidualProcesses = async () => {
    const res = await vault.closeResidualProcesses();
    if (res.success && res.profile) {
      onAccountSwitched?.(res.profile);
    }
    return res;
  };

  const handleSaveCurrent = async (overrideLabel?: string) => {
    const res = await vault.saveCurrentAccount(
      overrideLabel ?? newLabel,
      { source: overrideLabel ? 'unregistered' : 'manual' }
    );
    if (res.success) {
      setNewLabel('');
      setShowAddForm(false);
    }
  };

  const handleConnectNewAccount = async () => {
    if (isConnectingNew) return;
    vault.clearFeedback();
    await guidedLoginCoordinator.start(provider);
  };

  const handleStartRename = (prof: SavedAccountProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(prof.id);
    setEditingLabel(prof.label);
  };

  const handleCommitRename = async (accountId: string) => {
    const res = await vault.renameProfile(accountId, editingLabel);
    if (res.success) {
      setEditingId(null);
      setEditingLabel('');
    }
  };

  const handleRefreshActiveQuota = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshingQuota) return;
    setRefreshingQuota(true);
    try {
      await vault.refreshQuota();
    } finally {
      setRefreshingQuota(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !hasSubDialogOpen) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  useEffect(() => {
    if (!isOpen || hasSubDialogOpen) return;
    const handleWindowKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleWindowKey, true);
    return () => window.removeEventListener('keydown', handleWindowKey, true);
  }, [isOpen, hasSubDialogOpen, onClose]);

  if (!isOpen) return null;

  const canon = canonicalVaultProvider(provider);
  const activeLiveQuota = liveQuotas[quotaKeyForProvider(canon)];
  const authModeLabel = canon === 'antigravity' ? resolveAuthModeLabel(vault.authTelemetry) : null;
  const splitBrain = canon === 'antigravity' && isSplitBrainActive(vault.authTelemetry);
  const splitBrainDetail = splitBrain ? formatSplitBrainDetail(vault.authTelemetry) : null;

  const content = (
    <motion.div
      key="account-switcher-scrim"
      {...surfaceMotion('scrim')}
      transition={tweens.overlay}
      className="qt-modal-scrim"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <motion.div
        key="account-switcher-dialog"
        {...surfaceMotion('dialog')}
        transition={springs.dialog}
        className="qt-modal-container qt-modal-container--compact"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={{ borderRadius: 'var(--dialog-radius, 14px)' }}
      >
        {/* Header */}
        <header className="qt-modal-header">
          <div className="qt-modal-header__brand">
            <span className="qt-modal-icon-badge" aria-hidden="true">
              <BrandLogo engine={provider} size={22} />
            </span>
            <div>
              <h2 id={titleId} className="qt-modal-title">
                Cuentas de {providerLabel}
              </h2>
              <p id={descId} className="qt-modal-desc">
                Cambia rápidamente de cuenta sin cerrar sesión ni volver al navegador.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="qt-modal-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <XIcon size={14} />
          </button>
        </header>

        {/* Content Body */}
        <div className="qt-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {vault.error ? (
            <div
              className="qt-banner"
              data-tone="error"
              role="alert"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}
            >
              <span>{vault.error}</span>
              <AccountSwitchErrorActions
                lastFailedSwitch={vault.lastFailedSwitch}
                closingProcesses={vault.closingProcesses}
                onCloseResidualProcesses={handleCloseResidualProcesses}
                onReauth={() => void handleConnectNewAccount()}
                onRetry={handleSwitch}
              />
            </div>
          ) : null}

          {vault.notice ? (
            <div className="qt-banner" data-tone="ok">
              {vault.notice}
            </div>
          ) : null}

          {splitBrain ? (
            <div className="qt-account__split-box">
              <span>{splitBrainDetail || 'El IDE apunta a otra cuenta.'}</span>
              <button
                type="button"
                className="qt-button"
                disabled={Boolean(vault.switchingId)}
                onClick={async () => {
                  await vault.alignIde();
                  const nextActive = vault.profiles.find((p) => p.isActive);
                  if (nextActive) onAccountSwitched?.(nextActive);
                }}
              >
                Alinear IDE
              </button>
            </div>
          ) : null}

          {matchesLoginProvider && loginState.phase === 'waiting' ? (
            <div
              className="qt-banner"
              data-tone={loginState.timedOut ? 'warn' : 'ok'}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}
            >
              <div>
                <div>
                  {loginState.timedOut
                    ? loginState.notice
                    : `Esperando inicio de sesión (${loginState.loginCommand || 'agy acp --login'})...`}
                </div>
                {!loginState.timedOut && loginState.notice ? (
                  <div style={{ fontSize: '11px', opacity: 0.85, marginTop: '2px' }}>{loginState.notice}</div>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                {loginState.timedOut ? (
                  <button
                    type="button"
                    className="qt-button qt-button--primary"
                    onClick={() => void guidedLoginCoordinator.retryWaiting()}
                  >
                    Reintentar
                  </button>
                ) : null}
                <button
                  type="button"
                  className="qt-button"
                  onClick={() => void guidedLoginCoordinator.cancelAndRestore()}
                >
                  Cancelar y restaurar
                </button>
              </div>
            </div>
          ) : null}

          {matchesLoginProvider && (loginState.phase === 'done' || loginState.phase === 'cancelled') && loginState.notice ? (
            <div className="qt-banner" data-tone="ok">
              {loginState.notice}
            </div>
          ) : null}

          {matchesLoginProvider && loginState.phase === 'error' && loginState.error ? (
            <div
              className="qt-banner"
              data-tone="error"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}
            >
              <span>{loginState.error}</span>
              <GuidedLoginErrorActions
                canCloseProcesses={loginState.canCloseProcesses}
                closingProcesses={loginState.closingProcesses}
                canForceStart={loginState.canForceStart}
                onCloseResidualProcesses={() => guidedLoginCoordinator.closeResidualProcessesAndRetry(provider)}
                onForceStart={() => guidedLoginCoordinator.start(provider, { force: true })}
              />
            </div>
          ) : null}

          {/* Unregistered live session banner */}
          {vault.unregisteredLiveSession ? (
            <div
              className="qt-banner"
              data-tone="warn"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                padding: '10px 12px',
                borderRadius: 'var(--card-radius)',
              }}
            >
              <div>
                <strong style={{ fontSize: '12px' }}>Sesión activa no guardada:</strong>{' '}
                <code style={{ fontSize: '12px' }}>{vault.unregisteredLiveSession.email}</code>
                <div style={{ fontSize: '11px', opacity: 0.85, marginTop: '2px' }}>
                  Esta cuenta está en uso en tu sistema pero aún no está registrada en la bóveda.
                </div>
              </div>
              <button
                type="button"
                className="qt-button qt-button--primary"
                style={{ height: '28px', whiteSpace: 'nowrap' }}
                disabled={vault.saving}
                onClick={() => void handleSaveCurrent(vault.unregisteredLiveSession!.email)}
              >
                Guardar en bóveda
              </button>
            </div>
          ) : null}

          {/* Accounts List */}
          <div className="qt-accounts-modal-list">
            {vault.loading && vault.profiles.length === 0 ? (
              <div className="qt-empty" style={{ padding: '24px 0' }}>
                Cargando perfiles guardados…
              </div>
            ) : vault.profiles.length === 0 ? (
              <div className="qt-empty">
                <strong>No tienes cuentas guardadas en la bóveda todavía</strong>
                <span>
                  Guarda la sesión con la que estás trabajando en tu equipo para alternar cuentas en 1 clic.
                </span>
              </div>
            ) : (
              vault.profiles.map((prof) => {
                const isCurrent = prof.isActive;
                const isSwitching = vault.switchingId === prof.id;
                const isEditing = editingId === prof.id;
                const health = resolveCredentialHealthBadge(prof);
                const livePct =
                  isCurrent && activeLiveQuota?.isAvailable && activeLiveQuota.primaryRemainingPercent != null
                    ? Math.round(activeLiveQuota.primaryRemainingPercent)
                    : null;
                const remPct =
                  livePct !== null
                    ? livePct
                    : prof.primaryRemainingPercent !== null && prof.primaryRemainingPercent !== undefined
                    ? Math.round(prof.primaryRemainingPercent)
                    : null;

                return (
                  <div
                    key={prof.id}
                    className="qt-account-row"
                    data-active={isCurrent ? '' : undefined}
                    onClick={() => !isCurrent && !isEditing && !vault.switchingId && void handleSwitch(prof.id)}
                  >
                    <div className="qt-account-row__main">
                      <div className="qt-account-row__avatar-container">
                        <span className="qt-account-row__avatar" aria-hidden="true">
                          {(prof.label || '?').trim().charAt(0).toUpperCase()}
                        </span>
                        <div className="qt-account-row__logo-badge">
                          <BrandLogo engine={provider} size={14} />
                        </div>
                      </div>

                      <div className="qt-account-row__details">
                        {isEditing ? (
                          <form
                            className="qt-account__rename-row"
                            onClick={(e) => e.stopPropagation()}
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleCommitRename(prof.id);
                            }}
                          >
                            <input
                              type="text"
                              className="qt-input qt-input--md"
                              aria-label={`Nuevo nombre para ${prof.label}`}
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
                            <button
                              type="submit"
                              className="qt-button qt-button--primary"
                              disabled={vault.renamingId === prof.id}
                            >
                              Guardar
                            </button>
                            <button
                              type="button"
                              className="qt-button"
                              onClick={() => setEditingId(null)}
                            >
                              Cancelar
                            </button>
                          </form>
                        ) : (
                          <div className="qt-account-row__name-line">
                            <span className="qt-account-row__label">{prof.label}</span>
                            {isCurrent ? (
                              <span className="qt-chip" data-tone="ok">
                                Activa
                              </span>
                            ) : null}
                            {health ? (
                              <span className="qt-chip" data-tone={health.tone}>
                                {health.label}
                              </span>
                            ) : null}
                            {isCurrent && authModeLabel ? (
                              <span className="qt-chip" data-tone="info">
                                {authModeLabel}
                              </span>
                            ) : null}
                            {isCurrent && splitBrain ? (
                              <span className="qt-chip" data-tone="warn">
                                IDE desincronizada
                              </span>
                            ) : null}
                          </div>
                        )}
                        <div className="qt-account-row__sub-line">
                          {prof.email ? <span>{prof.email}</span> : <span>Sin correo detectado</span>}
                          {prof.planName ? <span>· {prof.planName}</span> : null}
                        </div>
                      </div>
                    </div>

                    <div className="qt-account-row__actions">
                      {remPct !== null ? (
                        <div className="qt-account-row__quota-info">
                          <span
                            className="qt-account-row__pct"
                            data-tone={remPct >= 45 ? 'ok' : remPct >= 20 ? 'warn' : 'low'}
                          >
                            {remPct}%
                          </span>
                          <span className="qt-hint">disponible</span>
                        </div>
                      ) : null}

                      {isCurrent ? (
                        <button
                          type="button"
                          className="qt-icon-button"
                          disabled={refreshingQuota}
                          onClick={(e) => void handleRefreshActiveQuota(e)}
                          title="Actualizar cuota en vivo"
                          aria-label="Actualizar cuota"
                        >
                          <RefreshSmallIcon size={12} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="qt-button"
                          disabled={isSwitching || Boolean(vault.switchingId)}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleSwitch(prof.id);
                          }}
                        >
                          {isSwitching ? 'Cambiando y verificando...' : 'Activar'}
                        </button>
                      )}

                      <button
                        type="button"
                        className="qt-icon-button"
                        onClick={(e) => handleStartRename(prof, e)}
                        title="Renombrar perfil"
                        aria-label={`Renombrar perfil ${prof.label}`}
                      >
                        <PencilIcon size={12} />
                      </button>

                      <button
                        type="button"
                        className="qt-icon-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          vault.requestDeleteProfile(prof);
                        }}
                        title="Eliminar de la bóveda"
                        aria-label="Eliminar cuenta"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <AutoSwitchSettingsPanel
            variant="compact"
            provider={provider}
            profiles={vault.profiles}
            policy={vault.autoSwitchPolicy}
            status={vault.autoSwitchRuntimeStatus}
            pendingConfirmations={vault.pendingAutoSwitchConfirmations}
            saving={vault.autoSwitchSaving}
            resuming={vault.autoSwitchResuming}
            closingProcesses={vault.closingProcesses}
            onUpdatePolicy={vault.updateAutoSwitchPolicy}
            onToggleAccountEligibility={vault.toggleAccountAutoSwitchEligibility}
            onMoveAccountPriority={vault.moveAccountAutoSwitchPriority}
            onResume={vault.resumeAutoSwitch}
            onCloseResidualProcesses={async () => {
              const res = await vault.closeResidualProcesses();
              if (res?.success && vault.autoSwitchRuntimeStatus.paused) {
                await vault.resumeAutoSwitch();
              }
            }}
            onConfirmPending={(item, selectedModelId) =>
              vault.confirmPendingAutoSwitch({
                confirmationId: item.confirmationId,
                ...(selectedModelId ? { selectedModelId } : {}),
                ...(item.reason === 'busy_terminals_ask' ? { forceBusy: true } : {}),
              })
            }
            onDismissPending={(confirmationId) =>
              vault.dismissPendingAutoSwitch(confirmationId)
            }
          />

          {/* Snapshot current session form */}
          {showAddForm ? (
            <div className="qt-save-card">
              <div className="qt-save-card__copy">
                <h4>Guardar sesión actual de {providerLabel}</h4>
                <p>
                  Captura las credenciales de la cuenta que está actualmente activa en tu equipo y la guarda en la bóveda local.
                </p>
              </div>
              <input
                type="text"
                className="qt-input qt-input--md"
                placeholder="Nombre o etiqueta (ej. Google Pro Personal, Claude Team)..."
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveCurrent();
                }}
                autoFocus
              />
              <div className="qt-save-card__actions">
                <button
                  type="button"
                  className="qt-button qt-button--md"
                  onClick={() => setShowAddForm(false)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--primary qt-button--md"
                  disabled={vault.saving}
                  onClick={() => void handleSaveCurrent()}
                >
                  {vault.saving ? 'Guardando…' : 'Guardar sesión actual'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="qt-button qt-button--md"
                style={{ whiteSpace: 'nowrap' }}
                disabled={isConnectingNew}
                onClick={() => void handleConnectNewAccount()}
              >
                {isConnectingNew ? 'Preparando...' : '+ Conectar nueva cuenta'}
              </button>
              <button
                type="button"
                className="qt-save-trigger"
                style={{ flex: 1, margin: 0, height: '32px', padding: '0 12px', borderRadius: 'var(--control-radius, 8px)' }}
                onClick={() => setShowAddForm(true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Guardar sesión actual</span>
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="qt-modal-footer">
          <div className="qt-modal-footer__count">
            <span className="qt-hint">
              {vault.profiles.length} cuenta{vault.profiles.length === 1 ? '' : 's'} guardada{vault.profiles.length === 1 ? '' : 's'} en este equipo
            </span>
          </div>
          <div className="qt-modal-footer__actions">
            <button type="button" className="qt-button qt-button--md" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );

  if (typeof document === 'undefined') return null;
  const portalTarget = document.querySelector('.app-frame--scaled') ?? document.body;

  return (
    <>
      {createPortal(
        <AnimatePresence>{isOpen ? content : null}</AnimatePresence>,
        portalTarget
      )}
      <AccountConfirmDialogs
        busyConfirm={vault.busyConfirm}
        deleteConfirmProfile={vault.deleteConfirmProfile}
        overwritePrompt={vault.overwritePrompt}
        saving={vault.saving}
        deletingId={vault.deletingId}
        switchingId={vault.switchingId}
        onConfirmBusy={async () => {
          const res = await vault.confirmBusySwitch();
          if (res?.success && res.profile) {
            onAccountSwitched?.(res.profile);
          }
        }}
        onCancelBusy={vault.cancelBusySwitch}
        onConfirmDelete={vault.confirmDeleteProfile}
        onCancelDelete={vault.cancelDeleteProfile}
        onConfirmOverwriteUpdate={async () => {
          const res = await vault.confirmOverwriteUpdate();
          if (res.success) {
            setNewLabel('');
            setShowAddForm(false);
          }
        }}
        onConfirmOverwriteRename={async () => {
          const res = await vault.confirmOverwriteRename();
          if (res.success) {
            setNewLabel('');
            setShowAddForm(false);
          }
        }}
        onCancelOverwrite={vault.cancelOverwritePrompt}
      />
    </>
  );
};
