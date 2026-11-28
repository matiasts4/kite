import React, { useState, useMemo, useCallback, useDeferredValue, useEffect, useRef } from 'react';
import type {
  ActivePlugin,
  OfficialPlugin,
  PluginCategory,
  PluginConfig,
  PluginConnection,
  PluginConnectionState,
} from './plugins/types';
import type { PluginRecordDto } from '../../lib/ipc/pluginRuntime';
import { OFFICIAL_PLUGINS } from './plugins/catalog';
import { PluginCard } from './plugins/PluginCard';
import { PluginDetailsDrawer } from './plugins/PluginDetailsDrawer';
import { InstalledPluginCard } from './plugins/InstalledPluginCard';
import { InstalledPluginDrawer } from './plugins/InstalledPluginDrawer';
import { InstallPluginModal } from './plugins/InstallPluginModal';
import { PluginCatalogTab } from './plugins/PluginCatalogTab';
import {
  PuzzleIcon,
  SearchIcon,
  ClearIcon,
  LayersIcon,
  RefreshIcon,
} from './plugins/pluginIcons';
import { usePluginConnections } from './plugins/usePluginConnections';
import { useAgentPluginCoverage } from './plugins/useAgentPluginCoverage';
import { useInstalledPlugins } from './plugins/useInstalledPlugins';
import './plugins/plugins.css';

export interface PluginsViewProps {
  embedded?: boolean;
}

const PlusIcon: React.FC = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

export function isConnectionActiveOrPending(state?: PluginConnectionState): boolean {
  return state === 'connected' || state === 'needsReauth' || state === 'disconnectPending';
}

