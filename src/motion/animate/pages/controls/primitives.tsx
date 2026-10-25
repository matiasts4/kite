import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useMotionValue,
  useSpring,
  type MotionStyle,
} from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { SegmentedIndicator } from '../../../../components/ui/SegmentedIndicator';
import type { CompareVariant } from '../../frame';
import { CloseIcon } from '../../ui';
import { SpinnerIcon } from './icons';

export function P1Pane({
  mode,
  children,
}: {
  mode: CompareVariant;
  children: ReactNode;
}) {
  return <div className={`p1-pane p1-pane--${mode}`}>{children}</div>;
}

export function P1Block({
  title,
  hint,
  className = '',
  children,
}: {
  title: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`p1-block ${className}`.trim()}>
      <div className="p1-block__head">
        <span className="p1-block__title">{title}</span>
        {hint && <span className="p1-block__hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Two icons sharing one box; the leaving one swaps out through a light blur. */
export function IconSwap({
  mode,
  active,
  idle,
  activeIcon,
  rotate = 0,
  className = '',
}: {
  mode: CompareVariant;
  active: boolean;
  idle: ReactNode;
  activeIcon: ReactNode;
  rotate?: number;
  className?: string;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return (
      <span
        className={`p1-iconswap${active ? ' is-on' : ''} ${className}`.trim()}
        style={{ '--p1-turn': `${rotate}deg` } as CSSProperties}
      >
        <span className="p1-iconswap__layer p1-iconswap__layer--idle">{idle}</span>
        <span className="p1-iconswap__layer p1-iconswap__layer--active">{activeIcon}</span>
      </span>
    );
  }

  return (
    <span className={`p1-iconswap ${className}`.trim()}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={active ? 'active' : 'idle'}
          className="p1-iconswap__layer"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.icon,
            filter: motionTokens.blur.icon,
            rotate: reduce ? 0 : -rotate,
          }}
          animate={{
            opacity: 1,
            scale: 1,
            filter: 'blur(0px)',
            rotate: 0,
            transition: motionTokens.tweens.swap,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.icon,
            filter: motionTokens.blur.icon,
            rotate: reduce ? 0 : rotate,
            transition: motionTokens.tweens.swap,
          }}
        >
          {active ? activeIcon : idle}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function P1Spinner({ mode, size = 13 }: { mode: CompareVariant; size?: number }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return (
      <span className="p1-spin" aria-hidden="true">
        <SpinnerIcon size={size} />
      </span>
    );
  }

  return (
    <motion.span
      className="p1-spin"
      aria-hidden="true"
      animate={reduce ? { opacity: [0.45, 1, 0.45] } : { rotate: 360 }}
      transition={
        reduce
          ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.9 / motionTokens.tempo, repeat: Infinity, ease: 'linear' }
      }
    >
      <SpinnerIcon size={size} />
    </motion.span>
  );
}

export type P1ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
export type P1ButtonSize = 'sm' | 'md' | 'lg';

export interface P1ButtonProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'
  > {
  mode: CompareVariant;
  variant?: P1ButtonVariant;
  size?: P1ButtonSize;
  circle?: boolean;
  /** Shake once on click, Animate UI column only. */
  shakeOnClick?: boolean;
  /** Turn the hover lift off where another gesture owns the transform. */
  lift?: boolean;
  /** Motion values for pointer-follow or other non-CSS transforms. */
  motionStyle?: MotionStyle;
}

/**
 * Real Kite button anatomy:
 * - Real classes: .primary-button, .secondary-button, .ghost-button, .danger-button, .cmp-btn
 * - Real sizes: sm (26px / .ui-control--sm), md (32px default), lg (38px / .ui-control--lg)
 * - Circle: circular 32px action button (.action-button--circle)
 * - Real states: normal, hover, active (press 0.97), disabled, busy with spinner
 * - Kite hoy: standard CSS transition + press scale(0.97)
 * - Animate UI: spring press whileTap scale(0.97) + hover lift
 */
