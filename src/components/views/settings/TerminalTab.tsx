import React, { useState, useEffect, useCallback } from 'react';
import { SelectMenu } from '../../ui/SelectMenu';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';
import {
  type TerminalAppearancePrefs,
  type TerminalFontFamilyId,
  DEFAULT_TERMINAL_APPEARANCE_PREFS,
  TERMINAL_FONT_OPTIONS,
  TERMINAL_LINE_HEIGHT_PRESETS,
  getTerminalAppearancePrefs,
  setTerminalAppearancePrefs,
  TERMINAL_APPEARANCE_CHANGED_EVENT,
} from '../../../lib/terminalAppearancePrefs';
import {
  type TerminalWebLinksTarget,
  getTerminalWebLinksTarget,
  setTerminalWebLinksTarget,
  TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT,
} from '../../../lib/terminalLinkNav';
import { readKitePref, writeKitePref } from '../../../lib/kitePrefs';

export const FONT_FAMILY_ROWS: Array<{ id: string; title: string; detail?: string }> =
  TERMINAL_FONT_OPTIONS.map((f) => ({
    id: f.id,
    title: f.label,
    detail: f.id === 'cascadia' ? 'Por defecto' : undefined,
  }));

export const SHELL_ROWS = [
  { id: 'default', title: 'Por defecto del sistema' },
  { id: 'powershell', title: 'PowerShell' },
  { id: 'cmd', title: 'Símbolo del sistema (CMD)' },
  { id: 'gitbash', title: 'Git Bash' },
  { id: 'wsl', title: 'WSL' },
];

