import React, { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import '../views/settings/quotas-tab.css';
import type { AntigravityAuthTelemetry, SavedAccountProfile } from '../../types';
import type {
  BusyTerminalConfirmState,
  OverwritePromptState,
} from '../../lib/accounts/accountVaultStore';

export interface CredentialHealthBadge {
  label: string;
  tone: 'ok' | 'error';
  needsReauth: boolean;
}

export function resolveCredentialHealthBadge(
  profile: Pick<SavedAccountProfile, 'credentialStatus' | 'hasRefreshToken'>
): CredentialHealthBadge | null {
  if (profile.credentialStatus === 'valid') {
    return { label: 'Lista', tone: 'ok', needsReauth: false };
  }
  if (profile.credentialStatus && profile.credentialStatus.trim()) {
    return { label: 'Sin token / Reautenticar', tone: 'error', needsReauth: true };
  }
  if (profile.hasRefreshToken === false) {
    return { label: 'Sin token / Reautenticar', tone: 'error', needsReauth: true };
  }
  return null;
}

export function resolveAuthModeLabel(
  telemetry?: AntigravityAuthTelemetry | null
): string | null {
  if (!telemetry) return null;
  if (telemetry.authModeLabel && telemetry.authModeLabel.trim()) {
    return telemetry.authModeLabel.trim();
  }
  if (telemetry.authMode === 'oauth') return 'OAuth CLI';
  if (telemetry.authMode === 'api_key_override') return 'API Key';
  if (telemetry.authMode === 'none') return 'Sin sesión CLI';
  return telemetry.authMode ? String(telemetry.authMode) : null;
}

export const PencilIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const RefreshSmallIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

export interface AccountConfirmDialogsProps {
  busyConfirm: BusyTerminalConfirmState | null;
  deleteConfirmProfile: SavedAccountProfile | null;
  overwritePrompt: OverwritePromptState | null;
  saving?: boolean;
  deletingId?: string | null;
  switchingId?: string | null;
  onConfirmBusy: () => void | Promise<unknown>;
  onCancelBusy: () => void;
  onConfirmDelete: () => void | Promise<unknown>;
  onCancelDelete: () => void;
  onConfirmOverwriteUpdate: () => void | Promise<unknown>;
  onConfirmOverwriteRename: () => void | Promise<unknown>;
  onCancelOverwrite: () => void;
}

export const AccountConfirmDialogs: React.FC<AccountConfirmDialogsProps> = ({
  busyConfirm,
  deleteConfirmProfile,
  overwritePrompt,
  saving = false,
  deletingId = null,
  switchingId = null,
  onConfirmBusy,
  onCancelBusy,
  onConfirmDelete,
  onCancelDelete,
  onConfirmOverwriteUpdate,
  onConfirmOverwriteRename,
  onCancelOverwrite,
}) => {
  const titleId = useId();
  const descId = useId();
  const activeKind = deleteConfirmProfile
    ? 'delete'
    : busyConfirm
    ? 'busy'
    : overwritePrompt
    ? 'overwrite'
    : null;

  useEffect(() => {
    if (!activeKind) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (activeKind === 'delete') onCancelDelete();
      else if (activeKind === 'busy') onCancelBusy();
      else onCancelOverwrite();
    };
    window.addEventListener('keydown', handleEsc, true);
    return () => window.removeEventListener('keydown', handleEsc, true);
  }, [activeKind, onCancelBusy, onCancelDelete, onCancelOverwrite]);

  if (!activeKind || typeof document === 'undefined') return null;

  const portalTarget = document.querySelector('.app-frame--scaled') ?? document.body;

  const closeCurrent = () => {
    if (activeKind === 'delete') onCancelDelete();
    else if (activeKind === 'busy') onCancelBusy();
    else onCancelOverwrite();
  };

  return createPortal(
    <div
      className="qt-modal-scrim qt-modal-scrim--top"
      onClick={(e) => {
        e.stopPropagation();
        closeCurrent();
      }}
    >
      <div
        className="qt-modal-container qt-modal-container--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
        style={{ borderRadius: 'var(--dialog-radius, 14px)' }}
      >
        {activeKind === 'delete' && deleteConfirmProfile && (
          <>
            <header className="qt-modal-header">
              <div>
                <h3 id={titleId} className="qt-modal-title">
                  Eliminar perfil guardado
                </h3>
                <p id={descId} className="qt-modal-desc">
                  Esta acción solo quita el registro guardado en tu bóveda local.
                </p>
              </div>
            </header>
            <div className="qt-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text-primary)' }}>
                ¿Seguro que deseas eliminar el perfil <strong>«{deleteConfirmProfile.label}»</strong>
                {deleteConfirmProfile.email ? ` (${deleteConfirmProfile.email})` : ''} de la bóveda?
              </p>
              <p style={{ margin: 0, fontSize: '11.5px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Solo se elimina la instantánea de credenciales guardada. No se cerrarán tus sesiones activas ni se detendrán tus terminales abiertas.
              </p>
            </div>
            <footer className="qt-modal-footer">
              <div />
              <div className="qt-modal-dialog-actions">
                <button
                  type="button"
                  className="qt-button qt-button--md"
                  onClick={onCancelDelete}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--md qt-button--danger"
                  disabled={deletingId === deleteConfirmProfile.id}
                  onClick={() => void onConfirmDelete()}
                >
                  {deletingId === deleteConfirmProfile.id ? 'Eliminando…' : 'Eliminar perfil'}
                </button>
              </div>
            </footer>
          </>
        )}

        {activeKind === 'busy' && busyConfirm && (
          <>
            <header className="qt-modal-header">
              <div>
                <h3 id={titleId} className="qt-modal-title">
                  Confirmar cambio con sesiones activas
                </h3>
                <p id={descId} className="qt-modal-desc">
                  Hay agentes ejecutándose en este momento que se verán afectados al cambiar a «{busyConfirm.label}».
                </p>
              </div>
            </header>
            <div className="qt-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div className="qt-busy-list">
                {busyConfirm.busySessions.length > 0 ? (
                  busyConfirm.busySessions.slice(0, 6).map((sess, idx) => (
                    <div key={sess.sessionId || idx} className="qt-busy-item">
                      <span>{sess.cwd || sess.engine || sess.sessionId || 'Sesión activa'}</span>
                      <span className="qt-chip" data-tone="warn">
                        {sess.reasons?.[0] || (sess.busy ? 'Ocupada' : 'Activa')}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="qt-busy-item">
                    <span>Sesiones ocupadas detectadas</span>
                  </div>
                )}
              </div>
              <div className="qt-hint" style={{ lineHeight: 1.45 }}>
                {busyConfirm.managedIdleCount > 0
                  ? `${busyConfirm.managedIdleCount} terminal${busyConfirm.managedIdleCount === 1 ? '' : 'es'} en reposo se actualizarán automáticamente. `
                  : ''}
                {busyConfirm.unaffectedTerminalsCount > 0
                  ? `${busyConfirm.unaffectedTerminalsCount} terminal${busyConfirm.unaffectedTerminalsCount === 1 ? '' : 'es'} de otro tipo permanecerán intactas.`
                  : ''}
              </div>
            </div>
            <footer className="qt-modal-footer">
              <div />
              <div className="qt-modal-dialog-actions">
                <button
                  type="button"
                  className="qt-button qt-button--md"
                  onClick={onCancelBusy}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--md qt-button--primary"
                  disabled={!!switchingId}
                  onClick={() => void onConfirmBusy()}
                >
                  {switchingId ? 'Cambiando…' : 'Cambiar de todas formas'}
                </button>
              </div>
            </footer>
          </>
        )}

        {activeKind === 'overwrite' && overwritePrompt && (
          <>
            <header className="qt-modal-header">
              <div>
                <h3 id={titleId} className="qt-modal-title">
                  Esta cuenta ya está guardada
                </h3>
                <p id={descId} className="qt-modal-desc">
                  Esta cuenta ya está guardada como «{overwritePrompt.existingProfile.label}».
                </p>
              </div>
            </header>
            <div className="qt-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ margin: 0, fontSize: '12.5px', lineHeight: 1.5, color: 'var(--text-primary)' }}>
                El correo actual ya pertenece al perfil <strong>«{overwritePrompt.existingProfile.label}»</strong>.
                ¿Deseas actualizar sus credenciales manteniendo ese nombre o renombrarlo a{' '}
                <strong>«{overwritePrompt.pendingLabel}»</strong>?
              </p>
            </div>
            <footer className="qt-modal-footer">
              <div />
              <div className="qt-modal-dialog-actions">
                <button
                  type="button"
                  className="qt-button qt-button--md"
                  onClick={onCancelOverwrite}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--md"
                  disabled={saving}
                  onClick={() => void onConfirmOverwriteRename()}
                >
                  Renombrar perfil
                </button>
                <button
                  type="button"
                  className="qt-button qt-button--md qt-button--primary"
                  disabled={saving}
                  onClick={() => void onConfirmOverwriteUpdate()}
                >
                  Actualizar credenciales
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>,
    portalTarget
  );
};
