import { useEffect, useState } from 'react';

export type PrimaryAction = 'send' | 'interrupt' | 'queue' | 'steer' | 'resume';
export type FollowUpMode = 'queue' | 'steer';

export const FOLLOW_UP_MODE_KEY = 'kite_default_follow_up';
export const FOLLOW_UP_MODE_EVENT = 'kite:default-follow-up';

export function isFollowUpMode(value: string | null | undefined): value is FollowUpMode {
  return value === 'queue' || value === 'steer';
}

export function readDefaultFollowUp(): FollowUpMode {
  try {
    const raw = localStorage.getItem(FOLLOW_UP_MODE_KEY);
    return isFollowUpMode(raw) ? raw : 'queue';
  } catch {
    return 'queue';
  }
}

export function writeDefaultFollowUp(mode: FollowUpMode): void {
  try {
    localStorage.setItem(FOLLOW_UP_MODE_KEY, mode);
  } catch {
    // Session listener still applies the preference when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(FOLLOW_UP_MODE_EVENT, { detail: mode }));
}

export function useDefaultFollowUp(): FollowUpMode {
  const [mode, setMode] = useState<FollowUpMode>(() => readDefaultFollowUp());

  useEffect(() => {
    setMode(readDefaultFollowUp());
    const onFollowUpChange = (event: Event) => {
      const next = (event as CustomEvent<FollowUpMode>).detail;
      setMode(isFollowUpMode(next) ? next : readDefaultFollowUp());
    };
    const onStorage = () => {
      setMode(readDefaultFollowUp());
    };
    window.addEventListener(FOLLOW_UP_MODE_EVENT, onFollowUpChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FOLLOW_UP_MODE_EVENT, onFollowUpChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return mode;
}

export function resolvePrimaryAction(input: {
  running: boolean;
  draftEmpty: boolean;
  paused: boolean;
  steerSupported: boolean;
  defaultFollowUp: 'queue' | 'steer';
  flip: boolean;
}): PrimaryAction {
  if (input.running && input.draftEmpty) return 'interrupt';
  if (input.running && !input.draftEmpty) {
    const preferred = input.steerSupported ? input.defaultFollowUp : 'queue';
    const opposite = preferred === 'queue' ? 'steer' : 'queue';
    const flipped = input.flip ? opposite : preferred;
    return flipped === 'steer' && input.steerSupported ? 'steer' : 'queue';
  }
  if (!input.running && input.paused && input.draftEmpty) return 'resume';
  return 'send';
}

export function queueVisibleRows<T>(rows: T[], expanded: boolean, limit = 3): { visible: T[]; hidden: number } {
  if (expanded || rows.length <= limit) return { visible: rows, hidden: 0 };
  return { visible: rows.slice(0, limit), hidden: rows.length - limit };
}