export const P1Button = forwardRef<HTMLButtonElement, P1ButtonProps>(function P1Button(
  props,
  ref
) {
  const {
    mode,
    variant = 'secondary',
    size,
    circle = false,
    className = '',
    type = 'button',
    onClick,
    disabled = false,
    'aria-disabled': ariaDisabled,
    'aria-busy': ariaBusy,
    style,
    shakeOnClick = false,
    lift = true,
    motionStyle,
    children,
    ...rest
  } = props;
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const finePointer = useFinePointer();
  const controls = useAnimationControls();
  const [denied, setDenied] = useState(false);
  const deniedTimer = useRef<number | undefined>(undefined);
  const blocked = disabled || ariaDisabled === true || ariaDisabled === 'true';
  const canHover = finePointer && !reduce && !blocked && lift;

  useEffect(
    () => () => {
      if (deniedTimer.current !== undefined) window.clearTimeout(deniedTimer.current);
    },
    []
  );

  const variantClass =
    variant === 'primary'
      ? 'primary-button'
      : variant === 'ghost'
      ? 'ghost-button'
      : variant === 'danger'
      ? 'danger-button'
      : variant === 'icon'
      ? 'ghost-button cmp-btn--icon'
      : 'secondary-button';

  const sizeClass =
    size === 'sm'
      ? 'ui-control--sm cmp-btn--sm'
      : size === 'lg'
      ? 'ui-control--lg'
      : '';

  const circleClass = circle ? 'action-button--circle' : '';

  const classes = [
    'cmp-btn',
    variantClass,
    sizeClass,
    circleClass,
    denied ? 'is-denied' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (mode === 'kite') {
    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        className={classes}
        onClick={onClick}
        disabled={disabled}
        aria-disabled={ariaDisabled}
        aria-busy={ariaBusy}
        style={style}
      >
        {children}
      </button>
    );
  }

  const shake = () => {
    const distance = motionTokens.shift.shake;
    void controls.start(
      { x: [null, -distance, distance, -distance * 0.66, distance * 0.33, 0] },
      { ...motionTokens.tweens.shake }
    );
  };

  const flashDenied = () => {
    setDenied(true);
    if (deniedTimer.current !== undefined) window.clearTimeout(deniedTimer.current);
    deniedTimer.current = window.setTimeout(
      () => setDenied(false),
      Math.max(120, motionTokens.tweens.shake.duration * 1000)
    );
  };

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!shakeOnClick || blocked || event.defaultPrevented) return;
    if (reduce) flashDenied();
    else shake();
  };

  return (
    <motion.button
      {...rest}
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled}
      aria-disabled={ariaDisabled}
      aria-busy={ariaBusy}
      style={{ ...style, ...motionStyle }}
      initial={{ scale: 1 }}
      animate={controls}
      whileHover={
        canHover
          ? {
              y: -1,
              transition: motionTokens.springs.highlight,
            }
          : undefined
      }
      whileTap={
        blocked
          ? undefined
          : {
              scale: reduce ? 1 : motionTokens.scale.press,
              transition: motionTokens.springs.press,
            }
      }
      transition={motionTokens.springs.press}
      onClick={handleClick}
    >
      {variant === 'icon' ? (
        <motion.span
          className="p1-btn__icon"
          whileHover={
            canHover
              ? {
                  y: -0.5,
                  transition: motionTokens.springs.highlight,
                }
              : undefined
          }
          transition={motionTokens.springs.highlight}
        >
          {children}
        </motion.span>
      ) : (
        children
      )}
    </motion.button>
  );
});

function SaveDraftIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 4h11l3 3v13H5Z" />
      <path d="M8 4v5h7V4" />
      <path d="M8 20v-6h8v6" />
    </svg>
  );
}

export type P1SavePhase = 'idle' | 'saving' | 'saved' | 'error';

