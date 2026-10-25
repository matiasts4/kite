import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import type { CompareVariant, CompareView } from '../../frame';
import { Checklist, maxBlurPx, type CheckItem, type Modality } from './shared';

const STEPS = 5;
const CHIPS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
const STEP_PX = 44;

const CHECKS: CheckItem[] = [
  {
    label: 'Solo transform, opacity y filter (motion)',
    detail:
      'La marca usa translateX; los chips, opacity y scale; las superficies, filter. Los colores de hover son repaints cortos, no movimiento.',
    status: 'pass',
  },
  {
    label: 'height solo en disclosures',
    detail: 'El único height animado de la página es el demo de transition.disclosure.',
    status: 'pass',
  },
  {
    label: 'Blur ligero',
    detail: 'El token más alto es 6 px; menús y superficies usan 4 px y los paneles 5 px.',
    status: 'pass',
  },
  {
    label: 'Sin layout thrash',
    detail: 'Ningún demo anima width, top, left ni margin.',
    status: 'pass',
  },
  {
    label: 'Propiedades nombradas',
    detail: 'El CSS de la página lista background-color, transform y filter; nunca all.',
    status: 'pass',
  },
  {
    label: 'Re-trigger sin reinicio',
    detail: 'La marca no cambia de key: cada acción retarget desde el valor actual.',
    status: 'pass',
  },
];

function InterruptionColumn({
  mode,
  step,
  onMove,
}: {
  mode: CompareVariant;
  step: number;
  onMove: (next: number, input: Modality) => void;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className="p9-interrupt">
      <div
        className="p9-track"
        role="group"
        aria-label={`Posiciones · ${mode}`}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            onMove(step + (event.key === 'ArrowRight' ? 1 : -1), 'keyboard');
          } else if (event.key === 'Home') {
            event.preventDefault();
            onMove(0, 'keyboard');
          } else if (event.key === 'End') {
            event.preventDefault();
            onMove(STEPS - 1, 'keyboard');
          }
        }}
      >
        {mode === 'animate' ? (
          <motion.span
            className="p9-marker p9-marker--animate"
            aria-hidden="true"
            animate={{ transform: `translateX(${step * STEP_PX}px)` }}
            transition={reduce ? { duration: 0 } : tokens.springs.selection}
          />
        ) : (
          <span
            className="p9-marker p9-marker--kite"
            aria-hidden="true"
            style={{ transform: `translateX(${step * STEP_PX}px)` }}
          />
        )}
        {Array.from({ length: STEPS }, (_, index) => (
          <button
            key={index}
            type="button"
            className={`p9-slot${step === index ? ' is-active' : ''}`}
            aria-pressed={step === index}
            aria-label={`Mover a la posición ${index + 1}`}
            onClick={(event) => onMove(index, event.detail === 0 ? 'keyboard' : 'pointer')}
          >
            {index + 1}
          </button>
        ))}
      </div>
      <span className="p9-interrupt__tokens">
        {mode === 'kite'
          ? 'CSS 180 ms · retarget'
          : `spring.selection · ${
              'stiffness' in tokens.springs.selection
                ? `k ${Math.round(tokens.springs.selection.stiffness)}`
                : 'spring'
            }`}
      </span>
    </div>
  );
}

