import React from 'react';
import {
  type SystemMetricsSnapshot,
  formatBytes,
} from '../../../lib/systemMetrics';
import { invokeCommand } from '../../../lib/ipc';

export interface MemoryProcessTabProps {
  snapshot: SystemMetricsSnapshot;
  onRefresh: () => void;
  procCategoryFilter: 'all' | 'terminals' | 'webview' | 'core' | 'build';
  setProcCategoryFilter: React.Dispatch<React.SetStateAction<'all' | 'terminals' | 'webview' | 'core' | 'build'>>;
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
  } catch {}
  if (workspaceId.includes('\\') || workspaceId.includes('/')) {
    const parts = workspaceId.split(/[\/\\]/).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return workspaceId;
}

export const MemoryProcessTab: React.FC<MemoryProcessTabProps> = ({
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
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 'var(--control-radius, 8px)',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
        border: '1px solid rgba(245, 158, 11, 0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '11px',
        color: 'var(--warning-text, #f59e0b)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span>⚠️</span>
        <span>
          <strong>{orphans.length}</strong> subprocesos huérfanos ({formatBytes(orphanBytes)})
        </span>
      </div>
      <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
        Inactivos sin terminal viva
      </span>
    </div>
  );

  return (
    <div
      style={{
        backgroundColor: 'var(--block-fill)',
        border: '1px solid var(--block-stroke)',
        borderRadius: 'var(--card-radius, 12px)',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {/* Header: Title and View Switcher */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
        <div
          style={{
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--text-primary)',
          }}
        >
          Subprocesos Activos ({snapshot.runtime.processes?.length || snapshot.runtime.processCount})
        </div>

        {/* View mode segmented switcher */}
        <div
          style={{
            display: 'flex',
            backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.03))',
            padding: '2px',
            borderRadius: 'var(--control-radius, 8px)',
            border: '1px solid var(--block-stroke)',
            gap: '2px',
          }}
        >
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
                onClick={() => setProcViewMode(mode.id)}
                style={{
                  padding: '3px 8px',
                  height: '24px',
                  borderRadius: 'var(--vl-radius-sm, 6px)',
                  fontSize: '10px',
                  fontWeight: isSel ? 600 : 500,
                  border: 'none',
                  backgroundColor: isSel ? 'var(--accent, #5c8fff)' : 'transparent',
                  color: isSel ? '#ffffff' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'all 120ms ease',
                }}
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
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              maxHeight: '260px',
              overflowY: 'auto',
              paddingRight: '2px',
            }}
          >
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
                <div
                  key={ws.workspaceId}
                  style={{
                    borderRadius: 'var(--control-radius, 8px)',
                    border: '1px solid var(--block-stroke)',
                    backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.02))',
                    overflow: 'hidden',
                  }}
                >
                  {/* Workspace Row Header */}
                  <button
                    type="button"
                    onClick={() => toggleSection(ws.workspaceId)}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span style={{ fontSize: '12px' }}>📁</span>
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-primary)' }}>
                          {wsName}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                          {wsTerminals.length > 0 ? wsTerminals.length : ws.terminalCount} terminal(es) · {ws.processCount} proceso(s)
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent, #5c8fff)' }}>
                          {formatBytes(ws.memoryBytes)}
                        </div>
                        <div style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                          {pctOfApp}% app
                          {ws.privateBytes != null && ` · ${formatBytes(ws.privateBytes)} priv`}
                        </div>
                      </div>
                      <span style={{ fontSize: '10px', color: 'var(--text-secondary)', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
                        ▶
                      </span>
                    </div>
                  </button>

                  {/* Workspace Subprocesses */}
                  {isExpanded && wsProcs.length > 0 && (
                    <div style={{ padding: '4px 10px 8px 24px', borderTop: '1px solid var(--block-stroke)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {wsProcs.map((p) => (
                        <div key={p.pid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '10px', padding: '3px 0' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>PID {p.pid}</span>
                            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{p.name}</span>
                            {p.label && <span style={{ color: 'var(--text-secondary)' }}>· {p.label}</span>}
                            {p.role === 'build' && (
                              <span style={{ fontSize: '8px', padding: '1px 4px', borderRadius: '4px', backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#a855f7' }}>
                                Build
                              </span>
                            )}
                          </div>
                          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                            {formatBytes(p.memoryBytes)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* System and UI Infrastructure Card */}
            <div
              style={{
                borderRadius: 'var(--control-radius, 8px)',
                border: '1px solid var(--block-stroke)',
                backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.015))',
                padding: '8px 10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px' }}>🖥️</span>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Motor UI (WebView2) & Host</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>Renderizado React, GPU, Núcleo Rust</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {formatBytes(snapshot.memory.appCoreBytes)}
                </div>
                <div style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                  Memoria base UI
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
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              maxHeight: '260px',
              overflowY: 'auto',
              paddingRight: '2px',
            }}
          >
            {terminals.map((term) => {
              const isExpanded = expandedSections[term.sessionId] ?? true;
              const termProcs = allProcs.filter((p) => p.sessionId === term.sessionId);
              const wsLabel = resolveWorkspaceName(term.workspaceId);

              return (
                <div
                  key={term.sessionId}
                  style={{
                    borderRadius: 'var(--control-radius, 8px)',
                    border: '1px solid var(--block-stroke)',
                    backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.02))',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div
                      onClick={() => toggleSection(term.sessionId)}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, cursor: 'pointer', flex: 1 }}
                    >
                      <span style={{ fontSize: '12px' }}>{term.isAgent ? '🤖' : '💻'}</span>
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 600, fontSize: '11px', color: 'var(--text-primary)' }}>
                            {term.title}
                          </span>
                          {term.isAgent && (
                            <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '4px', backgroundColor: 'rgba(92, 143, 255, 0.15)', color: 'var(--accent, #5c8fff)' }}>
                              Agente AI
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                          {wsLabel} · {term.processCount} proceso(s)
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent, #5c8fff)' }}>
                          {formatBytes(term.memoryBytes)}
                        </div>
                        {term.privateBytes != null && (
                          <div style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                            {formatBytes(term.privateBytes)} priv
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        title="Finalizar sesión de terminal"
                        onClick={() => handleTerminateSession(term.sessionId)}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--text-secondary)',
                          cursor: 'pointer',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Subprocesses under terminal */}
                  {isExpanded && termProcs.length > 0 && (
                    <div style={{ padding: '4px 10px 8px 24px', borderTop: '1px solid var(--block-stroke)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {termProcs.map((p) => (
                        <div key={p.pid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '10px', padding: '2px 0' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>PID {p.pid}</span>
                            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{p.name}</span>
                            {p.label && <span style={{ color: 'var(--text-secondary)' }}>· {p.label}</span>}
                          </div>
                          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                            {formatBytes(p.memoryBytes)}
                          </span>
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
        const termCount = allProcs.filter((p) => p.category === 'terminals').length;
        const webCount = allProcs.filter((p) => p.category === 'webview').length;
        const coreCount = allProcs.filter((p) => p.category === 'core').length;
        const buildCount = allProcs.filter((p) => p.role === 'build').length;

        const filtered = allProcs.filter((p) => {
          if (procCategoryFilter === 'build') {
            if (p.role !== 'build') return false;
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

        const filterButtons: Array<{ id: 'all' | 'terminals' | 'build' | 'webview' | 'core'; label: string }> = [
          { id: 'all', label: `Todos (${allProcs.length})` },
          { id: 'terminals', label: `Terminales & Agentes (${termCount})` },
        ];
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
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {filterButtons.map((filter) => {
                const isSel = procCategoryFilter === filter.id;
                return (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => setProcCategoryFilter(filter.id)}
                    style={{
                      padding: '3px 8px',
                      height: '24px',
                      borderRadius: 'var(--vl-radius-sm, 6px)',
                      fontSize: '10px',
                      fontWeight: isSel ? 600 : 500,
                      border: isSel
                        ? '1px solid var(--accent-tint-strong, rgba(92, 143, 255, 0.35))'
                        : '1px solid var(--block-stroke)',
                      backgroundColor: isSel
                        ? 'var(--accent-tint, rgba(92, 143, 255, 0.14))'
                        : 'transparent',
                      color: isSel ? 'var(--accent, #5c8fff)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'all 120ms ease',
                    }}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>

            {allProcs.length > 3 && (
              <input
                type="text"
                placeholder="Filtrar por PID, nombre o proyecto..."
                value={procSearchQuery}
                onChange={(e) => setProcSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  height: '26px',
                  borderRadius: 'var(--control-radius, 8px)',
                  border: '1px solid var(--block-stroke)',
                  backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.03))',
                  color: 'var(--text-primary)',
                  fontSize: '11px',
                  padding: '0 8px',
                  outline: 'none',
                }}
              />
            )}

            {/* Process list */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '5px',
                maxHeight: '230px',
                overflowY: 'auto',
                paddingRight: '2px',
              }}
            >
              {filtered.length === 0 ? (
                <div
                  style={{
                    padding: '16px',
                    textAlign: 'center',
                    color: 'var(--text-secondary)',
                    fontSize: '11px',
                  }}
                >
                  No se encontraron subprocesos activos para este filtro.
                </div>
              ) : (
                filtered.map((proc) => {
                  const pctOfApp =
                    snapshot.memory.appTotalBytes > 0
                      ? Math.round((proc.memoryBytes / snapshot.memory.appTotalBytes) * 100)
                      : 0;
                  const catColor =
                    proc.role === 'build'
                      ? '#a855f7'
                      : proc.role === 'agent'
                      ? 'var(--accent, #5c8fff)'
                      : proc.category === 'terminals'
                      ? '#f59e0b'
                      : proc.category === 'webview'
                      ? 'var(--status-running, #34c759)'
                      : 'var(--accent, #5c8fff)';

                  const catBadge =
                    proc.role === 'build'
                      ? 'Build / Test'
                      : proc.role === 'agent'
                      ? 'Agente AI'
                      : proc.category === 'terminals'
                      ? 'Terminal PTY'
                      : proc.category === 'webview'
                      ? 'WebView2'
                      : 'Host';

                  const wsTag = proc.workspaceId ? resolveWorkspaceName(proc.workspaceId) : null;

                  return (
                    <div
                      key={proc.pid}
                      style={{
                        padding: '6px 8px',
                        borderRadius: 'var(--control-radius, 8px)',
                        backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.025))',
                        border: proc.isOrphan ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid var(--block-stroke)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: '11px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: '9px',
                              fontWeight: 700,
                              fontVariantNumeric: 'tabular-nums',
                              padding: '1px 5px',
                              borderRadius: 'var(--vl-radius-xs, 4px)',
                              backgroundColor: 'var(--block-stroke)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            PID {proc.pid}
                          </span>
                          <span
                            style={{
                              fontWeight: 600,
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={proc.name}
                          >
                            {proc.name}
                          </span>
                          {proc.label && (
                            <span
                              style={{
                                fontSize: '10px',
                                color: 'var(--text-secondary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              · {proc.label}
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                          {wsTag && (
                            <span
                              style={{
                                fontSize: '9px',
                                padding: '1px 5px',
                                borderRadius: 'var(--vl-radius-xs, 4px)',
                                backgroundColor: 'var(--block-stroke)',
                                color: 'var(--text-secondary)',
                                maxWidth: '90px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {wsTag}
                            </span>
                          )}
                          <span
                            style={{
                              fontSize: '9px',
                              fontWeight: 600,
                              padding: '1px 5px',
                              borderRadius: 'var(--vl-radius-xs, 4px)',
                              color: catColor,
                              backgroundColor: 'color-mix(in srgb, currentColor 12%, transparent)',
                            }}
                          >
                            {catBadge}
                          </span>
                          <span
                            style={{
                              fontWeight: 700,
                              fontVariantNumeric: 'tabular-nums',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {formatBytes(proc.memoryBytes)}
                          </span>
                        </div>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: '10px',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <span>
                          {pctOfApp}% de la app
                          {proc.privateBytes != null && (
                            <span style={{ marginLeft: '4px' }}>
                              · {formatBytes(proc.privateBytes)} privada
                            </span>
                          )}
                          {proc.isOrphan && (
                            <span style={{ marginLeft: '6px', color: 'var(--warning-text, #f59e0b)', fontWeight: 600 }}>
                              · Huérfano
                            </span>
                          )}
                        </span>
                      </div>

                      <div
                        style={{
                          height: '3px',
                          borderRadius: '999px',
                          backgroundColor: 'color-mix(in srgb, var(--text-secondary) 14%, transparent)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.max(2, Math.min(100, pctOfApp))}%`,
                            backgroundColor: catColor,
                            borderRadius: '999px',
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
};