/** A fixed 14px slot: spinner → drawn check (with a ring) or a shaking cross. */
export function P1SaveGlyph({ state }: { state: P1SavePhase }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const distance = motionTokens.shift.shake;
  const saved = state === 'saved';
  const error = state === 'error';

  const layerInitial = saved
    ? {
        opacity: 0,
        scale: reduce ? 1 : 0.55,
        rotate: reduce ? 0 : -14,
        filter: motionTokens.swapBlur,
      }
    : { opacity: 0, filter: motionTokens.swapBlur };

  const layerAnimate = saved
    ? {
        opacity: 1,
        scale: 1,
        rotate: 0,
        filter: 'blur(0px)',
        transition: motionTokens.springs.pop,
      }
    : error && !reduce
      ? {
          opacity: 1,
          filter: 'blur(0px)',
          x: [0, -distance, distance, -distance * 0.66, distance * 0.33, 0],
          transition: motionTokens.tweens.shake,
        }
      : { opacity: 1, filter: 'blur(0px)', transition: motionTokens.tweens.swap };

  const layerExit = {
    opacity: 0,
    filter: motionTokens.swapBlur,
    transition: motionTokens.tweens.swap,
  };

  return (
    <span className="p1-save__glyph" aria-hidden="true">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          className={`p1-save__layer${saved ? ' p1-save__layer--saved' : ''}${
            error ? ' p1-save__layer--error' : ''
          }`}
          initial={layerInitial}
          animate={layerAnimate}
          exit={layerExit}
        >
          {state === 'idle' && <SaveDraftIcon />}
          {state === 'saving' && <P1Spinner mode="animate" />}
          {state === 'saved' && (
            <>
              <motion.span
                className="p1-save__ring"
                initial={{ opacity: 0.6, scale: reduce ? 1 : 0.55 }}
                animate={{ opacity: 0, scale: reduce ? 1 : 1.7 }}
                transition={motionTokens.tweens.reveal}
              />
              <svg className="p1-save__check" viewBox="0 0 16 16">
                <motion.path
                  d="M3.5 8.4 6.6 11.5 12.6 4.8"
                  initial={{ pathLength: reduce ? 1 : 0, opacity: reduce ? 1 : 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={reduce ? motionTokens.tweens.instant : motionTokens.tweens.reveal}
                />
              </svg>
            </>
          )}
          {state === 'error' && <CloseIcon size={12} />}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** A single expanding halo used by the pin toggle. */
export function P1PulseRing({
  active,
  className = '',
}: {
  active: boolean;
  className?: string;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.span
          key="ring"
          className={`p1-pulse-ring ${className}`.trim()}
          initial={{ opacity: 0.55, scale: reduce ? 1 : 0.55 }}
          animate={{ opacity: 0, scale: reduce ? 1 : 1.55 }}
          exit={{ opacity: 0, transition: motionTokens.tweens.swap }}
          transition={motionTokens.tweens.reveal}
          aria-hidden="true"
        />
      )}
    </AnimatePresence>
  );
}

/** A selected surface gliding between buttons that share one layoutId. */
export function P1GlideIndicator({
  layoutId,
  className = '',
}: {
  layoutId: string;
  className?: string;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <motion.span
      className={`p1-glide ${className}`.trim()}
      layoutId={layoutId}
      initial={false}
      transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.selection}
      aria-hidden="true"
    />
  );
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Pointer-follow button: the surface lags behind the pointer on
 * spring.highlight; the label trails it on spring.pop. Only the fine-pointer
 * and full-motion path binds the pointer; reduced motion keeps it at rest.
 */
export function P1MagneticButton({
  mode,
  className = '',
  children,
}: {
  mode: CompareVariant;
  className?: string;
  children: ReactNode;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const finePointer = useFinePointer();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const labelX = useMotionValue(0);
  const labelY = useMotionValue(0);
  const springX = useSpring(x, motionTokens.springs.highlight);
  const springY = useSpring(y, motionTokens.springs.highlight);
  const labelSpringX = useSpring(labelX, motionTokens.springs.pop);
  const labelSpringY = useSpring(labelY, motionTokens.springs.pop);
  const bound = mode === 'animate' && finePointer && !reduce;

  useEffect(() => {
    if (bound) return;
    x.jump(0);
    y.jump(0);
    labelX.jump(0);
    labelY.jump(0);
    springX.jump(0);
    springY.jump(0);
    labelSpringX.jump(0);
    labelSpringY.jump(0);
  }, [bound, x, y, labelX, labelY, springX, springY, labelSpringX, labelSpringY]);

  const rest = () => {
    if (reduce) {
      x.jump(0);
      y.jump(0);
      labelX.jump(0);
      labelY.jump(0);
      springX.jump(0);
      springY.jump(0);
      labelSpringX.jump(0);
      labelSpringY.jump(0);
      return;
    }
    x.set(0);
    y.set(0);
    labelX.set(0);
    labelY.set(0);
  };

  const follow = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!bound) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = clampUnit((event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2));
    const dy = clampUnit((event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2));
    const outer = motionTokens.travel(4);
    const inner = motionTokens.travel(1.5);
    x.set(dx * outer);
    y.set(dy * outer);
    labelX.set(dx * inner);
    labelY.set(dy * inner);
  };

  return (
    <P1Button
      mode={mode}
      variant="primary"
      lift={false}
      className={`p1-btn--magnet ${className}`.trim()}
      motionStyle={mode === 'animate' ? { x: springX, y: springY } : undefined}
      onPointerMove={follow}
      onPointerLeave={rest}
      onBlur={rest}
    >
      {mode === 'animate' ? (
        <motion.span className="p1-magnet__label" style={{ x: labelSpringX, y: labelSpringY }}>
          {children}
        </motion.span>
      ) : (
        <span className="p1-magnet__label">{children}</span>
      )}
    </P1Button>
  );
}

export function P1PlusMinus({ mode, active }: { mode: CompareVariant; active: boolean }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return (
      <span className={`p1-plusminus${active ? ' is-minus' : ''}`} aria-hidden="true">
        <i />
        <i />
      </span>
    );
  }

  return (
    <span className="p1-plusminus" aria-hidden="true">
      <i />
      <motion.i
        animate={{ scaleY: active ? 0 : 1 }}
        transition={reduce ? motionTokens.tweens.instant : motionTokens.tweens.swap}
      />
    </span>
  );
}

