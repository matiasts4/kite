import React, { useEffect, useMemo, useState } from 'react';
import './quotas-tab.css';
import { AccountVault } from './AccountVault';
import { BrandLogo } from '../agents/engineMetadata';
import {
  ALL_SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
  type ProviderQuotaStatus,
  type QuotaPreferences,
} from '../../../lib/quota/types';
import {
  QUOTA_PREFS_CHANGED_EVENT,
  readQuotaPreferences,
  saveQuotaPreferences,
  subscriptionQuotaManager,
} from '../../../lib/quota/quotaManager';
import { diagnoseProvider } from '../../../lib/quota/providerState';
import { PROVIDER_CONFIGS_ES } from '../../quota/QuotaSettingsModal';
import { clearOpenCodeCookie, saveOpenCodeCookie } from '../../../lib/ipc';
import { SETTINGS_PROVIDER_STORAGE_KEY } from '../../../lib/settingsNav';

const DISPLAY_MODES: { id: QuotaPreferences['displayMode']; label: string }[] = [
  { id: 'percent_remaining', label: '% restante' },
  { id: 'percent_used', label: '% usado' },
  { id: 'compact', label: 'Compacto' },
];

const toneFor = (pct: number) => (pct >= 45 ? 'ok' : pct >= 20 ? 'warn' : 'low');

const Switch: React.FC<{ checked: boolean; label: string; onChange: () => void }> = ({
  checked,
  label,
  onChange,
}) => (
  <button
    type="button"
    role="switch"
    className="ui-switch"
    aria-checked={checked}
    aria-label={label}
    onClick={onChange}
  >
    <span aria-hidden="true" className="ui-switch__knob" />
  </button>
);

