import React, { useCallback, useEffect, useState } from 'react';
import { Sparkline } from '../TelemetryGauges';
import {
  CONTEXT_OFFLINE_MESSAGE,
  formatContextCategoryLabel,
  formatContextFeatureLabel,
  formatMs,
  formatPercent,
  formatTokenCount,
  formatUsd,
  loadContextMonitor,
  refreshContextMonitor,
  resetContextMonitorStats,
  type ContextMonitorState,
  type ContextMonitorView,
} from '../../../lib/contextMonitor';

export interface ContextTabProps {
  load?: () => Promise<ContextMonitorState>;
  onRefresh?: () => Promise<ContextMonitorState>;
  onReset?: () => Promise<boolean>;
  intervalMs?: number;
}

type PanelState = ContextMonitorState | { status: 'loading' };

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="ctx-metric-row">
      <span className="ctx-metric-label">{label}</span>
      <span className="ctx-metric-value">{value}</span>
    </div>
  );
}

function ContextPanel({ view }: { view: ContextMonitorView }) {
  const grossSaved = Math.max(view.lifetime.grossTokensSaved, view.lifetime.tokensSaved);
  const ccrRetrieved = view.lifetime.ccrRetrievedTokens || view.ccrRetrieveTokens;

  return (
    <div className="ctx-card">
      <div className="ctx-hero">
        <div>
          <div className="ctx-hero-label-row">
            <div className="ctx-section-title">Ahorro acumulado</div>
            <span className="ctx-badge-net">Neto</span>
          </div>
          <div className="ctx-hero-value">
            {formatTokenCount(view.lifetime.tokensSaved)} tokens
          </div>
          <div className="ctx-hero-sub">
            {formatPercent(view.lifetime.savingsPercent)} · {formatUsd(view.lifetime.estimatedUsdSaved)}
            <span className="ctx-hero-sub-hint">Estimado</span>
          </div>
          <div className="ctx-hero-breakdown">
            {ccrRetrieved > 0
              ? `Bruto ${formatTokenCount(grossSaved)} − CCR ${formatTokenCount(ccrRetrieved)}`
              : `Bruto ${formatTokenCount(grossSaved)}`}
          </div>
        </div>
        {view.engineVersion ? (
          <div className="ctx-version">kite-ctx v{view.engineVersion}</div>
        ) : null}
      </div>

      <div className="ctx-section">
        <MetricLine label="Operaciones" value={formatTokenCount(view.lifetime.requests)} />
        <MetricLine
          label="Cuota preservada (30d · Pro / 5x)"
          value={`${formatPercent(view.quotaPreservation.proEquivalentPct)} · ${formatPercent(view.quotaPreservation.tier5xPct)}`}
        />
      </div>

      <div className="ctx-section ctx-section--divided">
        <div className="ctx-section-title">Salud del motor</div>
        <div className="ctx-health-grid">
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">Caché real</span>
            <span className="ctx-health-tile-value">
              {formatTokenCount(view.lifetime.cacheHits)} ({formatPercent(view.lifetime.cacheHitRate)})
            </span>
            <span className="ctx-health-tile-sub">Lecturas + comandos</span>
          </div>
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">KV Prefix Hits</span>
            <span className="ctx-health-tile-value">{formatTokenCount(view.kvPrefixHits)}</span>
            <span className="ctx-health-tile-sub">{formatTokenCount(view.kvSessions)} sesiones</span>
          </div>
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">CCR FTS5</span>
            <span className="ctx-health-tile-value">{formatTokenCount(view.ccrEntries)} entradas</span>
            <span className="ctx-health-tile-sub">
              {formatTokenCount(view.ccrRetrieveCalls)} consultas
            </span>
          </div>
          <div className="ctx-health-tile">
            <span className="ctx-health-tile-label">Tool Cache</span>
            <span className="ctx-health-tile-value">{formatTokenCount(view.toolCacheEntries)} entradas</span>
            <span className="ctx-health-tile-sub">git inmutable</span>
          </div>
        </div>
      </div>

      <div className="ctx-section ctx-section--divided">
        <div className="ctx-section-title">Esta sesión</div>
        <div className="ctx-session-headline">
          {formatTokenCount(view.session.tokensSaved)} tokens · {formatPercent(view.session.savingsPercent)} ·{' '}
          {formatUsd(view.session.estimatedUsdSaved)}
        </div>
        <div className="ctx-muted-note">
          {formatTokenCount(view.session.requests)} operaciones · {formatTokenCount(view.session.cacheHits)} en caché
        </div>
      </div>

      {view.sparkline.length > 1 ? (
        <Sparkline values={view.sparkline} color="var(--accent, #5c8fff)" width={340} height={36} />
      ) : null}

      {view.agents.length > 0 ? (
        <div className="ctx-section">
          <div className="ctx-section-title">Por agente</div>
          {view.agents.map((row) => (
            <MetricLine
              key={row.agent}
              label={row.agent}
              value={`${formatTokenCount(row.tokensSaved)} (${formatPercent(row.savingsPercent)})`}
            />
          ))}
        </div>
      ) : null}

      {view.models.length > 0 ? (
        <div className="ctx-section">
          <div className="ctx-section-title">Por modelo</div>
          {view.models.map((row) => (
            <MetricLine
              key={row.model}
              label={row.model}
              value={`${formatTokenCount(row.tokensSaved)} · ${formatUsd(row.savingsUsd)}`}
            />
          ))}
        </div>
      ) : null}

      {view.features.length > 0 ? (
        <div className="ctx-section">
          <div className="ctx-section-title">Por funcionalidad</div>
          {view.features.map((row) => (
            <MetricLine
              key={row.feature}
              label={formatContextFeatureLabel(row.feature)}
              value={`${formatTokenCount(row.tokensSaved)} (${formatPercent(row.savingsPercent)}) · ${row.requests} ops`}
            />
          ))}
        </div>
      ) : null}

      {view.categories.length > 0 ? (
        <div className="ctx-section">
          <div className="ctx-section-title">Por canal</div>
          {view.categories.map((row) => (
            <MetricLine
              key={row.category}
              label={formatContextCategoryLabel(row.category)}
              value={`${formatTokenCount(row.tokensSaved)} (${formatPercent(row.savingsPercent)})`}
            />
          ))}
        </div>
      ) : null}

      {view.audit.totalFiles > 0 ? (
        <div className="ctx-section ctx-section--divided">
          <div className="ctx-section-title">Auditoría Turn-0</div>
          <MetricLine
            label="Archivos / Tokens Turn-0"
            value={`${formatTokenCount(view.audit.totalFiles)} / ~${formatTokenCount(view.audit.totalTokens)}`}
          />
          {view.audit.wastedTokens > 0 ? (
            <div className="ctx-audit-banner">
              <span>
                ~{formatTokenCount(view.audit.wastedTokens)} redundantes ({view.audit.duplicateBlocks} dup ·{' '}
                {view.audit.staleBlocks} obsoletos · {view.audit.oversizedFiles} grandes)
              </span>
              <code className="ctx-audit-hint">kite ctx audit --fix</code>
            </div>
          ) : (
            <div className="ctx-muted-note">
              Sin bloques duplicados ni reglas obsoletas en Turn-0.
            </div>
          )}
          {view.audit.findings.slice(0, 3).map((finding, idx) => (
            <MetricLine
              key={`${finding.kind}:${finding.path}:${idx}`}
              label={`${finding.fixable ? '↳ ' : 'ℹ '}${finding.agent} · ${finding.label}`}
              value={
                finding.fixable
                  ? `~${formatTokenCount(finding.wastedTokens)} (reparable)`
                  : `~${formatTokenCount(finding.wastedTokens)} (${
                      finding.kind === 'cross_host_overlap' ? 'compartido' : 'grande'
                    })`
              }
            />
          ))}
        </div>
      ) : null}

      {view.discovery && view.discovery.scannedCommands > 0 ? (
        <div className="ctx-section ctx-section--divided">
          <div className="ctx-section-title">Auditoría de intercepción</div>
          <MetricLine
            label="Comandos auditados / optimizados"
            value={`${formatTokenCount(view.discovery.scannedCommands)} / ${formatTokenCount(view.discovery.alreadyOptimized)}`}
          />
          {view.discovery.missedCommands > 0 ? (
            <>
              <MetricLine
                label="Ahorro potencial no interceptado"
                value={`~${formatTokenCount(view.discovery.estimatedMissedTokens)} (${view.discovery.missedCommands} cmds)`}
              />
              {view.discovery.topCandidates.slice(0, 3).map((cand) => (
                <MetricLine
                  key={cand.command}
                  label={`↳ ${cand.command}`}
                  value={`${cand.count}x · ~${formatTokenCount(cand.estimatedMissedTokens)}`}
                />
              ))}
            </>
          ) : (
            <div className="ctx-muted-note">
              100% de los comandos elegibles fueron interceptados por hooks activos.
            </div>
          )}
        </div>
      ) : null}

      <div className="ctx-footer-meta">
        Sobrecarga {formatMs(view.avgOverheadMs)} · CCR {formatTokenCount(view.ccrEntries)} · Handoffs{' '}
        {formatTokenCount(view.sharedEntries)} · Lecturas {formatTokenCount(view.readRecords)}
      </div>
    </div>
  );
}

