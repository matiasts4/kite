import { readKitePref, writeKitePref } from './kitePrefs';

export type AppearanceMode = 'dark' | 'light' | 'system';
export type ResolvedThemeMode = 'dark' | 'light';

export type BackdropPresetId =
  | 'theme-default'
  | 'none'
  | 'aurora-mesh'
  | 'alpine-dusk'
  | 'solar-horizon'
  | 'custom-image';

export type ConcreteBackdropPresetId = Exclude<BackdropPresetId, 'theme-default'>;

export type HeroFigureId =
  | 'theme-default'
  | 'pixel-companion'
  | 'isometric-construct'
  | 'editorial-botanical'
  | 'orbital-constellation'
  | 'kite-crest'
  | 'none';

export type ConcreteHeroFigureId = Exclude<HeroFigureId, 'theme-default'>;

export interface KiteBackdropSettings {
  preset: BackdropPresetId;
  customImageUrl: string;
  dimming: number;
  blur: number;
  grain: boolean;
}

export interface KiteFigureSettings {
  style: HeroFigureId;
  showWatermark: boolean;
}

export interface KiteSurfaceSettings {
  translucent: boolean;
  opacity: number;
  blur: number;
  contrast: number;
}

export interface KiteThemeOverrides {
  accent: string | null;
  surface: string | null;
  ink: string | null;
  diffAdded: string | null;
  diffRemoved: string | null;
  daltonizedDiffs: boolean;
  uiFont: string | null;
  codeFont: string | null;
}

export interface KiteThemeCustomizations {
  schemaVersion: 1;
  appearanceMode: AppearanceMode;
  darkThemeId: string;
  lightThemeId: string;
  backdrop: KiteBackdropSettings;
  figure: KiteFigureSettings;
  surface: KiteSurfaceSettings;
  overrides: KiteThemeOverrides;
}

export interface ThemePackTokens {
  background: string;
  pane: string;
  sidebar: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  diffAddition: string;
  diffDeletion: string;
  terminalBg: string;
  terminalFg: string;
  terminalCursor: string;
  terminalSelection: string;
  ansi: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
}

export interface VisualThemePack {
  id: string;
  name: string;
  mode: ResolvedThemeMode;
  blurb: string;
  badge?: string;
  defaultBackdrop: Exclude<BackdropPresetId, 'theme-default' | 'custom-image'>;
  defaultFigure: ConcreteHeroFigureId;
  defaultTranslucent: boolean;
  defaultGrain: boolean;
  syntaxTheme: string;
  tokens: ThemePackTokens;
}

export interface BackdropPresetDescriptor {
  id: BackdropPresetId;
  label: string;
  blurb: string;
  previewGradient: string;
}

export interface HeroFigureDescriptor {
  id: HeroFigureId;
  label: string;
  blurb: string;
}

export interface FontOptionDescriptor {
  id: string;
  label: string;
  value: string | null;
  sample: string;
}

export const THEME_CUSTOMIZATIONS_STORAGE_KEY = 'kite.themeCustomizations';

const DEFAULT_DARK_ANSI: ThemePackTokens['ansi'] = [
  '#18181b',
  '#ef4444',
  '#22c55e',
  '#eab308',
  '#3b82f6',
  '#a855f7',
  '#06b6d4',
  '#d4d4d8',
  '#52525b',
  '#f87171',
  '#4ade80',
  '#facc15',
  '#60a5fa',
  '#c084fc',
  '#22d3ee',
  '#fafafa',
];

const DEFAULT_LIGHT_ANSI: ThemePackTokens['ansi'] = [
  '#1f2937',
  '#dc2626',
  '#16a34a',
  '#ca8a04',
  '#2563eb',
  '#9333ea',
  '#0891b2',
  '#6b7280',
  '#4b5563',
  '#ef4444',
  '#22c55e',
  '#eab308',
  '#3b82f6',
  '#a855f7',
  '#06b6d4',
  '#111827',
];

