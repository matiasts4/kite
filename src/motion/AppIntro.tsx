import React, { useLayoutEffect } from 'react';
import { AnimatePresence, motion, type MotionProps } from 'motion/react';
import { surfaceMotion } from './standard/surfaces';
import { springs, tweens } from './standard/tokens';
import './appIntro.css';

export interface AppIntroProps {
  open: boolean;
  /** Lab preview only. Production stays opaque on the first frame. */
  animateIn?: boolean;
}

/** Drop the static boot cover. Safe to call more than once. */
export function releaseBootCover(): void {
  document.documentElement.dataset.bootReleased = 'true';
  document.getElementById('boot')?.remove();
}

function opaqueOnFirstFrame(props: MotionProps): MotionProps {
  return { ...props, initial: false };
}

export const AppIntro: React.FC<AppIntroProps> = ({ open, animateIn = false }) => {
  useLayoutEffect(() => {
    if (open) releaseBootCover();
  }, [open]);

  const scrim = animateIn ? surfaceMotion('scrim') : opaqueOnFirstFrame(surfaceMotion('scrim'));
  const panel = animateIn ? surfaceMotion('dialog') : opaqueOnFirstFrame(surfaceMotion('dialog'));

  const intro = (
    <motion.div
      key="app-intro"
      className="app-intro"
      role="status"
      aria-live="polite"
      aria-busy={open}
      aria-label="Starting Kite"
      {...scrim}
      transition={tweens.overlay}
    >
      <motion.div className="app-intro__panel" {...panel} transition={springs.dialog}>
        <motion.img
          src="/assets/kite-symbol.svg"
          alt=""
          className="app-intro__mark"
          width={56}
          height={56}
          initial={animateIn ? { opacity: 0, scale: 0.92 } : false}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...springs.pop, delay: 0.08 }}
        />
        <span className="app-intro__title">Kite</span>
        <p className="app-intro__hint">Preparing your workspace…</p>
      </motion.div>
    </motion.div>
  );

  return <AnimatePresence>{open ? intro : null}</AnimatePresence>;
};
