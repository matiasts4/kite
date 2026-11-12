import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar, WorkMode } from './components/Sidebar';
import type { WorkspaceSessionTab, ChatThreadSummary } from './components/sidebar/types';
import { RightDock } from './components/RightDock';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { SettingsView } from './components/views/SettingsView';
import { openSettingsTab } from './lib/settingsNav';
import { readKitePref } from './lib/kitePrefs';
import { ZedStripHost, type ZedCallState } from './components/ZedStrip';
import { releaseOperatorCapture } from './lib/operator/voice/zedVoice';
import { useNotifications } from './lib/notifications/useNotifications';
import { Toaster } from './lib/toast';
import { requestNewThread, resolveHeldThreadSelection } from './lib/newThreadRequest';
import { getPlatform } from './lib/shortcuts/shortcutsRegistry';
import type { Workspace, AgentProfile, BootstrapResponse } from './types';
import {
  getBootstrap,
  listChatSummaries,
  listArchivedChats,
  isTauriEnvironment,
  getCreditsBalance,
  getAuthBootstrap,
} from './lib/ipc';
import { isBrowserTestLane } from './lib/browserTestLane';
import { loadOperatorConfig, saveOperatorConfig } from './lib/operator/operatorConfig';
import { APP_INTRO_MIN_MS, pulseZedOrb } from './motion/contract';
import { AppIntro, releaseBootCover } from './motion/AppIntro';

import { useAppTheme } from './components/app/useAppTheme';
import { useAppShortcuts } from './components/app/useAppShortcuts';
import { useAppGlobalEvents } from './components/app/useAppGlobalEvents';
import { useAppSidebarHandlers } from './components/app/useAppSidebarHandlers';
import { AppModals } from './components/app/AppModals';
import { AppNotificationsPopover } from './components/app/AppNotificationsPopover';
import { AppMainStage } from './components/app/AppMainStage';

export type ShellRoute =
  | { kind: 'agent' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'chat'; threadId?: string | null }
  | { kind: 'destination'; destination: string };

