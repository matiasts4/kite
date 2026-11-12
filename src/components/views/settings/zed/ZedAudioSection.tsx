import React, { useState } from 'react';
import {
  OperatorConfig,
  loadOperatorConfig,
  saveOperatorConfig,
} from '../../../../lib/operator/operatorConfig';
import { toast } from '../../../../lib/toast';

const MIC_DEVICE_STORAGE_KEY = 'kite_selected_mic_device_id';
const GROK_TRANSCRIPTION_KEY_STORAGE_KEY = 'kite_grok_transcription_api_key';

export interface ZedAudioSectionProps {
  config?: OperatorConfig;
  onFieldChange?: <K extends keyof OperatorConfig>(
    key: K,
    value: OperatorConfig[K]
  ) => void;
}

export const ZedAudioSection: React.FC<ZedAudioSectionProps> = ({
  config: externalConfig,
  onFieldChange,
}) => {
  const [deviceId] = useState(() => {
    try {
      return localStorage.getItem(MIC_DEVICE_STORAGE_KEY) || 'automatic';
    } catch {
      return 'automatic';
    }
  });
  const [showSttKey, setShowSttKey] = useState(false);
  const [savedSttKey, setSavedSttKey] = useState(false);

  const effectiveConfig = externalConfig ?? loadOperatorConfig();
  const sttKeyValue =
    effectiveConfig.grokTranscriptionApiKey ||
    effectiveConfig.grokApiKey ||
    '';

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
    if (onFieldChange) {
      onFieldChange('grokTranscriptionApiKey', value);
    } else {
      saveOperatorConfig({ grokTranscriptionApiKey: value });
    }
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Entrada de Audio y Micrófono del Asistente</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Micrófono del sistema</h3>
            <p>
              El micrófono y la prueba en vivo se configuran en Voice & Dictado. Dispositivo activo: {deviceId}.
            </p>
          </div>
        </div>

        <div className="ui-card__row settings-row settings-row--stacked">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Grok API Key (Transcripción Voz a Texto · STT)</h3>
            <p>
              Clave dedicada para transcribir tu voz a texto en el dictado global y en el modo de voz de Zed. Si queda vacía, reutiliza la API Key principal de Grok o Cloudflare Whisper.
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
                {savedSttKey ? 'Guardado ✓' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
