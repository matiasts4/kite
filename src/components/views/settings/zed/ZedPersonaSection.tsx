import React, { useState } from 'react';
import {
  ZedPersonaConfig,
  OperatorConfig,
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_CURATED_VOICES,
} from '../../../../lib/operator/operatorConfig';
import { SegmentedIndicator } from '../../../ui/SegmentedIndicator';
import { SelectMenu, type SelectMenuRow } from '../../../ui/SelectMenu';

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

const SPEED_ROWS: SelectMenuRow[] = Array.from({ length: 11 }, (_, index) => {
  const id = (0.8 + index * 0.05).toFixed(2);
  return { id, title: `${id}x` };
});

function menuTitle(rows: SelectMenuRow[], value: string, fallback: string): string {
  return rows.find((row) => row.id === value)?.title ?? fallback;
}

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
  const [showElevenKey, setShowElevenKey] = useState(false);
  const isEleven = config.ttsEngine === 'elevenlabs';
  const isCuratedVoice = ELEVENLABS_CURATED_VOICES.some((v) => v.id === config.elevenlabsVoiceId);
  const [customVoiceActive, setCustomVoiceActive] = useState(!isCuratedVoice && Boolean(config.elevenlabsVoiceId));
  const systemVoiceRows: SelectMenuRow[] = [
    ...VOICE_OPTIONS.map((voice, index) => ({
      id: voice.id,
      title: voice.label,
      sectionTitle: index === 0 ? 'Perfiles de Voz Zed' : undefined,
    })),
    ...systemVoices.map((voice, index) => ({
      id: voice.name,
      title: `${voice.name} (${voice.lang})`,
      sectionTitle: index === 0 ? 'Voces del Sistema' : undefined,
      ruleBefore: index === 0,
    })),
  ];
  if (
    persona.voice &&
    !systemVoiceRows.some((row) => row.id === persona.voice)
  ) {
    systemVoiceRows.push({ id: persona.voice, title: `${persona.voice} (actual)` });
  }
  const speedId = (config.ttsRate || 1).toFixed(2);
  const speedRows = SPEED_ROWS.some((row) => row.id === speedId)
    ? SPEED_ROWS
    : [...SPEED_ROWS, { id: speedId, title: `${speedId}x` }];

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Identidad y Comportamiento de Zed</h2>
      <div className="ui-card">
        {/* Nombre del asistente */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Nombre del Asistente</h3>
            <p>Nombre con el que responde el asistente en los saludos e interfaces.</p>
          </div>
          <div className="settings-row__control">
            <input
              type="text"
              className="zed-settings__input"
              value={persona.name}
              maxLength={32}
              onChange={(e) => onPersonaChange('name', e.target.value)}
              placeholder="Zed"
              style={{ width: 140 }}
              aria-label="Nombre del asistente"
            />
          </div>
        </div>

        {/* Motor de Síntesis (TTS Engine) */}
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Motor de Síntesis de Voz (TTS)</h3>
            <p>Elige entre la síntesis local del navegador o el streaming neuronal de ElevenLabs.</p>
          </div>
          <div className="settings-row__control">
            <fieldset aria-label="Motor de Síntesis de Voz" className="ui-segmented">
              <button
                type="button"
                aria-pressed={!isEleven}
                className="ui-segmented__item"
                onClick={() => onFieldChange('ttsEngine', 'browser')}
              >
                {!isEleven && <SegmentedIndicator group="settings-zed-tts-engine" />}
                <span>Nativo (Sistema)</span>
              </button>
              <button
                type="button"
                aria-pressed={isEleven}
                className="ui-segmented__item"
                onClick={() => onFieldChange('ttsEngine', 'elevenlabs')}
              >
                {isEleven && <SegmentedIndicator group="settings-zed-tts-engine" />}
                <span>ElevenLabs Neural (v4 Turbo)</span>
              </button>
            </fieldset>
          </div>
        </div>

        {/* Configuración de ElevenLabs */}
        {isEleven ? (
          <>
            <div className="ui-card__row settings-row settings-row--stacked">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">Clave de API ElevenLabs</h3>
                <p>Requerida para streaming de audio de alta fidelidad (~100ms de latencia).</p>
              </div>
              <div className="settings-row__control">
                <div className="settings-credential">
                  <input
                    type={showElevenKey ? 'text' : 'password'}
                    className="ui-field"
                    value={config.elevenlabsApiKey || ''}
                    onChange={(e) => onFieldChange('elevenlabsApiKey', e.target.value)}
                    placeholder="xi_..."
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Clave de API ElevenLabs"
                  />
                  <button
                    type="button"
                    className="settings-control ui-button"
                    onClick={() => setShowElevenKey(!showElevenKey)}
                    title={showElevenKey ? 'Ocultar clave' : 'Mostrar clave'}
                  >
                    {showElevenKey ? 'Ocultar' : 'Ver'}
                  </button>
                </div>
              </div>
            </div>

            <div className="ui-card__row settings-row">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">Modelo y Voz ElevenLabs</h3>
                <p>Selecciona el modelo optimizado de baja latencia y el timbre de voz deseado.</p>
              </div>
              <div className="settings-row__control" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <SelectMenu
                  label="Modelo de ElevenLabs"
                  variant="field"
                  className="settings-select"
                  value={config.elevenlabsModel || 'eleven_v4_turbo'}
                  rows={ELEVENLABS_TTS_MODELS.map((model) => ({ id: model.id, title: model.label }))}
                  triggerLabel={menuTitle(
                    ELEVENLABS_TTS_MODELS.map((model) => ({ id: model.id, title: model.label })),
                    config.elevenlabsModel || 'eleven_v4_turbo',
                    config.elevenlabsModel || 'eleven_v4_turbo'
                  )}
                  onSelect={(id) => onFieldChange('elevenlabsModel', id)}
                />
                <SelectMenu
                  label="Voz de ElevenLabs"
                  variant="field"
                  className="settings-select"
                  value={customVoiceActive ? 'custom' : (config.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM')}
                  rows={[
                    ...ELEVENLABS_CURATED_VOICES.map((voice, index) => ({
                      id: voice.id,
                      title: voice.label,
                      sectionTitle: index === 0 ? 'Voces Curadas' : undefined,
                    })),
                    {
                      id: 'custom',
                      title: 'ID Personalizado...',
                      sectionTitle: 'Personalizada',
                      ruleBefore: true,
                    },
                  ]}
                  triggerLabel={
                    customVoiceActive
                      ? 'ID Personalizado...'
                      : ELEVENLABS_CURATED_VOICES.find((voice) => voice.id === config.elevenlabsVoiceId)?.label
                        || config.elevenlabsVoiceId
                        || 'Voz'
                  }
                  onSelect={(id) => {
                    if (id === 'custom') {
                      setCustomVoiceActive(true);
                      return;
                    }
                    setCustomVoiceActive(false);
                    onFieldChange('elevenlabsVoiceId', id);
                  }}
                />

                {customVoiceActive && (
                  <input
                    type="text"
                    className="zed-settings__input"
                    value={config.elevenlabsVoiceId || ''}
                    onChange={(e) => onFieldChange('elevenlabsVoiceId', e.target.value)}
                    placeholder="Voice ID (ej. 21m00T...)"
                    style={{ width: 150, fontSize: 12, fontFamily: 'monospace' }}
                    aria-label="Voice ID personalizado"
                  />
                )}

                {/* Botón de prueba */}
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
                  title="Probar streaming de voz con ElevenLabs"
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
          </>
        ) : (
          /* Configuración Nativa del Sistema */
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Voz del Asistente (Sistema)</h3>
              <p>Perfil de voz emulada o voz instalada en el sistema operativo.</p>
            </div>
            <div className="settings-row__control" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <SelectMenu
                label="Voz del asistente"
                variant="field"
                className="settings-select"
                value={persona.voice}
                rows={systemVoiceRows}
                triggerLabel={menuTitle(systemVoiceRows, persona.voice, persona.voice)}
                onSelect={(id) => onPersonaChange('voice', id)}
              />
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
        )}

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Velocidad de Voz</h3>
            <p>Ritmo de lectura y cadencia de la síntesis ({((config.ttsRate || 1.0)).toFixed(2)}x).</p>
          </div>
          <div className="settings-row__control settings-row__control--menu">
            <SelectMenu
              label="Velocidad de voz"
              variant="field"
              className="settings-select"
              value={speedId}
              rows={speedRows}
              triggerLabel={menuTitle(speedRows, speedId, `${speedId}x`)}
              onSelect={(id) => onFieldChange('ttsRate', Number(id))}
            />
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
              ).map((t) => {
                const isSelected = persona.tone === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={isSelected}
                    className="ui-segmented__item"
                    onClick={() => onPersonaChange('tone', t.id)}
                  >
                    {isSelected && <SegmentedIndicator group="settings-zed-tone" />}
                    <span>{t.label}</span>
                  </button>
                );
              })}
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
              ).map((b) => {
                const isSelected = persona.brevity === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={isSelected}
                    className="ui-segmented__item"
                    onClick={() => onPersonaChange('brevity', b.id)}
                  >
                    {isSelected && <SegmentedIndicator group="settings-zed-brevity" />}
                    <span>{b.label}</span>
                  </button>
                );
              })}
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
            <SelectMenu
              label="Idioma"
              variant="field"
              className="settings-select"
              value={persona.language}
              rows={LANGUAGE_OPTIONS.map((lang) => ({ id: lang.id, title: lang.label }))}
              triggerLabel={menuTitle(
                LANGUAGE_OPTIONS.map((lang) => ({ id: lang.id, title: lang.label })),
                persona.language,
                persona.language
              )}
              onSelect={(id) => {
                onPersonaChange('language', id);
                onFieldChange('ttsLanguage', id);
              }}
            />
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
