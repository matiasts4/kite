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

type ResourceTab = 'overview' | 'memory' | 'cpu' | 'disk';

const Sparkline: React.FC<{
  values: number[];
  maxVal?: number;
  color: string;
  height?: number;
  width?: number;
}> = ({ values, maxVal, color, height = 34, width = 140 }) => {
  const safeValues = values.length > 1 ? values : [values[0] || 0, values[0] || 0];
  const computedMax = Math.max(maxVal ?? 0, ...safeValues, 1);
  const minVal = 0;
  const range = Math.max(1, computedMax - minVal);

  const pts = safeValues.map((v, i) => {
    const x = (i / Math.max(1, safeValues.length - 1)) * width;
    const clamped = Math.max(minVal, Math.min(computedMax, v));
    const y = height - 3 - ((clamped - minVal) / range) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polylinePoints = pts.join(' ');
  const areaPoints = `0,${height} ${polylinePoints} ${width},${height}`;
  const gradId = `spark-grad-${color.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', overflow: 'visible', flexShrink: 0 }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradId})`} />
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polylinePoints}
      />
    </svg>
  );
};

const CircularGauge: React.FC<{
  percentage: number;
  size?: number;
  strokeWidth?: number;
  color: string;
  label?: string;
}> = ({ percentage, size = 42, strokeWidth = 3.5, color, label }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percentage));
  const strokeDashoffset = circumference - (clamped / 100) * circumference;

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        style={{ transform: 'rotate(-90deg)', display: 'block', overflow: 'visible' }}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="color-mix(in srgb, var(--text-secondary) 22%, transparent)"
          strokeWidth={strokeWidth}
          fill="transparent"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="transparent"
          style={{
            transition: 'stroke-dashoffset 380ms cubic-bezier(0.16, 1, 0.3, 1), stroke 250ms ease',
          }}
        />
      </svg>
      {label && (
        <span
          style={{
            position: 'absolute',
            fontSize: '10px',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
};

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
          gridTemplateColumns: 'repeat(4, 1fr)',
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
                padding: '5px 8px',
                borderRadius: '6px',
                fontSize: '11px',
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
        {/* HERO CARD: App Total RAM (Always visible in Overview & Memory) */}
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
                return (
                  <div
                    key={group.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '3px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '11px',
                      }}
                    >
                      <span style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span>{group.label}</span>
                        <span
                          style={{
                            fontSize: '9px',
                            padding: '0 4px',
                            borderRadius: '3px',
                            backgroundColor: 'var(--chip-fill, rgba(255,255,255,0.05))',
                            border: '1px solid var(--block-stroke)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {group.processCount} proc
                        </span>
                      </span>
                      <span
                        style={{
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {formatBytes(group.memoryBytes)}{' '}
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '10px' }}>
                          ({pctOfApp}%)
                        </span>
                      </span>
                    </div>
                    <div
                      style={{
                        height: '4px',
                        borderRadius: '999px',
                        backgroundColor: 'color-mix(in srgb, var(--text-secondary) 16%, transparent)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.max(2, Math.min(100, pctOfApp))}%`,
                          backgroundColor:
                            group.id === 'core'
                              ? 'var(--accent, #5c8fff)'
                              : group.id === 'webview'
                              ? 'var(--status-running, #34c759)'
                              : '#f59e0b',
                          borderRadius: '999px',
                          transition: 'width 300ms ease',
                        }}
                      />
                    </div>
                  </div>
                );
              })}

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

        {/* OVERVIEW GRID: CPU, Disk, & Runtime Health Cards */}
        {activeTab === 'overview' && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '8px',
            }}
          >
            {/* CPU Card */}
            <button
              type="button"
              onClick={() => setActiveTab('cpu')}
              style={{
                textAlign: 'left',
                backgroundColor: 'var(--block-fill)',
                border: '1px solid var(--block-stroke)',
                borderRadius: '9px',
                padding: '10px',
                cursor: 'pointer',
                color: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                transition: 'border-color 120ms ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Procesador (CPU)
                </span>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={cpuColor}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div>
                  <div
                    style={{
                      fontSize: '16px',
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {snapshot.cpu.appUsagePercent.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                    App · Sistema {snapshot.cpu.systemUsagePercent.toFixed(1)}%
                  </div>
                </div>
                <Sparkline values={appCpuHistory} maxVal={100} color={cpuColor} width={68} height={24} />
              </div>
              <div
                style={{
                  height: '4px',
                  borderRadius: '999px',
                  backgroundColor: 'color-mix(in srgb, var(--text-secondary) 16%, transparent)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(3, Math.min(100, snapshot.cpu.systemUsagePercent))}%`,
                    backgroundColor: cpuColor,
                    borderRadius: '999px',
                    transition: 'width 300ms ease',
                  }}
                />
              </div>
            </button>

            {/* Disk Card */}
            <button
              type="button"
              onClick={() => setActiveTab('disk')}
              style={{
                textAlign: 'left',
                backgroundColor: 'var(--block-fill)',
                border: '1px solid var(--block-stroke)',
                borderRadius: '9px',
                padding: '10px',
                cursor: 'pointer',
                color: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                transition: 'border-color 120ms ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Disco ({snapshot.disk.mountPoint})
                </span>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={diskColor}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M3 5V19A9 3 0 0 0 21 19V5" />
                  <path d="M3 12A9 3 0 0 0 21 12" />
                </svg>
              </div>
              <div>
                <div
                  style={{
                    fontSize: '16px',
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--text-primary)',
                  }}
                >
                  {formatBytes(snapshot.disk.availableBytes, 0)} libres
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
                  {snapshot.disk.usagePercent}% usado de {formatBytes(snapshot.disk.totalBytes, 0)}
                </div>
              </div>
              <div
                style={{
                  height: '4px',
                  borderRadius: '999px',
                  backgroundColor: 'color-mix(in srgb, var(--text-secondary) 16%, transparent)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(3, Math.min(100, snapshot.disk.usagePercent))}%`,
                    backgroundColor: diskColor,
                    borderRadius: '999px',
                    transition: 'width 300ms ease',
                  }}
                />
              </div>
            </button>
          </div>
        )}

        {/* RUNTIME & UI DIAGNOSTICS BAR (Overview) */}
        {activeTab === 'overview' && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '6px',
              backgroundColor: 'var(--block-fill)',
              border: '1px solid var(--block-stroke)',
              borderRadius: '9px',
              padding: '8px 10px',
            }}
          >
            <div>
              <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Terminales PTY
              </div>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  marginTop: '1px',
                }}
              >
                {snapshot.runtime.activeTerminals} activas
              </div>
            </div>
            <div style={{ borderLeft: '1px solid var(--block-stroke)', paddingLeft: '8px' }}>
              <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Fluidez UI
              </div>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--status-running, #34c759)',
                  marginTop: '1px',
                }}
              >
                {uiFps} FPS
              </div>
            </div>
            <div style={{ borderLeft: '1px solid var(--block-stroke)', paddingLeft: '8px' }}>
              <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Subprocesos
              </div>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  marginTop: '1px',
                }}
              >
                {snapshot.runtime.processCount} activos
              </div>
            </div>
          </div>
        )}

        {/* DETAILED CPU TAB */}
        {activeTab === 'cpu' && (
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <CircularGauge
                  percentage={snapshot.cpu.systemUsagePercent}
                  color={cpuColor}
                  label={`${Math.round(snapshot.cpu.systemUsagePercent)}%`}
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
                    Carga de Procesador (CPU)
                  </div>
                  <div
                    style={{
                      fontSize: '19px',
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                      marginTop: '2px',
                    }}
                  >
                    App: {snapshot.cpu.appUsagePercent.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    Total del Sistema: {snapshot.cpu.systemUsagePercent.toFixed(1)}% ·{' '}
                    {snapshot.cpu.logicalCores} hilos lógicos
                  </div>
                </div>
              </div>
              <Sparkline values={sysCpuHistory} maxVal={100} color={cpuColor} width={115} height={36} />
            </div>

            <div
              style={{
                borderTop: '1px solid var(--block-stroke)',
                paddingTop: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Arquitectura / Modelo:</span>
                <span
                  style={{
                    fontWeight: 500,
                    maxWidth: '220px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={snapshot.cpu.model}
                >
                  {snapshot.cpu.model}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Árbol de Procesos de Kite:</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {snapshot.runtime.processCount} procesos (PID {snapshot.pid})
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Sesiones ConPTY / Agentes:</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {snapshot.runtime.activeTerminals} activas
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Rendimiento Render UI / IPC:</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {uiFps} FPS · {snapshot.ipcLatencyMs} ms
                </span>
              </div>
            </div>
          </div>
        )}

        {/* DETAILED DISK TAB */}
        {activeTab === 'disk' && (
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <CircularGauge
                percentage={snapshot.disk.usagePercent}
                color={diskColor}
                label={`${Math.round(snapshot.disk.usagePercent)}%`}
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
                  Almacenamiento Local ({snapshot.disk.mountPoint})
                </div>
                <div
                  style={{
                    fontSize: '19px',
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    marginTop: '2px',
                  }}
                >
                  {formatBytes(snapshot.disk.availableBytes, 1)} disponibles
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {formatBytes(snapshot.disk.usedBytes, 1)} usados de{' '}
                  {formatBytes(snapshot.disk.totalBytes, 1)}
                </div>
              </div>
            </div>

            <div
              style={{
                height: '6px',
                borderRadius: '999px',
                backgroundColor: 'color-mix(in srgb, var(--text-secondary) 16%, transparent)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.max(2, Math.min(100, snapshot.disk.usagePercent))}%`,
                  backgroundColor: diskColor,
                  borderRadius: '999px',
                  transition: 'width 300ms ease',
                }}
              />
            </div>

            <div
              style={{
                borderTop: '1px solid var(--block-stroke)',
                paddingTop: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Unidad del Workspace:</span>
                <span style={{ fontWeight: 600 }}>{snapshot.disk.mountPoint}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Base de datos & Scrollback PTY:</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {formatBytes(snapshot.disk.appCacheBytes)}
                </span>
              </div>
            </div>
          </div>
        )}
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
