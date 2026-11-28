import React, { useEffect, useState } from 'react';
import {
  OperatorConfig,
  TaskLatencySummaryRow,
  loadOperatorConfig,
  sanitizeRealtimeProvider,
} from '../../../../lib/operator/operatorConfig';
import {
  runLedger,
  type VoiceLatencyReport,
  type VoiceTier,
  type VoiceTransportMode,
  type VoiceTtsEngineKind,
} from '../../../../lib/operator/runLedger';
import {
  AUDIO_SETTINGS_CHANGED_EVENT,
  subscribeUnifiedAudioSettings,
} from '../../../../lib/operator/voice/audioSettingsSync';
import {
  listVoiceCallReceipts,
  type VoiceCallReceipt,
} from '../../../../lib/operator/voice/voiceCallReceipts';
import { Badge } from '../../../ui/Badge';
import { Card } from '../../../ui/Card';

export interface ArgosLatencySectionProps {
  testMessage: string | null;
  summaries: TaskLatencySummaryRow[];
  onClearMetrics: () => void;
  config?: OperatorConfig;
}

export type ZedLatencySectionProps = ArgosLatencySectionProps;

function formatMs(value: number): string {
  return value > 0 ? `${Math.round(value)}ms` : '—';
}

function formatActiveTransportLabel(config: OperatorConfig): string {
  if ((config.voiceTransportMode ?? 'cascaded') !== 'realtime') {
    return 'Cascaded';
  }
  const provider = sanitizeRealtimeProvider(config.realtimeProvider);
  if (provider === 'gemini_live') return 'Realtime · Gemini Live';
  if (provider === 'openai') return 'Realtime · OpenAI';
  return 'Realtime · xAI';
}

