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

    fireEvent.change(screen.getByLabelText(/Tipografía de interfaz/i), {
      target: { value: '"Instrument Serif", "Newsreader", Georgia, Cambria, serif' },
    });
    expect(onUpdateCustomizations).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({
          uiFont: '"Instrument Serif", "Newsreader", Georgia, Cambria, serif',
        }),
      })
    );

    fireEvent.change(screen.getByLabelText(/Tipografía de código/i), {
      target: { value: '"JetBrains Mono", "Fira Code", monospace' },
    });
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
});