export const VISUAL_THEME_PACKS: readonly VisualThemePack[] = [
  {
    id: 'kite-dark',
    name: 'Kite Dark',
    mode: 'dark',
    blurb: 'La paleta de carbón de la casa, optimizada para concentración profunda nocturna',
    badge: 'Estudio',
    defaultBackdrop: 'none',
    defaultFigure: 'kite-crest',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'pierre-dark',
    tokens: {
      background: '#090a0c',
      pane: '#0d0f12',
      sidebar: '#0b0d10',
      textPrimary: '#f3f4f6',
      textSecondary: '#9ca3af',
      accent: '#5c8fff',
      diffAddition: '#22c55e',
      diffDeletion: '#ef4444',
      terminalBg: '#0a0b0e',
      terminalFg: '#f3f4f6',
      terminalCursor: '#5c8fff',
      terminalSelection: 'rgba(92, 143, 255, 0.32)',
      ansi: DEFAULT_DARK_ANSI,
    },
  },
  {
    id: 'aurora-studio',
    name: 'Aurora Studio',
    mode: 'dark',
    blurb: 'Cintas de aurora atmosférica sobre cristal esmerilado de medianoche',
    badge: 'Atmosférico',
    defaultBackdrop: 'aurora-mesh',
    defaultFigure: 'orbital-constellation',
    defaultTranslucent: true,
    defaultGrain: true,
    syntaxTheme: 'tokyo-night',
    tokens: {
      background: '#070b14',
      pane: '#0d1424',
      sidebar: '#0a101d',
      textPrimary: '#e2e8f0',
      textSecondary: '#94a3b8',
      accent: '#38bdf8',
      diffAddition: '#34d399',
      diffDeletion: '#fb7185',
      terminalBg: '#080d18',
      terminalFg: '#e2e8f0',
      terminalCursor: '#38bdf8',
      terminalSelection: 'rgba(56, 189, 248, 0.28)',
      ansi: [
        '#0f172a',
        '#fb7185',
        '#34d399',
        '#fbbf24',
        '#38bdf8',
        '#a78bfa',
        '#2dd4bf',
        '#cbd5e1',
        '#475569',
        '#fda4af',
        '#6ee7b7',
        '#fde047',
        '#7dd3fc',
        '#c4b5fd',
        '#5eead4',
        '#f8fafc',
      ],
    },
  },
  {
    id: 'ember-editorial',
    name: 'Ember Editorial',
    mode: 'dark',
    blurb: 'Tinta carbón cálida con acentos terracota y arte botánico',
    badge: 'Editorial',
    defaultBackdrop: 'solar-horizon',
    defaultFigure: 'editorial-botanical',
    defaultTranslucent: true,
    defaultGrain: true,
    syntaxTheme: 'pierre-dark',
    tokens: {
      background: '#141210',
      pane: '#1c1916',
      sidebar: '#171412',
      textPrimary: '#f5f2eb',
      textSecondary: '#a8a29e',
      accent: '#d97757',
      diffAddition: '#4ade80',
      diffDeletion: '#f87171',
      terminalBg: '#151311',
      terminalFg: '#f5f2eb',
      terminalCursor: '#d97757',
      terminalSelection: 'rgba(217, 119, 87, 0.30)',
      ansi: DEFAULT_DARK_ANSI,
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    blurb: 'Azules neón sobre índigo profundo con atmósfera de aurora boreal',
    badge: 'Escena',
    defaultBackdrop: 'aurora-mesh',
    defaultFigure: 'pixel-companion',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'tokyo-night',
    tokens: {
      background: '#16161e',
      pane: '#1a1b26',
      sidebar: '#16161e',
      textPrimary: '#c0caf5',
      textSecondary: '#7982a9',
      accent: '#7aa2f7',
      diffAddition: '#73daca',
      diffDeletion: '#f7768e',
      terminalBg: '#16161e',
      terminalFg: '#c0caf5',
      terminalCursor: '#7aa2f7',
      terminalSelection: 'rgba(122, 162, 247, 0.28)',
      ansi: [
        '#15161e',
        '#f7768e',
        '#9ece6a',
        '#e0af68',
        '#7aa2f7',
        '#bb9af7',
        '#7dcfff',
        '#a9b1d6',
        '#414868',
        '#f7768e',
        '#9ece6a',
        '#e0af68',
        '#7aa2f7',
        '#bb9af7',
        '#7dcfff',
        '#c0caf5',
      ],
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    blurb: 'Acentos pastel sobre carbón cálido bajo un crepúsculo alpino',
    badge: 'Escena',
    defaultBackdrop: 'alpine-dusk',
    defaultFigure: 'pixel-companion',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'catppuccin-mocha',
    tokens: {
      background: '#181825',
      pane: '#1e1e2e',
      sidebar: '#181825',
      textPrimary: '#cdd6f4',
      textSecondary: '#a6adc8',
      accent: '#cba6f7',
      diffAddition: '#a6e3a1',
      diffDeletion: '#f38ba8',
      terminalBg: '#181825',
      terminalFg: '#cdd6f4',
      terminalCursor: '#cba6f7',
      terminalSelection: 'rgba(203, 166, 247, 0.28)',
      ansi: [
        '#45475a',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#bac2de',
        '#585b70',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#a6adc8',
      ],
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    blurb: 'Azules gélidos del Ártico con siluetas de cumbres alpinas',
    badge: 'Ártico',
    defaultBackdrop: 'alpine-dusk',
    defaultFigure: 'isometric-construct',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'nord',
    tokens: {
      background: '#242933',
      pane: '#2e3440',
      sidebar: '#292e39',
      textPrimary: '#eceff4',
      textSecondary: '#d8dee9',
      accent: '#88c0d0',
      diffAddition: '#a3be8c',
      diffDeletion: '#bf616a',
      terminalBg: '#242933',
      terminalFg: '#eceff4',
      terminalCursor: '#88c0d0',
      terminalSelection: 'rgba(136, 192, 208, 0.28)',
      ansi: [
        '#3b4252',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#88c0d0',
        '#e5e9f0',
        '#4c566a',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#8fbcbb',
        '#eceff4',
      ],
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    blurb: 'Rosas intensos sobre púrpura nocturno con destellos de aurora',
    badge: 'Escena',
    defaultBackdrop: 'aurora-mesh',
    defaultFigure: 'orbital-constellation',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'dracula',
    tokens: {
      background: '#1e1f29',
      pane: '#282a36',
      sidebar: '#21222c',
      textPrimary: '#f8f8f2',
      textSecondary: '#9ea4c7',
      accent: '#ff79c6',
      diffAddition: '#50fa7b',
      diffDeletion: '#ff5555',
      terminalBg: '#1e1f29',
      terminalFg: '#f8f8f2',
      terminalCursor: '#ff79c6',
      terminalSelection: 'rgba(255, 121, 198, 0.28)',
      ansi: [
        '#21222c',
        '#ff5555',
        '#50fa7b',
        '#f1fa8c',
        '#bd93f9',
        '#ff79c6',
        '#8be9fd',
        '#f8f8f2',
        '#6272a4',
        '#ff6e6e',
        '#69ff94',
        '#ffffa5',
        '#d6acff',
        '#ff92df',
        '#a4ffff',
        '#ffffff',
      ],
    },
  },
  {
    id: 'kite-light',
    name: 'Kite Light',
    mode: 'light',
    blurb: 'La paleta de la casa con luz diurna nítida',
    badge: 'Estudio',
    defaultBackdrop: 'none',
    defaultFigure: 'kite-crest',
    defaultTranslucent: false,
    defaultGrain: false,
    syntaxTheme: 'kite-light',
    tokens: {
      background: '#f8fafc',
      pane: '#ffffff',
      sidebar: '#f1f5f9',
      textPrimary: '#0f172a',
      textSecondary: '#475569',
      accent: '#2563eb',
      diffAddition: '#16a34a',
      diffDeletion: '#dc2626',
      terminalBg: '#f8fafc',
      terminalFg: '#0f172a',
      terminalCursor: '#2563eb',
      terminalSelection: 'rgba(37, 99, 235, 0.20)',
      ansi: DEFAULT_LIGHT_ANSI,
    },
  },
  {
    id: 'warm-atelier',
    name: 'Warm Atelier',
    mode: 'light',
    blurb: 'Marfil editorial limpio con tinta terracota y detalles botánicos',
    badge: 'Editorial',
    defaultBackdrop: 'none',
    defaultFigure: 'editorial-botanical',
    defaultTranslucent: true,
    defaultGrain: true,
    syntaxTheme: 'solarized-light',
    tokens: {
      background: '#faf8f4',
      pane: '#fffdf9',
      sidebar: '#f3efe6',
      textPrimary: '#1f1c18',
      textSecondary: '#665f54',
      accent: '#c86446',
      diffAddition: '#15803d',
      diffDeletion: '#b91c1c',
      terminalBg: '#f7f4ec',
      terminalFg: '#1f1c18',
      terminalCursor: '#c86446',
      terminalSelection: 'rgba(200, 100, 70, 0.22)',
      ansi: DEFAULT_LIGHT_ANSI,
    },
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    blurb: 'Acentos pastel sobre crema suave con horizonte solar cálido',
    badge: 'Escena',
    defaultBackdrop: 'solar-horizon',
    defaultFigure: 'pixel-companion',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'catppuccin-latte',
    tokens: {
      background: '#e6e9ef',
      pane: '#eff1f5',
      sidebar: '#e6e9ef',
      textPrimary: '#4c4f69',
      textSecondary: '#6c6f85',
      accent: '#8839ef',
      diffAddition: '#40a02b',
      diffDeletion: '#d20f39',
      terminalBg: '#eff1f5',
      terminalFg: '#4c4f69',
      terminalCursor: '#8839ef',
      terminalSelection: 'rgba(136, 57, 239, 0.20)',
      ansi: DEFAULT_LIGHT_ANSI,
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    blurb: 'Tonos equilibrados sobre pergamino cálido de archivo',
    badge: 'Papel',
    defaultBackdrop: 'none',
    defaultFigure: 'orbital-constellation',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'solarized-light',
    tokens: {
      background: '#eee8d5',
      pane: '#fdf6e3',
      sidebar: '#eee8d5',
      textPrimary: '#073642',
      textSecondary: '#586e75',
      accent: '#268bd2',
      diffAddition: '#859900',
      diffDeletion: '#dc322f',
      terminalBg: '#fdf6e3',
      terminalFg: '#073642',
      terminalCursor: '#268bd2',
      terminalSelection: 'rgba(38, 139, 210, 0.22)',
      ansi: DEFAULT_LIGHT_ANSI,
    },
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    mode: 'light',
    blurb: 'Superficies nítidas de revisión con alta legibilidad diurna',
    badge: 'Nítido',
    defaultBackdrop: 'none',
    defaultFigure: 'isometric-construct',
    defaultTranslucent: true,
    defaultGrain: false,
    syntaxTheme: 'github-light',
    tokens: {
      background: '#f6f8fa',
      pane: '#ffffff',
      sidebar: '#f6f8fa',
      textPrimary: '#1f2328',
      textSecondary: '#59636e',
      accent: '#0969da',
      diffAddition: '#1a7f37',
      diffDeletion: '#d1242f',
      terminalBg: '#f6f8fa',
      terminalFg: '#1f2328',
      terminalCursor: '#0969da',
      terminalSelection: 'rgba(9, 105, 218, 0.20)',
      ansi: DEFAULT_LIGHT_ANSI,
    },
  },
] as const;

export const BACKDROP_PRESETS: readonly BackdropPresetDescriptor[] = [
  {
    id: 'theme-default',
    label: 'Predeterminado del tema',
    blurb: 'Sigue la escena asignada por el tema activo',
    previewGradient: 'linear-gradient(135deg, var(--accent) 0%, var(--pane) 100%)',
  },
  {
    id: 'none',
    label: 'Lienzo limpio',
    blurb: 'Superficie arquitectónica plana sin fondo ilustrado',
    previewGradient: 'linear-gradient(135deg, var(--background) 0%, var(--pane) 100%)',
  },
  {
    id: 'aurora-mesh',
    label: 'Aurora Boreal',
    blurb: 'Cintas luminosas de aurora boreal sobre reflejos nocturnos',
    previewGradient: 'radial-gradient(circle at 20% 20%, #38bdf8 0%, #6366f1 45%, #0f172a 100%)',
  },
  {
    id: 'alpine-dusk',
    label: 'Crepúsculo Alpino',
    blurb: 'Siluetas de montañas al anochecer, bruma en el valle y cielo estrellado',
    previewGradient: 'linear-gradient(180deg, #1e1b4b 0%, #4c1d95 55%, #0f172a 100%)',
  },
  {
    id: 'solar-horizon',
    label: 'Horizonte Solar',
    blurb: 'Arco planetario terracota cálido sobre dunas basálticas',
    previewGradient: 'radial-gradient(circle at 50% 80%, #ea580c 0%, #7c2d12 45%, #1c1917 100%)',
  },
  {
    id: 'custom-image',
    label: 'Imagen personalizada',
    blurb: 'Tu propia URL de fondo o una imagen local subida',
    previewGradient: 'linear-gradient(135deg, #334155 0%, #0f172a 100%)',
  },
] as const;

export const HERO_FIGURE_OPTIONS: readonly HeroFigureDescriptor[] = [
  {
    id: 'theme-default',
    label: 'Predeterminado del tema',
    blurb: 'Coincide con la figura del paquete de tema activo',
  },
  {
    id: 'pixel-companion',
    label: 'Compañero Pixel',
    blurb: 'Mascota autónoma en pixel art con insignia de terminal',
  },
  {
    id: 'isometric-construct',
    label: 'Prisma Isométrico',
    blurb: 'Ensamblaje arquitectónico 3D de precisión',
  },
  {
    id: 'editorial-botanical',
    label: 'Botánica Editorial',
    blurb: 'Emblema botánico de línea fina y geometría solar cálida',
  },
  {
    id: 'orbital-constellation',
    label: 'Constelación Orbital',
    blurb: 'Anillos de astrolabio y nodos de inteligencia conectados',
  },
  {
    id: 'kite-crest',
    label: 'Emblema Kite',
    blurb: 'Insignia de cometa origami con sutil resplandor ambiental',
  },
  {
    id: 'none',
    label: 'Minimalista (Sin figura)',
    blurb: 'Estados vacíos tipográficos y limpios sin ilustraciones',
  },
] as const;

export const UI_FONT_OPTIONS: readonly FontOptionDescriptor[] = [
  { id: 'default', label: 'Predeterminada del sistema (Inter / SF)', value: null, sample: 'Aa' },
  {
    id: 'inter',
    label: 'Inter Geométrica',
    value: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
    sample: 'Aa',
  },
  {
    id: 'editorial-serif',
    label: 'Serif Editorial',
    value: '"Instrument Serif", "Newsreader", Georgia, Cambria, serif',
    sample: 'Aa',
  },
  {
    id: 'humanist',
    label: 'Sans Humanista',
    value: '"Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif',
    sample: 'Aa',
  },
  {
    id: 'accessible',
    label: 'Accesible amplia (Atkinson / Lexend)',
    value: '"Atkinson Hyperlegible", "Lexend", Verdana, sans-serif',
    sample: 'Aa',
  },
] as const;

export const CODE_FONT_OPTIONS: readonly FontOptionDescriptor[] = [
  { id: 'default', label: 'Monoespaciada predeterminada (JetBrains / SF Mono)', value: null, sample: '{}' },
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    value: '"JetBrains Mono", "Fira Code", monospace',
    sample: '{}',
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    value: '"Fira Code", "Cascadia Code", monospace',
    sample: '{}',
  },
  {
    id: 'ibm-plex',
    label: 'IBM Plex Mono',
    value: '"IBM Plex Mono", Consolas, monospace',
    sample: '{}',
  },
  {
    id: 'cascadia',
    label: 'Cascadia Mono',
    value: '"Cascadia Mono", "Consolas", monospace',
    sample: '{}',
  },
] as const;

export const BACKDROP_WALLPAPER_URLS: Partial<Record<ConcreteBackdropPresetId, string>> = {
  'aurora-mesh': '/wallpapers/aurora-mesh.jpg',
  'alpine-dusk': '/wallpapers/alpine-dusk.jpg',
  'solar-horizon': '/wallpapers/solar-horizon.jpg',
};

export const DEFAULT_THEME_CUSTOMIZATIONS: KiteThemeCustomizations = {
  schemaVersion: 1,
  appearanceMode: 'dark',
  darkThemeId: 'kite-dark',
  lightThemeId: 'kite-light',
  backdrop: {
    preset: 'theme-default',
    customImageUrl: '',
    dimming: 14,
    blur: 0,
    grain: false,
  },
  figure: {
    style: 'theme-default',
    showWatermark: false,
  },
  surface: {
    translucent: false,
    opacity: 56,
    blur: 20,
    contrast: 50,
  },
  overrides: {
    accent: null,
    surface: null,
    ink: null,
    diffAdded: null,
    diffRemoved: null,
    daltonizedDiffs: false,
    uiFont: null,
    codeFont: null,
  },
};

const VALID_BACKDROP_PRESETS = new Set<BackdropPresetId>(
  BACKDROP_PRESETS.map((item) => item.id)
);
const LEGACY_BACKDROP_MIGRATIONS: Record<string, BackdropPresetId> = {
  'cyber-prism': 'aurora-mesh',
  'architect-grid': 'alpine-dusk',
  'editorial-paper': 'none',
};
const VALID_HERO_FIGURES = new Set<HeroFigureId>(
  HERO_FIGURE_OPTIONS.map((item) => item.id)
);

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeColorString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed) || /^(rgb|hsl)a?\([^)]+\)$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export function sanitizeCustomImageUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().slice(0, 2_000_000);
  if (!trimmed || /["'()\r\n\\]/.test(trimmed)) return '';
  if (trimmed.startsWith('/')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\/(?:png|jpe?g|webp|gif|avif|bmp|ico);base64,[a-z0-9+/=]+$/i.test(trimmed)) {
    return trimmed;
  }
  return '';
}

export const DALTONIZED_DIFF_COLORS = {
  dark: { addition: '#38bdf8', deletion: '#f59e0b' },
  light: { addition: '#0284c7', deletion: '#d97706' },
} as const;

export function resolveActiveDiffColors(
  state: KiteThemeCustomizations,
  resolvedMode: ResolvedThemeMode = resolveThemeMode(state.appearanceMode)
): {
  diffAdded: string;
  diffRemoved: string;
  hasCustomDiffColors: boolean;
} {
  const pack = getThemePackById(getActivePaletteForState(state, resolvedMode));
  const daltonized = DALTONIZED_DIFF_COLORS[resolvedMode];
  const isCustomPack =
    pack.id === 'aurora-studio' || pack.id === 'ember-editorial' || pack.id === 'warm-atelier';

  const diffAdded = state.overrides.daltonizedDiffs
    ? daltonized.addition
    : state.overrides.diffAdded ?? pack.tokens.diffAddition;
  const diffRemoved = state.overrides.daltonizedDiffs
    ? daltonized.deletion
    : state.overrides.diffRemoved ?? pack.tokens.diffDeletion;

  const hasCustomDiffColors = Boolean(
    state.overrides.daltonizedDiffs ||
      state.overrides.diffAdded ||
      state.overrides.diffRemoved ||
      isCustomPack
  );

  return { diffAdded, diffRemoved, hasCustomDiffColors };
}

function sanitizeFontString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : null;
}

export function getThemePackById(id: string): VisualThemePack {
  const found = VISUAL_THEME_PACKS.find((pack) => pack.id === id);
  return found ?? VISUAL_THEME_PACKS[0];
}

export function isDarkThemeId(id: string): boolean {
  return VISUAL_THEME_PACKS.some((pack) => pack.id === id && pack.mode === 'dark');
}

export function isLightThemeId(id: string): boolean {
  return VISUAL_THEME_PACKS.some((pack) => pack.id === id && pack.mode === 'light');
}

export function detectSystemPrefersDark(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      if (mql && typeof mql.matches === 'boolean') {
        return mql.matches;
      }
    }
  } catch {
    // Fallback to dark when matchMedia is unavailable.
  }
  return true;
}

