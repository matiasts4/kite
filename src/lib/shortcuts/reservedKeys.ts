import { SupportedPlatform } from './types';

export interface ReservedShortcutRule {
  platforms: SupportedPlatform[];
  matches: (normalizedKeys: string[]) => boolean;
  reason: string;
  osName: string;
}

/**
 * Normalizes an array of keys into a canonical sorted order for comparison.
 * e.g., ['Shift', 'Ctrl', 'b'] -> ['Ctrl', 'Shift', 'B']
 */
export function normalizeKeysForComparison(keys: string[]): string[] {
  const modifiers: string[] = [];
  let mainKey = '';

  for (const raw of keys) {
    const k = raw.trim();
    const lower = k.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      if (!modifiers.includes('Ctrl')) modifiers.push('Ctrl');
    } else if (lower === 'alt' || lower === 'option') {
      if (!modifiers.includes('Alt')) modifiers.push('Alt');
    } else if (lower === 'shift') {
      if (!modifiers.includes('Shift')) modifiers.push('Shift');
    } else if (lower === 'cmd' || lower === 'meta' || lower === 'win' || lower === 'super') {
      if (!modifiers.includes('Meta')) modifiers.push('Meta');
    } else {
      // Main key
      mainKey = k.length === 1 ? k.toUpperCase() : k;
    }
  }

  // Sort modifiers in standard order: Ctrl, Alt, Shift, Meta
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return mainKey ? [...modifiers, mainKey] : modifiers;
}

function hasExactKeys(keys: string[], expected: string[]): boolean {
  const normActual = normalizeKeysForComparison(keys);
  const normExpected = normalizeKeysForComparison(expected);
  if (normActual.length !== normExpected.length) return false;
  return normActual.every((k, idx) => k.toLowerCase() === normExpected[idx].toLowerCase());
}

export const RESERVED_OS_RULES: ReservedShortcutRule[] = [
  // --- WINDOWS RESERVED ---
  {
    platforms: ['windows'],
    matches: (keys) =>
      hasExactKeys(keys, ['Alt', 'F4']),
    reason: 'Reservado por Windows para cerrar ventanas o la aplicación.',
    osName: 'Windows',
  },
  {
    platforms: ['windows'],
    matches: (keys) =>
      hasExactKeys(keys, ['Ctrl', 'Alt', 'Delete']) ||
      hasExactKeys(keys, ['Ctrl', 'Alt', 'Del']),
    reason: 'Interrupción de seguridad del kernel de Windows (Ctrl+Alt+Supr).',
    osName: 'Windows',
  },
  {
    platforms: ['windows'],
    matches: (keys) =>
      hasExactKeys(keys, ['Ctrl', 'Esc']),
    reason: 'Reservado por Windows para invocar el Menú Inicio.',
    osName: 'Windows',
  },
  {
    platforms: ['windows'],
    matches: (keys) =>
      hasExactKeys(keys, ['Alt', 'Tab']),
    reason: 'Reservado por Windows para alternar entre ventanas activas.',
    osName: 'Windows',
  },
  {
    platforms: ['windows'],
    matches: (keys) => {
      const norm = normalizeKeysForComparison(keys);
      // Windows intercepts Win + almost any key at the shell level
      return norm.includes('Meta');
    },
    reason: 'La tecla Windows (Win) está reservada para atajos globales del shell de Windows (Win+L, Win+D, Win+E, Win+R, etc.).',
    osName: 'Windows',
  },

  // --- MACOS RESERVED ---
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'Q']),
    reason: 'Reservado por macOS para salir completamente de la aplicación (Quit).',
    osName: 'macOS',
  },
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'H']),
    reason: 'Reservado por macOS para ocultar la ventana activa (Hide).',
    osName: 'macOS',
  },
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'Alt', 'H']),
    reason: 'Reservado por macOS para ocultar otras ventanas.',
    osName: 'macOS',
  },
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'M']),
    reason: 'Reservado por macOS para minimizar la ventana.',
    osName: 'macOS',
  },
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'Space']),
    reason: 'Reservado por macOS para Spotlight Search.',
    osName: 'macOS',
  },
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'Tab']),
    reason: 'Reservado por macOS para el selector de aplicaciones.',
    osName: 'macOS',
  },
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'Alt', 'Esc']),
    reason: 'Reservado por macOS para forzar la salida de aplicaciones.',
    osName: 'macOS',
  },
  {
    platforms: ['macos'],
    matches: (keys) =>
      hasExactKeys(keys, ['Meta', 'Shift', '3']) ||
      hasExactKeys(keys, ['Meta', 'Shift', '4']) ||
      hasExactKeys(keys, ['Meta', 'Shift', '5']),
    reason: 'Reservado por macOS para capturas y grabación de pantalla.',
    osName: 'macOS',
  },

  // --- LINUX RESERVED ---
  {
    platforms: ['linux'],
    matches: (keys) =>
      hasExactKeys(keys, ['Ctrl', 'Alt', 'T']),
    reason: 'Reservado por entornos Linux (GNOME/Ubuntu) para abrir la terminal del sistema.',
    osName: 'Linux',
  },
  {
    platforms: ['linux'],
    matches: (keys) =>
      hasExactKeys(keys, ['Ctrl', 'Alt', 'L']),
    reason: 'Reservado por entornos Linux para bloquear la pantalla.',
    osName: 'Linux',
  },
  {
    platforms: ['linux'],
    matches: (keys) =>
      hasExactKeys(keys, ['Alt', 'F2']),
    reason: 'Reservado por Linux para el lanzador rápido de aplicaciones.',
    osName: 'Linux',
  },
  {
    platforms: ['linux'],
    matches: (keys) => {
      const norm = normalizeKeysForComparison(keys);
      // Super key is reserved for activities/system overview
      return norm.includes('Meta');
    },
    reason: 'La tecla Super está reservada para el entorno gráfico de Linux (Activities / Menú principal).',
    osName: 'Linux',
  },

  // --- GENERAL BROWSER / WEBVIEW SYSTEM CONFLICTS ---
  {
    platforms: ['windows', 'macos', 'linux'],
    matches: (keys) =>
      hasExactKeys(keys, ['Ctrl', 'R']) ||
      hasExactKeys(keys, ['Meta', 'R']) ||
      hasExactKeys(keys, ['F5']),
    reason: 'Reservado por el navegador/webview para recargar la ventana.',
    osName: 'Sistema/Webview',
  },
  {
    platforms: ['windows', 'macos', 'linux'],
    matches: (keys) =>
      hasExactKeys(keys, ['Ctrl', 'Shift', 'R']) ||
      hasExactKeys(keys, ['Meta', 'Shift', 'R']) ||
      hasExactKeys(keys, ['Ctrl', 'F5']),
    reason: 'Reservado para forzar la recarga del navegador.',
    osName: 'Sistema/Webview',
  },
  {
    platforms: ['windows', 'macos', 'linux'],
    matches: (keys) =>
      hasExactKeys(keys, ['Ctrl', 'Shift', 'I']) ||
      hasExactKeys(keys, ['Meta', 'Alt', 'I']) ||
      hasExactKeys(keys, ['F12']),
    reason: 'Reservado por el motor web para abrir las herramientas de desarrollo (DevTools).',
    osName: 'Sistema/Webview',
  },
];

