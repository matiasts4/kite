import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import packageInfo from '../../package.json';

export interface UpdateError {
  code: string;
  message: string;
  detail: string;
}

export type UpdaterState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'uptodate' }
  | { status: 'available'; version: string; notes?: string | null }
  | { status: 'downloading'; percent: number | null }
  | { status: 'ready'; version?: string | null }
  | { status: 'error'; error: UpdateError };

export interface UpdateInfo {
  available: boolean;
  current_version?: string;
  version?: string | null;
  notes?: string | null;
  date?: string | null;
}

export const CURRENT_APP_VERSION = packageInfo.version || '0.1.4';

const asError = (e: unknown): UpdateError => {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as UpdateError;
  const detail = String(e);
  return { code: 'unknown', message: 'Error desconocido al actualizar.', detail };
};

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ============================================================================
// Singleton Reactive Store across components (Sidebar, UpdateDetailCard, Settings)
// ============================================================================

let globalState: UpdaterState = { status: 'idle' };
let globalCurrentVersion: string = CURRENT_APP_VERSION;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function setGlobalState(nextState: UpdaterState | ((prev: UpdaterState) => UpdaterState)) {
  globalState = typeof nextState === 'function' ? nextState(globalState) : nextState;
  notify();
}

function setGlobalVersion(v: string) {
  if (v && v !== globalCurrentVersion) {
    globalCurrentVersion = v;
    notify();
  }
}

let isInitialized = false;
let lastCheckTimestamp = 0;

/**
 * Checks for updates in the background without clearing the UI with a full loading spinner.
 * Throttled to at most once every 20 seconds. Automatically called on window focus,
 * visibility change, and component mount so newer consecutive releases immediately supersede
 * older pending versions.
 */
export async function checkSilently(): Promise<UpdateInfo | undefined> {
  if (!inTauri()) return;
  const now = Date.now();
  if (now - lastCheckTimestamp < 20_000) return;
  if (globalState.status === 'downloading') return;
  lastCheckTimestamp = now;

  try {
    const info = await invoke<UpdateInfo>('updater_check');
    if (info.current_version) setGlobalVersion(info.current_version);
    if (info.available && info.version) {
      setGlobalState({
        status: 'available',
        version: info.version,
        notes: info.notes,
      });
    } else if (!info.available && (globalState.status === 'available' || globalState.status === 'ready')) {
      setGlobalState({ status: 'uptodate' });
    }
    return info;
  } catch {
    // Silent background check fails quietly without disrupting the user
  }
}

function initTauriListeners() {
  if (isInitialized || !inTauri()) return;
  isInitialized = true;

  // Immediately query active runtime binary version
  invoke<string>('get_app_version')
    .then((ver) => {
      if (ver) setGlobalVersion(ver);
    })
    .catch(() => {});

  listen<UpdateInfo>('updater://available', (e) => {
    if (e.payload.current_version) setGlobalVersion(e.payload.current_version);
    setGlobalState({
      status: 'available',
      version: e.payload.version ?? '',
      notes: e.payload.notes,
    });
  });

  listen<UpdateInfo>('updater://uptodate', (e) => {
    if (e.payload.current_version) setGlobalVersion(e.payload.current_version);
    setGlobalState({ status: 'uptodate' });
  });

  listen<{ downloaded: number; total?: number | null }>('updater://progress', (e) => {
    const { downloaded, total } = e.payload;
    setGlobalState({
      status: 'downloading',
      percent: total ? Math.round((downloaded / total) * 100) : null,
    });
  });

  listen('updater://ready', () => {
    setGlobalState((prev) => ({
      status: 'ready',
      version: prev.status === 'available' || prev.status === 'ready' ? prev.version : null,
    }));
  });

  if (typeof window !== 'undefined') {
    let focusTimer: any = null;
    const scheduleFocusCheck = () => {
      if (focusTimer) clearTimeout(focusTimer);
      // Defer focus check by 2.5s so window activation, rendering and memory unpaging complete smoothly
      focusTimer = setTimeout(() => {
        checkSilently();
      }, 2500);
    };

    window.addEventListener('focus', scheduleFocusCheck);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleFocusCheck();
      }
    });
  }
}

/** Drives the Rust updater commands (src-tauri/src/updater.rs) with a synchronized global store. */
export function useAppUpdater() {
  const [state, setState] = useState<UpdaterState>(globalState);
  const [currentVersion, setCurrentVersion] = useState<string>(globalCurrentVersion);

  useEffect(() => {
    initTauriListeners();
    // Defer initial check by 3.5s so startup renders cleanly without feed requests
    const timer = setTimeout(() => {
      checkSilently();
    }, 3500);
    const update = () => {
      setState(globalState);
      setCurrentVersion(globalCurrentVersion);
    };
    listeners.add(update);
    update();
    return () => {
      clearTimeout(timer);
      listeners.delete(update);
    };
  }, []);

  const check = useCallback(async (): Promise<UpdateInfo | undefined> => {
    if (!inTauri()) return;
    setGlobalState({ status: 'checking' });
    try {
      const info = await invoke<UpdateInfo>('updater_check');
      if (info.current_version) setGlobalVersion(info.current_version);
      if (info.available) {
        setGlobalState({
          status: 'available',
          version: info.version ?? '',
          notes: info.notes,
        });
      } else {
        setGlobalState({ status: 'uptodate' });
      }
      return info;
    } catch (e) {
      const err = asError(e);
      setGlobalState({ status: 'error', error: err });
      throw err;
    }
  }, []);

  const install = useCallback(async () => {
    setGlobalState({ status: 'downloading', percent: null });
    try {
      await invoke('updater_install');
    } catch (e) {
      setGlobalState({ status: 'error', error: asError(e) });
    }
  }, []);

  const restart = useCallback(() => invoke('updater_restart'), []);

  /** One-click update: downloads, installs, and reloads the app. */
  const updateAndRestart = useCallback(async () => {
    setGlobalState({ status: 'downloading', percent: null });
    try {
      await invoke('updater_update_and_restart');
    } catch (e) {
      setGlobalState({ status: 'error', error: asError(e) });
    }
  }, []);

  const clearError = useCallback(() => setGlobalState({ status: 'idle' }), []);

  return {
    state,
    currentVersion,
    isAvailable: state.status === 'available',
    isDownloading: state.status === 'downloading',
    isReady: state.status === 'ready',
    check,
    install,
    restart,
    updateAndRestart,
    clearError,
  };
}