export function resolveThemeMode(
  mode: AppearanceMode,
  systemPrefersDark: boolean = detectSystemPrefersDark()
): ResolvedThemeMode {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark ? 'dark' : 'light';
}

export function getActivePaletteForState(
  state: KiteThemeCustomizations,
  resolvedMode: ResolvedThemeMode = resolveThemeMode(state.appearanceMode)
): string {
  return resolvedMode === 'light' ? state.lightThemeId : state.darkThemeId;
}

export function resolveEffectiveBackdropPreset(
  state: KiteThemeCustomizations,
  activePack: VisualThemePack
): ConcreteBackdropPresetId {
  if (state.backdrop.preset === 'theme-default') {
    return activePack.defaultBackdrop;
  }
  return state.backdrop.preset;
}

export function resolveEffectiveHeroFigure(
  state: KiteThemeCustomizations,
  activePack: VisualThemePack
): ConcreteHeroFigureId {
  if (state.figure.style === 'theme-default') {
    return activePack.defaultFigure;
  }
  return state.figure.style;
}

export function sanitizeThemeCustomizations(raw: unknown): KiteThemeCustomizations {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const appearanceMode: AppearanceMode =
    obj.appearanceMode === 'light' ||
    obj.appearanceMode === 'dark' ||
    obj.appearanceMode === 'system'
      ? obj.appearanceMode
      : DEFAULT_THEME_CUSTOMIZATIONS.appearanceMode;

  const rawDarkId = typeof obj.darkThemeId === 'string' ? obj.darkThemeId : '';
  const darkThemeId = isDarkThemeId(rawDarkId)
    ? rawDarkId
    : DEFAULT_THEME_CUSTOMIZATIONS.darkThemeId;

  const rawLightId = typeof obj.lightThemeId === 'string' ? obj.lightThemeId : '';
  const lightThemeId = isLightThemeId(rawLightId)
    ? rawLightId
    : DEFAULT_THEME_CUSTOMIZATIONS.lightThemeId;

  const rawBackdrop =
    typeof obj.backdrop === 'object' && obj.backdrop !== null
      ? (obj.backdrop as Record<string, unknown>)
      : {};
  const rawPreset = typeof rawBackdrop.preset === 'string' ? rawBackdrop.preset : '';
  const migratedPreset = LEGACY_BACKDROP_MIGRATIONS[rawPreset] ?? rawPreset;
  const preset: BackdropPresetId = VALID_BACKDROP_PRESETS.has(
    migratedPreset as BackdropPresetId
  )
    ? (migratedPreset as BackdropPresetId)
    : DEFAULT_THEME_CUSTOMIZATIONS.backdrop.preset;
  const customImageUrl = sanitizeCustomImageUrl(rawBackdrop.customImageUrl);

  const rawFigure =
    typeof obj.figure === 'object' && obj.figure !== null
      ? (obj.figure as Record<string, unknown>)
      : {};
  const figureStyle: HeroFigureId = VALID_HERO_FIGURES.has(rawFigure.style as HeroFigureId)
    ? (rawFigure.style as HeroFigureId)
    : DEFAULT_THEME_CUSTOMIZATIONS.figure.style;

  const rawSurface =
    typeof obj.surface === 'object' && obj.surface !== null
      ? (obj.surface as Record<string, unknown>)
      : {};

  const rawOverrides =
    typeof obj.overrides === 'object' && obj.overrides !== null
      ? (obj.overrides as Record<string, unknown>)
      : {};

  const migratedDimming =
    rawBackdrop.dimming === 24 && (rawBackdrop.blur === 0 || rawBackdrop.blur === undefined)
      ? DEFAULT_THEME_CUSTOMIZATIONS.backdrop.dimming
      : rawBackdrop.dimming;
  const migratedOpacity =
    rawSurface.opacity === 82 && (rawSurface.blur === 18 || rawSurface.blur === undefined)
      ? DEFAULT_THEME_CUSTOMIZATIONS.surface.opacity
      : rawSurface.opacity;
  const migratedSurfaceBlur =
    rawSurface.opacity === 82 && rawSurface.blur === 18
      ? DEFAULT_THEME_CUSTOMIZATIONS.surface.blur
      : rawSurface.blur;

  return {
    schemaVersion: 1,
    appearanceMode,
    darkThemeId,
    lightThemeId,
    backdrop: {
      preset,
      customImageUrl,
      dimming: clampNumber(
        migratedDimming,
        0,
        100,
        DEFAULT_THEME_CUSTOMIZATIONS.backdrop.dimming
      ),
      blur: clampNumber(rawBackdrop.blur, 0, 32, DEFAULT_THEME_CUSTOMIZATIONS.backdrop.blur),
      grain:
        typeof rawBackdrop.grain === 'boolean'
          ? rawBackdrop.grain
          : DEFAULT_THEME_CUSTOMIZATIONS.backdrop.grain,
    },
    figure: {
      style: figureStyle,
      showWatermark:
        typeof rawFigure.showWatermark === 'boolean'
          ? rawFigure.showWatermark
          : DEFAULT_THEME_CUSTOMIZATIONS.figure.showWatermark,
    },
    surface: {
      translucent:
        typeof rawSurface.translucent === 'boolean'
          ? rawSurface.translucent
          : DEFAULT_THEME_CUSTOMIZATIONS.surface.translucent,
      opacity: clampNumber(
        migratedOpacity,
        15,
        95,
        DEFAULT_THEME_CUSTOMIZATIONS.surface.opacity
      ),
      blur: clampNumber(migratedSurfaceBlur, 0, 32, DEFAULT_THEME_CUSTOMIZATIONS.surface.blur),
      contrast: clampNumber(
        rawSurface.contrast,
        0,
        100,
        DEFAULT_THEME_CUSTOMIZATIONS.surface.contrast
      ),
    },
    overrides: {
      accent: sanitizeColorString(rawOverrides.accent),
      surface: sanitizeColorString(rawOverrides.surface),
      ink: sanitizeColorString(rawOverrides.ink),
      diffAdded: sanitizeColorString(rawOverrides.diffAdded),
      diffRemoved: sanitizeColorString(rawOverrides.diffRemoved),
      daltonizedDiffs:
        typeof rawOverrides.daltonizedDiffs === 'boolean'
          ? rawOverrides.daltonizedDiffs
          : DEFAULT_THEME_CUSTOMIZATIONS.overrides.daltonizedDiffs,
      uiFont: sanitizeFontString(rawOverrides.uiFont),
      codeFont: sanitizeFontString(rawOverrides.codeFont),
    },
  };
}

