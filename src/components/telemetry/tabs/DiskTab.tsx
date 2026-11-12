import React from 'react';
import {
  type SystemMetricsSnapshot,
  formatBytes,
} from '../../../lib/systemMetrics';
import { CircularGauge } from '../TelemetryGauges';

export interface DiskTabProps {
  snapshot: SystemMetricsSnapshot;
  diskColor: string;
}

export const DiskTab: React.FC<DiskTabProps> = ({
  snapshot,
  diskColor,
}) => {
  return (
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
  );
};
