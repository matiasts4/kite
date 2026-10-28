import { useEffect, useState, useRef } from 'react';
import {
  getShortcuts,
  getPlatform,
  matchesEvent,
  SHORTCUTS_CHANGED_EVENT,
} from './shortcutsRegistry';
import { ShortcutItem, SupportedPlatform } from './types';

export const SHORTCUT_TRIGGERED_EVENT = 'kite:shortcut-triggered';

export type ShortcutActionHandler = () => void | Promise<void>;

export interface UseGlobalShortcutsOptions {
  handlers?: Partial<Record<string, ShortcutActionHandler>>;
  disabled?: boolean;
  platform?: SupportedPlatform;
}

/**
 * Checks whether the active element is an input, textarea or code editor where
 * typical typing / text-editing actions must not be hijacked.
 */
function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useGlobalShortcuts(options: UseGlobalShortcutsOptions = {}) {
  const { handlers = {}, disabled = false, platform: customPlatform } = options;
  const platform = customPlatform || getPlatform();
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>(() => getShortcuts(platform));

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Listen for shortcuts configuration changes (e.g. from Settings or modal)
  useEffect(() => {
    const handleUpdate = () => {
      setShortcuts(getShortcuts(platform));
    };
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, handleUpdate);
    return () => window.removeEventListener(SHORTCUTS_CHANGED_EVENT, handleUpdate);
  }, [platform]);

  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      const targetIsInput = isInputElement(e.target);

      for (const item of shortcuts) {
        const keys = item.customKeys || item.defaultKeys;
        if (!keys || keys.length === 0) continue;

        if (matchesEvent(keys, e, platform)) {
          // If focus is in an input, don't hijack simple keys unless it's Esc or a major global shortcut
          if (targetIsInput) {
            const isEscape = item.id === 'back-esc';
            const isCommandOrNav = [
              'command-palette',
              'quick-switcher',
              'open-settings',
              'toggle-sidebar',
              'toggle-dock',
              'toggle-operator',
              'mode-agent',
              'mode-code',
              'mode-chat',
            ].includes(item.id);

            if (!isEscape && !isCommandOrNav) {
              continue;
            }
          }

          e.preventDefault();
          e.stopPropagation();

          // Dispatch universal event
          window.dispatchEvent(
            new CustomEvent(SHORTCUT_TRIGGERED_EVENT, { detail: { id: item.id } })
          );

          // Invoke specific registered handler
          const fn = handlersRef.current[item.id];
          if (fn) {
            try {
              void fn();
            } catch (err) {
              console.error(`Error executing shortcut handler for "${item.id}":`, err);
            }
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [shortcuts, disabled, platform]);

  return { shortcuts };
}
