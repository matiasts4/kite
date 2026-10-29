export type TerminalRendererMode = 'dom' | 'webgl';

export type TerminalFontFamilyId =
  | 'cascadia'
  | 'jetbrains'
  | 'geist'
  | 'fira'
  | 'consolas';

export type TerminalCursorStyle = 'bar' | 'block' | 'underline';

export interface TerminalAppearancePrefs {
  renderer: TerminalRendererMode;
  fontFamilyId: TerminalFontFamilyId;
  fontSize: number;       // Clamped 10..22, default 13
  lineHeight: number;     // Allowed presets or clamped 1.0..1.4, default 1.16
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
}

export const TERMINAL_APPEARANCE_STORAGE_KEY = 'kite.terminalAppearancePrefs';
export const TERMINAL_APPEARANCE_CHANGED_EVENT = 'kite:terminal-appearance-changed';

export const DEFAULT_TERMINAL_APPEARANCE_PREFS: TerminalAppearancePrefs = {
  renderer: 'dom',
  fontFamilyId: 'cascadia',
  fontSize: 13,
  lineHeight: 1.16,
  cursorStyle: 'bar',
  cursorBlink: false,
};

export const TERMINAL_FONT_MAP: Record<TerminalFontFamilyId, string> = {
  cascadia: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  geist: '"Geist Mono", "Cascadia Mono", Consolas, monospace',
  fira: '"Fira Code", "Cascadia Mono", Consolas, monospace',
  consolas: 'Consolas, "Cascadia Mono", monospace',
};

export interface TerminalFontOption {
  id: TerminalFontFamilyId;
  label: string;
  stack: string;
}

export const TERMINAL_FONT_OPTIONS: readonly TerminalFontOption[] = [
  { id: 'cascadia', label: 'Cascadia Mono (Clásico)', stack: TERMINAL_FONT_MAP.cascadia },
  { id: 'jetbrains', label: 'JetBrains Mono', stack: TERMINAL_FONT_MAP.jetbrains },
  { id: 'geist', label: 'Geist Mono', stack: TERMINAL_FONT_MAP.geist },
  { id: 'fira', label: 'Fira Code', stack: TERMINAL_FONT_MAP.fira },
  { id: 'consolas', label: 'Consolas', stack: TERMINAL_FONT_MAP.consolas },
];

export interface TerminalLineHeightPreset {
  label: string;
  value: number;
  description: string;
}

export const TERMINAL_LINE_HEIGHT_PRESETS: readonly TerminalLineHeightPreset[] = [
  { label: 'Clásico (1.16)', value: 1.16, description: 'Espaciado original de Kite con lectura cómoda.' },
  { label: 'Balanceado (1.08)', value: 1.08, description: 'Densidad intermedia para paneles divididos.' },
  { label: 'Compacto (1.0)', value: 1.0, description: 'Máxima densidad vertical para TUIs de pantalla completa.' },
];

export function resolveTerminalFontFamily(fontFamilyId: TerminalFontFamilyId | string): string {
  if (typeof fontFamilyId === 'string' && fontFamilyId in TERMINAL_FONT_MAP) {
    return TERMINAL_FONT_MAP[fontFamilyId as TerminalFontFamilyId];
  }
  return TERMINAL_FONT_MAP.cascadia;
}

export function clampTerminalFontSize(fontSize: number): number {
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize)) {
    return DEFAULT_TERMINAL_APPEARANCE_PREFS.fontSize;
  }
  return Math.min(22, Math.max(10, Math.round(fontSize)));
}

export function clampTerminalLineHeight(lineHeight: number): number {
  if (typeof lineHeight !== 'number' || !Number.isFinite(lineHeight)) {
    return DEFAULT_TERMINAL_APPEARANCE_PREFS.lineHeight;
  }
  const rounded = Number(lineHeight.toFixed(2));
  return Number(Math.min(1.4, Math.max(1.0, rounded)).toFixed(2));
}

export function sanitizeTerminalAppearancePrefs(
  input: unknown,
  base: TerminalAppearancePrefs = DEFAULT_TERMINAL_APPEARANCE_PREFS
): TerminalAppearancePrefs {
  if (!input || typeof input !== 'object') {
    return { ...base };
  }
  const obj = input as Partial<Record<keyof TerminalAppearancePrefs, unknown>>;

  const renderer: TerminalRendererMode =
    obj.renderer === 'webgl' ? 'webgl' : obj.renderer === 'dom' ? 'dom' : base.renderer;

  const fontFamilyId: TerminalFontFamilyId =
    typeof obj.fontFamilyId === 'string' && obj.fontFamilyId in TERMINAL_FONT_MAP
      ? (obj.fontFamilyId as TerminalFontFamilyId)
      : base.fontFamilyId;

  const fontSize =
    typeof obj.fontSize === 'number'
      ? clampTerminalFontSize(obj.fontSize)
      : base.fontSize;

  const lineHeight =
    typeof obj.lineHeight === 'number'
      ? clampTerminalLineHeight(obj.lineHeight)
      : base.lineHeight;

  const cursorStyle: TerminalCursorStyle =
    obj.cursorStyle === 'block' || obj.cursorStyle === 'underline' || obj.cursorStyle === 'bar'
      ? obj.cursorStyle
      : base.cursorStyle;

  const cursorBlink = typeof obj.cursorBlink === 'boolean' ? obj.cursorBlink : base.cursorBlink;

  return {
    renderer,
    fontFamilyId,
    fontSize,
    lineHeight,
    cursorStyle,
    cursorBlink,
  };
}

export function getTerminalAppearancePrefs(): TerminalAppearancePrefs {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(TERMINAL_APPEARANCE_STORAGE_KEY);
      if (raw) {
        return sanitizeTerminalAppearancePrefs(JSON.parse(raw));
      }
    }
  } catch {}
  return { ...DEFAULT_TERMINAL_APPEARANCE_PREFS };
}

export function setTerminalAppearancePrefs(
  patch: Partial<TerminalAppearancePrefs>
): TerminalAppearancePrefs {
  const current = getTerminalAppearancePrefs();
  const next = sanitizeTerminalAppearancePrefs({ ...current, ...patch });

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TERMINAL_APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {}

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<TerminalAppearancePrefs>(TERMINAL_APPEARANCE_CHANGED_EVENT, {
        detail: next,
      })
    );
  }

  return next;
}

export function resetTerminalAppearancePrefs(): TerminalAppearancePrefs {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        TERMINAL_APPEARANCE_STORAGE_KEY,
        JSON.stringify(DEFAULT_TERMINAL_APPEARANCE_PREFS)
      );
    }
  } catch {}

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<TerminalAppearancePrefs>(TERMINAL_APPEARANCE_CHANGED_EVENT, {
        detail: { ...DEFAULT_TERMINAL_APPEARANCE_PREFS },
      })
    );
  }

  return { ...DEFAULT_TERMINAL_APPEARANCE_PREFS };
}