export function readThemeCustomizations(): KiteThemeCustomizations {
  try {
    const rawJson = localStorage.getItem(THEME_CUSTOMIZATIONS_STORAGE_KEY);
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      return sanitizeThemeCustomizations(parsed);
    }
  } catch {
    // Fall through to legacy migration.
  }

  const savedTheme = readKitePref('theme');
  const savedPalette = readKitePref('palette');

  const appearanceMode: AppearanceMode =
    savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system'
      ? savedTheme
      : 'dark';

  let darkThemeId = DEFAULT_THEME_CUSTOMIZATIONS.darkThemeId;
  let lightThemeId = DEFAULT_THEME_CUSTOMIZATIONS.lightThemeId;

  if (savedPalette) {
    if (isDarkThemeId(savedPalette)) {
      darkThemeId = savedPalette;
    } else if (isLightThemeId(savedPalette)) {
      lightThemeId = savedPalette;
    }
  }

  return sanitizeThemeCustomizations({
    ...DEFAULT_THEME_CUSTOMIZATIONS,
    appearanceMode,
    darkThemeId,
    lightThemeId,
  });
}

export function writeThemeCustomizations(state: KiteThemeCustomizations): void {
  const sanitized = sanitizeThemeCustomizations(state);
  const resolvedMode = resolveThemeMode(sanitized.appearanceMode);
  const activePalette = getActivePaletteForState(sanitized, resolvedMode);

  try {
    localStorage.setItem(THEME_CUSTOMIZATIONS_STORAGE_KEY, JSON.stringify(sanitized));
    writeKitePref('theme', resolvedMode);
    writeKitePref('palette', activePalette);
  } catch {
    // Storage may be unavailable.
  }
}

