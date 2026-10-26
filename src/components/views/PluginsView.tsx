import React, { useState, useMemo, useCallback } from 'react';
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
  const filteredPlugins = useMemo(() => {
    return filterPlugins(sortedPlugins, searchQuery, selectedCategory, statusFilter, connectionsMap);
  }, [sortedPlugins, searchQuery, selectedCategory, statusFilter, connectionsMap]);

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
              aria-label="Search plugins"
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) {
                  e.preventDefault();
                  setSearchQuery('');
                }
              }}
              placeholder="Search plugins by name, vendor, capabilities..."
              type="search"
              value={searchQuery}
            />
            {searchQuery ? (
              <button
                aria-label="Clear search"
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
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              padding: '2px',
              borderRadius: '6px',
              border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
            }}
          >
            {(
              [
                { id: 'all', label: `All (${OFFICIAL_PLUGINS.length})` },
                { id: 'installed', label: `Installed (${installedCount})` },
                { id: 'available', label: 'Available' },
              ] as const
            ).map((s) => {
              const active = statusFilter === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStatusFilter(s.id)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    border: 0,
                    backgroundColor: active ? 'rgba(92, 143, 255, 0.2)' : 'transparent',
                    color: active ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #9da2b4)',
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
              { id: 'all', label: 'All Categories' },
              { id: 'developer', label: 'Developer Tools' },
              { id: 'productivity', label: 'Productivity' },
              { id: 'creative', label: 'Creative & 3D' },
              { id: 'marketing', label: 'Social & Marketing' },
              { id: 'finance', label: 'Finance & Commerce' },
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
                  borderRadius: '14px',
                  border: active
                    ? '1px solid var(--accent, #5c8fff)'
                    : '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
                  backgroundColor: active
                    ? 'rgba(92, 143, 255, 0.16)'
                    : 'var(--block-fill, rgba(255, 255, 255, 0.03))',
                  color: active ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #9da2b4)',
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
            ? `No plugins match “${searchQuery.trim()}”.`
            : 'No plugins match the selected filter.'}
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
        Connect once to Kite. Choose each agent’s plugins in Agent Settings. Its access mode controls approvals; Read only keeps plugins read-only.
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
          <small>Connect accounts for your agents.</small>
        </span>

        {/* Global info pill */}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '11px',
            color: 'var(--text-secondary, #9da2b4)',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            padding: '2px 8px',
            borderRadius: '12px',
            border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          <LayersIcon size={12} />
          <span>29 authentic integrations</span>
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
