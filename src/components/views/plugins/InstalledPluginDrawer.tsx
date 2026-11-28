import React, { useEffect, useState } from 'react';
import type { AgentProfile } from '../../../types';
import {
  fetchSidecarLogs,
  type PluginManifestFormat,
  type PluginRecordDto,
  type SidecarStateKind,
  type SidecarStatusSnapshot,
} from '../../../lib/ipc/pluginRuntime';
import { Sheet } from '../../ui/Sheet';
import { AgentAvatar } from '../../AgentAvatar';
import { BrandLogo as EngineBrandLogo, getEngineDisplayName } from '../agents/engineMetadata';
import { ExternalLinkIcon, PuzzleIcon, RefreshIcon } from './pluginIcons';
import { dispatchOpenRightDockSidecar, getPluginSourceLabel } from './InstalledPluginCard';

export interface InstalledPluginDrawerProps {
  plugin: PluginRecordDto | null;
  isOpen: boolean;
  onClose: () => void;
  onToggleEnabled: (dirId: string, enabled: boolean) => Promise<unknown>;
  onSidecarAction: (
    namespacedId: string,
    action: 'start' | 'stop' | 'restart' | 'open',
    viewPath?: string
  ) => Promise<SidecarStatusSnapshot>;
  onFetchLogs?: (namespacedId: string, tailLines?: number) => Promise<string[]>;
  onUninstall: (dirId: string) => Promise<void>;
  agents: AgentProfile[];
  isPluginEnabledForAgent: (agentId: string, pluginId: string) => boolean;
  onTogglePluginForAgent: (agentId: string, pluginId: string, enable: boolean) => Promise<void>;
}

function getFormatLabel(format: PluginManifestFormat): string {
  switch (format) {
    case 'native':
      return 'Kite Native';
    case 'claude':
      return 'Bundle CC';
    case 'cursor':
      return 'Bundle Editor';
    case 'geminiExtension':
      return 'Extensión';
    case 'legacyManifest':
      return 'Manifiesto';
  }
}

function getSidecarStateLabel(state: SidecarStateKind): string {
  switch (state) {
    case 'running':
      return 'En ejecución';
    case 'starting':
      return 'Iniciando';
    case 'unhealthy':
      return 'Con alertas';
    case 'crashed':
      return 'Caído';
    case 'stopping':
      return 'Deteniendo';
    case 'stopped':
    default:
      return 'Detenido';
  }
}

function isSidecarActive(state: SidecarStateKind): boolean {
  return state === 'running' || state === 'starting' || state === 'unhealthy';
}

function safeExternalUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function formatDrawerError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Ocurrió un error al ejecutar la acción.';
}