export function applyThemeCustomizationsToDocument(state: KiteThemeCustomizations): {
  resolvedMode: ResolvedThemeMode;
  activePalette: string;
  pack: VisualThemePack;
  effectiveBackdrop: ConcreteBackdropPresetId;
  effectiveFigure: ConcreteHeroFigureId;
} {
  const resolvedMode = resolveThemeMode(state.appearanceMode);
  const activePalette = getActivePaletteForState(state, resolvedMode);
  const pack = getThemePackById(activePalette);
  const effectiveBackdrop = resolveEffectiveBackdropPreset(state, pack);
  const effectiveFigure = resolveEffectiveHeroFigure(state, pack);
  const effectiveTranslucent =
    state.surface.translucent || effectiveBackdrop !== 'none';

  const root = document.documentElement;
  root.setAttribute('data-theme', resolvedMode);
  root.setAttribute('data-palette', activePalette);
  root.setAttribute('data-appearance-mode', state.appearanceMode);
  root.setAttribute('data-backdrop', effectiveBackdrop);
  root.setAttribute('data-figure', effectiveFigure);
  root.setAttribute('data-surface-glass', effectiveTranslucent ? 'true' : 'false');
  root.setAttribute(
    'data-daltonized-diffs',
    state.overrides.daltonizedDiffs ? 'true' : 'false'
  );
  root.setAttribute(
    'data-contrast-custom',
    state.surface.contrast !== 50 ? 'true' : 'false'
  );
  root.classList.toggle('dark', resolvedMode === 'dark');
  root.classList.toggle('light', resolvedMode === 'light');

  const targets = [
    document.querySelector('.app-frame') as HTMLElement | null,
    document.querySelector('.zoom-viewport') as HTMLElement | null,
  ];
  const styleTargets: HTMLElement[] = [root, ...targets.filter((el): el is HTMLElement => Boolean(el))];
  const setThemeVar = (prop: string, val: string) => {
    for (const el of styleTargets) {
      el.style.setProperty(prop, val);
    }
  };
  const removeThemeVar = (prop: string) => {
    for (const el of styleTargets) {
      el.style.removeProperty(prop);
    }
  };

  // Stage & surface CSS variables
  setThemeVar('--theme-surface-opacity', `${state.surface.opacity}%`);
  setThemeVar('--theme-surface-blur', `${state.surface.blur}px`);
  setThemeVar('--theme-contrast', String(state.surface.contrast));
  setThemeVar('--theme-backdrop-dim', `${state.backdrop.dimming}%`);
  setThemeVar('--theme-backdrop-blur', `${state.backdrop.blur}px`);

  // Theme Pack base tokens for new packs (`aurora-studio`, `ember-editorial`, `warm-atelier`)
  // and custom overrides
  const isCustomPack =
    activePalette === 'aurora-studio' ||
    activePalette === 'ember-editorial' ||
    activePalette === 'warm-atelier';

  const effectiveSurface =
    state.overrides.surface ?? (isCustomPack ? pack.tokens.pane : null);
  const effectiveBackground =
    state.overrides.surface ?? (isCustomPack ? pack.tokens.background : null);
  const effectiveSidebar =
    state.overrides.surface ?? (isCustomPack ? pack.tokens.sidebar : null);
  const effectiveInk =
    state.overrides.ink ?? (isCustomPack ? pack.tokens.textPrimary : null);
  const effectiveSecondaryInk =
    !state.overrides.ink && isCustomPack ? pack.tokens.textSecondary : null;
  const effectiveAccent =
    state.overrides.accent ?? (isCustomPack ? pack.tokens.accent : null);

  if (effectiveBackground) {
    setThemeVar('--background', effectiveBackground);
  } else {
    removeThemeVar('--background');
  }

  if (effectiveSurface) {
    setThemeVar('--pane', effectiveSurface);
    setThemeVar('--composer', effectiveSurface);
    setThemeVar('--menu-plate', effectiveSurface);
  } else {
    removeThemeVar('--pane');
    removeThemeVar('--composer');
    removeThemeVar('--menu-plate');
  }

  if (effectiveSidebar) {
    setThemeVar('--sidebar-fill', effectiveSidebar);
  } else {
    removeThemeVar('--sidebar-fill');
  }

  if (effectiveInk) {
    setThemeVar('--text-primary', effectiveInk);
  } else {
    removeThemeVar('--text-primary');
  }

  if (effectiveSecondaryInk) {
    setThemeVar('--text-secondary', effectiveSecondaryInk);
  } else {
    removeThemeVar('--text-secondary');
  }

  if (effectiveAccent) {
    setThemeVar('--accent', effectiveAccent);
    setThemeVar(
      '--accent-fill',
      `color-mix(in srgb, ${effectiveAccent} 16%, transparent)`
    );
  } else {
    removeThemeVar('--accent');
    removeThemeVar('--accent-fill');
  }

  // Diff semantic colors & daltonized override
  const { diffAdded, diffRemoved, hasCustomDiffColors } = resolveActiveDiffColors(
    state,
    resolvedMode
  );

  if (hasCustomDiffColors) {
    setThemeVar('--diff-addition', diffAdded);
    setThemeVar('--diff-deletion', diffRemoved);
  } else {
    removeThemeVar('--diff-addition');
    removeThemeVar('--diff-deletion');
  }

  // Font overrides
  if (state.overrides.uiFont) {
    setThemeVar('--font-sans', state.overrides.uiFont);
  } else {
    removeThemeVar('--font-sans');
  }

  if (state.overrides.codeFont) {
    setThemeVar('--font-mono', state.overrides.codeFont);
  } else {
    removeThemeVar('--font-mono');
  }

  // Terminal tokens
  const termBg = state.overrides.surface ?? pack.tokens.terminalBg;
  const termFg = state.overrides.ink ?? pack.tokens.terminalFg;
  const termCursor = state.overrides.accent ?? pack.tokens.terminalCursor;
  setThemeVar('--terminal-canvas', termBg);
  setThemeVar('--terminal-fg', termFg);
  setThemeVar('--terminal-cursor', termCursor);
  setThemeVar('--terminal-selection', pack.tokens.terminalSelection);

  for (const el of targets) {
    if (el) {
      el.setAttribute('data-theme', resolvedMode);
      el.setAttribute('data-palette', activePalette);
      el.setAttribute('data-backdrop', effectiveBackdrop);
      el.setAttribute('data-figure', effectiveFigure);
      el.setAttribute('data-surface-glass', effectiveTranslucent ? 'true' : 'false');
    }
  }

  return {
    resolvedMode,
    activePalette,
    pack,
    effectiveBackdrop,
    effectiveFigure,
  };
}

