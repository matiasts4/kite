import { prefersReducedMotion } from './contract';

export type MotionSurfaceKind =
  | 'popover'
  | 'panel'
  | 'panel-left'
  | 'row'
  | 'terminal'
  | 'scrim'
  | 'modal';

/** CSS class for enter/exit animation on a motion surface. */
export function motionSurfaceClass(phase: 'in' | 'out', kind: MotionSurfaceKind): string {
  if (prefersReducedMotion()) return '';
  const suffix = phase === 'out' ? 'out' : 'in';
  if (kind === 'panel-left') return `motion-panel-${suffix}-left`;
  if (kind === 'scrim') return `motion-scrim-${suffix}`;
  if (kind === 'modal') return `motion-modal-${suffix}`;
  return `motion-${kind}-${suffix}`;
}
