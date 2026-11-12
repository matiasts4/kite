import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MotionProvider, useMotionStandard, useReduceMotion } from './context';

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function Probe() {
  const reduce = useReduceMotion();
  const standard = useMotionStandard();
  return (
    <span>
      {reduce ? 'reduce' : 'full'}:{standard.scale.press}
    </span>
  );
}

beforeEach(() => {
  delete document.documentElement.dataset.motion;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.motion;
});

describe('MotionProvider (S3)', () => {
  it('mirrors the motion preference to the document and exposes the tokens', () => {
    stubMatchMedia(false);
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>
    );
    expect(screen.getByText('full:0.97')).toBeInTheDocument();
    expect(document.documentElement.dataset.motion).toBe('full');
  });

  it('honors prefers-reduced-motion', () => {
    stubMatchMedia(true);
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>
    );
    expect(screen.getByText('reduce:0.97')).toBeInTheDocument();
    expect(document.documentElement.dataset.motion).toBe('reduce');
  });
});