export function sortPlugins(
  plugins: readonly OfficialPlugin[],
  connectionsMap: Map<string, PluginConnection>
): OfficialPlugin[] {
  return [...plugins].sort((a, b) => {
    const connA = connectionsMap.get(a.id);
    const connB = connectionsMap.get(b.id);
    const stateA = connA?.state ?? a.initialState;
    const stateB = connB?.state ?? b.initialState;

    const aActive = isConnectionActiveOrPending(stateA);
    const bActive = isConnectionActiveOrPending(stateB);

    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

export function filterPlugins(
  plugins: readonly OfficialPlugin[],
  searchQuery: string,
  category: 'all' | PluginCategory = 'all',
  statusFilter: 'all' | 'installed' | 'available' = 'all',
  connectionsMap?: Map<string, PluginConnection>
): OfficialPlugin[] {
  let list = plugins;

  if (category !== 'all') {
    list = list.filter((p) => p.category === category);
  }

  if (statusFilter !== 'all' && connectionsMap) {
    if (statusFilter === 'installed') {
      list = list.filter((p) => connectionsMap.get(p.id)?.state === 'connected');
    } else if (statusFilter === 'available') {
      list = list.filter((p) => connectionsMap.get(p.id)?.state !== 'connected');
    }
  }

  const query = searchQuery.trim().toLowerCase();
  if (!query) return [...list];

  const tokens = query.split(/\s+/).filter(Boolean);
  return list.filter((p) => {
    const name = p.name.toLowerCase();
    const vendor = p.vendor.toLowerCase();
    const summary = p.summary.toLowerCase();
    return tokens.every(
      (token) => name.includes(token) || vendor.includes(token) || summary.includes(token)
    );
  });
}

export function filterInstalledPlugins(
  plugins: readonly PluginRecordDto[],
  searchQuery: string
): PluginRecordDto[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return [...plugins];

  const tokens = query.split(/\s+/).filter(Boolean);
  return plugins.filter((plugin) => {
    const haystack = [
      plugin.displayName,
      plugin.name,
      plugin.description,
      plugin.author ?? '',
      ...plugin.keywords,
      ...plugin.skills.map((s) => `${s.name} ${s.description}`),
      ...plugin.mcpServers.map((m) => `${m.id} ${m.serverName}`),
      ...plugin.sidecars.map((s) => `${s.displayName} ${s.sidecarId}`),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export const PluginsView: React.FC<PluginsViewProps> = ({ embedded = false }) => {
  const [activeMode, setActiveMode] = useState<'extensions' | 'catalog' | 'connectors'>('connectors');
  const userSelectedModeRef = useRef(false);
  const didAutoSwitchRef = useRef(false);

  const [connectorSearchQuery, setConnectorSearchQuery] = useState('');
  const [extensionSearchQuery, setExtensionSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | PluginCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'installed' | 'available'>('all');
  const [activeDrawerPlugin, setActiveDrawerPlugin] = useState<ActivePlugin | null>(null);
  const [activeInstalledDirId, setActiveInstalledDirId] = useState<string | null>(null);
  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);
  const [connectorError, setConnectorError] = useState<string | null>(null);
  const [savingRoots, setSavingRoots] = useState(false);

  const { connections, action } = usePluginConnections();
  const coverage = useAgentPluginCoverage();
  const installedRuntime = useInstalledPlugins();

  useEffect(() => {
    if (
      !didAutoSwitchRef.current &&
      !userSelectedModeRef.current &&
      installedRuntime.plugins.length > 0
    ) {
      didAutoSwitchRef.current = true;
      setActiveMode('extensions');
    }
  }, [installedRuntime.plugins.length]);

  const handleSelectMode = useCallback((mode: 'extensions' | 'catalog' | 'connectors') => {
    userSelectedModeRef.current = true;
    setActiveMode(mode);
  }, []);

  const connectionsMap = useMemo(() => {
    return new Map<string, PluginConnection>(connections.map((c) => [c.id, c]));
  }, [connections]);

  const installedCount = useMemo(() => {
    return connections.filter((c) => c.state === 'connected').length;
  }, [connections]);

  const sortedPlugins = useMemo(() => {
    return sortPlugins(OFFICIAL_PLUGINS, connectionsMap);
  }, [connectionsMap]);

  const deferredConnectorSearch = useDeferredValue(connectorSearchQuery);
  const filteredPlugins = useMemo(() => {
    return filterPlugins(
      sortedPlugins,
      deferredConnectorSearch,
      selectedCategory,
      statusFilter,
      connectionsMap
    );
  }, [sortedPlugins, deferredConnectorSearch, selectedCategory, statusFilter, connectionsMap]);

  const deferredExtensionSearch = useDeferredValue(extensionSearchQuery);
  const filteredExtensions = useMemo(() => {
    return filterInstalledPlugins(installedRuntime.plugins, deferredExtensionSearch);
  }, [installedRuntime.plugins, deferredExtensionSearch]);

  const activeInstalledPlugin = useMemo(() => {
    if (!activeInstalledDirId) return null;
    return installedRuntime.plugins.find((p) => p.dirId === activeInstalledDirId) ?? null;
  }, [installedRuntime.plugins, activeInstalledDirId]);

  const handleToggleFromDrawer = useCallback(
    (plugin: ActivePlugin) => {
      const conn = connectionsMap.get(plugin.id);
      const isConnected = conn?.state === 'connected';
      setConnectorError(null);
      action(plugin.id, isConnected ? 'disconnect' : 'connect').catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[PluginsView] Connector toggle failed:', err);
        setConnectorError(message);
      });
    },
    [action, connectionsMap]
  );

  const handleSaveConfig = useCallback((_pluginId: string, _config: PluginConfig) => {
    // Config persistence is handled via PluginDetailsDrawer IPC
  }, []);

  const handleToggleSharedRoots = async () => {
    if (savingRoots) return;
    setSavingRoots(true);
    try {
      await installedRuntime.updateSettings({
        ...installedRuntime.settings,
        enableSharedSystemRoots: !installedRuntime.settings.enableSharedSystemRoots,
      });
    } catch (err) {
      console.warn('[PluginsView] Failed to toggle shared system roots:', err);
    } finally {
      setSavingRoots(false);
    }
  };

  const handleInstallFolder = async (path: string) => {
    const installed = await installedRuntime.installFolder(path);
    handleSelectMode('extensions');
    return installed;
  };

  const handleInstallGit = async (
    repoUrl: string,
    opts?: { gitRef?: string; subdir?: string }
  ) => {
    const installed = await installedRuntime.installGit(repoUrl, opts);
    handleSelectMode('extensions');
    return installed;
  };

  const handleInstallArchive = async (path: string) => {
    const installed = await installedRuntime.installArchive(path);
    handleSelectMode('extensions');
    return installed;
  };

  const catalogueContent = (
    <div className="plugin-catalogue">
      {/* Top Mode Switcher + Install CTA */}
      <div className="plugin-mode-bar">
        <div
          role="tablist"
          aria-label="Secciones de plugins"
          className="plugin-mode-switcher"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === 'extensions'}
            className={`plugin-mode-switcher__tab${
              activeMode === 'extensions' ? ' plugin-mode-switcher__tab--active' : ''
            }`}
            onClick={() => handleSelectMode('extensions')}
          >
            Extensiones ({installedRuntime.plugins.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === 'catalog'}
            className={`plugin-mode-switcher__tab${
              activeMode === 'catalog' ? ' plugin-mode-switcher__tab--active' : ''
            }`}
            onClick={() => handleSelectMode('catalog')}
          >
            Catálogo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === 'connectors'}
            className={`plugin-mode-switcher__tab${
              activeMode === 'connectors' ? ' plugin-mode-switcher__tab--active' : ''
            }`}
            onClick={() => handleSelectMode('connectors')}
          >
            Conectores ({OFFICIAL_PLUGINS.length})
          </button>
        </div>

        <button
          type="button"
          className="primary-button plugin-install-btn"
          onClick={() => setIsInstallModalOpen(true)}
        >
          <PlusIcon />
          <span>+ Instalar extensión</span>
        </button>
      </div>

      {activeMode === 'extensions' ? (
        <>
          {/* Extensions Search + Shared Roots + Refresh */}
          <div className="plugin-toolbar">
            <div className="plugin-toolbar__row">
              <label className="plugin-search plugin-toolbar__search">
                <SearchIcon size={13} />
                <input
                  aria-label="Buscar extensiones"
                  onChange={(e) => setExtensionSearchQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && extensionSearchQuery) {
                      e.preventDefault();
                      setExtensionSearchQuery('');
                    }
                  }}
                  placeholder="Buscar extensiones por nombre, descripción o capacidades..."
                  type="search"
                  value={extensionSearchQuery}
                />
                {extensionSearchQuery ? (
                  <button
                    aria-label="Limpiar búsqueda de extensiones"
                    onClick={() => setExtensionSearchQuery('')}
                    type="button"
                  >
                    <ClearIcon size={12} />
                  </button>
                ) : null}
              </label>

              <div className="plugin-extensions-actions">
                <div className="plugin-roots-toggle">
                  <span>Raíces compartidas del sistema</span>
                  <button
                    type="button"
                    role="switch"
                    aria-label="Activar raíces compartidas del sistema"
                    aria-checked={installedRuntime.settings.enableSharedSystemRoots}
                    className="ui-switch"
                    disabled={savingRoots}
                    onClick={() => void handleToggleSharedRoots()}
                  >
                    <span className="ui-switch__knob" />
                  </button>
                </div>

                <button
                  type="button"
                  className="secondary-button plugin-refresh-btn"
                  disabled={installedRuntime.loading}
                  onClick={() => void installedRuntime.refresh(true)}
                >
                  <RefreshIcon size={12} />
                  <span>Actualizar</span>
                </button>
              </div>
            </div>
          </div>

          {installedRuntime.error ? (
            <div role="alert" className="plugin-error-banner">
              <span>{installedRuntime.error}</span>
            </div>
          ) : null}

          {installedRuntime.plugins.length === 0 ? (
            <div className="plugin-empty-card">
              <span aria-hidden="true" className="plugin-empty-card__icon">
                <PuzzleIcon size={18} />
              </span>
              <h3 className="plugin-empty-card__title">
                {installedRuntime.loading
                  ? 'Buscando extensiones instaladas...'
                  : 'No hay extensiones instaladas todavía'}
              </h3>
              <p className="plugin-empty-card__copy">
                Instala bundles locales, repositorios Git o paquetes .zip con sidecars Web UI, herramientas MCP, skills, reglas y perfiles de agente.
              </p>
              {!installedRuntime.loading ? (
                <button
                  type="button"
                  className="primary-button plugin-install-btn"
                  onClick={() => setIsInstallModalOpen(true)}
                >
                  + Instalar extensión
                </button>
              ) : null}
            </div>
          ) : filteredExtensions.length === 0 ? (
            <p className="plugin-grid__empty">
              {`Ninguna extensión coincide con “${extensionSearchQuery.trim()}”.`}
            </p>
          ) : (
            <div className="installed-plugin-grid">
              {filteredExtensions.map((plugin) => (
                <InstalledPluginCard
                  key={plugin.dirId}
                  plugin={plugin}
                  onOpenDetails={(item) => setActiveInstalledDirId(item.dirId)}
                  onToggleEnabled={installedRuntime.toggleEnabled}
                />
              ))}
            </div>
          )}

          <InstalledPluginDrawer
            plugin={activeInstalledPlugin}
            isOpen={Boolean(activeInstalledPlugin)}
            onClose={() => setActiveInstalledDirId(null)}
            onToggleEnabled={installedRuntime.toggleEnabled}
            onSidecarAction={installedRuntime.runSidecar}
            onFetchLogs={installedRuntime.getLogs}
            onUninstall={installedRuntime.uninstall}
            agents={coverage.agents}
            isPluginEnabledForAgent={coverage.isPluginEnabledForAgent}
            onTogglePluginForAgent={coverage.togglePluginForAgent}
          />
        </>
      ) : activeMode === 'catalog' ? (
        <PluginCatalogTab onInstalled={() => void installedRuntime.refresh(true)} />
      ) : (
        <>
          {/* Search & Category Filter Toolbar */}
          <div className="plugin-toolbar">
            <div className="plugin-toolbar__row">
              <label className="plugin-search plugin-toolbar__search">
                <SearchIcon size={13} />
                <input
                  aria-label="Buscar plugins"
                  onChange={(e) => setConnectorSearchQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && connectorSearchQuery) {
                      e.preventDefault();
                      setConnectorSearchQuery('');
                    }
                  }}
                  placeholder="Buscar plugins por nombre, proveedor o capacidades..."
                  type="search"
                  value={connectorSearchQuery}
                />
                {connectorSearchQuery ? (
                  <button
                    aria-label="Limpiar búsqueda"
                    onClick={() => setConnectorSearchQuery('')}
                    type="button"
                  >
                    <ClearIcon size={12} />
                  </button>
                ) : null}
              </label>

              {/* Status filter chips */}
              <div className="plugin-status-chips">
                {(
                  [
                    { id: 'all', label: `Todos (${OFFICIAL_PLUGINS.length})` },
                    { id: 'installed', label: `Instalados (${installedCount})` },
                    { id: 'available', label: 'Disponibles' },
                  ] as const
                ).map((s) => {
                  const active = statusFilter === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStatusFilter(s.id)}
                      className={`plugin-status-chips__btn${
                        active ? ' plugin-status-chips__btn--active' : ''
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Category Pills */}
            <div className="plugin-category-strip">
              {(
                [
                  { id: 'all', label: 'Todas las categorías' },
                  { id: 'developer', label: 'Herramientas de desarrollo' },
                  { id: 'productivity', label: 'Productividad' },
                  { id: 'creative', label: 'Creatividad y 3D' },
                  { id: 'marketing', label: 'Redes y marketing' },
                  { id: 'finance', label: 'Finanzas y comercio' },
                ] as const
              ).map((cat) => {
                const active = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`plugin-category-pill${
                      active ? ' plugin-category-pill--active' : ''
                    }`}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </div>

          {connectorError ? (
            <div role="alert" className="plugin-error-banner">
              <span>{connectorError}</span>
            </div>
          ) : null}

          {/* Grid of 29 Canonical Plugins */}
          {filteredPlugins.length === 0 ? (
            <p className="plugin-grid__empty">
              {connectorSearchQuery.trim()
                ? `Ningún plugin coincide con “${connectorSearchQuery.trim()}”.`
                : 'Ningún plugin coincide con el filtro seleccionado.'}
            </p>
          ) : (
            <div className="plugin-grid plugin-grid--spaced">
              {filteredPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  connection={connectionsMap.get(plugin.id)}
                  onAction={action}
                  onOpenDetails={(p) => setActiveDrawerPlugin(p as ActivePlugin)}
                />
              ))}
            </div>
          )}

          {/* Canonical Footnote */}
          <p className="plugin-pane__footnote plugin-pane__footnote--spaced">
            Conecta una sola vez en Kite. Elige los plugins de cada agente en Ajustes del Agente. Su modo de acceso controla las aprobaciones; Solo lectura mantiene los plugins en modo de solo lectura.
          </p>

          {/* Plugin Details & Settings Drawer */}
          <PluginDetailsDrawer
            plugin={activeDrawerPlugin}
            isOpen={Boolean(activeDrawerPlugin)}
            onClose={() => setActiveDrawerPlugin(null)}
            onToggleStatus={handleToggleFromDrawer}
            onSaveConfig={handleSaveConfig}
            onAction={action}
            connection={activeDrawerPlugin ? connectionsMap.get(activeDrawerPlugin.id) : null}
            agents={coverage.agents}
            isPluginEnabledForAgent={coverage.isPluginEnabledForAgent}
            onTogglePluginForAgent={coverage.togglePluginForAgent}
          />
        </>
      )}

      <InstallPluginModal
        open={isInstallModalOpen}
        onClose={() => setIsInstallModalOpen(false)}
        onInstallFolder={handleInstallFolder}
        onInstallGit={handleInstallGit}
        onInstallArchive={handleInstallArchive}
      />
    </div>
  );

  if (embedded) {
    return catalogueContent;
  }

  return (
    <section className="pane destination-pane plugin-pane select-none">
      <header className="pane-titlebar pane-titlebar--large">
        <span aria-hidden="true" className="pane-titlebar__icon">
          <PuzzleIcon size={16} />
        </span>
        <span className="pane-titlebar__copy">
          <strong>Plugins</strong>
          <small>Extensiones locales, sidecars y conectores.</small>
        </span>

        {/* Global info pill */}
        <span className="plugin-pane__count-pill">
          <LayersIcon size={12} />
          <span>29 integraciones oficiales</span>
        </span>
      </header>
      <div className="plugin-pane__body">
        <div className="plugin-pane__column">{catalogueContent}</div>
      </div>
    </section>
  );
};

export { PluginsView as PluginsPane };
export default PluginsView;
