import { prefersReducedMotion } from '../../../motion/contract';
import { usePresence } from '../../../motion/usePresence';

/** Exit class for diffs menus; enter uses `diffsPopIn` on `.diffs-overflow-menu` / `.diff-quick-jump-popover`. */
export function diffsMenuMotionClass(phase: 'in' | 'out'): string {
  if (prefersReducedMotion()) return '';
  return phase === 'out' ? 'diffs-pop-out' : '';
}

export function useDiffsMenuPresence(open: boolean) {
  const presence = usePresence(open);
  return {
    mounted: presence.mounted,
    motionClass: diffsMenuMotionClass(presence.phase),
  };
}
