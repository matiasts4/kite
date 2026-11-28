import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauriEnvironment } from '../../../lib/ipc/core';
import {
  DEFAULT_PLUGIN_RUNTIME_SETTINGS,
  fetchSidecarLogs,
  getPluginRuntimeSettings,
  installPluginFromArchive,
  installPluginFromFolder,
  installPluginFromGit,
  listInstalledPlugins,
  refreshInstalledPlugins,
  runSidecarAction,
  savePluginRuntimeSettings,
  setInstalledPluginEnabled,
  uninstallInstalledPlugin,
  type PluginRecordDto,
  type PluginRuntimeSettings,
  type SidecarStatusSnapshot,
} from '../../../lib/ipc/pluginRuntime';

export const INSTALLED_PLUGINS_POLL_MS = 3000;
export const PLUGINS_UPDATED_EVENT = 'kite:plugins-updated';

export interface UseInstalledPluginsOptions {
  workspaceId?: string | null;
  workspacePath?: string | null;
}

export interface UseInstalledPluginsResult {
  plugins: PluginRecordDto[];
  settings: PluginRuntimeSettings;
  loading: boolean;
  error: string | null;
  refresh: (force?: boolean) => Promise<void>;
  toggleEnabled: (dirId: string, enabled: boolean) => Promise<PluginRecordDto[]>;
  installFolder: (path: string) => Promise<PluginRecordDto>;
  installGit: (
    repoUrl: string,
    opts?: { gitRef?: string; subdir?: string }
  ) => Promise<PluginRecordDto>;
  installArchive: (path: string) => Promise<PluginRecordDto>;
  uninstall: (dirId: string) => Promise<void>;
  updateSettings: (nextSettings: PluginRuntimeSettings) => Promise<PluginRuntimeSettings>;
  runSidecar: (
    namespacedId: string,
    action: 'start' | 'stop' | 'restart' | 'open',
    viewPath?: string
  ) => Promise<SidecarStatusSnapshot>;
  getLogs: (namespacedId: string, tailLines?: number) => Promise<string[]>;
}

function formatRuntimeError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Error inesperado al comunicarse con el runtime de extensiones.';
}

function notifyPluginsUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PLUGINS_UPDATED_EVENT));
  }
}

