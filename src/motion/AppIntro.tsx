import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { surfaceMotion } from './standard/surfaces';
import { springs, tweens } from './standard/tokens';
import './appIntro.css';

export interface AppIntroProps {
  open: boolean;
}

export const AppIntro: React.FC<AppIntroProps> = ({ open }) => {
  const intro = (
    <motion.div
      key="app-intro"
      className="app-intro"
      role="status"
      aria-live="polite"
      aria-busy={open}
      aria-label="Starting Kite"
      {...surfaceMotion('scrim')}
      transition={tweens.overlay}
    >
      <motion.div
        className="app-intro__panel"
        {...surfaceMotion('dialog')}
        transition={springs.dialog}
      >
        <motion.img
          src="/assets/kite-symbol.svg"
          alt=""
          className="app-intro__mark"
          width={56}
          height={56}
          initial={{ opacity: 0, scale: 0.92 }}
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
