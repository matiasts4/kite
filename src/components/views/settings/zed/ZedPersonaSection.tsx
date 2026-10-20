import React from 'react';
import {
  ZedPersonaConfig,
  OperatorConfig,
} from '../../../../lib/operator/operatorConfig';

export const VOICE_OPTIONS = [
  { id: 'Ara', label: 'Ara — Clara, ágil (recomendada)' },
  { id: 'Rex', label: 'Rex — Directo, técnico' },
  { id: 'Eve', label: 'Eve — Serena, analítica' },
  { id: 'Leo', label: 'Leo — Firme, conciso' },
  { id: 'Sal', label: 'Sal — Relajado, conversacional' },
];

export const LANGUAGE_OPTIONS = [
  { id: 'es-ES', label: 'Español (es-ES)' },
  { id: 'en-US', label: 'English (en-US)' },
  { id: 'pt-BR', label: 'Português (pt-BR)' },
];

export interface ZedPersonaSectionProps {
  config: OperatorConfig;
  persona: ZedPersonaConfig;
  onPersonaChange: <K extends keyof ZedPersonaConfig>(
    key: K,
    value: ZedPersonaConfig[K]
  ) => void;
  onFieldChange: <K extends keyof OperatorConfig>(
    key: K,
    value: OperatorConfig[K]
  ) => void;
  systemVoices: SpeechSynthesisVoice[];
  testingVoice: boolean;
  onTestVoice: () => void;
  openingPreview: string;
}