export const App: React.FC = () => {
  const [workMode, setWorkMode] = useState<WorkMode>(() => {
    try {
      // Default to 'code' on app launch; ignore previously persisted 'chat' (Thread) mode
      const saved = localStorage.getItem('kite.workMode');
      if (saved === 'code') {
        return 'code';
      }
    } catch {}
    return 'code';
  });

  const [hasOpenedChat, setHasOpenedChat] = useState<boolean>(() => workMode === 'chat');
  useEffect(() => {
    if (workMode === 'chat') {
      setHasOpenedChat(true);
    }
  }, [workMode]);

  useEffect(() => {
    try {
      localStorage.setItem('kite.workMode', workMode);
    } catch {}
  }, [workMode]);

  const skipModeAckRef = useRef(true);
  useEffect(() => {
    if (skipModeAckRef.current) {
      skipModeAckRef.current = false;
      return;
    }
    pulseZedOrb();
  }, [workMode]);

  const [newSessionRequest, setNewSessionRequest] = useState(0);
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(true);
  const [sidebarRailMounted, setSidebarRailMounted] = useState<boolean>(true);
  const [rightDockVisible, setRightDockVisible] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('kite-code.side-panel.visible.v1');
      if (saved !== null) {
        return saved === 'true';
      }
    } catch {}
    return false;
  });

  useEffect(() => {
    try {
      localStorage.setItem('kite-code.side-panel.visible.v1', String(rightDockVisible));
    } catch {}
  }, [rightDockVisible]);

  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  const {
    appearance,
    palette,
    applyTheme,
    handleToggleAppearance,
    handleToggleMode,
    handleSelectTheme,
  } = useAppTheme();

  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => {
    try {
      const saved = localStorage.getItem('kite.cached_workspaces');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [agents, setAgents] = useState<AgentProfile[]>(() => {
    try {
      const saved = localStorage.getItem('kite.cached_agents');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('kite.selectedWorkspaceId') || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (selectedWorkspaceId) {
      try {
        localStorage.setItem('kite.selectedWorkspaceId', selectedWorkspaceId);
      } catch {}
    }
  }, [selectedWorkspaceId]);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [agentEditorOpen, setAgentEditorOpen] = useState<boolean>(false);
  const [agentViewMode, setAgentViewMode] = useState<'chats' | 'settings' | 'memory' | 'skills' | 'starters'>('chats');
  const [_route, _setRoute] = useState<ShellRoute>({ kind: 'agent' });
  const { snapshot: notifSnapshot, unreadCount } = useNotifications();
  const [isNotificationsOpen, setIsNotificationsOpen] = useState<boolean>(false);
  const [notificationsAnchor, setNotificationsAnchor] = useState<DOMRect | null>(null);
  const [workspaceSessions, setWorkspaceSessions] = useState<Record<string, WorkspaceSessionTab[]>>({});
  const [requestedCodeTabId, setRequestedCodeTabId] = useState<string | null>(null);

  const handleCodeSessions = useCallback((workspaceId: string, sessions: WorkspaceSessionTab[]) => {
    setWorkspaceSessions((prev) => {
      const current = prev[workspaceId] ?? [];
      const same =
        current.length === sessions.length &&
        current.every((item, index) => {
          const next = sessions[index];
          if (!next) return false;
          if (
            item.id !== next.id ||
            item.title !== next.title ||
            item.isActive !== next.isActive ||
            item.paneCount !== next.paneCount
          ) {
            return false;
          }
          const itemPanes = item.panes ?? [];
          const nextPanes = next.panes ?? [];
          if (itemPanes.length !== nextPanes.length) return false;
          return itemPanes.every(
            (p, pIdx) =>
              p.id === nextPanes[pIdx]?.id &&
              p.label === nextPanes[pIdx]?.label &&
              p.engine === nextPanes[pIdx]?.engine &&
              p.status === nextPanes[pIdx]?.status &&
              p.isFocused === nextPanes[pIdx]?.isFocused
          );
        });
      if (same) return prev;
      return { ...prev, [workspaceId]: sessions };
    });
  }, []);

  const [accountName, setAccountName] = useState<string>('');
  const [accountEmail, setAccountEmail] = useState<string>('');
  const [accountTier, setAccountTier] = useState<string>('');
  const [accountTierPaid, setAccountTierPaid] = useState<boolean>(false);
  const [creditsLabel, setCreditsLabel] = useState<string>('');

  const [isUsageModalOpen, setIsUsageModalOpen] = useState<boolean>(false);
  const [isWhatsNewOpen, setIsWhatsNewOpen] = useState<boolean>(false);
  const [isArchivedChatsOpen, setIsArchivedChatsOpen] = useState<boolean>(false);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [isSshModalOpen, setIsSshModalOpen] = useState<boolean>(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);
  const appPlatform = getPlatform();
  const [routinesOpen, setRoutinesOpen] = useState<boolean>(false);
  const [zedCallState, setZedCallState] = useState<ZedCallState>({
    isActive: false,
    status: 'connected',
    orbState: 'connected',
    muted: false,
    speakerMuted: false,
    toolCalls: [],
    pendingConfirmation: null,
  });
  const [loading, setLoading] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('kite.cached_workspaces');
      return !saved;
    } catch {
      return true;
    }
  });
  const [bootstrapDone, setBootstrapDone] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const introStartRef = useRef(Date.now());
  const [introDismissed, setIntroDismissed] = useState(() => isBrowserTestLane());
  const bootReady = (bootstrapDone && !loading) || error != null;

  useEffect(() => {
    if (isBrowserTestLane()) return;
    if (introDismissed || !bootReady) return;
    const elapsed = Date.now() - introStartRef.current;
    const wait = Math.max(0, APP_INTRO_MIN_MS - elapsed);
    const timer = window.setTimeout(() => setIntroDismissed(true), wait);
    return () => window.clearTimeout(timer);
  }, [bootReady, introDismissed]);

  useLayoutEffect(() => {
    if (!introDismissed) return;
    releaseBootCover();
  }, [introDismissed]);

  // Kite Operator Assistant Bar state (floating top bar)
  // By default, the assistant does NOT appear as a floating pill upon application launch.
  // The user can toggle it at any time via TitleBar or Ctrl+Shift+K / Cmd+Shift+K.
  const [operatorOpen, setOperatorOpen] = useState<boolean>(() => {
    try {
      if (isBrowserTestLane()) return true;
      localStorage.removeItem('kite.operatorOpen');
      const sessionSaved = sessionStorage.getItem('kite.operatorOpen');
      return sessionSaved === 'true';
    } catch {}
    return false; // Default closed
  });

  useEffect(() => {
    try {
      sessionStorage.setItem('kite.operatorOpen', String(operatorOpen));
    } catch {}
    if (!operatorOpen) {
      void releaseOperatorCapture();
    }
  }, [operatorOpen]);

  const toggleOperator = useCallback(() => {
    setOperatorOpen((prev) => !prev);
  }, []);

  const bootstrappedRef = useRef(false);

  const loadThreads = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    try {
      const list = await listChatSummaries();
      setThreads(list);
      if (list.length > 0) {
        setSelectedThreadId((prev) => resolveHeldThreadSelection(prev, list.map((t) => t.id)));
      }
      try {
        const archived = await listArchivedChats(workMode === 'agent' ? selectedAgentId : null);
        setArchivedCount(Array.isArray(archived) ? archived.length : 0);
      } catch {
        setArchivedCount(0);
      }
    } catch (err) {
      console.warn('Failed to load chat summaries:', err);
    }
  }, [workMode, selectedAgentId]);

  useEffect(() => {
    if (!isBrowserTestLane()) return;
    setWorkMode('agent');
    setOperatorOpen(true);
    const antigravity = agents.find((a) => a.engine === 'antigravity');
    if (antigravity) {
      setSelectedAgentId(antigravity.id);
    }
    const opCfg = loadOperatorConfig();
    if (opCfg.activeProvider !== 'local') {
      saveOperatorConfig({ ...opCfg, activeProvider: 'local' });
    }
  }, [agents]);

  const loadBootstrap = useCallback(async () => {
    if (!isTauriEnvironment()) {
      setLoading(false);
      setBootstrapDone(true);
      return;
    }

    try {
      const data: BootstrapResponse = await getBootstrap();
      setWorkspaces(data.workspaces || []);
      setAgents(data.agents || []);
      try {
        localStorage.setItem('kite.cached_workspaces', JSON.stringify(data.workspaces || []));
        localStorage.setItem('kite.cached_agents', JSON.stringify(data.agents || []));
      } catch {}

      if (data.preferences) {
        if (
          !bootstrappedRef.current &&
          data.preferences.workMode &&
          ['agent', 'code', 'chat'].includes(data.preferences.workMode)
        ) {
          const hasSavedMode = Boolean(localStorage.getItem('kite.workMode'));
          if (!hasSavedMode && data.preferences.workMode === 'code') {
            setWorkMode('code');
          }
        }
        if (typeof data.preferences.sidebarVisible === 'boolean') {
          setSidebarVisible(data.preferences.sidebarVisible);
        }
        if (data.preferences.appearance) {
          const hasLocalTheme = Boolean(readKitePref('theme'));
          if (!hasLocalTheme) {
            const app = data.preferences.appearance === 'light' ? 'light' : 'dark';
            const pal =
              app === 'light'
                ? data.preferences.lightTheme || 'kite-light'
                : data.preferences.darkTheme || 'kite-dark';
            applyTheme(app, pal);
          }
        }
      }

      if (data.workspaces && data.workspaces.length > 0) {
        setSelectedWorkspaceId((prev) => {
          if (prev && data.workspaces.some((w) => w.id === prev)) {
            return prev;
          }
          const saved = localStorage.getItem('kite.selectedWorkspaceId');
          if (saved && data.workspaces.some((w) => w.id === saved)) {
            return saved;
          }
          return data.preferences?.selectedWorkspaceId && data.workspaces.some((w) => w.id === data.preferences.selectedWorkspaceId)
            ? data.preferences.selectedWorkspaceId
            : data.workspaces[0].id;
        });
      }
      if (data.agents && data.agents.length > 0) {
        setSelectedAgentId((prev) => prev || data.preferences?.selectedAgentId || data.agents[0].id);
      }

      // Reveal UI immediately with 0 latency
      setLoading(false);
      bootstrappedRef.current = true;
      setBootstrapDone(true);
      setError(null);

      // Load identity, credits and threads asynchronously in background
      void (async () => {
        try {
          const auth = await getAuthBootstrap();
          if (auth?.user?.name) {
            setAccountName(auth.user.name);
          }
          if (auth?.user?.email) {
            setAccountEmail(auth.user.email);
          }
          if (auth?.subscriptionTier) {
            setAccountTier(auth.subscriptionTier.toUpperCase());
            setAccountTierPaid(auth.subscriptionTier !== 'free');
          }
        } catch (_) {}

        try {
          const creds = await getCreditsBalance();
          if (creds && typeof creds.balance === 'number') {
            setCreditsLabel(creds.balance.toLocaleString());
          }
        } catch (_) {}

        void loadThreads();
      })();
    } catch (err: any) {
      console.error('Failed to bootstrap Studio:', err);
      setError(err?.message || 'Failed to connect to Kite backend.');
      setLoading(false);
      setBootstrapDone(true);
    }
  }, [applyTheme, loadThreads]);

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  const sidebarHandlers = useAppSidebarHandlers({
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
  });

  useAppShortcuts({
    platform: appPlatform,
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
  });

  useAppGlobalEvents({
    setWorkMode,
    setSettingsOpen,
    setRoutinesOpen,
    setSelectedWorkspaceId,
    setSelectedAgentId,
    setSelectedThreadId,
    setRightDockVisible,
    setIsCommandPaletteOpen,
    onAddWorkspace: sidebarHandlers.handleAddWorkspace,
    loadBootstrap,
    loadThreads,
    setAgents,
    selectedAgentId,
  });

  const handleNewChatInWorkspace = useCallback((targetWorkspaceId: string | null) => {
    setHasOpenedChat(true);
    setWorkMode('chat');
    setSettingsOpen(false);
    setRoutinesOpen(false);
    requestNewThread(targetWorkspaceId);
  }, []);

  return (
    <div
      className="zoom-viewport"
      data-palette={palette}
      data-theme={appearance}
    >
      <div
        className="app-frame app-frame--scaled"
        data-palette={palette}
        data-theme={appearance}
        style={{
          '--ui-scale': '1',
          width: '100vw',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        } as React.CSSProperties}
      >
        {/* Top Frameless TitleBar */}
        <TitleBar
          title="Kite"
          activeMode={workMode}
          onModeChange={(m) => {
            setWorkMode(m);
            setSettingsOpen(false);
          }}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          platform={appPlatform}
          browserVisible={rightDockVisible}
          onToggleBrowser={() => setRightDockVisible((v) => !v)}
          operatorVisible={operatorOpen}
          onToggleOperator={toggleOperator}
          settingsOpen={false}
          unreadCount={unreadCount}
          activeEngine={workMode === 'agent' ? agents.find((a) => a.id === selectedAgentId)?.engine : threads.find((t) => t.id === selectedThreadId)?.provider}
          activeSessionTitle={workMode === 'agent' ? agents.find((a) => a.id === selectedAgentId)?.name : threads.find((t) => t.id === selectedThreadId)?.title}
          onOpenNotifications={(rect) => {
            setIsNotificationsOpen((prev) => {
              if (prev) {
                setNotificationsAnchor(null);
                return false;
              }
              setNotificationsAnchor(rect ?? null);
              return true;
            });
          }}
          onOpenUsage={() => setIsUsageModalOpen(true)}
        />

        {/* Main Workspace Shell */}
        <div
          className={`workspace-shell ${
            sidebarVisible || sidebarRailMounted ? '' : 'workspace-shell--sidebar-hidden'
          }`}
        >
          {/* Authentic Left Rail Sidebar */}
          <Sidebar
            hidden={!sidebarVisible}
            onRailPresenceChange={setSidebarRailMounted}
            mode={workMode}
            workspaces={workspaces}
            agents={agents}
            threads={threads}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={(id) => {
              setSelectedWorkspaceId(id);
              setWorkMode('code');
            }}
            selectedAgentId={selectedAgentId}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setAgentEditorOpen(false);
              setWorkMode('agent');
            }}
            selectedThreadId={selectedThreadId}
            onSelectThread={(id) => {
              setSelectedThreadId(id);
              setWorkMode('chat');
            }}
            accountName={accountName}
            accountTier={accountTier}
            accountTierPaid={accountTierPaid}
            creditsLabel={creditsLabel}
            onNewAgent={() => {
              setWorkMode('agent');
              setAgentEditorOpen(true);
              setSettingsOpen(false);
            }}
            onAddWorkspace={sidebarHandlers.handleAddWorkspace}
            onNewChat={() => void handleNewChatInWorkspace(selectedWorkspaceId)}
            onNewChatInWorkspace={(wsId) => void handleNewChatInWorkspace(wsId)}
            onNewAgentChat={(agentId) => {
              setSelectedAgentId(agentId);
              setWorkMode('agent');
              setAgentEditorOpen(false);
              setAgentViewMode('chats');
              setSettingsOpen(false);
              window.dispatchEvent(new CustomEvent('studio-new-agent-chat', { detail: { agentId } }));
            }}
            onCopyWorkspacePath={sidebarHandlers.handleCopyPath}
            onTogglePinWorkspace={sidebarHandlers.handleTogglePinWorkspace}
            onTogglePinAgent={sidebarHandlers.handleTogglePinAgent}
            onMoveAgent={sidebarHandlers.handleMoveAgent}
            onDeleteAgent={sidebarHandlers.handleDeleteAgent}
            onOpenAgentSettings={(id) => {
              setSelectedAgentId(id);
              setWorkMode('agent');
              setAgentEditorOpen(false);
              setAgentViewMode('settings');
              setSettingsOpen(false);
            }}
            onRenameWorkspace={sidebarHandlers.handleRenameWorkspace}
            onRemoveWorkspaceFromList={sidebarHandlers.handleRemoveWorkspaceFromList}
            onMoveWorkspace={sidebarHandlers.handleMoveWorkspace}
            onTogglePinThread={sidebarHandlers.handleTogglePinThread}
            onRenameThread={sidebarHandlers.handleRenameThread}
            onArchiveThread={sidebarHandlers.handleArchiveThread}
            onRestoreThread={sidebarHandlers.handleRestoreThread}
            onDeleteThread={sidebarHandlers.handleDeleteThread}
            archivedCount={archivedCount}
            onNewWorkspaceSession={(id) => {
              setSelectedWorkspaceId(id);
              setWorkMode('code');
              setSettingsOpen(false);
              setNewSessionRequest((n) => n + 1);
            }}
            workspaceSessions={workspaceSessions}
            onSelectWorkspaceTab={(workspaceId, tabId) => {
              setSelectedWorkspaceId(workspaceId);
              setRequestedCodeTabId(tabId);
              setWorkMode('code');
            }}
            onCloseWorkspaceTab={sidebarHandlers.handleCloseWorkspaceTab}
            onRenameWorkspaceTab={sidebarHandlers.handleRenameWorkspaceTab}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenArchivedChats={() => setIsArchivedChatsOpen(true)}
            onConnectSsh={() => setIsSshModalOpen(true)}
            appearance={appearance}
            onToggleAppearance={handleToggleAppearance}
          />

          {/* Center stage. Agent, Code, and Thread stay mounted so a terminal is hidden, not killed, when the mode changes. */}
          <AppMainStage
            workMode={workMode}
            setWorkMode={setWorkMode}
            loading={loading}
            error={error}
            workspaces={workspaces}
            agents={agents}
            setAgents={setAgents}
            selectedWorkspaceId={selectedWorkspaceId}
            setSelectedWorkspaceId={setSelectedWorkspaceId}
            selectedAgentId={selectedAgentId}
            setSelectedAgentId={setSelectedAgentId}
            selectedThreadId={selectedThreadId}
            agentEditorOpen={agentEditorOpen}
            setAgentEditorOpen={setAgentEditorOpen}
            agentViewMode={agentViewMode}
            setAgentViewMode={setAgentViewMode}
            routinesOpen={routinesOpen}
            setRoutinesOpen={setRoutinesOpen}
            setSettingsOpen={setSettingsOpen}
            hasOpenedChat={hasOpenedChat}
            loadBootstrap={loadBootstrap}
            loadThreads={loadThreads}
            handleAddWorkspace={sidebarHandlers.handleAddWorkspace}
            handleCodeSessions={handleCodeSessions}
            requestedCodeTabId={requestedCodeTabId}
            setRequestedCodeTabId={setRequestedCodeTabId}
            newSessionRequest={newSessionRequest}
          />

          {/* Authentic Right Tools & Browser Dock */}
          <ErrorBoundary name="RightDock">
            <RightDock
              visible={rightDockVisible}
              onClose={() => setRightDockVisible(false)}
              workspaceId={selectedWorkspaceId}
              selectedThreadId={selectedThreadId}
              isOccluded={
                isUsageModalOpen ||
                isWhatsNewOpen ||
                isArchivedChatsOpen ||
                isSshModalOpen ||
                isNotificationsOpen ||
                settingsOpen ||
                isCommandPaletteOpen
              }
              workspaces={workspaces}
              onSelectWorkspace={setSelectedWorkspaceId}
              onStartAgent={() => {
                setRightDockVisible(false);
                if (selectedWorkspaceId) {
                  setWorkMode('code');
                  setNewSessionRequest((n) => n + 1);
                }
              }}
            />
          </ErrorBoundary>
        </div>

        {/* Auxiliary Dialogs & Modals */}
        <AppModals
          isCommandPaletteOpen={isCommandPaletteOpen}
          onCloseCommandPalette={() => setIsCommandPaletteOpen(false)}
          agents={agents}
          workMode={workMode}
          setWorkMode={setWorkMode}
          setSettingsOpen={setSettingsOpen}
          setRoutinesOpen={setRoutinesOpen}
          setSelectedAgentId={setSelectedAgentId}
          selectedAgentId={selectedAgentId}
          setSidebarVisible={setSidebarVisible}
          setRightDockVisible={setRightDockVisible}
          operatorOpen={operatorOpen}
          setOperatorOpen={setOperatorOpen}
          platform={appPlatform}
          isUsageModalOpen={isUsageModalOpen}
          onCloseUsageModal={() => setIsUsageModalOpen(false)}
          isWhatsNewOpen={isWhatsNewOpen}
          onCloseWhatsNew={() => setIsWhatsNewOpen(false)}
          isArchivedChatsOpen={isArchivedChatsOpen}
          onCloseArchivedChats={() => setIsArchivedChatsOpen(false)}
          onRestoredArchivedChat={async (threadId) => {
            setWorkMode('chat');
            await loadThreads();
            if (threadId) {
              setSelectedThreadId(threadId);
            }
          }}
          isSshModalOpen={isSshModalOpen}
          onCloseSshModal={() => setIsSshModalOpen(false)}
          onConnectSsh={(ws) => {
            setIsSshModalOpen(false);
            void loadBootstrap();
            setSelectedWorkspaceId(ws.id);
            setWorkMode('code');
          }}
        />

        <SettingsView
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onBack={() => setSettingsOpen(false)}
          onOpenWhatsNew={() => setIsWhatsNewOpen(true)}
          accountName={accountName}
          accountEmail={accountEmail || 'developer@kite.local'}
          accountTier={accountTier}
          accountTierPaid={accountTierPaid}
          creditsLabel={creditsLabel}
          mode={appearance}
          palette={palette}
          onToggleMode={handleToggleMode}
          onSelectTheme={handleSelectTheme}
        />

        {/* Notifications Popover */}
        <AppNotificationsPopover
          isOpen={isNotificationsOpen}
          anchor={notificationsAnchor}
          notifSnapshot={notifSnapshot}
          onClose={() => {
            setIsNotificationsOpen(false);
            setNotificationsAnchor(null);
          }}
          setSelectedAgentId={setSelectedAgentId}
          setSelectedThreadId={setSelectedThreadId}
          setWorkMode={setWorkMode}
          setSettingsOpen={setSettingsOpen}
        />

        {/* Floating Zed Voice & Operations Orb */}
        <ZedStripHost
          workspaceId={selectedWorkspaceId}
          call={{
            ...zedCallState,
            isActive: operatorOpen,
          }}
          onToggleMute={() =>
            setZedCallState((s) => ({ ...s, muted: !s.muted }))
          }
          onToggleSpeaker={() =>
            setZedCallState((s) => ({ ...s, speakerMuted: !s.speakerMuted }))
          }
          onEndCall={() => setOperatorOpen(false)}
          onOpenSettingsZed={() => {
            setSettingsOpen(true);
            openSettingsTab('zed');
          }}
        />

        <AppIntro open={!introDismissed} />

        {/* Ambient Sileo Toast System */}
        <Toaster position="bottom-right" theme="dark" offset={{ bottom: 24, right: 24 }} />
      </div>
    </div>
  );
};
