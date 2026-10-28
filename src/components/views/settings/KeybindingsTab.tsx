import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  getShortcuts,
  saveShortcut,
  resetShortcut,
  resetAllShortcuts,
  formatKeyCombination,
  getPlatform,
  SHORTCUTS_CHANGED_EVENT,
} from '../../../lib/shortcuts/shortcutsRegistry';
import { ShortcutCategory, ShortcutItem, SupportedPlatform } from '../../../lib/shortcuts/types';
import { ShortcutRecordModal } from '../../modals/ShortcutRecordModal';

export interface KeybindingsTabProps {
  platform?: SupportedPlatform;
}

export const KeybindingsTab: React.FC<KeybindingsTabProps> = ({ platform: propPlatform }) => {
  const platform = propPlatform || getPlatform();
  const [query, setQuery] = useState('');
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>(() => getShortcuts(platform));
  const [editingShortcut, setEditingShortcut] = useState<ShortcutItem | null>(null);

  // Sync state whenever shortcuts change
  const reloadShortcuts = useCallback(() => {
    setShortcuts(getShortcuts(platform));
  }, [platform]);

  useEffect(() => {
    reloadShortcuts();
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, reloadShortcuts);
    return () => window.removeEventListener(SHORTCUTS_CHANGED_EVENT, reloadShortcuts);
  }, [reloadShortcuts]);

  const customCount = useMemo(() => {
    return shortcuts.filter((s) => s.customKeys && s.customKeys.length > 0).length;
  }, [shortcuts]);

  const filtered = useMemo(() => {
    if (!query.trim()) return shortcuts;
    const q = query.toLowerCase();
    return shortcuts.filter((k) => {
      const activeKeys = k.customKeys || k.defaultKeys;
      const formatted = formatKeyCombination(activeKeys, platform).toLowerCase();
      const keysText = activeKeys.join('+').toLowerCase();
      return (
        k.action.toLowerCase().includes(q) ||
        k.description.toLowerCase().includes(q) ||
        keysText.includes(q) ||
        formatted.includes(q)
      );
    });
  }, [shortcuts, query, platform]);

  const categories: ShortcutCategory[] = ['Navigation', 'Modes', 'Terminal & Code', 'Voice'];

  const handleSave = (id: string, keys: string[]) => {
    saveShortcut(id, keys, platform);
    reloadShortcuts();
  };

  const handleReset = (id: string) => {
    resetShortcut(id);
    reloadShortcuts();
  };

  const handleResetAll = () => {
    resetAllShortcuts();
    reloadShortcuts();
  };

  return (
    <>
      <section className="settings-group">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <h2 className="settings-group__title" style={{ margin: 0 }}>
            Keyboard Shortcuts
          </h2>
          {customCount > 0 && (
            <button
              type="button"
              className="ghost-button action-button--row"
              onClick={handleResetAll}
              style={{ fontSize: 'var(--text-caption)' }}
              title="Restablecer todas las combinaciones personalizadas a los valores por defecto"
            >
              Restablecer todos ({customCount} personalizados)
            </button>
          )}
        </div>

        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Buscar atajos</h3>
              <p>Filtra comandos o presiona en cualquier atajo para editarlo y reasignar teclas.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <input
                aria-label="Filter keybindings"
                className="settings-control ui-button"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar atajos por nombre o tecla…"
                style={{ textAlign: 'left', minWidth: '220px' }}
                type="text"
                value={query}
              />
            </div>
          </div>
        </div>
      </section>

      {categories.map((cat) => {
        const items = filtered.filter((k) => k.category === cat);
        if (items.length === 0) return null;
        return (
          <section key={cat} className="settings-group">
            <h2 className="settings-group__title">{cat}</h2>
            <div className="ui-card">
              {items.map((item) => {
                const activeKeys = item.customKeys || item.defaultKeys;
                const isCustom = Boolean(item.customKeys && item.customKeys.length > 0);

                return (
                  <div
                    key={item.id}
                    className="ui-card__row settings-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setEditingShortcut(item)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setEditingShortcut(item);
                      }
                    }}
                    aria-label={`Editar atajo ${item.action}`}
                  >
                    <div className="settings-row__copy">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h3 className="settings-row__title">{item.action}</h3>
                        {isCustom && (
                          <span
                            style={{
                              fontSize: 'var(--text-badge, 10px)',
                              padding: '1px 6px',
                              borderRadius: 'var(--vl-radius-xs, 4px)',
                              background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                              color: 'var(--accent)',
                              fontWeight: 'var(--weight-semibold, 600)',
                            }}
                          >
                            Personalizado
                          </span>
                        )}
                      </div>
                      <p style={{ margin: '2px 0 0', fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>
                        {item.description}
                      </p>
                    </div>

                    <div
                      className="settings-row__control"
                      style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        className="dictation-shortcut__recorder"
                        style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}
                      >
                        {activeKeys.map((k, i) => (
                          <kbd
                            key={i}
                            style={{
                              padding: '2px 8px',
                              borderRadius: 'var(--vl-radius-xs, 4px)',
                              background: 'var(--chip-fill)',
                              border: '1px solid var(--block-stroke)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 'var(--text-caption, 11px)',
                              fontWeight: 'var(--weight-semibold)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>

                      {isCustom && (
                        <button
                          type="button"
                          className="ghost-button action-button--row"
                          onClick={() => handleReset(item.id)}
                          title="Restablecer este atajo al valor predeterminado"
                          style={{ padding: '0 8px', height: '26px', fontSize: '11px' }}
                        >
                          Restablecer
                        </button>
                      )}

                      <button
                        type="button"
                        className="secondary-button action-button--row"
                        onClick={() => setEditingShortcut(item)}
                        style={{ height: '28px', padding: '0 10px', fontSize: '12px' }}
                        title="Cambiar combinación de teclas"
                      >
                        Editar
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      <ShortcutRecordModal
        isOpen={editingShortcut !== null}
        shortcut={editingShortcut}
        onClose={() => setEditingShortcut(null)}
        onSave={handleSave}
        onReset={handleReset}
        platform={platform}
      />
    </>
  );
};
