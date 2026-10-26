import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OFFICIAL_PLUGINS } from './catalog';
import type { PluginAction, PluginConnection, PluginConnectionState } from './types';

export interface UsePluginConnectionsResult {
  connections: PluginConnection[];
  ready: boolean;
  error: string | null;
  pending: boolean;
  action: (idOrPayload: string | { id: string; action: PluginAction }, actionArg?: PluginAction) => Promise<void>;
  refresh: () => Promise<void>;
}

export function getDefaultConnections(): PluginConnection[] {
  return OFFICIAL_PLUGINS.map((plugin) => ({
    id: plugin.id,
    state: plugin.initialState,
    account: null,
    message: null,
  }));
}

export function areConnectionsEqual(
  a: readonly PluginConnection[],
  b: readonly PluginConnection[]
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const mapA = new Map<string, PluginConnection>();
  for (let i = 0; i < a.length; i++) {
    mapA.set(a[i].id, a[i]);
  }
  for (let i = 0; i < b.length; i++) {
    const itemB = b[i];
    const itemA = mapA.get(itemB.id);
    if (!itemA) return false;
    if (
      itemA.state !== itemB.state ||
      itemA.account !== itemB.account ||
      itemA.message !== itemB.message
    ) {
      return false;
    }
  }
  return true;
}

const FALLBACK_KEY = 'kite_plugin_connections_fallback';

export function getFallbackConnections(): PluginConnection[] {
  if (typeof window === 'undefined') return getDefaultConnections();
  try {
    const saved = localStorage.getItem(FALLBACK_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const map = new Map<string, PluginConnection>(parsed.map((c) => [c.id, c]));
        return OFFICIAL_PLUGINS.map((p) => {
          const existing = map.get(p.id);
          if (existing) {
            return {
              id: p.id,
              state: existing.state ?? p.initialState,
              account: existing.account ?? null,
              message: existing.message ?? null,
            };
          }
          return {
            id: p.id,
            state: p.initialState,
            account: null,
            message: null,
          };
        });
      }
    }
  } catch {
    // ignore
  }
  return getDefaultConnections();
}

export function saveFallbackConnections(connections: PluginConnection[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(connections));
  } catch {
    // ignore
  }
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    typeof (invoke as any)?.mock === 'object'
  );
}

export const usePluginConnections = (): UsePluginConnectionsResult => {
  const [connections, setConnections] = useState<PluginConnection[]>(() => {
    return isTauri() ? getDefaultConnections() : getFallbackConnections();
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const connectionsRef = useRef<PluginConnection[]>(connections);
  connectionsRef.current = connections;

  const fetchConnections = useCallback(async () => {
    if (!isTauri()) {
      const fallbackList = getFallbackConnections();
      setConnections((prev) => (areConnectionsEqual(prev, fallbackList) ? prev : fallbackList));
      setReady(true);
      return;
    }

    try {
      const raw = await invoke<any>('plugin_connections');
      const list: PluginConnection[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.connections)
          ? raw.connections
          : [];
      setConnections((prev) => (areConnectionsEqual(prev, list) ? prev : list));
      setError(null);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('__TAURI_INTERNALS__') || errMsg.includes('not running in Tauri')) {
        const fallbackList = getFallbackConnections();
        setConnections((prev) => (areConnectionsEqual(prev, fallbackList) ? prev : fallbackList));
      } else {
        setError(errMsg);
      }
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    const poll = async () => {
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function') {
        if (!document.hasFocus()) {
          return;
        }
      }
      if (isMounted) {
        await fetchConnections();
      }
    };

    poll();

    const intervalId = setInterval(() => {
      poll();
    }, 2000);

    const handleFocus = () => {
      poll();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus);
    }

    return () => {
      isMounted = false;
      clearInterval(intervalId);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
      }
    };
  }, [fetchConnections]);

  const action = useCallback(
    async (idOrPayload: string | { id: string; action: PluginAction }, actionArg?: PluginAction) => {
      const id = typeof idOrPayload === 'string' ? idOrPayload : idOrPayload.id;
      const act = typeof idOrPayload === 'string' ? (actionArg as PluginAction) : idOrPayload.action;

      if (!id || !act) {
        throw new Error('Plugin connection action requires both id and action parameters');
      }

      setPending(true);
      setError(null);

      const previousConnections = connectionsRef.current;
      const optimistic = previousConnections.map((conn) => {
        if (conn.id !== id) return conn;
        let nextState: PluginConnectionState = conn.state;
        if (act === 'connect') nextState = 'connecting';
        else if (act === 'cancel') nextState = 'disconnected';
        else if (act === 'disconnect') nextState = 'disconnected';
        return { ...conn, state: nextState, message: null };
      });
      setConnections(optimistic);

      const handleFallback = () => {
        const currentFallback = getFallbackConnections();
        const updated = currentFallback.map((c) => {
          if (c.id !== id) return c;
          if (act === 'connect') {
            return {
              ...c,
              state: 'connected' as PluginConnectionState,
              account: 'demo@kite.dev',
              message: null,
            };
          }
          if (act === 'cancel' || act === 'disconnect') {
            return {
              ...c,
              state: 'disconnected' as PluginConnectionState,
              account: null,
              message: null,
            };
          }
          return c;
        });
        saveFallbackConnections(updated);
        setConnections((prev) => (areConnectionsEqual(prev, updated) ? prev : updated));
      };

      try {
        if (isTauri()) {
          try {
            const response = await invoke<any>('plugin_connection_action', {
              request: {
                schemaVersion: 1,
                id,
                action: act,
              },
            });

            if (Array.isArray(response)) {
              setConnections((prev) => (areConnectionsEqual(prev, response) ? prev : response));
            } else if (response && typeof response === 'object' && response.id) {
              setConnections((prev) => {
                const updated = prev.map((c) =>
                  c.id === response.id ? (response as PluginConnection) : c
                );
                return areConnectionsEqual(prev, updated) ? prev : updated;
              });
            } else {
              await fetchConnections();
            }
          } catch (invokeErr: any) {
            const errMsg = invokeErr?.message || String(invokeErr);
            if (errMsg.includes('__TAURI_INTERNALS__')) {
              handleFallback();
            } else {
              throw invokeErr;
            }
          }
        } else {
          handleFallback();
        }
      } catch (err: any) {
        setConnections(previousConnections);
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setPending(false);
      }
    },
    [fetchConnections]
  );

  return {
    connections,
    ready,
    error,
    pending,
    action,
    refresh: fetchConnections,
  };
};
