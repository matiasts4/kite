export type SettingsTabId = 'general' | 'models' | 'usage';
export type ApprovalMode = 'ask' | 'auto' | 'never';
export type LanguageId = 'es' | 'en' | 'pt';
export type ModelId = 'opus' | 'sonnet' | 'haiku';

export interface SettingsValues {
  streaming: boolean;
  remember: boolean;
  approval: ApprovalMode;
  language: LanguageId;
  model: ModelId;
  temperature: number;
  workspace: string;
}

export interface SettingsHandlers {
  onStreaming: () => void;
  onRemember: () => void;
  onApproval: (next: ApprovalMode) => void;
  onLanguage: (next: LanguageId) => void;
  onModel: (next: ModelId) => void;
  onTemperature: (next: number) => void;
  onWorkspace: (next: string) => void;
  onTouchWorkspace: () => void;
}

export const DEFAULT_SETTINGS: SettingsValues = {
  streaming: true,
  remember: false,
  approval: 'ask',
  language: 'es',
  model: 'opus',
  temperature: 40,
  workspace: 'kite-motion',
};

export const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Modelos' },
  { id: 'usage', label: 'Consumo' },
];

export const SETTINGS_SECTIONS = [
  {
    id: 'context',
    title: 'Contexto del agente',
    body: 'Cuando el hilo crece, Kite resume las últimas herramientas y conserva el borde vivo.',
  },
  {
    id: 'permissions',
    title: 'Permisos y aprobaciones',
    body: 'Las escrituras piden aprobación; las lecturas pasan sin interrumpir.',
  },
];

export const APPROVAL_OPTIONS: { id: ApprovalMode; label: string }[] = [
  { id: 'ask', label: 'Preguntar' },
  { id: 'auto', label: 'Automático' },
  { id: 'never', label: 'Nunca' },
];

export const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  ask: 'Preguntar',
  auto: 'Automático',
  never: 'Nunca',
};

export const LANGUAGE_OPTIONS = [
  { id: 'es', label: 'Español' },
  { id: 'en', label: 'English' },
  { id: 'pt', label: 'Português' },
];

export const MODEL_OPTIONS = [
  { id: 'opus', label: 'Kite 2 · Opus' },
  { id: 'sonnet', label: 'Kite 2 · Sonnet' },
  { id: 'haiku', label: 'Kite 2 · Haiku' },
];

export function workspaceError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'El nombre no puede estar vacío.';
  if (trimmed.length < 3) return 'Usá al menos 3 caracteres.';
  if (trimmed.length > 24) return 'Máximo 24 caracteres.';
  return null;
}
