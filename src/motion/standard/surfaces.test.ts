import { describe, expect, it } from 'vitest';
import { surfaceMotion, surfaceOrigin } from './surfaces';

describe('standard surfaces (S5–S8, S14)', () => {
  it('enters a dialog on a spring-friendly transform and exits faster', () => {
    const dialog = surfaceMotion('dialog');
    expect(dialog.initial).toMatchObject({ opacity: 0, scale: 0.985 });
    expect(dialog.animate).toMatchObject({ opacity: 1, scale: 1 });
    expect(dialog.exit).toMatchObject({ opacity: 0, scale: 0.99 });
    expect(dialog.transition).toMatchObject({ type: 'spring', stiffness: 150, damping: 25 });
  });

  it('keeps scrims opacity-only', () => {
    const scrim = surfaceMotion('scrim');
    expect(scrim.initial).toEqual({ opacity: 0 });
    expect(scrim.animate).toEqual({ opacity: 1 });
    expect(scrim.exit).toMatchObject({ opacity: 0 });
  });

  it('never animates a panel width', () => {
    const panel = surfaceMotion('panel');
    expect(panel.initial).toMatchObject({ opacity: 0, x: 16 });
    expect(panel.animate).toMatchObject({ opacity: 1, x: 0 });
    expect(JSON.stringify(panel)).not.toContain('width');
  });

  it('matches a legacy presence timer when asked', () => {
    const quick = surfaceMotion('dialog', { exitMs: 140 });
    const exit = quick.exit as { transition?: { duration?: number } };
    expect(exit.transition?.duration).toBeCloseTo(0.14);
  });

  it('resolves anchored origins', () => {
    expect(surfaceOrigin('top')).toBe('top center');
    expect(surfaceOrigin('bottom')).toBe('bottom center');
    expect(surfaceOrigin()).toBe('center center');
  });
});
