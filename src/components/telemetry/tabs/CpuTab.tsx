import React from 'react';
import { type SystemMetricsSnapshot } from '../../../lib/systemMetrics';
import { CircularGauge, Sparkline } from '../TelemetryGauges';

export interface CpuTabProps {
  snapshot: SystemMetricsSnapshot;
  sysCpuHistory: number[];
  cpuColor: string;
  uiFps: number;
}

export const CpuTab: React.FC<CpuTabProps> = ({
  snapshot,
  sysCpuHistory,
  cpuColor,
  uiFps,
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
  );
};
