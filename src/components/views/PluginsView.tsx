import React, { useState, useMemo, useCallback, useDeferredValue } from 'react';
import type {
  ActivePlugin,
  OfficialPlugin,
  PluginCategory,
  PluginConfig,
} from './plugins/types';
import { OFFICIAL_PLUGINS } from './plugins/catalog';
import { PluginCard } from './plugins/PluginCard';
import { PluginDetailsDrawer } from './plugins/PluginDetailsDrawer';
import {
  PuzzleIcon,
  SearchIcon,
  ClearIcon,
  LayersIcon,
} from './plugins/pluginIcons';
import { usePluginConnections } from './plugins/usePluginConnections';
import { useAgentPluginCoverage } from './plugins/useAgentPluginCoverage';
import type { PluginConnection, PluginConnectionState } from './plugins/types';

export interface PluginsViewProps {
  embedded?: boolean;
}

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

  // Category filter
  if (category !== 'all') {
    list = list.filter((p) => p.category === category);
  }

  // Status filter
  if (statusFilter !== 'all' && connectionsMap) {
    if (statusFilter === 'installed') {
      list = list.filter((p) => connectionsMap.get(p.id)?.state === 'connected');
    } else if (statusFilter === 'available') {
      list = list.filter((p) => connectionsMap.get(p.id)?.state !== 'connected');
    }
  }

  // Search filter across name, vendor, summary
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

export const PluginsView: React.FC<PluginsViewProps> = ({ embedded = false }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | PluginCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'installed' | 'available'>('all');
  const [activeDrawerPlugin, setActiveDrawerPlugin] = useState<ActivePlugin | null>(null);

  const { connections, action } = usePluginConnections();
  const coverage = useAgentPluginCoverage();

  const connectionsMap = useMemo(() => {
    return new Map<string, PluginConnection>(connections.map((c) => [c.id, c]));
  }, [connections]);

  const installedCount = useMemo(() => {
    return connections.filter((c) => c.state === 'connected').length;
  }, [connections]);

  // Dynamic sorting: Active/pending connections first, then alphabetically by name
  const sortedPlugins = useMemo(() => {
    return sortPlugins(OFFICIAL_PLUGINS, connectionsMap);
  }, [connectionsMap]);

  // Live search filtering across name, vendor, summary
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredPlugins = useMemo(() => {
    return filterPlugins(sortedPlugins, deferredSearchQuery, selectedCategory, statusFilter, connectionsMap);
  }, [sortedPlugins, deferredSearchQuery, selectedCategory, statusFilter, connectionsMap]);

  const handleToggleFromDrawer = useCallback(
    (plugin: ActivePlugin) => {
      const conn = connectionsMap.get(plugin.id);
      const isConnected = conn?.state === 'connected';
      action(plugin.id, isConnected ? 'disconnect' : 'connect').catch(() => {});
    },
    [action, connectionsMap]
  );

  const handleSaveConfig = useCallback((_pluginId: string, _config: PluginConfig) => {
    // Config persistence can be saved locally or handled by backend
  }, []);

  const catalogueContent = (
    <div className="plugin-catalogue">
      {/* Search & Category Filter Toolbar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* Search bar */}
          <label className="plugin-search" style={{ flex: 1 }}>
            <SearchIcon size={13} />
            <input
              aria-label="Buscar plugins"
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) {
                  e.preventDefault();
                  setSearchQuery('');
                }
              }}
              placeholder="Buscar plugins por nombre, proveedor o capacidades..."
              type="search"
              value={searchQuery}
            />
            {searchQuery ? (
              <button
                aria-label="Limpiar búsqueda"
                onClick={() => setSearchQuery('')}
                type="button"
              >
                <ClearIcon size={12} />
              </button>
            ) : null}
          </label>

          {/* Status filter chips */}
          <div
            style={{
              display: 'flex',
              gap: '4px',
              backgroundColor: 'var(--glass-elevated-bg, var(--block-fill, transparent))',
              padding: '2px',
              borderRadius: 'var(--control-radius, 8px)',
              border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.08)))',
            }}
          >
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
                  style={{
                    padding: '4px 10px',
                    borderRadius: 'var(--vl-radius-sm, 6px)',
                    border: 0,
                    backgroundColor: active
                      ? 'var(--accent-tint, color-mix(in srgb, var(--accent, #5c8fff) 18%, transparent))'
                      : 'transparent',
                    color: active ? 'var(--text-primary, #fafafa)' : 'var(--text-secondary, #a1a1a1)',
                    fontSize: '11px',
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Category Pills */}
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '2px' }}>
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
                style={{
                  padding: '4px 10px',
                  borderRadius: 'var(--pill-radius, 9999px)',
                  border: active
                    ? '1px solid var(--accent-tint-strong, var(--accent, #5c8fff))'
                    : '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.08)))',
                  backgroundColor: active
                    ? 'var(--accent-tint, color-mix(in srgb, var(--accent, #5c8fff) 16%, transparent))'
                    : 'var(--block-fill, transparent)',
                  color: active ? 'var(--text-primary, #fafafa)' : 'var(--text-secondary, #a1a1a1)',
                  fontSize: '11px',
                  fontWeight: active ? 600 : 400,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  transition: 'all 120ms ease',
                }}
              >
                {cat.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Grid of 29 Canonical Plugins */}
      {filteredPlugins.length === 0 ? (
        <p className="plugin-grid__empty">
          {searchQuery.trim()
            ? `Ningún plugin coincide con “${searchQuery.trim()}”.`
            : 'Ningún plugin coincide con el filtro seleccionado.'}
        </p>
      ) : (
        <div className="plugin-grid" style={{ marginTop: '4px' }}>
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
      <p className="plugin-pane__footnote" style={{ marginTop: '12px' }}>
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
          <small>Conecta cuentas para tus agentes.</small>
        </span>

        {/* Global info pill */}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '11px',
            color: 'var(--text-secondary, #a1a1a1)',
            backgroundColor: 'var(--chip-fill, var(--block-fill, transparent))',
            padding: '2px 8px',
            borderRadius: 'var(--pill-radius, 9999px)',
            border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.08)))',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          <LayersIcon size={12} />
          <span>29 integraciones oficiales</span>
        </span>
      </header>
      <div className="agent-pane__rule" />
      <div className="plugin-pane__body">
        <div className="plugin-pane__column">{catalogueContent}</div>
      </div>
    </section>
  );
};

export { PluginsView as PluginsPane };
export default PluginsView;
