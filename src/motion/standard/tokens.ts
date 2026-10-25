/**
 * Kite motion standard.
 *
 * These are the Animate UI 2.x role tokens validated in `?animate`. They are the
 * single source of truth for production motion; the dev lab derives its level
 * and tempo variants from the same tables.
 */

export type Bezier = [number, number, number, number];

export interface SpringToken {
  type: 'spring';
  stiffness: number;
  damping: number;
  restSpeed?: number;
  restDelta?: number;
}

export interface VisualSpringToken {
  type: 'spring';
  visualDuration: number;
  bounce: number;
}

export type AnySpring = SpringToken | VisualSpringToken;

export interface TweenToken {
  duration: number;
  ease?: Bezier;
  delay?: number;
}

export const eases = {
  out: [0.23, 1, 0.32, 1],
  soft: [0.215, 0.61, 0.355, 1],
  away: [0.33, 0.17, 0.67, 0.5],
  color: [0.25, 0.1, 0.25, 1],
  leave: [0, 0, 0.58, 1],
  enter: [0.25, 0.1, 0.35, 1],
  inOut: [0.77, 0, 0.175, 1],
} satisfies Record<string, Bezier>;

export const springs = {
  press: { type: 'spring', stiffness: 550, damping: 30, restSpeed: 10 },
  pop: { type: 'spring', stiffness: 400, damping: 29 },
  dialog: { type: 'spring', stiffness: 150, damping: 25 },
  toast: { type: 'spring', stiffness: 280, damping: 24 },
  selection: { type: 'spring', stiffness: 300, damping: 30 },
  highlight: { type: 'spring', stiffness: 500, damping: 40 },
  reflow: { type: 'spring', stiffness: 500, damping: 40 },
  thumb: { type: 'spring', stiffness: 300, damping: 25 },
  number: { type: 'spring', stiffness: 90, damping: 50 },
  bounce: { type: 'spring', stiffness: 200, damping: 16 },
} satisfies Record<string, SpringToken>;

export const tweens = {
  menu: { duration: 0.22, ease: eases.soft },
  overlay: { duration: 0.4, ease: eases.soft },
  dialogFade: { duration: 0.4, ease: eases.soft },
  fade: { duration: 0.2, ease: eases.out },
  color: { duration: 0.2, ease: eases.color },
  reveal: { duration: 0.3, ease: eases.out },
  disclosure: { duration: 0.35, ease: eases.soft },
  panelOut: { duration: 0.15, ease: eases.leave },
  panelIn: { duration: 0.3, ease: eases.enter },
  swap: { duration: 0.15, ease: eases.out },
  spin: { duration: 0.3, ease: eases.out },
  dismiss: { duration: 0.2, ease: eases.away },
  sheet: { duration: 0.4, ease: eases.soft },
  shake: { duration: 0.4, ease: eases.inOut },
  instant: { duration: 0 },
} satisfies Record<string, TweenToken>;

export const scale = {
  press: 0.97,
  choice: 0.985,
  tooltip: 0.7,
  popover: 0.8,
  menu: 0.9,
  dialog: 0.8,
  icon: 0.5,
  toast: 0.96,
} as const;

export const blur = {
  tooltip: 'blur(6px)',
  icon: 'blur(2px)',
  disclosure: 'blur(2px)',
  surface: 'blur(4px)',
  panel: 'blur(5px)',
} as const;

export const shift = {
  handoff: 6,
  navigation: 24,
  tabs: 12,
  step: 24,
  tooltip: 40,
  shake: 3,
} as const;

/** Every production surface enters on a role spring and exits on a short tween. */
export const enter = {
  press: springs.press,
  pop: springs.pop,
  dialog: springs.dialog,
  toast: springs.toast,
  selection: springs.selection,
  panel: tweens.panelIn,
} as const;
