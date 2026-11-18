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
  resetContextMonitorStats,
  type ContextMonitorState,
  type ContextMonitorView,
} from '../../../lib/contextMonitor';

export interface ContextTabProps {
  load?: () => Promise<ContextMonitorState>;
  onReset?: () => Promise<boolean>;
  intervalMs?: number;
}

type PanelState = ContextMonitorState | { status: 'loading' };

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--block-fill)',
  border: '1px solid var(--block-stroke)',
  borderRadius: 'var(--card-radius)',
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
};

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function ContextPanel({ view }: { view: ContextMonitorView }) {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <div>
          <div style={sectionHeadingStyle}>Ahorro acumulado</div>
          <div
            style={{
              fontSize: '22px',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              marginTop: '2px',
              color: 'var(--accent, #5c8fff)',
            }}
          >
            {formatTokenCount(view.lifetime.tokensSaved)} tokens
          </div>
          <div style={{ fontSize: '12px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: '2px' }}>
            {formatPercent(view.lifetime.savingsPercent)} · {formatUsd(view.lifetime.estimatedUsdSaved)}
            <span style={{ marginLeft: '6px', color: 'var(--text-secondary)', fontWeight: 500 }}>Estimado</span>
          </div>
        </div>
        {view.engineVersion ? (
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textAlign: 'right' }}>
            kite-ctx v{view.engineVersion}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <MetricLine label="Operaciones" value={formatTokenCount(view.lifetime.requests)} />
        <MetricLine
          label="Reutilización en caché"
          value={`${formatTokenCount(view.lifetime.cacheHits)} (${formatPercent(view.lifetime.cacheHitRate)})`}
        />
        <MetricLine
          label="Cuota preservada (30d · Pro / 5x)"
          value={`${formatPercent(view.quotaPreservation.proEquivalentPct)} · ${formatPercent(view.quotaPreservation.tier5xPct)}`}
        />
      </div>

      <div style={{ borderTop: '1px solid var(--block-stroke)', paddingTop: '8px' }}>
        <div style={{ ...sectionHeadingStyle, marginBottom: '4px' }}>Esta sesión</div>
        <div style={{ fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
          {formatTokenCount(view.session.tokensSaved)} tokens · {formatPercent(view.session.savingsPercent)} ·{' '}
          {formatUsd(view.session.estimatedUsdSaved)}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
          {formatTokenCount(view.session.requests)} operaciones · {formatTokenCount(view.session.cacheHits)} en caché
        </div>
      </div>

      {view.sparkline.length > 1 ? (
        <Sparkline values={view.sparkline} color="var(--accent, #5c8fff)" width={340} height={36} />
      ) : null}

      {view.agents.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={sectionHeadingStyle}>Por agente</div>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={sectionHeadingStyle}>Por modelo</div>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={sectionHeadingStyle}>Por funcionalidad</div>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={sectionHeadingStyle}>Por canal</div>
          {view.categories.map((row) => (
            <MetricLine
              key={row.category}
              label={formatContextCategoryLabel(row.category)}
              value={`${formatTokenCount(row.tokensSaved)} (${formatPercent(row.savingsPercent)})`}
            />
          ))}
        </div>
      ) : null}

      {view.discovery && view.discovery.scannedCommands > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', borderTop: '1px solid var(--block-stroke)', paddingTop: '8px' }}>
          <div style={sectionHeadingStyle}>Auditoría de intercepción</div>
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
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              100% de los comandos elegibles fueron interceptados por hooks activos.
            </div>
          )}
        </div>
      ) : null}

      <div style={{ fontSize: '10px', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
        Sobrecarga {formatMs(view.avgOverheadMs)} · CCR {formatTokenCount(view.ccrEntries)} · Handoffs{' '}
        {formatTokenCount(view.sharedEntries)} · Lecturas {formatTokenCount(view.readRecords)}
      </div>
    </div>
  );
}

export const ContextTab: React.FC<ContextTabProps> = ({
  load = loadContextMonitor,
  onReset = resetContextMonitorStats,
  intervalMs = 5000,
}) => {
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const next = await load();
    setState(next);
  }, [load]);

  const handleReset = useCallback(async () => {
    const ok = await onReset();
    if (ok) {
      await refresh();
    }
  }, [onReset, refresh]);

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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginBottom: '8px' }}>
        <button
          type="button"
          onClick={() => void handleReset()}
          style={{
            height: 'var(--vl-control-sm)',
            padding: '0 10px',
            borderRadius: 'var(--control-radius)',
            border: '1px solid var(--block-stroke)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          Reiniciar
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          style={{
            height: 'var(--vl-control-sm)',
            padding: '0 10px',
            borderRadius: 'var(--control-radius)',
            border: '1px solid var(--block-stroke)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          Actualizar
        </button>
      </div>
      {state.status === 'loading' ? (
        <div role="status" style={{ ...cardStyle, color: 'var(--text-secondary)' }}>
          Leyendo métricas del motor de contexto.
        </div>
      ) : null}
      {state.status === 'offline' ? (
        <div role="status" style={{ ...cardStyle, color: 'var(--text-secondary)' }}>
          {state.message || CONTEXT_OFFLINE_MESSAGE}
        </div>
      ) : null}
      {state.status === 'online' ? <ContextPanel view={state.view} /> : null}
    </section>
  );
};