export const ZedPersonaSection: React.FC<ZedPersonaSectionProps> = ({
  config,
  persona,
  onPersonaChange,
  onFieldChange,
  systemVoices,
  testingVoice,
  onTestVoice,
  openingPreview,
}) => {
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Identidad y Comportamiento de Zed</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Nombre y Voz</h3>
            <p>Nombre con el que responde el asistente, perfil de voz o voz instalada del sistema.</p>
          </div>
          <div className="settings-row__control" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              className="zed-settings__input"
              value={persona.name}
              maxLength={32}
              onChange={(e) => onPersonaChange('name', e.target.value)}
              placeholder="Zed"
              style={{ width: 110 }}
              aria-label="Nombre del asistente"
            />
            <select
              className="settings-control ui-button zed-settings__select"
              value={persona.voice}
              onChange={(e) => onPersonaChange('voice', e.target.value)}
              style={{
                height: '32px',
                padding: '0 10px',
                fontSize: '12px',
                borderRadius: 'var(--radius-chip, 6px)',
                background: 'var(--block-fill, rgba(255, 255, 255, 0.05))',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                color: '#f4f4f6',
                colorScheme: 'dark',
                maxWidth: '240px',
              }}
              aria-label="Voz del asistente"
            >
              <optgroup label="Perfiles de Voz Zed" style={{ backgroundColor: '#18181d', color: '#a1a1aa' }}>
                {VOICE_OPTIONS.map((v) => (
                  <option
                    key={v.id}
                    value={v.id}
                    style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}
                  >
                    {v.label}
                  </option>
                ))}
              </optgroup>
              {systemVoices.length > 0 && (
                <optgroup label="Voces del Sistema" style={{ backgroundColor: '#18181d', color: '#a1a1aa' }}>
                  {systemVoices.map((v) => (
                    <option
                      key={v.name}
                      value={v.name}
                      style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}
                    >
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </optgroup>
              )}
              {!VOICE_OPTIONS.some((o) => o.id === persona.voice) &&
                !systemVoices.some((v) => v.name === persona.voice) &&
                persona.voice && (
                  <option
                    value={persona.voice}
                    style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}
                  >
                    {persona.voice} (actual)
                  </option>
                )}
            </select>
            <button
              type="button"
              className="secondary-button"
              onClick={onTestVoice}
              style={{
                height: '32px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0 12px',
                fontSize: '12px',
                whiteSpace: 'nowrap',
              }}
              title="Probar cómo suena la voz seleccionada"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {testingVoice ? (
                  <rect x="6" y="6" width="12" height="12" />
                ) : (
                  <polygon points="5 3 19 12 5 21 5 3" />
                )}
              </svg>
              <span>{testingVoice ? 'Detener' : 'Probar voz'}</span>
            </button>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Velocidad de Voz</h3>
            <p>Ritmo de lectura y cadencia de la síntesis ({((config.ttsRate || 1.0)).toFixed(2)}x).</p>
          </div>
          <div className="settings-row__control" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min="0.80"
              max="1.30"
              step="0.05"
              value={config.ttsRate || 1.0}
              onChange={(e) => onFieldChange('ttsRate', parseFloat(e.target.value))}
              style={{ width: 140, accentColor: 'var(--accent-color, #7c3aed)' }}
              aria-label="Velocidad de voz"
            />
            <span style={{ fontSize: '12px', minWidth: '40px', color: 'var(--text-secondary, #a1a1aa)' }}>
              {((config.ttsRate || 1.0)).toFixed(2)}x
            </span>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Tono</h3>
            <p>Estilo de comunicación cuando confirma acciones o resume estado.</p>
          </div>
          <div className="settings-row__control">
            <fieldset aria-label="Tono" className="ui-segmented">
              {(
                [
                  { id: 'direct', label: 'Direct' },
                  { id: 'warm', label: 'Warm' },
                  { id: 'chill', label: 'Chill' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={persona.tone === t.id}
                  className="ui-segmented__item"
                  onClick={() => onPersonaChange('tone', t.id)}
                >
                  <span>{t.label}</span>
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Brevedad</h3>
            <p>Nivel de detalle en las respuestas habladas y escritas.</p>
          </div>
          <div className="settings-row__control">
            <fieldset aria-label="Brevedad" className="ui-segmented">
              {(
                [
                  { id: 'tight', label: 'Tight' },
                  { id: 'normal', label: 'Normal' },
                  { id: 'detailed', label: 'Detailed' },
                ] as const
              ).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={persona.brevity === b.id}
                  className="ui-segmented__item"
                  onClick={() => onPersonaChange('brevity', b.id)}
                >
                  <span>{b.label}</span>
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">¿Cómo debe llamarte Zed?</h3>
            <p>Opcional — usado en saludos y confirmaciones.</p>
          </div>
          <div className="settings-row__control" style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="zed-settings__input"
              value={persona.builderCallMe}
              maxLength={40}
              onChange={(e) => onPersonaChange('builderCallMe', e.target.value)}
              placeholder="ej. Alex"
              style={{ width: 150 }}
            />
            <select
              className="settings-control ui-button zed-settings__select"
              value={persona.language}
              onChange={(e) => {
                onPersonaChange('language', e.target.value);
                onFieldChange('ttsLanguage', e.target.value);
              }}
              style={{
                height: '32px',
                padding: '0 10px',
                fontSize: '12px',
                borderRadius: 'var(--radius-chip, 6px)',
                background: 'var(--block-fill, rgba(255, 255, 255, 0.05))',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.1))',
                color: '#f4f4f6',
                colorScheme: 'dark',
              }}
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <option
                  key={lang.id}
                  value={lang.id}
                  style={{ backgroundColor: '#18181d', color: '#f4f4f6' }}
                >
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          className="ui-card__row"
          style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 18px' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 className="settings-row__title" style={{ margin: 0 }}>
              Instrucciones permanentes (Standing instructions)
            </h3>
            <span className="zed-settings__counter">
              {persona.standingInstructions.length} / 600
            </span>
          </div>
          <textarea
            className="zed-settings__textarea"
            rows={3}
            maxLength={600}
            value={persona.standingInstructions}
            onChange={(e) => onPersonaChange('standingInstructions', e.target.value)}
            placeholder="ej. Prefiere abrir subagentes con Grok para frontend, no pidas confirmación al cerrar terminales inactivas."
          />
          <div className="zed-settings__preview">
            <span className="zed-settings__preview-label">Zed opening preview</span>
            <span className="zed-settings__preview-line">&ldquo;{openingPreview}&rdquo;</span>
          </div>
        </div>

        {/* Voice synthesis controls */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Lectura en voz alta (TTS)</h3>
            <p>Leer automáticamente las respuestas y resúmenes de agentes en voz alta.</p>
          </div>
          <div className="settings-row__control" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              role="switch"
              aria-checked={config.ttsEnabled}
              className={`ui-switch${config.ttsEnabled ? ' is-on' : ''}`}
              onClick={() => onFieldChange('ttsEnabled', !config.ttsEnabled)}
            >
              <span aria-hidden="true" className="ui-switch__knob" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
