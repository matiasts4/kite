import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import '../../../components/views/settings.css';
import {
  DEFAULT_OPERATOR_CONFIG,
  type OperatorConfig,
  type OperatorProviderId,
} from '../../../lib/operator/operatorConfig';
import { usePresence } from '../../usePresence';
import { motionSurfaceClass } from '../../surface';
import { useLabMotion, useLabReduce } from '../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../frame';
import { CloseIcon, SwapLabel } from '../ui';
import { SettingsBody } from './SettingsBody';
import {
  DEFAULT_SETTINGS,
  SETTINGS_TABS,
  workspaceError,
  type SettingsHandlers,
  type SettingsTabId,
  type SettingsValues,
} from './settingsData';

function ResetDialog({
  mode,
  open,
  onClose,
  onConfirm,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const body = (
    <>
      <div className="cmp-modal__head">
        <strong>¿Restablecer los ajustes?</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar confirmación">
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <p className="cmp-muted">
        Se pierden los cambios de esta sesión y vuelven los valores por defecto.
      </p>
      <div className="cmp-modal__actions">
        <SceneButton mode={mode} variant="default" className="secondary-button" onClick={onClose}>
          Cancelar
        </SceneButton>
        <SceneButton mode={mode} variant="primary" className="primary-button" onClick={onConfirm}>
          Restablecer
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className="cmp-modal-layer p6-reset">
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          className={`cmp-modal ${motionSurfaceClass(presence.phase, 'modal')}`}
          role="dialog"
          aria-modal="true"
          aria-label="Restablecer ajustes"
        >
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-modal-layer p6-reset">
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmp-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
            exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
            onClick={onClose}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmp-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Restablecer ajustes"
            initial={{
              opacity: 0,
              scale: reduce ? 1 : motionTokens.scale.dialog,
              y: reduce ? 0 : motionTokens.travel(6),
            }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: reduce ? motionTokens.tweens.fade : motionTokens.springs.dialog,
            }}
            exit={{
              opacity: 0,
              scale: reduce ? 1 : motionTokens.scale.dialog,
              y: reduce ? 0 : motionTokens.travel(6),
              transition: motionTokens.tweens.dismiss,
            }}
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SettingsTabBar({
  mode,
  tab,
  onSelect,
}: {
  mode: CompareVariant;
  tab: SettingsTabId;
  onSelect: (next: SettingsTabId) => void;
}) {
  const motionTokens = useLabMotion();
  return (
    <div className="cmp-tabs" role="tablist" aria-label="Ajustes del agente">
      {SETTINGS_TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={`cmp-tabs__tab${tab === item.id ? ' is-active' : ''}`}
          onClick={() => onSelect(item.id)}
        >
          {mode === 'animate' && tab === item.id && (
            <motion.span
              layoutId="cmp-settings-indicator"
              className="cmp-tabs__indicator"
              initial={false}
              transition={motionTokens.springs.selection}
            />
          )}
          <span className="cmp-tabs__label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function UnsavedBanner({
  mode,
  onSave,
  onDiscard,
}: {
  mode: CompareVariant;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  const inner = (
    <div className="p6-banner__inner">
      <div className="p6-banner__text">
        <strong>Tenés cambios sin guardar.</strong>
        <span>Se aplican al workspace cuando guardás.</span>
      </div>
      <div className="p6-banner__actions">
        <SceneButton mode={mode} variant="default" className="cmp-btn--sm secondary-button" onClick={onDiscard}>
          Descartar
        </SceneButton>
        <SceneButton mode={mode} variant="primary" className="cmp-btn--sm primary-button" onClick={onSave}>
          Guardar
        </SceneButton>
      </div>
    </div>
  );

  if (mode === 'kite') {
    return <div className="p6-banner motion-row-in">{inner}</div>;
  }

  return (
    <motion.div
      className="p6-banner"
      initial={{ height: 0, opacity: 0, y: reduce ? 0 : -4 }}
      animate={{ height: 'auto', opacity: 1, y: 0, transition: motionTokens.tweens.disclosure }}
      exit={{ height: 0, opacity: 0, transition: motionTokens.tweens.panelOut }}
      style={{ overflow: 'hidden' }}
    >
      {inner}
    </motion.div>
  );
}

function SettingsPane({
  mode,
  tab,
  onSelectTab,
  values,
  handlers,
  openSection,
  onToggleSection,
  save,
  dirty,
  workspaceInvalid,
  workspaceTouched,
  resetOpen,
  operatorConfig,
  testingProvider,
  savedToast,
  onRunProbe,
  onSave,
  onOpenReset,
  onCloseReset,
  onConfirmReset,
  onDiscard,
}: {
  mode: CompareVariant;
  tab: SettingsTabId;
  onSelectTab: (next: SettingsTabId) => void;
  values: SettingsValues;
  handlers: SettingsHandlers;
  openSection: string | null;
  onToggleSection: (id: string) => void;
  save: 'idle' | 'saving' | 'saved';
  dirty: boolean;
  workspaceInvalid: string | null;
  workspaceTouched: boolean;
  resetOpen: boolean;
  operatorConfig: OperatorConfig;
  testingProvider: OperatorProviderId | null;
  savedToast: boolean;
  onRunProbe: (providerId: OperatorProviderId) => void;
  onSave: () => void;
  onOpenReset: () => void;
  onCloseReset: () => void;
  onConfirmReset: () => void;
  onDiscard: () => void;
}) {
  const motionTokens = useLabMotion();
  const saveLabel =
    save === 'saving' ? 'Guardando…' : save === 'saved' ? 'Guardado' : 'Guardar cambios';

  return (
    <div className={`cmp-settings p6-mode p6-mode--${mode}`}>
      <header className="cmp-card__head">
        <div>
          <strong>Ajustes del agente</strong>
          <span>configuración local y operador</span>
        </div>
        <span className="cmp-badge">agent</span>
      </header>

      <SettingsTabBar mode={mode} tab={tab} onSelect={onSelectTab} />

      <div className="cmp-settings__panel-wrap">
        {mode === 'animate' ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              className="cmp-settings__panel"
              initial={{
                opacity: 0,
                x: motionTokens.travel(motionTokens.shift.tabs),
                filter: motionTokens.blur.panel,
              }}
              animate={{
                opacity: 1,
                x: 0,
                filter: 'blur(0px)',
                transition: motionTokens.tweens.panelIn,
              }}
              exit={{
                opacity: 0,
                x: -motionTokens.travel(motionTokens.shift.tabs),
                filter: motionTokens.blur.panel,
                transition: motionTokens.tweens.panelOut,
              }}
            >
              <SettingsBody
                mode={mode}
                tab={tab}
                values={values}
                handlers={handlers}
                openSection={openSection}
                onToggleSection={onToggleSection}
                workspaceInvalid={workspaceInvalid}
                workspaceTouched={workspaceTouched}
                operatorConfig={operatorConfig}
                testingProvider={testingProvider}
                savedToast={savedToast}
                onRunProbe={onRunProbe}
              />
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="cmp-settings__panel">
            <SettingsBody
              mode={mode}
              tab={tab}
              values={values}
              handlers={handlers}
              openSection={openSection}
              onToggleSection={onToggleSection}
              workspaceInvalid={workspaceInvalid}
              workspaceTouched={workspaceTouched}
              operatorConfig={operatorConfig}
              testingProvider={testingProvider}
              savedToast={savedToast}
              onRunProbe={onRunProbe}
            />
          </div>
        )}
      </div>

      {mode === 'animate' ? (
        <AnimatePresence initial={false}>
          {dirty && save === 'idle' && (
            <UnsavedBanner
              key="banner"
              mode={mode}
              onSave={onSave}
              onDiscard={onDiscard}
            />
          )}
        </AnimatePresence>
      ) : (
        dirty && save === 'idle' && <UnsavedBanner mode={mode} onSave={onSave} onDiscard={onDiscard} />
      )}

      <footer className="cmp-card__foot">
        <SceneButton mode={mode} variant="default" className="secondary-button" onClick={onOpenReset} disabled={!dirty}>
          Restablecer
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="primary"
          className="primary-button"
          onClick={onSave}
          disabled={save === 'saving' || !dirty}
        >
          {mode === 'animate' ? (
            <SwapLabel
              value={saveLabel}
              labels={['Guardar cambios', 'Guardando…', 'Guardado']}
            />
          ) : (
            saveLabel
          )}
        </SceneButton>
      </footer>

      <ResetDialog
        mode={mode}
        open={resetOpen}
        onClose={onCloseReset}
        onConfirm={onConfirmReset}
      />
    </div>
  );
}

export function SettingsScene({ view }: { view: CompareView }) {
  const [tab, setTab] = useState<SettingsTabId>('general');
  const [values, setValues] = useState<SettingsValues>(DEFAULT_SETTINGS);
  const [baseline, setBaseline] = useState<SettingsValues>(DEFAULT_SETTINGS);
  const [touched, setTouched] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [resetOpen, setResetOpen] = useState(false);
  const [operatorConfig, _setOperatorConfig] = useState<OperatorConfig>(DEFAULT_OPERATOR_CONFIG);
  const [testingProvider, setTestingProvider] = useState<OperatorProviderId | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);
  const invalidName = workspaceError(values.workspace);

  const update = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handlers: SettingsHandlers = {
    onStreaming: () => update('streaming', !values.streaming),
    onRemember: () => update('remember', !values.remember),
    onApproval: (next) => update('approval', next),
    onLanguage: (next) => update('language', next),
    onModel: (next) => update('model', next),
    onTemperature: (next) => update('temperature', next),
    onWorkspace: (next) => update('workspace', next),
    onTouchWorkspace: () => setTouched(true),
  };

  const handleRunProbe = (providerId: OperatorProviderId) => {
    setTestingProvider(providerId);
    timers.current.push(
      window.setTimeout(() => {
        setTestingProvider(null);
        setSavedToast(true);
        timers.current.push(window.setTimeout(() => setSavedToast(false), 2000));
      }, 1200)
    );
  };

  const saveSettings = () => {
    if (save === 'saving') return;
    if (invalidName) {
      setTouched(true);
      return;
    }
    setSave('saving');
    timers.current.push(
      window.setTimeout(() => {
        setBaseline(values);
        setSave('saved');
        timers.current.push(window.setTimeout(() => setSave('idle'), 1500));
      }, 950)
    );
  };

  const resetSettings = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    setValues(DEFAULT_SETTINGS);
    setBaseline(DEFAULT_SETTINGS);
    setTouched(false);
    setSave('idle');
    setResetOpen(false);
  };

  return (
    <CompareScene
      index="02"
      title="Ajustes completos"
      target="SettingsView · AgentSettingsTab"
      note="La misma tarjeta con tabs, switch, segmented controls, fields, validación, ZedHeroCard con orbe de 64px y BorderBeam, y diálogo de reset."
      view={view}
    >
      {(mode) => (
        <SettingsPane
          mode={mode}
          tab={tab}
          onSelectTab={setTab}
          values={values}
          handlers={handlers}
          openSection={openSection}
          onToggleSection={(id) =>
            setOpenSection((current) => (current === id ? null : id))
          }
          save={save}
          dirty={dirty}
          workspaceInvalid={invalidName}
          workspaceTouched={touched}
          resetOpen={resetOpen}
          operatorConfig={operatorConfig}
          testingProvider={testingProvider}
          savedToast={savedToast}
          onRunProbe={handleRunProbe}
          onSave={saveSettings}
          onOpenReset={() => setResetOpen(true)}
          onCloseReset={() => setResetOpen(false)}
          onConfirmReset={resetSettings}
          onDiscard={() => {
            setValues(baseline);
            setTouched(false);
          }}
        />
      )}
    </CompareScene>
  );
}
