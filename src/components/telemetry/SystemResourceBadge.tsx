import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  type SystemMetricsSnapshot,
  type SystemMetricsHistoryPoint,
  fetchSystemMetricsSnapshot,
  formatBytes,
  getPressureColors,
  readSystemMetricsPreferences,
  SYSTEM_METRICS_PREFS_EVENT,
} from '../../lib/systemMetrics';
import { SystemResourcePopover } from './SystemResourcePopover';

export interface SystemResourceBadgeProps {
  className?: string;
}

const MAX_HISTORY_POINTS = 24;

export const SystemResourceBadge: React.FC<SystemResourceBadgeProps> = ({ className = '' }) => {
  const [snapshot, setSnapshot] = useState<SystemMetricsSnapshot | null>(null);
  const [history, setHistory] = useState<SystemMetricsHistoryPoint[]>([]);
  const [prefs, setPrefs] = useState(() => readSystemMetricsPreferences());
  const [isOpen, setIsOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef<boolean>(true);

  const pollMetrics = useCallback(async (manual = false) => {
    if (manual && mountedRef.current) setIsRefreshing(true);
    try {
      const data = await fetchSystemMetricsSnapshot();
      if (!mountedRef.current) return;
      setSnapshot(data);
      setHistory((prev) => {
        const point: SystemMetricsHistoryPoint = {
          timestampMs: data.timestampMs,
          appRamMb: Math.round(data.memory.appTotalBytes / (1024 * 1024)),
          sysRamPct: data.memory.systemUsagePercent,
          appCpuPct: data.cpu.appUsagePercent,
          sysCpuPct: data.cpu.systemUsagePercent,
        };
        const next = [...prev, point];
        return next.length > MAX_HISTORY_POINTS ? next.slice(next.length - MAX_HISTORY_POINTS) : next;
      });
    } finally {
      if (manual && mountedRef.current) setIsRefreshing(false);
    }
  }, []);

  // Periodic polling based on preferences
  useEffect(() => {
    mountedRef.current = true;
    // Defer initial poll so startup frames render instantly without process table scanning (0ms in tests)
    const isTest = typeof globalThis !== 'undefined' && (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === 'test';
    const initialDelay = isTest ? 0 : 2500;
    const initialTimer = window.setTimeout(() => {
      if (mountedRef.current) {
        pollMetrics(false);
      }
    }, initialDelay);

    const intervalId = window.setInterval(() => {
      if (mountedRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        pollMetrics(false);
      }
    }, prefs.refreshIntervalMs);

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && mountedRef.current) {
        pollMetrics(false);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      mountedRef.current = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalId);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [prefs.refreshIntervalMs, pollMetrics]);

  // Listen to preference updates from popover
  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail) {
        setPrefs(e.detail);
      }
    };
    window.addEventListener(SYSTEM_METRICS_PREFS_EVENT, handler);
    return () => window.removeEventListener(SYSTEM_METRICS_PREFS_EVENT, handler);
  }, []);

  const handleToggle = () => {
    if (!isOpen && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setIsOpen((prev) => !prev);
  };

  const appRamFormatted = snapshot ? formatBytes(snapshot.memory.appTotalBytes) : '-- MB';
  const pressure = snapshot?.memory.pressure ?? 'normal';
  const pressureTheme = getPressureColors(pressure);
  const sysPct = snapshot?.memory.systemUsagePercent ?? 0;

  // Mini ring math (13x13 svg)
  const ringSize = 13;
  const ringStroke = 2;
  const radius = (ringSize - ringStroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.max(6, Math.min(100, sysPct));
  const dashOffset = circumference - (clampedPct / 100) * circumference;

  const tooltipText = snapshot
    ? `Consumo RAM App: ${appRamFormatted} (${snapshot.memory.appShareOfSystemPercent}% del equipo · Estado: ${pressureTheme.label}) · CPU: ${snapshot.cpu.appUsagePercent.toFixed(1)}% · Disco libre: ${formatBytes(snapshot.disk.availableBytes, 0)}. Clic para abrir el monitor de recursos.`
    : 'Cargando consumo de memoria RAM y recursos del sistema...';

  return (
    <div
      className={`system-resource-container ${className}`}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="system-resource-badge"
        onClick={handleToggle}
        title={tooltipText}
        aria-label={tooltipText}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="system-resource-badge"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 8px',
          height: '24px',
          width: 'auto',
          borderRadius: 'var(--radius-chip, 6px)',
          border: isOpen
            ? `1px solid ${pressureTheme.stroke}`
            : '1px solid var(--block-stroke)',
          backgroundColor: isOpen ? 'var(--block-stroke)' : 'var(--block-fill)',
          color: 'var(--text-primary)',
          fontSize: '11px',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 120ms ease',
          outline: 'none',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        {/* Micro RAM Chip SVG */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke={pressureTheme.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0, opacity: 0.92 }}
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

        {/* Micro Progress Ring */}
        <svg
          width={ringSize}
          height={ringSize}
          style={{
            transform: 'rotate(-90deg)',
            display: 'block',
            overflow: 'visible',
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            stroke="color-mix(in srgb, var(--text-secondary) 26%, transparent)"
            strokeWidth={ringStroke}
            fill="transparent"
          />
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={radius}
            stroke={pressureTheme.color}
            strokeWidth={ringStroke}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            fill="transparent"
            style={{
              transition:
                'stroke-dashoffset 400ms cubic-bezier(0.16, 1, 0.3, 1), stroke 300ms ease',
            }}
          />
        </svg>

        {/* Label & Primary RAM Metric */}
        <span
          style={{
            fontSize: '10px',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            letterSpacing: '0.02em',
          }}
        >
          RAM
        </span>

        <span
          data-testid="system-resource-ram-value"
          style={{
            fontWeight: 700,
            fontSize: '11px',
            fontVariantNumeric: 'tabular-nums',
            color:
              pressure === 'critical' || pressure === 'high'
                ? pressureTheme.color
                : 'var(--text-primary)',
          }}
        >
          {prefs.badgeMode === 'ram_percent' && snapshot
            ? `${snapshot.memory.systemUsagePercent}%`
            : appRamFormatted}
        </span>

        {/* Optional CPU readout when badgeMode === 'ram_and_cpu' */}
        {prefs.badgeMode === 'ram_and_cpu' && snapshot && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              borderLeft: '1px solid var(--block-stroke)',
              paddingLeft: '6px',
              fontSize: '10px',
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--text-secondary)',
            }}
          >
            <span>CPU</span>
            <strong style={{ color: 'var(--accent, #5c8fff)', fontWeight: 700 }}>
              {snapshot.cpu.appUsagePercent.toFixed(1)}%
            </strong>
          </span>
        )}
      </button>

      {isOpen && snapshot && (
        <SystemResourcePopover
          snapshot={snapshot}
          history={history}
          prefs={prefs}
          isRefreshing={isRefreshing}
          onRefresh={() => pollMetrics(true)}
          onClose={() => setIsOpen(false)}
          anchorRect={anchorRect}
        />
      )}
    </div>
  );
};
