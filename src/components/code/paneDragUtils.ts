import type { PaneDropEdge } from './treeUtils';

export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DropZoneCalculation {
  edge: PaneDropEdge | null;
  previewRect: PaneRect;
}

export const DRAG_ACTIVATION_THRESHOLD_PX = 4;
export const DEFAULT_EDGE_ZONE_RATIO = 0.25;

/**
 * Calculates whether a pointer position (x, y) targets an edge (split) or center (swap)
 * of a pane rectangle.
 *
 * - Outer 25% boundary perimeter => edge split ('left' | 'right' | 'top' | 'bottom')
 * - Inner 50% core area => center pane swap (null)
 */
export function calculateDropZone(
  rect: PaneRect,
  x: number,
  y: number,
  edgeThresholdRatio = DEFAULT_EDGE_ZONE_RATIO
): DropZoneCalculation | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (
    x < rect.left ||
    x > rect.left + rect.width ||
    y < rect.top ||
    y > rect.top + rect.height
  ) {
    return null;
  }

  const u = (x - rect.left) / rect.width;
  const v = (y - rect.top) / rect.height;

  const distances: Array<{ dist: number; edge: PaneDropEdge }> = [
    { dist: u, edge: 'left' },
    { dist: 1 - u, edge: 'right' },
    { dist: v, edge: 'top' },
    { dist: 1 - v, edge: 'bottom' },
  ];

  distances.sort((a, b) => a.dist - b.dist);
  const closest = distances[0];

  if (closest && closest.dist < edgeThresholdRatio) {
    const edge = closest.edge;
    switch (edge) {
      case 'left':
        return {
          edge,
          previewRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width / 2,
            height: rect.height,
          },
        };
      case 'right':
        return {
          edge,
          previewRect: {
            left: rect.left + rect.width / 2,
            top: rect.top,
            width: rect.width / 2,
            height: rect.height,
          },
        };
      case 'top':
        return {
          edge,
          previewRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height / 2,
          },
        };
      case 'bottom':
        return {
          edge,
          previewRect: {
            left: rect.left,
            top: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height / 2,
          },
        };
    }
  }

  // Inner center zone: full pane swap preview
  return {
    edge: null,
    previewRect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
  };
}
