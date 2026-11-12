import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { AppIntro, releaseBootCover } from './AppIntro';

afterEach(() => {
  cleanup();
  document.getElementById('boot')?.remove();
  delete document.documentElement.dataset.bootReleased;
  MotionGlobalConfig.skipAnimations = true;
});

describe('releaseBootCover', () => {
  it('sets data-boot-released and removes #boot, and is idempotent', () => {
    document.body.insertAdjacentHTML('afterbegin', '<div id="boot" class="boot">cover</div>');

    releaseBootCover();
    releaseBootCover();

    expect(document.documentElement.getAttribute('data-boot-released')).toBe('true');
    expect(document.getElementById('boot')).toBeNull();
  });
});

describe('AppIntro first frame', () => {
  it('does not leave the scrim at opacity 0 when open with default props', () => {
    MotionGlobalConfig.skipAnimations = false;
    render(<AppIntro open />);

    const scrim = screen.getByRole('status', { name: 'Starting Kite' });
    expect(scrim.style.opacity).not.toBe('0');
  });

  it('applies an entrance initial when animateIn is requested', () => {
    MotionGlobalConfig.skipAnimations = false;
    render(<AppIntro open animateIn />);

    const scrim = screen.getByRole('status', { name: 'Starting Kite' });
    expect(scrim.style.opacity).toBe('0');
  });
});
