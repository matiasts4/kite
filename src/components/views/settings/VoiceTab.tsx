import React, { useState, useEffect, useRef } from 'react';
import type { DictationAvailability, DictationInputDevice, DictationSettings } from './types';
import {
  loadOperatorConfig,
  saveOperatorConfig,
  syncNativeCredentialsWithVault,
  type OperatorConfig,
} from '../../../lib/operator/operatorConfig';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';
import { toast } from '../../../lib/toast';
import { MicCalibrationCard } from './voice/MicCalibrationCard';

interface VoiceTabProps {
  dictationSettings: DictationSettings;
  dictationAvailability: DictationAvailability;
  dictationDevices: DictationInputDevice[];
  onUpdateDictationMode: (mode: 'cloud' | 'local') => void;
  onToggleCues: () => void;
  onResetShortcut: () => void;
  onSelectDevice: (deviceId: string | null) => void;
  onChooseWhisperModel: () => void;
  onRequestMicrophone: () => void;
}

let vaultSyncDone = false;
let vaultSyncInFlight: Promise<OperatorConfig> | null = null;

function ensureVaultSyncedOnce(): Promise<OperatorConfig> | null {
  if (vaultSyncDone) return null;
  if (!vaultSyncInFlight) {
    vaultSyncInFlight = syncNativeCredentialsWithVault()
      .then((synced) => {
        vaultSyncDone = true;
        return synced;
      })
      .finally(() => {
        vaultSyncInFlight = null;
      });
  }
  return vaultSyncInFlight;
}

function readGrokKeyFromConfig(cfg: OperatorConfig): string {
  try {
    return (
      cfg.grokTranscriptionApiKey ||
      localStorage.getItem('kite_grok_transcription_api_key') ||
      cfg.grokApiKey ||
      ''
    );
  } catch {
    return cfg.grokTranscriptionApiKey || cfg.grokApiKey || '';
  }
}

