import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  type SystemMetricsSnapshot,
  type SystemMetricsHistoryPoint,
  type SystemMetricsPreferences,
  type BadgeMetricDisplayMode,
  formatBytes,
  formatUptime,
  getPressureColors,
  saveSystemMetricsPreferences,
} from '../../lib/systemMetrics';
import { MOTION_EXIT_MS } from '../../motion/contract';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { CircularGauge, Sparkline } from './TelemetryGauges';
import { MemoryProcessTab } from './tabs/MemoryProcessTab';
import { OverviewTab } from './tabs/OverviewTab';
import { CpuTab } from './tabs/CpuTab';
import { DiskTab } from './tabs/DiskTab';
import { HeadroomTab } from './tabs/HeadroomTab';

export interface SystemResourcePopoverProps {
  snapshot: SystemMetricsSnapshot;
  history: SystemMetricsHistoryPoint[];
  prefs: SystemMetricsPreferences;
  isRefreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
  anchorRect?: DOMRect | null;
  phase?: 'in' | 'out';
}

type ResourceTab = 'overview' | 'memory' | 'cpu' | 'disk' | 'headroom';

export const SystemResourcePopover: React.FC<SystemResourcePopoverProps> = ({
  snapshot,
  history,
  prefs,
  isRefreshing,
  onRefresh,
  onClose,
  anchorRect,
  phase = 'in',
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<ResourceTab>('overview');
  const [uiFps, setUiFps] = useState<number>(60);
  const [procCategoryFilter, setProcCategoryFilter] = useState<'all' | 'agents' | 'mcp' | 'terminals' | 'webview' | 'core' | 'build'>('all');
  const [procSearchQuery, setProcSearchQuery] = useState<string>('');
  const hasWorkspaces = Boolean(snapshot?.runtime.workspaces && snapshot.runtime.workspaces.length > 0);
  const [procViewMode, setProcViewMode] = useState<'projects' | 'terminals' | 'flat'>(hasWorkspaces ? 'projects' : 'flat');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  // Measure live UI frame rate while popover is open
  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId = 0;
    const tick = (now: number) => {
      frameCount += 1;
      const elapsed = now - lastTime;
      if (elapsed >= 600) {
        const currentFps = Math.min(144, Math.max(1, Math.round((frameCount * 1000) / elapsed)));
        setUiFps(currentFps);
        frameCount = 0;
        lastTime = now;
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  // Position anchored to the TitleBar pill
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 44, right: 80 });

  useEffect(() => {
    if (anchorRect) {
      const top = anchorRect.bottom + 6;
      const right = Math.max(12, window.innerWidth - anchorRect.right);
      setPosition({ top, right });
    }
  }, [anchorRect]);

  // Close on click outside or Escape
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        if (!target.closest('.system-resource-badge')) {
          onClose();
        }
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const pressureTheme = getPressureColors(snapshot.memory.pressure);
  const appRamHistory = history.map((h) => h.appRamMb);
  const appCpuHistory = history.map((h) => h.appCpuPct);
  const sysCpuHistory = history.map((h) => h.sysCpuPct);

  const cpuColor =
    snapshot.cpu.systemUsagePercent > 80
      ? 'var(--status-failed, #ef4444)'
      : snapshot.cpu.systemUsagePercent > 50
      ? 'var(--warning-text, #f59e0b)'
      : 'var(--accent, #5c8fff)';

  const diskColor =
    snapshot.disk.usagePercent > 90
      ? 'var(--status-failed, #ef4444)'
      : snapshot.disk.usagePercent > 75
      ? 'var(--warning-text, #f59e0b)'
      : '#a855f7';

  const intervals: Array<2000 | 3000 | 5000 | 10000> = [2000, 3000, 5000, 10000];
  const badgeModes: Array<{ id: BadgeMetricDisplayMode; label: string }> = [
    { id: 'ram_only', label: 'Solo RAM' },
    { id: 'ram_and_cpu', label: 'RAM + CPU' },
    { id: 'ram_percent', label: '% Sistema' },
  ];

  const popoverNode = (
    <motion.div
      {...surfaceMotion('popover', { exitMs: MOTION_EXIT_MS })}
      ref={popoverRef}
      role="dialog"
      aria-label="Monitor de recursos del sistema y de la aplicación"
      className="system-resource-popover"
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        right: `${position.right}px`,
        // The panel's right edge sits under the badge, so it grows from that corner.
        transformOrigin: 'top right',
        width: '416px',
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100vh - 60px)',
        backgroundColor: 'var(--menu-glass, #121214)',
        backdropFilter: 'var(--menu-backdrop, blur(20px))',
        WebkitBackdropFilter: 'var(--menu-backdrop, blur(20px))',
        border: '1px solid var(--block-stroke)',
        borderRadius: '12px',
        boxShadow: '0 16px 42px rgba(0, 0, 0, 0.42)',
        padding: '14px',
        color: 'var(--text-primary)',
        fontSize: '12px',
        zIndex: 10001,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '10px',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: '7px',
              backgroundColor: pressureTheme.tint,
              border: `1px solid ${pressureTheme.stroke}`,
              color: pressureTheme.color,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <path d="M9 1v3" />
              <path d="M15 1v3" />
              <path d="M9 20v3" />
              <path d="M15 20v3" />
              <path d="M20 9h3" />
              <path d="M20 14h3" />
              <path d="M1 9h3" />
              <path d="M1 14h3" />
            </svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                Monitor de Recursos
              </span>
              <span
                style={{
                  fontSize: '9px',
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: '4px',
                  backgroundColor: pressureTheme.tint,
                  color: pressureTheme.color,
                  border: `1px solid ${pressureTheme.stroke}`,
                  textTransform: 'uppercase',
                  letterSpacing: '0.03em',
                }}
              >
                {pressureTheme.label}
              </span>
            </div>
            <div
              style={{
                fontSize: '10px',
                color: 'var(--text-secondary)',
                fontVariantNumeric: 'tabular-nums',
                marginTop: '1px',
              }}
            >
              PID {snapshot.pid} · Activo {formatUptime(snapshot.uptimeSeconds)} · IPC{' '}
              {snapshot.ipcLatencyMs}ms
            </div>
          </div>
        </div>

        {/* Refresh & Close Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          <button
            type="button"
            onClick={onRefresh}
            title="Actualizar métricas ahora"
            aria-label="Actualizar métricas ahora"
            style={{
              background: 'none',
              border: 'none',
              padding: '5px',
              borderRadius: '5px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
          </button>

          <button
            type="button"
            onClick={onClose}
            title="Cerrar"
            aria-label="Cerrar monitor de recursos"
            style={{
              background: 'none',
              border: 'none',
              padding: '5px',
              borderRadius: '5px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Category Switcher Tabs */}
      <div
        role="tablist"
        aria-label="Categorías de consumo"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: '4px',
          padding: '3px',
          backgroundColor: 'var(--block-fill)',
          border: '1px solid var(--block-stroke)',
          borderRadius: '8px',
          marginBottom: '12px',
        }}
      >
        {(
          [
            { id: 'overview', label: 'Resumen' },
            { id: 'memory', label: 'RAM' },
            { id: 'cpu', label: 'CPU' },
            { id: 'disk', label: 'Disco' },
            { id: 'headroom', label: 'Headroom' },
          ] as const
        ).map((tab) => {
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '5px 4px',
                borderRadius: '6px',
                fontSize: '10px',
                whiteSpace: 'nowrap',
                fontWeight: isSelected ? 600 : 500,
                border: isSelected
                  ? '1px solid var(--accent-tint-strong, rgba(92, 143, 255, 0.35))'
                  : '1px solid transparent',
                backgroundColor: isSelected
                  ? 'var(--accent-tint, rgba(92, 143, 255, 0.14))'
                  : 'transparent',
                color: isSelected ? 'var(--accent, #5c8fff)' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all 120ms ease',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Main Content Area */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          overflowY: 'auto',
          maxHeight: '420px',
          paddingRight: '2px',
        }}
      >
        {/* HERO CARD: App Total RAM (Visible in Overview & Memory) */}
        {(activeTab === 'overview' || activeTab === 'memory') && (
          <div
            style={{
              backgroundColor: 'var(--block-fill)',
              border: '1px solid var(--block-stroke)',
              borderRadius: '10px',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <CircularGauge
                  percentage={snapshot.memory.systemUsagePercent}
                  color={pressureTheme.color}
                  label={`${Math.round(snapshot.memory.systemUsagePercent)}%`}
                />
                <div>
                  <div
                    style={{
                      fontSize: '10px',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    RAM Total de la Aplicación
                  </div>
                  <div
                    style={{
                      fontSize: '20px',
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                      color: 'var(--text-primary)',
                      lineHeight: 1.15,
                      marginTop: '2px',
                    }}
                  >
                    {formatBytes(snapshot.memory.appTotalBytes)}
                  </div>
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--text-secondary)',
                      fontVariantNumeric: 'tabular-nums',
                      marginTop: '2px',
                    }}
                  >
                    {snapshot.memory.appShareOfSystemPercent}% de{' '}
                    {formatBytes(snapshot.memory.systemTotalBytes, 0)} del sistema
                    {snapshot.memory.appPrivateBytes != null && (
                      <span style={{ color: 'var(--accent, #5c8fff)', marginLeft: '6px' }}>
                        · {formatBytes(snapshot.memory.appPrivateBytes)} priv.
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--text-secondary)',
                      fontVariantNumeric: 'tabular-nums',
                      marginTop: '2px',
                    }}
                  >
                    UI + Core: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(snapshot.memory.appCoreBytes)}</strong>
                    {' · '}
                    Agentes: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(snapshot.memory.appAgentsBytes ?? snapshot.memory.appTerminalsBytes)}</strong>
                    {snapshot.memory.appMcpsBytes != null && snapshot.memory.appMcpsBytes > 0 && (
                      <>
                        {' · '}
                        MCPs: <strong style={{ color: '#c084fc' }}>{formatBytes(snapshot.memory.appMcpsBytes)}</strong>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                <Sparkline
                  values={appRamHistory}
                  color={pressureTheme.color}
                  width={118}
                  height={34}
                />
                <span style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                   Evolución en vivo ({history.length} muestras)
                </span>
              </div>
            </div>

            {/* Explanatory note in Memory Tab */}
            {activeTab === 'memory' && (
              <div
                style={{
                  fontSize: '10px',
                  lineHeight: 1.45,
                  color: 'var(--text-secondary)',
                  padding: '7px 9px',
                  borderRadius: 'var(--control-radius, 8px)',
                  backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.03))',
                  border: '1px solid var(--block-stroke)',
                }}
              >
                <strong style={{ color: 'var(--text-primary)' }}>¿Por qué varía el consumo?</strong> La{' '}
                <em>Memoria Privada</em> es la RAM exclusiva reservada por Kite y los agentes. El{' '}
                <em>Working Set</em> incluye páginas compartidas de Windows y Chromium multi-contadas por
                proceso, y varía bruscamente al nacer o morir subprocesos de compilación o tests.
              </div>
            )}

            {/* Process Tree Breakdown */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                borderTop: '1px solid var(--block-stroke)',
                paddingTop: '8px',
              }}
            >
              {snapshot.runtime.breakdown.map((group) => {
                const pctOfApp =
                  snapshot.memory.appTotalBytes > 0
                    ? Math.round((group.memoryBytes / snapshot.memory.appTotalBytes) * 100)
                    : 0;

                const color =
                  group.id === 'mcps'
                    ? '#c084fc'
                    : group.id === 'agents'
                    ? 'var(--accent, #5c8fff)'
                    : group.id === 'terminals'
                    ? '#f59e0b'
                    : group.id === 'webview'
                    ? 'var(--status-running, #34c759)'
                    : 'var(--accent, #5c8fff)';

                return (
                  <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '11px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span
                          style={{
                            width: '7px',
                            height: '7px',
                            borderRadius: '50%',
                            backgroundColor: color,
                            display: 'inline-block',
                          }}
                        />
                        <span style={{ fontWeight: 500 }}>{group.label}</span>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>
                          ({group.processCount} proc.)
                        </span>
                      </div>
                      <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {formatBytes(group.memoryBytes)}{' '}
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '10px' }}>
                          ({pctOfApp}%)
                        </span>
                      </div>
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
                          backgroundColor: color,
                          borderRadius: '999px',
                          transition: 'width 250ms ease',
                        }}
                      />
                    </div>
                  </div>
                );
              })}

              {/* Jump to Memory Details button in overview */}
              {activeTab === 'overview' && (
                <button
                  type="button"
                  onClick={() => setActiveTab('memory')}
                  style={{
                    marginTop: '4px',
                    padding: '6px 9px',
                    borderRadius: 'var(--control-radius, 8px)',
                    border: '1px solid var(--block-stroke)',
                    backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.02))',
                    color: 'var(--accent, #5c8fff)',
                    fontSize: '11px',
                    fontWeight: 500,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    transition: 'all 120ms ease',
                  }}
                >
                  <span>Ver desglose de subprocesos ({snapshot.runtime.processes?.length || snapshot.runtime.processCount} activos)</span>
                  <span style={{ fontSize: '12px' }}>→</span>
                </button>
              )}

              {/* System Host RAM bar */}
              <div
                style={{
                  marginTop: '4px',
                  padding: '7px 9px',
                  borderRadius: '6px',
                  backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.03))',
                  border: '1px solid var(--block-stroke)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '11px',
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>RAM Física del Equipo:</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {formatBytes(snapshot.memory.systemUsedBytes)} /{' '}
                  {formatBytes(snapshot.memory.systemTotalBytes)} ({snapshot.memory.systemUsagePercent}%)
                </span>
              </div>

              {snapshot.memory.jsHeapUsedBytes != null && (
                <div
                  style={{
                    padding: '6px 9px',
                    borderRadius: '6px',
                    backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.03))',
                    border: '1px solid var(--block-stroke)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '11px',
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>Memoria Heap JS (V8 UI):</span>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {formatBytes(snapshot.memory.jsHeapUsedBytes)}
                    {snapshot.memory.jsHeapLimitBytes
                      ? ` / ${formatBytes(snapshot.memory.jsHeapLimitBytes, 0)}`
                      : ''}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* DETAILED PROCESS BREAKDOWN (Exclusively in Memory Tab) */}
        {activeTab === 'memory' && (
          <MemoryProcessTab
            snapshot={snapshot}
            onRefresh={onRefresh}
            procCategoryFilter={procCategoryFilter}
            setProcCategoryFilter={setProcCategoryFilter}
            procSearchQuery={procSearchQuery}
            setProcSearchQuery={setProcSearchQuery}
            procViewMode={procViewMode}
            setProcViewMode={setProcViewMode}
            expandedSections={expandedSections}
            setExpandedSections={setExpandedSections}
          />
        )}

        {/* OVERVIEW GRID: CPU, Disk, & Runtime Health Cards */}
        {activeTab === 'overview' && (
          <OverviewTab
            snapshot={snapshot}
            appCpuHistory={appCpuHistory}
            cpuColor={cpuColor}
            diskColor={diskColor}
            uiFps={uiFps}
            onSelectTab={setActiveTab}
          />
        )}

        {/* DETAILED CPU TAB */}
        {activeTab === 'cpu' && (
          <CpuTab
            snapshot={snapshot}
            sysCpuHistory={sysCpuHistory}
            cpuColor={cpuColor}
            uiFps={uiFps}
          />
        )}

        {/* DETAILED DISK TAB */}
        {activeTab === 'disk' && (
          <DiskTab
            snapshot={snapshot}
            diskColor={diskColor}
          />
        )}

        {activeTab === 'headroom' && <HeadroomTab />}
      </div>

      {/* Footer Controls: Update Frequency & Badge Display Mode */}
      <div
        style={{
          borderTop: '1px solid var(--block-stroke)',
          marginTop: '12px',
          paddingTop: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '6px',
          }}
        >
          <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
            Mostrar en barra superior:
          </span>
          <div style={{ display: 'inline-flex', gap: '3px' }}>
            {badgeModes.map((m) => {
              const active = prefs.badgeMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => saveSystemMetricsPreferences({ badgeMode: m.id })}
                  style={{
                    padding: '2px 7px',
                    borderRadius: '5px',
                    fontSize: '10px',
                    fontWeight: active ? 600 : 400,
                    border: active
                      ? '1px solid var(--accent-tint-strong, rgba(92, 143, 255, 0.35))'
                      : '1px solid var(--block-stroke)',
                    backgroundColor: active
                      ? 'var(--accent-tint, rgba(92, 143, 255, 0.14))'
                      : 'var(--block-fill)',
                    color: active ? 'var(--accent, #5c8fff)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '6px',
          }}
        >
          <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
            Frecuencia de actualización:
          </span>
          <div style={{ display: 'inline-flex', gap: '3px' }}>
            {intervals.map((ms) => {
              const active = prefs.refreshIntervalMs === ms;
              return (
                <button
                  key={ms}
                  type="button"
                  onClick={() => saveSystemMetricsPreferences({ refreshIntervalMs: ms })}
                  style={{
                    padding: '2px 7px',
                    borderRadius: '5px',
                    fontSize: '10px',
                    fontWeight: active ? 600 : 400,
                    fontVariantNumeric: 'tabular-nums',
                    border: active
                      ? '1px solid var(--accent-tint-strong, rgba(92, 143, 255, 0.35))'
                      : '1px solid var(--block-stroke)',
                    backgroundColor: active
                      ? 'var(--accent-tint, rgba(92, 143, 255, 0.14))'
                      : 'var(--block-fill)',
                    color: active ? 'var(--accent, #5c8fff)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {ms / 1000}s
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>{phase === 'in' && popoverNode}</AnimatePresence>,
    document.body
  );
};
