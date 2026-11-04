import { describe, expect, it } from 'vitest';
import { classifySnapshotApply } from './snapshotApply';

describe('classifySnapshotApply', () => {
  it('applies the next partial and any full frame', () => {
    expect(classifySnapshotApply(4, 5, false)).toBe('apply');
    expect(classifySnapshotApply(4, 9, true)).toBe('apply');
    expect(classifySnapshotApply(0, 1, true)).toBe('apply');
  });

  it('ignores a snapshot that is older than the screen already shown', () => {
    expect(classifySnapshotApply(8, 7, false)).toBe('ignore');
    expect(classifySnapshotApply(8, 7, true)).toBe('ignore');
  });

  it('asks for a full frame when a partial skips the frame the canvas has', () => {
    expect(classifySnapshotApply(4, 6, false)).toBe('resync');
    expect(classifySnapshotApply(0, 3, false)).toBe('resync');
    expect(classifySnapshotApply(4, 4, false)).toBe('resync');
  });
});