export function InterruptionSection({ view }: { view: CompareView }) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const [step, setStep] = useState(2);
  const [hits, setHits] = useState(0);
  const [interruptions, setInterruptions] = useState(0);
  const [via, setVia] = useState<Modality>('pointer');
  const [bursting, setBursting] = useState(false);
  const lastAt = useRef(0);
  const burstTimers = useRef<number[]>([]);
  const stressTimers = useRef<number[]>([]);
  const [pressed, setPressed] = useState<boolean[]>(() => CHIPS.map((_, index) => index % 2 === 0));
  const [toggles, setToggles] = useState(0);
  const [spamming, setSpamming] = useState(false);

  const move = (next: number, input: Modality) => {
    const now = performance.now();
    if (lastAt.current > 0 && now - lastAt.current < 380) {
      setInterruptions((value) => value + 1);
    }
    lastAt.current = now;
    setVia(input);
    setStep(((next % STEPS) + STEPS) % STEPS);
    setHits((value) => value + 1);
  };

  const burst = () => {
    if (bursting) return;
    setBursting(true);
    for (let index = 1; index <= 6; index += 1) {
      burstTimers.current.push(
        window.setTimeout(() => move(step + index, 'pointer'), index * 90)
      );
    }
    burstTimers.current.push(
      window.setTimeout(() => {
        burstTimers.current = [];
        setBursting(false);
      }, 6 * 90 + 140)
    );
  };

  const reset = () => {
    burstTimers.current.forEach((timer) => window.clearTimeout(timer));
    burstTimers.current = [];
    setBursting(false);
    setHits(0);
    setInterruptions(0);
    setStep(0);
    lastAt.current = 0;
  };

  const toggle = (index: number) => {
    setPressed((previous) =>
      previous.map((value, position) => (position === index ? !value : value))
    );
    setToggles((value) => value + 1);
  };

  const spam = () => {
    if (spamming) return;
    setSpamming(true);
    for (let index = 0; index < 12; index += 1) {
      stressTimers.current.push(
        window.setTimeout(() => toggle(index % CHIPS.length), index * 55)
      );
    }
    stressTimers.current.push(
      window.setTimeout(() => {
        stressTimers.current = [];
        setSpamming(false);
      }, 12 * 55 + 140)
    );
  };

  useEffect(
    () => () => {
      burstTimers.current.forEach((timer) => window.clearTimeout(timer));
      stressTimers.current.forEach((timer) => window.clearTimeout(timer));
    },
    []
  );

  const maxBlur = maxBlurPx(tokens.blur);
  const checks = CHECKS.map((item) =>
    item.label === 'Blur ligero'
      ? {
          ...item,
          detail: `El token más alto es ${maxBlur} px; menús y superficies usan 4 px y los paneles 5 px.`,
        }
      : item
  );

  return (
    <section className="cmp-scene" data-page="09">
      <header className="cmp-scene__head">
        <span className="cmp-scene__index">09.5</span>
        <div className="cmp-scene__copy">
          <h2>Interrupción, estrés y rendimiento</h2>
          <p>
            Cada acción cambia el target; la marca retoma desde donde está. No se remonta, no
            reinicia y no espera. La fila de estrés existe para comprobarlo a golpes.
          </p>
        </div>
        <span className="cmp-scene__target">retarget · transform / opacity</span>
      </header>

      <div className={`cmp-grid cmp-grid--${view}`}>
        {view !== 'animate' && (
          <div className="cmp-pane">
            <div className="cmp-pane__head">
              <span className="cmp-pane__dot cmp-pane__dot--kite" />
              <span className="cmp-pane__title">Kite hoy</span>
              <span className="cmp-pane__meta">CSS · 180 ms · retarget</span>
            </div>
            <InterruptionColumn mode="kite" step={step} onMove={move} />
          </div>
        )}
        {view !== 'kite' && (
          <div className="cmp-pane">
            <div className="cmp-pane__head">
              <span className="cmp-pane__dot cmp-pane__dot--animate" />
              <span className="cmp-pane__title">Animate UI</span>
              <span className="cmp-pane__meta">spring.selection · retarget</span>
            </div>
            <InterruptionColumn mode="animate" step={step} onMove={move} />
          </div>
        )}
      </div>

      <div className="p9-toolbar">
        <div className="p9-stats">
          <span className="p9-stat">
            <small>Movimientos</small>
            <strong>{hits}</strong>
          </span>
          <span className="p9-stat">
            <small>Interrupciones</small>
            <strong>{interruptions}</strong>
          </span>
          <span className="p9-stat">
            <small>Remontajes</small>
            <strong>0</strong>
          </span>
          <span className="p9-stat">
            <small>Última entrada</small>
            <strong>{via === 'keyboard' ? 'teclado' : 'puntero'}</strong>
          </span>
        </div>
        <div className="p9-toolbar__actions">
          <button type="button" className="cmp-btn cmp-btn--primary" onClick={burst} disabled={bursting}>
            {bursting ? 'Ráfaga…' : 'Ráfaga ×6'}
          </button>
          <button type="button" className="cmp-btn" onClick={reset}>
            Reiniciar
          </button>
        </div>
      </div>

      <div className="p9-stress">
        <header className="p9-stress__head">
          <div>
            <h3>Fila de estrés</h3>
            <span>Spamea los chips o usa Agitar: cada click retarget el spring.</span>
          </div>
          <button type="button" className="cmp-btn cmp-btn--sm" onClick={spam} disabled={spamming}>
            {spamming ? 'Agitando…' : 'Agitar ×12'}
          </button>
        </header>

        <div className="p9-stress__row">
          {CHIPS.map((chip, index) => {
            const on = pressed[index];
            return (
              <motion.button
                key={chip}
                type="button"
                className={`p9-chip${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => toggle(index)}
                whileTap={
                  reduce ? undefined : { transform: `scale(${tokens.scale.press})` }
                }
                transition={tokens.springs.press}
              >
                <motion.span
                  className="p9-chip__dot"
                  aria-hidden="true"
                  animate={{
                    opacity: on ? 1 : 0.25,
                    transform: reduce ? 'none' : on ? 'scale(1)' : 'scale(0.72)',
                  }}
                  transition={tokens.springs.press}
                />
                {chip}
              </motion.button>
            );
          })}
        </div>

        <footer className="p9-stress__foot">
          <span>
            Toggles <strong>{toggles}</strong>
          </span>
          <span>
            <code>spring.press</code> · <code>scale.press</code> · <code>opacity</code>
          </span>
        </footer>
      </div>

      <Checklist title="Checklist de rendimiento" items={checks} />

      <div className="p9-rejected">
        <h3 className="p9-subhead">Rechazado en revisión</h3>
        <ul>
          <li>
            <span className="p9-reject-mark" aria-hidden="true">✕</span>
            Animar <code>width</code>, <code>height</code> fuera de un disclosure,{' '}
            <code>top</code>, <code>left</code> o <code>margin</code>.
          </li>
          <li>
            <span className="p9-reject-mark" aria-hidden="true">✕</span>
            <code>blur(12px)</code> o más en superficies grandes: paint caro, sobre todo en
            Safari.
          </li>
          <li>
            <span className="p9-reject-mark" aria-hidden="true">✕</span>
            <code>transition: all</code>: anima propiedades que nadie pidió.
          </li>
          <li>
            <span className="p9-reject-mark" aria-hidden="true">✕</span>
            Escala en hover sobre un pressable: el hover cambia color, no tamaño.
          </li>
        </ul>
      </div>
    </section>
  );
}
