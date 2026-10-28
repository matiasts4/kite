/**
 * Lightweight settings navigation hub so any component (title-bar badge, quota
 * popover, notifications…) can send the user straight to a Settings tab
 * without prop-drilling through App.
 */
export const OPEN_SETTINGS_EVENT = 'bmone:open-settings';
export const SETTINGS_TAB_STORAGE_KEY = 'kite.settingsTab';
export const SETTINGS_PROVIDER_STORAGE_KEY = 'bmone.settingsProvider';

export interface OpenSettingsDetail {
  tab: string;
  /** Optional provider id to pre-select inside the tab (e.g. "antigravity"). */
  provider?: string;
}

export function openSettingsTab(tab: string, provider?: string): void {
  try {
    localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tab);
    if (provider) localStorage.setItem(SETTINGS_PROVIDER_STORAGE_KEY, provider);
    else localStorage.removeItem(SETTINGS_PROVIDER_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable; the event still carries the detail.
  }
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { tab, provider } })
  );
}
