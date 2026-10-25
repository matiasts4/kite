import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  SceneSwitch,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { P7Checkbox, P7ContextReadout } from './parts';

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

type PlaygroundTab = 'general' | 'advanced' | 'log';

const TABS: { id: PlaygroundTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'advanced', label: 'Avanzado' },
  { id: 'log', label: 'Registro' },
];

const TAB_CONTENT: Record<PlaygroundTab, { title: string; lines: [string, string][] }> = {
  general: {
    title: 'Los cambios se aplican al hilo activo sin cortar el transcript.',
    lines: [
      ['Modelo', 'Kite 2 · Opus'],
      ['Contexto', '72% libre'],
    ],
  },
  advanced: {
    title: 'Ajustes de ejecución que no interrumpen la conversación.',
    lines: [
      ['Temperatura', '0.4'],
      ['Paralelismo', '2 hilos'],
    ],
  },
  log: {
    title: 'Las últimas acciones del agente en este workspace.',
    lines: [
      ['09:12', 'agente iniciado'],
      ['09:13', 'contexto cargado'],
      ['09:14', 'esperando entrada'],
    ],
  },
};

function usePlaygroundDemo() {
  const [count, setCount] = useState(0);
  const [countDir, setCountDir] = useState<1 | -1>(1);
  const [checks, setChecks] = useState({ autoSave: true, telemetry: false });
  const [streaming, setStreaming] = useState(true);
  const [tab, setTab] = useState<PlaygroundTab>('general');

  const bump = (delta: 1 | -1) => {
    setCountDir(delta);
    setCount((value) => Math.min(99, Math.max(0, value + delta)));
  };

  const toggleCheck = (id: 'autoSave' | 'telemetry') => {
    setChecks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const reset = () => {
    setCountDir(-1);
    setCount(0);
    setChecks({ autoSave: true, telemetry: false });
    setStreaming(true);
    setTab('general');
  };

  return {
    count,
    countDir,
    bump,
    checks,
    toggleCheck,
    streaming,
    setStreaming,
    tab,
    setTab,
    reset,
  };
}

type PlaygroundDemo = ReturnType<typeof usePlaygroundDemo>;

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function CounterValue({ mode, value, dir }: { mode: CompareVariant; value: number; dir: 1 | -1 }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const digits = String(value).padStart(2, '0');
  const variants = {
    enter: (direction: number) => ({
      opacity: 0,
      y: reduce ? 0 : direction * motionTokens.travel(8),
      filter: motionTokens.swapBlur,
    }),
    center: {
      opacity: 1,
      y: 0,
      filter: 'blur(0px)',
      transition: motionTokens.tweens.swap,
    },
    exit: (direction: number) => ({
      opacity: 0,
      y: reduce ? 0 : -direction * motionTokens.travel(8),
      filter: motionTokens.swapBlur,
      transition: motionTokens.tweens.swap,
    }),
  };

  return (
    <>
      <span className="p7-count" aria-hidden="true">
        <span className="p7-count__ghost">00</span>
        {mode === 'animate' ? (
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.span
              key={value}
              className="p7-count__live"
              custom={dir}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {digits}
            </motion.span>
          </AnimatePresence>
        ) : (
          <span key={value} className="p7-count__live motion-row-in">
            {digits}
          </span>
        )}
      </span>
      <span className="p7-sr" role="status" aria-live="polite">
        {value} tickets en cola
      </span>
    </>
  );
}

function TabsPanel({ mode, tab }: { mode: CompareVariant; tab: PlaygroundTab }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const content = TAB_CONTENT[tab];

  const body = (
    <>
      <p>{content.title}</p>
      {content.lines.map(([label, value]) => (
        <div className="p7-play__line" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </>
  );

  if (mode === 'animate') {
    return (
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          role="tabpanel"
          aria-labelledby={`p7-tab-${mode}-${tab}`}
          tabIndex={0}
          className="p7-play__panel"
          initial={{
            opacity: 0,
            x: reduce ? 0 : motionTokens.shift.tabs,
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
            x: reduce ? 0 : -motionTokens.shift.tabs,
            filter: motionTokens.blur.panel,
            transition: motionTokens.tweens.panelOut,
          }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
    );
  }

  return (
    <div
      key={tab}
      role="tabpanel"
      aria-labelledby={`p7-tab-${mode}-${tab}`}
      tabIndex={0}
      className="p7-play__panel motion-panel-in"
    >
      {body}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pane                                                                       */
/* -------------------------------------------------------------------------- */

function PlaygroundPane({ mode, demo }: { mode: CompareVariant; demo: PlaygroundDemo }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const tabRefs = useRef<Record<PlaygroundTab, HTMLButtonElement | null>>({
    general: null,
    advanced: null,
    log: null,
  });
  const activeIndex = TABS.findIndex((item) => item.id === demo.tab);

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (activeIndex + delta + TABS.length) % TABS.length;
    const nextId = TABS[nextIndex].id;
    demo.setTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  return (
    <div className="p7-play">
      <header className="cmp-card__head">
        <div>
          <strong>Playground de primitivas</strong>
          <span>controles aislados · un solo estado</span>
        </div>
        <span className="cmp-badge">primitivas</span>
      </header>

      <div className="p7-play__body">
        <P7ContextReadout />

        <div className="p7-play__grid">
          <div className="p7-play__col">
            <section className="p7-block">
              <span className="p7-block__title">Botones</span>
              <div className="p7-buttons">
                <SceneButton
                  mode={mode}
                  variant="primary"
                  className="cmp-btn--sm"
                  onClick={() => demo.bump(1)}
                  disabled={demo.count >= 99}
                >
                  Sumar ticket
                </SceneButton>
                <SceneButton
                  mode={mode}
                  className="cmp-btn--sm"
                  onClick={() => demo.bump(-1)}
                  disabled={demo.count === 0}
                >
                  Restar
                </SceneButton>
                <SceneButton
                  mode={mode}
                  variant="ghost"
                  className="cmp-btn--sm"
                  onClick={demo.reset}
                >
                  Reiniciar
                </SceneButton>
              </div>
              <span className="p7-hint">Presión de 0.97 en Animate UI; fondo en Kite.</span>
            </section>

            <section className="p7-block">
              <span className="p7-block__title">Controles</span>
              <div className="p7-check-list">
                <P7Checkbox
                  mode={mode}
                  checked={demo.checks.autoSave}
                  onChange={() => demo.toggleCheck('autoSave')}
                  label="Auto-guardado"
                  hint="Guarda el hilo sin bloquear el cuadro de mensaje."
                />
                <P7Checkbox
                  mode={mode}
                  checked={demo.checks.telemetry}
                  onChange={() => demo.toggleCheck('telemetry')}
                  label="Telemetría"
                  hint="Métricas anónimas de duración y errores."
                />
              </div>
              <div className="p7-switch-row">
                <div className="p7-switch-row__text">
                  <strong>Streaming</strong>
                  <span>Mostrar los tokens a medida que llegan.</span>
                </div>
                <SceneSwitch
                  mode={mode}
                  checked={demo.streaming}
                  onChange={() => demo.setStreaming((value) => !value)}
                />
              </div>
            </section>
          </div>

          <div className="p7-play__col">
            <section className="p7-counter">
              <span className="p7-counter__label">Tickets en cola</span>
              <CounterValue mode={mode} value={demo.count} dir={demo.countDir} />
              <span className="p7-counter__hint">spring.number · swap</span>
              <div className="p7-counter__track" aria-hidden="true">
                {mode === 'animate' && !reduce ? (
                  <motion.span
                    className="p7-counter__fill"
                    initial={false}
                    animate={{ scaleX: demo.count / 99 }}
                    transition={motionTokens.springs.number}
                    style={{ width: '100%', transformOrigin: 'left center' }}
                  />
                ) : (
                  <span
                    className="p7-counter__fill"
                    style={{ width: `${(demo.count / 99) * 100}%` }}
                  />
                )}
              </div>
            </section>
          </div>
        </div>

        <section className="p7-block p7-block--tabs">
          <div className="cmp-tabs" role="tablist" aria-label="Panel de primitivas">
            {TABS.map((item) => {
              const active = demo.tab === item.id;
              return (
                <button
                  key={item.id}
                  id={`p7-tab-${mode}-${item.id}`}
                  ref={(element) => {
                    tabRefs.current[item.id] = element;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={`cmp-tabs__tab${active ? ' is-active' : ''}`}
                  onClick={() => demo.setTab(item.id)}
                  onKeyDown={onTabKeyDown}
                >
                  {mode === 'animate' && active ? (
                    <motion.span
                      layoutId="p7-play-tab"
                      className="cmp-tabs__indicator"
                      initial={false}
                      transition={motionTokens.springs.selection}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="cmp-tabs__label">{item.label}</span>
                </button>
              );
            })}
          </div>
          <div className="p7-play__panel-wrap">
            <TabsPanel mode={mode} tab={demo.tab} />
          </div>
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

export function PlaygroundScene({ view }: { view: CompareView }) {
  const demo = usePlaygroundDemo();

  return (
    <CompareScene
      index="07"
      title="Playground de primitivas"
      target="Button · Checkbox · Switch · Tabs · Counter"
      note="Un contador y cinco primitivas aisladas comparten el mismo estado. El nivel y el tempo de la barra superior solo mueven la columna Animate UI; reduced motion apaga el movimiento en las dos."
      view={view}
    >
      {(mode) => <PlaygroundPane mode={mode} demo={demo} />}
    </CompareScene>
  );
}
