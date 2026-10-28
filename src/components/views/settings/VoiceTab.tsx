import React, { useState } from 'react';
import type { DictationAvailability, DictationInputDevice, DictationSettings } from './types';
import { saveOperatorConfig } from '../../../lib/operator/operatorConfig';
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
  const [grokKeyInput, setGrokKeyInput] = useState<string>(() => {
    try {
      return localStorage.getItem('kite_grok_transcription_api_key') || '';
    } catch {
      return '';
    }
  });
  const [showKey, setShowKey] = useState(false);
  const [savedBadge, setSavedBadge] = useState(false);
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

  const handleSaveGrokKey = () => {
    const trimmed = grokKeyInput.trim();
    try {
      localStorage.setItem('kite_grok_transcription_api_key', trimmed);
      saveOperatorConfig({ grokTranscriptionApiKey: trimmed });
      setSavedBadge(true);
      toast.success('Clave API guardada', 'Configuración de dictado y transcripción actualizada.');
      setTimeout(() => setSavedBadge(false), 2000);
    } catch {
      toast.error('Error al guardar', 'No se pudo guardar la clave API en almacenamiento local.');
    }
  };

  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Voice to text</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Voice transcription</h3>
              <p>Choose where each take is transcribed.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Voice transcription" className="ui-segmented">
                <button
                  aria-pressed={dictationSettings.mode === 'local'}
                  className="ui-segmented__item"
                  onClick={() => onUpdateDictationMode('local')}
                  type="button"
                >
                  {dictationSettings.mode === 'local' && (
                    <SegmentedIndicator group="settings-voice-transcription" />
                  )}
                  <span>On this PC</span>
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
                  <span>Cloud</span>
                </button>
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Voice privacy</h3>
              <p>
                {dictationAvailability.guidance ||
                  (dictationSettings.mode === 'cloud'
                    ? 'Cloud transcription is unavailable in this local studio.'
                    : 'No installed local transcription engine is ready.')}
              </p>
            </div>
            <div className="settings-row__control">
              <span
                className="settings-badge"
                data-tone={dictationSettings.mode === 'local' ? 'running' : 'accent'}
              >
                {dictationSettings.mode === 'local' ? 'Local' : 'Cloud'}
              </span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">
                {dictationSettings.mode === 'local' ? 'On-device engine' : 'Cloud model'}
              </h3>
              <p>
                {dictationSettings.mode === 'local'
                  ? 'Only installed engines can be selected. Local failure never sends audio to Cloud.'
                  : 'Cloud transcription is unavailable in this local studio. Audio is not sent anywhere.'}
              </p>
            </div>
            <div className="settings-row__control">
              {dictationSettings.mode === 'local' ? (
                <button
                  className="settings-control ui-button"
                  onClick={onChooseWhisperModel}
                  type="button"
                >
                  Choose Whisper model…
                </button>
              ) : (
                <span className="settings-badge" data-tone="warning">
                  Unavailable
                </span>
              )}
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Language</h3>
              <p>Automatic detects the spoken language for each take.</p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge">Automatic (detect)</span>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Dictation</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Dictation shortcut</h3>
              <p>Starts dictation in the composer you&apos;re working in while Kite is in front. Press it again to transcribe.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-label="Dictation shortcut"
                className="settings-control dictation-shortcut__recorder ui-button"
                type="button"
              >
                <kbd>Ctrl+Shift+D</kbd>
              </button>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Audio cues & atenuación</h3>
              <p>Reproduce el tono Zen armónico y atenúa el volumen de fondo al iniciar y finalizar la grabación.</p>
            </div>
            <div className="settings-row__control">
              <button
                aria-checked={dictationSettings.cuesEnabled}
                aria-label="Audio cues"
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
              <h3 className="settings-row__title">Microphone access</h3>
              <p>{dictationAvailability.guidance || 'Checking the local microphone.'}</p>
            </div>
            <div className="settings-row__control">
              <button className="settings-control ui-button" onClick={onRequestMicrophone} type="button">
                Allow microphone…
              </button>
              <span
                className="settings-badge"
                data-tone={dictationAvailability.canStart ? 'running' : 'warning'}
              >
                {dictationAvailability.canStart ? 'Ready' : 'Unavailable'}
              </span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Reset shortcut</h3>
              <p>Restore the default keyboard combination.</p>
            </div>
            <div className="settings-row__control">
              <button className="settings-control ui-button" onClick={onResetShortcut} type="button">
                Reset
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
        </div>
      </section>
    </>
  );
};
