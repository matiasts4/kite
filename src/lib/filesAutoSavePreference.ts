import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'kite-code.files-auto-save.v1';
const listeners = new Set<() => void>();
let cachedValue: boolean | null = null;
let isListeningStorage = false;

export function getFilesAutoSavePreference(): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return cachedValue ?? true;
    const item = storage.getItem(STORAGE_KEY);
    return item === 'true' || item !== 'false';
  } catch {
    return cachedValue ?? true;
  }
}

export function setFilesAutoSavePreference(value: boolean): void {
  cachedValue = value;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(value));
  } catch {}
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (!isListeningStorage && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('storage', handleStorage);
    isListeningStorage = true;
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && isListeningStorage) {
      globalThis.removeEventListener('storage', handleStorage);
      isListeningStorage = false;
    }
  };
}

function handleStorage(e: StorageEvent): void {
  if (e.key === STORAGE_KEY || e.key === null) {
    cachedValue = null;
    for (const listener of listeners) {
      listener();
    }
  }
}

export function useFilesAutoSavePreference(): [boolean, (val: boolean) => void] {
  const autoSave = useSyncExternalStore(subscribe, getFilesAutoSavePreference, () => true);
  return [autoSave, setFilesAutoSavePreference];
}
