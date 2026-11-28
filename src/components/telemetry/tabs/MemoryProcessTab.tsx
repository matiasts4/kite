import React from 'react';
import {
  type SystemMetricsSnapshot,
  formatBytes,
} from '../../../lib/systemMetrics';
import { invokeCommand } from '../../../lib/ipc';
import {
  AlertTriangleIcon,
  BotSparkIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  MonitorIcon,
  SearchIcon,
  TerminalIcon,
} from '../../titlebar/TopbarPopoverIcons';

export interface MemoryProcessTabProps {
  snapshot: SystemMetricsSnapshot;
  onRefresh: () => void;
  procCategoryFilter: 'all' | 'terminals' | 'webview' | 'core' | 'build' | 'mcp' | 'agents';
  setProcCategoryFilter: React.Dispatch<React.SetStateAction<'all' | 'terminals' | 'webview' | 'core' | 'build' | 'mcp' | 'agents'>>;
  procSearchQuery: string;
  setProcSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  procViewMode: 'projects' | 'terminals' | 'flat';
  setProcViewMode: React.Dispatch<React.SetStateAction<'projects' | 'terminals' | 'flat'>>;
  expandedSections: Record<string, boolean>;
  setExpandedSections: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

function resolveWorkspaceName(workspaceId?: string | null): string {
  if (!workspaceId) return 'General';
  try {
    const raw = typeof window !== 'undefined'
      ? (localStorage.getItem('kite.cached_workspaces'))
      : null;
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const found = list.find((w: any) => w.id === workspaceId);
        if (found?.displayName) return found.displayName;
      }
    }
  } catch (err) {
    console.warn('[MemoryProcessTab] Failed to resolve cached workspace name:', err);
  }
  if (workspaceId.includes('\\') || workspaceId.includes('/')) {
    const parts = workspaceId.split(/[\/\\]/).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return workspaceId;
}

function getProcessTone(proc: { role?: string; category?: string }): string {
  if (proc.role === 'mcp' || proc.category === 'mcp') return 'mcp';
  if (proc.role === 'build') return 'build';
  if (proc.role === 'agent' || proc.category === 'agent') return 'agent';
  if (proc.category === 'terminals') return 'terminals';
  if (proc.category === 'webview') return 'webview';
  return 'core';
}

function getProcessBarColor(tone: string): string {
  if (tone === 'mcp' || tone === 'build') return 'var(--tm-violet)';
  if (tone === 'terminals') return 'var(--tm-amber)';
  if (tone === 'webview') return 'var(--status-running)';
  return 'var(--accent)';
}

