import { useEffect, useState } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';

/* -------------------------------------------------------------------------- */
/* Scene 4 — Numbers: counting, sliding, scrolling, delta badge               */
/* -------------------------------------------------------------------------- */

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const WHEEL = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const DIGIT_HEIGHT = 26;
const START_VALUE = 1284;
const BUDGET = 4096;

function formatValue(value: number): string {
  return Math.round(value).toLocaleString('es-AR');
}

function toneOf(delta: number | null): 'up' | 'down' | 'flat' {
  if (delta === null || delta === 0) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

function deltaLabel(delta: number | null): string {
  if (delta === null || delta === 0) return '—';
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString('es-AR')}`;
}

function CountingValue({ value }: { value: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const counter = useMotionValue(value);
  const text = useTransform(counter, (latest) => formatValue(latest));

  useEffect(() => {
    const controls = animate(
      counter,
      value,
      reduce ? motionTokens.tweens.instant : motionTokens.springs.number
    );
    return () => controls.stop();
  }, [counter, value, reduce, motionTokens]);

  return <motion.span className="p4-num__value">{text}</motion.span>;
}

function SlidingValue({ mode, value }: { mode: CompareVariant; value: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const text = formatValue(value);

  return (
    <span className="p4-num">
      <span className="p4-sr">{text}</span>
      <span className="p4-digits" aria-hidden="true">
        {Array.from(text).map((char, index) => {
          const digit = Number(char);
          if (Number.isNaN(digit)) {
            return (
              <span key={`sep-${index}`} className="p4-digit__sep">
                {char}
              </span>
            );
          }
          return (
            <span key={`digit-${index}`} className="p4-digit">
              {mode === 'animate' ? (
                <motion.span
                  className="p4-digit__strip"
                  initial={false}
                  animate={{ y: -digit * DIGIT_HEIGHT }}
                  transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.number}
                >
                  {DIGITS.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </motion.span>
              ) : (
                <span
                  className="p4-digit__strip p4-digit__strip--css"
                  style={{ transform: `translateY(${-digit * DIGIT_HEIGHT}px)` }}
                >
                  {DIGITS.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}

function ScrollingValue({ mode, percent }: { mode: CompareVariant; percent: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const index = Math.max(0, WHEEL.indexOf(Math.round(percent / 10) * 10));

  return (
    <span className="p4-wheel">
      <span className="p4-sr">{percent}%</span>
      {mode === 'animate' ? (
        <motion.span
          className="p4-wheel__track"
          aria-hidden="true"
          initial={false}
          animate={{ y: -index * DIGIT_HEIGHT }}
          transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.number}
        >
          {WHEEL.map((item) => (
            <span key={item}>{item}%</span>
          ))}
        </motion.span>
      ) : (
        <span
          className="p4-wheel__track p4-wheel__track--css"
          aria-hidden="true"
          style={{ transform: `translateY(${-index * DIGIT_HEIGHT}px)` }}
        >
          {WHEEL.map((item) => (
            <span key={item}>{item}%</span>
          ))}
        </span>
      )}
    </span>
  );
}

function DeltaBadge({ mode, delta, seq }: { mode: CompareVariant; delta: number | null; seq: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const tone = toneOf(delta);

  if (mode === 'animate') {
    return (
      <motion.span
        key={seq}
        className={`p4-delta p4-delta--${tone}`}
        initial={reduce ? false : { scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={motionTokens.springs.pop}
      >
        {deltaLabel(delta)}
      </motion.span>
    );
  }

  return (
    <span key={seq} className={`p4-delta p4-delta--${tone} p4-bump`}>
      {deltaLabel(delta)}
    </span>
  );
}

export function NumbersScene({ view }: { view: CompareView }) {
  const [value, setValue] = useState(START_VALUE);
  const [delta, setDelta] = useState<number | null>(null);
  const [seq, setSeq] = useState(0);

  const change = (amount: number) => {
    const next = Math.max(0, value + amount);
    setDelta(next - value);
    setValue(next);
    setSeq((current) => current + 1);
  };

  const reset = () => {
    setDelta(null);
    setValue(START_VALUE);
    setSeq((current) => current + 1);
  };

  const tickets = Math.max(0, 5000 - value);
  const percent = Math.min(100, Math.round((value / BUDGET) * 100));

  return (
    <CompareScene
      index="04"
      title="Números que se mueven"
      target="CountingNumber · SlidingNumber · ScrollingNumber · DeltaBadge"
      note="Cambiá el valor con los tres disparadores. Kite reemplaza el número; Animate UI cuenta sobre spring.number, rueda los dígitos y la rueda de porcentaje, y el badge de variación hace un pop."
      view={view}
    >
      {(mode) => (
        <div className="p4-numbers" data-engine={mode}>
          <div className="p4-numgrid">
            <div className="p4-numtile">
              <span className="p4-label">Tokens usados</span>
              {mode === 'animate' ? (
                <CountingValue value={value} />
              ) : (
                <span key={value} className="p4-num__value p4-value-in">
                  {formatValue(value)}
                </span>
              )}
              <span className="p4-hint">de {formatValue(BUDGET)} disponibles</span>
            </div>

            <div className="p4-numtile">
              <span className="p4-label">Tickets restantes</span>
              <SlidingValue mode={mode} value={tickets} />
              <span className="p4-hint">de 5.000 del plan</span>
            </div>

            <div className="p4-numtile">
              <span className="p4-label">Contexto usado</span>
              <span className="p4-num">
                <ScrollingValue mode={mode} percent={percent} />
              </span>
              <span className="p4-hint">de {formatValue(BUDGET)} tokens</span>
            </div>

            <div className="p4-numtile">
              <span className="p4-label">Última variación</span>
              <span className="p4-delta-line">
                <DeltaBadge mode={mode} delta={delta} seq={seq} />
                <span className="p4-hint">sobre el total</span>
              </span>
              <span className="p4-hint">se dispara con cada cambio</span>
            </div>
          </div>

          <div className="p4-numactions">
            <SceneButton mode={mode} variant="primary" className="cmp-btn--sm" onClick={() => change(1000)}>
              Sumar 1.000
            </SceneButton>
            <SceneButton mode={mode} className="cmp-btn--sm" onClick={() => change(-320)}>
              Restar 320
            </SceneButton>
            <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={reset}>
              Reiniciar
            </SceneButton>
            <span className="p4-hint p4-numactions__note">
              {formatValue(value)} tokens · {formatValue(tickets)} tickets
            </span>
          </div>
        </div>
      )}
    </CompareScene>
  );
}
