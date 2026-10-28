import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './quotas-tab.css';
import { AccountVault, MULTI_ACCOUNT_PROVIDERS } from './AccountVault';
import { BrandLogo } from '../../ui/BrandLogo';
import { AddProviderModal } from '../../quota/AddProviderModal';
import { AccountSwitcherModal } from '../../quota/AccountSwitcherModal';
import { ProviderConnectionPanel } from '../../quota/ProviderConnectionPanel';
import { ENGINE_METADATA } from '../agents/engineMetadata';
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
  listDetectedCliAccounts,
  type ConnectionSummary,
  type DetectedCliAccount,
  type CredentialStatusItem,
} from '../../../lib/ipc';
import { getActiveAgentTerminals, type ActiveAgentTerminal } from '../../../lib/terminalRegistry';
import {
  detectAllProviderSessions,
  getAutoEnableSuggestedProviders,
} from '../../../lib/quota/sessionDetection';
import {
  fetchVaultCredentials,
  getProviderConnectionMeta,
} from '../../../lib/quota/connectionMethods';
import { SETTINGS_PROVIDER_STORAGE_KEY } from '../../../lib/settingsNav';
import { StarIcon, ChevronDownIcon, ChevronUpIcon } from './icons';

const DISPLAY_MODES: { id: QuotaPreferences['displayMode']; label: string }[] = [
  { id: 'percent_remaining', label: '% restante' },
  { id: 'percent_used', label: '% usado' },
  { id: 'compact', label: 'Compacto' },
];

const toneFor = (pct: number) => (pct >= 45 ? 'ok' : pct >= 20 ? 'warn' : 'low');

