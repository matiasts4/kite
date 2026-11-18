import React, { useEffect, useRef, useState } from 'react';
import {
  SunIcon,
  MoonIcon,
  MonitorIcon,
  CheckIcon,
  CopyIcon,
  UploadIcon,
  RotateCcwIcon,
} from './icons';
import { ThemeItem, DARK_THEMES, LIGHT_THEMES } from './types';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';
import { StageBackdrop } from '../../theme/StageBackdrop';
import { ThemeHeroFigure } from '../../theme/ThemeHeroFigure';
import {
  BACKDROP_PRESETS,
  BACKDROP_WALLPAPER_URLS,
  CODE_FONT_OPTIONS,
  DEFAULT_THEME_CUSTOMIZATIONS,
  HERO_FIGURE_OPTIONS,
  UI_FONT_OPTIONS,
  exportThemeJson,
  exportThemeString,
  getThemePackById,
  importThemePayload,
  sanitizeCustomImageUrl,
  type AppearanceMode,
  type ConcreteBackdropPresetId,
  type KiteThemeCustomizations,
  type KiteThemeOverrides,
} from '../../../lib/themeCustomizations';

interface CustomizationsTabProps {
  mode: 'dark' | 'light';
  appearanceMode?: AppearanceMode;
  palette: string;
  customizations?: KiteThemeCustomizations;
  onToggleMode: (mode: AppearanceMode) => void;
  onSelectTheme: (paletteId: string, mode?: 'dark' | 'light') => void;
  onUpdateCustomizations?: (patch: Partial<KiteThemeCustomizations>) => void;
  onResetThemeOverrides?: () => void;
  onResetAllCustomizations?: () => void;
}

type ColorOverrideKey = 'accent' | 'surface' | 'ink' | 'diffAdded' | 'diffRemoved';

interface ColorOverrideField {
  key: ColorOverrideKey;
  label: string;
  fallback: (pack: ReturnType<typeof getThemePackById>) => string;
}

const COLOR_OVERRIDE_FIELDS: readonly ColorOverrideField[] = [
  { key: 'accent', label: 'Acento', fallback: (p) => p.tokens.accent },
  { key: 'surface', label: 'Superficie', fallback: (p) => p.tokens.pane },
  { key: 'ink', label: 'Texto principal', fallback: (p) => p.tokens.textPrimary },
  { key: 'diffAdded', label: 'Diff agregado', fallback: (p) => p.tokens.diffAddition },
  { key: 'diffRemoved', label: 'Diff eliminado', fallback: (p) => p.tokens.diffDeletion },
];

interface SwitchRowProps {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}

const SwitchSettingRow: React.FC<SwitchRowProps> = ({
  id,
  title,
  description,
  checked,
  onToggle,
}) => (
  <div className="ui-card__row settings-row">
    <div className="settings-row__copy">
      <h3 className="settings-row__title" id={`${id}-label`}>
        {title}
      </h3>
      <p>{description}</p>
    </div>
    <div className="settings-row__control">
      <button
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        className="ui-switch"
        onClick={onToggle}
        role="switch"
        type="button"
      >
        <span aria-hidden="true" className="ui-switch__knob" />
      </button>
    </div>
  </div>
);

interface RangeRowProps {
  id: string;
  title: string;
  description: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}

const RangeSettingRow: React.FC<RangeRowProps> = ({
  id,
  title,
  description,
  min,
  max,
  value,
  unit = '',
  disabled = false,
  onChange,
}) => (
  <div className="ui-card__row settings-row">
    <div className="settings-row__copy">
      <label className="settings-row__title" htmlFor={id}>
        {title}
      </label>
      <p>{description}</p>
    </div>
    <div className="settings-row__control customizations-slider-control">
      <input
        aria-label={title}
        className="customizations-range"
        disabled={disabled}
        id={id}
        max={max}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        type="range"
        value={value}
      />
      <span className="customizations-slider-value">
        {value}
        {unit}
      </span>
    </div>
  </div>
);

