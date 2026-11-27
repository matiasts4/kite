import { describe, it, expect, beforeEach } from 'vitest';
import {
  BACKDROP_PRESETS,
  BACKDROP_WALLPAPER_URLS,
  DEFAULT_THEME_CUSTOMIZATIONS,
  HERO_FIGURE_OPTIONS,
  VISUAL_THEME_PACKS,
  getThemePackById,
  resolveThemeMode,
  getActivePaletteForState,
  resolveEffectiveBackdropPreset,
  resolveEffectiveHeroFigure,
  sanitizeThemeCustomizations,
  readThemeCustomizations,
  writeThemeCustomizations,
  applyThemeCustomizationsToDocument,
  exportThemeString,
  importThemePayload,
  sanitizeCustomImageUrl,
  resolveActiveDiffColors,
} from './themeCustomizations';

describe('themeCustomizations engine', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
    document.documentElement.removeAttribute('data-backdrop');
    document.documentElement.removeAttribute('data-figure');
    document.documentElement.removeAttribute('data-surface-glass');
    document.documentElement.removeAttribute('data-daltonized-diffs');
    document.documentElement.removeAttribute('style');
  });

  it('provides 12 rich visual theme packs across dark and light modes', () => {
    expect(VISUAL_THEME_PACKS.length).toBeGreaterThanOrEqual(12);
    const aurora = getThemePackById('aurora-studio');
    expect(aurora.mode).toBe('dark');
    expect(aurora.defaultBackdrop).toBe('aurora-mesh');
    expect(aurora.defaultFigure).toBe('orbital-constellation');

    const atelier = getThemePackById('warm-atelier');
    expect(atelier.mode).toBe('light');
    expect(atelier.defaultBackdrop).toBe('none');
    expect(atelier.defaultFigure).toBe('editorial-botanical');

    expect(getThemePackById('kite-dark').defaultBackdrop).toBe('none');
    expect(getThemePackById('tokyo-night').defaultBackdrop).toBe('aurora-mesh');
    expect(getThemePackById('dracula').defaultBackdrop).toBe('aurora-mesh');
    expect(getThemePackById('github-light').defaultBackdrop).toBe('none');
    expect(getThemePackById('solarized-light').defaultBackdrop).toBe('none');
    expect(getThemePackById('catppuccin-latte').defaultBackdrop).toBe('solar-horizon');

    const allowedBackdrops = new Set(['aurora-mesh', 'alpine-dusk', 'solar-horizon', 'none']);
    for (const pack of VISUAL_THEME_PACKS) {
      expect(allowedBackdrops.has(pack.defaultBackdrop)).toBe(true);
    }
  });

  it('migrates legacy backdrop presets cleanly and exposes Spanish descriptors', () => {
    expect(
      sanitizeThemeCustomizations({ backdrop: { preset: 'cyber-prism' } }).backdrop.preset
    ).toBe('aurora-mesh');
    expect(
      sanitizeThemeCustomizations({ backdrop: { preset: 'architect-grid' } }).backdrop.preset
    ).toBe('alpine-dusk');
    expect(
      sanitizeThemeCustomizations({ backdrop: { preset: 'editorial-paper' } }).backdrop.preset
    ).toBe('none');

    expect(BACKDROP_PRESETS.map((p) => p.id)).toEqual([
      'theme-default',
      'none',
      'aurora-mesh',
      'alpine-dusk',
      'solar-horizon',
      'event-horizon',
      'lunar-eclipse',
      'astral-nebula',
      'tokyo-rain',
      'misty-forest',
      'cloud-sea',
      'custom-image',
    ]);
    expect(BACKDROP_PRESETS.map((p) => p.label)).toEqual([
      'Predeterminado del tema',
      'Lienzo limpio',
      'Aurora Boreal',
      'Crepúsculo Alpino',
      'Horizonte Solar',
      'Horizonte de Eventos',
      'Claro de Luna',
      'Nebulosa Astral',
      'Tokio Sakura',
      'Bosque de Niebla',
      'Pradera Celeste',
      'Imagen personalizada',
    ]);
    expect(Object.keys(BACKDROP_WALLPAPER_URLS)).toEqual([
      'aurora-mesh',
      'alpine-dusk',
      'solar-horizon',
      'event-horizon',
      'lunar-eclipse',
      'astral-nebula',
      'tokyo-rain',
      'misty-forest',
      'cloud-sea',
    ]);
    expect(HERO_FIGURE_OPTIONS.map((f) => f.label)).toEqual([
      'Predeterminado del tema',
      'Compañero Pixel',
      'Prisma Isométrico',
      'Botánica Editorial',
      'Constelación Orbital',
      'Emblema Kite',
      'Anillo Cinético',
      'Minimalista (Sin figura)',
    ]);
  });

  it('resolves light, dark, and system modes and preserves darkThemeId and lightThemeId independently', () => {
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');

    const state = sanitizeThemeCustomizations({
      appearanceMode: 'dark',
      darkThemeId: 'tokyo-night',
      lightThemeId: 'solarized-light',
    });

    expect(getActivePaletteForState(state, 'dark')).toBe('tokyo-night');
    expect(getActivePaletteForState(state, 'light')).toBe('solarized-light');
  });

  it('resolves theme-default backdrop and figure from the active visual theme pack', () => {
    const pack = getThemePackById('tokyo-night');
    const state = sanitizeThemeCustomizations({
      darkThemeId: 'tokyo-night',
      backdrop: { preset: 'theme-default' },
      figure: { style: 'theme-default' },
    });

    expect(resolveEffectiveBackdropPreset(state, pack)).toBe('aurora-mesh');
    expect(resolveEffectiveHeroFigure(state, pack)).toBe('pixel-companion');
  });

  it('applies DOM attributes, glass tokens, contrast, daltonized diffs, and custom overrides', () => {
    const state = sanitizeThemeCustomizations({
      appearanceMode: 'dark',
      darkThemeId: 'dracula',
      backdrop: {
        preset: 'alpine-dusk',
        dimming: 40,
        blur: 12,
        grain: true,
        customImageUrl: '',
      },
      figure: {
        style: 'isometric-construct',
        showWatermark: true,
      },
      surface: {
        translucent: true,
        opacity: 76,
        blur: 22,
        contrast: 68,
      },
      overrides: {
        accent: '#ff55aa',
        surface: '#11131a',
        ink: '#f4f6fb',
        diffAdded: null,
        diffRemoved: null,
        daltonizedDiffs: true,
        uiFont: '"Inter", sans-serif',
        codeFont: '"JetBrains Mono", monospace',
      },
    });

    const applied = applyThemeCustomizationsToDocument(state);
    expect(applied.resolvedMode).toBe('dark');
    expect(applied.activePalette).toBe('dracula');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('dracula');
    expect(document.documentElement.getAttribute('data-backdrop')).toBe('alpine-dusk');
    expect(document.documentElement.getAttribute('data-figure')).toBe('isometric-construct');
    expect(document.documentElement.getAttribute('data-surface-glass')).toBe('true');
    expect(document.documentElement.getAttribute('data-daltonized-diffs')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--theme-surface-opacity')).toBe('76%');
    expect(document.documentElement.style.getPropertyValue('--theme-surface-blur')).toBe('22px');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff55aa');
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('"Inter", sans-serif');
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('"JetBrains Mono", monospace');
  });

  it('round-trips persistence in localStorage and migrates legacy theme/palette keys', () => {
    localStorage.setItem('kite.theme', 'light');
    localStorage.setItem('kite.palette', 'catppuccin-latte');

    const migrated = readThemeCustomizations();
    expect(migrated.appearanceMode).toBe('light');
    expect(migrated.lightThemeId).toBe('catppuccin-latte');
    expect(migrated.darkThemeId).toBe('kite-dark');

    const updated = {
      ...migrated,
      darkThemeId: 'nord',
    };
    writeThemeCustomizations(updated);
    const reread = readThemeCustomizations();
    expect(reread.darkThemeId).toBe('nord');
    expect(reread.lightThemeId).toBe('catppuccin-latte');
  });

  it('exports and imports kite-theme-v1 strings, external *-theme-v1 strings, and JSON override objects', () => {
    const custom = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'dark',
      darkThemeId: 'aurora-studio',
      surface: { translucent: true, opacity: 80, blur: 20, contrast: 65 },
      overrides: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.overrides,
        accent: '#38bdf8',
      },
    });

    const exported = exportThemeString(custom);
    expect(exported.startsWith('kite-theme-v1:')).toBe(true);

    const imported = importThemePayload(exported);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.state.darkThemeId).toBe('aurora-studio');
      expect(imported.state.overrides.accent).toBe('#38bdf8');
      expect(imported.state.surface.contrast).toBe(65);
    }

    // Compatible external *-theme-v1 payload
    const externalV1 =
      'external-theme-v1:{"codeThemeId":"tokyo-night","variant":"dark","theme":{"accent":"#7aa2f7","contrast":72,"fonts":{"code":"JetBrains Mono","ui":"Inter"},"ink":"#c0caf5","opaqueWindows":false,"semanticColors":{"diffAdded":"#4fd6be","diffRemoved":"#f7768e","skill":"#bb9af7"},"surface":"#1a1b26"}}';
    const extResult = importThemePayload(externalV1);
    expect(extResult.ok).toBe(true);
    if (extResult.ok) {
      expect(extResult.state.appearanceMode).toBe('dark');
      expect(extResult.state.darkThemeId).toBe('tokyo-night');
      expect(extResult.state.surface.translucent).toBe(true);
      expect(extResult.state.surface.contrast).toBe(72);
      expect(extResult.state.overrides.accent).toBe('#7aa2f7');
      expect(extResult.state.overrides.diffAdded).toBe('#4fd6be');
    }

    // Invalid payload
    const bad = importThemePayload('not-valid-json');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain('Formato de tema inválido');
    }
  });

  it('sanitizes customImageUrl safely and resolves daltonized/custom diff colors', () => {
    expect(sanitizeCustomImageUrl('https://example.com/wall.png')).toBe('https://example.com/wall.png');
    expect(sanitizeCustomImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(sanitizeCustomImageUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeCustomImageUrl('https://x.com/a.png");background:red')).toBe('');

    const daltonizedDark = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'dark',
      overrides: { ...DEFAULT_THEME_CUSTOMIZATIONS.overrides, daltonizedDiffs: true },
    });
    expect(resolveActiveDiffColors(daltonizedDark, 'dark')).toEqual({
      diffAdded: '#38bdf8',
      diffRemoved: '#f59e0b',
      hasCustomDiffColors: true,
    });

    const aurora = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      darkThemeId: 'aurora-studio',
    });
    applyThemeCustomizationsToDocument(aurora);
    expect(document.documentElement.style.getPropertyValue('--sidebar-fill')).toBe('#0a101d');
    expect(document.documentElement.style.getPropertyValue('--diff-addition')).toBe('#34d399');
    expect(document.documentElement.getAttribute('data-surface-glass')).toBe('true');

    // Legacy 0.1.59 default opacity (82) and dimming (24) migrate to translucent 56% and 14%
    const migrated = sanitizeThemeCustomizations({
      backdrop: { preset: 'solar-horizon', dimming: 24, blur: 0 },
      surface: { translucent: false, opacity: 82, blur: 18, contrast: 50 },
    });
    expect(migrated.surface.opacity).toBe(56);
    expect(migrated.backdrop.dimming).toBe(14);
    applyThemeCustomizationsToDocument(migrated);
    expect(document.documentElement.getAttribute('data-surface-glass')).toBe('true');
  });

  it('preserves surface elevation between --pane, --composer, and --menu-plate and keeps --accent-fill solid', () => {
    const aurora = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'dark',
      darkThemeId: 'aurora-studio',
    });
    applyThemeCustomizationsToDocument(aurora);
    expect(document.documentElement.style.getPropertyValue('--pane')).toBe('#0d1424');
    expect(document.documentElement.style.getPropertyValue('--composer')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--menu-plate')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#38bdf8');
    expect(document.documentElement.style.getPropertyValue('--accent-fill')).toBe('');

    const customOverrides = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'dark',
      darkThemeId: 'kite-dark',
      overrides: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.overrides,
        surface: '#11131a',
        accent: '#ff55aa',
      },
    });
    applyThemeCustomizationsToDocument(customOverrides);
    expect(document.documentElement.style.getPropertyValue('--pane')).toBe('#11131a');
    expect(document.documentElement.style.getPropertyValue('--composer')).not.toBe('#11131a');
    expect(document.documentElement.style.getPropertyValue('--composer')).toContain('color-mix');
    expect(document.documentElement.style.getPropertyValue('--menu-plate')).not.toBe('#11131a');
    expect(document.documentElement.style.getPropertyValue('--menu-plate')).toContain('color-mix');
    expect(document.documentElement.style.getPropertyValue('--accent-fill')).toBe('#ff55aa');
    expect(document.documentElement.style.getPropertyValue('--accent-tint')).toContain('color-mix');
  });
});
