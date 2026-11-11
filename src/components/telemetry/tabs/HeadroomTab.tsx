import React, { useCallback, useEffect, useState } from 'react';
import { Sparkline } from '../TelemetryGauges';
import {
  formatMs,
  formatPercent,
  formatTokenCount,
  formatUptimeMinutes,
  formatUsd,
  HEADROOM_OFFLINE_MESSAGE,
  loadHeadroomMonitor,
  type HeadroomMonitorState,
  type HeadroomMonitorView,
} from '../../../lib/headroomMonitor';

export interface HeadroomTabProps {
  load?: () => Promise<HeadroomMonitorState>;
  intervalMs?: number;
}

type PanelState = HeadroomMonitorState | { status: 'loading' };

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--block-fill)',
  border: '1px solid var(--block-stroke)',
  borderRadius: 'var(--card-radius)',
  padding: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function HeadroomPanel({ view }: { view: HeadroomMonitorView }) {
  const meta = [
    view.version ? `v${view.version}` : null,
    view.uptimeSeconds != null ? formatUptimeMinutes(view.uptimeSeconds) : null,
    view.mode,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <div>
          <div
            style={{
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
            }}
          >
            Ahorro acumulado
          </div>
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
            {formatUsd(view.lifetime.savingsUsd)}
            {view.lifetime.estimatedUsd ? (
              <span style={{ marginLeft: '6px', color: 'var(--text-secondary)', fontWeight: 500 }}>Estimado</span>
            ) : null}
          </div>
        </div>
        {meta ? (
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textAlign: 'right' }}>{meta}</div>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <MetricLine label="Peticiones" value={formatTokenCount(view.lifetime.requests)} />
        <MetricLine label="Tokens de caché" value={formatTokenCount(view.lifetime.cacheReadTokens)} />
        <MetricLine
          label="Coste de entrada"
          value={formatUsd(view.lifetime.inputCostUsd)}
        />
      </div>

      <div style={{ borderTop: '1px solid var(--block-stroke)', paddingTop: '8px' }}>
        <div
          style={{
            fontSize: '10px',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '4px',
          }}
        >
          Esta sesión
        </div>
        <div style={{ fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
          {formatTokenCount(view.session.tokensSaved)} tokens · {formatPercent(view.session.savingsPercent)} ·{' '}
          {formatUsd(view.session.savingsUsd)}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
          {formatTokenCount(view.session.requests)} peticiones
        </div>
      </div>

      {view.sparkline.length > 1 ? (
        <Sparkline values={view.sparkline} color="var(--accent, #5c8fff)" width={340} height={36} />
      ) : null}

      {view.models.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div
            style={{
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
            }}
          >
            Por modelo
          </div>
          {view.models.map((row) => (
            <MetricLine
              key={row.model}
              label={row.model}
              value={`${formatTokenCount(row.tokensSaved)} · ${formatUsd(row.savingsUsd)}`}
            />
          ))}
        </div>
      ) : null}

      {view.agents.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div
            style={{
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
            }}
          >
            Agentes en esta sesión
          </div>
          {view.agents.map((row) => (
            <MetricLine
              key={row.label}
              label={row.label}
              value={`${formatTokenCount(row.tokensSaved)} tokens`}
            />
          ))}
        </div>
      ) : null}

      <div style={{ fontSize: '10px', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
        {view.overheadMs != null ? `Sobrecarga ${formatMs(view.overheadMs)}` : 'Sobrecarga —'}
        {' · '}
        Fallidas {formatTokenCount(view.requestsFailed)}
      </div>
    </div>
  );
}

export const HeadroomTab: React.FC<HeadroomTabProps> = ({
  load = loadHeadroomMonitor,
  intervalMs = 5000,
}) => {
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const next = await load();
    setState(next);
  }, [load]);

  useEffect(() => {
    let active = true;
    void load().then((next) => {
      if (active) setState(next);
    });
    if (intervalMs <= 0) return () => {
      active = false;
    };
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
    <section aria-label="Monitor de Headroom">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
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
          Leyendo métricas de Headroom.
        </div>
      ) : null}
      {state.status === 'offline' ? (
        <div role="status" style={{ ...cardStyle, color: 'var(--text-secondary)' }}>
          {state.message || HEADROOM_OFFLINE_MESSAGE}
        </div>
      ) : null}
      {state.status === 'online' ? <HeadroomPanel view={state.view} /> : null}
    </section>
  );
};
