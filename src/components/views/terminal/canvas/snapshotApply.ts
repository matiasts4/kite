export type SnapshotApplyPlan = 'apply' | 'ignore' | 'resync';

/**
 * A partial snapshot is a delta from the immediately previous frame.
 * An older seq would paint that delta onto a newer screen.
 * A skipped seq is a delta from a frame this canvas never applied.
 */
export function classifySnapshotApply(
  lastSeq: number,
  seq: number,
  full: boolean,
): SnapshotApplyPlan {
  if (seq < lastSeq) return 'ignore';
  if (!full && seq !== lastSeq + 1) return 'resync';
  return 'apply';
}
