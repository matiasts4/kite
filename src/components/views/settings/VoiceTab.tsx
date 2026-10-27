import React, { useState, useRef, useEffect } from 'react';
import type { DictationAvailability, DictationInputDevice, DictationSettings } from './types';
import {
  startMicrophoneTest,
  startTranscriptionTestSession,
  releaseOperatorCapture,
  type MicrophoneTester,
  type TranscriptionTestResult,
  type TranscriptionTestSession,
} from '../../../lib/operator/voice/zedVoice';
import {
  loadOperatorConfig,
  saveOperatorConfig,
} from '../../../lib/operator/operatorConfig';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';
import { toast } from '../../../lib/toast';

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
  const [operatorCfg, setOperatorCfg] = useState(() => loadOperatorConfig());
  const [elevenKeyInput, setElevenKeyInput] = useState(() => operatorCfg.elevenlabsApiKey || '');
  const [showElevenKey, setShowElevenKey] = useState(false);
  const [savedElevenBadge, setSavedElevenBadge] = useState(false);
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [testMicLevel, setTestMicLevel] = useState(0);
  const [micTestError, setMicTestError] = useState<string | null>(null);
  const micTesterRef = useRef<MicrophoneTester | null>(null);

  useEffect(() => {
    return () => {
      if (micTesterRef.current) {
        micTesterRef.current.stop();
        micTesterRef.current = null;
      }
    };
  }, []);

  const handleToggleMicTest = async () => {
    if (isTestingMic) {
      if (micTesterRef.current) {
        micTesterRef.current.stop();
        micTesterRef.current = null;
      }
      setIsTestingMic(false);
      setTestMicLevel(0);
      setMicTestError(null);
    } else {
      setMicTestError(null);
      try {
        await releaseOperatorCapture();
        const tester = await startMicrophoneTest(
          dictationSettings.deviceId || null,
          (lvl) => {
            setTestMicLevel(lvl);
          }
        );
        micTesterRef.current = tester;
        setIsTestingMic(true);
      } catch (err: any) {
        setMicTestError(
          err?.message || 'No se pudo acceder al micrófono. Verifica los permisos del sistema.'
        );
        setIsTestingMic(false);
        setTestMicLevel(0);
      }
    }
  };

  const [transcriptionTestState, setTranscriptionTestState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [transcriptionTestSeconds, setTranscriptionTestSeconds] = useState(0);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionTestResult | null>(null);
  const transcriptionSessionRef = useRef<TranscriptionTestSession | null>(null);
  const transcriptionTimerRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (transcriptionSessionRef.current) {
        transcriptionSessionRef.current.cancel();
        transcriptionSessionRef.current = null;
      }
      if (transcriptionTimerRef.current) {
        clearInterval(transcriptionTimerRef.current);
        transcriptionTimerRef.current = null;
      }
    };
  }, []);

  const handleToggleTranscriptionTest = async () => {
    if (transcriptionTestState === 'recording') {
      if (transcriptionTimerRef.current) {
        clearInterval(transcriptionTimerRef.current);
        transcriptionTimerRef.current = null;
      }
      const session = transcriptionSessionRef.current;
      transcriptionSessionRef.current = null;
      setTranscriptionTestState('transcribing');

      if (session) {
        try {
          const res = await session.stopAndTranscribe();
          setTranscriptionResult(res);
        } catch (err: any) {
          setTranscriptionResult({
            success: false,
            error: err?.message || 'Error inesperado al transcribir.',
            engine: 'Desconocido',
            latencyMs: 0,
            durationSecs: transcriptionTestSeconds,
          });
        } finally {
          setTranscriptionTestState('idle');
        }
      } else {
        setTranscriptionTestState('idle');
      }
    } else if (transcriptionTestState === 'idle') {
      setTranscriptionResult(null);
      setTranscriptionTestSeconds(0);
      try {
        await releaseOperatorCapture();
        const session = await startTranscriptionTestSession(dictationSettings.deviceId || null);
        transcriptionSessionRef.current = session;
        setTranscriptionTestState('recording');

        let elapsed = 0;
        transcriptionTimerRef.current = setInterval(async () => {
          elapsed += 1;
          setTranscriptionTestSeconds(elapsed);
          if (elapsed >= 8 && transcriptionSessionRef.current) {
            clearInterval(transcriptionTimerRef.current);
            transcriptionTimerRef.current = null;
            const currentSession = transcriptionSessionRef.current;
            transcriptionSessionRef.current = null;
            setTranscriptionTestState('transcribing');
            try {
              const res = await currentSession.stopAndTranscribe();
              setTranscriptionResult(res);
            } catch (err: any) {
              setTranscriptionResult({
                success: false,
                error: err?.message || 'Error al transcribir.',
                engine: 'Desconocido',
                latencyMs: 0,
                durationSecs: elapsed,
              });
            } finally {
              setTranscriptionTestState('idle');
            }
          }
        }, 1000);
      } catch (err: any) {
        setTranscriptionResult({
          success: false,
          error: err?.message || 'No se pudo acceder al micrófono para la prueba.',
          engine: 'Desconocido',
          latencyMs: 0,
          durationSecs: 0,
        });
        setTranscriptionTestState('idle');
      }
    }
  };


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
    try {
      localStorage.setItem('kite_grok_transcription_api_key', grokKeyInput.trim());
      setSavedBadge(true);
      toast.success('Clave API guardada', 'Configuración de dictado y transcripción actualizada.');
      setTimeout(() => setSavedBadge(false), 2000);
    } catch {
      toast.error('Error al guardar', 'No se pudo guardar la clave API en almacenamiento local.');
    }
  };

  const handleSaveElevenKey = () => {
    const updated = saveOperatorConfig({
      elevenlabsApiKey: elevenKeyInput.trim(),
    });
    setOperatorCfg(updated);
    setSavedElevenBadge(true);
    toast.success('Clave de ElevenLabs guardada', 'El sintetizador de voz usará las credenciales configuradas.');
    setTimeout(() => setSavedElevenBadge(false), 2000);
  };

  const handleToggleTtsEngine = (engine: 'browser' | 'elevenlabs') => {
    const updated = saveOperatorConfig({ ttsEngine: engine });
    setOperatorCfg(updated);
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
              <h3 className="settings-row__title">Microphone</h3>
              <p>Device names are private to this computer. Automatic chooses a safe input.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu" style={{ minWidth: 200, maxWidth: 300, flex: '0 1 300px' }}>
              <select
                aria-label="Microphone"
                className="settings-control ui-button zed-settings__select"
                style={{
                  width: '100%',
                  maxWidth: '280px',
                  height: '32px',
                  padding: '0 10px',
                  fontSize: '12px',
                  borderRadius: 'var(--radius-chip, 6px)',
                  background: 'var(--block-fill, rgba(255, 255, 255, 0.05))',
                  border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                  color: '#f4f4f6',
                  colorScheme: 'dark',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                }}
                onChange={(event) =>
                  onSelectDevice(event.target.value === 'automatic' ? null : event.target.value)
                }
                value={dictationSettings.deviceId ?? 'automatic'}
              >
                <option value="automatic" style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}>
                  Automatic
                </option>
                {dictationDevices.map((device) => (
                  <option
                    key={device.id}
                    value={device.id}
                    style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}
                  >
                    {device.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Live Mic Test in VoiceTab */}
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Prueba de audio en vivo (VU Meter)</h3>
              <p>
                {isTestingMic
                  ? testMicLevel > 0.08
                    ? `Voz detectada (${Math.round(testMicLevel * 100)}%)`
                    : 'En silencio — habla al micrófono'
                  : 'Comprueba que el micrófono captura sonido en tiempo real.'}
              </p>
            </div>
            <div className="settings-row__control" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
              <div
                style={{
                  flex: 1,
                  height: 8,
                  background: 'rgba(255, 255, 255, 0.08)',
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.round(testMicLevel * 100)}%`,
                    background: testMicLevel > 0.7 ? '#fbbf24' : '#10b981',
                    transition: 'width 0.08s ease-out',
                  }}
                />
              </div>
              <button
                type="button"
                className={`settings-control ui-button ${isTestingMic ? 'ui-button--danger' : ''}`}
                onClick={handleToggleMicTest}
                style={{ minWidth: 80, fontSize: 12 }}
              >
                {isTestingMic ? 'Detener' : 'Probar'}
              </button>
            </div>
          </div>
          {micTestError && (
            <div className="ui-card__row" style={{ color: '#f87171', fontSize: 12, padding: '8px 20px' }}>
              {micTestError}
            </div>
          )}

          {/* Live Transcription Test in VoiceTab */}
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Prueba de transcripción (Speech-to-Text)</h3>
              <p>
                {transcriptionTestState === 'idle'
                  ? 'Prueba si el modelo de IA en la nube transcribe lo que dices.'
                  : transcriptionTestState === 'recording'
                  ? `Grabando tu voz… habla al micrófono (${transcriptionTestSeconds}s / máx 8s)`
                  : 'Transcribiendo audio en la nube con IA… por favor espera.'}
              </p>
            </div>
            <div className="settings-row__control" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className={`settings-control ui-button ${transcriptionTestState === 'recording' ? 'ui-button--danger' : ''}`}
                onClick={handleToggleTranscriptionTest}
                disabled={transcriptionTestState === 'transcribing'}
                style={{ minWidth: 150, fontSize: 12 }}
              >
                {transcriptionTestState === 'recording'
                  ? 'Detener y Transcribir'
                  : transcriptionTestState === 'transcribing'
                  ? 'Transcribiendo…'
                  : 'Probar transcripción'}
              </button>
            </div>
          </div>
          {transcriptionResult && (
            <div
              className="ui-card__row"
              style={{
                flexDirection: 'column',
                gap: 8,
                padding: '12px 20px',
                background: transcriptionResult.success ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
                borderTop: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.06))',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    className="settings-badge"
                    data-tone={transcriptionResult.success ? 'running' : 'warning'}
                  >
                    {transcriptionResult.success ? `✓ ${transcriptionResult.engine}` : 'Fallo en la transcripción'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted, #9ca3af)' }}>
                    Grabación: {transcriptionResult.durationSecs.toFixed(1)}s • Latencia:{' '}
                    {transcriptionResult.latencyMs}ms
                  </span>
                </div>
              </div>
              {transcriptionResult.success ? (
                <div
                  style={{
                    fontSize: 13,
                    color: '#f4f4f6',
                    background: 'rgba(0, 0, 0, 0.35)',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    fontStyle: transcriptionResult.text ? 'normal' : 'italic',
                  }}
                >
                  {transcriptionResult.text ? `"${transcriptionResult.text}"` : '(Sin palabras detectadas — audio en silencio)'}
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    color: '#f87171',
                    background: 'rgba(239, 68, 68, 0.1)',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid rgba(239, 68, 68, 0.2)',
                  }}
                >
                  {transcriptionResult.error}
                </div>
              )}
            </div>
          )}

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
              <button
                className="settings-control ui-button"
                onClick={onResetShortcut}
                type="button"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Seccion Asistente Zed (Voz en la Nube con Grok) ─────────── */}
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

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Grok API Key (Transcripción en la Nube)</h3>
              <p>
                Clave de API de xAI (Grok) para enviar el audio directamente a la nube sin consumir recursos locales.
              </p>
            </div>
            <div className="settings-row__control" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type={showKey ? 'text' : 'password'}
                className="settings-control ui-input"
                style={{ width: '220px', fontFamily: 'monospace', fontSize: '12px' }}
                placeholder="xai-..."
                value={grokKeyInput}
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
                de la síntesis de voz del sistema o ElevenLabs Neural Streaming.
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
              <h3 className="settings-row__title">Motor de Síntesis de Voz (TTS)</h3>
              <p>
                Elige entre la síntesis local del navegador o el streaming neuronal de ElevenLabs (v4 Turbo).
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

          {operatorCfg.ttsEngine === 'elevenlabs' && (
            <div className="ui-card__row settings-row">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">ElevenLabs API Key</h3>
                <p>
                  Clave de API de ElevenLabs para streaming de voz neuronal de baja latencia (~100ms).
                </p>
              </div>
              <div className="settings-row__control" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type={showElevenKey ? 'text' : 'password'}
                  className="settings-control ui-input"
                  style={{ width: '220px', fontFamily: 'monospace', fontSize: '12px' }}
                  placeholder="xi_..."
                  value={elevenKeyInput}
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
            </div>
          )}

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Idioma del Asistente</h3>
              <p>El Asistente opera y sintetiza respuestas estrictamente en español.</p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge">Español (es-ES / es-Latam)</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
};
