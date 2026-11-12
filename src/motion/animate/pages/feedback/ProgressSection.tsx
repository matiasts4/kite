import { useEffect, useRef, useState } from 'react';
import { animate, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';

/* -------------------------------------------------------------------------- */
/* Scene 3 — Progress                                                         */
/* -------------------------------------------------------------------------- */

function AnimatedCounter({ value }: { value: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const [display, setDisplay] = useState(value);
  const current = useRef(value);

  useEffect(() => {
    if (reduce) {
      current.current = value;
      setDisplay(value);
      return undefined;
    }
    if (current.current === value) return undefined;
    const controls = animate(current.current, value, {
      ...motionTokens.springs.number,
      onUpdate: (latest: number) => {
        const next = Math.round(latest);
        current.current = next;
        setDisplay(next);
      },
      onComplete: () => {
        current.current = value;
        setDisplay(value);
      },
    });
    return () => controls.stop();
  }, [value, reduce, motionTokens]);

  return <span className="p3-counter__value">{display.toLocaleString('es-AR')}</span>;
}

function ProgressColumn({
  mode,
  value,
  indeterminate,
  onValue,
  onToggleIndeterminate,
}: {
  mode: CompareVariant;
  value: number;
  indeterminate: boolean;
  onValue: (next: number) => void;
  onToggleIndeterminate: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  const tickets = 240 + value * 10;

  return (
    <div className="p3-pane" data-mode={mode}>
      <div className="p3-panel">
        <div className="p3-panel__head">
          <strong>Sincronización del workspace</strong>
          <span className="cmp-badge">{value}%</span>
        </div>

        <div className="p3-progress-top">
          <div className="p3-ring">
            <svg
              viewBox="0 0 88 88"
              role="img"
              aria-label={`Progreso de sincronización: ${value} por ciento`}
            >
              <circle className="p3-ring__track" cx="44" cy="44" r={radius} />
              {mode === 'kite' ? (
                <circle
                  className="p3-ring__value"
                  cx="44"
                  cy="44"
                  r={radius}
                  strokeDasharray={circumference}
                  style={{ strokeDashoffset: offset }}
                />
              ) : (
                <motion.circle
                  className="p3-ring__value"
                  cx="44"
                  cy="44"
                  r={radius}
                  strokeDasharray={circumference}
                  initial={false}
                  animate={{ strokeDashoffset: offset }}
                  transition={reduce ? { duration: 0 } : motionTokens.springs.number}
                />
              )}
            </svg>
            <span className="p3-ring__label" aria-hidden="true">
              {value}%
            </span>
          </div>

          <div className="p3-progress-side">
            <div
              className="cmp-meter p3-track"
              role="progressbar"
              aria-label="Progreso de sincronización"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={value}
            >
              {mode === 'kite' ? (
                <span
                  className="cmp-meter__fill p3-fill p3-fill--kite"
                  style={{ width: `${value}%` }}
                />
              ) : reduce ? (
                <span
                  className="cmp-meter__fill p3-fill"
                  style={{ width: `${value}%` }}
                />
              ) : (
                <motion.span
                  className="cmp-meter__fill p3-fill"
                  initial={false}
                  animate={{ scaleX: value / 100 }}
                  transition={motionTokens.springs.number}
                  style={{ transformOrigin: 'left center' }}
                />
              )}
            </div>

            <div className="p3-counter">
              <span className="p3-counter__label">Tickets usados</span>
              {mode === 'animate' ? (
                <AnimatedCounter value={tickets} />
              ) : (
                <span className="p3-counter__value">
                  {tickets.toLocaleString('es-AR')}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="p3-controls">
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={() => onValue(Math.max(0, value - 10))}
          >
            −10
          </SceneButton>
          <input
            className="p3-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            onChange={(event) => onValue(Number(event.target.value))}
            aria-label="Progreso de sincronización"
          />
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={() => onValue(Math.min(100, value + 10))}
          >
            +10
          </SceneButton>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            onClick={() => onValue(0)}
          >
            Reiniciar
          </SceneButton>
        </div>
        <p className="p3-hint">
          El rango responde a las flechas del teclado; la barra, el anillo y el contador leen el
          mismo valor.
        </p>
      </div>

      <div className="p3-panel">
        <div className="p3-panel__head">
          <strong>Subida en curso</strong>
          <SceneButton
            mode={mode}
            variant={indeterminate ? 'ghost' : 'primary'}
            className="cmp-btn--sm"
            onClick={onToggleIndeterminate}
            aria-pressed={indeterminate}
          >
            {indeterminate ? 'Detener' : 'Iniciar subida'}
          </SceneButton>
        </div>

        <div
          className="cmp-meter p3-track"
          role="progressbar"
          aria-label="Subida de archivo"
          aria-valuetext={indeterminate ? 'Subiendo' : 'En pausa'}
          aria-busy={indeterminate}
        >
          {indeterminate &&
            (mode === 'kite' && !reduce ? (
              <span className="p3-indeterminate p3-indeterminate--css" />
            ) : mode === 'animate' && !reduce ? (
              <motion.span
                className="p3-indeterminate"
                initial={false}
                animate={{ x: ['-120%', '320%'] }}
                transition={{ duration: 1.15, ease: 'linear', repeat: Infinity }}
              />
            ) : (
              <span className="p3-indeterminate is-static" />
            ))}
        </div>
        <p className="p3-hint">
          Sin valor conocido: Kite usa una animación CSS lineal; Animate UI mueve el mismo bloque
          con un loop de Motion y lo congela con reduced motion.
        </p>
      </div>
    </div>
  );
}

export function ProgressSection({ view }: { view: CompareView }) {
  const [value, setValue] = useState(42);
  const [indeterminate, setIndeterminate] = useState(false);

  return (
    <CompareScene
      index="3.3"
      title="Progreso"
      target="ProgressBar · ProgressRing · Counter"
      note="Un valor compartido mueve la barra determinada, el anillo y el contador de tickets. Kite transiciona ancho y stroke con CSS; Animate UI lleva ambos con spring.number y hace rodar el número. La subida indeterminada usa un loop lineal que se detiene con reduced motion."
      view={view}
    >
      {(mode) => (
        <ProgressColumn
          mode={mode}
          value={value}
          indeterminate={indeterminate}
          onValue={setValue}
          onToggleIndeterminate={() => setIndeterminate((current) => !current)}
        />
      )}
    </CompareScene>
  );
}

export { ProgressSection as ProgressScene };
