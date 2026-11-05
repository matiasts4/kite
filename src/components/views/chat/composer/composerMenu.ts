import type { CSSProperties } from 'react';
import { composerMenu } from '../../../../motion/standard/tokens';

const ease = `cubic-bezier(${composerMenu.ease.join(', ')})`;

/** Inline motion for a footer menu. The card drifts toward the control that opened it. */
export function composerMenuStyle(position: CSSProperties): CSSProperties {
  return {
    ...position,
    ['--composer-menu-ms' as string]: `${composerMenu.durationMs}ms`,
    ['--composer-menu-drift' as string]: `${composerMenu.driftPx}px`,
    ['--composer-menu-ease' as string]: ease,
    ['--composer-menu-exit-ms' as string]: `${composerMenu.exit.duration * 1000}ms`,
    animationDuration: `${composerMenu.durationMs}ms`,
    animationTimingFunction: ease,
  };
}