export const CustomizationsTab: React.FC<CustomizationsTabProps> = ({
  mode,
  appearanceMode,
  palette,
  customizations = DEFAULT_THEME_CUSTOMIZATIONS,
  onToggleMode,
  onSelectTheme,
  onUpdateCustomizations,
  onResetThemeOverrides,
  onResetAllCustomizations,
}) => {
  const effectiveAppearanceMode: AppearanceMode =
    appearanceMode ?? customizations.appearanceMode ?? mode;
  const activePack = getThemePackById(palette);
  const darkPack = getThemePackById(customizations.darkThemeId);
  const lightPack = getThemePackById(customizations.lightThemeId);

  const [customUrlDraft, setCustomUrlDraft] = useState(customizations.backdrop.customImageUrl);
  const [importDraft, setImportDraft] = useState('');
  const [importStatus, setImportStatus] = useState<{
    tone: 'ok' | 'error';
    text: string;
  } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCustomUrlDraft(customizations.backdrop.customImageUrl);
  }, [customizations.backdrop.customImageUrl]);

  const updateBackdrop = (patch: Partial<KiteThemeCustomizations['backdrop']>) => {
    onUpdateCustomizations?.({
      backdrop: { ...customizations.backdrop, ...patch },
    });
  };

  const updateFigure = (patch: Partial<KiteThemeCustomizations['figure']>) => {
    onUpdateCustomizations?.({
      figure: { ...customizations.figure, ...patch },
    });
  };

  const updateSurface = (patch: Partial<KiteThemeCustomizations['surface']>) => {
    onUpdateCustomizations?.({
      surface: { ...customizations.surface, ...patch },
    });
  };

  const updateOverrides = (patch: Partial<KiteThemeOverrides>) => {
    onUpdateCustomizations?.({
      overrides: { ...customizations.overrides, ...patch },
    });
  };

  const handleApplyCustomUrl = () => {
    const trimmed = customUrlDraft.trim();
    if (!trimmed) {
      updateBackdrop({ preset: 'custom-image', customImageUrl: '' });
      setImportStatus(null);
      return;
    }
    const safe = sanitizeCustomImageUrl(trimmed);
    if (!safe) {
      setImportStatus({
        tone: 'error',
        text: 'Ingresa una URL http(s) válida, una ruta /assets o una imagen data URI en base64.',
      });
      return;
    }
    setImportStatus(null);
    updateBackdrop({ preset: 'custom-image', customImageUrl: safe });
  };

  const handleImageFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? sanitizeCustomImageUrl(reader.result) : '';
      if (result) {
        setCustomUrlDraft(result);
        updateBackdrop({ preset: 'custom-image', customImageUrl: result });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleCopyThemeString = async () => {
    const payload = exportThemeString(customizations);
    try {
      await navigator.clipboard?.writeText(payload);
      setCopyFeedback('Cadena kite-theme-v1:{...} copiada');
    } catch {
      setImportDraft(payload);
      setCopyFeedback('Cadena lista en el cuadro inferior');
    }
    window.setTimeout(() => setCopyFeedback(null), 2200);
  };

  const handleExportJson = () => {
    const json = exportThemeJson(customizations);
    setImportDraft(json);
    if (typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${activePack.id}-theme.json`;
        link.click();
        URL.revokeObjectURL(url);
      } catch {
        // Fallback already populated importDraft.
      }
    }
    setImportStatus({ tone: 'ok', text: `JSON de ${activePack.name} exportado.` });
  };

  const handleImportTheme = () => {
    const res = importThemePayload(importDraft, customizations);
    if (!res.ok) {
      setImportStatus({ tone: 'error', text: res.error });
      return;
    }
    onUpdateCustomizations?.(res.state);
    setImportStatus({ tone: 'ok', text: res.summary });
  };

  const renderThemeCard = (theme: ThemeItem) => {
    const isThemeActive = palette === theme.id;
    const pack = getThemePackById(theme.id);
    const previewState: KiteThemeCustomizations = {
      ...customizations,
      appearanceMode: theme.mode,
      darkThemeId: theme.mode === 'dark' ? theme.id : customizations.darkThemeId,
      lightThemeId: theme.mode === 'light' ? theme.id : customizations.lightThemeId,
    };

    const previewStyle = {
      '--background': pack.tokens.background,
      '--pane': pack.tokens.pane,
      '--sidebar-fill': pack.tokens.sidebar,
      '--text-primary': pack.tokens.textPrimary,
      '--text-secondary': pack.tokens.textSecondary,
      '--accent': pack.tokens.accent,
      '--accent-fill': pack.tokens.accent,
      '--accent-on-fill': theme.mode === 'light' ? '#ffffff' : '#090a0c',
    } as React.CSSProperties;

    return (
      <button
        key={theme.id}
        aria-pressed={isThemeActive}
        className="theme-card"
        onClick={() => onSelectTheme(theme.id, theme.mode)}
        type="button"
      >
        <span
          aria-hidden="true"
          className="theme-preview theme-preview--rich"
          data-palette={theme.id}
          data-surface-glass={pack.defaultTranslucent ? 'true' : 'false'}
          data-theme={theme.mode}
          style={previewStyle}
        >
          <StageBackdrop
            customizations={previewState}
            overridePreset={pack.defaultBackdrop}
            variant="miniature"
          />
          <span className="theme-preview__rail">
            <span className="theme-preview__row theme-preview__row--selected">
              <span className="theme-preview__dot" data-status="running" />
              <span className="theme-preview__line theme-preview__line--primary" />
            </span>
            <span className="theme-preview__row">
              <span className="theme-preview__dot" data-status="waiting" />
              <span className="theme-preview__line" />
            </span>
            <span className="theme-preview__row">
              <span className="theme-preview__dot" data-status="idle" />
              <span className="theme-preview__line theme-preview__line--short" />
            </span>
          </span>
          <span className="theme-preview__pane">
            <span className="theme-preview__pane-header">
              <span className="theme-preview__line theme-preview__line--primary" />
              <ThemeHeroFigure
                figure={pack.defaultFigure}
                paletteId={pack.id}
                variant="miniature"
              />
            </span>
            <span className="theme-preview__line theme-preview__line--short" />
            <span className="theme-preview__footer">
              <span className="theme-preview__pill">
                <span className="theme-preview__label" />
              </span>
              <span className="theme-preview__swatches">
                <span
                  className="theme-preview__swatch-dot"
                  style={{ background: pack.tokens.diffAddition }}
                />
                <span
                  className="theme-preview__swatch-dot"
                  style={{ background: pack.tokens.diffDeletion }}
                />
              </span>
            </span>
          </span>
        </span>

        <span className="theme-card__meta">
          <span className="theme-card__copy">
            <span className="theme-card__title-row">
              <span className="theme-card__name">{theme.name}</span>
              {theme.badge && <span className="theme-card__badge">{theme.badge}</span>}
            </span>
            <span className="theme-card__blurb">{theme.blurb}</span>
          </span>
          {isThemeActive && (
            <span className="theme-card__active" title="Activo">
              <CheckIcon aria-hidden="true" size={14} strokeWidth={2.5} />
              <span className="sr-only">Activo</span>
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <>
      {/* 1. Appearance Mode & Independent Memory */}
      <section className="settings-group">
        <h2 className="settings-group__title">Apariencia</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Modo</h3>
              <p>
                Claro, oscuro o seguir al sistema. Recordado: Oscuro ({darkPack.name}) · Claro (
                {lightPack.name}).
              </p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Modo de apariencia" className="ui-segmented">
                <button
                  aria-pressed={effectiveAppearanceMode === 'light'}
                  className="ui-segmented__item"
                  onClick={() => onToggleMode('light')}
                  type="button"
                >
                  {effectiveAppearanceMode === 'light' && (
                    <SegmentedIndicator group="settings-customizations-mode" />
                  )}
                  <span aria-hidden="true" className="ui-segmented__icon">
                    <SunIcon size={12} strokeWidth={2} />
                  </span>
                  <span>Claro</span>
                </button>
                <button
                  aria-pressed={effectiveAppearanceMode === 'dark'}
                  className="ui-segmented__item"
                  onClick={() => onToggleMode('dark')}
                  type="button"
                >
                  {effectiveAppearanceMode === 'dark' && (
                    <SegmentedIndicator group="settings-customizations-mode" />
                  )}
                  <span aria-hidden="true" className="ui-segmented__icon">
                    <MoonIcon size={12} strokeWidth={2} />
                  </span>
                  <span>Oscuro</span>
                </button>
                <button
                  aria-pressed={effectiveAppearanceMode === 'system'}
                  className="ui-segmented__item"
                  onClick={() => onToggleMode('system')}
                  type="button"
                >
                  {effectiveAppearanceMode === 'system' && (
                    <SegmentedIndicator group="settings-customizations-mode" />
                  )}
                  <span aria-hidden="true" className="ui-segmented__icon">
                    <MonitorIcon size={12} strokeWidth={2} />
                  </span>
                  <span>Sistema</span>
                </button>
              </fieldset>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Dark & Light Visual Theme Packs */}
      <section aria-labelledby="theme-group-dark" className="settings-group">
        <h2 className="settings-group__title" id="theme-group-dark">
          Paquetes de tema oscuro
        </h2>
        <div className="theme-grid">{DARK_THEMES.map(renderThemeCard)}</div>
        <p className="settings-note">
          {mode === 'dark'
            ? 'En uso ahora. Kite conserva esta elección cuando la apariencia es oscura.'
            : 'Elegir un tema oscuro cambia Kite a modo oscuro recordando tu tema claro.'}
        </p>
      </section>

      <section aria-labelledby="theme-group-light" className="settings-group">
        <h2 className="settings-group__title" id="theme-group-light">
          Paquetes de tema claro
        </h2>
        <div className="theme-grid">{LIGHT_THEMES.map(renderThemeCard)}</div>
        <p className="settings-note">
          {mode === 'light'
            ? 'En uso ahora. Kite conserva esta elección cuando la apariencia es clara.'
            : 'Elegir un tema claro cambia Kite a modo claro recordando tu tema oscuro.'}
        </p>
      </section>

      {/* 3. Stage Backdrop & Atmosphere */}
      <section className="settings-group">
        <h2 className="settings-group__title">Fondo de Escenario y Atmósfera</h2>
        <div className="customizations-picker-grid">
          {BACKDROP_PRESETS.map((preset) => {
            const active = customizations.backdrop.preset === preset.id;
            const resolvedPresetId: ConcreteBackdropPresetId =
              preset.id === 'theme-default' ? activePack.defaultBackdrop : preset.id;
            const wallpaperUrl = BACKDROP_WALLPAPER_URLS[resolvedPresetId];
            return (
              <button
                key={preset.id}
                aria-pressed={active}
                className="customizations-preset-tile"
                onClick={() => updateBackdrop({ preset: preset.id })}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="customizations-preset-tile__swatch"
                  style={
                    wallpaperUrl
                      ? {
                          backgroundImage: `url("${wallpaperUrl}"), ${preset.previewGradient}`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        }
                      : { background: preset.previewGradient }
                  }
                />
                <span className="customizations-preset-tile__copy">
                  <span className="customizations-preset-tile__label">{preset.label}</span>
                  <span className="customizations-preset-tile__blurb">{preset.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="ui-card">
          <div className="ui-card__row settings-row settings-row--stacked">
            <div className="settings-row__copy">
              <label className="settings-row__title" htmlFor="custom-wallpaper-url">
                Imagen de fondo personalizada
              </label>
              <p>Pega la URL de una imagen o sube un archivo local para el fondo Imagen personalizada.</p>
            </div>
            <div className="customizations-inline-actions">
              <input
                aria-label="URL de imagen de fondo personalizada"
                className="ui-field customizations-url-input"
                id="custom-wallpaper-url"
                onChange={(e) => setCustomUrlDraft(e.target.value)}
                placeholder="https://... o /assets/wallpaper.jpg"
                type="url"
                value={customUrlDraft}
              />
              <button
                className="secondary-button customizations-btn-md"
                onClick={handleApplyCustomUrl}
                type="button"
              >
                Aplicar imagen
              </button>
              <button
                className="secondary-button customizations-btn-md"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <UploadIcon aria-hidden="true" size={13} />
                Subir archivo
              </button>
              <input
                accept="image/png,image/jpeg,image/webp,image/gif"
                aria-label="Subir imagen de fondo"
                className="sr-only"
                onChange={handleImageFileUpload}
                ref={fileInputRef}
                type="file"
              />
            </div>
          </div>

          <RangeSettingRow
            description="Aplica una capa de legibilidad sobre el fondo del escenario antes del desenfoque."
            id="backdrop-dimming-slider"
            max={100}
            min={0}
            onChange={(dimming) => updateBackdrop({ dimming })}
            title="Atenuación del fondo"
            unit="%"
            value={customizations.backdrop.dimming}
          />
          <RangeSettingRow
            description="Suaviza los detalles del fondo detrás de los paneles y márgenes del espacio de trabajo."
            id="backdrop-blur-slider"
            max={32}
            min={0}
            onChange={(blur) => updateBackdrop({ blur })}
            title="Desenfoque del fondo"
            unit="px"
            value={customizations.backdrop.blur}
          />
          <SwitchSettingRow
            checked={customizations.backdrop.grain}
            description="Añade una textura sutil de grano arquitectónico sobre el lienzo del escenario."
            id="backdrop-grain-switch"
            onToggle={() => updateBackdrop({ grain: !customizations.backdrop.grain })}
            title="Grano de película / Dither"
          />
        </div>
      </section>

      {/* 4. Empty-State Hero Figures & Watermark */}
      <section className="settings-group">
        <h2 className="settings-group__title">Figuras de portada y marca de agua</h2>
        <div className="customizations-figure-grid">
          {HERO_FIGURE_OPTIONS.map((option) => {
            const active = customizations.figure.style === option.id;
            const figureToPreview =
              option.id === 'theme-default' ? activePack.defaultFigure : option.id;
            return (
              <button
                key={option.id}
                aria-pressed={active}
                className="customizations-figure-tile"
                onClick={() => updateFigure({ style: option.id })}
                type="button"
              >
                <span aria-hidden="true" className="customizations-figure-tile__art">
                  {figureToPreview === 'none' ? (
                    <span className="customizations-figure-tile__none">Aa</span>
                  ) : (
                    <ThemeHeroFigure
                      figure={figureToPreview}
                      paletteId={activePack.id}
                      variant="card"
                    />
                  )}
                </span>
                <span className="customizations-figure-tile__label">{option.label}</span>
                <span className="customizations-figure-tile__blurb">{option.blurb}</span>
              </button>
            );
          })}
        </div>

        <div className="ui-card">
          <SwitchSettingRow
            checked={customizations.figure.showWatermark}
            description="Proyecta una marca de agua sutil de la figura seleccionada en la esquina del espacio de trabajo."
            id="figure-watermark-switch"
            onToggle={() => updateFigure({ showWatermark: !customizations.figure.showWatermark })}
            title="Marca de agua en el fondo"
          />
        </div>
      </section>

      {/* 5. Translucent Surfaces & Contrast */}
      <section className="settings-group">
        <h2 className="settings-group__title">Superficies translúcidas y contraste</h2>
        <div className="ui-card">
          <SwitchSettingRow
            checked={customizations.surface.translucent}
            description="Activa la translucidez de vidrio esmerilado en barras laterales, paneles, tarjetas, dock derecho y compositores."
            id="surface-translucent-switch"
            onToggle={() => updateSurface({ translucent: !customizations.surface.translucent })}
            title="Superficies translúcidas (Vidrio esmerilado)"
          />
          <RangeSettingRow
            description="Controla la opacidad de los paneles esmerilados sobre el fondo de escenario activo."
            id="surface-opacity-slider"
            max={95}
            min={15}
            onChange={(opacity) => updateSurface({ opacity })}
            title="Opacidad de paneles"
            unit="%"
            value={customizations.surface.opacity}
          />
          <RangeSettingRow
            description="Controla la intensidad del desenfoque de fondo en las superficies translúcidas."
            id="surface-blur-slider"
            max={32}
            min={0}
            onChange={(blur) => updateSurface({ blur })}
            title="Desenfoque de paneles"
            unit="px"
            value={customizations.surface.blur}
          />
          <RangeSettingRow
            description="Ajusta la definición de los bordes de panel y el contraste del texto secundario en la interfaz."
            id="surface-contrast-slider"
            max={100}
            min={0}
            onChange={(contrast) => updateSurface({ contrast })}
            title="Contraste"
            unit=""
            value={customizations.surface.contrast}
          />
        </div>
      </section>

      {/* 6. Color Overrides, Daltonized Diffs & Typography */}
      <section className="settings-group">
        <h2 className="settings-group__title">Personalización avanzada, accesibilidad y tipografía</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row settings-row--stacked">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Colores personalizados</h3>
              <p>Superpone colores personalizados sobre el paquete de tema visual activo.</p>
            </div>
            <div className="customizations-color-grid">
              {COLOR_OVERRIDE_FIELDS.map((field) => {
                const currentVal = customizations.overrides[field.key];
                const effectiveHex = currentVal ?? field.fallback(activePack);
                return (
                  <div key={field.key} className="customizations-color-chip">
                    <label
                      className="customizations-color-chip__label"
                      htmlFor={`override-color-${field.key}`}
                    >
                      {field.label}
                    </label>
                    <div className="customizations-color-chip__controls">
                      <input
                        aria-label={`Color personalizado de ${field.label}`}
                        className="customizations-color-input"
                        id={`override-color-${field.key}`}
                        onChange={(e) => updateOverrides({ [field.key]: e.target.value })}
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(effectiveHex) ? effectiveHex : '#5c8fff'}
                      />
                      <span className="customizations-color-chip__hex">
                        {currentVal ?? 'Tema'}
                      </span>
                      {currentVal && (
                        <button
                          aria-label={`Limpiar color de ${field.label}`}
                          className="ghost-button customizations-clear-btn"
                          onClick={() => updateOverrides({ [field.key]: null })}
                          type="button"
                        >
                          Limpiar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <SwitchSettingRow
            checked={customizations.overrides.daltonizedDiffs}
            description="Asigna azul cerúleo y ámbar cálido de alto contraste a las adiciones y eliminaciones en diffs."
            id="daltonized-diffs-switch"
            onToggle={() =>
              updateOverrides({ daltonizedDiffs: !customizations.overrides.daltonizedDiffs })
            }
            title="Diffs aptos para daltonismo"
          />

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <label className="settings-row__title" htmlFor="ui-font-select">
                Tipografía de interfaz
              </label>
              <p>Tipografía principal de la interfaz en barras laterales, chat y configuración.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <select
                aria-label="Tipografía de interfaz"
                className="ui-field settings-control"
                id="ui-font-select"
                onChange={(e) => updateOverrides({ uiFont: e.target.value || null })}
                value={customizations.overrides.uiFont ?? ''}
              >
                {UI_FONT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.value ?? ''}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <label className="settings-row__title" htmlFor="code-font-select">
                Tipografía de código
              </label>
              <p>Fuente monoespaciada para diffs, bloques de código y símbolos en línea.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <select
                aria-label="Tipografía de código"
                className="ui-field settings-control"
                id="code-font-select"
                onChange={(e) => updateOverrides({ codeFont: e.target.value || null })}
                value={customizations.overrides.codeFont ?? ''}
              >
                {CODE_FONT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.value ?? ''}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Restablecer personalización</h3>
              <p>Limpia los colores y fuentes personalizados manteniendo el paquete activo, o restaura los valores predeterminados.</p>
            </div>
            <div className="settings-row__control">
              <button
                className="secondary-button customizations-btn-md"
                onClick={() => onResetThemeOverrides?.()}
                type="button"
              >
                <RotateCcwIcon aria-hidden="true" size={13} />
                Restablecer colores y fuentes
              </button>
              <button
                className="ghost-button customizations-btn-md"
                onClick={() => onResetAllCustomizations?.()}
                type="button"
              >
                Restablecer todo
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 7. Portable Theme Import / Export */}
      <section className="settings-group">
        <h2 className="settings-group__title">Esquema de tema portable (Importar / Exportar)</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row settings-row--stacked">
            <div className="settings-row__copy">
              <label className="settings-row__title" htmlFor="theme-import-textarea">
                Cadena de tema portable o JSON
              </label>
              <p>
                Comparte configuraciones usando <code>kite-theme-v1:{'{...}'}</code>, cadenas{' '}
                <code>*-theme-v1</code> compatibles u objetos JSON de personalización.
              </p>
            </div>
            <div className="customizations-inline-actions">
              <button
                className="secondary-button customizations-btn-md"
                onClick={() => void handleCopyThemeString()}
                type="button"
              >
                <CopyIcon aria-hidden="true" size={13} />
                {copyFeedback ?? 'Copiar cadena de tema'}
              </button>
              <button
                className="secondary-button customizations-btn-md"
                onClick={handleExportJson}
                type="button"
              >
                Exportar JSON
              </button>
            </div>
            <textarea
              aria-label="Importar cadena de tema o JSON"
              className="ui-field ui-field--area customizations-import-textarea"
              id="theme-import-textarea"
              onChange={(e) => setImportDraft(e.target.value)}
              placeholder='Pega kite-theme-v1:{...} o {"overrides":{"accent":"#38bdf8"}}'
              rows={3}
              value={importDraft}
            />
            <div className="customizations-import-footer">
              <button
                className="primary-button customizations-btn-md"
                onClick={handleImportTheme}
                type="button"
              >
                Importar tema
              </button>
              {importStatus && (
                <span
                  className={`customizations-status customizations-status--${importStatus.tone}`}
                  role="status"
                >
                  {importStatus.text}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
};

export const AppearanceTab = CustomizationsTab;
