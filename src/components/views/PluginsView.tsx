import React, { useState, useMemo, useEffect, useCallback } from 'react';
import type {
  ActivePlugin,
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
import { saveShellState, invokeCommand } from '../../lib/ipc';

export interface PluginsViewProps {
  embedded?: boolean;
}

const STORAGE_KEY = 'kite_connected_plugins';
const CONFIGS_KEY = 'kite_plugin_configs';

export const PluginsView: React.FC<PluginsViewProps> = ({ embedded = false }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | PluginCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'installed' | 'available'>('all');
  const [activeDrawerPlugin, setActiveDrawerPlugin] = useState<ActivePlugin | null>(null);

  // Installed plugin IDs
  const [connectedIds, setConnectedIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return new Set<string>(parsed);
      }
    } catch (_) {}
    return new Set<string>();
  });

  // Saved configs
  const [pluginConfigs, setPluginConfigs] = useState<Record<string, PluginConfig>>(() => {
    try {
      const saved = localStorage.getItem(CONFIGS_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (_) {}
    return {};
  });

  // Re-read storage on mount for freshness across windows/reloads
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setConnectedIds(new Set<string>(parsed));
        }
      }
      const savedConfigs = localStorage.getItem(CONFIGS_KEY);
      if (savedConfigs) {
        setPluginConfigs(JSON.parse(savedConfigs));
      }
    } catch (_) {}
  }, []);

  // Persist state to Tauri shell state and localStorage
  const persistState = useCallback(
    (newConnected: Set<string>, newConfigs?: Record<string, PluginConfig>) => {
      const list = Array.from(newConnected);
      const configs = newConfigs ?? pluginConfigs;

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        if (newConfigs) {
          localStorage.setItem(CONFIGS_KEY, JSON.stringify(newConfigs));
        }
      } catch (_) {}

      // Tauri shell state persistence
      saveShellState({ plugins: list, pluginConfigs: configs }).catch(() => {});
      invokeCommand('save_shell_state', { key: 'plugins', value: list }).catch(() => {});
    },
    [pluginConfigs]
  );

  // Toggle Install / Enable status
  const handleToggleStatus = useCallback(
    (plugin: ActivePlugin) => {
      if (plugin.initialState === 'unavailable') return;

      setConnectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(plugin.id)) {
          next.delete(plugin.id);
        } else {
          next.add(plugin.id);
        }
        persistState(next);
        return next;
      });

      // Also update currently open drawer plugin if open
      setActiveDrawerPlugin((current) => {
        if (!current || current.id !== plugin.id) return current;
        const willBeInstalled = !connectedIds.has(plugin.id);
        return {
          ...current,
          status: willBeInstalled ? 'installed' : 'available',
        };
      });
    },
    [connectedIds, persistState]
  );

  // Save Plugin Configuration
  const handleSaveConfig = useCallback(
    (pluginId: string, config: PluginConfig) => {
      setPluginConfigs((prev) => {
        const next = { ...prev, [pluginId]: config };
        persistState(connectedIds, next);
        return next;
      });

      setActiveDrawerPlugin((current) => {
        if (!current || current.id !== pluginId) return current;
        return {
          ...current,
          config,
        };
      });
    },
    [connectedIds, persistState]
  );

  // Build active plugins list
  const activePlugins: ActivePlugin[] = useMemo(() => {
    return OFFICIAL_PLUGINS.map((plugin) => {
      const isConnected = connectedIds.has(plugin.id);
      const config = pluginConfigs[plugin.id];
      const status = isConnected
        ? 'installed'
        : plugin.initialState === 'unavailable'
        ? 'disabled'
        : 'available';

      return {
        ...plugin,
        status,
        config,
      };
    });
  }, [connectedIds, pluginConfigs]);

  // Sort and filter plugins:
  // Installed first, then alphabetically by name. Filter tokens on name, vendor, summary.
  const filteredPlugins = useMemo(() => {
    // 1. Alphabetical sort
    const alphabetical = [...activePlugins].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    );

    // 2. Installed first
    const prioritized = [
      ...alphabetical.filter((p) => p.status === 'installed'),
      ...alphabetical.filter((p) => p.status !== 'installed'),
    ];

    return prioritized.filter((p) => {
      // Category filter
      if (selectedCategory !== 'all' && p.category !== selectedCategory) {
        return false;
      }

      // Status filter
      if (statusFilter === 'installed' && p.status !== 'installed') {
        return false;
      }
      if (statusFilter === 'available' && p.status === 'installed') {
        return false;
      }

      // Search tokens
      if (searchQuery.trim()) {
        const tokens = searchQuery
          .toLowerCase()
          .split(/\s+/u)
          .filter((t) => t.length > 0);

        const name = p.name.toLowerCase();
        const vendor = p.vendor.toLowerCase();
        const summary = p.summary.toLowerCase();
        const desc = p.description.toLowerCase();
        const cat = p.category.toLowerCase();

        return tokens.every(
          (t) =>
            name.includes(t) ||
            vendor.includes(t) ||
            summary.includes(t) ||
            desc.includes(t) ||
            cat.includes(t)
        );
      }

      return true;
    });
  }, [activePlugins, selectedCategory, statusFilter, searchQuery]);

  const installedCount = useMemo(() => connectedIds.size, [connectedIds]);

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

      {/* Grid of 29 Authentic Plugins */}
      {filteredPlugins.length === 0 ? (
        <p className="plugin-grid__empty">
          No plugins match &quot;{searchQuery.trim()}&quot; in the selected category.
        </p>
      ) : (
        <div className="plugin-grid" style={{ marginTop: '4px' }}>
          {filteredPlugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              onToggleStatus={handleToggleStatus}
              onOpenDetails={(p) => setActiveDrawerPlugin(p)}
              onConnectAction={handleToggleStatus}
            />
          ))}
        </div>
      )}

      {/* Footnote */}
      <p className="plugin-pane__footnote" style={{ marginTop: '12px' }}>
        Connect once to Kite. Choose each agent&apos;s plugins in Agent Settings. Its access mode controls approvals; Read only keeps plugins read-only.
      </p>

      {/* Plugin Details & Settings Drawer */}
      <PluginDetailsDrawer
        plugin={activeDrawerPlugin}
        isOpen={Boolean(activeDrawerPlugin)}
        onClose={() => setActiveDrawerPlugin(null)}
        onToggleStatus={handleToggleStatus}
        onSaveConfig={handleSaveConfig}
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
