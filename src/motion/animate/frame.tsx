import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useLabMotion, useLabReduce } from './context';

export type CompareVariant = 'kite' | 'animate';
export type CompareView = 'split' | 'kite' | 'animate';

type SceneButtonVariant = 'default' | 'primary' | 'ghost' | 'icon';

type SceneButtonBaseProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onDrag'
  | 'onDragEnd'
  | 'onDragEnter'
  | 'onDragExit'
  | 'onDragLeave'
  | 'onDragOver'
  | 'onDragStart'
  | 'onDrop'
>;

interface SceneButtonProps extends SceneButtonBaseProps {
  mode: CompareVariant;
  variant?: SceneButtonVariant;
}

export const SceneButton = forwardRef<HTMLButtonElement, SceneButtonProps>(
  function SceneButton({ mode, variant = 'default', className = '', type = 'button', ...rest }, ref) {
    const motionTokens = useLabMotion();
    const reduce = useLabReduce();
    const prodClass =
      variant === 'primary'
        ? 'primary-button'
        : variant === 'ghost'
        ? 'ghost-button'
        : variant === 'icon'
        ? 'ghost-button'
        : 'secondary-button';
    const classes = ['cmp-btn', `cmp-btn--${variant}`, prodClass, className].filter(Boolean).join(' ');

    if (mode === 'animate') {
      return (
        <motion.button
          ref={ref}
          type={type}
          className={classes}
          initial={{ scale: 1 }}
          whileHover={reduce ? undefined : { y: -1, transition: motionTokens.springs.highlight }}
          whileTap={{ scale: reduce ? 1 : motionTokens.scale.press }}
          transition={motionTokens.springs.press}
          {...rest}
        />
      );
    }

    return <button ref={ref} type={type} className={classes} {...rest} />;
  }
);

export function PaneHead({
  mode,
  label,
  meta,
}: {
  mode: CompareVariant;
  label?: string;
  meta?: string;
}) {
  return (
    <div className="cmp-pane__head">
      <span className={`cmp-pane__dot cmp-pane__dot--${mode}`} />
      <span className="cmp-pane__title">
        {label ?? (mode === 'kite' ? 'Kite hoy' : 'Animate UI')}
      </span>
      <span className="cmp-pane__meta">
        {meta ?? (mode === 'kite' ? 'CSS · 180 / 140 ms' : 'springs · tokens')}
      </span>
    </div>
  );
}

interface CompareSceneProps {
  index: string;
  title: string;
  target: string;
  note: string;
  view: CompareView;
  labels?: Partial<Record<CompareVariant, string>>;
  meta?: Partial<Record<CompareVariant, string>>;
  children: (mode: CompareVariant) => ReactNode;
}

export function CompareScene({
  index,
  title,
  target,
  note,
  view,
  labels,
  meta,
  children,
}: CompareSceneProps) {
  return (
    <section className="cmp-scene">
      <header className="cmp-scene__head">
        <span className="cmp-scene__index">{index}</span>
        <div className="cmp-scene__copy">
          <h2>{title}</h2>
          <p>{note}</p>
        </div>
        <span className="cmp-scene__target">{target}</span>
      </header>
      <div className={`cmp-grid cmp-grid--${view}`}>
        {view !== 'animate' && (
          <div className="cmp-pane">
            <PaneHead mode="kite" label={labels?.kite} meta={meta?.kite} />
            {children('kite')}
          </div>
        )}
        {view !== 'kite' && (
          <div className="cmp-pane">
            <PaneHead mode="animate" label={labels?.animate} meta={meta?.animate} />
            {children('animate')}
          </div>
        )}
      </div>
    </section>
  );
}

export function SceneSwitch({
  mode,
  checked,
  onChange,
  disabled = false,
}: {
  mode: CompareVariant;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const [pressed, setPressed] = useState(false);

  if (mode === 'animate') {
    return (
      <motion.button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`ui-switch cmp-switch${checked ? ' is-on' : ''}`}
        onClick={onChange}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        onBlur={() => setPressed(false)}
        whileTap={{ scale: reduce ? 1 : motionTokens.scale.press }}
        transition={motionTokens.springs.press}
      >
        <motion.span
          className="ui-switch__knob cmp-switch__thumb"
          animate={{ x: checked ? 18 : 0, scaleX: pressed ? 1.08 : 1 }}
          transition={motionTokens.springs.thumb}
          style={{ transformOrigin: checked ? 'right center' : 'left center' }}
        />
      </motion.button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`ui-switch cmp-switch${checked ? ' is-on' : ''}`}
      onClick={onChange}
    >
      <span
        className="ui-switch__knob cmp-switch__thumb"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(0)' }}
      />
    </button>
  );
}
