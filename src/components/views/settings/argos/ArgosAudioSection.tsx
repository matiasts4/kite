import React, { useEffect, useState } from 'react';
import {
  DEFAULT_REALTIME_ENDPOINTS,
  OperatorConfig,
  RealtimeProviderId,
  loadOperatorConfig,
  sanitizeRealtimeProvider,
  sanitizeVoiceIdleTimeoutSec,
  saveOperatorConfig,
} from '../../../../lib/operator/operatorConfig';
import { invokeCommand, isTauriEnvironment } from '../../../../lib/ipc';
import { SelectMenu, type SelectMenuRow } from '../../../ui/SelectMenu';
import { Badge } from '../../../ui/Badge';
import { Card } from '../../../ui/Card';
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
import { getVoicePalette, isKnownVoicePreset } from '../../../../lib/operator/config/voicePalettes';
import { VoicePickerModal } from './VoicePickerModal';

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

const REALTIME_PROVIDER_ROWS: SelectMenuRow[] = [
  {
    id: 'xai',
    title: 'xAI Realtime (24 kHz)',
    detail: 'WebSocket full-duplex 24 kHz con voz nativa y VAD de servidor',
  },
  {
    id: 'gemini_live',
    title: 'Google Gemini Live API (16/24 kHz)',
    detail: 'BidiGenerateContent 16 kHz entrada / 24 kHz salida con barge-in nativo',
  },
  {
    id: 'openai',
    title: 'OpenAI Realtime (24 kHz)',
    detail: 'WebSocket full-duplex 24 kHz compatible con gpt-realtime',
  },
];

const IDLE_TIMEOUT_ROWS: SelectMenuRow[] = [
  {
    id: '60',
    title: '1 min',
    detail: 'Pausa rápido tras 60s de silencio total',
  },
  {
    id: '180',
    title: '3 min (Recomendado)',
    detail: 'Balance ideal entre charla y ahorro de cuota',
  },
  {
    id: '300',
    title: '5 min',
    detail: 'Ventana extendida antes de cerrar el stream',
  },
  {
    id: '0',
    title: 'Desactivado',
    detail: 'Mantiene el canal abierto sin límite automático',
  },
];

const KNOWN_DEFAULT_ENDPOINTS = new Set<string>([
  DEFAULT_REALTIME_ENDPOINTS.xai,
  DEFAULT_REALTIME_ENDPOINTS.gemini_live,
  DEFAULT_REALTIME_ENDPOINTS.openai,
  'wss://api.openai.com/v1/realtime',
]);

