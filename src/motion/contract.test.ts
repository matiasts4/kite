import { afterEach, describe, expect, it } from 'vitest';
import {
  followLiveEdge,
  isAtLiveEdge,
  prefersReducedMotion,
} from './contract';

describe('live edge follow', () => {
  it('treats the bottom 48px as the live edge', () => {
    expect(isAtLiveEdge(1000, 900, 80)).toBe(true);
    expect(isAtLiveEdge(1000, 800, 80)).toBe(false);
  });

  it('advances only by the new height while pinned', () => {
    expect(followLiveEdge(400, 24, true)).toBe(424);
  });

  it('leaves a reader who scrolled up in place', () => {
    expect(followLiveEdge(120, 24, false)).toBe(120);
    expect(followLiveEdge(120, 0, true)).toBe(120);
    expect(followLiveEdge(120, -8, true)).toBe(120);
  });
});

describe('prefersReducedMotion', () => {
  afterEach(() => {
    delete document.documentElement.dataset.motion;
  });

  it('honors the lab override before the media query', () => {
    document.documentElement.dataset.motion = 'reduce';
    expect(prefersReducedMotion()).toBe(true);
    document.documentElement.dataset.motion = 'full';
    expect(prefersReducedMotion()).toBe(false);
  });
});
