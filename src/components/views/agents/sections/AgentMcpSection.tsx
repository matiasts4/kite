import React, { useState, useEffect, useMemo } from 'react';
import { invokeCommand } from '../../../../lib/ipc';
import { usePluginConnections } from '../../plugins/usePluginConnections';
import { OFFICIAL_PLUGINS } from '../../plugins/catalog';
import { getEngineDisplayName } from '../engineMetadata';
import { engineToChatProvider } from '../../chat/types';
import { PuzzleIcon } from '../agentIcons';

export interface AgentMcpSectionProps {
  engine: string;
  disabledPluginIds: string[];
  readOnly?: boolean;
  saving?: boolean;
  onToggleServer: (serverId: string) => void;
}

export const AgentMcpSection: React.FC<AgentMcpSectionProps> = ({
  engine,
  disabledPluginIds,
  readOnly = false,
  saving = false,
  onToggleServer,
}) => {
  const [allMcpServers, setAllMcpServers] = useState<Array<{
    id: string;
    name: string;
    provider: string;
    providerLabel: string;
    transport?: string;
    status?: string;
    builtin?: boolean;
    description?: string;
    toolCount?: number;
    tools?: string[];
  }>>([]);
  const [mcpScope, setMcpScope] = useState<'provider' | 'all'>('provider');
  const [expandedMcpId, setExpandedMcpId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    invokeCommand<{ allServers?: any[]; servers?: any[] }>('list_provider_mcp_servers', {})
      .then((res) => {
        if (!mounted || !res) return;
        const list = Array.isArray(res.allServers)
          ? res.allServers
          : Array.isArray(res.servers)
            ? res.servers
            : [];
        setAllMcpServers(list);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const currentChatProvider = engineToChatProvider(engine);
  const { connections: pluginConnections } = usePluginConnections();

  const combinedMcpServers = useMemo(() => {
    const pluginMap = new Map(OFFICIAL_PLUGINS.map((p) => [p.id, p]));
    const pluginServers = pluginConnections
      .filter((c) => c.state === 'connected')
      .map((c) => {
        const meta = pluginMap.get(c.id);
        return {
          id: c.id,
          name: meta?.name || c.id,
          provider: 'kite',
          providerLabel: 'Kite Plugin',
          description: c.account ? `${meta?.summary ?? 'Plugin'} (${c.account})` : meta?.summary ?? 'Connected plugin',
          builtin: false,
          toolCount: meta?.permissions?.length ?? 0,
          tools: meta?.permissions ?? [],
        };
      });

    const existingIds = new Set(allMcpServers.map((s) => s.id));
    const uniquePluginServers = pluginServers.filter((s) => !existingIds.has(s.id));
    return [...allMcpServers, ...uniquePluginServers];
  }, [allMcpServers, pluginConnections]);

  const visibleMcpServers = combinedMcpServers.filter((srv) => {
    if (mcpScope === 'all') return true;
    return srv.provider === engine || srv.provider === currentChatProvider || srv.provider === 'kite';
  });

  return (
    <section className="agent-setting-group">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <h2 className="agent-setting-label" style={{ margin: 0 }}>Integrations & MCP Servers</h2>
        {combinedMcpServers.length > 0 && (
          <div style={{ display: 'inline-flex', gap: '4px', background: 'var(--chip-fill)', padding: '2px', borderRadius: '6px', border: '1px solid var(--block-stroke)' }}>
            <button
              type="button"
              className={`secondary-button ${mcpScope === 'provider' ? 'choice-pill--selected' : ''}`}
              style={{ fontSize: '11px', padding: '2px 8px', height: '22px' }}
              onClick={() => setMcpScope('provider')}
            >
              {getEngineDisplayName(engine)} ({combinedMcpServers.filter((s) => s.provider === engine || s.provider === currentChatProvider || s.provider === 'kite').length})
            </button>
            <button
              type="button"
              className={`secondary-button ${mcpScope === 'all' ? 'choice-pill--selected' : ''}`}
              style={{ fontSize: '11px', padding: '2px 8px', height: '22px' }}
              onClick={() => setMcpScope('all')}
            >
              All Providers ({combinedMcpServers.length})
            </button>
          </div>
        )}
      </div>

      {visibleMcpServers.length === 0 ? (
        <div className="ui-card agent-settings__readonly-row agent-settings__empty-row">
          <PuzzleIcon size={14} />
          <span>No plugins connected</span>
        </div>
      ) : (
        <div className="ui-card agent-settings__rows">
          {visibleMcpServers.map((srv) => {
            const isEnabled = !disabledPluginIds.includes(srv.id);
            const isExpanded = expandedMcpId === srv.id;
            const tools = Array.isArray(srv.tools) ? srv.tools : [];
            return (
              <div key={srv.id} style={{ borderBottom: '1px solid var(--block-stroke)' }}>
                <div className="agent-settings__row" style={{ borderBottom: 'none' }}>
                  <span className="agent-settings__row-copy" style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <strong>{srv.name}</strong>
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '1px 6px',
                          borderRadius: '999px',
                          background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                          color: 'var(--accent)',
                          fontWeight: 600,
                        }}
                      >
                        {srv.providerLabel || srv.provider}
                      </span>
                      {typeof srv.toolCount === 'number' && srv.toolCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setExpandedMcpId(isExpanded ? null : srv.id)}
                          style={{
                            fontSize: '10px',
                            padding: '1px 6px',
                            borderRadius: '999px',
                            background: 'var(--chip-fill)',
                            border: '1px solid var(--block-stroke)',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                          }}
                          title="Inspect MCP tools"
                        >
                          {srv.toolCount} tools {isExpanded ? '▴' : '▾'}
                        </button>
                      )}
                    </span>
                    <small>{srv.description || 'Native MCP server integration'}</small>
                  </span>
                  <span className="agent-settings__control">
                    <button
                      type="button"
                      role="switch"
                      aria-label={`Enable ${srv.name} for this agent`}
                      aria-checked={isEnabled}
                      className="ui-switch"
                      disabled={readOnly || saving}
                      onClick={() => onToggleServer(srv.id)}
                    >
                      <span aria-hidden="true" className="ui-switch__knob" />
                    </button>
                  </span>
                </div>
                {isExpanded && tools.length > 0 && (
                  <div
                    style={{
                      padding: '0 14px 10px 14px',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '4px',
                    }}
                  >
                    {tools.slice(0, 36).map((t) => (
                      <code
                        key={t}
                        style={{
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: 'var(--chip-fill)',
                          border: '1px solid var(--block-stroke)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {t}
                      </code>
                    ))}
                    {tools.length > 36 && (
                      <small style={{ fontSize: '10px', color: 'var(--text-tertiary)', alignSelf: 'center' }}>
                        +{tools.length - 36} more
                      </small>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="agent-setting-hint">
        Native MCP servers are grouped by provider ({getEngineDisplayName(engine)}) and can be toggled individually per agent.
      </p>
    </section>
  );
};
