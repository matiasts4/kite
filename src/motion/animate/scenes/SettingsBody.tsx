import { AnimatePresence, motion } from 'motion/react';
import { ZedHeroCard } from '../../../components/views/settings/zed/ZedHeroCard';
import {
  DEFAULT_ZED_PERSONA,
  type OperatorConfig,
  type OperatorProviderId,
} from '../../../lib/operator/operatorConfig';
import { useLabMotion, useLabReduce } from '../context';
import type { CompareVariant } from '../frame';
import { ChevronDownIcon } from '../ui';
import {
  APPROVAL_LABELS,
  APPROVAL_OPTIONS,
  LANGUAGE_OPTIONS,
  MODEL_OPTIONS,
  SETTINGS_SECTIONS,
  type LanguageId,
  type ModelId,
  type SettingsHandlers,
  type SettingsTabId,
  type SettingsValues,
} from './settingsData';

function SettingsSlider({
  mode,
  value,
  onChange,
}: {
  mode: CompareVariant;
  value: number;
  onChange: (next: number) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className="p6-slider">
      <div className="p6-slider__track" aria-hidden="true">
        {mode === 'animate' ? (
          <motion.div
            className="p6-slider__fill"
            initial={false}
            animate={{ scaleX: value / 100 }}
            transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.thumb}
            style={{ transformOrigin: 'left center' }}
          />
        ) : (
          <div className="p6-slider__fill p6-slider__fill--css" style={{ width: `${value}%` }} />
        )}
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        className="p6-slider__input"
        aria-label="Creatividad"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <strong className="p6-slider__value">{value}%</strong>
    </div>
  );
}

