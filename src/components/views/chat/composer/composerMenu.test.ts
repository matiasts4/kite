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

async function readRepoFile(relativePath: string): Promise<string> {
  const fsSpecifier = ['node', 'fs'].join(':');
  const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
    readFileSync: (filePath: string, encoding: 'utf8') => string;
  };
  return fs.readFileSync(relativePath, 'utf8');
}

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

  it('keeps the top and bottom strips flush against the composer without undefined theme tokens', async () => {
    const composerCss = await readRepoFile('src/components/views/chat/composer/composer.css');
    const stripBlock = composerCss.match(/\.kite-composer-context-strip\s*\{[^}]*\}/)?.[0] ?? '';
    expect(stripBlock).toContain('margin-top: 0;');
    expect(stripBlock).not.toMatch(/margin-top:\s*-/);

    const topStripBlock = composerCss.match(/\.kite-composer-top-strip\s*\{[^}]*\}/)?.[0] ?? '';
    expect(topStripBlock).toContain('margin-bottom: 0;');
    expect(topStripBlock).not.toMatch(/margin-bottom:\s*-/);
    expect(topStripBlock).toContain('border-bottom: none;');

    const undefinedTokenPattern = /var\(--(?:border|secondary-label|muted-foreground|primary|destructive|canvas|surface|surface-raised)\b/;
    expect(composerCss).not.toMatch(undefinedTokenPattern);
    for (const source of POPOVERS) {
      expect(source).not.toMatch(undefinedTokenPattern);
    }
  });

  it('hides inactive mode layers and active child tab/pane layers to prevent bleed-through', async () => {
    const indexCss = await readRepoFile('src/index.css');
    const modeLayerBlock = indexCss.match(/\.mode-layer\s*\{[^}]*\}/)?.[0] ?? '';
    const visibleModeLayerBlock = indexCss.match(/\.mode-layer--visible\s*\{[^}]*\}/)?.[0] ?? '';

    expect(modeLayerBlock).toContain('display: none;');
    expect(visibleModeLayerBlock).toContain('display: flex;');
    expect(indexCss).toContain('.mode-layer:not(.mode-layer--visible) .workspace-tab-layer--active');
    expect(indexCss).toMatch(/\.mode-layer\[aria-hidden=['"]true['"]\] \.workspace-tab-layer--active/);
    expect(indexCss).toContain('.mode-layer:not(.mode-layer--visible) .main-pane__layer--visible');
    expect(indexCss).toContain('.workspace-shell:has(> .app-browser-sidebar--fullscreen)');
  });

  it('uses higher-density translucent composer tokens across the main composer and top/bottom strips', async () => {
    const composerCss = await readRepoFile('src/components/views/chat/composer/composer.css');
    const visualLangCss = await readRepoFile('src/visual-language.css');

    const mainBlock = composerCss.match(/\.kite-composer-main\s*\{[^}]*\}/)?.[0] ?? '';
    const bottomStripBlock = composerCss.match(/\.kite-composer-context-strip\s*\{[^}]*\}/)?.[0] ?? '';
    const topStripBlock = composerCss.match(/\.kite-composer-top-strip\s*\{[^}]*\}/)?.[0] ?? '';

    expect(mainBlock).toContain('var(--glass-composer-bg');
    expect(bottomStripBlock).toContain('var(--glass-composer-strip-bg');
    expect(topStripBlock).toContain('var(--glass-composer-strip-bg');
    expect(visualLangCss).toContain('--glass-composer-bg:');
    expect(visualLangCss).toContain('--glass-composer-strip-bg:');
  });
});
