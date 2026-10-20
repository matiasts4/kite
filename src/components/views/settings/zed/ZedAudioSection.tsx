import React from 'react';
import {
  AudioInputDeviceInfo,
  TranscriptionTestResult,
} from '../../../../lib/operator/voice/zedVoice';
import { playZenCue } from '../../../../lib/operator/voice/audioDucking';

export interface ZedAudioSectionProps {
  micDevices: AudioInputDeviceInfo[];
  selectedMicId: string;
  onSelectMic: (deviceId: string) => void;
  onRefreshMicDevices: () => void;
  isTestingMic: boolean;
  testMicLevel: number;
  micTestStatus: string | null;
  onToggleMicTest: () => void;
  transcriptionTestState: 'idle' | 'recording' | 'transcribing';
  transcriptionTestSeconds: number;
  onToggleTranscriptionTest: () => void;
  transcriptionResult: TranscriptionTestResult | null;
  grokTransKey: string;
  onGrokTransKeyChange: (val: string) => void;
  showGrokTransKey: boolean;
  onToggleShowGrokTransKey: () => void;
  onSaveGrokTransKey: () => void;
  grokTransSaved: boolean;
}

export const ZedAudioSection: React.FC<ZedAudioSectionProps> = ({
  micDevices,
  selectedMicId,
  onSelectMic,
  onRefreshMicDevices,
  isTestingMic,
  testMicLevel,
  micTestStatus,
  onToggleMicTest,
  transcriptionTestState,
  transcriptionTestSeconds,
  onToggleTranscriptionTest,
  transcriptionResult,
  grokTransKey,
  onGrokTransKeyChange,
  showGrokTransKey,
  onToggleShowGrokTransKey,
  onSaveGrokTransKey,
  grokTransSaved,
}) => {
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
          Entrada de Audio y Micrófono del Asistente
        </h2>
        <button
          type="button"
          className="secondary-button"
          onClick={onRefreshMicDevices}
          style={{ fontSize: 12 }}
        >
          Actualizar lista de micrófonos
        </button>
      </div>

      <div className="ui-card">
        {/* Selector de micrófono */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Dispositivo de Entrada (Micrófono)</h3>
            <p>
              Selecciona el micrófono utilizado al pulsar el orbe esférico o el botón de voz.
            </p>
          </div>
          <div className="settings-row__control" style={{ minWidth: 200, maxWidth: 300, flex: '0 1 300px' }}>
            <select
              className="settings-control ui-button zed-settings__select"
              value={selectedMicId}
              onChange={(e) => onSelectMic(e.target.value)}
              style={{
                width: '100%',
                maxWidth: '280px',
                height: '34px',
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
            >
              <option value="automatic" style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}>
                Predeterminado del Sistema (Automático)
              </option>
              {micDevices.map((d) => (
                <option
                  key={d.deviceId}
                  value={d.deviceId}
                  style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}
                >
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Prueba en tiempo real con medidor de nivel / VU meter */}
        <div
          className="ui-card__row"
          style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div>
              <h3 className="settings-row__title" style={{ margin: 0, fontSize: 13 }}>
                Prueba de Audio en Tiempo Real (VU Meter)
              </h3>
              <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                Habla al micrófono para verificar que Kite recibe sonido correctamente sin distorsión.
              </p>
            </div>
            <button
              type="button"
              className={`secondary-button ${isTestingMic ? 'is-active' : ''}`}
              onClick={onToggleMicTest}
              style={{
                minWidth: 140,
                fontWeight: 600,
                backgroundColor: isTestingMic ? 'rgba(239, 68, 68, 0.15)' : undefined,
                borderColor: isTestingMic ? 'rgba(239, 68, 68, 0.4)' : undefined,
                color: isTestingMic ? '#f87171' : undefined,
              }}
            >
              {isTestingMic ? '■ Detener prueba' : '▶ Probar micrófono'}
            </button>
          </div>

          {/* Visual VU Meter Bar */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '12px 14px',
              borderRadius: 8,
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 11,
              }}
            >
              <span style={{ color: 'var(--text-muted)' }}>Nivel de entrada:</span>
              <span
                style={{
                  fontWeight: 600,
                  color: testMicLevel > 0.08 ? '#34d399' : 'var(--text-muted)',
                }}
              >
                {isTestingMic
                  ? testMicLevel > 0.08
                    ? `Voz detectada (${Math.round(testMicLevel * 100)}%)`
                    : 'En silencio / Esperando voz'
                  : 'Prueba inactiva'}
              </span>
            </div>

            <div
              style={{
                width: '100%',
                height: 10,
                background: 'rgba(255, 255, 255, 0.08)',
                borderRadius: 5,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.round(testMicLevel * 100)}%`,
                  background:
                    testMicLevel > 0.8
                      ? 'linear-gradient(90deg, #10b981 0%, #fbbf24 70%, #ef4444 100%)'
                      : testMicLevel > 0.3
                      ? 'linear-gradient(90deg, #10b981 0%, #34d399 100%)'
                      : '#10b981',
                  borderRadius: 5,
                  transition: 'width 0.08s ease-out',
                }}
              />
            </div>

            {micTestStatus && (
              <div style={{ color: '#f87171', fontSize: 11, marginTop: 4 }}>
                {micTestStatus}
              </div>
            )}
          </div>

          {/* Live Transcription Test in ZedTab */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              marginTop: 14,
              paddingTop: 14,
              borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <div>
              <h3 className="settings-row__title" style={{ margin: 0, fontSize: 13 }}>
                Prueba de Transcripción (Speech-to-Text)
              </h3>
              <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                {transcriptionTestState === 'idle'
                  ? 'Comprueba que la IA en la nube convierte correctamente tu voz en texto.'
                  : transcriptionTestState === 'recording'
                  ? `Grabando tu voz… habla al micrófono (${transcriptionTestSeconds}s / máx 8s)`
                  : 'Transcribiendo audio en la nube con IA… por favor espera.'}
              </p>
            </div>
            <button
              type="button"
              className={`secondary-button ${transcriptionTestState === 'recording' ? 'is-active' : ''}`}
              onClick={onToggleTranscriptionTest}
              disabled={transcriptionTestState === 'transcribing'}
              style={{
                minWidth: 160,
                fontWeight: 600,
                backgroundColor: transcriptionTestState === 'recording' ? 'rgba(239, 68, 68, 0.15)' : undefined,
                borderColor: transcriptionTestState === 'recording' ? 'rgba(239, 68, 68, 0.4)' : undefined,
                color: transcriptionTestState === 'recording' ? '#f87171' : undefined,
              }}
            >
              {transcriptionTestState === 'recording'
                ? '■ Detener y Transcribir'
                : transcriptionTestState === 'transcribing'
                ? 'Transcribiendo…'
                : '▶ Probar transcripción'}
            </button>
          </div>

          {transcriptionResult && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '12px 14px',
                borderRadius: 8,
                background: transcriptionResult.success ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
                border: transcriptionResult.success ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(239, 68, 68, 0.2)',
                marginTop: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span
                  className="settings-badge"
                  data-tone={transcriptionResult.success ? 'running' : 'warning'}
                >
                  {transcriptionResult.success ? `✓ ${transcriptionResult.engine}` : 'Fallo en la transcripción'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Grabación: {transcriptionResult.durationSecs.toFixed(1)}s • Latencia: {transcriptionResult.latencyMs}ms
                </span>
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
                  }}
                >
                  {transcriptionResult.error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Grok Cloud Audio Transcription Key */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">API Key de Grok / xAI (Transcripción en la Nube)</h3>
            <p>
              Opcional. Si se proporciona, usa xAI Grok STT (grok-voice-transcribe-2.0) en la nube. Si se omite o hay un error, usa Cloudflare Whisper Cloud integrado sin configuración requerida.
            </p>
          </div>
          <div
            className="settings-row__control"
            style={{ display: 'flex', gap: 8, alignItems: 'center' }}
          >
            <input
              type={showGrokTransKey ? 'text' : 'password'}
              className="zed-settings__input"
              value={grokTransKey}
              onChange={(e) => onGrokTransKeyChange(e.target.value)}
              placeholder="xai-... (opcional)"
              style={{ width: 190 }}
            />
            <button
              type="button"
              className="secondary-button"
              onClick={onToggleShowGrokTransKey}
              title={showGrokTransKey ? 'Ocultar' : 'Ver'}
            >
              {showGrokTransKey ? 'Ocultar' : 'Ver'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={onSaveGrokTransKey}
            >
              {grokTransSaved ? 'Guardado ✓' : 'Guardar'}
            </button>
          </div>
        </div>

        {/* Atenuación de Sonido y Tonos Zen (Veloce Parity) */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Atenuación de Sonido y Tonos Zen</h3>
            <p>
              Al hablarle al asistente, se atenúa automáticamente el volumen del sistema al 20% para evitar interferencias, reproduciendo los tonos Zen armónicos al inicio y fin de la grabación.
            </p>
          </div>
          <div
            className="settings-row__control"
            style={{ display: 'flex', gap: 8, alignItems: 'center' }}
          >
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                playZenCue(true);
                setTimeout(() => playZenCue(false), 350);
              }}
              style={{ fontSize: 12, padding: '5px 12px' }}
              title="Escuchar tono Zen de inicio y fin"
            >
              Probar Tonos Zen
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
