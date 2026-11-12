import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useSpring } from 'motion/react';
import { LabReduceContext, useLabMotion, useLabReduce } from '../../context';
import { SceneButton } from '../../frame';
import { Checklist, springOptions, type CheckItem } from './shared';

function CountValue({ value, reduce }: { value: number; reduce: boolean }) {
  const tokens = useLabMotion();
  const spring = useSpring(value, springOptions(tokens.springs.number));
  const [shown, setShown] = useState(value);

  useEffect(() => spring.on('change', (latest) => setShown(Math.round(latest))), [spring]);

  useEffect(() => {
    if (reduce) {
      spring.jump(value);
      return;
    }
    spring.set(value);
  }, [reduce, spring, value]);

  return <span className="p9-count__value">{shown}</span>;
}

function ReducedDemo({
  reduced,
  open,
  count,
  onToggle,
  onCount,
}: {
  reduced: boolean;
  open: boolean;
  count: number;
  onToggle: () => void;
  onCount: () => void;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className={`p9-reduced${reduced ? ' is-reduced' : ''}`}>
      <div className="p9-reduced__bar">
        <SceneButton
          mode="animate"
          variant="ghost"
          className="cmp-chip"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? 'Ocultar superficie' : 'Mostrar superficie'}
        </SceneButton>
        <button type="button" className="cmp-btn cmp-btn--sm" onClick={onCount}>
          Sumar 20
        </button>
      </div>

      <div className="p9-reduced__stage">
        <AnimatePresence>
          {open && (
            <motion.div
              className="p9-surface"
              initial={{
                opacity: 0,
                transform: reduce
                  ? 'none'
                  : `translateY(${-tokens.travel(12)}px) scale(${tokens.scale.toast})`,
                filter: tokens.surfaceBlur,
              }}
              animate={{ opacity: 1, transform: 'none', filter: 'blur(0px)' }}
              exit={{
                opacity: 0,
                transform: reduce
                  ? 'none'
                  : `translateY(${-tokens.travel(8)}px) scale(${tokens.scale.toast})`,
                filter: tokens.surfaceBlur,
                transition: tokens.tweens.dismiss,
              }}
              transition={reduce ? tokens.tweens.fade : tokens.springs.toast}
            >
              <div className="p9-surface__head">
                <strong>Uso del plan</strong>
                <span>{reduced ? 'reduce = true' : 'reduce = false'}</span>
              </div>
              <div className="p9-surface__row">
                <span className="p9-count">
                  <CountValue value={count} reduce={reduce} />
                  <small>créditos</small>
                </span>
                <span className="p9-surface__of">de 200</span>
              </div>
              <div className="cmp-meter">
                <div
                  className="cmp-meter__fill"
                  style={{ width: `${Math.min(100, Math.round(count / 2))}%` }}
                />
              </div>
              <div className="p9-loop">
                <span
                  className={`p9-spinner${reduced ? ' is-paused' : ''}`}
                  aria-hidden="true"
                />
                <span>{reduced ? 'Loop en pausa' : 'Sincronizando'}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <footer className="p9-reduced__foot">
        <code>transform: {reduced ? 'none' : 'translateY + scale'}</code>
        <code>opacity: fade</code>
        <code>filter: blur → 0</code>
        <code>
          {reduced ? 'transition.fade · transition.dismiss' : 'spring.toast · transition.dismiss'}
        </code>
      </footer>
    </div>
  );
}

const CHECKS: CheckItem[] = [
  {
    label: 'Transforms fuera',
    detail: 'La columna reducida no se desplaza ni escala; la normal sí.',
    status: 'pass',
  },
  {
    label: 'Fades y blur se quedan',
    detail: 'Ambas columnas aparecen y desaparecen con opacity y filter.',
    status: 'pass',
  },
  {
    label: 'Números de inmediato',
    detail: 'La columna reducida muestra el valor final sin rodar.',
    status: 'pass',
  },
  {
    label: 'Bucles en pausa',
    detail: 'El spinner reducido queda detenido; no hay animación infinita.',
    status: 'pass',
  },
  {
    label: 'Foco visible',
    detail: 'El anillo de foco aparece en el mismo frame y no se anima.',
    status: 'pass',
  },
];

export function ReducedMotionSection() {
  const [open, setOpen] = useState(true);
  const [count, setCount] = useState(128);

  const toggle = () => setOpen((value) => !value);
  const add = () => setCount((value) => Math.min(200, value + 20));

  return (
    <section className="cmp-scene" data-page="09">
      <header className="cmp-scene__head">
        <span className="cmp-scene__index">09.3</span>
        <div className="cmp-scene__copy">
          <h2>Reduced motion</h2>
          <p>
            Las dos columnas fijan su propio <code>reduce</code> para comparar los dos
            comportamientos a la vez. El toggle global sigue gobernando el resto de la página.
          </p>
        </div>
        <span className="cmp-scene__target">useLabReduce()</span>
      </header>

      <p className="p9-lede">
        La columna normal usa un <code>transform</code> string. Motion no lo omite solo: por eso
        la columna reducida lo neutraliza con <code>useLabReduce()</code>. El movimiento
        desaparece; la opacidad y el blur se quedan.
      </p>

      <div className="cmp-grid cmp-grid--split">
        <div className="cmp-pane">
          <div className="cmp-pane__head">
            <span className="cmp-pane__dot p9-dot--normal" />
            <span className="cmp-pane__title">Normal</span>
            <span className="cmp-pane__meta">reduce = false · transform + fade + blur</span>
          </div>
          <LabReduceContext.Provider value={false}>
            <ReducedDemo
              reduced={false}
              open={open}
              count={count}
              onToggle={toggle}
              onCount={add}
            />
          </LabReduceContext.Provider>
        </div>

        <div className="cmp-pane">
          <div className="cmp-pane__head">
            <span className="cmp-pane__dot p9-dot--reduced" />
            <span className="cmp-pane__title">Reducido</span>
            <span className="cmp-pane__meta">reduce = true · fade + blur</span>
          </div>
          <LabReduceContext.Provider value>
            <ReducedDemo
              reduced
              open={open}
              count={count}
              onToggle={toggle}
              onCount={add}
            />
          </LabReduceContext.Provider>
        </div>
      </div>

      <Checklist title="Checklist de reduced motion" items={CHECKS} />
    </section>
  );
}