export const QuotasTab: React.FC = () => {
  const [prefs, setPrefs] = useState<QuotaPreferences>(() => readQuotaPreferences());
  const [quotas, setQuotas] = useState<Record<string, ProviderQuotaStatus>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SETTINGS_PROVIDER_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [cookie, setCookie] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [openCodeStatus, setOpenCodeStatus] = useState<string | null>(null);

  useEffect(() => subscriptionQuotaManager.subscribe((data) => setQuotas(data)), []);

  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail) setPrefs(e.detail);
    };
    window.addEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
  }, []);

  useEffect(() => {
    void subscriptionQuotaManager.fetchAll(false).catch(() => undefined);
  }, []);

  const enabledSet = useMemo(
    () => new Set(prefs.enabledProviders || prefs.providerOrder),
    [prefs.enabledProviders, prefs.providerOrder]
  );

  const ordered = useMemo(() => {
    const order = prefs.providerOrder?.length ? prefs.providerOrder : ALL_SUPPORTED_PROVIDERS;
    const known = order.filter((id) => ALL_SUPPORTED_PROVIDERS.includes(id));
    const missing = ALL_SUPPORTED_PROVIDERS.filter((id) => !known.includes(id));
    return [...known, ...missing];
  }, [prefs.providerOrder]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await subscriptionQuotaManager.fetchAll(true);
    } finally {
      setRefreshing(false);
    }
  };

  const toggleProvider = (id: string) => {
    const next = new Set(prefs.enabledProviders || prefs.providerOrder);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saveQuotaPreferences({ enabledProviders: Array.from(next) });
  };

  const copy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(cmd);
      setTimeout(() => setCopied(null), 2200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const saveCookie = async () => {
    if (!cookie.trim()) return;
    setOpenCodeStatus('Guardando…');
    try {
      const ok = await saveOpenCodeCookie(cookie.trim(), workspaceId.trim() || undefined);
      setOpenCodeStatus(ok ? 'Credenciales guardadas' : 'No se pudo guardar');
      if (ok) {
        setCookie('');
        await subscriptionQuotaManager.fetchAll(true);
      }
    } catch (err: any) {
      setOpenCodeStatus(err?.message || 'Error al guardar');
    }
    setTimeout(() => setOpenCodeStatus(null), 3500);
  };

  const clearCookie = async () => {
    try {
      await clearOpenCodeCookie();
      setOpenCodeStatus('Credenciales eliminadas');
      await subscriptionQuotaManager.fetchAll(true);
    } catch (err: any) {
      setOpenCodeStatus(err?.message || 'Error al limpiar');
    }
    setTimeout(() => setOpenCodeStatus(null), 3000);
  };

  return (
    <>
      {/* ── Indicator preferences ───────────────────────────── */}
      <section className="settings-group">
        <h2 className="settings-group__title">Medidor de la barra superior</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Mostrar medidor de cuota</h3>
              <p>Porcentaje restante y tiempo de reinicio del agente que estás usando.</p>
            </div>
            <div className="settings-row__control">
              <Switch
                checked={prefs.enabled}
                label="Mostrar medidor de cuota"
                onChange={() => saveQuotaPreferences({ enabled: !prefs.enabled })}
              />
            </div>
          </div>
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Detectar el agente activo</h3>
              <p>El medidor cambia solo al proveedor de la sesión en la que trabajas.</p>
            </div>
            <div className="settings-row__control">
              <Switch
                checked={prefs.autoDetectActive}
                label="Detectar el agente activo"
                onChange={() => saveQuotaPreferences({ autoDetectActive: !prefs.autoDetectActive })}
              />
            </div>
          </div>
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Formato</h3>
              <p>Cómo se muestra el porcentaje en la pastilla.</p>
            </div>
            <div className="settings-row__control">
              <div className="qt-segment qt-segment--compact" role="radiogroup" aria-label="Formato">
                {DISPLAY_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={prefs.displayMode === m.id}
                    className="qt-segment__item"
                    data-active={prefs.displayMode === m.id ? '' : undefined}
                    onClick={() => saveQuotaPreferences({ displayMode: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Account vault ───────────────────────────────────── */}
      <section className="settings-group">
        <h2 className="settings-group__title">Cuentas conectadas</h2>
        <p className="qt-lead">
          Guarda varias suscripciones y cambia de una a otra en un clic cuando una se agote. Todo queda en
          tu equipo, sin proxies.
        </p>
        <AccountVault onChanged={() => void subscriptionQuotaManager.fetchAll(true)} />
      </section>

      {/* ── Providers ───────────────────────────────────────── */}
      <section className="settings-group">
        <div className="qt-group-head">
          <h2 className="settings-group__title">Proveedores monitoreados</h2>
          <div className="qt-group-head__actions">
            <button
              type="button"
              className="qt-button qt-button--ghost"
              onClick={() => saveQuotaPreferences({ enabledProviders: [...ALL_SUPPORTED_PROVIDERS] })}
            >
              Activar todos
            </button>
            <button
              type="button"
              className="qt-button qt-button--ghost"
              onClick={() => saveQuotaPreferences({ enabledProviders: [] })}
            >
              Desactivar todos
            </button>
            <button type="button" className="qt-button" disabled={refreshing} onClick={refresh}>
              {refreshing ? 'Actualizando…' : 'Actualizar'}
            </button>
          </div>
        </div>

        <div className="ui-card qt-providers">
          {ordered.map((id) => {
            const q = quotas[id];
            const diag = diagnoseProvider(q);
            const cfg = PROVIDER_CONFIGS_ES[id];
            const pct = diag.state === 'ok' && q ? Math.round(q.primaryRemainingPercent ?? 0) : null;
            const open = expanded === id;
            return (
              <div key={id} className="qt-provider" data-open={open ? '' : undefined}>
                <div className="qt-provider__row">
                  <button
                    type="button"
                    className="qt-provider__main"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : id)}
                  >
                    <BrandLogo engine={id} size={18} />
                    <span className="qt-provider__name">{PROVIDER_LABELS[id] || id}</span>
                    <span className="qt-chip" data-tone={diag.state === 'ok' || diag.state === 'detected' ? 'ok' : diag.state === 'not_installed' ? 'idle' : 'warn'}>
                      {diag.statusLabel}
                    </span>
                    {pct !== null ? (
                      <span className="qt-provider__pct" data-tone={toneFor(pct)}>
                        {pct}%
                      </span>
                    ) : null}
                    <svg className="qt-provider__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <Switch
                    checked={enabledSet.has(id)}
                    label={`Mostrar ${PROVIDER_LABELS[id] || id}`}
                    onChange={() => toggleProvider(id)}
                  />
                </div>

                {open ? (
                  <div className="qt-provider__detail">
                    {cfg ? (
                      <>
                        <h4>{cfg.title}</h4>
                        <p>{cfg.desc}</p>
                        <dl>
                          <dt>Origen de datos</dt>
                          <dd><code>{cfg.source}</code></dd>
                          {q?.metadata?.email ? (
                            <>
                              <dt>Cuenta detectada</dt>
                              <dd>{String(q.metadata.email)}</dd>
                            </>
                          ) : null}
                          {diag.state !== 'ok' && diag.detail ? (
                            <>
                              <dt>Estado</dt>
                              <dd>{diag.detail}</dd>
                            </>
                          ) : null}
                        </dl>
                        <p className="qt-provider__note">{cfg.details}</p>
                        {cfg.loginCmd ? (
                          <div className="qt-cmd">
                            <code>{cfg.loginCmd}</code>
                            <button type="button" className="qt-button qt-button--ghost" onClick={() => copy(cfg.loginCmd!)}>
                              {copied === cfg.loginCmd ? 'Copiado' : 'Copiar'}
                            </button>
                          </div>
                        ) : null}
                        {cfg.connectionType === 'opencode_form' ? (
                          <div className="qt-form">
                            <textarea
                              className="qt-input"
                              rows={3}
                              placeholder="Cabecera Cookie (incluye __Host-console_session)"
                              value={cookie}
                              onChange={(e) => setCookie(e.target.value)}
                            />
                            <input
                              className="qt-input"
                              placeholder="Workspace ID (opcional)"
                              value={workspaceId}
                              onChange={(e) => setWorkspaceId(e.target.value)}
                            />
                            <div className="qt-form__actions">
                              <button type="button" className="qt-button qt-button--primary" onClick={saveCookie}>
                                Guardar
                              </button>
                              <button type="button" className="qt-button qt-button--ghost" onClick={clearCookie}>
                                Quitar credenciales
                              </button>
                              {openCodeStatus ? <span className="qt-hint">{openCodeStatus}</span> : null}
                            </div>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p>Sin información adicional para este proveedor.</p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
};
