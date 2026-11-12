import { useEffect } from 'react';
import type React from 'react';
import { OPEN_SETTINGS_EVENT } from '../../lib/settingsNav';
import { OPEN_RIGHT_DOCK_BROWSER_EVENT } from '../../lib/terminalLinkNav';
import {
  OPEN_RIGHT_DOCK_SUBAGENT_EVENT,
  type OpenRightDockSubagentDetail,
} from '../../lib/subagentNav';
import { sendUiAck, type UiBusRequestPayload } from '../../lib/operator/executor/ui-bus';
import { registerToastNavigator } from '../../lib/toast';
import type { WorkMode } from '../Sidebar';
import type { AgentProfile } from '../../types';

export interface UseAppGlobalEventsOptions {
  setWorkMode: (mode: WorkMode) => void;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRoutinesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedAgentId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedThreadId: React.Dispatch<React.SetStateAction<string | null>>;
  setRightDockVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCommandPaletteOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  onAddWorkspace?: () => Promise<void> | void;
  loadBootstrap: () => Promise<void>;
  loadThreads: () => Promise<void>;
  setAgents: React.Dispatch<React.SetStateAction<AgentProfile[]>>;
  selectedAgentId: string | null;
}

export function useAppGlobalEvents({
  setWorkMode,
  setSettingsOpen,
  setRoutinesOpen,
  setSelectedWorkspaceId,
  setSelectedAgentId,
  setSelectedThreadId,
  setRightDockVisible,
  setIsCommandPaletteOpen,
  onAddWorkspace,
  loadBootstrap,
  loadThreads,
  setAgents,
  selectedAgentId,
}: UseAppGlobalEventsOptions): void {
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  }, [setSettingsOpen]);

  useEffect(() => {
    return registerToastNavigator({
      onNavigateAgent: (id) => {
        setSelectedAgentId(id);
        setWorkMode('agent');
      },
      onNavigateThread: (threadId, agentId) => {
        if (agentId) {
          setSelectedAgentId(agentId);
          setWorkMode('agent');
        } else {
          setWorkMode('code');
        }
        setSelectedThreadId(threadId);
      },
      onNavigateMode: (m) => {
        setWorkMode(m);
      },
    });
  }, [setSelectedAgentId, setSelectedThreadId, setWorkMode]);

  useEffect(() => {
    const handleNavigate = (e: Event) => {
      const custom = e as CustomEvent<WorkMode | { mode?: string }>;
      const raw =
        typeof custom.detail === 'string' ? custom.detail : custom.detail?.mode;
      // Operator view modes use surface names (agents/threads); the app uses its own.
      const modeAlias: Record<string, WorkMode> = {
        agents: 'agent',
        agent: 'agent',
        threads: 'chat',
        chat: 'chat',
        code: 'code',
      };
      const nextMode = raw ? modeAlias[raw] : undefined;
      if (nextMode) {
        setWorkMode(nextMode);
        setSettingsOpen(false);
      }
    };

    const handleSelectWorkspace = (e: Event) => {
      const custom = e as CustomEvent<string | { workspaceId?: string }>;
      const workspaceId =
        typeof custom.detail === 'string' ? custom.detail : custom.detail?.workspaceId;
      if (workspaceId) {
        setSelectedWorkspaceId(workspaceId);
      }
    };

    const handleSelectThread = (e: Event) => {
      const custom = e as CustomEvent<string | { threadId?: string; mode?: WorkMode }>;
      const threadId =
        typeof custom.detail === 'string' ? custom.detail : custom.detail?.threadId;
      if (threadId) {
        setSelectedThreadId(threadId);
        const targetMode =
          typeof custom.detail === 'object' && custom.detail?.mode ? custom.detail.mode : 'chat';
        setWorkMode(targetMode);
        setSettingsOpen(false);
        setRoutinesOpen(false);
      }
    };

    const handleOpenFilePreview = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpenBrowserInDock = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null; url?: string }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpenSubagentInDock = (e: Event) => {
      const custom = e as CustomEvent<OpenRightDockSubagentDetail>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpenDiffsInDock = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleDockShortcutKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        setRightDockVisible(true);
      }
    };

    const handleSpawnAgentTerminal = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setWorkMode('code');
      setSettingsOpen(false);
      setRoutinesOpen(false);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };

    const handleOpRequest = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (!custom.detail) return;
      if (custom.detail.kind === 'navigate') {
        const targetMode = custom.detail.payload?.mode as WorkMode;
        if (targetMode && ['agent', 'code', 'chat'].includes(targetMode)) {
          setWorkMode(targetMode);
          setSettingsOpen(false);
          sendUiAck({
            reqId: custom.detail.reqId,
            ok: true,
            data: { mode: targetMode },
          });
        } else {
          sendUiAck({
            reqId: custom.detail.reqId,
            ok: false,
            reason: `Invalid mode: ${targetMode}`,
          });
        }
      }
    };

    const handleAddWorkspaceEvent = () => {
      if (onAddWorkspace) {
        void onAddWorkspace();
      }
    };

    const handleOpenCommandPalette = () => {
      if (setIsCommandPaletteOpen) {
        setIsCommandPaletteOpen(true);
      }
    };

    window.addEventListener('kite:navigate-mode', handleNavigate);
    window.addEventListener('kite:select-workspace', handleSelectWorkspace);
    window.addEventListener('kite:select-thread', handleSelectThread);
    window.addEventListener('kite:open-right-dock-file', handleOpenFilePreview);
    window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowserInDock);
    window.addEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagentInDock);
    window.addEventListener('kite:open-right-dock-diffs', handleOpenDiffsInDock);
    window.addEventListener('kite:open-diffs', handleOpenDiffsInDock);
    window.addEventListener('keydown', handleDockShortcutKeyDown);
    window.addEventListener('kite:spawn-agent-terminal', handleSpawnAgentTerminal);
    window.addEventListener('kite:op-request', handleOpRequest);
    window.addEventListener('kite:add-workspace', handleAddWorkspaceEvent);
    window.addEventListener('kite:open-command-palette', handleOpenCommandPalette);

    return () => {
      window.removeEventListener('kite:navigate-mode', handleNavigate);
      window.removeEventListener('kite:select-workspace', handleSelectWorkspace);
      window.removeEventListener('kite:select-thread', handleSelectThread);
      window.removeEventListener('kite:open-right-dock-file', handleOpenFilePreview);
      window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowserInDock);
      window.removeEventListener(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, handleOpenSubagentInDock);
      window.removeEventListener('kite:open-right-dock-diffs', handleOpenDiffsInDock);
      window.removeEventListener('kite:open-diffs', handleOpenDiffsInDock);
      window.removeEventListener('keydown', handleDockShortcutKeyDown);
      window.removeEventListener('kite:spawn-agent-terminal', handleSpawnAgentTerminal);
      window.removeEventListener('kite:op-request', handleOpRequest);
      window.removeEventListener('kite:add-workspace', handleAddWorkspaceEvent);
      window.removeEventListener('kite:open-command-palette', handleOpenCommandPalette);
    };
  }, [
    setWorkMode,
    setSettingsOpen,
    setSelectedWorkspaceId,
    setSelectedThreadId,
    setRoutinesOpen,
    setRightDockVisible,
    onAddWorkspace,
    setIsCommandPaletteOpen,
  ]);

  useEffect(() => {
    const host = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    if (!host.__TAURI_INTERNALS__ && !host.__TAURI__) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const timers = new Set<number>();
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ sessionId?: string; engine?: string; alias?: string | null }>(
          'dispatch-open-pane',
          (event) => {
            const sessionId = event.payload?.sessionId;
            if (!sessionId) return;
            setWorkMode('code');
            setSettingsOpen(false);
            setRoutinesOpen(false);
            const timer = window.setTimeout(() => {
              timers.delete(timer);
              const alias = event.payload?.alias || undefined;
              window.dispatchEvent(
                new CustomEvent('kite:spawn-agent-terminal', {
                  detail: {
                    sessionId,
                    engine: event.payload?.engine || undefined,
                    title: alias,
                    agentName: alias,
                    attachOnly: true,
                  },
                })
              );
            }, 200);
            timers.add(timer);
          }
        )
      )
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [setWorkMode, setSettingsOpen, setRoutinesOpen]);

  useEffect(() => {
    const handleAgentsChanged = () => {
      void loadBootstrap();
    };
    const handleAgentDeleted = (e: Event) => {
      const custom = e as CustomEvent<{ agentId: string }>;
      const deletedId = custom.detail?.agentId;
      if (deletedId) {
        setAgents((prev) => {
          const remaining = prev.filter((a) => a.id !== deletedId);
          if (selectedAgentId === deletedId) {
            setSelectedAgentId(remaining[0]?.id ?? null);
          }
          return remaining;
        });
      } else {
        void loadBootstrap();
      }
    };
    window.addEventListener('kite:agents-changed', handleAgentsChanged);
    window.addEventListener('kite:agent-deleted', handleAgentDeleted);
    return () => {
      window.removeEventListener('kite:agents-changed', handleAgentsChanged);
      window.removeEventListener('kite:agent-deleted', handleAgentDeleted);
    };
  }, [loadBootstrap, selectedAgentId, setAgents, setSelectedAgentId]);

  useEffect(() => {
    const handleThreadsChanged = () => {
      void loadThreads();
    };
    window.addEventListener('kite:threads-changed', handleThreadsChanged);
    return () => window.removeEventListener('kite:threads-changed', handleThreadsChanged);
  }, [loadThreads]);
}
