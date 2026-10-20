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
});
