import React, { useEffect, useRef, useState } from 'react';
import { SelectMenu } from '../../../ui/SelectMenu';
import type { DictationInputDevice } from '../types';
import {
  releaseOperatorCapture,
  startMicrophoneTest,
  startTranscriptionTestSession,
  type MicrophoneTester,
  type TranscriptionTestResult,
  type TranscriptionTestSession,
} from '../../../../lib/operator/voice/zedVoice';

interface MicCalibrationCardProps {
  devices: DictationInputDevice[];
  deviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export const MicCalibrationCard: React.FC<MicCalibrationCardProps> = ({
  devices,
  deviceId,
  onSelectDevice,
}) => {
  const selectedId = deviceId || 'automatic';
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [testMicLevel, setTestMicLevel] = useState(0);
  const [micTestError, setMicTestError] = useState<string | null>(null);
  const micTesterRef = useRef<MicrophoneTester | null>(null);

  const [transcriptionTestState, setTranscriptionTestState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [transcriptionTestSeconds, setTranscriptionTestSeconds] = useState(0);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionTestResult | null>(null);
  const transcriptionSessionRef = useRef<TranscriptionTestSession | null>(null);
  const transcriptionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      micTesterRef.current?.stop();
      micTesterRef.current = null;
      transcriptionSessionRef.current?.cancel();
      transcriptionSessionRef.current = null;
      if (transcriptionTimerRef.current) {
        clearInterval(transcriptionTimerRef.current);
        transcriptionTimerRef.current = null;
      }
    };
  }, []);

  const captureDeviceId = selectedId === 'automatic' ? null : selectedId;

  const handleToggleMicTest = async () => {
    if (isTestingMic) {
      micTesterRef.current?.stop();
      micTesterRef.current = null;
      setIsTestingMic(false);
      setTestMicLevel(0);
      setMicTestError(null);
      return;
    }

    setMicTestError(null);
    try {
      await releaseOperatorCapture();
      const tester = await startMicrophoneTest(captureDeviceId, (level) => {
        setTestMicLevel(level);
      });
      micTesterRef.current = tester;
      setIsTestingMic(true);
    } catch (err) {
      setMicTestError(errorMessage(err, 'No se pudo acceder al micrófono. Verifica los permisos del sistema.'));
      setIsTestingMic(false);
      setTestMicLevel(0);
    }
  };

  const finishTranscription = async (session: TranscriptionTestSession | null, elapsed: number) => {
    if (!session) {
      setTranscriptionTestState('idle');
      return;
    }
    setTranscriptionTestState('transcribing');
    try {
      const result = await session.stopAndTranscribe();
      setTranscriptionResult(result);
    } catch (err) {
      setTranscriptionResult({
        success: false,
        error: errorMessage(err, 'Error inesperado al transcribir.'),
        engine: 'Desconocido',
        latencyMs: 0,
        durationSecs: elapsed,
      });
    } finally {
      setTranscriptionTestState('idle');
    }
  };

  const handleToggleTranscriptionTest = async () => {
    if (transcriptionTestState === 'recording') {
      if (transcriptionTimerRef.current) {
        clearInterval(transcriptionTimerRef.current);
        transcriptionTimerRef.current = null;
      }
      const session = transcriptionSessionRef.current;
      transcriptionSessionRef.current = null;
      await finishTranscription(session, transcriptionTestSeconds);
      return;
    }

    if (transcriptionTestState !== 'idle') return;

    setTranscriptionResult(null);
    setTranscriptionTestSeconds(0);
    try {
      await releaseOperatorCapture();
      const session = await startTranscriptionTestSession(captureDeviceId);
      transcriptionSessionRef.current = session;
      setTranscriptionTestState('recording');

      let elapsed = 0;
      transcriptionTimerRef.current = setInterval(() => {
        elapsed += 1;
        setTranscriptionTestSeconds(elapsed);
        if (elapsed < 8 || !transcriptionSessionRef.current) return;
        if (transcriptionTimerRef.current) {
          clearInterval(transcriptionTimerRef.current);
          transcriptionTimerRef.current = null;
        }
        const currentSession = transcriptionSessionRef.current;
        transcriptionSessionRef.current = null;
        void finishTranscription(currentSession, elapsed);
      }, 1000);
    } catch (err) {
      setTranscriptionResult({
        success: false,
        error: errorMessage(err, 'No se pudo acceder al micrófono para la prueba.'),
        engine: 'Desconocido',
        latencyMs: 0,
        durationSecs: 0,
      });
      setTranscriptionTestState('idle');
    }
  };

  const rows = [
    { id: 'automatic', title: 'Automatic' },
    ...devices.map((device) => ({ id: device.id, title: device.name })),
  ];
  if (!rows.some((row) => row.id === selectedId)) {
    rows.push({ id: selectedId, title: selectedId });
  }
  const selectedTitle = rows.find((row) => row.id === selectedId)?.title ?? 'Automatic';

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Calibración del micrófono</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Microphone</h3>
            <p>Device names are private to this computer. Automatic chooses a safe input.</p>
          </div>
          <div className="settings-row__control settings-row__control--menu">
            <SelectMenu
              label="Microphone"
              variant="field"
              className="settings-select"
              value={selectedId}
              rows={rows}
              triggerLabel={selectedTitle}
              onSelect={(id) => onSelectDevice(id === 'automatic' ? null : id)}
            />
          </div>
        </div>

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
          <div className="settings-row__control settings-vu-row">
            <div className="settings-vu" aria-hidden="true">
              <div
                className={`settings-vu__fill${testMicLevel > 0.7 ? ' settings-vu__fill--hot' : ''}`}
                style={{ width: `${Math.round(testMicLevel * 100)}%` }}
              />
            </div>
            <button
              type="button"
              className={`settings-control ui-button${isTestingMic ? ' ui-button--danger' : ''}`}
              onClick={() => void handleToggleMicTest()}
            >
              {isTestingMic ? 'Detener' : 'Probar'}
            </button>
          </div>
        </div>
        {micTestError ? <div className="settings-inline-error">{micTestError}</div> : null}

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
          <div className="settings-row__control">
            <button
              type="button"
              className={`settings-control ui-button${transcriptionTestState === 'recording' ? ' ui-button--danger' : ''}`}
              onClick={() => void handleToggleTranscriptionTest()}
              disabled={transcriptionTestState === 'transcribing'}
            >
              {transcriptionTestState === 'recording'
                ? 'Detener y Transcribir'
                : transcriptionTestState === 'transcribing'
                  ? 'Transcribiendo…'
                  : 'Probar transcripción'}
            </button>
          </div>
        </div>
        {transcriptionResult ? (
          <div
            className={`settings-transcription-result${transcriptionResult.success ? ' is-ok' : ' is-error'}`}
          >
            <div className="settings-transcription-result__meta">
              <span className="settings-badge" data-tone={transcriptionResult.success ? 'running' : 'warning'}>
                {transcriptionResult.success ? `✓ ${transcriptionResult.engine}` : 'Fallo en la transcripción'}
              </span>
              <span>
                Grabación: {transcriptionResult.durationSecs.toFixed(1)}s • Latencia: {transcriptionResult.latencyMs}ms
              </span>
            </div>
            {transcriptionResult.success ? (
              <div className="settings-transcription-result__text">
                {transcriptionResult.text
                  ? `"${transcriptionResult.text}"`
                  : '(Sin palabras detectadas — audio en silencio)'}
              </div>
            ) : (
              <div className="settings-transcription-result__error">{transcriptionResult.error}</div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
};
