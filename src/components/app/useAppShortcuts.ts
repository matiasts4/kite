import type React from 'react';
import { useGlobalShortcuts } from '../../lib/shortcuts/useGlobalShortcuts';
import type { SupportedPlatform } from '../../lib/shortcuts/types';
import type { WorkMode } from '../Sidebar';

export interface UseAppShortcutsOptions {
  platform: SupportedPlatform;
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode) => void;
  setSidebarVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setRightDockVisible: React.Dispatch<React.SetStateAction<boolean>>;
  settingsOpen: boolean;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isCommandPaletteOpen: boolean;
  setIsCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isNotificationsOpen: boolean;
  setIsNotificationsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isUsageModalOpen: boolean;
  setIsUsageModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isWhatsNewOpen: boolean;
  setIsWhatsNewOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isArchivedChatsOpen: boolean;
  setIsArchivedChatsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isSshModalOpen: boolean;
  setIsSshModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  routinesOpen: boolean;
  setRoutinesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  operatorOpen: boolean;
  setOperatorOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useAppShortcuts({
  platform,
  workMode,
  setWorkMode,
  setSidebarVisible,
  setRightDockVisible,
  settingsOpen,
  setSettingsOpen,
  isCommandPaletteOpen,
  setIsCommandPaletteOpen,
  isNotificationsOpen,
  setIsNotificationsOpen,
  isUsageModalOpen,
  setIsUsageModalOpen,
  isWhatsNewOpen,
  setIsWhatsNewOpen,
  isArchivedChatsOpen,
  setIsArchivedChatsOpen,
  isSshModalOpen,
  setIsSshModalOpen,
  routinesOpen,
  setRoutinesOpen,
  operatorOpen,
  setOperatorOpen,
}: UseAppShortcutsOptions): void {
  useGlobalShortcuts({
    platform,
    handlers: {
      'toggle-sidebar': () => {
        setSidebarVisible((v) => !v);
      },
      'open-settings': () => {
        setSettingsOpen((v) => !v);
      },
      'command-palette': () => {
        setIsCommandPaletteOpen((v) => !v);
      },
      'quick-switcher': () => {
        setIsCommandPaletteOpen((v) => !v);
      },
      'back-esc': () => {
        if (isCommandPaletteOpen) {
          setIsCommandPaletteOpen(false);
        } else if (isNotificationsOpen) {
          setIsNotificationsOpen(false);
        } else if (isUsageModalOpen) {
          setIsUsageModalOpen(false);
        } else if (isWhatsNewOpen) {
          setIsWhatsNewOpen(false);
        } else if (isArchivedChatsOpen) {
          setIsArchivedChatsOpen(false);
        } else if (isSshModalOpen) {
          setIsSshModalOpen(false);
        } else if (routinesOpen) {
          setRoutinesOpen(false);
        } else if (settingsOpen) {
          setSettingsOpen(false);
        } else if (operatorOpen) {
          setOperatorOpen(false);
        } else {
          return false;
        }
        return true;
      },
      'mode-agent': () => {
        setWorkMode('agent');
        setSettingsOpen(false);
        setRoutinesOpen(false);
      },
      'mode-code': () => {
        setWorkMode('code');
        setSettingsOpen(false);
        setRoutinesOpen(false);
      },
      'mode-chat': () => {
        setWorkMode('chat');
        setSettingsOpen(false);
        setRoutinesOpen(false);
      },
      'toggle-dock': () => {
        setRightDockVisible((v) => !v);
      },
      'toggle-diffs': () => {
        setRightDockVisible(true);
        window.dispatchEvent(new CustomEvent('kite:open-diffs'));
      },
      'toggle-operator': () => {
        setOperatorOpen((prev) => !prev);
      },
      'dictation-toggle': () => {
        if (!operatorOpen) {
          setOperatorOpen(true);
        }
        window.dispatchEvent(new CustomEvent('kite:toggle-voice'));
      },
      'new-terminal': () => {
        if (workMode !== 'code') {
          setWorkMode('code');
          setSettingsOpen(false);
        }
        window.dispatchEvent(
          new CustomEvent('kite:shortcut-pane-action', { detail: { action: 'new-terminal' } })
        );
      },
      'split-vertical': () => {
        if (workMode !== 'code') {
          setWorkMode('code');
          setSettingsOpen(false);
        }
        window.dispatchEvent(
          new CustomEvent('kite:shortcut-pane-action', {
            detail: { action: 'split-pane', axis: 'vertical' },
          })
        );
      },
      'split-horizontal': () => {
        if (workMode !== 'code') {
          setWorkMode('code');
          setSettingsOpen(false);
        }
        window.dispatchEvent(
          new CustomEvent('kite:shortcut-pane-action', {
            detail: { action: 'split-pane', axis: 'horizontal' },
          })
        );
      },
      'close-pane': () => {
        window.dispatchEvent(
          new CustomEvent('kite:shortcut-pane-action', { detail: { action: 'close-pane' } })
        );
      },
      'save-file': () => {
        window.dispatchEvent(new CustomEvent('kite:save-file'));
      },
    },
  });
}
