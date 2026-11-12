import { useCallback } from 'react';
import type React from 'react';
import {
  addWorkspace,
  copyWorkspacePath,
  setWorkspacePinned,
  renameWorkspace,
  removeWorkspace,
  moveWorkspace,
  setAgentPinned,
  moveAgent,
  deleteAgentProfile,
  renameChatThread,
  setChatThreadPinned,
  archiveChatThread,
  restoreArchivedChat,
  deleteChatThread,
} from '../../lib/ipc';
import type { Workspace, AgentProfile } from '../../types';
import type { WorkMode } from '../Sidebar';

export interface UseAppSidebarHandlersOptions {
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>;
  agents: AgentProfile[];
  setAgents: React.Dispatch<React.SetStateAction<AgentProfile[]>>;
  loadBootstrap: () => Promise<void>;
  loadThreads: () => Promise<void>;
  selectedWorkspaceId: string | null;
  setSelectedWorkspaceId: (id: string | null) => void;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  selectedThreadId: string | null;
  setSelectedThreadId: (id: string | null) => void;
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode) => void;
  setSettingsOpen: (open: boolean) => void;
  setNewSessionRequest: React.Dispatch<React.SetStateAction<number>>;
}

export function useAppSidebarHandlers({
  setWorkspaces,
  agents,
  setAgents,
  loadBootstrap,
  loadThreads,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  selectedAgentId,
  setSelectedAgentId,
  selectedThreadId,
  setSelectedThreadId,
  workMode,
  setWorkMode,
  setSettingsOpen,
  setNewSessionRequest,
}: UseAppSidebarHandlersOptions) {
  const handleAddWorkspace = useCallback(async () => {
    try {
      const created = await addWorkspace();
      if (created) {
        await loadBootstrap();
        setSelectedWorkspaceId(created.id);
        if (workMode !== 'chat') {
          setWorkMode('code');
        }
        setSettingsOpen(false);
        setNewSessionRequest((n) => n + 1);
      }
    } catch (e) {
      console.error(e);
    }
  }, [loadBootstrap, setSelectedWorkspaceId, workMode, setWorkMode, setSettingsOpen, setNewSessionRequest]);

  const handleCopyPath = useCallback(async (id: string) => {
    try {
      const path = await copyWorkspacePath(id);
      if (path) {
        await navigator.clipboard.writeText(path);
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  const handleTogglePinWorkspace = useCallback(async (id: string, pinned: boolean) => {
    try {
      await setWorkspacePinned(id, pinned);
      await loadBootstrap();
    } catch (e) {
      console.error(e);
    }
  }, [loadBootstrap]);

  const handleTogglePinAgent = useCallback(async (id: string, pinned: boolean) => {
    try {
      const updated = await setAgentPinned(id, pinned);
      setAgents(updated);
    } catch (e) {
      console.error(e);
    }
  }, [setAgents]);

  const handleMoveAgent = useCallback(async (id: string, toIndex: number) => {
    try {
      const updated = await moveAgent(id, toIndex);
      setAgents(updated);
    } catch (e) {
      console.error(e);
    }
  }, [setAgents]);

  const handleDeleteAgent = useCallback(async (id: string) => {
    try {
      await deleteAgentProfile(id);
      const remaining = agents.filter((a) => a.id !== id);
      setAgents(remaining);
      if (selectedAgentId === id) {
        setSelectedAgentId(remaining[0]?.id ?? null);
      }
    } catch (e) {
      console.error(e);
    }
  }, [agents, selectedAgentId, setAgents, setSelectedAgentId]);

  const handleRenameWorkspace = useCallback(async (id: string, newName: string) => {
    try {
      const updated = await renameWorkspace(id, newName);
      setWorkspaces(updated);
    } catch (e) {
      console.error(e);
    }
  }, [setWorkspaces]);

  const handleRemoveWorkspaceFromList = useCallback(async (id: string) => {
    try {
      const updated = await removeWorkspace(id);
      setWorkspaces(updated);
      if (selectedWorkspaceId === id) {
        setSelectedWorkspaceId(updated[0]?.id ?? null);
      }
    } catch (e) {
      console.error(e);
    }
  }, [selectedWorkspaceId, setSelectedWorkspaceId, setWorkspaces]);

  const handleMoveWorkspace = useCallback(async (id: string, toIndex: number) => {
    try {
      const updated = await moveWorkspace(id, toIndex);
      setWorkspaces(updated);
    } catch (e) {
      console.error(e);
    }
  }, [setWorkspaces]);

  const handleTogglePinThread = useCallback(async (id: string, pinned: boolean) => {
    try {
      await setChatThreadPinned(id, pinned);
      await loadThreads();
    } catch (e) {
      console.error(e);
    }
  }, [loadThreads]);

  const handleRenameThread = useCallback(async (id: string, newTitle: string) => {
    try {
      await renameChatThread(id, newTitle);
      await loadThreads();
    } catch (e) {
      console.error(e);
    }
  }, [loadThreads]);

  const handleArchiveThread = useCallback(async (id: string) => {
    try {
      await archiveChatThread(id);
      await loadThreads();
      if (selectedThreadId === id) {
        setSelectedThreadId(null);
      }
    } catch (e) {
      console.error(e);
    }
  }, [loadThreads, selectedThreadId, setSelectedThreadId]);

  const handleRestoreThread = useCallback(async (id: string) => {
    try {
      await restoreArchivedChat(id);
      await loadThreads();
      setSelectedThreadId(id);
    } catch (e) {
      console.error(e);
    }
  }, [loadThreads, setSelectedThreadId]);

  const handleDeleteThread = useCallback(async (id: string) => {
    try {
      await deleteChatThread(id);
      await loadThreads();
      if (selectedThreadId === id) {
        setSelectedThreadId(null);
      }
    } catch (e) {
      console.error(e);
    }
  }, [loadThreads, selectedThreadId, setSelectedThreadId]);

  const handleCloseWorkspaceTab = useCallback((workspaceId: string, tabId: string) => {
    window.dispatchEvent(
      new CustomEvent('kite:close-workspace-tab', {
        detail: { workspaceId, tabId },
      })
    );
  }, []);

  const handleRenameWorkspaceTab = useCallback((workspaceId: string, tabId: string, newTitle: string) => {
    window.dispatchEvent(
      new CustomEvent('kite:rename-workspace-tab', {
        detail: { workspaceId, tabId, newTitle },
      })
    );
  }, []);

  return {
    handleAddWorkspace,
    handleCopyPath,
    handleTogglePinWorkspace,
    handleTogglePinAgent,
    handleMoveAgent,
    handleDeleteAgent,
    handleRenameWorkspace,
    handleRemoveWorkspaceFromList,
    handleMoveWorkspace,
    handleTogglePinThread,
    handleRenameThread,
    handleArchiveThread,
    handleRestoreThread,
    handleDeleteThread,
    handleCloseWorkspaceTab,
    handleRenameWorkspaceTab,
  };
}
