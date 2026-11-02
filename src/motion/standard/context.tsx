import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { MotionConfig } from 'motion/react';
import { prefersReducedMotion } from '../contract';
import { blur, scale, shift, springs, tweens } from './tokens';

const ReduceMotionContext = createContext(false);

export function useReduceMotion(): boolean {
  return useContext(ReduceMotionContext);
}

export interface MotionStandard {
  springs: typeof springs;
  tweens: typeof tweens;
  scale: typeof scale;
  blur: typeof blur;
  shift: typeof shift;
  reduce: boolean;
}

export function useMotionStandard(): MotionStandard {
  const reduce = useReduceMotion();
  return useMemo(
    () => ({ springs, tweens, scale, blur, shift, reduce }),
    [reduce]
  );
}

function readInitialPreference(): boolean {
  return prefersReducedMotion();
}

/**
 * Wraps the app with Motion's reduced-motion behavior and mirrors the effective
 * preference to `html[data-motion]` so CSS transitions and Motion agree.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduce, setReduce] = useState(readInitialPreference);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduce(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.motion = reduce ? 'reduce' : 'full';
    return () => {
      if (root.dataset.motion === (reduce ? 'reduce' : 'full')) {
        delete root.dataset.motion;
      }
    };
  }, [reduce]);

  return (
    <ReduceMotionContext.Provider value={reduce}>
      <MotionConfig reducedMotion={reduce ? 'always' : 'never'}>{children}</MotionConfig>
    </ReduceMotionContext.Provider>
  );
}
