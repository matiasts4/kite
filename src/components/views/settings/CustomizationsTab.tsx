import React from 'react';
import { SunIcon, MoonIcon, CheckIcon } from './icons';
import { ThemeItem, DARK_THEMES, LIGHT_THEMES } from './types';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';

interface CustomizationsTabProps {
  mode: 'dark' | 'light';
  palette: string;
  onToggleMode: (mode: 'dark' | 'light') => void;
  onSelectTheme: (paletteId: string, mode?: 'dark' | 'light') => void;
}

export const CustomizationsTab: React.FC<CustomizationsTabProps> = ({
  mode,
  palette,
  onToggleMode,
  onSelectTheme,
}) => {
  const renderThemeCard = (theme: ThemeItem) => {
    const isThemeActive = palette === theme.id;
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
          className="theme-preview"
          data-palette={theme.id}
          data-theme={theme.mode}
        >
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
            <span className="theme-preview__line theme-preview__line--primary" />
            <span className="theme-preview__line theme-preview__line--short" />
            <span className="theme-preview__footer">
              <span className="theme-preview__pill">
                <span className="theme-preview__label" />
              </span>
              <span className="theme-preview__dot" data-status="failed" />
            </span>
          </span>
        </span>

        <span className="theme-card__meta">
          <span className="theme-card__copy">
            <span className="theme-card__name">{theme.name}</span>
            <span className="theme-card__blurb">{theme.blurb}</span>
          </span>
          {isThemeActive && (
            <span className="theme-card__active" title="Active">
              <CheckIcon aria-hidden="true" size={14} strokeWidth={2.5} />
              <span className="sr-only">Active</span>
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Appearance</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Mode</h3>
              <p>Dark or light. Each remembers its own theme, and terminals match.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Mode" className="ui-segmented">
                <button
                  aria-pressed={mode === 'light'}
                  className="ui-segmented__item"
                  onClick={() => onToggleMode('light')}
                  type="button"
                >
                  {mode === 'light' && (
                    <SegmentedIndicator group="settings-customizations-mode" />
                  )}
                  <span aria-hidden="true" className="ui-segmented__icon">
                    <SunIcon size={12} strokeWidth={2} />
                  </span>
                  <span>Light</span>
                </button>
                <button
                  aria-pressed={mode === 'dark'}
                  className="ui-segmented__item"
                  onClick={() => onToggleMode('dark')}
                  type="button"
                >
                  {mode === 'dark' && (
                    <SegmentedIndicator group="settings-customizations-mode" />
                  )}
                  <span aria-hidden="true" className="ui-segmented__icon">
                    <MoonIcon size={12} strokeWidth={2} />
                  </span>
                  <span>Dark</span>
                </button>
              </fieldset>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="theme-group-dark" className="settings-group">
        <h2 className="settings-group__title" id="theme-group-dark">
          Dark themes
        </h2>
        <div className="theme-grid">{DARK_THEMES.map(renderThemeCard)}</div>
        <p className="settings-note">
          {mode === 'dark'
            ? 'In use now. Kite keeps this pick while it is dark.'
            : 'Picking one switches Kite to dark.'}
        </p>
      </section>

      <section aria-labelledby="theme-group-light" className="settings-group">
        <h2 className="settings-group__title" id="theme-group-light">
          Light themes
        </h2>
        <div className="theme-grid">{LIGHT_THEMES.map(renderThemeCard)}</div>
        <p className="settings-note">
          {mode === 'light'
            ? 'In use now. Kite keeps this pick while it is light.'
            : 'Picking one switches Kite to light.'}
        </p>
      </section>
    </>
  );
};

export const AppearanceTab = CustomizationsTab;
