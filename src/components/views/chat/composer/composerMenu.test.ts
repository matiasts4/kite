import { describe, expect, it } from 'vitest';
import type { CSSProperties } from 'react';
import { composerMenu } from '../../../../motion/standard/tokens';
import { composerMenuStyle } from './composerMenu';
import attachMenu from './AttachMenuPopover.tsx?raw';
import modelPicker from './ModelPickerPopover.tsx?raw';
import effortSlider from './EffortSliderPopover.tsx?raw';
import connectionPicker from './ConnectionPickerPopover.tsx?raw';
import workModePicker from './WorkModePickerPopover.tsx?raw';
import permissionPicker from './PermissionPickerPopover.tsx?raw';
import contextStrip from './ComposerContextStrip.tsx?raw';

const POPOVERS = [
  attachMenu,
  modelPicker,
  effortSlider,
  connectionPicker,
  workModePicker,
  permissionPicker,
  contextStrip,
];

describe('composer menu motion', () => {
  it('drifts 4px toward the control in 80ms and does not scale', () => {
    const style = composerMenuStyle({ top: '10px' }) as CSSProperties & Record<string, string>;
    expect(style.animationDuration).toBe(`${composerMenu.durationMs}ms`);
    expect(style.animationTimingFunction).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(style['--composer-menu-drift']).toBe('4px');
    expect(String(style.animationTimingFunction)).not.toContain('scale');
    expect(Number.parseFloat(String(style['--composer-menu-exit-ms']))).toBeLessThan(composerMenu.durationMs);
  });

  it('is the motion used by every footer menu', () => {
    for (const source of POPOVERS) {
      expect(source).toContain('composerMenuStyle');
      expect(source).not.toContain('kiteFadeIn');
    }
  });
});
