import { describe, expect, it } from 'vitest';
import { createLabTokens } from '../animate/tokens';
import { eases, scale, springs, tweens } from './tokens';

describe('production motion standard tokens (S2, S4)', () => {
  it('keeps the Animate UI role springs', () => {
    expect(springs.press).toMatchObject({ type: 'spring', stiffness: 550, damping: 30 });
    expect(springs.pop).toMatchObject({ type: 'spring', stiffness: 400, damping: 29 });
    expect(springs.dialog).toMatchObject({ type: 'spring', stiffness: 150, damping: 25 });
    expect(springs.toast).toMatchObject({ type: 'spring', stiffness: 280, damping: 24 });
    expect(springs.selection).toMatchObject({ type: 'spring', stiffness: 300, damping: 30 });
    expect(springs.reflow).toMatchObject({ type: 'spring', stiffness: 500, damping: 40 });
    expect(springs.thumb).toMatchObject({ type: 'spring', stiffness: 300, damping: 25 });
    expect(springs.number).toMatchObject({ type: 'spring', stiffness: 90, damping: 50 });
    expect(springs.bounce).toMatchObject({ type: 'spring', stiffness: 200, damping: 16 });
  });

  it('keeps the tween curves and the press scale', () => {
    expect(tweens.menu).toEqual({ duration: 0.22, ease: eases.soft });
    expect(tweens.dismiss).toEqual({ duration: 0.2, ease: eases.away });
    expect(tweens.swap).toEqual({ duration: 0.15, ease: eases.out });
    expect(tweens.instant).toEqual({ duration: 0 });
    expect(scale.press).toBe(0.97);
  });

  it('is the same source the dev lab derives from', () => {
    const lab = createLabTokens('subtle', 1);
    expect(lab.springs.press).toEqual(springs.press);
    expect(lab.springs.dialog).toEqual(springs.dialog);
    expect(lab.tweens.menu).toEqual(tweens.menu);
    expect(lab.scale).toBe(scale);
  });
});