function isDefaultOrEmptyRealtimeEndpoint(endpoint?: string): boolean {
  const trimmed = (endpoint ?? '').trim();
  return trimmed.length === 0 || KNOWN_DEFAULT_ENDPOINTS.has(trimmed);
}

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
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [savedSttKey, setSavedSttKey] = useState(false);
  const [savedModel, setSavedModel] = useState(false);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [availability, setAvailability] = useState<DictationAvailabilityPayload | null>(null);

  const effectiveConfig = externalConfig ?? loadOperatorConfig();
  const [modelPathInput, setModelPathInput] = useState(
    () => effectiveConfig.offlineSttModelPath || ''
  );
  const [idleTimeoutValue, setIdleTimeoutValue] = useState<number>(() =>
    sanitizeVoiceIdleTimeoutSec(
      externalConfig?.voiceIdleTimeoutSec ?? unifiedAudio.voiceIdleTimeoutSec
    )
  );
  const [selectedVoiceOverride, setSelectedVoiceOverride] = useState<string | null>(null);

  useEffect(() => {
    if (effectiveConfig.offlineSttModelPath !== undefined) {
      setModelPathInput(effectiveConfig.offlineSttModelPath);
    }
  }, [effectiveConfig.offlineSttModelPath]);

  useEffect(() => {
    if (externalConfig?.voiceIdleTimeoutSec !== undefined) {
      setIdleTimeoutValue(sanitizeVoiceIdleTimeoutSec(externalConfig.voiceIdleTimeoutSec));
    }
  }, [externalConfig?.voiceIdleTimeoutSec]);

  useEffect(() => {
    setSelectedVoiceOverride(null);
  }, [effectiveConfig.persona?.voice]);

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
      if (active) {
        setUnifiedAudio(next);
        setIdleTimeoutValue(sanitizeVoiceIdleTimeoutSec(next.voiceIdleTimeoutSec));
      }
    });
    if (isTauriEnvironment()) {
      void invokeCommand<DictationAvailabilityPayload>('read_dictation_availability')
        .then((res) => {
          if (active && res) setAvailability(res);
        })
        .catch((err) => {
          console.warn('[ArgosAudioSection] Failed to read dictation availability:', err);
        });
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
      } catch (err) {
        console.warn('[ArgosAudioSection] Failed to select offline dictation Whisper model:', err);
      }
    }
    setSavedModel(true);
    window.setTimeout(() => setSavedModel(false), 1800);
    toast.success('Configuración STT offline actualizada');
  };

  const activeRealtimeProvider: RealtimeProviderId = sanitizeRealtimeProvider(
    effectiveConfig.realtimeProvider ?? unifiedAudio.realtimeProvider
  );

  const handleRealtimeProviderSelect = (id: string) => {
    const nextProvider = sanitizeRealtimeProvider(id);
    updateField('realtimeProvider', nextProvider);
    if (isDefaultOrEmptyRealtimeEndpoint(effectiveConfig.realtimeEndpoint)) {
      updateField('realtimeEndpoint', DEFAULT_REALTIME_ENDPOINTS[nextProvider]);
    }
    void updateUnifiedAudioSettings({ realtimeProvider: nextProvider });
  };

  const handleIdleTimeoutSelect = (id: string) => {
    const nextSec = sanitizeVoiceIdleTimeoutSec(Number(id));
    setIdleTimeoutValue(nextSec);
    updateField('voiceIdleTimeoutSec', nextSec);
    void updateUnifiedAudioSettings({ voiceIdleTimeoutSec: nextSec });
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

  const currentVoiceName =
    selectedVoiceOverride ?? effectiveConfig.persona?.voice ?? 'Ara';
  const voicePreset = getVoicePalette(currentVoiceName);
  const voiceToneLabel = isKnownVoicePreset(currentVoiceName)
    ? voicePreset.toneEs
    : 'Voz personalizada';

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
              <p className="customizations-status customizations-status--ok">
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
            <div className="customizations-inline-actions" style={{ marginTop: 6 }}>
              {localEngines.map((eng) => (
                <Badge
                  key={eng.id}
                  tone={eng.available ? 'success' : 'neutral'}
                  shape="chip"
                  data-testid={`offline-stt-badge-${eng.id}`}
                >
                  {eng.label}: {eng.available ? 'Disponible' : 'No instalado'}
                </Badge>
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
                  }).catch((err) => {
                    console.warn('[ArgosAudioSection] Failed to update offlineSttEngine:', err);
                  });
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
              Elige entre el pipeline en cascada (STT + LLM + TTS) o el canal directo full-duplex a 24 kHz con fallback automático.
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
              <>
                <div className="subagent-settings__field-group" data-testid="realtime-provider-select">
                  <span className="subagent-settings__label">Proveedor Talker Realtime</span>
                  <SelectMenu
                    label="Proveedor Talker Realtime"
                    value={activeRealtimeProvider}
                    triggerLabel={
                      REALTIME_PROVIDER_ROWS.find((r) => r.id === activeRealtimeProvider)?.title ||
                      'xAI Realtime (24 kHz)'
                    }
                    rows={REALTIME_PROVIDER_ROWS}
                    variant="field"
                    onSelect={handleRealtimeProviderSelect}
                  />
                </div>
                <input
                  type="text"
                  className="ui-field"
                  value={effectiveConfig.realtimeEndpoint ?? ''}
                  onChange={(e) => {
                    updateField('realtimeEndpoint', e.target.value);
                  }}
                  placeholder={DEFAULT_REALTIME_ENDPOINTS[activeRealtimeProvider]}
                  aria-label="Endpoint WebSocket Realtime"
                  spellCheck={false}
                />
                {activeRealtimeProvider === 'gemini_live' && (
                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">Google Gemini Live API Key</span>
                    <div className="settings-credential">
                      <input
                        type={showGeminiKey ? 'text' : 'password'}
                        className="ui-field"
                        data-testid="gemini-live-api-key-input"
                        value={effectiveConfig.geminiLiveApiKey || ''}
                        onChange={(e) => updateField('geminiLiveApiKey', e.target.value)}
                        placeholder="AIza... (API Key de Google AI Studio / Gemini Live)"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Google Gemini Live API Key"
                      />
                      <button
                        type="button"
                        className="settings-control ui-button"
                        onClick={() => setShowGeminiKey((v) => !v)}
                      >
                        {showGeminiKey ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>
                )}
                {activeRealtimeProvider === 'openai' && (
                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">OpenAI Realtime API Key</span>
                    <div className="settings-credential">
                      <input
                        type={showOpenaiKey ? 'text' : 'password'}
                        className="ui-field"
                        data-testid="openai-realtime-api-key-input"
                        value={effectiveConfig.openaiRealtimeApiKey || ''}
                        onChange={(e) => updateField('openaiRealtimeApiKey', e.target.value)}
                        placeholder="sk-... (API Key de OpenAI Realtime)"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="OpenAI Realtime API Key"
                      />
                      <button
                        type="button"
                        className="settings-control ui-button"
                        onClick={() => setShowOpenaiKey((v) => !v)}
                      >
                        {showOpenaiKey ? 'Ocultar' : 'Ver'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Auto-pausa por inactividad</h3>
            <p>
              Protege tu cuota de audio continuo pausando automáticamente el stream S2S o micrófono abierto tras silencio total sin subagentes activos.
            </p>
          </div>
          <div
            className="settings-row__control settings-row__control--menu"
            data-testid="voice-idle-timeout-select"
          >
            <SelectMenu
              label="Auto-pausa por inactividad"
              value={String(idleTimeoutValue)}
              triggerLabel={
                IDLE_TIMEOUT_ROWS.find((r) => r.id === String(idleTimeoutValue))?.title ||
                '3 min (Recomendado)'
              }
              rows={IDLE_TIMEOUT_ROWS}
              variant="field"
              onSelect={handleIdleTimeoutSelect}
            />
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Voz y Paleta de Argos</h3>
            <p>
              Elige el perfil vocal del asistente y su paleta de 3 tonos para el brillo del compositor.
            </p>
            <p className="settings-note" data-testid="current-voice-summary">
              Voz actual: <strong>{currentVoiceName}</strong> · {voiceToneLabel}
            </p>
          </div>
          <div className="settings-row__control">
            <button
              type="button"
              className="secondary-button"
              data-testid="open-voice-picker-btn"
              onClick={() => setVoicePickerOpen(true)}
            >
              Elegir voz y paleta
            </button>
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
              <span className="settings-note">
                Todavía no hay llamadas de voz registradas.
              </span>
            ) : (
              receipts.map((rec) => {
                const isExpanded = expandedReceiptId === rec.callId;
                return (
                  <Card key={rec.callId} padding="sm">
                    <button
                      type="button"
                      className="settings-choice-row"
                      data-testid={`voice-call-receipt-${rec.callId}`}
                      onClick={() =>
                        setExpandedReceiptId((prev) => (prev === rec.callId ? null : rec.callId))
                      }
                    >
                      <span className="subagent-settings__section-head">
                        <span>
                          {rec.turnCount} turnos · {formatDurationSeconds(rec.durationMs)} ·{' '}
                          {rec.transport}
                        </span>
                        <span className="settings-note">
                          {rec.ttfaP50Ms != null ? `TTFA ${Math.round(rec.ttfaP50Ms)}ms` : 'Sin TTFA'}
                          {rec.cacheHitRatio != null
                            ? ` · Caché ${Math.round(rec.cacheHitRatio * 100)}%`
                            : ''}
                        </span>
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="settings-transcription-result__meta">
                        {rec.boundThreadId && <span>Hilo vinculado: {rec.boundThreadId}</span>}
                        {rec.toolsExecuted.length > 0 && (
                          <span>Herramientas: {rec.toolsExecuted.join(', ')}</span>
                        )}
                        {rec.summary && <span>Resumen: {rec.summary}</span>}
                      </div>
                    )}
                  </Card>
                );
              })
            )}
          </div>
        </div>
      </div>

      <VoicePickerModal
        isOpen={voicePickerOpen}
        initialVoice={currentVoiceName}
        volume={effectiveConfig.voiceVolume ?? 100}
        onClose={() => setVoicePickerOpen(false)}
        onSelectVoice={(voiceName) => {
          setSelectedVoiceOverride(voiceName);
          updateField('persona', {
            ...effectiveConfig.persona,
            voice: voiceName,
          });
        }}
      />
    </section>
  );
};

export const ZedAudioSection = ArgosAudioSection;
