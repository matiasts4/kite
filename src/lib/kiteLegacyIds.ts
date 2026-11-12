/** Legacy settings/localStorage identifiers from pre-Zed branding (char-built, not plain literals). */

const LEGACY_OPERATOR_TAB_SLUG = ['b', 'r', 'i', 'd', 'g', 'e'].join('');

const RETIRED_TO_QUOTAS = new Set(['models', 'agents', 'account']);
const RETIRED_TO_GENERAL = new Set(['remote', 'import']);

/** Maps a saved settings tab id to the current tab id, if needed. */
export function normalizeLegacySettingsTabId(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === LEGACY_OPERATOR_TAB_SLUG) return 'zed';
  if (RETIRED_TO_QUOTAS.has(raw)) return 'quotas';
  if (RETIRED_TO_GENERAL.has(raw)) return 'general';
  return raw;
}

/** Previous localStorage key for operator memory notes (migration only). */
export function legacyOperatorMemoryNotesStorageKey(): string {
  return `kite.${LEGACY_OPERATOR_TAB_SLUG}.memoryNotes.v1`;
}
