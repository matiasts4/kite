import { motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import type { CompareVariant } from '../../frame';
import type { LabLevel } from '../../tokens';

const LEVEL_LABELS: Record<LabLevel, string> = {
  subtle: 'Subtle',
  more: 'More',
  expressive: 'Expressive',
};

interface CheckboxProps {
  mode: CompareVariant;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}

/**
 * Page-local checkbox. The native input carries the semantics and the
 * keyboard path; only the box and the check are drawn by the page.
 */
export function P7Checkbox({ mode, checked, onChange, label, hint }: CheckboxProps) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <label className={`p7-check${checked ? ' is-on' : ''}`}>
      <input
        className="p7-check__input"
        type="checkbox"
        checked={checked}
        onChange={onChange}
      />
      <span className="p7-check__box" aria-hidden="true">
        {mode === 'animate' ? (
          <motion.svg
            className="p7-check__check"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <motion.polyline
              points="20 6 9 17 4 12"
              initial={false}
              animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : checked
                    ? motionTokens.tweens.reveal
                    : motionTokens.tweens.swap
              }
            />
          </motion.svg>
        ) : (
          <svg
            className="p7-check__check p7-check__check--kite"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      <span className="p7-check__text">
        <strong>{label}</strong>
        {hint ? <span>{hint}</span> : null}
      </span>
    </label>
  );
}

interface DotsProps {
  mode: CompareVariant;
  count: number;
  active: number;
}

/** Small step markers. Kite grows the width; Animate UI scales on the token. */
export function P7Dots({ mode, count, active }: DotsProps) {
  const motionTokens = useLabMotion();

  return (
    <span className="p7-dots" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => {
        const on = index === active;
        if (mode === 'animate') {
          return (
            <motion.span
              key={index}
              className={`p7-dot${on ? ' is-on' : ''}`}
              initial={false}
              animate={{ scaleX: on ? 1.7 : 1 }}
              transition={motionTokens.springs.selection}
              style={{ transformOrigin: 'left center' }}
            />
          );
        }
        return <span key={index} className={`p7-dot p7-dot--kite${on ? ' is-on' : ''}`} />;
      })}
    </span>
  );
}

/**
 * Read-only view of the page context. The level, tempo and reduced-motion
 * values are changed in the global top bar; the playground only reflects them.
 */
export function P7ContextReadout() {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className="p7-context" aria-label="Contexto de movimiento">
      <span className="p7-context__title">Contexto</span>
      <span className="p7-context__item">
        Nivel <strong>{LEVEL_LABELS[motionTokens.level]}</strong>
      </span>
      <span className="p7-context__item">
        Tempo <strong>×{motionTokens.tempo.toFixed(2)}</strong>
      </span>
      <span className="p7-context__item">
        Reduced motion <strong>{reduce ? 'activo' : 'inactivo'}</strong>
      </span>
      <span className="p7-context__hint">Se ajustan en la barra superior</span>
    </div>
  );
}