export function preseedThemeCustomizationsOnBoot(): void {
  try {
    const state = readThemeCustomizations();
    applyThemeCustomizationsToDocument(state);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-palette', 'kite-dark');
  }
}

export function exportThemeString(state: KiteThemeCustomizations): string {
  const sanitized = sanitizeThemeCustomizations(state);
  return `kite-theme-v1:${JSON.stringify(sanitized)}`;
}

export function exportThemeJson(state: KiteThemeCustomizations): string {
  const sanitized = sanitizeThemeCustomizations(state);
  return JSON.stringify(sanitized, null, 2);
}

export function importThemePayload(
  input: string,
  current: KiteThemeCustomizations = readThemeCustomizations()
): { ok: true; state: KiteThemeCustomizations; summary: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'Pega primero una cadena kite-theme-v1 o un JSON de tema.' };
  }

  let jsonPart = trimmed;
  let prefixKind: 'kite' | 'external' | 'json' = 'json';

  const prefixMatch = /^([a-z0-9-]+)-theme-v1:([\s\S]+)$/i.exec(trimmed);
  if (prefixMatch) {
    prefixKind = prefixMatch[1].toLowerCase() === 'kite' ? 'kite' : 'external';
    jsonPart = prefixMatch[2].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return {
      ok: false,
      error: 'Formato de tema inválido. Se esperaba kite-theme-v1:{...} o JSON válido.',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'El paquete del tema debe ser un objeto JSON.' };
  }

  const record = parsed as Record<string, unknown>;

  // 1. Native KiteThemeCustomizations shape
  if (
    prefixKind === 'kite' ||
    typeof record.darkThemeId === 'string' ||
    typeof record.lightThemeId === 'string' ||
    typeof record.appearanceMode === 'string'
  ) {
    const merged = sanitizeThemeCustomizations({
      ...current,
      ...record,
    });
    const activePack = getThemePackById(getActivePaletteForState(merged));
    const modeLabel =
      merged.appearanceMode === 'light'
        ? 'claro'
        : merged.appearanceMode === 'dark'
          ? 'oscuro'
          : 'sistema';
    return {
      ok: true,
      state: merged,
      summary: `Tema ${activePack.name} importado (modo ${modeLabel})`,
    };
  }

  // 2. Portable *-theme-v1 shape (`{ codeThemeId, variant, theme: { accent, contrast, fonts, ink, opaqueWindows, semanticColors, surface } }`)
  if (typeof record.theme === 'object' && record.theme !== null) {
    const themeObj = record.theme as Record<string, unknown>;
    const variant: ResolvedThemeMode = record.variant === 'light' ? 'light' : 'dark';
    const codeThemeId = typeof record.codeThemeId === 'string' ? record.codeThemeId : '';
    const matchedPackId =
      variant === 'light'
        ? isLightThemeId(codeThemeId)
          ? codeThemeId
          : current.lightThemeId
        : isDarkThemeId(codeThemeId)
          ? codeThemeId
          : current.darkThemeId;

    const fontsObj =
      typeof themeObj.fonts === 'object' && themeObj.fonts !== null
        ? (themeObj.fonts as Record<string, unknown>)
        : {};
    const semanticObj =
      typeof themeObj.semanticColors === 'object' && themeObj.semanticColors !== null
        ? (themeObj.semanticColors as Record<string, unknown>)
        : {};

    const opaqueWindows =
      typeof themeObj.opaqueWindows === 'boolean' ? themeObj.opaqueWindows : true;

    const nextState = sanitizeThemeCustomizations({
      ...current,
      appearanceMode: variant,
      darkThemeId: variant === 'dark' ? matchedPackId : current.darkThemeId,
      lightThemeId: variant === 'light' ? matchedPackId : current.lightThemeId,
      surface: {
        ...current.surface,
        translucent: !opaqueWindows,
        contrast: clampNumber(themeObj.contrast, 0, 100, current.surface.contrast),
      },
      overrides: {
        ...current.overrides,
        accent: sanitizeColorString(themeObj.accent),
        surface: sanitizeColorString(themeObj.surface),
        ink: sanitizeColorString(themeObj.ink),
        diffAdded: sanitizeColorString(semanticObj.diffAdded),
        diffRemoved: sanitizeColorString(semanticObj.diffRemoved),
        uiFont: sanitizeFontString(fontsObj.ui),
        codeFont: sanitizeFontString(fontsObj.code),
      },
    });

    const variantLabel = variant === 'light' ? 'claro' : 'oscuro';
    return {
      ok: true,
      state: nextState,
      summary: `Tema portátil ${variantLabel} importado${codeThemeId ? ` (${codeThemeId})` : ''}`,
    };
  }

  // 3. Override JSON shape (`{ name, base, overrides: { ... } }`)
  if (typeof record.overrides === 'object' && record.overrides !== null) {
    const ov = record.overrides as Record<string, unknown>;
    const baseMode: ResolvedThemeMode = record.base === 'light' ? 'light' : 'dark';
    const nextState = sanitizeThemeCustomizations({
      ...current,
      appearanceMode: baseMode,
      overrides: {
        ...current.overrides,
        accent: sanitizeColorString(ov.accent ?? ov.primary ?? ov.brand),
        surface: sanitizeColorString(ov.surface ?? ov.background),
        ink: sanitizeColorString(ov.ink ?? ov.foreground ?? ov.text),
        diffAdded: sanitizeColorString(ov.diffAdded),
        diffRemoved: sanitizeColorString(ov.diffRemoved),
      },
    });
    const label = typeof record.name === 'string' ? record.name : baseMode === 'light' ? 'claro' : 'oscuro';
    return {
      ok: true,
      state: nextState,
      summary: `Ajustes de tema importados (${label})`,
    };
  }

  return {
    ok: false,
    error: 'Esquema de tema no reconocido. Se esperaba kite-theme-v1 o campos de ajustes de tema.',
  };
}