export const InstalledPluginDrawer: React.FC<InstalledPluginDrawerProps> = ({
  plugin,
  isOpen,
  onClose,
  onToggleEnabled,
  onSidecarAction,
  onFetchLogs,
  onUninstall,
  agents,
  isPluginEnabledForAgent,
  onTogglePluginForAgent,
}) => {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [logsBySidecar, setLogsBySidecar] = useState<Record<string, string[]>>({});
  const [logsLoading, setLogsLoading] = useState<Record<string, boolean>>({});
  const [logoError, setLogoError] = useState(false);

  useEffect(() => {
    setActionError(null);
    setBusyKey(null);
    setExpandedLogs({});
    setLogsBySidecar({});
    setLogsLoading({});
    setLogoError(false);
  }, [plugin?.dirId, isOpen]);

  if (!isOpen || !plugin) return null;

  const title = plugin.displayName || plugin.name;
  const sourceLabel = getPluginSourceLabel(plugin.source);
  const repoUrl = safeExternalUrl(plugin.repository);
  const homeUrl = safeExternalUrl(plugin.homepage);
  const loadLogsFn = onFetchLogs ?? fetchSidecarLogs;

  const handleToggleExtension = async () => {
    setActionError(null);
    setBusyKey('toggle-plugin');
    try {
      await onToggleEnabled(plugin.dirId, !plugin.enabled);
    } catch (err) {
      setActionError(formatDrawerError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleSidecarCommand = async (
    sidecar: SidecarStatusSnapshot,
    action: 'start' | 'stop' | 'restart'
  ) => {
    setActionError(null);
    setBusyKey(`${sidecar.namespacedId}:${action}`);
    try {
      await onSidecarAction(sidecar.namespacedId, action);
    } catch (err) {
      setActionError(formatDrawerError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const refreshSidecarLogs = async (namespacedId: string) => {
    setActionError(null);
    setLogsLoading((prev) => ({ ...prev, [namespacedId]: true }));
    try {
      const lines = await loadLogsFn(namespacedId, 200);
      setLogsBySidecar((prev) => ({ ...prev, [namespacedId]: lines }));
    } catch (err) {
      setActionError(formatDrawerError(err));
    } finally {
      setLogsLoading((prev) => ({ ...prev, [namespacedId]: false }));
    }
  };

  const handleToggleLogs = async (namespacedId: string) => {
    const nextExpanded = !expandedLogs[namespacedId];
    setExpandedLogs((prev) => ({ ...prev, [namespacedId]: nextExpanded }));
    if (nextExpanded) await refreshSidecarLogs(namespacedId);
  };

  const handleToggleAgent = async (agentId: string) => {
    setActionError(null);
    const enabled = isPluginEnabledForAgent(agentId, plugin.dirId);
    try {
      await onTogglePluginForAgent(agentId, plugin.dirId, !enabled);
    } catch (err) {
      setActionError(formatDrawerError(err));
    }
  };

  const handleUninstall = async () => {
    if (!plugin.canUninstall || busyKey === 'uninstall') return;
    setActionError(null);
    setBusyKey('uninstall');
    try {
      await onUninstall(plugin.dirId);
      onClose();
    } catch (err) {
      setActionError(formatDrawerError(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Sheet
      open={isOpen}
      onCancel={onClose}
      width={620}
      title={title}
      secondary={{ label: 'Cerrar', onClick: onClose }}
      description={
        <div className="installed-drawer__header-meta">
          <div className="installed-drawer__header-badges">
            <span aria-hidden="true" className="installed-plugin-card__tile">
              {plugin.logoDataUri && !logoError ? (
                <img
                  alt=""
                  className="installed-plugin-card__logo"
                  src={plugin.logoDataUri}
                  onError={() => setLogoError(true)}
                />
              ) : (
                <PuzzleIcon size={16} />
              )}
            </span>
            {plugin.version ? (
              <span className="installed-drawer__chip installed-drawer__chip--mono">{plugin.version}</span>
            ) : null}
            <span className={`installed-plugin-card__source installed-plugin-card__source--${plugin.source}`}>
              {sourceLabel}
            </span>
            <span className="installed-drawer__chip">{getFormatLabel(plugin.format)}</span>
          </div>

          <div className="installed-drawer__header-switch">
            <span className={`installed-drawer__status-pill${plugin.enabled ? ' installed-drawer__status-pill--active' : ''}`}>
              <i aria-hidden="true" className="installed-drawer__status-dot" />
              {plugin.enabled ? 'Habilitada' : 'Deshabilitada'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={plugin.enabled}
              aria-label={`${plugin.enabled ? 'Desactivar' : 'Activar'} ${title}`}
              className="ui-switch"
              disabled={busyKey === 'toggle-plugin'}
              onClick={handleToggleExtension}
            >
              <span className="ui-switch__knob" />
            </button>
          </div>
        </div>
      }
    >
      <div className="installed-drawer">
        {actionError ? (
          <div role="alert" className="installed-drawer__error">
            <span>{actionError}</span>
          </div>
        ) : null}

        <section className="installed-drawer__section">
          <h3 className="installed-drawer__section-title">Información general</h3>
          <p className="installed-drawer__description">
            {plugin.description || 'Sin descripción disponible en el manifiesto.'}
          </p>

          <dl className="installed-drawer__meta-grid">
            {plugin.author ? (
              <div className="installed-drawer__meta-item">
                <dt>Autor</dt>
                <dd>{plugin.author}</dd>
              </div>
            ) : null}
            {plugin.license ? (
              <div className="installed-drawer__meta-item">
                <dt>Licencia</dt>
                <dd>{plugin.license}</dd>
              </div>
            ) : null}
            <div className="installed-drawer__meta-item installed-drawer__meta-item--wide">
              <dt>Ruta</dt>
              <dd className="installed-drawer__mono-value" title={plugin.rootPath}>
                {plugin.rootPath}
              </dd>
            </div>
          </dl>

          {repoUrl || homeUrl ? (
            <div className="installed-drawer__links">
              {repoUrl ? (
                <a href={repoUrl} target="_blank" rel="noreferrer" className="installed-drawer__link">
                  <span>Repositorio</span>
                  <ExternalLinkIcon size={12} />
                </a>
              ) : null}
              {homeUrl ? (
                <a href={homeUrl} target="_blank" rel="noreferrer" className="installed-drawer__link">
                  <span>Sitio web</span>
                  <ExternalLinkIcon size={12} />
                </a>
              ) : null}
            </div>
          ) : null}

          {plugin.keywords.length > 0 ? (
            <div className="installed-drawer__tags">
              {plugin.keywords.map((kw) => (
                <span key={kw} className="installed-drawer__tag">{kw}</span>
              ))}
            </div>
          ) : null}

          {plugin.suggestedPrompts.length > 0 ? (
            <div className="installed-drawer__prompts">
              <span className="installed-drawer__sublabel">Prompts sugeridos</span>
              <ul className="installed-drawer__prompt-list">
                {plugin.suggestedPrompts.map((prompt) => (
                  <li key={prompt} className="installed-drawer__prompt-item">{prompt}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="installed-drawer__section">
          <h3 className="installed-drawer__section-title">Sidecars ({plugin.sidecars.length})</h3>
          {plugin.sidecars.length === 0 ? (
            <p className="installed-drawer__empty">Esta extensión no declara servicios sidecar.</p>
          ) : (
            <div className="installed-drawer__list">
              {plugin.sidecars.map((sidecar) => {
                const active = isSidecarActive(sidecar.state);
                const logsOpen = Boolean(expandedLogs[sidecar.namespacedId]);
                const logs = logsBySidecar[sidecar.namespacedId] ?? [];
                const isBusy = busyKey?.startsWith(`${sidecar.namespacedId}:`) ?? false;

                return (
                  <div key={sidecar.namespacedId} className="installed-drawer__sidecar-card">
                    <div className="installed-drawer__sidecar-head">
                      <div className="installed-drawer__sidecar-copy">
                        <strong>{sidecar.displayName || sidecar.sidecarId}</strong>
                        <span className="installed-drawer__sidecar-id">
                          {sidecar.namespacedId}
                          {sidecar.proxyPort ? ` · :${sidecar.proxyPort}` : ''}
                        </span>
                      </div>
                      <span className={`installed-drawer__state-badge installed-drawer__state-badge--${sidecar.state}`}>
                        <i aria-hidden="true" className="installed-drawer__status-dot" />
                        {getSidecarStateLabel(sidecar.state)}
                      </span>
                    </div>

                    {sidecar.description ? (
                      <p className="installed-drawer__sidecar-desc">{sidecar.description}</p>
                    ) : null}
                    {sidecar.lastError ? (
                      <p className="installed-drawer__sidecar-err">{sidecar.lastError}</p>
                    ) : null}

                    <div className="installed-drawer__sidecar-actions">
                      {sidecar.hasWebUi && plugin.enabled ? (
                        <button
                          type="button"
                          className="primary-button installed-drawer__action-btn"
                          onClick={() => dispatchOpenRightDockSidecar(sidecar)}
                        >
                          Abrir panel
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="secondary-button installed-drawer__action-btn"
                        disabled={!plugin.enabled || isBusy}
                        title={plugin.enabled ? undefined : 'Habilita la extensión para controlar el sidecar.'}
                        onClick={() => handleSidecarCommand(sidecar, active ? 'stop' : 'start')}
                      >
                        {active ? 'Detener' : 'Iniciar'}
                      </button>
                      <button
                        type="button"
                        className="secondary-button installed-drawer__action-btn"
                        disabled={!plugin.enabled || isBusy}
                        onClick={() => handleSidecarCommand(sidecar, 'restart')}
                      >
                        Reiniciar
                      </button>
                      <button
                        type="button"
                        className="ghost-button installed-drawer__action-btn"
                        aria-expanded={logsOpen}
                        onClick={() => handleToggleLogs(sidecar.namespacedId)}
                      >
                        {logsOpen ? 'Ocultar logs' : 'Ver logs'}
                      </button>
                    </div>

                    {logsOpen ? (
                      <div className="installed-drawer__logs-panel">
                        <div className="installed-drawer__logs-bar">
                          <span title={sidecar.logPath}>{sidecar.logPath}</span>
                          <button
                            type="button"
                            className="ghost-button installed-drawer__logs-refresh"
                            disabled={Boolean(logsLoading[sidecar.namespacedId])}
                            onClick={() => refreshSidecarLogs(sidecar.namespacedId)}
                          >
                            <RefreshIcon size={12} />
                            <span>Actualizar</span>
                          </button>
                        </div>
                        <pre className="installed-drawer__logs-pre">
                          {logsLoading[sidecar.namespacedId]
                            ? 'Cargando logs...'
                            : logs.length > 0
                              ? logs.join('\n')
                              : 'Sin entradas de log todavía.'}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="installed-drawer__section">
          <h3 className="installed-drawer__section-title">Capacidades</h3>
          <div className="installed-drawer__cap-grid">
            <div className="installed-drawer__cap-block">
              <span className="installed-drawer__sublabel">Skills ({plugin.skills.length})</span>
              {plugin.skills.length === 0 ? (
                <p className="installed-drawer__empty">Ninguna skill declarada.</p>
              ) : (
                <ul className="installed-drawer__cap-list">
                  {plugin.skills.map((skill) => (
                    <li key={skill.id} className="installed-drawer__cap-item">
                      <strong>{skill.name}</strong>
                      {skill.description ? <small>{skill.description}</small> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="installed-drawer__cap-block">
              <span className="installed-drawer__sublabel">Servidores MCP ({plugin.mcpServers.length})</span>
              {plugin.mcpServers.length === 0 ? (
                <p className="installed-drawer__empty">Sin servidores MCP.</p>
              ) : (
                <ul className="installed-drawer__cap-list">
                  {plugin.mcpServers.map((mcp) => (
                    <li key={mcp.id} className="installed-drawer__cap-row">
                      <span>{mcp.id}</span>
                      <span className="installed-drawer__chip">{mcp.transport}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="installed-drawer__cap-block">
              <span className="installed-drawer__sublabel">Reglas ({plugin.ruleNames.length})</span>
              {plugin.ruleNames.length === 0 ? (
                <p className="installed-drawer__empty">Sin reglas declaradas.</p>
              ) : (
                <div className="installed-drawer__tags">
                  {plugin.ruleNames.map((rule) => (
                    <span key={rule} className="installed-drawer__tag">{rule}</span>
                  ))}
                </div>
              )}
            </div>

            <div className="installed-drawer__cap-block">
              <span className="installed-drawer__sublabel">
                Perfiles de agente ({plugin.agentSlugs.length}) · Lifecycle Hooks
              </span>
              <div className="installed-drawer__tags">
                <span className={`installed-drawer__tag${plugin.hasHooks ? ' installed-drawer__tag--accent' : ''}`}>
                  {plugin.hasHooks ? 'Hooks activos' : 'Sin hooks'}
                </span>
                {plugin.agentSlugs.map((slug) => (
                  <span key={slug} className="installed-drawer__tag">{slug}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="installed-drawer__section">
          <h3 className="installed-drawer__section-title">Agentes ({agents.length})</h3>
          {agents.length === 0 ? (
            <p className="installed-drawer__empty">No hay agentes registrados en este espacio de trabajo.</p>
          ) : (
            <div className="installed-drawer__list">
              {agents.map((agent) => {
                const enabledForAgent = isPluginEnabledForAgent(agent.id, plugin.dirId);
                const engineName = getEngineDisplayName(agent.engine);
                return (
                  <div key={agent.id} className="installed-drawer__agent-row">
                    <div className="installed-drawer__agent-info">
                      <AgentAvatar id={agent.id} name={agent.name} avatar={agent.avatar} size={28} />
                      <div>
                        <strong className="installed-drawer__agent-name">{agent.name}</strong>
                        <div className="installed-drawer__agent-engine">
                          <EngineBrandLogo engine={agent.engine} size={14} label={engineName} />
                          <span>{engineName}</span>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`Habilitar ${title} para ${agent.name}`}
                      aria-checked={enabledForAgent}
                      className="ui-switch"
                      onClick={() => handleToggleAgent(agent.id)}
                    >
                      <span className="ui-switch__knob" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <footer className="installed-drawer__footer-zone">
          <button
            type="button"
            className="danger-button installed-drawer__uninstall-btn"
            disabled={!plugin.canUninstall || busyKey === 'uninstall'}
            title={
              plugin.canUninstall
                ? 'Desinstalar esta extensión de Kite'
                : 'Las extensiones de workspace o raíces compartidas del sistema son de solo lectura.'
            }
            onClick={handleUninstall}
          >
            {busyKey === 'uninstall' ? 'Desinstalando...' : 'Desinstalar'}
          </button>
          {!plugin.canUninstall ? (
            <span className="installed-drawer__readonly-note">
              Solo lectura ({sourceLabel}) — no se puede desinstalar desde Kite.
            </span>
          ) : null}
        </footer>
      </div>
    </Sheet>
  );
};
