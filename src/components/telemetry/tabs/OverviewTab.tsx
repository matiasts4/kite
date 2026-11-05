import React from 'react';
import {
  type SystemMetricsSnapshot,
  formatBytes,
} from '../../../lib/systemMetrics';
import { Sparkline } from '../TelemetryGauges';

export interface OverviewTabProps {
  snapshot: SystemMetricsSnapshot;
  appCpuHistory: number[];
  cpuColor: string;
  diskColor: string;
  uiFps: number;
  onSelectTab: (tab: 'cpu' | 'disk') => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  snapshot,
  appCpuHistory,
  cpuColor,
  diskColor,
  uiFps,
  onSelectTab,
}) => {
  return (
    <>
      {/* OVERVIEW GRID: CPU, Disk, & Runtime Health Cards */}
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
          onClick={() => onSelectTab('cpu')}
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
          onClick={() => onSelectTab('disk')}
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

      {/* RUNTIME & UI DIAGNOSTICS BAR */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '6px',
          backgroundColor: 'var(--block-fill)',
          border: '1px solid var(--block-stroke)',
          borderRadius: 'var(--control-radius, 8px)',
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
            Agentes AI
          </div>
          <div
            style={{
              fontSize: '13px',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--accent, #5c8fff)',
              marginTop: '1px',
            }}
          >
            {formatBytes(snapshot.memory.appAgentsBytes ?? snapshot.memory.appTerminalsBytes)}
          </div>
        </div>
        <div style={{ borderLeft: '1px solid var(--block-stroke)', paddingLeft: '8px' }}>
          <div style={{ fontSize: '9px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            Servidores MCP
          </div>
          <div
            style={{
              fontSize: '13px',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              color: '#c084fc',
              marginTop: '1px',
            }}
          >
            {snapshot.memory.appMcpsBytes ? formatBytes(snapshot.memory.appMcpsBytes) : '0 B'}
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
      </div>
    </>
  );
};
