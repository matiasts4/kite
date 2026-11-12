export type ShortcutCategory = 'Navigation' | 'Modes' | 'Terminal & Code' | 'Voice';

export type SupportedPlatform = 'windows' | 'macos' | 'linux';

export interface ShortcutItem {
  id: string;
  action: string;
  category: ShortcutCategory;
  description: string;
  defaultKeys: string[];
  customKeys?: string[];
  allowNoModifier?: boolean;
}

export interface ShortcutValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
  conflictWith?: {
    id: string;
    action: string;
  };
  isReservedByOs?: boolean;
  osName?: string;
}

export interface ShortcutRecordModalProps {
  isOpen: boolean;
  shortcut: ShortcutItem | null;
  onClose: () => void;
  onSave: (id: string, keys: string[]) => void;
  onReset: (id: string) => void;
  platform?: SupportedPlatform;
}
