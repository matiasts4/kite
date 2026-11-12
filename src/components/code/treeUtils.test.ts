import { describe, it, expect } from 'vitest';
import {
  createLeaf,
  createSplit,
  splitLeaf,
  removeLeaf,
  findLeaf,
  getAllLeaves,
  equalizeSplits,
  updateSplitRatios,
  swapAdjacent,
  copySplitRatiosIfSameChildren,
  swapLeaves,
  moveLeafToEdge,
} from './treeUtils';
import type { PaneSplit } from './types';

describe('treeUtils - Code Workspace Split Tree Operations', () => {
  it('creates an independent leaf with unique ID and occupant metadata', () => {
    const leaf = createLeaf({
      kind: 'terminal',
      sessionId: 'session-1',
      label: 'Antigravity Terminal',
    });

    expect(leaf.type).toBe('leaf');
    expect(leaf.id).toBeDefined();
    expect(leaf.occupant.kind).toBe('terminal');
    if (leaf.occupant.kind === 'terminal') {
      expect(leaf.occupant.sessionId).toBe('session-1');
      expect(leaf.occupant.label).toBe('Antigravity Terminal');
    }
  });

  it('splits a single leaf into vertical split with equal 50/50 ratios', () => {
    const originalLeaf = createLeaf({ kind: 'terminal', sessionId: 's-1', label: 'Pane 1' });
    const newLeaf = createLeaf({ kind: 'terminal', sessionId: 's-2', label: 'Pane 2' });

    const root = splitLeaf(originalLeaf, originalLeaf.id, newLeaf, 'vertical');

    expect(root.type).toBe('split');
    const split = root as PaneSplit;
    expect(split.axis).toBe('vertical');
    expect(split.children).toHaveLength(2);
    expect(split.ratios).toEqual([0.5, 0.5]);
    expect(split.children[0].id).toBe(originalLeaf.id);
    expect(split.children[1].id).toBe(newLeaf.id);
  });

  it('finds leaves at any level of nesting', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' });
    const l3 = createLeaf({ kind: 'terminal', sessionId: 's-3' });

    const innerSplit = createSplit('horizontal', [l2, l3]);
    const root = createSplit('vertical', [l1, innerSplit]);

    expect(findLeaf(root, l1.id)?.id).toBe(l1.id);
    expect(findLeaf(root, l2.id)?.id).toBe(l2.id);
    expect(findLeaf(root, l3.id)?.id).toBe(l3.id);
    expect(findLeaf(root, 'non-existent')).toBeNull();

    const all = getAllLeaves(root);
    expect(all).toHaveLength(3);
    expect(all.map((l) => l.id)).toEqual([l1.id, l2.id, l3.id]);
  });

  it('removes a leaf and collapses split to surviving sibling', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' });
    const root = createSplit('vertical', [l1, l2]);

    const updated = removeLeaf(root, l1.id);
    expect(updated).not.toBeNull();
    expect(updated?.type).toBe('leaf');
    expect(updated?.id).toBe(l2.id);
  });

  it('equalizes ratios across multiple children in a split', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' });
    const l3 = createLeaf({ kind: 'terminal', sessionId: 's-3' });
    const split = createSplit('vertical', [l1, l2, l3], [0.8, 0.1, 0.1]);

    const equalized = equalizeSplits(split) as PaneSplit;
    expect(equalized.ratios[0]).toBeCloseTo(0.333, 2);
    expect(equalized.ratios[1]).toBeCloseTo(0.333, 2);
    expect(equalized.ratios[2]).toBeCloseTo(0.333, 2);
  });

  it('updates split ratios proportionally on divider movement', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' });
    const split = createSplit('vertical', [l1, l2], [0.5, 0.5]);

    // Move divider right by 0.1 (first child grows, second shrinks)
    const moved = updateSplitRatios(split, split.id, 0, 0.1) as PaneSplit;
    expect(moved.ratios[0]).toBeCloseTo(0.6, 2);
    expect(moved.ratios[1]).toBeCloseTo(0.4, 2);
  });

  it('swaps adjacent leaves in order', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' });
    const split = createSplit('vertical', [l1, l2]);

    const swapped = swapAdjacent(split, l1.id, 1) as PaneSplit;
    expect(swapped.children[0].id).toBe(l2.id);
    expect(swapped.children[1].id).toBe(l1.id);
  });

  it('safely inserts new leaf when targetLeafId is a split container ID instead of a leaf', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' });
    const rootSplit = createSplit('vertical', [l1, l2]);
    const newLeaf = createLeaf({ kind: 'terminal', sessionId: 's-3' });

    // Target the root split container directly (e.g. currentTab.root.id when focusedLeafId is null)
    const result = splitLeaf(rootSplit, rootSplit.id, newLeaf, 'horizontal');
    const allLeaves = getAllLeaves(result);

    expect(allLeaves.some((l) => l.id === newLeaf.id)).toBe(true);
    expect(allLeaves).toHaveLength(3);
  });

  it('appends adjacent side-by-side columns when splitting along vertical axis', () => {
    const leaf1 = createLeaf({ kind: 'terminal', sessionId: 's-1', label: 'Orion' });
    const leaf2 = createLeaf({ kind: 'terminal', sessionId: 's-2', label: 'Nova' });
    const leaf3 = createLeaf({ kind: 'terminal', sessionId: 's-3', label: 'Atlas' });

    const root2 = splitLeaf(leaf1, leaf1.id, leaf2, 'vertical') as PaneSplit;
    expect(root2.axis).toBe('vertical');
    expect(root2.children).toHaveLength(2);

    const root3 = splitLeaf(root2, leaf2.id, leaf3, 'vertical') as PaneSplit;
    expect(root3.axis).toBe('vertical');
    expect(root3.children).toHaveLength(3);
    expect(root3.ratios).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('copies divider ratios when the child order is unchanged', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'left');
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'right');
    const current = createSplit('vertical', [l1, l2], [0.5, 0.5], 'split');
    const resized = createSplit('vertical', [l1, l2], [0.7, 0.3], 'split');

    const merged = copySplitRatiosIfSameChildren(current, resized) as PaneSplit;
    expect(merged.children.map((child) => child.id)).toEqual(['left', 'right']);
    expect(merged.ratios[0]).toBeCloseTo(0.7, 2);
    expect(merged.ratios[1]).toBeCloseTo(0.3, 2);
  });

  it('keeps a swapped child order when copying ratios from an older tree', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'left');
    const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'right');
    const swapped = createSplit('vertical', [l2, l1], [0.4, 0.6], 'split');
    const older = createSplit('vertical', [l1, l2], [0.8, 0.2], 'split');

    const merged = copySplitRatiosIfSameChildren(swapped, older) as PaneSplit;
    expect(merged.children.map((child) => child.id)).toEqual(['right', 'left']);
    expect(merged.ratios).toEqual([0.4, 0.6]);
  });

  describe('swapLeaves - Drag and Drop Pane Swapping', () => {
    it('swaps two leaves directly in a single split', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'leaf-1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'leaf-2');
      const root = createSplit('vertical', [l1, l2], [0.5, 0.5]);

      const swapped = swapLeaves(root, 'leaf-1', 'leaf-2') as PaneSplit;
      expect(swapped.children[0].id).toBe('leaf-2');
      expect(swapped.children[1].id).toBe('leaf-1');
      expect(swapped.ratios).toEqual([0.5, 0.5]);
    });

    it('swaps two distant leaves across different nested split containers', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'leaf-1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'leaf-2');
      const l3 = createLeaf({ kind: 'terminal', sessionId: 's-3' }, 'leaf-3');

      const inner = createSplit('horizontal', [l2, l3], [0.5, 0.5]);
      const root = createSplit('vertical', [l1, inner], [0.4, 0.6]);

      const swapped = swapLeaves(root, 'leaf-1', 'leaf-3') as PaneSplit;
      expect(swapped.children[0].id).toBe('leaf-3');
      const updatedInner = swapped.children[1] as PaneSplit;
      expect(updatedInner.children[0].id).toBe('leaf-2');
      expect(updatedInner.children[1].id).toBe('leaf-1');
    });

    it('returns root unchanged if source equals target or either id is missing', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'leaf-1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'leaf-2');
      const root = createSplit('vertical', [l1, l2]);

      expect(swapLeaves(root, 'leaf-1', 'leaf-1')).toBe(root);
      expect(swapLeaves(root, 'leaf-1', 'unknown')).toBe(root);
    });
  });

  describe('moveLeafToEdge - Drag and Drop Edge Splitting', () => {
    it('moves a leaf to the left of another leaf in the same vertical split', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'l1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'l2');
      const l3 = createLeaf({ kind: 'terminal', sessionId: 's-3' }, 'l3');
      const root = createSplit('vertical', [l1, l2, l3], [0.33, 0.33, 0.34]);

      // Move l3 to the left of l1
      const result = moveLeafToEdge(root, 'l3', 'l1', 'left') as PaneSplit;
      expect(result.axis).toBe('vertical');
      expect(result.children.map((c) => c.id)).toEqual(['l3', 'l1', 'l2']);
    });

    it('moves a leaf to the right of another leaf', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'l1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'l2');
      const root = createSplit('vertical', [l1, l2], [0.5, 0.5]);

      // Move l1 to the right of l2
      const result = moveLeafToEdge(root, 'l1', 'l2', 'right') as PaneSplit;
      expect(result.axis).toBe('vertical');
      expect(result.children.map((c) => c.id)).toEqual(['l2', 'l1']);
      expect(result.ratios).toEqual([0.5, 0.5]);
    });

    it('moves a leaf to the top of another leaf creating a horizontal split', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'l1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'l2');
      const root = createSplit('vertical', [l1, l2], [0.5, 0.5]);

      // Move l1 to the top of l2
      const result = moveLeafToEdge(root, 'l1', 'l2', 'top');
      // Old vertical split collapsed because l1 was removed leaving only l2,
      // then l2 was split horizontally with l1 before l2!
      expect(result.type).toBe('split');
      const split = result as PaneSplit;
      expect(split.axis).toBe('horizontal');
      expect(split.children.map((c) => c.id)).toEqual(['l1', 'l2']);
      expect(split.ratios).toEqual([0.5, 0.5]);
    });

    it('moves a leaf to the bottom of another leaf in a complex tree', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'l1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'l2');
      const l3 = createLeaf({ kind: 'terminal', sessionId: 's-3' }, 'l3');
      const root = createSplit('vertical', [l1, l2, l3], [0.33, 0.33, 0.34]);

      // Move l1 to the bottom of l2
      const result = moveLeafToEdge(root, 'l1', 'l2', 'bottom') as PaneSplit;
      expect(result.axis).toBe('vertical');
      expect(result.children).toHaveLength(2); // column with (l2+l1) and column with l3

      const col1 = result.children[0] as PaneSplit;
      expect(col1.type).toBe('split');
      expect(col1.axis).toBe('horizontal');
      expect(col1.children.map((c) => c.id)).toEqual(['l2', 'l1']);
      expect(col1.ratios).toEqual([0.5, 0.5]);

      expect(result.children[1].id).toBe('l3');
    });

    it('preserves ratio balance and total sum = 1 when moving into existing split axis', () => {
      const l1 = createLeaf({ kind: 'terminal', sessionId: 's-1' }, 'l1');
      const l2 = createLeaf({ kind: 'terminal', sessionId: 's-2' }, 'l2');
      const l3 = createLeaf({ kind: 'terminal', sessionId: 's-3' }, 'l3');
      const root = createSplit('vertical', [l1, l2, l3], [0.2, 0.5, 0.3]);

      // Move l1 to the left of l2
      const result = moveLeafToEdge(root, 'l1', 'l2', 'left') as PaneSplit;
      const sum = result.ratios.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 4);
    });
  });
});
