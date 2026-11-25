import React, { useEffect, useState } from 'react';
import {
  OperatorConfig,
  loadOperatorConfig,
  saveOperatorConfig,
} from '../../../../lib/operator/operatorConfig';
import { invokeCommand, isTauriEnvironment } from '../../../../lib/ipc';
import { SelectMenu, type SelectMenuRow } from '../../../ui/SelectMenu';
import { toast } from '../../../../lib/toast';
import {
  listAudioInputDevices,
  listAudioOutputDevices,
  type AudioInputDeviceInfo,
  type AudioOutputDeviceInfo,
} from '../../../../lib/operator/voice/audioDevices';
import {
  readUnifiedAudioSettings,
  subscribeUnifiedAudioSettings,
  updateUnifiedAudioSettings,
  type UnifiedAudioSettings,
} from '../../../../lib/operator/voice/audioSettingsSync';
import {
  listVoiceCallReceipts,
  type VoiceCallReceipt,
} from '../../../../lib/operator/voice/voiceCallReceipts';

const GROK_TRANSCRIPTION_KEY_STORAGE_KEY = 'kite_grok_transcription_api_key';

interface LocalSttEngineInfo {
  id: string;
  label: string;
  available: boolean;
  detail?: string;
}

interface DictationAvailabilityPayload {
  state?: string;
  guidance?: string;
  localEngines?: LocalSttEngineInfo[];
}

export interface ArgosAudioSectionProps {
  config?: OperatorConfig;
  onFieldChange?: <K extends keyof OperatorConfig>(
    key: K,
    value: OperatorConfig[K]
  ) => void;
}

export type ZedAudioSectionProps = ArgosAudioSectionProps;

const OFFLINE_ENGINE_ROWS: SelectMenuRow[] = [
  {
    id: 'auto',
    title: 'Automático (Cloud + fallback offline)',
    detail: 'Usa Cloud STT y degrada a Whisper/Parakeet local si falta conexión',
  },
  {
    id: 'whisper',
    title: 'Whisper Local',
    detail: 'Prioriza modelo local GGML/GGUF',
  },
  {
    id: 'parakeet',
    title: 'Parakeet Local',
    detail: 'Prioriza modelo local ONNX',
  },
  {
    id: 'disabled',
    title: 'Solo Cloud / Navegador',
    detail: 'No usar motor STT local offline',
  },
];

const TRANSPORT_MODE_ROWS: SelectMenuRow[] = [
  {
    id: 'cascaded',
    title: 'Cascaded (Multi-Proveedor · Recomendado)',
    detail: 'Funciona con cualquier proveedor LLM de Kite y TTS ElevenLabs/Nativo',
  },
  {
    id: 'realtime',
    title: 'Realtime 24 kHz (Full-Duplex S2S)',
    detail: 'Audio bidireccional 24 kHz con fallback automático a Cascaded',
  },
];

const LANGUAGE_ROWS: SelectMenuRow[] = [
  { id: 'es-AR', title: 'Español (Argentina · Río de la Plata)' },
  { id: 'es-ES', title: 'Español (Neutro)' },
  { id: 'en-US', title: 'English (US)' },
];

