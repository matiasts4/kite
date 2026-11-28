import React, { Suspense, lazy } from 'react';
import { ResumeHost } from '../modals/ResumeHost';
import { PromptProjectileOverlay } from '../code/PromptProjectileOverlay';
import { openSettingsTab } from '../../lib/settingsNav';
import type { SupportedPlatform } from '../../lib/shortcuts/types';
import type { WorkMode } from '../Sidebar';
import type { Workspace, AgentProfile } from '../../types';

const CommandPaletteModal = lazy(() =>
  import('../modals/CommandPaletteModal').then((m) => ({ default: m.CommandPaletteModal }))
);
const UsageDashboardModal = lazy(() =>
  import('../views/modals/UsageDashboardModal').then((m) => ({ default: m.UsageDashboardModal }))
);
const WhatsNewModal = lazy(() =>
  import('../views/modals/WhatsNewModal').then((m) => ({ default: m.WhatsNewModal }))
);
const ArchivedChatsModal = lazy(() =>
  import('../views/modals/ArchivedChatsModal').then((m) => ({ default: m.ArchivedChatsModal }))
);
const SshWorkspaceModal = lazy(() =>
  import('../views/modals/SshWorkspaceModal').then((m) => ({ default: m.SshWorkspaceModal }))
);

export interface AppModalsProps {
  isCommandPaletteOpen: boolean;
  onCloseCommandPalette: () => void;
  agents: AgentProfile[];
  workMode: WorkMode;
  setWorkMode: (mode: WorkMode) => void;
  setSettingsOpen: (open: boolean) => void;
  setRoutinesOpen: (open: boolean) => void;
  setSelectedAgentId: (id: string | null) => void;
  selectedAgentId: string | null;
  setSidebarVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setRightDockVisible: React.Dispatch<React.SetStateAction<boolean>>;
  operatorOpen: boolean;
  setOperatorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  platform: SupportedPlatform;

  isUsageModalOpen: boolean;
  onCloseUsageModal: () => void;

  isWhatsNewOpen: boolean;
  onCloseWhatsNew: () => void;

  isArchivedChatsOpen: boolean;
  onCloseArchivedChats: () => void;
  onRestoredArchivedChat: (threadId?: string) => Promise<void> | void;

  isSshModalOpen: boolean;
  onCloseSshModal: () => void;
  onConnectSsh: (ws: Workspace) => void;
}

export const AppModals: React.FC<AppModalsProps> = ({
  isCommandPaletteOpen,
  onCloseCommandPalette,
  agents,
  workMode,
  setWorkMode,
  setSettingsOpen,
  setRoutinesOpen,
  setSelectedAgentId,
  selectedAgentId,
  setSidebarVisible,
  setRightDockVisible,
  operatorOpen,
  setOperatorOpen,
  platform,

  isUsageModalOpen,
  onCloseUsageModal,

  isWhatsNewOpen,
  onCloseWhatsNew,

  isArchivedChatsOpen,
  onCloseArchivedChats,
  onRestoredArchivedChat,

  isSshModalOpen,
  onCloseSshModal,
  onConnectSsh,
}) => {
  return (
    <>
      {isCommandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPaletteModal
            isOpen={isCommandPaletteOpen}
            onClose={onCloseCommandPalette}
            agents={agents}
            onLaunchAgent={(engineId, displayName) => {
              if (workMode !== 'code') {
                setWorkMode('code');
                setSettingsOpen(false);
              }
              setRoutinesOpen(false);
              window.dispatchEvent(
                new CustomEvent('kite:shortcut-pane-action', {
                  detail: { action: 'launch-agent', engineId, engineName: displayName },
                })
              );
            }}
            onSelectAgent={(agentId) => {
              setSelectedAgentId(agentId);
              setWorkMode('agent');
              setSettingsOpen(false);
              setRoutinesOpen(false);
            }}
            onSelectMode={(mode) => {
              setWorkMode(mode);
              setSettingsOpen(false);
              setRoutinesOpen(false);
            }}
            onToggleSidebar={() => setSidebarVisible((v) => !v)}
            onToggleDock={() => setRightDockVisible((v) => !v)}
            onToggleOperator={() => setOperatorOpen((prev) => !prev)}
            onToggleVoice={() => {
              if (!operatorOpen) setOperatorOpen(true);
              window.dispatchEvent(new CustomEvent('kite:toggle-voice'));
            }}
            onOpenSettings={(tab) => {
              setSettingsOpen(true);
              if (tab) openSettingsTab(tab);
            }}
            onNewTerminal={() => {
              if (workMode !== 'code') setWorkMode('code');
              setRoutinesOpen(false);
              window.dispatchEvent(
                new CustomEvent('kite:shortcut-pane-action', { detail: { action: 'new-terminal' } })
              );
            }}
            onSplitPane={(axis) => {
              if (workMode !== 'code') setWorkMode('code');
              setRoutinesOpen(false);
              window.dispatchEvent(
                new CustomEvent('kite:shortcut-pane-action', {
                  detail: { action: 'split-pane', axis },
                })
              );
            }}
            onClosePane={() => {
              window.dispatchEvent(
                new CustomEvent('kite:shortcut-pane-action', { detail: { action: 'close-pane' } })
              );
            }}
            onSaveFile={() => {
              window.dispatchEvent(new CustomEvent('kite:save-file'));
            }}
            platform={platform}
          />
        </Suspense>
      )}

      {isUsageModalOpen && (
        <Suspense fallback={null}>
          <UsageDashboardModal
            isOpen={isUsageModalOpen}
            onClose={onCloseUsageModal}
          />
        </Suspense>
      )}

      {isWhatsNewOpen && (
        <Suspense fallback={null}>
          <WhatsNewModal
            isOpen={isWhatsNewOpen}
            onClose={onCloseWhatsNew}
          />
        </Suspense>
      )}

      {isArchivedChatsOpen && (
        <Suspense fallback={null}>
          <ArchivedChatsModal
            isOpen={isArchivedChatsOpen}
            onClose={onCloseArchivedChats}
            profileId={workMode === 'agent' ? selectedAgentId : null}
            onRestored={onRestoredArchivedChat}
          />
        </Suspense>
      )}

      {isSshModalOpen && (
        <Suspense fallback={null}>
          <SshWorkspaceModal
            isOpen={isSshModalOpen}
            onClose={onCloseSshModal}
            onConnect={onConnectSsh}
          />
        </Suspense>
      )}

      {/* Visual Spark Projectile Overlay for Dispatched Prompts */}
      <PromptProjectileOverlay />

      {/* Startup Agent Recovery Sheet */}
      <ResumeHost />
    </>
  );
};