export const ArgosLatencySection: React.FC<ArgosLatencySectionProps> = ({
  testMessage,
  summaries,
  onClearMetrics,
  config: externalConfig,
}) => {
  const [voiceReport, setVoiceReport] = useState<VoiceLatencyReport>(() =>
    runLedger.getVoiceLatencyReport()
  );
  const [storedConfig, setStoredConfig] = useState<OperatorConfig>(() => loadOperatorConfig());
  const [callReceipts, setCallReceipts] = useState<VoiceCallReceipt[]>([]);

  useEffect(() => {
    let active = true;
    setVoiceReport(runLedger.getVoiceLatencyReport());
    const unsubLedger = runLedger.subscribe(() => {
      if (active) setVoiceReport(runLedger.getVoiceLatencyReport());
    });
    const refreshReceipts = () => {
      void listVoiceCallReceipts(25).then((items) => {
        if (active) setCallReceipts(items);
      });
    };
    const refreshConfig = () => {
      if (active) setStoredConfig(loadOperatorConfig());
    };
    refreshReceipts();
    const unsubAudio = subscribeUnifiedAudioSettings(() => {
      refreshConfig();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('kite:operator-config-updated', refreshConfig);
      window.addEventListener(AUDIO_SETTINGS_CHANGED_EVENT, refreshConfig);
    }
    return () => {
      active = false;
      unsubLedger();
      unsubAudio();
      if (typeof window !== 'undefined') {
        window.removeEventListener('kite:operator-config-updated', refreshConfig);
        window.removeEventListener(AUDIO_SETTINGS_CHANGED_EVENT, refreshConfig);
      }
    };
  }, []);

  const handleClearAll = () => {
    runLedger.clearHistory();
    setVoiceReport(runLedger.getVoiceLatencyReport());
    onClearMetrics();
  };

  const effectiveConfig = externalConfig ?? storedConfig;
  const activeTransportLabel = formatActiveTransportLabel(effectiveConfig);
  const isRealtimeTransport = (effectiveConfig.voiceTransportMode ?? 'cascaded') === 'realtime';

  const totalStreamSeconds = Math.round(
    callReceipts.reduce((sum, rec) => sum + Math.max(0, rec.durationMs || 0), 0) / 1000
  );
  const latestStreamSeconds =
    callReceipts.length > 0
      ? Math.round(Math.max(0, callReceipts[0].durationMs || 0) / 1000)
      : 0;

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

  const segmentRows = [
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
  ].filter((row) => row.stat.count > 0);

  return (
    <section className="settings-group">
      <div className="subagent-settings__section-head">
        <h2 className="settings-group__title">Rendimiento y Latencia por Proveedor / Tarea</h2>
        <button
          type="button"
          className="secondary-button"
          onClick={handleClearAll}
        >
          Limpiar métricas
        </button>
      </div>

      <Card padding="md" data-testid="voice-sli-hud">
        <div className="kite-card__header" style={{ flexWrap: 'wrap' }}>
          <span className="settings-row__title">
            Telemetría Voice Mode · SLI / SLO ({voiceReport.sampleCount} turnos)
          </span>
          <div className="customizations-inline-actions">
            <Badge
              tone={isRealtimeTransport ? 'accent' : 'neutral'}
              shape="pill"
              dot
              data-testid="voice-active-transport-pill"
            >
              {activeTransportLabel}
            </Badge>
            <Badge tone={cascadedMeetsSlo ? 'success' : 'danger'} shape="chip">
              SLO Cascaded &le; 900ms
            </Badge>
            <Badge tone={realtimeMeetsSlo ? 'success' : 'danger'} shape="chip">
              SLO Realtime &le; 450ms
            </Badge>
          </div>
        </div>

        <div className="customizations-color-grid">
          <div className="customizations-color-chip">
            <div className="customizations-color-chip__label">TTFA-Audio p50</div>
            <div
              data-testid="voice-ttfa-p50"
              className="tabular"
              style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {formatMs(voiceReport.ttfaAudio.p50)}
            </div>
          </div>

          <div className="customizations-color-chip">
            <div className="customizations-color-chip__label">TTFA p95 / p99</div>
            <div
              data-testid="voice-ttfa-p95-p99"
              className="tabular"
              style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {formatMs(voiceReport.ttfaAudio.p95)} / {formatMs(voiceReport.ttfaAudio.p99)}
            </div>
          </div>

          <div className="customizations-color-chip">
            <div className="customizations-color-chip__label">Cache Hit Ratio</div>
            <div
              data-testid="voice-cache-hit-ratio"
              className={`tabular ${cacheHitPct >= 60 ? 'customizations-status--ok' : ''}`.trim()}
              style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {cacheHitPct}%
            </div>
          </div>

          <div className="customizations-color-chip">
            <div className="customizations-color-chip__label">Tokens / Turno (prom.)</div>
            <div
              data-testid="voice-token-breakdown"
              className="tabular"
              style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {voiceReport.tokenAverages.promptTokensTotal} in / {voiceReport.tokenAverages.completionTokens} out
            </div>
          </div>

          <div className="customizations-color-chip">
            <div className="customizations-color-chip__label">Stream de audio est.</div>
            <div
              data-testid="voice-stream-seconds"
              className="tabular"
              style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}
            >
              {totalStreamSeconds}s total · {latestStreamSeconds}s última
            </div>
          </div>
        </div>

        <div className="settings-note">
          Prefix: <strong>{voiceReport.tokenAverages.systemStaticTokens}t</strong> · Dynamic:{' '}
          <strong>{voiceReport.tokenAverages.contextDynamicTokens}t</strong> · Tools:{' '}
          <strong>{voiceReport.tokenAverages.toolsSchemaTokens}t</strong> · History:{' '}
          <strong>{voiceReport.tokenAverages.historyTokens}t</strong>
        </div>

        {segmentRows.length > 0 && (
          <div className="ui-card">
            {segmentRows.map((row) => (
              <div key={row.id} className="ui-card__row settings-row">
                <div className="settings-row__copy">
                  <span className="settings-row__title">{row.label}</span>
                  <p>{row.stat.count} turnos</p>
                </div>
                <div className="customizations-inline-actions tabular">
                  <Badge tone="neutral" shape="chip">
                    TTFA p50 {formatMs(row.stat.ttfaAudio.p50)}
                  </Badge>
                  <Badge tone="neutral" shape="chip">
                    p95 {formatMs(row.stat.ttfaAudio.p95)}
                  </Badge>
                  <Badge tone="neutral" shape="chip">
                    TTFT {formatMs(row.stat.ttft.p50)}
                  </Badge>
                  <Badge tone="neutral" shape="chip">
                    Cache {Math.round(row.stat.cacheHitRatio * 100)}%
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card padding="md">
        {testMessage && (
          <div className="settings-transcription-result__text">{testMessage}</div>
        )}

        {summaries.length === 0 ? (
          <p className="settings-note">
            Aún no hay mediciones registradas. Pulsa &ldquo;Probar latencia&rdquo; o ejecuta un
            comando en el orbe de Argos para comparar la velocidad real de cada proveedor y
            modelo.
          </p>
        ) : (
          <div className="ui-card">
            {summaries.map((s) => (
              <div
                key={`${s.providerId}-${s.taskType}`}
                className="ui-card__row settings-row"
              >
                <div className="settings-row__copy">
                  <span className="settings-row__title">
                    {s.providerId.toUpperCase()} · {s.taskType}
                  </span>
                  <p className="tabular">
                    {s.count} muestras · Última {s.lastMs}ms · Mín/Máx {s.minMs}ms/{s.maxMs}ms · Éxito{' '}
                    {Math.round(s.successRate * 100)}%
                  </p>
                </div>
                <div className="settings-row__control">
                  <span
                    className="settings-badge tabular"
                    data-tone={
                      s.avgMs < 400
                        ? 'running'
                        : s.avgMs < 1200
                          ? 'warning'
                          : 'failed'
                    }
                  >
                    {s.avgMs}ms
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
};

export const ZedLatencySection = ArgosLatencySection;
