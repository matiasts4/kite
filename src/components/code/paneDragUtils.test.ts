import { describe, it, expect } from 'vitest';
import { calculateDropZone, type PaneRect } from './paneDragUtils';

describe('paneDragUtils - Drop Zone Geometry Calculations', () => {
  const rect: PaneRect = {
    left: 100,
    top: 200,
    width: 400,
    height: 400,
  };

  it('detects left edge drop within the outer 25% boundary', () => {
    // x = 120 (5% from left edge), y = 400 (center vertically)
    const result = calculateDropZone(rect, 120, 400);
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('left');
    expect(result?.previewRect).toEqual({
      left: 100,
      top: 200,
      width: 200,
      height: 400,
    });
  });

  it('detects right edge drop within the outer 25% boundary', () => {
    // x = 480 (5% from right edge), y = 400
    const result = calculateDropZone(rect, 480, 400);
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('right');
    expect(result?.previewRect).toEqual({
      left: 300,
      top: 200,
      width: 200,
      height: 400,
    });
  });

  it('detects top edge drop within the outer 25% boundary', () => {
    // x = 300 (center horizontally), y = 220 (5% from top edge)
    const result = calculateDropZone(rect, 300, 220);
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('top');
    expect(result?.previewRect).toEqual({
      left: 100,
      top: 200,
      width: 400,
      height: 200,
    });
  });

  it('detects bottom edge drop within the outer 25% boundary', () => {
    // x = 300, y = 580 (5% from bottom edge)
    const result = calculateDropZone(rect, 300, 580);
    expect(result).not.toBeNull();
    expect(result?.edge).toBe('bottom');
    expect(result?.previewRect).toEqual({
      left: 100,
      top: 400,
      width: 400,
      height: 200,
    });
  });

  it('detects center zone swap within the inner 50% core area', () => {
    // x = 300 (50%), y = 400 (50%)
    const result = calculateDropZone(rect, 300, 400);
    expect(result).not.toBeNull();
    expect(result?.edge).toBeNull(); // center swap
    expect(result?.previewRect).toEqual({
      left: 100,
      top: 200,
      width: 400,
      height: 400, // full pane highlight
    });
  });

  it('returns null if pointer is outside rect bounds', () => {
    expect(calculateDropZone(rect, 50, 300)).toBeNull(); // to the left
    expect(calculateDropZone(rect, 550, 300)).toBeNull(); // to the right
    expect(calculateDropZone(rect, 300, 150)).toBeNull(); // above
    expect(calculateDropZone(rect, 300, 650)).toBeNull(); // below
  });

  it('returns null if rect has non-positive dimensions', () => {
    expect(calculateDropZone({ left: 0, top: 0, width: 0, height: 100 }, 10, 10)).toBeNull();
  });
});