export function useInstalledPlugins(
  options?: UseInstalledPluginsOptions
): UseInstalledPluginsResult {
  const workspaceId = options?.workspaceId ?? undefined;
  const workspacePath = options?.workspacePath ?? undefined;

  const [plugins, setPlugins] = useState<PluginRecordDto[]>([]);
  const [settings, setSettings] = useState<PluginRuntimeSettings>(
    DEFAULT_PLUGIN_RUNTIME_SETTINGS
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef<boolean>(true);
  const inFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scope = useMemo(
    () => ({
      workspaceId,
      workspacePath,
    }),
    [workspaceId, workspacePath]
  );

  const loadSnapshot = useCallback(
    async (forceRefresh = false): Promise<void> => {
      if (inFlightRef.current && !forceRefresh) {
        return inFlightRef.current;
      }

      const task = (async () => {
        try {
          const [nextPlugins, nextSettings] = await Promise.all([
            forceRefresh
              ? refreshInstalledPlugins(scope)
              : listInstalledPlugins(scope),
            getPluginRuntimeSettings(),
          ]);

          if (!mountedRef.current) return;
          setPlugins(Array.isArray(nextPlugins) ? nextPlugins : []);
          if (nextSettings) {
            setSettings(nextSettings);
          }
          setError(null);
        } catch (err) {
          if (!mountedRef.current) return;
          setError(formatRuntimeError(err));
        } finally {
          if (mountedRef.current) {
            setLoading(false);
          }
        }
      })().finally(() => {
        if (inFlightRef.current === task) {
          inFlightRef.current = null;
        }
      });

      inFlightRef.current = task;
      return task;
    },
    [scope]
  );

  useEffect(() => {
    setLoading(true);
    void loadSnapshot(false);
  }, [loadSnapshot]);

  useEffect(() => {
    if (!isTauriEnvironment()) return undefined;

    const timer = window.setInterval(() => {
      if (typeof document === 'undefined' || document.hasFocus()) {
        void loadSnapshot(false);
      }
    }, INSTALLED_PLUGINS_POLL_MS);

    const handleFocus = () => {
      void loadSnapshot(false);
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [loadSnapshot]);

  const refresh = useCallback(
    async (force = true): Promise<void> => {
      await loadSnapshot(force);
    },
    [loadSnapshot]
  );

  const toggleEnabled = useCallback(
    async (dirId: string, enabled: boolean): Promise<PluginRecordDto[]> => {
      try {
        const updated = await setInstalledPluginEnabled(dirId, enabled, workspaceId);
        if (mountedRef.current) {
          setPlugins(Array.isArray(updated) ? updated : []);
          setError(null);
        }
        notifyPluginsUpdated();
        return updated;
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    [workspaceId]
  );

  const installFolder = useCallback(
    async (path: string): Promise<PluginRecordDto> => {
      try {
        const installed = await installPluginFromFolder(path, workspaceId);
        await loadSnapshot(false);
        notifyPluginsUpdated();
        return installed;
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    [workspaceId, loadSnapshot]
  );

  const installGit = useCallback(
    async (
      repoUrl: string,
      opts?: { gitRef?: string; subdir?: string }
    ): Promise<PluginRecordDto> => {
      try {
        const installed = await installPluginFromGit(repoUrl, {
          ...opts,
          workspaceId,
        });
        await loadSnapshot(false);
        notifyPluginsUpdated();
        return installed;
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    [workspaceId, loadSnapshot]
  );

  const installArchive = useCallback(
    async (path: string): Promise<PluginRecordDto> => {
      try {
        const installed = await installPluginFromArchive(path, workspaceId);
        await loadSnapshot(false);
        notifyPluginsUpdated();
        return installed;
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    [workspaceId, loadSnapshot]
  );

  const uninstall = useCallback(
    async (dirId: string): Promise<void> => {
      try {
        await uninstallInstalledPlugin(dirId, workspaceId);
        if (mountedRef.current) {
          setPlugins((prev) => prev.filter((item) => item.dirId !== dirId));
          setError(null);
        }
        await loadSnapshot(false);
        notifyPluginsUpdated();
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    [workspaceId, loadSnapshot]
  );

  const updateSettings = useCallback(
    async (nextSettings: PluginRuntimeSettings): Promise<PluginRuntimeSettings> => {
      try {
        const saved = await savePluginRuntimeSettings(nextSettings, workspaceId);
        if (mountedRef.current) {
          setSettings(saved);
          setError(null);
        }
        await loadSnapshot(true);
        notifyPluginsUpdated();
        return saved;
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    [workspaceId, loadSnapshot]
  );

  const runSidecar = useCallback(
    async (
      namespacedId: string,
      action: 'start' | 'stop' | 'restart' | 'open',
      viewPath?: string
    ): Promise<SidecarStatusSnapshot> => {
      try {
        const snapshot = await runSidecarAction(namespacedId, action, {
          viewPath,
          workspaceId,
        });
        if (mountedRef.current) {
          setPlugins((prev) =>
            prev.map((plugin) => ({
              ...plugin,
              sidecars: plugin.sidecars.map((sidecar) =>
                sidecar.namespacedId === snapshot.namespacedId ? snapshot : sidecar
              ),
            }))
          );
          setError(null);
        }
        notifyPluginsUpdated();
        return snapshot;
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    [workspaceId]
  );

  const getLogs = useCallback(
    async (namespacedId: string, tailLines = 200): Promise<string[]> => {
      try {
        const lines = await fetchSidecarLogs(namespacedId, tailLines);
        if (mountedRef.current) setError(null);
        return lines;
      } catch (err) {
        const msg = formatRuntimeError(err);
        if (mountedRef.current) setError(msg);
        throw err;
      }
    },
    []
  );

  return {
    plugins,
    settings,
    loading,
    error,
    refresh,
    toggleEnabled,
    installFolder,
    installGit,
    installArchive,
    uninstall,
    updateSettings,
    runSidecar,
    getLogs,
  };
}
