import React, { useEffect, useMemo, useState } from 'react';
import './quotas-tab.css';
import { AccountVault } from './AccountVault';
import { BrandLogo } from '../agents/engineMetadata';
import {
  ALL_SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
  type ProviderQuotaStatus,
  type QuotaPreferences,
  resolveEnabledProviderIds,
} from '../../../lib/quota/types';
import {
  QUOTA_PREFS_CHANGED_EVENT,
  isVerifiedQuotaEndpoint,
  listQuotaConnections,
  readQuotaPreferences,
  saveQuotaPreferences,
  subscriptionQuotaManager,
} from '../../../lib/quota/quotaManager';
import { diagnoseProvider } from '../../../lib/quota/providerState';
import { PROVIDER_CONFIGS_ES } from '../../quota/QuotaSettingsModal';
import {
  clearOpenCodeApiKey,
  saveOpenCodeApiKey,
  type ConnectionSummary,
} from '../../../lib/ipc';
import { SETTINGS_PROVIDER_STORAGE_KEY } from '../../../lib/settingsNav';
import { Sheet } from '../../ui/Sheet';

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
  const [apiKey, setApiKey] = useState('');
  const [openCodeStatus, setOpenCodeStatus] = useState<string | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [addSelection, setAddSelection] = useState<string[]>([]);
  const [verifiedConnections, setVerifiedConnections] = useState<ConnectionSummary[]>([]);

  useEffect(() => subscriptionQuotaManager.subscribe((data) => setQuotas(data)), []);

  useEffect(() => {
    let cancelled = false;
    void listQuotaConnections().then((connections) => {
      if (!cancelled) setVerifiedConnections(connections);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const enabledIds = useMemo(() => resolveEnabledProviderIds(prefs), [prefs]);

  const fullOrder = useMemo(() => {
    const order = prefs.providerOrder?.length ? prefs.providerOrder : ALL_SUPPORTED_PROVIDERS;
    const known = order.filter((id) => ALL_SUPPORTED_PROVIDERS.includes(id));
    const missing = ALL_SUPPORTED_PROVIDERS.filter((id) => !known.includes(id));
    return [...known, ...missing];
  }, [prefs.providerOrder]);

  const enabledIdSet = useMemo(() => new Set(enabledIds), [enabledIds]);

  const availableProviders = useMemo(
    () => fullOrder.filter((id) => !enabledIdSet.has(id)),
    [fullOrder, enabledIdSet]
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await subscriptionQuotaManager.fetchAll(true);
    } finally {
      setRefreshing(false);
    }
  };

  const removeProvider = (id: string) => {
    const next = enabledIds.filter((providerId) => providerId !== id);
    saveQuotaPreferences({
      enabledProviders: next,
      pinnedProvider: prefs.pinnedProvider === id ? null : prefs.pinnedProvider,
    });
  };

  const togglePin = (id: string) => {
    saveQuotaPreferences({ pinnedProvider: prefs.pinnedProvider === id ? null : id });
  };

  const moveProvider = (id: string, direction: 'up' | 'down') => {
    const index = enabledIds.indexOf(id);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index === -1 || targetIndex < 0 || targetIndex >= enabledIds.length) return;

    const targetId = enabledIds[targetIndex];
    const order = [...fullOrder];
    const from = order.indexOf(id);
    const to = order.indexOf(targetId);
    if (from === -1 || to === -1) return;
    [order[from], order[to]] = [order[to], order[from]];
    saveQuotaPreferences({ providerOrder: order });
  };

  const openAddProvider = () => {
    setAddSelection([]);
    setAddProviderOpen(true);
  };

  const confirmAddProviders = () => {
    if (addSelection.length === 0) return;
    const next = [...enabledIds];
    for (const id of addSelection) {
      if (!next.includes(id)) next.push(id);
    }
    saveQuotaPreferences({ enabledProviders: next });
    setAddProviderOpen(false);
    setAddSelection([]);
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

  const saveApiKey = async () => {
    if (!apiKey.trim()) return;
    setOpenCodeStatus('Guardando…');
    try {
      const ok = await saveOpenCodeApiKey(apiKey.trim());
      setOpenCodeStatus(ok ? 'API key guardada' : 'No se pudo guardar');
      if (ok) {
        setApiKey('');
        await subscriptionQuotaManager.fetchAll(true);
      }
    } catch (err: any) {
      setOpenCodeStatus(err?.message || 'Error al guardar');
    }
    setTimeout(() => setOpenCodeStatus(null), 3500);
  };

  const clearApiKey = async () => {
    try {
      await clearOpenCodeApiKey();
      setOpenCodeStatus('Clave de Kite eliminada; la detección de OpenCode sigue activa');
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

      {/* ── Connections verified in the shared registry ──────── */}
      {verifiedConnections.length > 0 ? (
        <section className="settings-group">
          <h2 className="settings-group__title">Conexiones con cuota verificada</h2>
          <p className="qt-lead">
            Se leen del registro compartido. Una conexión aparece aquí solo si su propio endpoint de
            cuota fue verificado. El nombre del driver no alcanza.
          </p>
          <div className="ui-card">
            {verifiedConnections.map((connection) => {
              const verifiedCount = connection.endpoints.filter(
                (endpoint) => endpoint.ok && isVerifiedQuotaEndpoint(endpoint.endpointId)
              ).length;
              return (
                <div key={connection.connectionId} className="ui-card__row settings-row">
                  <div className="settings-row__copy">
                    <h3 className="settings-row__title">{connection.displayName}</h3>
                    <p>
                      {connection.driverKind} · {connection.authMethod}
                      {connection.accountIdentity.email
                        ? ` · ${connection.accountIdentity.email}`
                        : ''}
                    </p>
                  </div>
                  <div className="settings-row__control">
                    <span className="qt-chip" data-tone="ok">
                      Quota verified
                    </span>
                    <span className="qt-hint" style={{ marginLeft: 8 }}>
                      {verifiedCount} endpoint{verifiedCount === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ── Providers ───────────────────────────────────────── */}
      <section className="settings-group">
        <div className="qt-group-head">
          <h2 className="settings-group__title">Proveedores monitoreados</h2>
          <div className="qt-group-head__actions">
            <button type="button" className="qt-button qt-button--primary" onClick={openAddProvider}>
              Agregar proveedor
            </button>
            <button
              type="button"
              className="qt-button"
              disabled={refreshing || enabledIds.length === 0}
              onClick={refresh}
            >
              {refreshing ? 'Actualizando…' : 'Actualizar'}
            </button>
          </div>
        </div>
        <p className="qt-lead">
          Nada se monitorea por defecto. Agregá solo los proveedores que usás; tus claves y sesiones
          existentes no se modifican ni se borran.
        </p>

        {enabledIds.length === 0 ? (
          <div className="qt-empty">
            <strong>Todavía no agregaste proveedores</strong>
            <span>Sumá un proveedor para ver su cuota en la barra superior.</span>
            <button type="button" className="qt-button qt-button--primary" onClick={openAddProvider}>
              Agregar proveedor
            </button>
          </div>
        ) : (
        <div className="ui-card qt-providers">
          {enabledIds.map((id, index) => {
            const q = quotas[id];
            const diag = diagnoseProvider(q);
            const cfg = PROVIDER_CONFIGS_ES[id];
            const pct = diag.state === 'ok' && q ? Math.round(q.primaryRemainingPercent ?? 0) : null;
            const open = expanded === id;
            const pinned = prefs.pinnedProvider === id;
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
                    {pinned ? <span className="qt-chip" data-tone="ok">En la barra</span> : null}
                    {pct !== null ? (
                      <span className="qt-provider__pct" data-tone={toneFor(pct)}>
                        {pct}%
                      </span>
                    ) : null}
                    <svg className="qt-provider__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  <div className="qt-provider__actions">
                    <button
                      type="button"
                      className="qt-icon-button"
                      title="Subir en el orden"
                      aria-label={`Subir ${PROVIDER_LABELS[id] || id}`}
                      disabled={index === 0}
                      onClick={() => moveProvider(id, 'up')}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 15 12 9 18 15" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="qt-icon-button"
                      title="Bajar en el orden"
                      aria-label={`Bajar ${PROVIDER_LABELS[id] || id}`}
                      disabled={index === enabledIds.length - 1}
                      onClick={() => moveProvider(id, 'down')}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="qt-icon-button"
                      data-active={pinned ? '' : undefined}
                      title={pinned ? 'Dejar de fijar en la barra' : 'Fijar en la barra superior'}
                      aria-label={pinned ? `Dejar de fijar ${PROVIDER_LABELS[id] || id}` : `Fijar ${PROVIDER_LABELS[id] || id} en la barra`}
                      aria-pressed={pinned}
                      onClick={() => togglePin(id)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 3h6l-1 7 3 3H7l3-3-1-7z" />
                        <line x1="12" y1="16" x2="12" y2="21" />
                      </svg>
                    </button>
                    <Switch
                      checked
                      label={`Quitar ${PROVIDER_LABELS[id] || id}`}
                      onChange={() => removeProvider(id)}
                    />
                  </div>
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
                            <div className="qt-hint">
                              Detección:{' '}
                              {String(
                                quotas['opencode']?.metadata?.authSource ||
                                  'sin credenciales detectadas'
                              )}{' '}
                              · HTTP {quotas['opencode']?.metadata?.httpStatus ?? '—'}
                            </div>
                            {quotas['opencode']?.metadata?.legacyNote ? (
                              <div className="qt-hint">
                                {String(quotas['opencode'].metadata.legacyNote)}
                              </div>
                            ) : null}
                            <input
                              className="qt-input"
                              type="password"
                              autoComplete="off"
                              placeholder="API key de OpenCode Go (opcional si OpenCode ya está logueado)"
                              value={apiKey}
                              onChange={(e) => setApiKey(e.target.value)}
                            />
                            <div className="qt-form__actions">
                              <button type="button" className="qt-button qt-button--primary" onClick={saveApiKey}>
                                Guardar API key
                              </button>
                              <button type="button" className="qt-button qt-button--ghost" onClick={clearApiKey}>
                                Quitar clave de Kite
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
        )}
      </section>

      <Sheet
        open={addProviderOpen}
        title="Agregar proveedor"
        description="Elegí qué proveedores querés monitorear. Después podés configurarlos y ordenarlos como quieras."
        width={460}
        onCancel={() => setAddProviderOpen(false)}
        primary={{
          label:
            addSelection.length > 0 ? `Agregar (${addSelection.length})` : 'Agregar',
          onClick: confirmAddProviders,
          disabled: addSelection.length === 0,
        }}
        secondary={{ label: 'Cancelar', onClick: () => setAddProviderOpen(false) }}
      >
        <div className="qt-add-list">
          {availableProviders.map((id) => {
            const diag = diagnoseProvider(quotas[id]);
            const checked = addSelection.includes(id);
            return (
              <label key={id} className="qt-add-row" data-selected={checked ? '' : undefined}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setAddSelection((prev) =>
                      prev.includes(id) ? prev.filter((providerId) => providerId !== id) : [...prev, id]
                    )
                  }
                />
                <BrandLogo engine={id} size={18} />
                <span className="qt-add-row__name">{PROVIDER_LABELS[id] || id}</span>
                <span
                  className="qt-chip"
                  data-tone={
                    diag.state === 'ok' || diag.state === 'detected'
                      ? 'ok'
                      : diag.state === 'not_installed'
                      ? 'idle'
                      : 'warn'
                  }
                >
                  {diag.statusLabel}
                </span>
              </label>
            );
          })}
          {availableProviders.length === 0 ? (
            <p className="qt-hint">Todos los proveedores ya están agregados.</p>
          ) : null}
        </div>
      </Sheet>
    </>
  );
};
