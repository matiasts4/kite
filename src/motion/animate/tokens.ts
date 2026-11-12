/**
 * Animate UI motion tokens for the dev comparison lab.
 * The base tables live in `src/motion/standard/tokens.ts`; this module only
 * applies the level and tempo steps described in `references/feel.md`.
 */

import {
  blur,
  scale,
  shift,
  springs as baseSprings,
  tweens as baseTweens,
  type AnySpring,
  type Bezier,
  type SpringToken,
  type TweenToken,
  type VisualSpringToken,
} from '../standard/tokens';

export type { AnySpring, Bezier, SpringToken, TweenToken, VisualSpringToken };
export { blur, scale, shift };

export type LabLevel = 'subtle' | 'more' | 'expressive';

interface LabSprings {
  press: AnySpring;
  pop: AnySpring;
  dialog: AnySpring;
  toast: AnySpring;
  selection: AnySpring;
  highlight: AnySpring;
  reflow: AnySpring;
  thumb: AnySpring;
  number: AnySpring;
  bounce: AnySpring;
}

interface LabTweens {
  menu: TweenToken;
  overlay: TweenToken;
  dialogFade: TweenToken;
  fade: TweenToken;
  color: TweenToken;
  reveal: TweenToken;
  disclosure: TweenToken;
  panelOut: TweenToken;
  panelIn: TweenToken;
  swap: TweenToken;
  spin: TweenToken;
  dismiss: TweenToken;
  sheet: TweenToken;
  shake: TweenToken;
  instant: TweenToken;
}

export interface LabTokens {
  level: LabLevel;
  tempo: number;
  springs: LabSprings;
  tweens: LabTweens;
  scale: typeof scale;
  blur: typeof blur;
  shift: typeof shift;
  /** Distance token for the active level: 1x, 1.5x, 2.4x. */
  travel: (px: number) => number;
  /** Blur used when a surface enters; none at the subtle level. */
  surfaceBlur: string;
  /** Blur used for swaps (labels, icons). */
  swapBlur: string;
  /** Blur used for list items. */
  itemBlur: string;
  /** Spring used for items making room; bouncy at the expressive level. */
  itemSpring: AnySpring;
  /** Delay between items arriving together; only at the expressive level. */
  stagger: number;
}

const TRAVEL: Record<LabLevel, number> = {
  subtle: 1,
  more: 1.5,
  expressive: 2.4,
};

function paceSpring(token: AnySpring, tempo: number): AnySpring {
  if ('visualDuration' in token) {
    return { ...token, visualDuration: token.visualDuration * tempo };
  }
  return {
    ...token,
    stiffness: token.stiffness / (tempo * tempo),
    damping: token.damping / tempo,
  };
}

function paceTween(token: TweenToken, tempo: number): TweenToken {
  const paced: TweenToken = { ...token, duration: token.duration * tempo };
  if (token.delay !== undefined) paced.delay = token.delay * tempo;
  return paced;
}

export function createLabTokens(level: LabLevel, tempo: number): LabTokens {
  const springEntries = Object.entries(baseSprings) as [keyof LabSprings, AnySpring][];
  const pacedSprings = Object.fromEntries(
    springEntries.map(([key, value]) => [key, paceSpring(value, tempo)])
  ) as unknown as LabSprings;

  if (level === 'expressive') {
    pacedSprings.reflow = paceSpring(baseSprings.bounce, tempo);
  }

  const tweenEntries = Object.entries(baseTweens) as [keyof LabTweens, TweenToken][];
  const pacedTweens = Object.fromEntries(
    tweenEntries.map(([key, value]) => [key, paceTween(value, tempo)])
  ) as unknown as LabTweens;

  return {
    level,
    tempo,
    springs: pacedSprings,
    tweens: pacedTweens,
    scale,
    blur,
    shift,
    travel: (px: number) => px * TRAVEL[level],
    surfaceBlur: level === 'subtle' ? 'blur(0px)' : blur.surface,
    swapBlur: level === 'subtle' ? blur.icon : blur.surface,
    itemBlur: level === 'subtle' ? 'blur(0px)' : blur.surface,
    itemSpring: pacedSprings.reflow,
    stagger: level === 'expressive' ? 0.03 : 0,
  };
}
