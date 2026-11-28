import React from 'react';
import { type SystemMetricsSnapshot } from '../../../lib/systemMetrics';
import { CircularGauge, Sparkline } from '../TelemetryGauges';

export interface CpuTabProps {
  snapshot: SystemMetricsSnapshot;
  sysCpuHistory: number[];
  cpuColor: string;
  uiFps: number;
}

export const CpuTab: React.FC<CpuTabProps> = React.memo(({
  snapshot,
  sysCpuHistory,
  cpuColor,
  uiFps,
}) => {
  return (
    <div className="tm-hero-card">
      <div className="tm-hero-top">
        <div className="tm-hero-left">
          <CircularGauge
            percentage={snapshot.cpu.systemUsagePercent}
            color={cpuColor}
            label={`${Math.round(snapshot.cpu.systemUsagePercent)}%`}
          />
          <div>
            <div className="tm-hero-kicker">Carga de Procesador (CPU)</div>
            <div className="tm-hero-value">App: {snapshot.cpu.appUsagePercent.toFixed(1)}%</div>
            <div className="tm-hero-sub">
              Total del Sistema: {snapshot.cpu.systemUsagePercent.toFixed(1)}% ·{' '}
              {snapshot.cpu.logicalCores} hilos lógicos
            </div>
          </div>
        </div>
        <Sparkline values={sysCpuHistory} maxVal={100} color={cpuColor} width={114} height={36} />
      </div>

      <div className="tm-spec-sheet">
        <div className="tm-spec-row">
          <span className="tm-spec-label">Arquitectura / Modelo:</span>
          <span className="tm-spec-val" title={snapshot.cpu.model}>
            {snapshot.cpu.model}
          </span>
        </div>
        <div className="tm-spec-row">
          <span className="tm-spec-label">Árbol de Procesos de Kite:</span>
          <span className="tm-spec-val">
            {snapshot.runtime.processCount} procesos (PID {snapshot.pid})
          </span>
        </div>
        <div className="tm-spec-row">
          <span className="tm-spec-label">Sesiones ConPTY / Agentes:</span>
          <span className="tm-spec-val">{snapshot.runtime.activeTerminals} activas</span>
        </div>
        <div className="tm-spec-row">
          <span className="tm-spec-label">Rendimiento Render UI / IPC:</span>
          <span className="tm-spec-val">
            {uiFps} FPS · {snapshot.ipcLatencyMs} ms
          </span>
        </div>
      </div>
    </div>
  );
});
