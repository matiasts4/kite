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

export const DiskTab: React.FC<DiskTabProps> = React.memo(({
  snapshot,
  diskColor,
}) => {
  return (
    <div className="tm-hero-card">
      <div className="tm-hero-left">
        <CircularGauge
          percentage={snapshot.disk.usagePercent}
          color={diskColor}
          label={`${Math.round(snapshot.disk.usagePercent)}%`}
        />
        <div>
          <div className="tm-hero-kicker">Almacenamiento Local ({snapshot.disk.mountPoint})</div>
          <div className="tm-hero-value">
            {formatBytes(snapshot.disk.availableBytes, 1)} disponibles
          </div>
          <div className="tm-hero-sub">
            {formatBytes(snapshot.disk.usedBytes, 1)} usados de{' '}
            {formatBytes(snapshot.disk.totalBytes, 1)}
          </div>
        </div>
      </div>

      <div className="tp-meter tp-meter--md">
        <div
          className="tp-meter__fill"
          style={{
            width: `${Math.max(2, Math.min(100, snapshot.disk.usagePercent))}%`,
            backgroundColor: diskColor,
          }}
        />
      </div>

      <div className="tm-spec-sheet">
        <div className="tm-spec-row">
          <span className="tm-spec-label">Unidad del Workspace:</span>
          <span className="tm-spec-val">{snapshot.disk.mountPoint}</span>
        </div>
        <div className="tm-spec-row">
          <span className="tm-spec-label">Base de datos & Scrollback PTY:</span>
          <span className="tm-spec-val">{formatBytes(snapshot.disk.appCacheBytes)}</span>
        </div>
      </div>
    </div>
  );
});
