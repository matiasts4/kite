import React, { useState, useEffect } from 'react';
import { openSettingsTab } from '../../../lib/settingsNav';
import { listGoogleAccounts, setActiveGoogleAccount } from '../../../lib/ipc';

export interface AccountTabProps {
  accountName?: string;
  accountEmail?: string;
  accountTier?: string;
  accountTierPaid?: boolean;
  creditsLabel?: string | null;
  creditsDetail?: string;
  creditsCycle?: { remaining: number; included: number } | null;
  creditsLevel?: 'ok' | 'low' | 'empty' | null;
  creditsError?: boolean;
  creditsLoading?: boolean;
  signingOut?: boolean;
  onRetryCredits?: () => void;
  onSignOut?: () => void;
  onOpenTerms?: () => void;
  onOpenPrivacy?: () => void;
}

export const AccountTab: React.FC<AccountTabProps> = ({
  accountName = 'Kite User',
  accountEmail = 'local@kite.dev',
}) => {
  const [legalModal, setLegalModal] = useState<'terms' | 'privacy' | null>(null);
  const [googleActive, setGoogleActive] = useState<string | null>(null);
  const [googleAccounts, setGoogleAccounts] = useState<string[]>([]);
  const [isSwitchingGoogle, setIsSwitchingGoogle] = useState(false);
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);
  const avatarLetter = (accountName || 'K').trim().charAt(0).toUpperCase();

  useEffect(() => {
    void loadGoogleState();
  }, []);

  const loadGoogleState = async () => {
    try {
      const data = await listGoogleAccounts();
      if (data) {
        setGoogleActive(data.active);
        setGoogleAccounts(data.accounts || []);
      }
    } catch {
      // Ignora si no hay cuentas disponibles
    }
  };

  const handleSelectGoogleAccount = async (email: string) => {
    if (email === googleActive || isSwitchingGoogle) return;
    setIsSwitchingGoogle(true);
    setGoogleNotice(null);
    try {
      const res = await setActiveGoogleAccount(email);
      if (res.success) {
        setGoogleActive(res.active);
        setGoogleAccounts(res.accounts || []);
        setGoogleNotice(`Cuenta de Antigravity cambiada a ${res.active}`);
        setTimeout(() => setGoogleNotice(null), 3500);
      }
    } catch (err: any) {
      setGoogleNotice(err?.message || 'Error al cambiar cuenta de Google');
    } finally {
      setIsSwitchingGoogle(false);
    }
  };

  return (
    <>
      {/* 1. Sesión y Perfil Local */}
      <section className="settings-group">
        <h2 className="settings-group__title">Perfil del sistema</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row settings-account">
            <span aria-hidden="true" className="settings-account__avatar">
              {avatarLetter}
            </span>
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                <span className="settings-account__name">{accountName}</span>
              </h3>
              <p className="settings-account__email">{accountEmail}</p>
            </div>
            <div className="settings-row__control">
              <button
                className="secondary-button"
                onClick={() => openSettingsTab('quotas')}
                type="button"
                style={{ height: '28px', padding: '0 12px', fontSize: '12px' }}
                title="Gestionar perfiles en la Bóveda de Cuentas"
              >
                Bóveda de Cuentas…
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Conectividad Antigravity ACP & Cuenta Google */}
      <section className="settings-group">
        <h2 className="settings-group__title">Antigravity · Conexión ACP (Google Account)</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                Cuenta Google Activa en Antigravity
              </h3>
              <p className="settings-row__detail">
                {googleActive ? (
                  <>
                    Sesión activa: <strong style={{ color: 'var(--text-primary)' }}>{googleActive}</strong>
                  </>
                ) : (
                  'No se detectó cuenta activa en ~/.gemini/google_accounts.json'
                )}
              </p>
              {googleNotice && (
                <p style={{ marginTop: '4px', fontSize: '11px', color: 'var(--accent-primary, #60a5fa)' }}>
                  {googleNotice}
                </p>
              )}
            </div>

            <div className="settings-row__control" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {googleAccounts.length > 1 && (
                <select
                  className="secondary-button"
                  style={{ height: '28px', padding: '0 8px', fontSize: '12px', background: 'var(--bg-surface)' }}
                  value={googleActive || ''}
                  disabled={isSwitchingGoogle}
                  onChange={(e) => handleSelectGoogleAccount(e.target.value)}
                  title="Seleccionar otra cuenta de Google detectada en el sistema"
                >
                  {googleAccounts.map((acc) => (
                    <option key={acc} value={acc}>
                      {acc} {acc === googleActive ? '✓ (Activa)' : ''}
                    </option>
                  ))}
                </select>
              )}

              <button
                className="secondary-button"
                onClick={() => openSettingsTab('quotas')}
                type="button"
                style={{ height: '28px', padding: '0 12px', fontSize: '12px' }}
                title="Ver cuota en tiempo real y ventanas de límite"
              >
                Ver Cuota & Uso…
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Información Legal y Privacidad Local */}
      <section className="settings-group">
        <h2 className="settings-group__title">Políticas y Privacidad</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Compromiso de Privacidad Local</h3>
              <p className="settings-row__detail">
                Tus credenciales, tokens de IA, historial y código fuente se almacenan exclusivamente en este equipo.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-label="Ver política de privacidad"
                className="secondary-button"
                onClick={() => setLegalModal('privacy')}
                type="button"
                style={{ height: '28px', padding: '0 12px', fontSize: '12px' }}
              >
                Ver detalle
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Términos de Uso</h3>
              <p className="settings-row__detail">
                Uso de software autónomo y responsabilidades en entornos de desarrollo local.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-label="Ver términos de uso"
                className="secondary-button"
                onClick={() => setLegalModal('terms')}
                type="button"
                style={{ height: '28px', padding: '0 12px', fontSize: '12px' }}
              >
                Ver detalle
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Modal Informativo Legal */}
      {legalModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: '20px',
          }}
          onClick={() => setLegalModal(null)}
        >
          <div
            style={{
              backgroundColor: 'var(--menu-glass, #18181b)',
              border: '1px solid var(--block-stroke)',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '520px',
              width: '100%',
              color: 'var(--text-primary)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px' }}>
              {legalModal === 'privacy' ? 'Privacidad y Protección de Datos' : 'Términos de Kite'}
            </h3>
            <div style={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--text-secondary)', marginBottom: '20px' }}>
              {legalModal === 'privacy' ? (
                <p>
                  Kite funciona bajo una arquitectura <strong>Local-First y Zero-Telemetry</strong>.
                  Todas las sesiones de agentes, tokens de acceso y código son gestionados por el binario nativo en tu propio dispositivo.
                  No existe intermediación en la nube para interceptar tus tareas ni recolectar datos de telemetría.
                </p>
              ) : (
                <p>
                  Kite se proporciona para acelerar flujos de trabajo de ingeniería de software y automatización.
                  La responsabilidad de ejecución de comandos en terminales y modificación de archivos recae en el usuario,
                  con confirmación previa requerida para operaciones de riesgo.
                </p>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="ui-button ui-button--primary"
                onClick={() => setLegalModal(null)}
                style={{ height: '28px', padding: '0 16px', fontSize: '12px' }}
              >
                Entendido
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