/**
 * Checks if a key combination is reserved by the host OS or Webview.
 */
export function checkOsReservedShortcut(
  keys: string[],
  platform: SupportedPlatform
): { isReserved: boolean; reason?: string; osName?: string } {
  const normalized = normalizeKeysForComparison(keys);

  for (const rule of RESERVED_OS_RULES) {
    if (rule.platforms.includes(platform) && rule.matches(normalized)) {
      return {
        isReserved: true,
        reason: rule.reason,
        osName: rule.osName,
      };
    }
  }

  return { isReserved: false };
}

/**
 * Validates whether the key combination has sufficient modifiers to avoid
 * breaking regular typing inside input fields or text editors.
 */
export function checkModifierRequirement(
  keys: string[],
  allowNoModifier = false
): { valid: boolean; error?: string } {
  if (keys.length === 0) {
    return { valid: false, error: 'Presiona al menos una tecla.' };
  }

  const normalized = normalizeKeysForComparison(keys);
  const modifiers = normalized.filter((k) => ['Ctrl', 'Alt', 'Shift', 'Meta'].includes(k));
  const mainKeys = normalized.filter((k) => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(k));

  if (mainKeys.length === 0) {
    return { valid: false, error: 'Debes presionar una tecla junto con los modificadores.' };
  }

  if (mainKeys.length > 1) {
    return { valid: false, error: 'Solo se permite una tecla principal combinada con modificadores.' };
  }

  const primary = mainKeys[0];

  // Specific single keys that are safe without modifiers
  const isFunctionKey = /^F([1-9]|1[0-2])$/i.test(primary);
  const isEscapeKey = /^Esc(ape)?$/i.test(primary);

  if (modifiers.length === 0) {
    if (allowNoModifier || isEscapeKey || isFunctionKey) {
      return { valid: true };
    }
    return {
      valid: false,
      error: 'Se requiere al menos una tecla modificadora (Ctrl, Alt, Shift o Cmd) para evitar interferir con la escritura.',
    };
  }

  return { valid: true };
}
