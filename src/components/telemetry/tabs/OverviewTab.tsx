import React from 'react';
import {
  type SystemMetricsSnapshot,
  formatBytes,
} from '../../../lib/systemMetrics';
import { type RuntimeTransportMetrics } from '../../../lib/ipc/chat';
import { formatPercent, formatTokenCount } from '../../../lib/contextMonitor';
import { Sparkline } from '../TelemetryGauges';
import {
  ActivityPulseIcon,
  ArrowRightIcon,
  HardDriveIcon,
} from '../../titlebar/TopbarPopoverIcons';

export interface OverviewTabProps {
  snapshot: SystemMetricsSnapshot;
  appCpuHistory: number[];
  cpuColor: string;
  diskColor: string;
  uiFps: number;
  contextSummary?: {
    tokensSaved: number;
    savingsPercent: number;
    requests: number;
    wastedTurn0Tokens?: number;
  } | null;
  transportMetrics?: RuntimeTransportMetrics | null;
  onSelectTab: (tab: 'cpu' | 'disk' | 'context') => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = React.memo(({
  snapshot,
  appCpuHistory,
  cpuColor,
  diskColor,
  uiFps,
  contextSummary,
  transportMetrics,
  onSelectTab,
}) => {
  const activeMuxDaemons = transportMetrics?.activeMuxDaemons ?? 0;
  const muxSessionsTotal =
    (transportMetrics?.agyAcp?.sessions ?? 0) +
    (transportMetrics?.opencode?.leases ?? 0) +
    (transportMetrics?.grok?.sessions ?? 0);
  const pooledStdioServers = transportMetrics?.mcpHub?.pooledStdioServers ?? 0;
  const mcpHttpRunning = Boolean(transportMetrics?.mcpHub?.httpRunning);
  const mcpPort = transportMetrics?.mcpHub?.port ?? null;
  const mcpRequestCount = transportMetrics?.mcpHub?.requestCount ?? 0;
  const fastLaneSessions = transportMetrics?.activeFastLaneSessions ?? 0;
  const fastLaneEnabled = Boolean(transportMetrics?.settings?.fastLaneEnabled);
  const heavyActive = transportMetrics?.governor?.heavyActive ?? 0;
  const heavyLimit = transportMetrics?.governor?.heavyLimit ?? 0;
  const heavyQueued = transportMetrics?.governor?.heavyQueued ?? 0;

  return (
    <>
      {/* OVERVIEW GRID: CPU & Disk Instrument Cards */}
      <div className="tm-bento-grid">
        {/* CPU Card */}
        <button
          type="button"
          className="tm-bento-card"
          onClick={() => onSelectTab('cpu')}
        >
          <div className="tm-bento-card__head">
            <span className="tm-hero-kicker">Procesador (CPU)</span>
            <span style={{ color: cpuColor }}>
              <ActivityPulseIcon size={13} />
            </span>
          </div>
          <div className="tm-bento-card__body">
            <div>
              <div className="tm-bento-card__val">
                {snapshot.cpu.appUsagePercent.toFixed(1)}%
              </div>
              <div className="tm-bento-card__sub">
                App · Sistema {snapshot.cpu.systemUsagePercent.toFixed(1)}%
              </div>
            </div>
            <Sparkline values={appCpuHistory} maxVal={100} color={cpuColor} width={66} height={24} />
          </div>
          <div className="tp-meter">
            <div
              className="tp-meter__fill"
              style={{
                width: `${Math.max(3, Math.min(100, snapshot.cpu.systemUsagePercent))}%`,
                backgroundColor: cpuColor,
              }}
            />
          </div>
        </button>

        {/* Disk Card */}
        <button
          type="button"
          className="tm-bento-card"
          onClick={() => onSelectTab('disk')}
        >
          <div className="tm-bento-card__head">
            <span className="tm-hero-kicker">Disco ({snapshot.disk.mountPoint})</span>
            <span style={{ color: diskColor }}>
              <HardDriveIcon size={13} />
            </span>
          </div>
          <div>
            <div className="tm-bento-card__val">
              {formatBytes(snapshot.disk.availableBytes, 0)} libres
            </div>
            <div className="tm-bento-card__sub">
              {snapshot.disk.usagePercent}% usado de {formatBytes(snapshot.disk.totalBytes, 0)}
            </div>
          </div>
          <div className="tp-meter">
            <div
              className="tp-meter__fill"
              style={{
                width: `${Math.max(3, Math.min(100, snapshot.disk.usagePercent))}%`,
                backgroundColor: diskColor,
              }}
            />
          </div>
        </button>
      </div>

      {/* RUNTIME & UI DIAGNOSTICS STRIP */}
      <div className="tm-diag-strip">
        <div className="tm-diag-cell">
          <div className="tm-diag-cell__label">Terminales PTY</div>
          <div className="tm-diag-cell__val">{snapshot.runtime.activeTerminals} activas</div>
        </div>
        <div className="tm-diag-cell">
          <div className="tm-diag-cell__label">Agentes AI</div>
          <div className="tm-diag-cell__val tm-diag-cell__val--accent">
            {formatBytes(snapshot.memory.appAgentsBytes ?? snapshot.memory.appTerminalsBytes)}
          </div>
        </div>
        <div className="tm-diag-cell">
          <div className="tm-diag-cell__label">Servidores MCP</div>
          <div className="tm-diag-cell__val tm-diag-cell__val--violet">
            {snapshot.memory.appMcpsBytes ? formatBytes(snapshot.memory.appMcpsBytes) : '0 B'}
          </div>
        </div>
        <div className="tm-diag-cell">
          <div className="tm-diag-cell__label">Fluidez UI</div>
          <div className="tm-diag-cell__val tm-diag-cell__val--success">{uiFps} FPS</div>
        </div>
      </div>

      {/* RUNTIME TRANSPORT & GOVERNOR SUMMARY */}
      <section aria-label="Arquitectura de transporte" className="ctx-card">
        <div className="tp-eyebrow">Arquitectura de transporte</div>
        <div className="ctx-health-grid">
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">Daemons multiplexados</span>
            <span className="ctx-health-tile-value">{activeMuxDaemons}</span>
            <span className="ctx-health-tile-sub">{muxSessionsTotal} sesiones mux</span>
          </div>
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">Pool MCP</span>
            <span className="ctx-health-tile-value">
              {pooledStdioServers} servidores · HTTP {mcpHttpRunning ? 'activo' : 'inactivo'}
            </span>
            <span className="ctx-health-tile-sub">
              {mcpPort != null ? `Puerto ${mcpPort} · ${mcpRequestCount} req` : `${mcpRequestCount} req`}
            </span>
          </div>
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">Fast Lane</span>
            <span className="ctx-health-tile-value">{fastLaneSessions} sesiones</span>
            <span className="ctx-health-tile-sub">
              {fastLaneEnabled ? 'Habilitado (API / Go)' : 'En espera / inactivo'}
            </span>
          </div>
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">Concurrencia pesada</span>
            <span className="ctx-health-tile-value">
              {heavyActive}/{heavyLimit}
            </span>
            <span className="ctx-health-tile-sub">
              {heavyQueued > 0 ? `${heavyQueued} en cola` : 'Sin procesos en cola'}
            </span>
          </div>
        </div>
      </section>

      {/* CONTEXT ENGINE SUMMARY SHORTCUT */}
      <button
        type="button"
        className="tm-nav-row"
        onClick={() => onSelectTab('context')}
      >
        <span className="tm-spec-label">
          Motor de contexto:{' '}
          <strong className="tm-hero-sub--accent">
            {contextSummary && contextSummary.requests > 0
              ? `${formatTokenCount(contextSummary.tokensSaved)} tokens ahorrados (${formatPercent(contextSummary.savingsPercent)})`
              : 'Sin actividad aún'}
          </strong>
          {(contextSummary?.wastedTurn0Tokens ?? 0) > 0 ? (
            <span className="ctx-overview-turn0">
              {' '}
              · Turn-0: ~{formatTokenCount(contextSummary?.wastedTurn0Tokens ?? 0)} redundantes
            </span>
          ) : null}
        </span>
        <span className="tm-nav-row__cta">
          <span>Por funcionalidad</span>
          <ArrowRightIcon size={12} />
        </span>
      </button>
    </>
  );
});
