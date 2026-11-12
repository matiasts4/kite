import { motion } from 'motion/react';
import { springs } from '../../motion/standard/tokens';

/**
 * One gliding selection layer for a `.ui-segmented` group.
 *
 * Render it inside the selected item only. Every group must pass a unique
 * `group` id so two groups never share the same layout animation.
 */
export function SegmentedIndicator({ group }: { group: string }) {
  return (
    <motion.span
      layoutId={`segmented-${group}`}
      className="ui-segmented__indicator"
      transition={springs.selection}
      initial={false}
      aria-hidden="true"
    />
  );
}