export function SettingsBody({
  mode,
  tab,
  values,
  handlers,
  openSection,
  onToggleSection,
  workspaceInvalid,
  workspaceTouched,
  operatorConfig,
  testingProvider,
  savedToast,
  onRunProbe,
}: {
  mode: CompareVariant;
  tab: SettingsTabId;
  values: SettingsValues;
  handlers: SettingsHandlers;
  openSection: string | null;
  onToggleSection: (id: string) => void;
  workspaceInvalid: string | null;
  workspaceTouched: boolean;
  operatorConfig: OperatorConfig;
  testingProvider: OperatorProviderId | null;
  savedToast: boolean;
  onRunProbe: (providerId: OperatorProviderId) => void;
}) {
  const motionTokens = useLabMotion();

  if (tab === 'models') {
    return (
      <div className="ui-card">
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Modelo por defecto</h3>
            <p>Se usa cuando un hilo no declara uno.</p>
          </div>
          <div className="ui-segmented" role="radiogroup" aria-label="Modelo por defecto">
            {MODEL_OPTIONS.map((opt) => {
              const selected = values.model === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  className="ui-segmented__item"
                  onClick={() => handlers.onModel(opt.id as ModelId)}
                >
                  {mode === 'animate' && selected && (
                    <motion.span
                      layoutId="cmp-settings-model"
                      className="ui-segmented__indicator"
                      initial={false}
                      transition={motionTokens.springs.selection}
                    />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Creatividad</h3>
            <p>Cuánto se permite improvisar al modelo.</p>
          </div>
          <SettingsSlider mode={mode} value={values.temperature} onChange={handlers.onTemperature} />
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Aprobaciones</h3>
            <p>Preguntar antes de escribir archivos.</p>
          </div>
          <span className="cmp-badge">{APPROVAL_LABELS[values.approval]}</span>
        </div>
      </div>
    );
  }

  if (tab === 'usage') {
    return (
      <div className="ui-card">
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Tokens del mes</h3>
            <p>72% del presupuesto del workspace.</p>
          </div>
          <strong className="cmp-metric">72%</strong>
        </div>
        <div className="cmp-meter" style={{ margin: '0 20px 16px' }}>
          <div className="cmp-meter__fill" style={{ width: '72%' }} />
        </div>
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Sesiones activas</h3>
            <p>Una por cada agente conectado.</p>
          </div>
          <strong className="cmp-metric">18</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-settings__rows" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* REAL ZedHeroCard with 64px ZedOrb, BorderBeam, and MetalFx latency probe */}
      <ZedHeroCard
        persona={operatorConfig.persona ?? DEFAULT_ZED_PERSONA}
        config={operatorConfig}
        savedToast={savedToast}
        testingProvider={testingProvider}
        onRunProbe={onRunProbe}
      />

      {/* Real settings group using .ui-card, .ui-switch, .ui-segmented, and .ui-field */}
      <div className="ui-card">
        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Streaming en vivo</h3>
            <p>Mostrar los tokens a medida que llegan en tiempo real.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={values.streaming}
            aria-label="Streaming en vivo"
            className="ui-switch"
            onClick={handlers.onStreaming}
          >
            <span className="ui-switch__knob" />
          </button>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Recordar permisos</h3>
            <p>No volver a preguntar por las lecturas de esta sesión.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={values.remember}
            aria-label="Recordar permisos"
            className="ui-switch"
            onClick={handlers.onRemember}
          >
            <span className="ui-switch__knob" />
          </button>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Aprobaciones</h3>
            <p>Qué pasa antes de escribir un archivo o ejecutar comandos.</p>
          </div>
          <div className="ui-segmented" role="radiogroup" aria-label="Aprobaciones">
            {APPROVAL_OPTIONS.map((opt) => {
              const selected = values.approval === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  className="ui-segmented__item"
                  onClick={() => handlers.onApproval(opt.id)}
                >
                  {mode === 'animate' && selected && (
                    <motion.span
                      layoutId="cmp-settings-approval"
                      className="ui-segmented__indicator"
                      initial={false}
                      transition={motionTokens.springs.selection}
                    />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Nombre del workspace</h3>
            <p>Se muestra en el rail y en los exports.</p>
          </div>
          <div className="p6-field" style={{ minWidth: 200 }}>
            <input
              className={`ui-field p6-input${workspaceInvalid && workspaceTouched ? ' is-invalid' : ''}`}
              value={values.workspace}
              onChange={(event) => handlers.onWorkspace(event.target.value)}
              onBlur={handlers.onTouchWorkspace}
              aria-label="Nombre del workspace"
              aria-invalid={Boolean(workspaceInvalid && workspaceTouched)}
            />
            {workspaceInvalid && workspaceTouched && (
              <span className="p6-field__error">{workspaceInvalid}</span>
            )}
          </div>
        </div>

        <div className="settings-row ui-card__row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Idioma de la interfaz</h3>
            <p>Copy y mensajes del agente.</p>
          </div>
          <div className="ui-segmented" role="radiogroup" aria-label="Idioma de la interfaz">
            {LANGUAGE_OPTIONS.map((opt) => {
              const selected = values.language === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-pressed={selected}
                  className="ui-segmented__item"
                  onClick={() => handlers.onLanguage(opt.id as LanguageId)}
                >
                  {mode === 'animate' && selected && (
                    <motion.span
                      layoutId="cmp-settings-language"
                      className="ui-segmented__indicator"
                      initial={false}
                      transition={motionTokens.springs.selection}
                    />
                  )}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="cmp-accordion">
        {SETTINGS_SECTIONS.map((section) => {
          const isOpen = openSection === section.id;
          return (
            <div key={section.id} className="cmp-accordion__item">
              <button
                type="button"
                className="cmp-accordion__trigger"
                aria-expanded={isOpen}
                onClick={() => onToggleSection(section.id)}
              >
                <span>{section.title}</span>
                {mode === 'animate' ? (
                  <motion.span
                    className="cmp-accordion__chevron"
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={motionTokens.tweens.disclosure}
                  >
                    <ChevronDownIcon size={13} />
                  </motion.span>
                ) : (
                  <ChevronDownIcon
                    size={13}
                    className={`cmp-accordion__chevron${isOpen ? ' is-open' : ''}`}
                  />
                )}
              </button>
              {mode === 'animate' ? (
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="content"
                      initial={{
                        height: 0,
                        opacity: 0,
                        filter: motionTokens.blur.disclosure,
                      }}
                      animate={{
                        height: 'auto',
                        opacity: 1,
                        filter: 'blur(0px)',
                        transitionEnd: { filter: 'none' },
                        transition: motionTokens.tweens.disclosure,
                      }}
                      exit={{
                        height: 0,
                        opacity: 0,
                        filter: motionTokens.blur.disclosure,
                        transition: motionTokens.tweens.disclosure,
                      }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="cmp-accordion__body">{section.body}</div>
                    </motion.div>
                  )}
                </AnimatePresence>
              ) : (
                isOpen && <div className="cmp-accordion__body">{section.body}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
