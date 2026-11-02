import React, { useState, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import type { SavedAccountProfile } from '../../types';
import {
  listSavedAccounts,
  saveCurrentAccountProfile,
  switchAccountProfile,
  deleteAccountProfile,
} from '../../lib/ipc';
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
  const [profiles, setProfiles] = useState<SavedAccountProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const titleId = useId();
  const descId = useId();

  const fetchProfiles = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await listSavedAccounts(provider);
      setProfiles(data);
    } catch {
      setErrorMsg('Error al cargar las cuentas guardadas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void fetchProfiles();
      setSuccessMsg(null);
      setErrorMsg(null);
      setShowAddForm(false);
      setNewLabel('');
    }
  }, [isOpen, provider]);

  const handleSwitch = async (id: string) => {
    if (switchingId) return;
    setSwitchingId(id);
    setErrorMsg(null);
    setSuccessMsg(null);
    // Optimistically reflect active account immediately for instantaneous visual feedback
    setProfiles((prev) =>
      prev.map((p) => ({
        ...p,
        isActive: p.id === id,
      }))
    );
    try {
      const res = await switchAccountProfile(provider, id);
      if (res.success && res.profile) {
        setSuccessMsg(`Sesión cambiada exitosamente a «${res.profile.label}».`);
        window.dispatchEvent(
          new CustomEvent('kite:terminal-command', {
            detail: { command: 'restart-agent' },
          })
        );
        await fetchProfiles();
        if (onAccountSwitched) {
          onAccountSwitched(res.profile);
        }
      } else {
        setErrorMsg(res.error || 'No se pudo cambiar la sesión.');
        await fetchProfiles();
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error al cambiar cuenta');
      await fetchProfiles();
    } finally {
      setSwitchingId(null);
    }
  };

  const handleSaveCurrent = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const label = newLabel.trim() || `Cuenta ${profiles.length + 1}`;
      const res = await saveCurrentAccountProfile(provider, label);
      if (res.success && res.profile) {
        setSuccessMsg(`Sesión actual guardada como «${res.profile.label}».`);
        setNewLabel('');
        setShowAddForm(false);
        await fetchProfiles();
      } else {
        setErrorMsg(res.error || 'No se pudo guardar la sesión actual.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error al guardar la sesión actual');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('¿Seguro que deseas eliminar este perfil guardado de la bóveda?')) return;
    try {
      await deleteAccountProfile(provider, id);
      await fetchProfiles();
    } catch {
      setErrorMsg('Error al eliminar la cuenta');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  if (!isOpen) return null;

  const content = (
    <motion.div
      key="account-switcher-scrim"
      {...surfaceMotion('scrim')}
      transition={tweens.overlay}
      className="qt-modal-scrim"
      onClick={onClose}
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
          {errorMsg ? (
            <div className="qt-banner" data-tone="error">
              {errorMsg}
            </div>
          ) : null}

          {successMsg ? (
            <div className="qt-banner" data-tone="ok">
              {successMsg}
            </div>
          ) : null}

          {/* Accounts List */}
          <div className="qt-accounts-modal-list">
            {loading ? (
              <div className="qt-empty" style={{ padding: '24px 0' }}>
                Cargando perfiles guardados…
              </div>
            ) : profiles.length === 0 ? (
              <div className="qt-empty">
                <strong>No tienes cuentas guardadas en la bóveda todavía</strong>
                <span>
                  Guarda la sesión con la que estás trabajando en tu equipo para alternar cuentas en 1 clic.
                </span>
              </div>
            ) : (
              profiles.map((prof) => {
                const isCurrent = prof.isActive;
                const isSwitching = switchingId === prof.id;
                const remPct =
                  prof.primaryRemainingPercent !== null && prof.primaryRemainingPercent !== undefined
                    ? Math.round(prof.primaryRemainingPercent)
                    : null;

                return (
                  <div
                    key={prof.id}
                    className="qt-account-row"
                    data-active={isCurrent ? '' : undefined}
                    onClick={() => !isCurrent && handleSwitch(prof.id)}
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
                        <div className="qt-account-row__name-line">
                          <span className="qt-account-row__label">{prof.label}</span>
                          {isCurrent ? (
                            <span className="qt-chip" data-tone="ok">
                              Activa
                            </span>
                          ) : null}
                        </div>
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

                      {!isCurrent ? (
                        <button
                          type="button"
                          className="qt-button"
                          disabled={isSwitching}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSwitch(prof.id);
                          }}
                        >
                          {isSwitching ? 'Cambiando…' : 'Activar'}
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="qt-icon-button"
                        onClick={(e) => handleDelete(prof.id, e)}
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
                className="qt-input"
                placeholder="Nombre o etiqueta (ej. Google Pro Personal, Claude Team)..."
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                autoFocus
              />
              <div className="qt-save-card__actions">
                <button
                  type="button"
                  className="qt-button"
                  onClick={() => setShowAddForm(false)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--primary"
                  disabled={isSaving}
                  onClick={handleSaveCurrent}
                >
                  {isSaving ? 'Guardando…' : 'Guardar sesión actual'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="qt-save-trigger"
              onClick={() => setShowAddForm(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Guardar sesión actual como nueva cuenta en la bóveda</span>
            </button>
          )}
        </div>

        {/* Footer */}
        <footer className="qt-modal-footer">
          <div className="qt-modal-footer__count">
            <span className="qt-hint">
              {profiles.length} cuenta{profiles.length === 1 ? '' : 's'} guardada{profiles.length === 1 ? '' : 's'} en este equipo
            </span>
          </div>
          <div className="qt-modal-footer__actions">
            <button type="button" className="qt-button" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>{isOpen ? content : null}</AnimatePresence>,
    document.querySelector('.app-frame--scaled') ?? document.body
  );
};
