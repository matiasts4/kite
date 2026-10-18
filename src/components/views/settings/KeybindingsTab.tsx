import React, { useState, useMemo } from 'react';

interface KeybindingItem {
  id: string;
  category: 'Navigation' | 'Modes' | 'Terminal & Code' | 'Voice';
  action: string;
  keys: string[];
}

const KEYBINDINGS: KeybindingItem[] = [
  { id: 'toggle-sidebar', category: 'Navigation', action: 'Toggle lateral sidebar', keys: ['Ctrl', 'B'] },
  { id: 'open-settings', category: 'Navigation', action: 'Open application settings', keys: ['Ctrl', ','] },
  { id: 'command-palette', category: 'Navigation', action: 'Open command palette', keys: ['Ctrl', 'P'] },
  { id: 'quick-switcher', category: 'Navigation', action: 'Quick switcher', keys: ['Ctrl', 'K'] },
  { id: 'back-esc', category: 'Navigation', action: 'Dismiss modal / Return', keys: ['Esc'] },

  { id: 'mode-agent', category: 'Modes', action: 'Switch to Agent mode', keys: ['Ctrl', '1'] },
  { id: 'mode-code', category: 'Modes', action: 'Switch to Code Workspace mode', keys: ['Ctrl', '2'] },
  { id: 'mode-chat', category: 'Modes', action: 'Switch to Chat mode', keys: ['Ctrl', '3'] },
  { id: 'toggle-dock', category: 'Modes', action: 'Toggle right dock / browser', keys: ['Ctrl', 'Shift', 'B'] },

  { id: 'new-terminal', category: 'Terminal & Code', action: 'Open new terminal', keys: ['Ctrl', 'Shift', '`'] },
  { id: 'split-vertical', category: 'Terminal & Code', action: 'Split pane vertically', keys: ['Ctrl', '\\'] },
  { id: 'split-horizontal', category: 'Terminal & Code', action: 'Split pane horizontally', keys: ['Ctrl', 'Shift', '\\'] },
  { id: 'close-pane', category: 'Terminal & Code', action: 'Close focused pane', keys: ['Ctrl', 'W'] },
  { id: 'save-file', category: 'Terminal & Code', action: 'Save active file', keys: ['Ctrl', 'S'] },

  { id: 'dictation-toggle', category: 'Voice', action: 'Start / Stop voice dictation', keys: ['Ctrl', 'Shift', 'D'] },
];

export const KeybindingsTab: React.FC = () => {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return KEYBINDINGS;
    const q = query.toLowerCase();
    return KEYBINDINGS.filter(
      (k) => k.action.toLowerCase().includes(q) || k.keys.join('+').toLowerCase().includes(q)
    );
  }, [query]);

  const categories: KeybindingItem['category'][] = ['Navigation', 'Modes', 'Terminal & Code', 'Voice'];

  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">Keyboard Shortcuts</h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Find keybindings</h3>
              <p>Type to filter shortcuts across application modes and terminal panes.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <input
                aria-label="Filter keybindings"
                className="settings-control ui-button"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search shortcuts…"
                style={{ textAlign: 'left', minWidth: '180px' }}
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
              {items.map((item) => (
                <div key={item.id} className="ui-card__row settings-row">
                  <div className="settings-row__copy">
                    <h3 className="settings-row__title">{item.action}</h3>
                  </div>
                  <div className="settings-row__control">
                    <div className="dictation-shortcut__recorder" style={{ display: 'inline-flex', gap: '4px' }}>
                      {item.keys.map((k, i) => (
                        <kbd key={i} style={{ padding: '2px 6px', borderRadius: '4px', background: 'var(--chip-fill)' }}>
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
};
