import { describe, expect, it } from 'vitest';
import { createLabTokens } from './tokens';

describe('Animate UI motion tokens (S3, S4)', () => {
  it('ports the role springs from tokens.md at tempo 1', () => {
    const { springs } = createLabTokens('subtle', 1);
    expect(springs.press).toMatchObject({ type: 'spring', stiffness: 550, damping: 30, restSpeed: 10 });
    expect(springs.pop).toMatchObject({ type: 'spring', stiffness: 400, damping: 29 });
    expect(springs.dialog).toMatchObject({ type: 'spring', stiffness: 150, damping: 25 });
    expect(springs.toast).toMatchObject({ type: 'spring', stiffness: 280, damping: 24 });
    expect(springs.selection).toMatchObject({ type: 'spring', stiffness: 300, damping: 30 });
    expect(springs.highlight).toMatchObject({ type: 'spring', stiffness: 500, damping: 40 });
    expect(springs.reflow).toMatchObject({ type: 'spring', stiffness: 500, damping: 40 });
    expect(springs.thumb).toMatchObject({ type: 'spring', stiffness: 300, damping: 25 });
    expect(springs.number).toMatchObject({ type: 'spring', stiffness: 90, damping: 50 });
  });

  it('keeps the tween curves from tokens.md', () => {
    const { tweens } = createLabTokens('subtle', 1);
    expect(tweens.menu).toEqual({ duration: 0.22, ease: [0.215, 0.61, 0.355, 1] });
    expect(tweens.dismiss).toEqual({ duration: 0.2, ease: [0.33, 0.17, 0.67, 0.5] });
    expect(tweens.swap).toEqual({ duration: 0.15, ease: [0.23, 1, 0.32, 1] });
    expect(tweens.instant).toEqual({ duration: 0 });
  });

  it('paces stiffness by tempo^2, damping and durations by tempo', () => {
    const fast = createLabTokens('subtle', 2);
    expect(fast.springs.press).toMatchObject({ stiffness: 137.5, damping: 15, restSpeed: 10 });
    expect(fast.tweens.menu.duration).toBeCloseTo(0.44);
  });

  it('derives level travel, blur, stagger and the expressive reflow spring', () => {
    const subtle = createLabTokens('subtle', 1);
    const more = createLabTokens('more', 1);
    const expressive = createLabTokens('expressive', 1);
    expect([subtle.travel(8), more.travel(8), expressive.travel(8)]).toEqual([8, 12, 19.2]);
    expect([subtle.surfaceBlur, more.surfaceBlur]).toEqual(['blur(0px)', 'blur(4px)']);
    expect([subtle.stagger, more.stagger, expressive.stagger]).toEqual([0, 0, 0.03]);
    expect(expressive.springs.reflow).toMatchObject({ stiffness: 200, damping: 16 });
    expect(more.springs.press).toMatchObject({ stiffness: 550, damping: 30 });
  });

  it('keeps the scale, blur and shift tables', () => {
    const { scale, blur, shift } = createLabTokens('subtle', 1);
    expect(scale.press).toBe(0.97);
    expect(blur.surface).toBe('blur(4px)');
    expect(shift.tabs).toBe(12);
  });
});
