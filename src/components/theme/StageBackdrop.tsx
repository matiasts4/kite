import React from 'react';
import {
  BACKDROP_WALLPAPER_URLS,
  getActivePaletteForState,
  getThemePackById,
  resolveEffectiveBackdropPreset,
  resolveEffectiveHeroFigure,
  sanitizeCustomImageUrl,
  type ConcreteBackdropPresetId,
  type KiteThemeCustomizations,
} from '../../lib/themeCustomizations';
import { ThemeHeroFigure } from './ThemeHeroFigure';

export interface StageBackdropProps {
  customizations: KiteThemeCustomizations;
  variant?: 'stage' | 'miniature';
  overridePreset?: ConcreteBackdropPresetId;
  className?: string;
}

const StageBackdropInner: React.FC<StageBackdropProps> = ({
  customizations,
  variant = 'stage',
  overridePreset,
  className = '',
}) => {
  const activePaletteId = getActivePaletteForState(customizations);
  const pack = getThemePackById(activePaletteId);
  const effectivePreset: ConcreteBackdropPresetId =
    overridePreset ?? resolveEffectiveBackdropPreset(customizations, pack);

  if (effectivePreset === 'none') {
    return null;
  }

  const effectiveFigure = resolveEffectiveHeroFigure(customizations, pack);
  const effectiveGrain =
    customizations.backdrop.grain ||
    (customizations.backdrop.preset === 'theme-default' && pack.defaultGrain);

  const showWatermark =
    variant === 'stage' &&
    customizations.figure.showWatermark &&
    effectiveFigure !== 'none';
  const safeCustomImageUrl = sanitizeCustomImageUrl(customizations.backdrop.customImageUrl);
  const presetWallpaperUrl = BACKDROP_WALLPAPER_URLS[effectivePreset];

  return (
    <div
      aria-hidden="true"
      className={`stage-backdrop stage-backdrop--${variant} stage-backdrop--${effectivePreset} ${className}`.trim()}
      data-backdrop-preset={effectivePreset}
      data-grain={effectiveGrain ? 'true' : 'false'}
      data-testid={variant === 'stage' ? 'stage-backdrop' : `stage-backdrop-${variant}`}
    >
      <div
        className="stage-backdrop__canvas"
        data-testid={`stage-backdrop-scene-${effectivePreset}`}
        style={
          customizations.backdrop.blur > 0
            ? {
                filter: `blur(${customizations.backdrop.blur}px)`,
                transform: 'scale(1.04)',
              }
            : undefined
        }
      >
        {presetWallpaperUrl && (
          <div
            className="stage-backdrop__wallpaper"
            data-testid={`stage-backdrop-wallpaper-${effectivePreset}`}
            style={{
              backgroundImage: `url("${presetWallpaperUrl}")`,
            }}
          />
        )}
        {effectivePreset === 'custom-image' && (
          <div
            className="stage-backdrop__custom-image"
            data-testid="stage-backdrop-custom-image"
            style={
              safeCustomImageUrl
                ? {
                    backgroundImage: `url("${safeCustomImageUrl}")`,
                  }
                : undefined
            }
          />
        )}
      </div>

      <div
        className="stage-backdrop__scrim"
        style={{
          opacity: Math.min(0.95, Math.max(0, customizations.backdrop.dimming / 100)),
        }}
      />

      {effectiveGrain && <div className="stage-backdrop__grain" />}

      {showWatermark && (
        <div
          className="stage-backdrop__watermark"
          data-testid="stage-backdrop-watermark"
        >
          <ThemeHeroFigure
            figure={effectiveFigure}
            paletteId={activePaletteId}
            variant="watermark"
          />
        </div>
      )}
    </div>
  );
};

export const StageBackdrop = React.memo(StageBackdropInner);
