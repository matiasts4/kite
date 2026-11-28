import { describe, it, expect } from 'vitest';

const fsSpecifier = ['node', 'fs'].join(':');
const pathSpecifier = ['node', 'path'].join(':');
const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
  readFileSync: (filePath: string, encoding: 'utf8') => string;
};
const path = (await import(/* @vite-ignore */ pathSpecifier)) as {
  resolve: (...segments: string[]) => string;
};

const visualLanguageCss = fs.readFileSync(
  path.resolve('src/visual-language.css'),
  'utf8'
);

const settingsCss = fs.readFileSync(
  path.resolve('src/components/views/settings.css'),
  'utf8'
);

describe('Visual Language & Settings CSS contracts', () => {
  it('adapts TitleBar .mode-toggle--stadium to theme-aware translucent glass while preserving protected geometry', () => {
    expect(visualLanguageCss).toContain('height: 32px !important;');
    expect(visualLanguageCss).toContain('border-radius: 9999px !important;');
    expect(visualLanguageCss).toContain('padding: 3px !important;');
    expect(visualLanguageCss).toContain('gap: 2px !important;');
    expect(visualLanguageCss).toContain('height: 26px !important;');
    expect(visualLanguageCss).toContain('padding: 0 16px !important;');
    expect(visualLanguageCss).toContain('min-width: 68px !important;');

    // No hardcoded opaque dark hexes for stadium track, backdrop, or item labels
    expect(visualLanguageCss).not.toContain('#090a0d');
    expect(visualLanguageCss).not.toContain('#26282d');
    expect(visualLanguageCss).not.toContain('#838891');

    // Explicit glass + light-mode overrides for .mode-toggle--stadium
    expect(visualLanguageCss).toMatch(/html\[data-surface-glass='true'\][^{]*\.mode-toggle--stadium/);
    expect(visualLanguageCss).toMatch(/html\[data-theme='light'\][^{]*\.mode-toggle--stadium/);
  });

  it('separates glass border hierarchy, lifts elevated card fills, and calibrates modal cards', () => {
    expect(visualLanguageCss).not.toContain(
      'color-mix(in srgb, var(--accent, #5c8fff) 18%, var(--vl-stroke-strong))'
    );
    expect(visualLanguageCss).toContain('--glass-card-border:');
    expect(visualLanguageCss).toContain('--glass-card-border-hover:');
    expect(visualLanguageCss).toContain('--glass-inner-border:');
    expect(visualLanguageCss).toContain('--glass-field-bg:');
    expect(visualLanguageCss).toMatch(/html\[data-surface-glass='true'\]\[data-theme='light'\][^{]*\{[\s\S]*--glass-card-border:/);
    expect(visualLanguageCss).toMatch(/\.settings-modal-window[\s\S]*\.qt-modal-container[\s\S]*--glass-elevated-bg:/);
  });

  it('keeps Settings error text readable and segmented radii/heights aligned to semantic scale', () => {
    expect(settingsCss).not.toMatch(/color:\s*var\(--danger-fill/);
    expect(settingsCss).not.toContain('calc(var(--radius-chip, 6px) + 1px)');
    expect(settingsCss).toMatch(/\.ui-segmented__item\s*\{[^}]*height:\s*var\(--vl-control-sm,\s*26px\)/);
  });
});