export const TerminalTab: React.FC = () => {
  const [terminalShell, setTerminalShell] = useState<string>(
    () => readKitePref('terminalShell') || 'default'
  );
  const [terminalWebLinksTarget, setTerminalWebLinksTargetState] = useState<TerminalWebLinksTarget>(
    () => getTerminalWebLinksTarget()
  );
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearancePrefs>(
    () => getTerminalAppearancePrefs()
  );

  useEffect(() => {
    const handleTargetChanged = (e: Event) => {
      const custom = e as CustomEvent<TerminalWebLinksTarget>;
      if (custom.detail) {
        setTerminalWebLinksTargetState(custom.detail);
      }
    };
    window.addEventListener(TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT, handleTargetChanged);
    return () =>
      window.removeEventListener(TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT, handleTargetChanged);
  }, []);

  useEffect(() => {
    const handleAppearanceChanged = (e: Event) => {
      const custom = e as CustomEvent<TerminalAppearancePrefs>;
      if (custom.detail) {
        setTerminalAppearance(custom.detail);
      }
    };
    window.addEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, handleAppearanceChanged);
    return () =>
      window.removeEventListener(TERMINAL_APPEARANCE_CHANGED_EVENT, handleAppearanceChanged);
  }, []);

  const handleUpdateTerminalAppearance = useCallback((patch: Partial<TerminalAppearancePrefs>) => {
    const next = setTerminalAppearancePrefs(patch);
    setTerminalAppearance(next);
  }, []);

  const handleTerminalShellChange = (value: string) => {
    setTerminalShell(value);
    writeKitePref('terminalShell', value);
  };

  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Apariencia y Tipografía</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Motor de renderizado</h3>
              <p>GhostGrid · 2D es el motor de la terminal: emulación VT en Rust y sprites en canvas.</p>
            </div>
            <div className="settings-row__control">
              <span>GhostGrid · 2D</span>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Familia tipográfica</h3>
              <p>Fuente monoespaciada utilizada en todas las terminales integradas.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <SelectMenu
                label="Familia tipográfica"
                variant="field"
                className="settings-select"
                value={terminalAppearance.fontFamilyId}
                rows={FONT_FAMILY_ROWS}
                triggerLabel={
                  FONT_FAMILY_ROWS.find((row) => row.id === terminalAppearance.fontFamilyId)?.title ??
                  'Cascadia Mono (Clásico)'
                }
                onSelect={(id: string) =>
                  handleUpdateTerminalAppearance({ fontFamilyId: id as TerminalFontFamilyId })
                }
              />
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Tamaño de fuente</h3>
              <p>Tamaño base del texto en píxeles (10 px – 22 px).</p>
            </div>
            <div className="settings-row__control" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <fieldset aria-label="Ajustar tamaño de fuente" className="ui-segmented">
                <button
                  type="button"
                  className="ui-segmented__item"
                  disabled={terminalAppearance.fontSize <= 10}
                  onClick={() =>
                    handleUpdateTerminalAppearance({ fontSize: terminalAppearance.fontSize - 1 })
                  }
                  aria-label="Reducir tamaño de fuente"
                  style={{ minWidth: '32px', padding: '0 8px' }}
                >
                  -
                </button>
                <span
                  className="ui-segmented__item"
                  style={{
                    minWidth: '56px',
                    cursor: 'default',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 600,
                    userSelect: 'none',
                  }}
                >
                  {terminalAppearance.fontSize} px
                </span>
                <button
                  type="button"
                  className="ui-segmented__item"
                  disabled={terminalAppearance.fontSize >= 22}
                  onClick={() =>
                    handleUpdateTerminalAppearance({ fontSize: terminalAppearance.fontSize + 1 })
                  }
                  aria-label="Aumentar tamaño de fuente"
                  style={{ minWidth: '32px', padding: '0 8px' }}
                >
                  +
                </button>
              </fieldset>
              {terminalAppearance.fontSize !== DEFAULT_TERMINAL_APPEARANCE_PREFS.fontSize && (
                <button
                  type="button"
                  className="settings-control ui-button"
                  onClick={() =>
                    handleUpdateTerminalAppearance({
                      fontSize: DEFAULT_TERMINAL_APPEARANCE_PREFS.fontSize,
                    })
                  }
                  title="Restablecer tamaño por defecto"
                >
                  Restablecer
                </button>
              )}
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Altura de línea</h3>
              <p>Espaciado vertical entre filas. El modo Clásico (1.16) mantiene la proporción original.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Altura de línea" className="ui-segmented">
                {TERMINAL_LINE_HEIGHT_PRESETS.map((preset) => {
                  const isSelected =
                    Math.abs(terminalAppearance.lineHeight - preset.value) < 0.001;
                  return (
                    <button
                      key={preset.value}
                      aria-pressed={isSelected}
                      className="ui-segmented__item"
                      onClick={() => handleUpdateTerminalAppearance({ lineHeight: preset.value })}
                      type="button"
                    >
                      {isSelected && (
                        <SegmentedIndicator group="settings-terminal-line-height" />
                      )}
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Estilo del cursor</h3>
              <p>Forma visual del cursor activo en la terminal.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Estilo del cursor" className="ui-segmented">
                <button
                  aria-pressed={terminalAppearance.cursorStyle === 'bar'}
                  className="ui-segmented__item"
                  onClick={() => handleUpdateTerminalAppearance({ cursorStyle: 'bar' })}
                  type="button"
                >
                  {terminalAppearance.cursorStyle === 'bar' && (
                    <SegmentedIndicator group="settings-terminal-cursor-style" />
                  )}
                  <span>Barra</span>
                </button>
                <button
                  aria-pressed={terminalAppearance.cursorStyle === 'block'}
                  className="ui-segmented__item"
                  onClick={() => handleUpdateTerminalAppearance({ cursorStyle: 'block' })}
                  type="button"
                >
                  {terminalAppearance.cursorStyle === 'block' && (
                    <SegmentedIndicator group="settings-terminal-cursor-style" />
                  )}
                  <span>Bloque</span>
                </button>
                <button
                  aria-pressed={terminalAppearance.cursorStyle === 'underline'}
                  className="ui-segmented__item"
                  onClick={() => handleUpdateTerminalAppearance({ cursorStyle: 'underline' })}
                  type="button"
                >
                  {terminalAppearance.cursorStyle === 'underline' && (
                    <SegmentedIndicator group="settings-terminal-cursor-style" />
                  )}
                  <span>Subrayado</span>
                </button>
              </fieldset>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Shell</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Shell por defecto</h3>
              <p>Intérprete de comandos para las nuevas pestañas de terminal.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <SelectMenu
                label="Tipo de shell"
                variant="field"
                className="settings-select"
                value={terminalShell}
                rows={SHELL_ROWS}
                triggerLabel={
                  SHELL_ROWS.find((row) => row.id === terminalShell)?.title ??
                  'Por defecto del sistema'
                }
                onSelect={handleTerminalShellChange}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Enlaces y Navegación Web</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Destino de enlaces web (URLs)</h3>
              <p>Elige dónde abrir los enlaces web (http/https) al hacer clic en la terminal.</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Destino de enlaces web" className="ui-segmented">
                <button
                  aria-pressed={terminalWebLinksTarget === 'internal'}
                  className="ui-segmented__item"
                  onClick={() => {
                    setTerminalWebLinksTargetState('internal');
                    setTerminalWebLinksTarget('internal');
                  }}
                  type="button"
                >
                  {terminalWebLinksTarget === 'internal' && (
                    <SegmentedIndicator group="settings-terminal-links-target" />
                  )}
                  <span>Navegador integrado</span>
                </button>
                <button
                  aria-pressed={terminalWebLinksTarget === 'external'}
                  className="ui-segmented__item"
                  onClick={() => {
                    setTerminalWebLinksTargetState('external');
                    setTerminalWebLinksTarget('external');
                  }}
                  type="button"
                >
                  {terminalWebLinksTarget === 'external' && (
                    <SegmentedIndicator group="settings-terminal-links-target" />
                  )}
                  <span>Navegador externo</span>
                </button>
              </fieldset>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Sessions</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Terminal host runtime</h3>
              <p>Integrated native daemon managing active shell sessions and scrollback.</p>
            </div>
            <div className="settings-row__control">
              <span className="settings-badge" data-tone="running">Online</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
};