function formatDurationSeconds(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${m}m ${rem}s`;
}

export const ArgosAudioSection: React.FC<ArgosAudioSectionProps> = ({
  config: externalConfig,
  onFieldChange,
}) => {
  const [unifiedAudio, setUnifiedAudio] = useState<UnifiedAudioSettings>(() =>
    readUnifiedAudioSettings()
  );
  const [inputDevices, setInputDevices] = useState<AudioInputDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioOutputDeviceInfo[]>([]);
  const [receipts, setReceipts] = useState<VoiceCallReceipt[]>([]);
  const [expandedReceiptId, setExpandedReceiptId] = useState<string | null>(null);
  const [showSttKey, setShowSttKey] = useState(false);
  const [savedSttKey, setSavedSttKey] = useState(false);
  const [savedModel, setSavedModel] = useState(false);
  const [availability, setAvailability] = useState<DictationAvailabilityPayload | null>(null);

  const effectiveConfig = externalConfig ?? loadOperatorConfig();
  const [modelPathInput, setModelPathInput] = useState(
    () => effectiveConfig.offlineSttModelPath || ''
  );
  useEffect(() => {
    if (effectiveConfig.offlineSttModelPath !== undefined) {
      setModelPathInput(effectiveConfig.offlineSttModelPath);
    }
  }, [effectiveConfig.offlineSttModelPath]);

  const sttKeyValue =
    effectiveConfig.grokTranscriptionApiKey ||
    effectiveConfig.grokApiKey ||
    '';

  useEffect(() => {
    let active = true;
    void listAudioInputDevices().then((devs) => {
      if (active) setInputDevices(devs);
    });
    void listAudioOutputDevices().then((devs) => {
      if (active) setOutputDevices(devs);
    });
    void listVoiceCallReceipts(10).then((items) => {
      if (active) setReceipts(items);
    });
    const unsub = subscribeUnifiedAudioSettings((next) => {
      if (active) setUnifiedAudio(next);
    });
    if (isTauriEnvironment()) {
      void invokeCommand<DictationAvailabilityPayload>('read_dictation_availability')
        .then((res) => {
          if (active && res) setAvailability(res);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const updateField = <K extends keyof OperatorConfig>(key: K, value: OperatorConfig[K]) => {
    if (onFieldChange) {
      onFieldChange(key, value);
    } else {
      saveOperatorConfig({ [key]: value } as Partial<OperatorConfig>);
    }
  };

  const handleSttKeyChange = (value: string) => {
    const trimmed = value.trim();
    try {
      if (trimmed) {
        localStorage.setItem(GROK_TRANSCRIPTION_KEY_STORAGE_KEY, trimmed);
      } else {
        localStorage.removeItem(GROK_TRANSCRIPTION_KEY_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
    updateField('grokTranscriptionApiKey', value);
  };

  const handleSaveOfflineModel = async () => {
    const modelPath = modelPathInput.trim();
    updateField('offlineSttModelPath', modelPath);
    if (isTauriEnvironment()) {
      try {
        const nextAvail = await invokeCommand<DictationAvailabilityPayload>(
          'select_dictation_whisper_model',
          { modelPath: modelPath || null }
        );
        if (nextAvail) setAvailability(nextAvail);
      } catch {
        // ignore
      }
    }
    setSavedModel(true);
    window.setTimeout(() => setSavedModel(false), 1800);
    toast.success('Configuración STT offline actualizada');
  };

  const localEngines = availability?.localEngines ?? [
    { id: 'whisper', label: 'Whisper', available: false, detail: 'Sin verificar' },
    { id: 'parakeet', label: 'Parakeet', available: false, detail: 'Sin verificar' },
  ];

  const micRows: SelectMenuRow[] = [
    { id: 'automatic', title: 'Automático (Predeterminado del sistema)' },
    ...inputDevices.map((d) => ({ id: d.deviceId, title: d.label })),
  ];
  const speakerRows: SelectMenuRow[] = [
    { id: 'automatic', title: 'Automático (Salida predeterminada)' },
    ...outputDevices.map((d) => ({ id: d.deviceId, title: d.label })),
  ];

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Entrada de Audio y Micrófono del Asistente</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row settings-row--stacked">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Audio, Salida e Idioma Unificados</h3>
            <p>
              Sincronizado en tiempo real entre Dictado, Voice Mode del hilo, Orb y Companion Bar.
            </p>
          </div>
          <div
            className="settings-row__control"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
          >
            <div data-testid="unified-mic-select">
              <SelectMenu
                label="Micrófono activo"
                value={unifiedAudio.micDeviceId}
                triggerLabel={
                  micRows.find((r) => r.id === unifiedAudio.micDeviceId)?.title ||
                  unifiedAudio.micDeviceId
                }
                rows={micRows}
                variant="field"
                onSelect={(id) => {
                  void updateUnifiedAudioSettings({ micDeviceId: id });
                }}
              />
            </div>
            <div data-testid="unified-speaker-select">
              <SelectMenu
                label="Altavoz de salida"
                value={unifiedAudio.outputDeviceId}
                triggerLabel={
                  speakerRows.find((r) => r.id === unifiedAudio.outputDeviceId)?.title ||
                  unifiedAudio.outputDeviceId
                }
                rows={speakerRows}
                variant="field"
                onSelect={(id) => {
                  void updateUnifiedAudioSettings({ outputDeviceId: id });
                }}
              />
            </div>
            <div data-testid="unified-language-select">
              <SelectMenu
                label="Idioma de Voz y Dictado"
                value={unifiedAudio.language}
                triggerLabel={
                  LANGUAGE_ROWS.find((r) => r.id === unifiedAudio.language)?.title ||
                  unifiedAudio.language
                }
                rows={LANGUAGE_ROWS}
                variant="field"
                onSelect={(id) => {
                  updateField('ttsLanguage', id);
                  void updateUnifiedAudioSettings({ language: id });
                }}
              />
            </div>
          </div>
        </div>

        <div className="ui-card__row settings-row settings-row--stacked">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Grok API Key (Transcripción Voz a Texto · STT)</h3>
            <p>
              Clave dedicada para transcribir tu voz a texto en el dictado global y en el modo de voz de Argos. Si queda vacía, reutiliza la API Key principal de Grok o Cloudflare Whisper.
            </p>
            {sttKeyValue.trim() ? (
              <p style={{ marginTop: 4, color: 'var(--text-success, #4ade80)' }}>
                Protegida en Bóveda Local SQLite
              </p>
            ) : null}
          </div>
          <div className="settings-row__control">
            <div className="settings-credential">
              <input
                type={showSttKey ? 'text' : 'password'}
                className="ui-field"
                value={effectiveConfig.grokTranscriptionApiKey || ''}
                onChange={(e) => handleSttKeyChange(e.target.value)}
                placeholder={
                  effectiveConfig.grokApiKey?.trim()
                    ? 'Usando API Key principal de Grok (opcional dedicar otra xai-...)'
                    : 'xai-... (API Key de console.x.ai)'
                }
                autoComplete="off"
                spellCheck={false}
                aria-label="Grok API Key para Transcripción Voz a Texto"
              />
              <button
                type="button"
                className="settings-control ui-button"
                onClick={() => setShowSttKey((v) => !v)}
              >
                {showSttKey ? 'Ocultar' : 'Ver'}
              </button>
              <button
                type="button"
                className="settings-control ui-button ui-button--primary"
                onClick={() => {
                  handleSttKeyChange((effectiveConfig.grokTranscriptionApiKey || '').trim());
                  setSavedSttKey(true);
                  window.setTimeout(() => setSavedSttKey(false), 1800);
                  toast.success('API Key de transcripción guardada en Bóveda SQLite');
                }}
              >
                {savedSttKey ? 'Guardado' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>

        <div className="ui-card__row settings-row settings-row--stacked">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Motor STT Local Offline (Whisper / Parakeet)</h3>
            <p>
              Respaldo 100% offline usando captura nativa WASAPI cuando no hay clave Cloud o conexión a internet.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {localEngines.map((eng) => (
                <span
                  key={eng.id}
                  data-testid={`offline-stt-badge-${eng.id}`}
                  style={{
                    padding: '2px 8px',
                    borderRadius: 'var(--vl-radius-sm, 6px)',
                    fontSize: 11.5,
                    background: eng.available
                      ? 'rgba(52, 211, 153, 0.14)'
                      : 'rgba(255, 255, 255, 0.06)',
                    color: eng.available ? '#34d399' : 'var(--text-muted)',
                  }}
                >
                  {eng.label}: {eng.available ? 'Disponible' : 'No instalado'}
                </span>
              ))}
            </div>
          </div>
          <div
            className="settings-row__control"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
          >
            <SelectMenu
              label="Modo STT local"
              value={effectiveConfig.offlineSttEngine || 'auto'}
              triggerLabel={
                OFFLINE_ENGINE_ROWS.find(
                  (r) => r.id === (effectiveConfig.offlineSttEngine || 'auto')
                )?.title || 'Automático'
              }
              rows={OFFLINE_ENGINE_ROWS}
              variant="field"
              onSelect={(id) => {
                const engine = id as NonNullable<OperatorConfig['offlineSttEngine']>;
                updateField('offlineSttEngine', engine);
                if (isTauriEnvironment()) {
                  void invokeCommand('update_dictation_settings', {
                    settings: { offlineSttEngine: engine },
                  }).catch(() => {});
                }
              }}
            />
            <div className="settings-credential">
              <input
                type="text"
                className="ui-field"
                value={modelPathInput}
                onChange={(e) => {
                  setModelPathInput(e.target.value);
                  updateField('offlineSttModelPath', e.target.value);
                }}
                placeholder="Ruta del modelo local (ej. C:\models\ggml-base.bin)"
                aria-label="Ruta del modelo local STT"
                spellCheck={false}
              />
              <button
                type="button"
                data-testid="save-offline-stt-model-btn"
                className="settings-control ui-button ui-button--primary"
                onClick={() => void handleSaveOfflineModel()}
              >
                {savedModel ? 'Guardado' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>

        <div className="ui-card__row settings-row settings-row--stacked">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Modo de Transporte de Voz</h3>
            <p>
              Elegí entre el pipeline en cascada (STT + LLM + TTS) o el canal directo full-duplex a 24 kHz con fallback automático.
            </p>
          </div>
          <div
            className="settings-row__control"
            data-testid="voice-transport-select"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
          >
            <SelectMenu
              label="Modo de transporte de voz"
              value={effectiveConfig.voiceTransportMode ?? 'cascaded'}
              triggerLabel={
                TRANSPORT_MODE_ROWS.find(
                  (r) => r.id === (effectiveConfig.voiceTransportMode ?? 'cascaded')
                )?.title || 'Cascaded'
              }
              rows={TRANSPORT_MODE_ROWS}
              variant="field"
              onSelect={(id) => {
                const mode = id as 'cascaded' | 'realtime';
                updateField('voiceTransportMode', mode);
                void updateUnifiedAudioSettings({ voiceTransportMode: mode });
              }}
            />
            {(effectiveConfig.voiceTransportMode ?? 'cascaded') === 'realtime' && (
              <input
                type="text"
                className="ui-field"
                value={effectiveConfig.realtimeEndpoint ?? ''}
                onChange={(e) => {
                  updateField('realtimeEndpoint', e.target.value);
                }}
                placeholder="wss://api.openai.com/v1/realtime?model=gpt-realtime"
                aria-label="Endpoint WebSocket Realtime"
                spellCheck={false}
              />
            )}
          </div>
        </div>

        <div
          className="ui-card__row settings-row settings-row--stacked"
          data-testid="voice-call-receipts-section"
        >
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Historial de Llamadas de Voz</h3>
            <p>
              Recibos persistentes de sesiones de voz con duración, TTFA p50, ratio de caché y herramientas ejecutadas.
            </p>
          </div>
          <div
            className="settings-row__control"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
          >
            {receipts.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Todavía no hay llamadas de voz registradas.
              </span>
            ) : (
              receipts.map((rec) => {
                const isExpanded = expandedReceiptId === rec.callId;
                return (
                  <div
                    key={rec.callId}
                    style={{
                      border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
                      borderRadius: 'var(--card-radius, 12px)',
                      padding: '8px 12px',
                      background: 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <button
                      type="button"
                      data-testid={`voice-call-receipt-${rec.callId}`}
                      onClick={() =>
                        setExpandedReceiptId((prev) => (prev === rec.callId ? null : rec.callId))
                      }
                      style={{
                        width: '100%',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        minHeight: 'var(--vl-control-sm, 28px)',
                        color: 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 12.5,
                      }}
                    >
                      <span>
                        {rec.turnCount} turnos · {formatDurationSeconds(rec.durationMs)} ·{' '}
                        {rec.transport}
                      </span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {rec.ttfaP50Ms != null ? `TTFA ${Math.round(rec.ttfaP50Ms)}ms` : 'Sin TTFA'}
                        {rec.cacheHitRatio != null
                          ? ` · Caché ${Math.round(rec.cacheHitRatio * 100)}%`
                          : ''}
                      </span>
                    </button>
                    {isExpanded && (
                      <div
                        style={{
                          marginTop: 8,
                          paddingTop: 8,
                          borderTop: '1px solid rgba(255,255,255,0.08)',
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        {rec.boundThreadId && <div>Hilo vinculado: {rec.boundThreadId}</div>}
                        {rec.toolsExecuted.length > 0 && (
                          <div>Herramientas: {rec.toolsExecuted.join(', ')}</div>
                        )}
                        {rec.summary && <div>Resumen: {rec.summary}</div>}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export const ZedAudioSection = ArgosAudioSection;
