import { describe, expect, it } from 'vitest';
import { effortBarHeights, resolveEffortGlyph } from './effortGlyph';

describe('resolveEffortGlyph', () => {
  it('fills rising bars up to the selected ordinary level', () => {
    const glyph = resolveEffortGlyph(['low', 'medium', 'high', 'max'], 'medium');
    expect(glyph.disabled).toBe(false);
    expect(glyph.heights).toEqual(effortBarHeights(3));
    expect(glyph.filledUntil).toBe(1);
    expect(glyph.namedLabel).toBeNull();
  });

  it('shows the named label beside a filled scale', () => {
    const glyph = resolveEffortGlyph(['low', 'high', 'ultra'], 'ultra');
    expect(glyph.namedLabel).toBe('ultra');
  });

  it('disables a model that advertises fewer than two levels', () => {
    const glyph = resolveEffortGlyph(['low'], 'low');
    expect(glyph.disabled).toBe(true);
    expect(glyph.reason).toContain('does not advertise reasoning effort levels.');
  });
});
