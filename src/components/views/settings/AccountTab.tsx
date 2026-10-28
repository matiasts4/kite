import React, { useState, useEffect } from 'react';
import { openSettingsTab } from '../../../lib/settingsNav';
import {
  listGoogleAccounts,
  setActiveGoogleAccount,
  listDetectedCliAccounts,
  type DetectedCliAccount,
} from '../../../lib/ipc';
import { BrandLogo } from '../../ui/BrandLogo';
import { AccountSwitcherModal } from '../../quota/AccountSwitcherModal';
import { SelectMenu } from '../../ui/SelectMenu';
import { MULTI_ACCOUNT_PROVIDERS } from './AccountVault';
import { CheckIcon, XIcon } from './icons';
import { PrivacyPolicyCard } from './PrivacyPolicyCard';

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
  const [googleActive, setGoogleActive] = useState<string | null>(null);
  const [googleAccounts, setGoogleAccounts] = useState<string[]>([]);
  const [isSwitchingGoogle, setIsSwitchingGoogle] = useState(false);
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);
  const [detectedAccounts, setDetectedAccounts] = useState<DetectedCliAccount[]>([]);
  const [loadingDetected, setLoadingDetected] = useState(false);
  const [switcherProvider, setSwitcherProvider] = useState<{ id: string; label: string } | null>(null);
  const avatarLetter = (accountName || 'K').trim().charAt(0).toUpperCase();

  useEffect(() => {
    void loadGoogleState();
    void loadDetectedAccounts();
  }, []);

  const loadDetectedAccounts = async () => {
    setLoadingDetected(true);
    try {
      const accounts = await listDetectedCliAccounts();
      setDetectedAccounts(accounts);
    } catch (err) {
      console.warn('Error loading detected CLI accounts:', err);
    } finally {
      setLoadingDetected(false);
    }
  };

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
        void loadDetectedAccounts();
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

      {/* 2. Sesiones CLI heredadas en el sistema (Auto-detectadas) */}
      <section className="settings-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
          <div>
            <h2 className="settings-group__title" style={{ margin: 0 }}>
              Sesiones CLI detectadas en el sistema
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
              Kite hereda automáticamente las sesiones y credenciales de tus CLIs locales sin necesidad de iniciar sesión dentro de la app.
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={loadDetectedAccounts}
            disabled={loadingDetected}
            style={{ height: '26px', padding: '0 10px', fontSize: '11px', flexShrink: 0 }}
          >
            {loadingDetected ? 'Detectando…' : 'Re-escanear'}
          </button>
        </div>

        {googleNotice && (
          <div style={{ marginBottom: '10px', padding: '6px 12px', borderRadius: '6px', background: 'rgba(96, 165, 250, 0.1)', color: 'var(--accent-primary, #60a5fa)', fontSize: '12px' }}>
            {googleNotice}
          </div>
        )}

        <div className="ui-card" style={{ display: 'flex', flexDirection: 'column' }}>
          {detectedAccounts.length === 0 && !loadingDetected && (
            <div className="ui-card__row settings-row">
              <p className="settings-row__detail" style={{ color: 'var(--text-secondary)' }}>
                No se han escaneado las sesiones CLI aún. Haz clic en Re-escanear.
              </p>
            </div>
          )}

          {detectedAccounts.map((acc) => {
            const isAuth = acc.authState === 'authenticated';
            const isInstalled = acc.authState !== 'not_installed';

            return (
              <div
                key={acc.provider}
                className="ui-card__row settings-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--block-stroke, rgba(255,255,255,0.06))',
                  gap: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                  <div style={{ width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <BrandLogo engine={acc.provider} size={24} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {acc.displayName}
                      </span>
                      {acc.planName && (
                        <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-muted, rgba(255,255,255,0.08))', color: 'var(--text-secondary)' }}>
                          {acc.planName}
                        </span>
                      )}
                      {isAuth ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px', borderRadius: '4px', fontSize: '11px', fontWeight: 500, background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.3)' }}>
                          <CheckIcon size={11} strokeWidth={2.5} />
                          <span>Sesión activa</span>
                        </span>
                      ) : isInstalled ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px', borderRadius: '4px', fontSize: '11px', fontWeight: 500, background: 'rgba(234, 179, 8, 0.15)', color: '#facc15', border: '1px solid rgba(234, 179, 8, 0.3)' }}>
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#facc15', display: 'inline-block' }} />
                          <span>CLI instalada</span>
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px', borderRadius: '4px', fontSize: '11px', fontWeight: 500, background: 'rgba(148, 163, 184, 0.1)', color: 'var(--text-secondary)', border: '1px solid rgba(148, 163, 184, 0.2)' }}>
                          <XIcon size={11} strokeWidth={2.5} />
                          <span>No instalado</span>
                        </span>
                      )}
                    </div>

                    <p style={{ margin: '3px 0 0', fontSize: '12px', color: isAuth ? 'var(--text-primary)' : 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {acc.accountLabel ? (
                        <strong>{acc.accountLabel}</strong>
                      ) : (
                        <span>Sin sesión activa configurada en la CLI</span>
                      )}
                      {acc.details && (
                        <span style={{ marginLeft: '6px', color: 'var(--text-secondary)', fontSize: '11px' }}>
                          · {acc.details}
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                  {acc.provider === 'antigravity' && googleAccounts.length > 1 && (
                    <SelectMenu
                      label="Cuenta de Google"
                      variant="field"
                      className="settings-select"
                      value={googleActive || googleAccounts[0]}
                      disabled={isSwitchingGoogle}
                      rows={googleAccounts.map((email) => ({
                        id: email,
                        title: email,
                        detail: email === googleActive ? 'Activa' : undefined,
                      }))}
                      triggerLabel={googleActive || googleAccounts[0]}
                      onSelect={(email) => {
                        void handleSelectGoogleAccount(email);
                      }}
                    />
                  )}

                  {MULTI_ACCOUNT_PROVIDERS.some((p) => p.id === acc.provider) && (
                    <button
                      className="secondary-button"
                      onClick={() => setSwitcherProvider({ id: acc.provider, label: acc.displayName })}
                      type="button"
                      style={{ height: '28px', padding: '0 10px', fontSize: '12px' }}
                      title={`Cambiar o gestionar cuentas guardadas de ${acc.displayName}`}
                    >
                      Cuentas…
                    </button>
                  )}

                  <button
                    className="secondary-button"
                    onClick={() => openSettingsTab('quotas')}
                    type="button"
                    style={{ height: '28px', padding: '0 12px', fontSize: '12px' }}
                    title={`Ver cuota y perfiles de ${acc.displayName}`}
                  >
                    Ver Cuota…
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <PrivacyPolicyCard />
      {switcherProvider && (
        <AccountSwitcherModal
          provider={switcherProvider.id}
          providerLabel={switcherProvider.label}
          isOpen={!!switcherProvider}
          onClose={() => setSwitcherProvider(null)}
          onAccountSwitched={() => {
            void loadDetectedAccounts();
          }}
        />
      )}
    </>
  );
};
