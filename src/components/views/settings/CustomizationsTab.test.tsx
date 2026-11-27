import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomizationsTab } from './CustomizationsTab';
import {
  BACKDROP_PRESETS,
  DEFAULT_THEME_CUSTOMIZATIONS,
  HERO_FIGURE_OPTIONS,
  VISUAL_THEME_PACKS,
  sanitizeThemeCustomizations,
  type KiteThemeCustomizations,
} from '../../../lib/themeCustomizations';

describe('CustomizationsTab UI overhaul', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders 3-mode switcher (Claro, Oscuro, Sistema) and all 12 rich Visual Theme Pack miniature cards', async () => {
    const user = userEvent.setup();
    const onToggleMode = vi.fn();
    const onSelectTheme = vi.fn();

    render(
      <CustomizationsTab
        mode="dark"
        appearanceMode="dark"
        palette="kite-dark"
        customizations={DEFAULT_THEME_CUSTOMIZATIONS}
        onToggleMode={onToggleMode}
        onSelectTheme={onSelectTheme}
        onUpdateCustomizations={vi.fn()}
        onResetThemeOverrides={vi.fn()}
        onResetAllCustomizations={vi.fn()}
      />
    );

    const lightBtn = screen.getByRole('button', { name: /^Claro$/i });
    const darkBtn = screen.getByRole('button', { name: /^Oscuro$/i });
    const systemBtn = screen.getByRole('button', { name: /^Sistema$/i });
    expect(darkBtn).toHaveAttribute('aria-pressed', 'true');
    expect(lightBtn).toHaveAttribute('aria-pressed', 'false');
    expect(systemBtn).toHaveAttribute('aria-pressed', 'false');

    await user.click(systemBtn);
    expect(onToggleMode).toHaveBeenCalledWith('system');

    for (const pack of VISUAL_THEME_PACKS) {
      expect(screen.getByText(pack.name)).toBeInTheDocument();
    }

    expect(document.querySelectorAll('[data-testid^="stage-backdrop"]')).toHaveLength(0);
    expect(document.querySelectorAll('.theme-preview__backdrop').length).toBeGreaterThan(0);

    const auroraCard = screen.getByRole('button', { name: /Aurora Studio/i });
    await user.click(auroraCard);
    expect(onSelectTheme).toHaveBeenCalledWith('aurora-studio', 'dark');
  });

  it('configures Stage Backdrop presets, custom image URL, dimming, blur, grain, Hero Figures, and watermark', async () => {
    const user = userEvent.setup();
    const onUpdateCustomizations = vi.fn();

    const state: KiteThemeCustomizations = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      backdrop: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.backdrop,
        preset: 'custom-image',
        customImageUrl: '',
      },
    });

    render(
      <CustomizationsTab
        mode="dark"
        appearanceMode="dark"
        palette="kite-dark"
        customizations={state}
        onToggleMode={vi.fn()}
        onSelectTheme={vi.fn()}
        onUpdateCustomizations={onUpdateCustomizations}
        onResetThemeOverrides={vi.fn()}
        onResetAllCustomizations={vi.fn()}
      />
    );

    const auroraPreset = BACKDROP_PRESETS.find((p) => p.id === 'aurora-mesh');
    expect(auroraPreset).toBeDefined();
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
    await user.click(
      screen.getByRole('button', { name: new RegExp(`^${auroraPreset!.label}`, 'i') })
    );
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        backdrop: expect.objectContaining({ preset: 'aurora-mesh' }),
      })
    );

    const urlInput = screen.getByLabelText(/URL de imagen de fondo personalizada/i);
    fireEvent.change(urlInput, { target: { value: 'https://example.com/bg.png' } });
    await user.click(screen.getByRole('button', { name: /Aplicar imagen/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        backdrop: expect.objectContaining({
          preset: 'custom-image',
          customImageUrl: 'https://example.com/bg.png',
        }),
      })
    );

    const dimSlider = screen.getByLabelText(/Atenuación del fondo/i);
    fireEvent.change(dimSlider, { target: { value: '60' } });
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        backdrop: expect.objectContaining({ dimming: 60 }),
      })
    );

    const blurSlider = screen.getByLabelText(/Desenfoque del fondo/i);
    fireEvent.change(blurSlider, { target: { value: '14' } });
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        backdrop: expect.objectContaining({ blur: 14 }),
      })
    );

    await user.click(screen.getByRole('switch', { name: /Grano de película/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        backdrop: expect.objectContaining({ grain: true }),
      })
    );

    const pixelFigure = HERO_FIGURE_OPTIONS.find((f) => f.id === 'pixel-companion');
    expect(pixelFigure).toBeDefined();
    await user.click(
      screen.getByRole('button', { name: new RegExp(`^${pixelFigure!.label}`, 'i') })
    );
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        figure: expect.objectContaining({ style: 'pixel-companion' }),
      })
    );

    await user.click(screen.getByRole('switch', { name: /Marca de agua en el fondo/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        figure: expect.objectContaining({ showWatermark: true }),
      })
    );
  });

  it('controls Frosted Glass, Opacity, Blur, Contrast, Overrides, Daltonized Diffs, Fonts, and Reset Overrides', async () => {
    const user = userEvent.setup();
    const onUpdateCustomizations = vi.fn();
    const onResetThemeOverrides = vi.fn();

    render(
      <CustomizationsTab
        mode="dark"
        appearanceMode="dark"
        palette="kite-dark"
        customizations={DEFAULT_THEME_CUSTOMIZATIONS}
        onToggleMode={vi.fn()}
        onSelectTheme={vi.fn()}
        onUpdateCustomizations={onUpdateCustomizations}
        onResetThemeOverrides={onResetThemeOverrides}
        onResetAllCustomizations={vi.fn()}
      />
    );

    await user.click(screen.getByRole('switch', { name: /Superficies translúcidas/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: expect.objectContaining({ translucent: true }),
      })
    );

    fireEvent.change(screen.getByLabelText(/Opacidad de paneles/i), { target: { value: '70' } });
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: expect.objectContaining({ opacity: 70 }),
      })
    );

    fireEvent.change(screen.getByLabelText(/Contraste/i), { target: { value: '78' } });
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: expect.objectContaining({ contrast: 78 }),
      })
    );

    await user.click(screen.getByRole('switch', { name: /Diffs aptos para daltonismo/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({ daltonizedDiffs: true }),
      })
    );

    await user.click(screen.getByRole('combobox', { name: /Tipografía de interfaz/i }));
    await user.click(screen.getByRole('option', { name: /Serif Editorial/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({
          uiFont: '"Instrument Serif", "Newsreader", Georgia, Cambria, serif',
        }),
      })
    );

    await user.click(screen.getByRole('combobox', { name: /Tipografía de código/i }));
    await user.click(screen.getByRole('option', { name: /JetBrains Mono/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({
          codeFont: '"JetBrains Mono", "Fira Code", monospace',
        }),
      })
    );

    await user.click(screen.getByRole('button', { name: /Restablecer colores y fuentes/i }));
    expect(onResetThemeOverrides).toHaveBeenCalledTimes(1);
  });

  it('copies kite-theme-v1 string, exports JSON, and validates/imports portable theme payloads', async () => {
    const user = userEvent.setup();
    const onUpdateCustomizations = vi.fn();
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    render(
      <CustomizationsTab
        mode="dark"
        appearanceMode="dark"
        palette="aurora-studio"
        customizations={{
          ...DEFAULT_THEME_CUSTOMIZATIONS,
          darkThemeId: 'aurora-studio',
        }}
        onToggleMode={vi.fn()}
        onSelectTheme={vi.fn()}
        onUpdateCustomizations={onUpdateCustomizations}
        onResetThemeOverrides={vi.fn()}
        onResetAllCustomizations={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /Copiar cadena de tema/i }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(expect.stringMatching(/^kite-theme-v1:\{/));
    });
    expect(await screen.findByText(/Cadena kite-theme-v1:\{\.\.\.\} copiada/i)).toBeInTheDocument();

    const importBox = screen.getByLabelText(/Importar cadena de tema o JSON/i);
    fireEvent.change(importBox, { target: { value: '{not-valid-json' } });
    await user.click(screen.getByRole('button', { name: /Importar tema/i }));
    expect(screen.getByRole('status')).toHaveClass('customizations-status--error');
    expect(screen.getByRole('status')).toHaveTextContent(/Formato de tema inválido/i);

    fireEvent.change(importBox, {
      target: {
        value:
          'kite-theme-v1:{"appearanceMode":"light","lightThemeId":"warm-atelier","overrides":{"accent":"#c86446"}}',
      },
    });
    await user.click(screen.getByRole('button', { name: /Importar tema/i }));
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        appearanceMode: 'light',
        lightThemeId: 'warm-atelier',
        overrides: expect.objectContaining({ accent: '#c86446' }),
      })
    );
    expect(screen.getByRole('status')).toHaveClass('customizations-status--ok');
    expect(screen.getByRole('status')).toHaveTextContent(/Tema Warm Atelier importado/i);
  });

  it('renders the compact agent activity indicator gallery with color controls, live preview, and persistence', async () => {
    const user = userEvent.setup();

    render(
      <CustomizationsTab
        mode="dark"
        appearanceMode="dark"
        palette="kite-dark"
        customizations={DEFAULT_THEME_CUSTOMIZATIONS}
        onToggleMode={vi.fn()}
        onSelectTheme={vi.fn()}
        onUpdateCustomizations={vi.fn()}
        onResetThemeOverrides={vi.fn()}
        onResetAllCustomizations={vi.fn()}
      />
    );

    expect(screen.getByText(/Indicador de actividad de agentes/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Órbita clásica/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Destello vivo/i })).not.toBeInTheDocument();

    const matrixTile = screen.getByRole('button', { name: /Matriz neural/i });
    const kiteTile = screen.getByRole('button', { name: /Cometa Kite/i });
    const grid3x3Tile = screen.getByRole('button', { name: /Grilla 3×3/i });

    expect(matrixTile).toHaveAttribute('aria-pressed', 'true');
    expect(kiteTile).toHaveAttribute('aria-pressed', 'false');

    await user.click(kiteTile);
    expect(kiteTile).toHaveAttribute('aria-pressed', 'true');
    expect(matrixTile).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('kite.agentActivityIndicator')).toBe('kite-diamond');

    const preview = screen.getByTestId('agent-indicator-live-preview');
    const previewIndicators = preview.querySelectorAll('[data-testid="agent-status-indicator"]');
    expect(previewIndicators.length).toBeGreaterThanOrEqual(3);
    previewIndicators.forEach((node) => {
      expect(node).toHaveAttribute('data-variant', 'kite-diamond');
    });

    await user.click(grid3x3Tile);
    expect(grid3x3Tile).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('kite.agentActivityIndicator')).toBe('matrix-3x3');

    const accentColorBtn = screen.getByRole('button', { name: /Acento del tema/i });
    await user.click(accentColorBtn);
    expect(accentColorBtn).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('kite.agentActivityIndicatorColor')).toBe('accent');
    preview.querySelectorAll('[data-testid="agent-status-indicator"]').forEach((node) => {
      expect(node).toHaveAttribute('data-variant', 'matrix-3x3');
      expect(node).toHaveAttribute('data-color-mode', 'accent');
    });

    const cyanSwatch = screen.getByRole('button', { name: /^Cian$/i });
    await user.click(cyanSwatch);
    expect(cyanSwatch).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('kite.agentActivityIndicatorColor')).toBe('cyan');
    preview.querySelectorAll('[data-testid="agent-status-indicator"]').forEach((node) => {
      expect(node).toHaveAttribute('data-color-mode', 'cyan');
      expect(node).toHaveStyle({ color: '#38bdf8' });
    });

    const customColorTrigger = screen.getByRole('button', {
      name: /Color personalizado del indicador/i,
    });
    await user.click(customColorTrigger);
    const hexInput = screen.getByLabelText(/Código hexadecimal/i);
    fireEvent.change(hexInput, { target: { value: '#22d3ee' } });
    expect(localStorage.getItem('kite.agentActivityIndicatorColor')).toBe('#22d3ee');
    preview.querySelectorAll('[data-testid="agent-status-indicator"]').forEach((node) => {
      expect(node).toHaveAttribute('data-color-mode', '#22d3ee');
      expect(node).toHaveStyle({ color: '#22d3ee' });
    });
  });
});