export const MemoryProcessTab: React.FC<MemoryProcessTabProps> = React.memo(({
  snapshot,
  onRefresh,
  procCategoryFilter,
  setProcCategoryFilter,
  procSearchQuery,
  setProcSearchQuery,
  procViewMode,
  setProcViewMode,
  expandedSections,
  setExpandedSections,
}) => {

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleTerminateSession = async (sessionId: string) => {
    try {
      await invokeCommand('terminate_terminal', { sessionId, owner: 'user' });
      onRefresh();
    } catch (err) {
      console.warn('[Telemetry] Error terminating terminal:', err);
    }
  };

  const allProcs = snapshot.runtime.processes || [];
  const workspaces = snapshot.runtime.workspaces || [];
  const terminals = snapshot.runtime.terminals || [];
  const orphans = allProcs.filter((p) => p.isOrphan);
  const orphanBytes = orphans.reduce((sum, p) => sum + p.memoryBytes, 0);

  // 1. Orphan Alert Banner
  const orphanBanner = orphans.length > 0 && (
    <div className="tm-orphan-banner" role="status">
      <div className="tm-orphan-banner__left">
        <AlertTriangleIcon size={13} />
        <span>
          <strong>{orphans.length}</strong> subprocesos huérfanos ({formatBytes(orphanBytes)})
        </span>
      </div>
      <span className="tm-orphan-banner__sub">Inactivos sin terminal viva</span>
    </div>
  );

  return (
    <div className="tm-proc-card">
      {/* Header: Title and View Switcher */}
      <div className="tm-proc-head">
        <div className="tm-proc-title">
          Subprocesos Activos ({snapshot.runtime.processes?.length || snapshot.runtime.processCount})
        </div>

        {/* View mode segmented switcher */}
        <div className="tp-segmented tp-segmented--inline">
          {(
            [
              { id: 'projects', label: `Por Proyecto (${snapshot.runtime.workspaces?.length || 0})` },
              { id: 'terminals', label: `Por Terminal (${snapshot.runtime.terminals?.length || snapshot.runtime.activeTerminals})` },
              { id: 'flat', label: 'Lista Completa' },
            ] as const
          ).map((mode) => {
            const isSel = procViewMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={`tp-segmented__item${isSel ? ' tp-segmented__item--active' : ''}`}
                onClick={() => setProcViewMode(mode.id)}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* VIEW: POR PROYECTO */}
      {procViewMode === 'projects' && workspaces.length > 0 && (
        <>
          {orphanBanner}
          <div className="tm-proc-group-list">
            {workspaces.map((ws) => {
              const wsName = resolveWorkspaceName(ws.workspaceId);
              const isExpanded = expandedSections[ws.workspaceId] ?? true;
              const wsProcs = allProcs.filter((p) => p.workspaceId === ws.workspaceId);
              const wsTerminals = terminals.filter((t) => t.workspaceId === ws.workspaceId);
              const pctOfApp =
                snapshot.memory.appTotalBytes > 0
                  ? Math.round((ws.memoryBytes / snapshot.memory.appTotalBytes) * 100)
                  : 0;

              return (
                <div key={ws.workspaceId} className="tm-proc-group">
                  {/* Workspace Row Header */}
                  <button
                    type="button"
                    className="tm-proc-group__trigger"
                    onClick={() => toggleSection(ws.workspaceId)}
                    aria-expanded={isExpanded}
                  >
                    <div className="tm-proc-group__left">
                      <span className="tm-proc-pedestal" aria-hidden="true">
                        <FolderIcon size={13} />
                      </span>
                      <div className="tm-proc-group__meta">
                        <span className="tm-proc-group__name">{wsName}</span>
                        <span className="tm-proc-group__sub">
                          {wsTerminals.length > 0 ? wsTerminals.length : ws.terminalCount} terminal(es) · {ws.processCount} proceso(s)
                        </span>
                      </div>
                    </div>

                    <div className="tm-proc-group__right">
                      <div className="tm-proc-group__mem">
                        <div className="tm-proc-group__mem-val">{formatBytes(ws.memoryBytes)}</div>
                        <div className="tm-proc-group__mem-sub">
                          {pctOfApp}% app
                          {ws.privateBytes != null && ` · ${formatBytes(ws.privateBytes)} priv`}
                        </div>
                      </div>
                      <ChevronRightIcon
                        size={12}
                        className={`tm-proc-chevron${isExpanded ? ' tm-proc-chevron--open' : ''}`}
                      />
                    </div>
                  </button>

                  {/* Workspace Subprocesses */}
                  {isExpanded && wsProcs.length > 0 && (
                    <div className="tm-proc-children">
                      {wsProcs.map((p) => (
                        <div key={p.pid} className="tm-proc-child">
                          <div className="tm-proc-child__left">
                            <span className="tm-pid-chip">PID {p.pid}</span>
                            <span className="tm-breakdown-label">{p.name}</span>
                            {p.label && <span className="tm-breakdown-count">· {p.label}</span>}
                            {p.role === 'mcp' && (
                              <span className="tm-role-chip tm-role-chip--mcp">MCP</span>
                            )}
                            {p.role === 'agent' && (
                              <span className="tm-role-chip tm-role-chip--agent">Agente</span>
                            )}
                            {p.role === 'build' && (
                              <span className="tm-role-chip tm-role-chip--build">Build</span>
                            )}
                          </div>
                          <span className="tm-breakdown-value">{formatBytes(p.memoryBytes)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* System and UI Infrastructure Card */}
            <div className="tm-proc-group">
              <div className="tm-proc-group__row">
                <div className="tm-proc-group__left">
                  <span className="tm-proc-pedestal" aria-hidden="true">
                    <MonitorIcon size={13} />
                  </span>
                  <div className="tm-proc-group__meta">
                    <div className="tm-proc-group__name">Motor UI (WebView2) & Host</div>
                    <div className="tm-proc-group__sub">Renderizado React, GPU, Núcleo Rust</div>
                  </div>
                </div>
                <div className="tm-proc-group__mem">
                  <div className="tm-proc-group__mem-val tm-proc-group__mem-val--neutral">
                    {formatBytes(snapshot.memory.appCoreBytes)}
                  </div>
                  <div className="tm-proc-group__mem-sub">Memoria base UI</div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* VIEW: POR TERMINAL & AGENTE */}
      {procViewMode === 'terminals' && terminals.length > 0 && (
        <>
          {orphanBanner}
          <div className="tm-proc-group-list">
            {terminals.map((term) => {
              const isExpanded = expandedSections[term.sessionId] ?? true;
              const termProcs = allProcs.filter((p) => p.sessionId === term.sessionId);
              const wsLabel = resolveWorkspaceName(term.workspaceId);

              return (
                <div key={term.sessionId} className="tm-proc-group">
                  <div className="tm-proc-group__row">
                    <div
                      onClick={() => toggleSection(term.sessionId)}
                      className="tm-proc-group__left tm-proc-group__left--clickable"
                    >
                      <span
                        className={`tm-proc-pedestal${term.isAgent ? ' tm-proc-pedestal--agent' : ''}`}
                        aria-hidden="true"
                      >
                        {term.isAgent ? <BotSparkIcon size={13} /> : <TerminalIcon size={13} />}
                      </span>
                      <div className="tm-proc-group__meta">
                        <div className="tm-proc-child__left">
                          <span className="tm-proc-group__name">{term.title}</span>
                          {term.isAgent && (
                            <span className="tm-role-chip tm-role-chip--agent">Agente AI</span>
                          )}
                        </div>
                        <span className="tm-proc-group__sub">
                          {wsLabel} · {term.processCount} proceso(s)
                        </span>
                      </div>
                    </div>

                    <div className="tm-proc-group__right">
                      <div className="tm-proc-group__mem">
                        <div className="tm-proc-group__mem-val">{formatBytes(term.memoryBytes)}</div>
                        <div className="tm-proc-group__mem-sub">
                          {term.agentBytes != null && term.agentBytes > 0 && (
                            <span>Agente: {formatBytes(term.agentBytes)}</span>
                          )}
                          {term.mcpBytes != null && term.mcpBytes > 0 && (
                            <span className="tm-hero-sub--violet">
                              {term.agentBytes ? ' · ' : ''}MCPs: {formatBytes(term.mcpBytes)}
                            </span>
                          )}
                          {!term.agentBytes && !term.mcpBytes && term.privateBytes != null && (
                            <span>{formatBytes(term.privateBytes)} priv</span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="tp-icon-btn"
                        title="Finalizar sesión de terminal"
                        aria-label={`Finalizar sesión ${term.title}`}
                        onClick={() => handleTerminateSession(term.sessionId)}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Subprocesses under terminal */}
                  {isExpanded && termProcs.length > 0 && (
                    <div className="tm-proc-children">
                      {termProcs.map((p) => (
                        <div key={p.pid} className="tm-proc-child">
                          <div className="tm-proc-child__left">
                            <span className="tm-pid-chip">PID {p.pid}</span>
                            <span className="tm-breakdown-label">{p.name}</span>
                            {p.label && <span className="tm-breakdown-count">· {p.label}</span>}
                            {p.role === 'mcp' && (
                              <span className="tm-role-chip tm-role-chip--mcp">MCP</span>
                            )}
                            {p.role === 'agent' && (
                              <span className="tm-role-chip tm-role-chip--agent">Agente</span>
                            )}
                            {p.role === 'build' && (
                              <span className="tm-role-chip tm-role-chip--build">Build</span>
                            )}
                          </div>
                          <span className="tm-breakdown-value">{formatBytes(p.memoryBytes)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* VIEW: FLAT LIST (Detailed Process List) */}
      {(procViewMode === 'flat' || (procViewMode === 'projects' && workspaces.length === 0) || (procViewMode === 'terminals' && terminals.length === 0)) && (() => {
        const agentCount = allProcs.filter((p) => p.role === 'agent' || p.category === 'agent').length;
        const mcpCount = allProcs.filter((p) => p.role === 'mcp' || p.category === 'mcp').length;
        const termCount = allProcs.filter((p) => p.category === 'terminals' && p.role !== 'mcp' && p.role !== 'agent').length;
        const webCount = allProcs.filter((p) => p.category === 'webview').length;
        const coreCount = allProcs.filter((p) => p.category === 'core').length;
        const buildCount = allProcs.filter((p) => p.role === 'build').length;

        const filtered = allProcs.filter((p) => {
          if (procCategoryFilter === 'build') {
            if (p.role !== 'build') return false;
          } else if (procCategoryFilter === 'mcp') {
            if (p.role !== 'mcp' && p.category !== 'mcp') return false;
          } else if (procCategoryFilter === 'agents') {
            if (p.role !== 'agent' && p.category !== 'agent') return false;
          } else if (procCategoryFilter === 'terminals') {
            if (p.category !== 'terminals' || p.role === 'mcp' || p.role === 'agent') return false;
          } else if (procCategoryFilter !== 'all' && p.category !== procCategoryFilter) {
            return false;
          }
          if (procSearchQuery.trim()) {
            const q = procSearchQuery.toLowerCase();
            return (
              p.name.toLowerCase().includes(q) ||
              (p.label && p.label.toLowerCase().includes(q)) ||
              (p.workspaceId && p.workspaceId.toLowerCase().includes(q)) ||
              String(p.pid).includes(q)
            );
          }
          return true;
        });

        const filterButtons: Array<{ id: 'all' | 'agents' | 'mcp' | 'terminals' | 'build' | 'webview' | 'core'; label: string }> = [
          { id: 'all', label: `Todos (${allProcs.length})` },
        ];
        if (agentCount > 0) {
          filterButtons.push({ id: 'agents', label: `Agentes AI (${agentCount})` });
        }
        if (mcpCount > 0) {
          filterButtons.push({ id: 'mcp', label: `MCPs & Tools (${mcpCount})` });
        }
        filterButtons.push({ id: 'terminals', label: `Shells PTY (${termCount})` });
        if (buildCount > 0) {
          filterButtons.push({ id: 'build', label: `Build / Tests (${buildCount})` });
        }
        filterButtons.push(
          { id: 'webview', label: `Motor UI (${webCount})` },
          { id: 'core', label: `Núcleo (${coreCount})` }
        );

        return (
          <>
            {orphanBanner}
            <div className="tm-filter-bar">
              {filterButtons.map((filter) => {
                const isSel = procCategoryFilter === filter.id;
                return (
                  <button
                    key={filter.id}
                    type="button"
                    className={`tm-filter-chip${isSel ? ' tm-filter-chip--active' : ''}`}
                    onClick={() => setProcCategoryFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>

            {allProcs.length > 3 && (
              <div className="tp-field">
                <SearchIcon size={12} />
                <input
                  type="text"
                  className="tp-field__input"
                  placeholder="Filtrar por PID, nombre o proyecto..."
                  value={procSearchQuery}
                  onChange={(e) => setProcSearchQuery(e.target.value)}
                />
              </div>
            )}

            {/* Process list */}
            <div className="tm-proc-group-list">
              {filtered.length === 0 ? (
                <div className="tm-proc-empty">
                  No se encontraron subprocesos activos para este filtro.
                </div>
              ) : (
                filtered.map((proc) => {
                  const pctOfApp =
                    snapshot.memory.appTotalBytes > 0
                      ? Math.round((proc.memoryBytes / snapshot.memory.appTotalBytes) * 100)
                      : 0;
                  const tone = getProcessTone(proc);
                  const barColor = getProcessBarColor(tone);
                  const catBadge =
                    tone === 'mcp'
                      ? 'Servidor MCP'
                      : tone === 'build'
                        ? 'Build / Test'
                        : tone === 'agent'
                          ? 'Agente AI'
                          : tone === 'terminals'
                            ? 'Terminal PTY'
                            : tone === 'webview'
                              ? 'WebView2'
                              : 'Host';

                  const wsTag = proc.workspaceId ? resolveWorkspaceName(proc.workspaceId) : null;

                  return (
                    <div
                      key={proc.pid}
                      className={`tm-flat-row${proc.isOrphan ? ' tm-flat-row--orphan' : ''}`}
                    >
                      <div className="tm-flat-row__top">
                        <div className="tm-proc-child__left">
                          <span className="tm-pid-chip">PID {proc.pid}</span>
                          <span className="tm-proc-group__name" title={proc.name}>
                            {proc.name}
                          </span>
                          {proc.label && (
                            <span className="tm-breakdown-count">· {proc.label}</span>
                          )}
                        </div>

                        <div className="tm-proc-group__right">
                          {wsTag && <span className="tm-ws-chip">{wsTag}</span>}
                          <span className={`tm-role-chip tm-role-chip--${tone}`}>{catBadge}</span>
                          <span className="tm-breakdown-value">{formatBytes(proc.memoryBytes)}</span>
                        </div>
                      </div>

                      <div className="tm-flat-row__meta">
                        <span>
                          {pctOfApp}% de la app
                          {proc.privateBytes != null && (
                            <span> · {formatBytes(proc.privateBytes)} privada</span>
                          )}
                          {proc.isOrphan && (
                            <span className="tm-orphan-banner__left"> · Huérfano</span>
                          )}
                        </span>
                      </div>

                      <div className="tp-meter">
                        <div
                          className="tp-meter__fill"
                          style={{
                            width: `${Math.max(2, Math.min(100, pctOfApp))}%`,
                            backgroundColor: barColor,
                          }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
});