export const ContextTab: React.FC<ContextTabProps> = ({
  load = loadContextMonitor,
  onRefresh,
  onReset = resetContextMonitorStats,
  intervalMs = 5000,
}) => {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const isCustomLoader = load !== loadContextMonitor;
  const effectiveRefresh = onRefresh ?? (isCustomLoader ? load : refreshContextMonitor);

  const refresh = useCallback(async () => {
    const next = await effectiveRefresh();
    setState(next);
  }, [effectiveRefresh]);

  const handleReset = useCallback(async () => {
    const ok = await onReset();
    if (ok) {
      const next = await load();
      setState(next);
    }
  }, [load, onReset]);

  useEffect(() => {
    let active = true;
    void load().then((next) => {
      if (active) setState(next);
    });
    if (intervalMs <= 0) {
      return () => {
        active = false;
      };
    }
    const timer = window.setInterval(() => {
      void load().then((next) => {
        if (active) setState(next);
      });
    }, intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [intervalMs, load]);

  return (
    <section aria-label="Monitor de Contexto">
      <div className="ctx-tab-toolbar">
        <button type="button" onClick={() => void handleReset()} className="ctx-tab-btn">
          Reiniciar
        </button>
        <button type="button" onClick={() => void refresh()} className="ctx-tab-btn">
          Actualizar
        </button>
      </div>
      {state.status === 'loading' ? (
        <div role="status" className="ctx-card ctx-card--muted">
          Leyendo métricas del motor de contexto.
        </div>
      ) : null}
      {state.status === 'offline' ? (
        <div role="status" className="ctx-card ctx-card--muted">
          {state.message || CONTEXT_OFFLINE_MESSAGE}
        </div>
      ) : null}
      {state.status === 'online' ? <ContextPanel view={state.view} /> : null}
    </section>
  );
};
