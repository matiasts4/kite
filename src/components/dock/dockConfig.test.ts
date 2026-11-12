import { describe, it, expect, beforeEach } from 'vitest';
import {
  TAB_CONFIGS,
  STANDARD_MENU_TABS,
  loadInitialTabs,
} from './dockConfig';

describe('dockConfig subagents registration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('registers subagents in TAB_CONFIGS and STANDARD_MENU_TABS with Ctrl+Alt+S shortcut', () => {
    expect(TAB_CONFIGS.subagents).toBeDefined();
    expect(TAB_CONFIGS.subagents.label).toBe('Subagents');
    expect(TAB_CONFIGS.subagents.closable).toBe(true);

    const menuEntry = STANDARD_MENU_TABS.find((t) => t.kind === 'subagents');
    expect(menuEntry).toBeDefined();
    expect(menuEntry?.label).toBe('Subagents');
    expect(menuEntry?.shortcut).toBe('Ctrl+Alt+S');
  });

  it('restores persisted subagents tab from localStorage', () => {
    localStorage.setItem(
      'kite-code.side-panel.tabs.v1',
      JSON.stringify({
        tabs: [
          { id: 'dashboard', kind: 'dashboard' },
          { id: 'subagents', kind: 'subagents' },
        ],
        selectedId: 'subagents',
      }),
    );

    const restored = loadInitialTabs();
    expect(restored.tabs.some((t) => t.kind === 'subagents')).toBe(true);
    expect(restored.activeTabId).toBe('subagents');
  });
});