export const VoiceTab: React.FC<VoiceTabProps> = ({
  dictationSettings,
  dictationAvailability,
  dictationDevices,
  onUpdateDictationMode,
  onToggleCues,
  onResetShortcut,
  onSelectDevice,
  onChooseWhisperModel,
  onRequestMicrophone,
}) => {
  const initialCfgRef = useRef<OperatorConfig | null>(null);
  if (initialCfgRef.current === null) {
    initialCfgRef.current = loadOperatorConfig();
  }
  const [operatorCfg, setOperatorCfg] = useState<OperatorConfig>(initialCfgRef.current);
  const [grokKeyInput, setGrokKeyInput] = useState<string>(() =>
    readGrokKeyFromConfig(initialCfgRef.current!)
  );
  const [showKey, setShowKey] = useState(false);
  const [savedBadge, setSavedBadge] = useState(false);
  const [elevenKeyInput, setElevenKeyInput] = useState<string>(
    () => initialCfgRef.current!.elevenlabsApiKey || ''
  );
  const [showElevenKey, setShowElevenKey] = useState(false);
  const [savedElevenBadge, setSavedElevenBadge] = useState(false);
  const [autoExecute, setAutoExecute] = useState<boolean>(() => {
    try {
      return localStorage.getItem('kite_zed_auto_execute') !== 'false';
    } catch {
      return true;
    }
  });
  const [ttsFeedback, setTtsFeedback] = useState<boolean>(() => {
    try {
      return localStorage.getItem('kite_zed_tts_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  const savedBadgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedElevenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let mounted = true;
    const syncPromise = ensureVaultSyncedOnce();
    if (syncPromise) {
      void syncPromise.then((synced) => {
        if (!mounted) return;
        setOperatorCfg(synced);
        const nextGrok = readGrokKeyFromConfig(synced);
        setGrokKeyInput((prev) => (prev.trim() ? prev : nextGrok));
        setElevenKeyInput((prev) => (prev.trim() ? prev : synced.elevenlabsApiKey || ''));
      });
    }

    const handleConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent<OperatorConfig>).detail ?? loadOperatorConfig();
      setOperatorCfg(detail);
      if (detail.grokTranscriptionApiKey) {
        setGrokKeyInput(detail.grokTranscriptionApiKey);
      }
      if (detail.elevenlabsApiKey !== undefined) {
        setElevenKeyInput(detail.elevenlabsApiKey);
      }
    };
    window.addEventListener('kite:operator-config-updated', handleConfigUpdated);
    return () => {
      mounted = false;
      window.removeEventListener('kite:operator-config-updated', handleConfigUpdated);
      if (savedBadgeTimerRef.current) clearTimeout(savedBadgeTimerRef.current);
      if (savedElevenTimerRef.current) clearTimeout(savedElevenTimerRef.current);
    };
  }, []);

  const handleSaveGrokKey = () => {
    const trimmed = grokKeyInput.trim();
    try {
      localStorage.setItem('kite_grok_transcription_api_key', trimmed);
      const updated = saveOperatorConfig({ grokTranscriptionApiKey: trimmed });
      setOperatorCfg(updated);
      setSavedBadge(true);
      toast.success('Clave API guardada', 'Configuración de dictado y transcripción actualizada en bóveda SQLite.');
      if (savedBadgeTimerRef.current) clearTimeout(savedBadgeTimerRef.current);
      savedBadgeTimerRef.current = setTimeout(() => setSavedBadge(false), 2000);
    } catch {
      toast.error('Error al guardar', 'No se pudo guardar la clave API en almacenamiento local.');
    }
  };

  const handleToggleTtsEngine = (engine: 'browser' | 'elevenlabs') => {
    const updated = saveOperatorConfig({ ttsEngine: engine });
    setOperatorCfg(updated);
  };

  const handleSaveElevenKey = () => {
    const trimmed = elevenKeyInput.trim();
    try {
      const updated = saveOperatorConfig({
        elevenlabsApiKey: trimmed,
        ttsEngine: trimmed ? 'elevenlabs' : operatorCfg.ttsEngine,
      });
      setOperatorCfg(updated);
      setSavedElevenBadge(true);
      toast.success('Clave de ElevenLabs guardada', 'Síntesis de voz (Texto a Voz) guardada en bóveda SQLite.');
      if (savedElevenTimerRef.current) clearTimeout(savedElevenTimerRef.current);
      savedElevenTimerRef.current = setTimeout(() => setSavedElevenBadge(false), 2000);
    } catch {
      toast.error('Error al guardar', 'No se pudo guardar la clave de ElevenLabs.');
    }
  };

  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Voz a texto</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Transcripción de voz</h3>
              <p>Elige dónde se transcribe cada grabación.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Transcripción de voz" className="ui-segmented">
                <button
                  aria-pressed={dictationSettings.mode === 'local'}
                  className="ui-segmented__item"
                  onClick={() => onUpdateDictationMode('local')}
                  type="button"
                >
                  {dictationSettings.mode === 'local' && (
                    <SegmentedIndicator group="settings-voice-transcription" />
                  )}
                  <span>En esta PC</span>
                </button>
                <button
                  aria-pressed={dictationSettings.mode === 'cloud'}
                  className="ui-segmented__item"
                  onClick={() => onUpdateDictationMode('cloud')}
                  type="button"
                >
                  {dictationSettings.mode === 'cloud' && (
                    <SegmentedIndicator group="settings-voice-transcription" />
                  )}
                  <span>En la nube</span>
                </button>
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Privacidad de voz</h3>
              <p>
                {dictationAvailability.guidance ||
                  (dictationSettings.mode === 'cloud'
                    ? 'La transcripción en la nube no está disponible en este estudio local.'
                    : 'No hay ningún motor de transcripción local instalado y listo.')}
              </p>
            </div>
            <div className="settings-row__control">
              <span
                className="settings-badge"
                data-tone={dictationSettings.mode === 'local' ? 'running' : 'accent'}
              >
                {dictationSettings.mode === 'local' ? 'Local' : 'En la nube'}
              </span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                {dictationSettings.mode === 'local' ? 'Motor local en el dispositivo' : 'Modelo en la nube'}
              </h3>
              <p>
                {dictationSettings.mode === 'local'
                  ? 'Solo se pueden seleccionar motores instalados. Si falla el modo local, nunca se envía audio a la nube.'
                  : 'La transcripción en la nube no está disponible en este estudio local. El audio no se envía a ningún servidor.'}
              </p>
            </div>
            <div className="settings-row__control">
              {dictationSettings.mode === 'local' ? (
                <button
                  className="settings-control ui-button"
                  onClick={onChooseWhisperModel}
                  type="button"
                >
                  Elegir modelo Whisper…
                </button>
              ) : (
                <span className="settings-badge" data-tone="warning">
                  No disponible
                </span>
              )}
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Idioma</h3>
              <p>Automático detecta el idioma hablado en cada grabación.</p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge">Automático (detectar)</span>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Dictado</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Atajo de dictado</h3>
              <p>Inicia el dictado en el compositor donde estés trabajando cuando Kite esté en primer plano. Pulsa de nuevo para transcribir.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-label="Atajo de dictado"
                className="settings-control dictation-shortcut__recorder ui-button"
                type="button"
              >
                <kbd>Ctrl+Shift+D</kbd>
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Señales de audio y atenuación</h3>
              <p>Reproduce el tono Zen armónico y atenúa el volumen de fondo al iniciar y finalizar la grabación.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={dictationSettings.cuesEnabled}
                aria-label="Señales de audio"
                className="ui-switch"
                onClick={onToggleCues}
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Acceso al micrófono</h3>
              <p>{dictationAvailability.guidance || 'Comprobando el micrófono local.'}</p>
            </div>
            <div className="settings-row__control">
              <button className="settings-control ui-button" onClick={onRequestMicrophone} type="button">
                Permitir micrófono…
              </button>
              <span
                className="settings-badge"
                data-tone={dictationAvailability.canStart ? 'running' : 'warning'}
              >
                {dictationAvailability.canStart ? 'Listo' : 'No disponible'}
              </span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Restablecer atajo</h3>
              <p>Restaura la combinación de teclas predeterminada.</p>
            </div>
            <div className="settings-row__control">
              <button className="settings-control ui-button" onClick={onResetShortcut} type="button">
                Restablecer
              </button>
            </div>
          </div>
        </div>
      </section>

      <MicCalibrationCard
        devices={dictationDevices}
        deviceId={dictationSettings.deviceId ?? null}
        onSelectDevice={onSelectDevice}
      />

      <section className="settings-group">
        <h2 className="settings-group__title">Asistente Zed (Voz en la Nube con Grok)</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Modo de Transcripción</h3>
              <p>
                El Asistente utiliza transcripción de voz en la nube mediante los modelos de alta precisión de xAI Grok.
              </p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge" data-tone={grokKeyInput.trim() ? 'running' : 'idle'}>
                {grokKeyInput.trim() ? 'Nube (xAI Grok Whisper)' : 'Nativo del Navegador'}
              </span>
            </div>
          </div>

          <div className="ui-card__row settings-row settings-row--stacked">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Grok API Key (Transcripción en la Nube)</h3>
              <p>
                Clave de API de xAI (Grok) para enviar el audio directamente a la nube sin consumir recursos locales.
              </p>
            </div>
            <div className="settings-row__control">
              <div className="settings-credential">
                <input
                  type={showKey ? 'text' : 'password'}
                  className="ui-field"
                  placeholder="xai-..."
                  value={grokKeyInput}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Grok API Key (Transcripción en la Nube)"
                  onChange={(e) => setGrokKeyInput(e.target.value)}
                />
                <button
                  type="button"
                  className="settings-control ui-button"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? 'Ocultar clave' : 'Mostrar clave'}
                >
                  {showKey ? 'Ocultar' : 'Ver'}
                </button>
                <button
                  type="button"
                  className="settings-control ui-button ui-button--primary"
                  onClick={handleSaveGrokKey}
                >
                  {savedBadge ? 'Guardado ✓' : 'Guardar'}
                </button>
              </div>
              {grokKeyInput.trim() ? (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-success, #4ade80)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    marginTop: '4px',
                  }}
                >
                  Protegida en Bóveda Local SQLite (Voz a Texto · STT)
                </span>
              ) : null}
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Auto-ejecución por voz</h3>
              <p>
                Al terminar de hablar con el Asistente, despacha y verifica automáticamente el comando sin
                necesidad de pulsar botones ni escribir.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={autoExecute}
                aria-label="Auto-ejecución por voz"
                className="ui-switch"
                role="switch"
                type="button"
                onClick={() => {
                  const next = !autoExecute;
                  setAutoExecute(next);
                  localStorage.setItem('kite_zed_auto_execute', String(next));
                }}
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Respuesta por voz (TTS)</h3>
              <p>
                El Asistente narra en español el resultado verificado de las acciones realizadas a través
                de la síntesis de voz configurada en Asistente Zed.
              </p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={ttsFeedback}
                aria-label="Respuesta por voz"
                className="ui-switch"
                role="switch"
                type="button"
                onClick={() => {
                  const next = !ttsFeedback;
                  setTtsFeedback(next);
                  localStorage.setItem('kite_zed_tts_enabled', String(next));
                }}
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Motor de Síntesis de Voz (Texto a Voz · TTS)</h3>
              <p>
                Elige entre la voz local del sistema o el streaming neuronal de ElevenLabs (v4 Turbo).
              </p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Motor de Síntesis de Voz" className="ui-segmented">
                <button
                  type="button"
                  aria-pressed={operatorCfg.ttsEngine !== 'elevenlabs'}
                  className="ui-segmented__item"
                  onClick={() => handleToggleTtsEngine('browser')}
                >
                  {operatorCfg.ttsEngine !== 'elevenlabs' && (
                    <SegmentedIndicator group="voice-tab-tts-engine" />
                  )}
                  <span>Nativo (Sistema)</span>
                </button>
                <button
                  type="button"
                  aria-pressed={operatorCfg.ttsEngine === 'elevenlabs'}
                  className="ui-segmented__item"
                  onClick={() => handleToggleTtsEngine('elevenlabs')}
                >
                  {operatorCfg.ttsEngine === 'elevenlabs' && (
                    <SegmentedIndicator group="voice-tab-tts-engine" />
                  )}
                  <span>ElevenLabs Neural</span>
                </button>
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row settings-row--stacked">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">ElevenLabs API Key (Texto a Voz · TTS)</h3>
              <p>
                Clave de API de ElevenLabs para que el asistente hable con voz neuronal de baja latencia (~100ms).
              </p>
            </div>
            <div className="settings-row__control">
              <div className="settings-credential">
                <input
                  type={showElevenKey ? 'text' : 'password'}
                  className="ui-field"
                  placeholder="xi_..."
                  value={elevenKeyInput}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="ElevenLabs API Key (Texto a Voz)"
                  onChange={(e) => setElevenKeyInput(e.target.value)}
                />
                <button
                  type="button"
                  className="settings-control ui-button"
                  onClick={() => setShowElevenKey(!showElevenKey)}
                  title={showElevenKey ? 'Ocultar clave' : 'Mostrar clave'}
                >
                  {showElevenKey ? 'Ocultar' : 'Ver'}
                </button>
                <button
                  type="button"
                  className="settings-control ui-button ui-button--primary"
                  onClick={handleSaveElevenKey}
                >
                  {savedElevenBadge ? 'Guardado ✓' : 'Guardar'}
                </button>
              </div>
              {elevenKeyInput.trim() ? (
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-success, #4ade80)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    marginTop: '4px',
                  }}
                >
                  Protegida en Bóveda Local SQLite (Texto a Voz · TTS)
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </>
  );
};
