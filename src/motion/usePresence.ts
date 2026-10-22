import { useEffect, useRef, useState } from 'react';
import { MOTION_EXIT_MS, prefersReducedMotion } from './contract';

export interface Presence {
  mounted: boolean;
  phase: 'in' | 'out';
}

/** Keep a surface mounted through its exit, then drop it. */
export function usePresence(open: boolean): Presence {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<'in' | 'out'>(open ? 'in' : 'out');
  const mountedRef = useRef(open);
  mountedRef.current = mounted;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setPhase('in');
      return;
    }
    if (!mountedRef.current) return;
    setPhase('out');
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), MOTION_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return { mounted, phase };
}
