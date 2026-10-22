import React, { useState, useEffect } from 'react';
import type { SavedAccountProfile } from '../../types';
import {
  listSavedAccounts,
  saveCurrentAccountProfile,
  switchAccountProfile,
  deleteAccountProfile,
} from '../../lib/ipc';
import { usePresence } from '../../motion/usePresence';
import { motionSurfaceClass } from '../../motion/surface';

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

  const fetchProfiles = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await listSavedAccounts(provider);
      setProfiles(data);
    } catch (err: any) {
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
    }
  }, [isOpen, provider]);

  const handleSwitch = async (id: string) => {
    if (switchingId) return;
    setSwitchingId(id);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await switchAccountProfile(provider, id);
      if (res.success && res.profile) {
        setSuccessMsg(`Sesión cambiada a: ${res.profile.label}`);
        await fetchProfiles();
        if (onAccountSwitched) {
          onAccountSwitched(res.profile);
        }
      } else {
        setErrorMsg(res.error || 'No se pudo cambiar la sesión.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error al cambiar cuenta');
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
        setSuccessMsg(`Sesión actual guardada como "${res.profile.label}"`);
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
    if (!window.confirm('¿Seguro que deseas eliminar este perfil guardado?')) return;
    try {
      await deleteAccountProfile(provider, id);
      await fetchProfiles();
    } catch (err: any) {
      setErrorMsg('Error al eliminar la cuenta');
    }
  };

  const layerPresence = usePresence(isOpen);
  if (!layerPresence.mounted) return null;

  const scrimMotion = motionSurfaceClass(layerPresence.phase, 'scrim');
  const panelMotion = motionSurfaceClass(layerPresence.phase, 'modal');

  return (
    <div
      className={scrimMotion || undefined}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10005,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        className={panelMotion || undefined}
        style={{
          width: '100%',
          maxWidth: '480px',
          backgroundColor: '#18181b',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '14px',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.05)',
          color: '#f4f4f5',
          fontSize: '13px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
              Cuentas de {providerLabel}
            </h3>
            <p style={{ margin: '2px 0 0', color: '#a1a1aa', fontSize: '12px' }}>
              Cambia rápidamente de cuenta sin cerrar sesión ni volver al navegador.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#a1a1aa',
              cursor: 'pointer',
              fontSize: '18px',
              padding: '4px',
              borderRadius: '4px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {errorMsg && (
            <div style={{ padding: '8px 12px', borderRadius: '6px', backgroundColor: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '12px' }}>
              {errorMsg}
            </div>
          )}

          {successMsg && (
            <div style={{ padding: '8px 12px', borderRadius: '6px', backgroundColor: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', color: '#6ee7b7', fontSize: '12px' }}>
              {successMsg}
            </div>
          )}

          {/* Accounts List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: '#a1a1aa' }}>
                Cargando perfiles...
              </div>
            ) : profiles.length === 0 ? (
              <div
                style={{
                  padding: '24px 16px',
                  textAlign: 'center',
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: '10px',
                  border: '1px dashed rgba(255, 255, 255, 0.1)',
                  color: '#a1a1aa',
                }}
              >
                <p style={{ margin: '0 0 8px', fontSize: '13px', color: '#e4e4e7' }}>
                  No tienes cuentas guardadas en la bóveda todavía.
                </p>
                <p style={{ margin: 0, fontSize: '12px' }}>
                  Guarda la sesión actual con la que estás trabajando para empezar a rotar cuentas en 1 clic.
                </p>
              </div>
            ) : (
              profiles.map((prof) => {
                const isCurrent = prof.isActive;
                const isSwitching = switchingId === prof.id;
                const remPct = prof.primaryRemainingPercent !== null && prof.primaryRemainingPercent !== undefined
                  ? Math.round(prof.primaryRemainingPercent)
                  : null;

                return (
                  <div
                    key={prof.id}
                    onClick={() => !isCurrent && handleSwitch(prof.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      borderRadius: '10px',
                      border: isCurrent
                        ? '1px solid rgba(16, 185, 129, 0.6)'
                        : '1px solid rgba(255, 255, 255, 0.08)',
                      backgroundColor: isCurrent
                        ? 'rgba(16, 185, 129, 0.1)'
                        : 'rgba(255, 255, 255, 0.03)',
                      cursor: isCurrent ? 'default' : 'pointer',
                      transition: 'all 120ms ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: isCurrent ? '#10b981' : '#71717a',
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 600, color: isCurrent ? '#34d399' : '#f4f4f5' }}>
                            {prof.label}
                          </span>
                          {isCurrent && (
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 600,
                                padding: '1px 5px',
                                borderRadius: '4px',
                                backgroundColor: 'rgba(16, 185, 129, 0.25)',
                                color: '#6ee7b7',
                              }}
                            >
                              Activa
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {prof.email && <span>{prof.email}</span>}
                          {prof.planName && <span>• {prof.planName}</span>}
                        </div>
                      </div>
                    </div>

                    {/* Right side: Quota & Actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, marginLeft: '12px' }}>
                      {remPct !== null && (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                          <span
                            style={{
                              fontSize: '12px',
                              fontWeight: 600,
                              color: remPct >= 50 ? '#10b981' : remPct >= 20 ? '#f59e0b' : '#ef4444',
                            }}
                          >
                            {remPct}%
                          </span>
                          <span style={{ fontSize: '10px', color: '#71717a' }}>
                            disponible
                          </span>
                        </div>
                      )}

                      {!isCurrent ? (
                        <button
                          type="button"
                          disabled={isSwitching}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSwitch(prof.id);
                          }}
                          style={{
                            padding: '5px 12px',
                            borderRadius: '6px',
                            backgroundColor: 'rgba(255, 255, 255, 0.08)',
                            color: '#e4e4e7',
                            border: 'none',
                            fontSize: '11px',
                            fontWeight: 500,
                            cursor: 'pointer',
                          }}
                        >
                          {isSwitching ? 'Cambiando...' : 'Activar'}
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={(e) => handleDelete(prof.id, e)}
                        title="Eliminar perfil"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#71717a',
                          padding: '4px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          borderRadius: '4px',
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Add form */}
          {showAddForm ? (
            <div
              style={{
                marginTop: '8px',
                padding: '14px',
                borderRadius: '10px',
                backgroundColor: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#e4e4e7' }}>
                Guardar sesión actual de {providerLabel}
              </div>
              <p style={{ margin: 0, fontSize: '11px', color: '#a1a1aa' }}>
                Captura las credenciales de la cuenta que está actualmente activa en tu equipo y la guarda en la bóveda local.
              </p>
              <input
                type="text"
                placeholder="Nombre o etiqueta (ej. Google Pro Personal)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  backgroundColor: '#09090b',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  color: '#f4f4f5',
                  fontSize: '12px',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    background: 'none',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    color: '#a1a1aa',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={handleSaveCurrent}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '6px',
                    backgroundColor: '#10b981',
                    color: '#09090b',
                    fontWeight: 600,
                    border: 'none',
                    fontSize: '11px',
                    cursor: isSaving ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isSaving ? 'Guardando...' : 'Guardar sesión actual'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              style={{
                marginTop: '4px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px dashed rgba(255, 255, 255, 0.2)',
                backgroundColor: 'transparent',
                color: '#60a5fa',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                transition: 'all 120ms ease',
              }}
            >
              <span>+ Guardar sesión actual como nueva cuenta</span>
            </button>
          )}
        </div>

        {/* Footer with Antigravity Login Instructions */}
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(0, 0, 0, 0.25)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '8px',
              backgroundColor: 'rgba(59, 130, 246, 0.08)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              fontSize: '11px',
              color: '#93c5fd',
              lineHeight: 1.5,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>ℹ️</span>
              <span>¿Cómo agregar una cuenta adicional de Antigravity?</span>
            </div>
            <p style={{ margin: '0 0 6px', color: '#bfdbfe' }}>
              Antigravity no tiene un comando de terminal como <code>agy login</code>. La autenticación oficial de Google se realiza a través de su aplicación:
            </p>
            <ol style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <li>Abre <strong>Antigravity IDE</strong> (la aplicación de escritorio).</li>
              <li>En la esquina inferior izquierda, haz clic en el icono de <strong>Cuentas</strong> e inicia sesión con tu otra cuenta de Google AI Pro en el navegador.</li>
              <li>Cierra Antigravity para liberar los archivos de sesión.</li>
              <li>Vuelve aquí y pulsa <strong>"+ Guardar sesión actual como nueva cuenta"</strong>.</li>
            </ol>
            <p style={{ margin: '6px 0 0', color: '#93c5fd', fontStyle: 'italic' }}>
              ¡Solo debes hacer este inicio de sesión en el navegador una única vez por cuenta! Luego rotarás entre ellas en 1 clic desde Kite.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '11px', color: '#71717a' }}>
              Seguro & Nativo • Sin proxies externos
            </span>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                color: '#f4f4f5',
                border: 'none',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