export function ToggleIcon({
  mode,
  active,
  heart = false,
  children,
}: {
  mode: CompareVariant;
  active: boolean;
  heart?: boolean;
  children: ReactNode;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const classes = `p1-toggle-icon${active ? ' is-on' : ''}${heart ? ' p1-toggle-icon--heart' : ''}`;

  if (mode === 'kite') {
    return <span className={classes}>{children}</span>;
  }

  return (
    <motion.span
      className={classes}
      initial={false}
      animate={{ scale: active && !reduce ? 1.12 : 1 }}
      transition={motionTokens.springs.pop}
    >
      {children}
    </motion.span>
  );
}

export function useFinePointer(): boolean {
  const [fine, setFine] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );

  useEffect(() => {
    const media = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setFine(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return fine;
}

export function useAutoSize(value: string, minHeight = 54) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.max(minHeight, element.scrollHeight)}px`;
  }, [value, minHeight]);

  return ref;
}

export interface SegmentedItem {
  id: string;
  label: string;
}

/**
 * Real Kite .ui-segmented component backed by SegmentedIndicator.
 */
export function Segmented({
  mode,
  label,
  items,
  value,
  onChange,
  layoutId,
  onInputKind,
}: {
  mode: CompareVariant;
  label: string;
  items: SegmentedItem[];
  value: string;
  onChange: (next: string) => void;
  layoutId: string;
  onInputKind?: (kind: 'pointer' | 'keyboard') => void;
}) {
  const groupRef = useRef<HTMLFieldSetElement>(null);

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, itemIndex: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = (itemIndex + direction + items.length) % items.length;
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[next]?.focus();
    onChange(items[next].id);
    onInputKind?.('keyboard');
  };

  return (
    <fieldset ref={groupRef} className="ui-segmented" aria-label={label}>
      {items.map((item, itemIndex) => {
        const selected = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className="ui-segmented__item"
            aria-pressed={selected}
            onClick={(event) => {
              onChange(item.id);
              onInputKind?.(event.detail === 0 ? 'keyboard' : 'pointer');
            }}
            onKeyDown={(event) => moveWithKeyboard(event, itemIndex)}
          >
            {selected && mode === 'animate' && (
              <SegmentedIndicator group={layoutId} />
            )}
            {selected && mode === 'kite' && (
              <span className="ui-segmented__indicator" aria-hidden="true" />
            )}
            <span className="ui-segmented__label">{item.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

export function MultiGroup({
  mode,
  label,
  items,
  selected,
  onToggle,
}: {
  mode: CompareVariant;
  label: string;
  items: SegmentedItem[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="ui-segmented" aria-label={label}>
      {items.map((item) => {
        const active = selected.includes(item.id);
        return (
          <button
            key={item.id}
            type="button"
            className="ui-segmented__item"
            aria-pressed={active}
            onClick={() => onToggle(item.id)}
          >
            {active && mode === 'animate' && (
              <SegmentedIndicator group={`multi-${item.id}`} />
            )}
            {active && mode === 'kite' && (
              <span className="ui-segmented__indicator" aria-hidden="true" />
            )}
            <span className="ui-segmented__label">{item.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
