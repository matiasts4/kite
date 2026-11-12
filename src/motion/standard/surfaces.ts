import type { MotionProps } from 'motion/react';
import { scale, springs, tweens } from './tokens';

export type SurfaceKind =
  | 'dialog'
  | 'popover'
  | 'menu'
  | 'sheet'
  | 'toast'
  | 'panel'
  | 'panel-left'
  | 'scrim';

export interface SurfaceMotionOptions {
  /** Match a legacy presence timer so the exit is not cut short. */
  exitMs?: number;
}

function exitTransition(base: { duration: number; ease?: [number, number, number, number] }, exitMs?: number) {
  return exitMs === undefined ? base : { ...base, duration: exitMs / 1000 };
}

/**
 * Entry and exit props for the standard surfaces. Entry uses the role spring;
 * exit is always a short tween, so dismissal feels faster than arrival.
 */
export function surfaceMotion(
  kind: SurfaceKind,
  options: SurfaceMotionOptions = {}
): MotionProps {
  const exit = exitTransition(tweens.dismiss, options.exitMs);
  switch (kind) {
    case 'scrim':
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0, transition: exit },
        transition: tweens.overlay,
      };
    case 'dialog':
      return {
        initial: { opacity: 0, y: 10, scale: scale.choice },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 6, scale: 0.99, transition: exit },
        transition: springs.dialog,
      };
    case 'sheet':
      return {
        initial: { opacity: 0, y: 16, scale: 0.99 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 10, scale: 0.995, transition: exitTransition(tweens.panelOut, options.exitMs) },
        transition: tweens.sheet,
      };
    case 'toast':
      return {
        initial: { opacity: 0, y: -8, scale: scale.toast },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -6, scale: scale.toast, transition: exit },
        transition: springs.toast,
      };
    case 'panel':
      return {
        initial: { opacity: 0, x: 16 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: 16, transition: exitTransition(tweens.panelOut, options.exitMs) },
        transition: tweens.panelIn,
      };
    case 'panel-left':
      return {
        initial: { opacity: 0, x: -16 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: -16, transition: exitTransition(tweens.panelOut, options.exitMs) },
        transition: tweens.panelIn,
      };
    case 'menu':
      return {
        initial: { opacity: 0, y: -4, scale: 0.96 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -4, scale: 0.98, transition: exit },
        transition: springs.pop,
      };
    case 'popover':
    default:
      return {
        initial: { opacity: 0, y: -6, scale: 0.96 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -4, scale: 0.98, transition: exit },
        transition: springs.pop,
      };
  }
}

/** Transform origin for an anchored surface. */
export function surfaceOrigin(
  side: 'top' | 'bottom' | 'left' | 'right' | 'center' = 'center'
): string {
  switch (side) {
    case 'top':
      return 'top center';
    case 'bottom':
      return 'bottom center';
    case 'left':
      return 'left center';
    case 'right':
      return 'right center';
    default:
      return 'center center';
  }
}
