import type { PaneNode, PaneLeaf, PaneSplit, PaneAxis, PaneOccupant } from './types';

export function createLeaf(occupant: PaneOccupant, id?: string): PaneLeaf {
  return {
    type: 'leaf',
    id: id || globalThis.crypto.randomUUID(),
    occupant,
  };
}

export function createSplit(axis: PaneAxis, children: PaneNode[], ratios?: number[], id?: string): PaneSplit {
  const count = children.length;
  const initialRatios = ratios && ratios.length === count
    ? ratios
    : Array.from({ length: count }, () => 1 / count);
  return {
    type: 'split',
    id: id || globalThis.crypto.randomUUID(),
    axis,
    children,
    ratios: initialRatios,
  };
}

export function findLeaf(root: PaneNode, leafId: string): PaneLeaf | null {
  if (root.type === 'leaf') {
    return root.id === leafId ? root : null;
  }
  for (const child of root.children) {
    const found = findLeaf(child, leafId);
    if (found) return found;
  }
  return null;
}

export function getAllLeaves(root: PaneNode): PaneLeaf[] {
  if (root.type === 'leaf') {
    return [root];
  }
  return root.children.flatMap(getAllLeaves);
}

export function splitLeaf(
  root: PaneNode,
  targetLeafId: string,
  newLeaf: PaneLeaf,
  axis: PaneAxis
): PaneNode {
  const leaves = getAllLeaves(root);
  if (leaves.length === 0) {
    return newLeaf;
  }
  const effectiveTargetId = leaves.some((l) => l.id === targetLeafId)
    ? targetLeafId
    : (leaves[leaves.length - 1]?.id || targetLeafId);

  return splitLeafInternal(root, effectiveTargetId, newLeaf, axis);
}

function splitLeafInternal(
  root: PaneNode,
  targetLeafId: string,
  newLeaf: PaneLeaf,
  axis: PaneAxis
): PaneNode {
  if (root.type === 'leaf') {
    if (root.id === targetLeafId) {
      return createSplit(axis, [root, newLeaf], [0.5, 0.5]);
    }
    return root;
  }

  // If current split has same axis and contains targetLeafId directly:
  const targetIndex = root.children.findIndex((c) => c.type === 'leaf' && c.id === targetLeafId);
  if (root.axis === axis && targetIndex !== -1) {
    const newChildren = [...root.children];
    newChildren.splice(targetIndex + 1, 0, newLeaf);
    const count = newChildren.length;
    const newRatios = Array.from({ length: count }, () => 1 / count);
    return {
      ...root,
      children: newChildren,
      ratios: newRatios,
    };
  }

  return {
    ...root,
    children: root.children.map((child) => splitLeafInternal(child, targetLeafId, newLeaf, axis)),
  };
}

export function equalizeSplits(node: PaneNode): PaneNode {
  if (node.type === 'leaf') return node;
  const count = node.children.length;
  return {
    ...node,
    ratios: Array.from({ length: count }, () => 1 / count),
    children: node.children.map(equalizeSplits),
  };
}

export function swapAdjacent(root: PaneNode, leafId: string, direction: -1 | 1): PaneNode {
  if (root.type === 'leaf') return root;
  const index = root.children.findIndex((child) => child.type === 'leaf' && child.id === leafId);
  const next = index + direction;
  if (index >= 0 && next >= 0 && next < root.children.length) {
    const children = [...root.children];
    const ratios = [...root.ratios];
    [children[index], children[next]] = [children[next], children[index]];
    [ratios[index], ratios[next]] = [ratios[next], ratios[index]];
    return { ...root, children, ratios };
  }
  return {
    ...root,
    children: root.children.map((child) => swapAdjacent(child, leafId, direction)),
  };
}

export function removeLeaf(root: PaneNode, targetLeafId: string): PaneNode | null {
  if (root.type === 'leaf') {
    return root.id === targetLeafId ? null : root;
  }

  const updatedChildren: PaneNode[] = [];
  const updatedRatios: number[] = [];

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    const res = removeLeaf(child, targetLeafId);
    if (res !== null) {
      updatedChildren.push(res);
      updatedRatios.push(root.ratios[i] ?? 1);
    }
  }

  if (updatedChildren.length === 0) {
    return null;
  }

  if (updatedChildren.length === 1) {
    return updatedChildren[0];
  }

  const ratioSum = updatedRatios.reduce((a, b) => a + b, 0);
  const normalizedRatios = updatedRatios.map((r) => r / (ratioSum || 1));

  return {
    ...root,
    children: updatedChildren,
    ratios: normalizedRatios,
  };
}

export function updateSplitRatios(
  root: PaneNode,
  splitId: string,
  dividerIndex: number,
  deltaRatio: number
): PaneNode {
  if (root.type === 'leaf') {
    return root;
  }

  if (root.id === splitId) {
    const newRatios = [...root.ratios];
    const minRatio = 0.08;
    const r1 = newRatios[dividerIndex];
    const r2 = newRatios[dividerIndex + 1];

    if (r1 !== undefined && r2 !== undefined) {
      const total = r1 + r2;
      const nextR1 = Math.max(minRatio, Math.min(total - minRatio, r1 + deltaRatio));
      const nextR2 = total - nextR1;
      newRatios[dividerIndex] = nextR1;
      newRatios[dividerIndex + 1] = nextR2;
    }

    return {
      ...root,
      ratios: newRatios,
    };
  }

  return {
    ...root,
    children: root.children.map((child) =>
      updateSplitRatios(child, splitId, dividerIndex, deltaRatio)
    ),
  };
}
