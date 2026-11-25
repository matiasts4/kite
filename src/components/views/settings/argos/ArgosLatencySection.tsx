import React, { useEffect, useState } from 'react';
import { TaskLatencySummaryRow } from '../../../../lib/operator/operatorConfig';
import {
  runLedger,
  type VoiceLatencyReport,
  type VoiceTier,
  type VoiceTransportMode,
  type VoiceTtsEngineKind,
} from '../../../../lib/operator/runLedger';

export interface ArgosLatencySectionProps {
  testMessage: string | null;
  summaries: TaskLatencySummaryRow[];
  onClearMetrics: () => void;
}

export type ZedLatencySectionProps = ArgosLatencySectionProps;

function formatMs(value: number): string {
  return value > 0 ? `${Math.round(value)}ms` : '—';
}

export const ArgosLatencySection: React.FC<ArgosLatencySectionProps> = ({
  testMessage,
  summaries,
  onClearMetrics,
}) => {
  const [voiceReport, setVoiceReport] = useState<VoiceLatencyReport>(() =>
    runLedger.getVoiceLatencyReport()
  );

  useEffect(() => {
    setVoiceReport(runLedger.getVoiceLatencyReport());
    const unsub = runLedger.subscribe(() => {
      setVoiceReport(runLedger.getVoiceLatencyReport());
    });
    return unsub;
  }, []);

  const handleClearAll = () => {
    runLedger.clearHistory();
    setVoiceReport(runLedger.getVoiceLatencyReport());
    onClearMetrics();
  };

  const cacheHitPct = Math.round(voiceReport.tokenAverages.cacheHitRatio * 100);
  const cascadedMeetsSlo =
    voiceReport.byTransport.cascaded.ttfaAudio.count === 0 ||
    voiceReport.byTransport.cascaded.ttfaAudio.p50 <= 900;
  const realtimeMeetsSlo =
    voiceReport.byTransport.realtime.ttfaAudio.count === 0 ||
    voiceReport.byTransport.realtime.ttfaAudio.p50 <= 450;

  const tierEntries: Array<{ key: VoiceTier; label: string }> = [
    { key: 'L0', label: 'L0 (Heurística)' },
    { key: 'L1', label: 'L1 (Fast)' },
    { key: 'L2', label: 'L2 (Diagnosis)' },
  ];
  const transportEntries: Array<{ key: VoiceTransportMode; label: string }> = [
    { key: 'cascaded', label: 'cascaded' },
    { key: 'realtime', label: 'realtime' },
  ];
  const ttsEntries: Array<{ key: VoiceTtsEngineKind; label: string }> = [
    { key: 'elevenlabs_ws', label: 'elevenlabs_ws' },
    { key: 'elevenlabs_http', label: 'elevenlabs_http' },
    { key: 'browser', label: 'browser' },
  ];

  return (
    <section className="settings-group">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <h2 className="settings-group__title" style={{ margin: 0 }}>
          Rendimiento y Latencia por Proveedor / Tarea
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="secondary-button"
            onClick={handleClearAll}
            style={{ fontSize: 12 }}
          >
            Limpiar métricas
          </button>
        </div>
      </div>

      <div
        className="ui-card"
        data-testid="voice-sli-hud"
        style={{
          padding: '14px 18px',
          marginBottom: 12,
          borderRadius: 'var(--card-radius, 12px)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            Telemetría Voice Mode · SLI / SLO ({voiceReport.sampleCount} turnos)
          </span>
          <div style={{ display: 'flex', gap: 8, fontSize: 11.5 }}>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 'var(--vl-radius-sm, 6px)',
                background: cascadedMeetsSlo
                  ? 'rgba(52, 211, 153, 0.14)'
                  : 'rgba(248, 113, 113, 0.14)',
                color: cascadedMeetsSlo ? '#34d399' : '#f87171',
              }}
            >
              SLO Cascaded &le; 900ms
            </span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 'var(--vl-radius-sm, 6px)',
                background: realtimeMeetsSlo
                  ? 'rgba(52, 211, 153, 0.14)'
                  : 'rgba(248, 113, 113, 0.14)',
                color: realtimeMeetsSlo ? '#34d399' : '#f87171',
              }}
            >
              SLO Realtime &le; 450ms
            </span>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--control-radius, 8px)',
              background: 'rgba(255, 255, 255, 0.03)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>TTFA-Audio p50</div>
            <div
              data-testid="voice-ttfa-p50"
              style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {formatMs(voiceReport.ttfaAudio.p50)}
            </div>
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--control-radius, 8px)',
              background: 'rgba(255, 255, 255, 0.03)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>TTFA p95 / p99</div>
            <div
              data-testid="voice-ttfa-p95-p99"
              style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {formatMs(voiceReport.ttfaAudio.p95)} / {formatMs(voiceReport.ttfaAudio.p99)}
            </div>
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--control-radius, 8px)',
              background: 'rgba(255, 255, 255, 0.03)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Cache Hit Ratio</div>
            <div
              data-testid="voice-cache-hit-ratio"
              style={{
                fontSize: 15,
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: cacheHitPct >= 60 ? '#34d399' : 'var(--text-primary)',
              }}
            >
              {cacheHitPct}%
            </div>
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--control-radius, 8px)',
              background: 'rgba(255, 255, 255, 0.03)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tokens / Turno (prom.)</div>
            <div
              data-testid="voice-token-breakdown"
              style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {voiceReport.tokenAverages.promptTokensTotal} in / {voiceReport.tokenAverages.completionTokens} out
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            fontSize: 11.5,
            color: 'var(--text-muted)',
          }}
        >
          <span>
            Prefix:{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>
              {voiceReport.tokenAverages.systemStaticTokens}t
            </strong>{' '}
            · Dynamic:{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>
              {voiceReport.tokenAverages.contextDynamicTokens}t
            </strong>{' '}
            · Tools:{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>
              {voiceReport.tokenAverages.toolsSchemaTokens}t
            </strong>{' '}
            · History:{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>
              {voiceReport.tokenAverages.historyTokens}t
            </strong>
          </span>
        </div>

        {voiceReport.sampleCount > 0 && (
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 11.5,
                textAlign: 'left',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <th style={{ padding: '4px 6px' }}>Segmento</th>
                  <th style={{ padding: '4px 6px' }}>Turnos</th>
                  <th style={{ padding: '4px 6px' }}>TTFA p50</th>
                  <th style={{ padding: '4px 6px' }}>TTFA p95</th>
                  <th style={{ padding: '4px 6px' }}>TTFT p50</th>
                  <th style={{ padding: '4px 6px' }}>Cache</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...tierEntries.map((e) => ({
                    id: `tier-${e.key}`,
                    label: e.label,
                    stat: voiceReport.byTier[e.key],
                  })),
                  ...transportEntries.map((e) => ({
                    id: `transport-${e.key}`,
                    label: `Transport: ${e.label}`,
                    stat: voiceReport.byTransport[e.key],
                  })),
                  ...ttsEntries.map((e) => ({
                    id: `tts-${e.key}`,
                    label: `TTS: ${e.label}`,
                    stat: voiceReport.byTtsEngine[e.key],
                  })),
                ]
                  .filter((row) => row.stat.count > 0)
                  .map((row) => (
                    <tr
                      key={row.id}
                      style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
                    >
                      <td style={{ padding: '5px 6px', fontWeight: 500 }}>{row.label}</td>
                      <td style={{ padding: '5px 6px' }}>{row.stat.count}</td>
                      <td style={{ padding: '5px 6px', fontFamily: 'var(--font-mono)' }}>
                        {formatMs(row.stat.ttfaAudio.p50)}
                      </td>
                      <td style={{ padding: '5px 6px', fontFamily: 'var(--font-mono)' }}>
                        {formatMs(row.stat.ttfaAudio.p95)}
                      </td>
                      <td style={{ padding: '5px 6px', fontFamily: 'var(--font-mono)' }}>
                        {formatMs(row.stat.ttft.p50)}
                      </td>
                      <td style={{ padding: '5px 6px', fontFamily: 'var(--font-mono)' }}>
                        {Math.round(row.stat.cacheHitRatio * 100)}%
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="ui-card" style={{ padding: '14px 18px' }}>
        {testMessage && (
          <div
            style={{
              marginBottom: 12,
              padding: '8px 12px',
              borderRadius: 'var(--control-radius, 8px)',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: 12,
              color: 'var(--text-primary)',
            }}
          >
            {testMessage}
          </div>
        )}

        {summaries.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
            Aún no hay mediciones registradas. Pulsa &ldquo;Probar latencia&rdquo; o ejecuta un
            comando en el orbe de Argos para comparar la velocidad real de cada proveedor y
            modelo.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12,
                textAlign: 'left',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <th style={{ padding: '6px 8px' }}>Proveedor</th>
                  <th style={{ padding: '6px 8px' }}>Tarea</th>
                  <th style={{ padding: '6px 8px' }}>Muestras</th>
                  <th style={{ padding: '6px 8px' }}>Última</th>
                  <th style={{ padding: '6px 8px' }}>Promedio</th>
                  <th style={{ padding: '6px 8px' }}>Mín / Máx</th>
                  <th style={{ padding: '6px 8px' }}>Éxito</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr
                    key={`${s.providerId}-${s.taskType}`}
                    style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
                  >
                    <td style={{ padding: '8px', fontWeight: 600 }}>
                      {s.providerId.toUpperCase()}
                    </td>
                    <td style={{ padding: '8px', color: 'var(--text-secondary)' }}>
                      {s.taskType}
                    </td>
                    <td style={{ padding: '8px' }}>{s.count}</td>
                    <td style={{ padding: '8px', fontFamily: 'var(--font-mono)' }}>
                      {s.lastMs}ms
                    </td>
                    <td
                      style={{
                        padding: '8px',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 600,
                        color:
                          s.avgMs < 400
                            ? '#34d399'
                            : s.avgMs < 1200
                              ? '#fbbf24'
                              : '#f87171',
                      }}
                    >
                      {s.avgMs}ms
                    </td>
                    <td
                      style={{
                        padding: '8px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {s.minMs}ms / {s.maxMs}ms
                    </td>
                    <td style={{ padding: '8px' }}>{Math.round(s.successRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

export const ZedLatencySection = ArgosLatencySection;