function formatReset(ms?: number | null, resetAt?: string | null): string | null {
  if (ms && ms > 0) {
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `Reinicia en ${h} h ${m} min` : `Reinicia en ${m} min`;
  }
  if (resetAt) {
    try {
      const d = new Date(resetAt);
      if (!isNaN(d.getTime())) {
        return `Reinicia a las ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
    } catch {
      /* fallback */
    }
    return `Reinicia ${resetAt}`;
  }
  return null;
}

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
  const [cliAccounts, setCliAccounts] = useState<DetectedCliAccount[]>([]);
  const [activeTerminals, setActiveTerminals] = useState<ActiveAgentTerminal[]>(() => {
    try {
      return getActiveAgentTerminals();
    } catch {
      return [];
    }
  });
  const [expandedWindows, setExpandedWindows] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [openCodeStatus, setOpenCodeStatus] = useState<string | null>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [switcherProvider, setSwitcherProvider] = useState<{ id: string; label: string } | null>(null);
  const [verifiedConnections, setVerifiedConnections] = useState<ConnectionSummary[]>([]);
  const [vaultCredentials, setVaultCredentials] = useState<Record<string, CredentialStatusItem>>({});

  const refreshCredentials = useCallback(async () => {
    try {
      const creds = await fetchVaultCredentials();
      setVaultCredentials(creds);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshCredentials();
  }, [refreshCredentials]);

  useEffect(() => subscriptionQuotaManager.subscribe((data) => setQuotas(data)), []);

  useEffect(() => {
    let cancelled = false;
    void listQuotaConnections().then((connections) => {
      if (!cancelled) setVerifiedConnections(connections);
    });
    void listDetectedCliAccounts().then((accounts) => {
      if (!cancelled) setCliAccounts(accounts);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleTerminalUpdate = () => {
      try {
        setActiveTerminals(getActiveAgentTerminals());
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('kite:terminal-agent-update', handleTerminalUpdate);
    return () => window.removeEventListener('kite:terminal-agent-update', handleTerminalUpdate);
  }, []);

  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail) setPrefs(e.detail);
    };
    window.addEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(QUOTA_PREFS_CHANGED_EVENT, handler);
  }, []);

  useEffect(() => {
    // Prewarm all supported providers so quotas and models are populated across views
    void subscriptionQuotaManager.fetchAll(false, ALL_SUPPORTED_PROVIDERS).catch(() => undefined);
  }, []);

  const handleCredentialChanged = async () => {
    await refreshCredentials();
    void subscriptionQuotaManager.fetchAll(true);
  };

  const detectedSessions = useMemo(
    () =>
      detectAllProviderSessions(
        cliAccounts,
        activeTerminals,
        quotas,
        Object.values(vaultCredentials)
      ),
    [cliAccounts, activeTerminals, quotas, vaultCredentials]
  );

  // Auto-seed detected sessions if the user has never configured providers yet
  useEffect(() => {
    if (prefs.enabledProviders && prefs.enabledProviders.length > 0) return;
    const suggested = getAutoEnableSuggestedProviders(detectedSessions);
    if (suggested.length > 0) {
      saveQuotaPreferences({ enabledProviders: suggested });
      setSelectedProviderId((prev) => prev ?? suggested[0]);
    }
  }, [detectedSessions, prefs.enabledProviders]);

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

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(SETTINGS_PROVIDER_STORAGE_KEY);
      if (stored && enabledIds.includes(stored)) return stored;
    } catch {
      /* ignore */
    }
    return enabledIds[0] ?? null;
  });

  useEffect(() => {
    if (!selectedProviderId || !enabledIds.includes(selectedProviderId)) {
      setSelectedProviderId(enabledIds[0] ?? null);
    }
  }, [enabledIds, selectedProviderId]);

  const handleSelectProvider = (id: string) => {
    setSelectedProviderId(id);
    try {
      localStorage.setItem(SETTINGS_PROVIDER_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  };

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
    setAddProviderOpen(true);
  };

  const handleConfirmAddProviders = (ids: string[]) => {
    if (ids.length === 0) return;
    const next = [...enabledIds];
    for (const id of ids) {
      if (!next.includes(id)) next.push(id);
    }
    saveQuotaPreferences({ enabledProviders: next });
    if (ids[0]) {
      handleSelectProvider(ids[0]);
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

  const activeProvider = selectedProviderId ? selectedProviderId : null;
  const activeQuota = activeProvider ? quotas[activeProvider] : undefined;
  const activeSession = activeProvider ? detectedSessions[activeProvider] : undefined;
  const activeDiag = diagnoseProvider(activeQuota);
  const activeCfg = activeProvider ? PROVIDER_CONFIGS_ES[activeProvider] : undefined;
  const activeMeta = activeProvider ? ENGINE_METADATA[activeProvider] : undefined;
  const activeIndex = activeProvider ? enabledIds.indexOf(activeProvider) : -1;
  const activePinned = activeProvider ? prefs.pinnedProvider === activeProvider : false;
  const activePct =
    activeDiag.state === 'ok' && activeQuota
      ? Math.round(activeQuota.primaryRemainingPercent ?? 0)
      : null;

  return (
    <>
      {/* ── 1. TOP SECTION: PROVIDERS (T3 Code-inspired Master-Detail) ─────── */}
      <section className="settings-group">
        <div className="qt-group-head">
          <div>
            <h2 className="settings-group__title">Proveedores</h2>
            <p className="qt-lead" style={{ margin: '3px 0 0' }}>
              Conexiones de IA activas en tu equipo. Configura tus agentes o agrega nuevos proveedores.
            </p>
          </div>
          <div className="qt-group-head__actions">
            <button
              type="button"
              className="qt-button"
              disabled={refreshing || enabledIds.length === 0}
              onClick={refresh}
            >
              {refreshing ? 'Actualizando…' : 'Actualizar'}
            </button>
            <button
              type="button"
              className="qt-button qt-button--primary"
              onClick={openAddProvider}
            >
              + Agregar proveedor
            </button>
          </div>
        </div>

        {enabledIds.length === 0 ? (
          <div className="qt-empty" style={{ margin: '14px 0' }}>
            <span
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background: 'var(--chip-fill)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)',
                marginBottom: '4px',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <strong>Todavía no agregaste proveedores</strong>
            <span>Agrega tus proveedores de IA para monitorear sus cuotas y alternar sesiones en un clic.</span>
            <button
              type="button"
              className="qt-button qt-button--primary"
              onClick={openAddProvider}
              style={{ marginTop: '8px' }}
            >
              + Agregar proveedor
            </button>
          </div>
        ) : (
          <div className="qt-providers-container" style={{ marginTop: '12px' }}>
            {/* Left Column: Connected Providers List + Add Provider Row at bottom */}
            <div className="qt-providers-sidebar">
              <div className="qt-providers-sidebar__scroll">
                {enabledIds.map((id) => {
                  const q = quotas[id];
                  const s = detectedSessions[id];
                  const diag = diagnoseProvider(q);
                  const isSelected = selectedProviderId === id;
                  const isPinned = prefs.pinnedProvider === id;
                  const pct = diag.state === 'ok' && q ? Math.round(q.primaryRemainingPercent ?? 0) : null;

                  return (
                    <button
                      key={id}
                      type="button"
                      className="qt-providers-sidebar__item"
                      data-selected={isSelected ? '' : undefined}
                      onClick={() => handleSelectProvider(id)}
                    >
                      <BrandLogo engine={id} size={18} />
                      <span className="qt-providers-sidebar__name">
                        {PROVIDER_LABELS[id] || id}
                      </span>
                      {isPinned ? (
                        <span
                          title="Fijado en la barra superior"
                          style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center' }}
                        >
                          <StarIcon size={12} filled />
                        </span>
                      ) : null}
                      {pct !== null ? (
                        <span className="qt-provider__pct" data-tone={toneFor(pct)}>
                          {pct}%
                        </span>
                      ) : (
                        <span
                          className="qt-chip"
                          data-tone={
                            s?.statusTone ??
                            (diag.state === 'ok' || diag.state === 'detected'
                              ? 'ok'
                              : diag.state === 'not_installed'
                              ? 'idle'
                              : 'warn')
                          }
                          style={{ padding: '0 5px', fontSize: '9.5px', height: '16px' }}
                        >
                          {s?.sessionType === 'terminal_agent'
                            ? 'Term'
                            : s?.sessionType === 'cli_authenticated'
                            ? 'CLI'
                            : diag.state === 'ok' || diag.state === 'detected'
                            ? 'OK'
                            : diag.state === 'not_installed'
                            ? 'Login'
                            : '!'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Exact T3 Code location: "+ Add provider" at the bottom of the list */}
              <button
                type="button"
                className="qt-add-provider-trigger"
                onClick={openAddProvider}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Agregar proveedor</span>
              </button>
            </div>

            {/* Right Column: Selected Provider Inspector & Editor */}
            <div className="qt-providers-detail">
              {activeProvider ? (
                <>
                  <div className="qt-providers-detail__header">
                    <div className="qt-providers-detail__brand">
                      <div className="qt-providers-detail__icon-box">
                        <BrandLogo engine={activeProvider} size={30} />
                      </div>
                      <div className="qt-providers-detail__title-col">
                        <h3>
                          <span>{PROVIDER_LABELS[activeProvider] || activeProvider}</span>
                          {activePinned ? <span className="qt-chip" data-tone="ok">En la barra</span> : null}
                          {activePct !== null ? (
                            <span className="qt-chip" data-tone={toneFor(activePct)}>
                              {activePct}% disponible
                            </span>
                          ) : null}
                        </h3>
                        <div className="qt-providers-detail__vendor">
                          {activeMeta?.vendor ? `${activeMeta.vendor} · ` : ''}
                          {activeCfg?.title || 'Proveedor de IA'}
                        </div>
                      </div>
                    </div>

                    <div className="qt-providers-detail__actions">
                      <button
                        type="button"
                        className="qt-button"
                        data-active={activePinned ? '' : undefined}
                        onClick={() => togglePin(activeProvider)}
                        title={activePinned ? 'Dejar de fijar en la barra superior' : 'Fijar en la barra superior'}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                      >
                        <StarIcon size={13} filled={Boolean(activePinned)} />
                        <span>{activePinned ? 'Fijado' : 'Fijar en barra'}</span>
                      </button>

                      <button
                        type="button"
                        className="qt-icon-button"
                        title="Subir en el orden de prioridad"
                        disabled={activeIndex === 0}
                        onClick={() => moveProvider(activeProvider, 'up')}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 15 12 9 18 15" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        className="qt-icon-button"
                        title="Bajar en el orden de prioridad"
                        disabled={activeIndex === enabledIds.length - 1}
                        onClick={() => moveProvider(activeProvider, 'down')}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>

                      {MULTI_ACCOUNT_PROVIDERS.some((p) => p.id === activeProvider) && (
                        <button
                          type="button"
                          className="qt-button"
                          onClick={() =>
                            setSwitcherProvider({
                              id: activeProvider,
                              label: PROVIDER_LABELS[activeProvider] || activeProvider,
                            })
                          }
                          title="Alternar entre múltiples cuentas guardadas"
                        >
                          Cuentas en bóveda…
                        </button>
                      )}

                      <button
                        type="button"
                        className="qt-button qt-button--ghost"
                        onClick={() => removeProvider(activeProvider)}
                        title="Quitar este proveedor de los monitoreados"
                        style={{ color: 'var(--status-failed)' }}
                      >
                        Quitar
                      </button>
                    </div>
                  </div>

                  {/* Spec Grid */}
                  <div className="qt-providers-detail__grid">
                    <div className="qt-spec-card">
                      <span className="qt-spec-card__label">Estado de conexión</span>
                      <span className="qt-spec-card__value">
                        <span
                          className="qt-chip"
                          data-tone={
                            activeSession?.statusTone ??
                            (activeDiag.state === 'ok' || activeDiag.state === 'detected'
                              ? 'ok'
                              : activeDiag.state === 'not_installed'
                              ? 'idle'
                              : 'warn')
                          }
                        >
                          <span
                            className="qt-status-dot"
                            data-tone={
                              activeSession?.statusTone ??
                              (activeDiag.state === 'ok' || activeDiag.state === 'detected'
                                ? 'ok'
                                : activeDiag.state === 'not_installed'
                                ? 'idle'
                                : 'warn')
                            }
                          />
                          {activeSession?.statusLabel ?? activeDiag.statusLabel}
                        </span>
                      </span>
                    </div>

                    <div className="qt-spec-card">
                      <span className="qt-spec-card__label">Cuenta detectada</span>
                      <span className="qt-spec-card__value">
                        {activeSession?.email
                          ? activeSession.email
                          : activeSession?.accountLabel
                          ? activeSession.accountLabel
                          : activeQuota?.metadata?.email
                          ? String(activeQuota.metadata.email)
                          : activeSession?.hasSession
                          ? 'Sesión local detectada'
                          : 'Sesión local del sistema'}
                      </span>
                    </div>

                    <div className="qt-spec-card">
                      <span className="qt-spec-card__label">Origen de datos</span>
                      <span className="qt-spec-card__value">
                        <code>{activeSession?.details || activeCfg?.source || 'CLI local'}</code>
                      </span>
                    </div>

                    <div className="qt-spec-card">
                      <span className="qt-spec-card__label">Tipo de sesión</span>
                      <span className="qt-spec-card__value">
                        {activeSession?.sessionType === 'terminal_agent'
                          ? 'Agente en terminal interactiva'
                          : activeSession?.sessionType === 'cli_authenticated'
                          ? activeSession.planName || 'CLI local autenticada'
                          : activeCfg?.connectionType === 'cli_oauth'
                          ? 'OAuth CLI heredado'
                          : activeCfg?.connectionType === 'local_rpc'
                          ? 'RPC local'
                          : activeCfg?.connectionType === 'opencode_form'
                          ? 'Formulario OpenCode'
                          : 'Configuración de equipo'}
                      </span>
                    </div>
                  </div>

                  {/* Multi-Method Connection Panel (CLI Terminal, API Key in Vault, Web Console) */}
                  <ProviderConnectionPanel
                    providerId={activeProvider}
                    detectedSession={activeSession}
                    vaultCredential={
                      vaultCredentials[
                        getProviderConnectionMeta(activeProvider)?.apiKeyProviderKey ?? activeProvider
                      ]
                    }
                    onCredentialChanged={handleCredentialChanged}
                  />

                  {/* OpenCode custom form */}
                  {activeCfg?.connectionType === 'opencode_form' ? (
                    <div className="qt-spec-card">
                      <span className="qt-spec-card__label">Configuración de clave API de OpenCode</span>
                      <div className="qt-form" style={{ marginTop: '8px' }}>
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
                        <div className="settings-row settings-row--stacked">
                          <div className="settings-row__control">
                            <div className="settings-credential">
                              <input
                                className="ui-field"
                                type={showApiKey ? 'text' : 'password'}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="API key de OpenCode Go (opcional si OpenCode ya está logueado)"
                                aria-label="API key de OpenCode Go"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                              />
                              <button
                                type="button"
                                className="settings-control ui-button"
                                onClick={() => setShowApiKey((current) => !current)}
                              >
                                {showApiKey ? 'Ocultar' : 'Ver'}
                              </button>
                              <button
                                type="button"
                                className="settings-control ui-button ui-button--primary"
                                onClick={saveApiKey}
                              >
                                Guardar
                              </button>
                              <button
                                type="button"
                                className="settings-control ui-button"
                                onClick={clearApiKey}
                              >
                                Quitar clave de Kite
                              </button>
                            </div>
                            {openCodeStatus ? <span className="qt-hint">{openCodeStatus}</span> : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="qt-empty" style={{ margin: 'auto' }}>
                  <strong>Selecciona un proveedor de la lista</strong>
                  <span>Elige un proveedor para ver su diagnóstico, cuentas y opciones.</span>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── 2. USAGE PROVIDERS (Límites y consumo en tiempo real) ──────────── */}
      <section className="settings-group">
        <div className="qt-group-head">
          <div>
            <h2 className="settings-group__title">Límites y consumo de proveedores</h2>
            <p className="qt-lead" style={{ margin: '3px 0 0' }}>
              Consumo en tiempo real, ventanas de 5 horas, límites semanales y tiempo de reinicio.
            </p>
          </div>
        </div>

        {enabledIds.length === 0 ? (
          <p className="qt-hint">Agrega proveedores en la sección superior para ver sus métricas de consumo aquí.</p>
        ) : (
          <div className="qt-usage-grid" style={{ marginTop: '12px' }}>
            {enabledIds.map((id) => {
              const q = quotas[id];
              const s = detectedSessions[id];
              const diag = diagnoseProvider(q);
              const pct = diag.state === 'ok' && q ? Math.round(q.primaryRemainingPercent ?? 0) : null;
              const resetLabel = formatReset(q?.timeUntilResetMs, q?.primaryResetAt);
              const isWindowsExpanded = expandedWindows[id] ?? false;
              const hasWindows = Boolean(q?.windows && q.windows.length > 0);

              return (
                <div key={id} className="qt-usage-card">
                  <div className="qt-usage-card__head">
                    <div className="qt-usage-card__brand">
                      <BrandLogo engine={id} size={22} />
                      <span className="qt-usage-card__name">
                        {PROVIDER_LABELS[id] || id}
                      </span>
                    </div>
                    {pct !== null ? (
                      <span className="qt-usage-card__pct" data-tone={toneFor(pct)}>
                        {pct}%
                      </span>
                    ) : (
                      <span
                        className="qt-chip"
                        data-tone={
                          s?.statusTone ??
                          (diag.state === 'ok' || diag.state === 'detected'
                            ? 'ok'
                            : diag.state === 'not_installed'
                            ? 'idle'
                            : 'warn')
                        }
                      >
                        {s?.statusLabel ?? diag.statusLabel}
                      </span>
                    )}
                  </div>

                  <div className="qt-usage-card__meter-container">
                    {pct !== null ? (
                      <>
                        <div className="qt-meter" data-tone={toneFor(pct)}>
                          <span style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <span className="qt-hint">
                            {s?.email || s?.accountLabel || (q?.metadata?.email ? String(q.metadata.email) : 'Cuenta activa')}
                          </span>
                          {resetLabel ? <span className="qt-hint">{resetLabel}</span> : null}
                        </div>
                      </>
                    ) : (
                      <span className="qt-hint">
                        {s?.hasSession ? s.details : (diag.detail || 'Sin datos de cuota disponibles actualmente.')}
                      </span>
                    )}
                  </div>

                  {/* Collapsible Sub-windows for models to prevent vertical explosion */}
                  {hasWindows ? (
                    <div className="qt-usage-card__windows-wrapper">
                      <button
                        type="button"
                        className="qt-usage-card__toggle-btn"
                        onClick={() =>
                          setExpandedWindows((prev) => ({
                            ...prev,
                            [id]: !isWindowsExpanded,
                          }))
                        }
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                      >
                        {isWindowsExpanded ? (
                          <>
                            <ChevronUpIcon size={12} />
                            <span>Ocultar desglose de modelos</span>
                          </>
                        ) : (
                          <>
                            <ChevronDownIcon size={12} />
                            <span>Ver desglose por modelo ({q!.windows.length})</span>
                          </>
                        )}
                      </button>

                      {isWindowsExpanded ? (
                        <div className="qt-usage-card__windows-scroll">
                          {q!.windows.map((win, wIdx) => {
                            const winPct = Math.round((win.remainingFraction ?? 0) * 100);
                            const winReset = formatReset(win.timeUntilResetMs, win.resetsAt);
                            return (
                              <div key={wIdx} className="qt-usage-card__window-row">
                                <div className="qt-usage-card__window-head">
                                  <span>{win.name}</span>
                                  <span data-tone={toneFor(winPct)} style={{ fontWeight: 600 }}>
                                    {winPct}%
                                  </span>
                                </div>
                                <div className="qt-meter" data-tone={toneFor(winPct)} style={{ height: '4px' }}>
                                  <span style={{ width: `${Math.max(2, Math.min(100, winPct))}%` }} />
                                </div>
                                {winReset ? (
                                  <span className="qt-hint" style={{ fontSize: '10.5px' }}>
                                    {winReset}
                                  </span>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Verified connections from shared registry ───────────────────────── */}
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

      {/* ── 3. TOP BAR METER PREFERENCES ───────────────────────────────────── */}
      <section className="settings-group">
        <h2 className="settings-group__title">Medidor de la barra superior</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Mostrar medidor de cuota</h3>
              <p>Porcentaje restante y tiempo de reinicio del agente que estás usando en la barra superior.</p>
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
              <p>Cómo se muestra el porcentaje en la pastilla de la barra.</p>
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

      {/* ── 4. ACCOUNT VAULT (Cuentas conectadas) ─────────────────────────── */}
      <section className="settings-group">
        <h2 className="settings-group__title">Bóveda de cuentas conectadas</h2>
        <p className="qt-lead">
          Guarda varias suscripciones y cambia de una a otra en un clic cuando una se agote. Todo queda en
          tu equipo, sin proxies.
        </p>
        <AccountVault onChanged={() => void subscriptionQuotaManager.fetchAll(true)} />
      </section>

      {/* ── Cohesive Modals ──────────────────────────────────────────────── */}
      <AddProviderModal
        isOpen={addProviderOpen}
        onClose={() => setAddProviderOpen(false)}
        availableProviders={availableProviders}
        quotas={quotas}
        detectedSessions={detectedSessions}
        onAdd={handleConfirmAddProviders}
      />

      {switcherProvider && (
        <AccountSwitcherModal
          provider={switcherProvider.id}
          providerLabel={switcherProvider.label}
          isOpen={!!switcherProvider}
          onClose={() => setSwitcherProvider(null)}
          onAccountSwitched={() => {
            void subscriptionQuotaManager.fetchAll(true);
          }}
        />
      )}
    </>
  );
};
