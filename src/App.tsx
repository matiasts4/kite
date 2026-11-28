import React, { useState, useEffect, useCallback, useRef, useLayoutEffect, Suspense, lazy } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar, WorkMode } from './components/Sidebar';
import type { WorkspaceSessionTab, ChatThreadSummary } from './components/sidebar/types';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { openSettingsTab } from './lib/settingsNav';
import {
  OPEN_RIGHT_DOCK_SIDECAR_EVENT,
  type OpenRightDockSidecarDetail,
} from './lib/sidecarNav';
const ArgosCompanionBar = lazy(() =>
  import('./components/ArgosCompanionBar').then((m) => ({ default: m.ArgosCompanionBar }))
);
import {
  COMPANION_GLOBAL_HOTKEY_EVENT,
  loadCompanionGlobalShortcut,
  matchesCompanionHotkey,
  registerOsCompanionGlobalShortcut,
  transferVoiceCallSurface,
} from './lib/operator/voice/companionTransfer';
import { sendUiAck, type UiBusRequestPayload, type NavigateViewPayload } from './lib/operator/executor/ui-bus';

const RightDock = lazy(() => import('./components/RightDock').then((m) => ({ default: m.RightDock })));
const SettingsView = lazy(() => import('./components/views/SettingsView').then((m) => ({ default: m.SettingsView })));
const ZedStripHost = lazy(() => import('./components/ZedStrip').then((m) => ({ default: m.ZedStripHost })));
import { isValidWorkMode, readKitePref, readSavedWorkMode, writeSavedWorkMode } from './lib/kitePrefs';
import type { ZedCallState } from './components/ZedStrip';
import { useVoiceSession, voiceSessionStore } from './lib/operator/voice/voiceSessionStore';
import { loadInitialTabs } from './components/dock/dockConfig';
import { useNotifications } from './lib/notifications/useNotifications';
import { startTerminalNotificationBridge } from './lib/notifications/terminalNotificationBridge';
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
import { StageBackdrop } from './components/theme/StageBackdrop';
import { THEME_CUSTOMIZATIONS_STORAGE_KEY } from './lib/themeCustomizations';
import { useAppShortcuts } from './components/app/useAppShortcuts';
import { useAppGlobalEvents } from './components/app/useAppGlobalEvents';
import { useAppSidebarHandlers } from './components/app/useAppSidebarHandlers';
import { AppModals } from './components/app/AppModals';
import { AppNotificationsPopover } from './components/app/AppNotificationsPopover';
import { AppMainStage } from './components/app/AppMainStage';
import { GuidedLoginBanner } from './components/quota/GuidedLoginBanner';
import { initArgosRemoteBridge } from './lib/remote/argosRemoteBridge';

export type ShellRoute =
  | { kind: 'agent' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'chat'; threadId?: string | null }
  | { kind: 'destination'; destination: string };

export const App: React.FC = () => {
  const hadSavedWorkModeRef = useRef<boolean>(readSavedWorkMode() !== null);
  const [workMode, setWorkModeState] = useState<WorkMode>(() => readSavedWorkMode() ?? 'code');

  const workModeRef = useRef<WorkMode>(workMode);
  workModeRef.current = workMode;

  const setWorkMode = useCallback<React.Dispatch<React.SetStateAction<WorkMode>>>((next) => {
    const resolved = typeof next === 'function' ? next(workModeRef.current) : next;
    workModeRef.current = resolved;
    writeSavedWorkMode(resolved);
    setWorkModeState(resolved);
  }, []);

  const [hasOpenedChat, setHasOpenedChat] = useState<boolean>(() => workMode === 'chat');
  useEffect(() => {
    if (workMode === 'chat') {
      setHasOpenedChat(true);
    }
  }, [workMode]);

  useEffect(() => {
    writeSavedWorkMode(workMode);
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

  const [hasOpenedRightDock, setHasOpenedRightDock] = useState<boolean>(() => rightDockVisible);
  useEffect(() => {
    if (rightDockVisible) {
      setHasOpenedRightDock(true);
    }
  }, [rightDockVisible]);

  const voiceSession = useVoiceSession();
  const isVoiceSessionRunning =
    voiceSession.phase === 'active' || voiceSession.phase === 'starting';
  const keepRightDockMountedForBrowser =
    !rightDockVisible &&
    hasOpenedRightDock &&
    loadInitialTabs().tabs.some((t) => t.kind === 'browser');
  const shouldMountRightDock = rightDockVisible || keepRightDockMountedForBrowser;

  useEffect(() => {
    try {
      localStorage.setItem('kite-code.side-panel.visible.v1', String(rightDockVisible));
    } catch {}
  }, [rightDockVisible]);

  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [hasOpenedSettings, setHasOpenedSettings] = useState<boolean>(false);
  useEffect(() => {
    if (settingsOpen) {
      setHasOpenedSettings(true);
    }
  }, [settingsOpen]);

  const {
    appearance,
    appearanceMode,
    palette,
    customizations,
    applyTheme,
    handleToggleAppearance,
    handleToggleMode,
    handleSelectTheme,
    updateCustomizations,
    resetThemeOverrides,
    resetAllCustomizations,
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
  const [selectedAgentThreadId, setSelectedAgentThreadId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [agentEditorOpen, setAgentEditorOpen] = useState<boolean>(false);
  const [agentViewMode, setAgentViewMode] = useState<'chats' | 'settings' | 'memory' | 'skills' | 'starters' | 'playbooks' | 'audit'>('chats');
  const [_route, _setRoute] = useState<ShellRoute>({ kind: 'agent' });
  const [routinesOpen, setRoutinesOpen] = useState<boolean>(false);
  const { snapshot: notifSnapshot, unreadCount } = useNotifications({
    activeContext: {
      workMode,
      selectedAgentId,
      selectedAgentThreadId,
      selectedThreadId,
      selectedWorkspaceId,
      settingsOpen,
      routinesOpen,
    },
    lookups: {
      agents,
      threads,
    },
  });

  useEffect(() => {
    return startTerminalNotificationBridge();
  }, []);
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
  const [companionBarOpen, setCompanionBarOpen] = useState<boolean>(false);
  const [zedCallState] = useState<ZedCallState>({
    isActive: false,
    status: 'connected',
    orbState: 'connected',
    toolCalls: [],
    pendingConfirmation: null,
  });

  useEffect(() => {
    const summonCompanion = () => {
      setCompanionBarOpen(true);
      const snapshot = voiceSessionStore.getSnapshot();
      if (snapshot.phase === 'active' || snapshot.phase === 'starting') {
        transferVoiceCallSurface('companion');
      }
    };

    const handleCompanionHotkey = (event: KeyboardEvent) => {
      if (!matchesCompanionHotkey(event, loadCompanionGlobalShortcut())) return;
      event.preventDefault();
      setCompanionBarOpen((prev) => {
        const next = !prev;
        if (next) {
          const snapshot = voiceSessionStore.getSnapshot();
          if (snapshot.phase === 'active' || snapshot.phase === 'starting') {
            transferVoiceCallSurface('companion');
          }
        }
        return next;
      });
    };

    window.addEventListener('keydown', handleCompanionHotkey);
    window.addEventListener(COMPANION_GLOBAL_HOTKEY_EVENT, summonCompanion);

    let unlistenOsHotkey: (() => void) | undefined;
    let cancelled = false;
    if (isTauriEnvironment()) {
      void registerOsCompanionGlobalShortcut(loadCompanionGlobalShortcut());
      void import('@tauri-apps/api/event')
        .then(({ listen }) =>
          listen(COMPANION_GLOBAL_HOTKEY_EVENT, () => {
            if (!cancelled) {
              summonCompanion();
              window.dispatchEvent(new CustomEvent(COMPANION_GLOBAL_HOTKEY_EVENT));
            }
          })
        )
        .then((stop) => {
          if (cancelled) stop();
          else unlistenOsHotkey = stop;
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
      unlistenOsHotkey?.();
      window.removeEventListener('keydown', handleCompanionHotkey);
      window.removeEventListener(COMPANION_GLOBAL_HOTKEY_EVENT, summonCompanion);
    };
  }, []);
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

  const wasOperatorOpenRef = useRef(operatorOpen);
  useEffect(() => {
    const wasOpen = wasOperatorOpenRef.current;
    wasOperatorOpenRef.current = operatorOpen;
    try {
      sessionStorage.setItem('kite.operatorOpen', String(operatorOpen));
    } catch {}
    if (!operatorOpen && wasOpen) {
      const phase = voiceSessionStore.getSnapshot().phase;
      if (phase !== 'active' && phase !== 'starting') {
        void import('./lib/operator/voice/zedVoice')
          .then(({ releaseOperatorCapture }) => releaseOperatorCapture())
          .catch(() => undefined);
      }
    }
  }, [operatorOpen]);

  const toggleOperator = useCallback(() => {
    setOperatorOpen((prev) => !prev);
  }, []);

  const bootstrappedRef = useRef(false);

  const selectedAgentIdRef = useRef<string | null>(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  const loadThreads = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    try {
      const list = await listChatSummaries();
      setThreads(list);
      if (list.length > 0) {
        setSelectedThreadId((prev) => resolveHeldThreadSelection(prev, list.map((t) => t.id)));
      }
      try {
        const currentMode = workModeRef.current;
        const currentAgentId = selectedAgentIdRef.current;
        const archived = await listArchivedChats(currentMode === 'agent' ? currentAgentId : null);
        setArchivedCount(Array.isArray(archived) ? archived.length : 0);
      } catch {
        setArchivedCount(0);
      }
    } catch (err) {
      console.warn('Failed to load chat summaries:', err);
    }
  }, []);

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
          !hadSavedWorkModeRef.current &&
          isValidWorkMode(data.preferences.workMode)
        ) {
          setWorkMode(data.preferences.workMode);
        }
        if (typeof data.preferences.sidebarVisible === 'boolean') {
          setSidebarVisible(data.preferences.sidebarVisible);
        }
        if (data.preferences.themeCustomizations) {
          const hasLocalCustomizations = Boolean(
            localStorage.getItem(THEME_CUSTOMIZATIONS_STORAGE_KEY)
          );
          if (!hasLocalCustomizations) {
            updateCustomizations(data.preferences.themeCustomizations);
          }
        } else if (data.preferences.appearance) {
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

  const archivedOwnerId = workMode === 'agent' ? selectedAgentId : null;
  useEffect(() => {
    if (!bootstrappedRef.current || !isTauriEnvironment()) return;
    let cancelled = false;
    void listArchivedChats(archivedOwnerId)
      .then((archived) => {
        if (!cancelled) {
          setArchivedCount(Array.isArray(archived) ? archived.length : 0);
        }
      })
      .catch(() => {
        if (!cancelled) setArchivedCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [archivedOwnerId]);

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
    setSelectedAgentThreadId,
    setSelectedThreadId,
    setAgentViewMode,
    setRightDockVisible,
    setIsCommandPaletteOpen,
    onAddWorkspace: sidebarHandlers.handleAddWorkspace,
    loadBootstrap,
    loadThreads,
    setAgents,
    selectedAgentId,
  });

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    return initArgosRemoteBridge();
  }, []);

  useEffect(() => {
    const handleNavigateViewRequest = (e: Event) => {
      const custom = e as CustomEvent<UiBusRequestPayload>;
      if (!custom.detail || custom.detail.kind !== 'navigate-view') return;
      const payload = (custom.detail.payload || {}) as Partial<NavigateViewPayload>;
      const view = payload.view;
      if (!view) {
        sendUiAck({ reqId: custom.detail.reqId, ok: false, reason: 'missing_view' });
        return;
      }
      if (view === 'threads') {
        setWorkMode('chat');
        setSettingsOpen(false);
        setRoutinesOpen(false);
        if (payload.threadId) setSelectedThreadId(payload.threadId);
      } else if (view === 'code') {
        setWorkMode('code');
        setSettingsOpen(false);
        setRoutinesOpen(false);
        if (payload.filePath) {
          setRightDockVisible(true);
          window.dispatchEvent(
            new CustomEvent('kite:open-right-dock-file', { detail: { filePath: payload.filePath } })
          );
        }
      } else if (view === 'agents') {
        setWorkMode('agent');
        setSettingsOpen(false);
        setRoutinesOpen(false);
      } else if (view === 'diffs') {
        setRightDockVisible(true);
        window.dispatchEvent(new CustomEvent('kite:open-right-dock-diffs'));
      } else if (view === 'tasks') {
        setRightDockVisible(true);
        window.dispatchEvent(
          new CustomEvent('kite:open-right-dock-tasks', {
            detail: payload.taskId ? { taskId: payload.taskId } : undefined,
          })
        );
      } else if (view === 'routines') {
        setRoutinesOpen(true);
        setSettingsOpen(false);
      } else if (view === 'settings') {
        setSettingsOpen(true);
      }
      sendUiAck({ reqId: custom.detail.reqId, ok: true, data: { view } });
    };
    window.addEventListener('kite:op-request', handleNavigateViewRequest);
    return () => window.removeEventListener('kite:op-request', handleNavigateViewRequest);
  }, [setWorkMode]);

  useEffect(() => {
    const handleOpenSidecarInDock = (e: Event) => {
      const custom = e as CustomEvent<OpenRightDockSidecarDetail | undefined>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };
    window.addEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, handleOpenSidecarInDock);
    return () => window.removeEventListener(OPEN_RIGHT_DOCK_SIDECAR_EVENT, handleOpenSidecarInDock);
  }, []);

  const handleNewChatInWorkspace = useCallback((targetWorkspaceId: string | null) => {
    setHasOpenedChat(true);
    setWorkMode('chat');
    setSettingsOpen(false);
    setRoutinesOpen(false);
    requestNewThread(targetWorkspaceId);
  }, []);

  const handleShowModeHome = useCallback(() => {
    setRoutinesOpen(false);
    setSettingsOpen(false);
    if (workModeRef.current === 'agent') {
      setAgentEditorOpen(false);
    }
  }, []);

  const handleSelectWorkspace = useCallback(
    (id: string) => {
      setSelectedWorkspaceId(id);
      setWorkMode('code');
      setRoutinesOpen(false);
    },
    [setSelectedWorkspaceId, setWorkMode],
  );

  const handleSelectAgent = useCallback(
    (id: string) => {
      if (id !== selectedAgentIdRef.current) {
        setSelectedAgentThreadId(null);
      }
      setSelectedAgentId(id);
      setAgentEditorOpen(false);
      setWorkMode('agent');
      setRoutinesOpen(false);
    },
    [setSelectedAgentId, setWorkMode],
  );

  const handleSelectThread = useCallback(
    (id: string) => {
      setSelectedThreadId(id);
      setWorkMode('chat');
      setRoutinesOpen(false);
    },
    [setSelectedThreadId, setWorkMode],
  );

  const handleNewAgent = useCallback(() => {
    setWorkMode('agent');
    setAgentEditorOpen(true);
    setSettingsOpen(false);
    setRoutinesOpen(false);
  }, [setWorkMode]);

  const handleAddWorkspaceClick = useCallback(() => {
    void sidebarHandlers.handleAddWorkspace();
  }, [sidebarHandlers.handleAddWorkspace]);

  const handleNewGlobalChat = useCallback(() => {
    void handleNewChatInWorkspace(null);
  }, [handleNewChatInWorkspace]);

  const handleNewAgentChat = useCallback(
    (agentId: string) => {
      if (agentId !== selectedAgentIdRef.current) {
        setSelectedAgentThreadId(null);
      }
      setSelectedAgentId(agentId);
      setWorkMode('agent');
      setAgentEditorOpen(false);
      setAgentViewMode('chats');
      setSettingsOpen(false);
      setRoutinesOpen(false);
      window.dispatchEvent(new CustomEvent('studio-new-agent-chat', { detail: { agentId } }));
    },
    [setSelectedAgentId, setWorkMode],
  );

  const handleOpenAgentSettings = useCallback(
    (id: string) => {
      setSelectedAgentId(id);
      setWorkMode('agent');
      setAgentEditorOpen(false);
      setAgentViewMode('settings');
      setSettingsOpen(false);
      setRoutinesOpen(false);
    },
    [setSelectedAgentId, setWorkMode],
  );

  const handleToggleRoutines = useCallback(() => {
    setRoutinesOpen((prev) => !prev);
    setSettingsOpen(false);
  }, []);

  const handleNewWorkspaceSession = useCallback(
    (id: string) => {
      setSelectedWorkspaceId(id);
      setWorkMode('code');
      setSettingsOpen(false);
      setRoutinesOpen(false);
      setNewSessionRequest((n) => n + 1);
    },
    [setSelectedWorkspaceId, setWorkMode],
  );

  const handleSelectWorkspaceTab = useCallback(
    (workspaceId: string, tabId: string) => {
      setSelectedWorkspaceId(workspaceId);
      setRequestedCodeTabId(tabId);
      setWorkMode('code');
      setRoutinesOpen(false);
    },
    [setSelectedWorkspaceId, setWorkMode],
  );

  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleOpenArchivedChats = useCallback(() => setIsArchivedChatsOpen(true), []);
  const handleConnectSsh = useCallback(() => setIsSshModalOpen(true), []);
  const handleCloseRightDock = useCallback(() => setRightDockVisible(false), []);
  const handleStartAgentFromDock = useCallback(() => {
    setRightDockVisible(false);
    if (selectedWorkspaceId) {
      setWorkMode('code');
      setNewSessionRequest((n) => n + 1);
    }
  }, [selectedWorkspaceId, setWorkMode]);

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
          position: 'relative',
        } as React.CSSProperties}
      >
        {/* Ambient Stage Backdrop & Surface Atmosphere */}
        <StageBackdrop customizations={customizations} />

        {/* Top Frameless TitleBar */}
        <TitleBar
          title="Kite"
          activeMode={workMode}
          onModeChange={(m) => {
            setWorkMode(m);
            setSettingsOpen(false);
            setRoutinesOpen(false);
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

        <GuidedLoginBanner />

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
            routinesOpen={routinesOpen}
            onShowModeHome={handleShowModeHome}
            workspaces={workspaces}
            agents={agents}
            threads={threads}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={handleSelectWorkspace}
            selectedAgentId={selectedAgentId}
            onSelectAgent={handleSelectAgent}
            selectedThreadId={selectedThreadId}
            onSelectThread={handleSelectThread}
            accountName={accountName}
            accountTier={accountTier}
            accountTierPaid={accountTierPaid}
            creditsLabel={creditsLabel}
            onNewAgent={handleNewAgent}
            onAddWorkspace={handleAddWorkspaceClick}
            onNewChat={handleNewGlobalChat}
            onNewChatInWorkspace={handleNewChatInWorkspace}
            onNewAgentChat={handleNewAgentChat}
            onCopyWorkspacePath={sidebarHandlers.handleCopyPath}
            onTogglePinWorkspace={sidebarHandlers.handleTogglePinWorkspace}
            onTogglePinAgent={sidebarHandlers.handleTogglePinAgent}
            onMoveAgent={sidebarHandlers.handleMoveAgent}
            onDeleteAgent={sidebarHandlers.handleDeleteAgent}
            onOpenAgentSettings={handleOpenAgentSettings}
            onOpenRoutines={handleToggleRoutines}
            onRenameWorkspace={sidebarHandlers.handleRenameWorkspace}
            onRemoveWorkspaceFromList={sidebarHandlers.handleRemoveWorkspaceFromList}
            onMoveWorkspace={sidebarHandlers.handleMoveWorkspace}
            onTogglePinThread={sidebarHandlers.handleTogglePinThread}
            onRenameThread={sidebarHandlers.handleRenameThread}
            onRegenerateTitle={sidebarHandlers.handleRegenerateTitle}
            titlePending={sidebarHandlers.titlePending}
            onArchiveThread={sidebarHandlers.handleArchiveThread}
            onRestoreThread={sidebarHandlers.handleRestoreThread}
            onDeleteThread={sidebarHandlers.handleDeleteThread}
            archivedCount={archivedCount}
            onNewWorkspaceSession={handleNewWorkspaceSession}
            workspaceSessions={workspaceSessions}
            onSelectWorkspaceTab={handleSelectWorkspaceTab}
            onCloseWorkspaceTab={sidebarHandlers.handleCloseWorkspaceTab}
            onRenameWorkspaceTab={sidebarHandlers.handleRenameWorkspaceTab}
            onOpenSettings={handleOpenSettings}
            onOpenArchivedChats={handleOpenArchivedChats}
            onConnectSsh={handleConnectSsh}
            appearance={appearance}
            onToggleAppearance={handleToggleAppearance}
          />

          {/* Center stage. Agent, Code, and Thread stay mounted so a terminal is hidden, not killed, when the mode changes. */}
          <ErrorBoundary name="WorkspaceStage">
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
              selectedAgentThreadId={selectedAgentThreadId}
              setSelectedAgentThreadId={setSelectedAgentThreadId}
              selectedThreadId={selectedThreadId}
              setSelectedThreadId={setSelectedThreadId}
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
          </ErrorBoundary>

          {/* Authentic Right Tools & Browser Dock */}
          {shouldMountRightDock && (
            <ErrorBoundary name="RightDock">
              <Suspense fallback={null}>
                <RightDock
                  visible={rightDockVisible}
                  onClose={handleCloseRightDock}
                  workspaceId={selectedWorkspaceId}
                  selectedThreadId={
                    workMode === 'agent'
                      ? (selectedAgentThreadId ?? selectedThreadId)
                      : selectedThreadId
                  }
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
                  onStartAgent={handleStartAgentFromDock}
                />
              </Suspense>
            </ErrorBoundary>
          )}
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
            setRoutinesOpen(false);
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
            setRoutinesOpen(false);
          }}
        />

        {hasOpenedSettings && (
          <Suspense fallback={null}>
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
              appearanceMode={appearanceMode}
              palette={palette}
              customizations={customizations}
              onToggleMode={handleToggleMode}
              onSelectTheme={handleSelectTheme}
              onUpdateCustomizations={updateCustomizations}
              onResetThemeOverrides={resetThemeOverrides}
              onResetAllCustomizations={resetAllCustomizations}
            />
          </Suspense>
        )}

        {/* Notifications Popover */}
        <AppNotificationsPopover
          isOpen={isNotificationsOpen}
          anchor={notificationsAnchor}
          notifSnapshot={notifSnapshot}
          agents={agents}
          threads={threads}
          onClose={() => {
            setIsNotificationsOpen(false);
            setNotificationsAnchor(null);
          }}
          setSelectedWorkspaceId={setSelectedWorkspaceId}
          setSelectedAgentId={setSelectedAgentId}
          setSelectedAgentThreadId={setSelectedAgentThreadId}
          setSelectedThreadId={setSelectedThreadId}
          setAgentViewMode={setAgentViewMode}
          setWorkMode={setWorkMode}
          setSettingsOpen={setSettingsOpen}
          setRoutinesOpen={setRoutinesOpen}
        />

        {/* Floating Argos Voice & Operations Orb */}
        {(operatorOpen || isVoiceSessionRunning) && (
          <Suspense fallback={null}>
            <ZedStripHost
              workspaceId={selectedWorkspaceId}
              call={{
                ...zedCallState,
                isActive: operatorOpen,
                muted: voiceSession.micMuted,
                speakerMuted: voiceSession.speakerMuted,
              }}
              onToggleMute={() => voiceSession.toggleMicMuted()}
              onToggleSpeaker={() => voiceSession.toggleSpeakerMuted()}
              onEndCall={() => setOperatorOpen(false)}
              onOpenSettingsZed={() => {
                setSettingsOpen(true);
                openSettingsTab('zed');
              }}
            />
          </Suspense>
        )}

        {companionBarOpen && (
          <Suspense fallback={null}>
            <ArgosCompanionBar
              open={companionBarOpen}
              onOpenChange={setCompanionBarOpen}
              enableGlobalHotkey={false}
              threadId={voiceSession.boundThreadId ?? selectedThreadId}
              onTransferToThread={(tid) => {
                if (tid) setSelectedThreadId(tid);
                setWorkMode('chat');
                setRoutinesOpen(false);
                setCompanionBarOpen(false);
              }}
              onEndSession={() => setCompanionBarOpen(false)}
            />
          </Suspense>
        )}

        <AppIntro open={!introDismissed} />

        {/* Ambient Sileo Toast System */}
        <Toaster position="bottom-right" theme={appearance} offset={isVoiceSessionRunning ? { bottom: 96, right: 24 } : { bottom: 24, right: 24 }} />
      </div>
    </div>
  );
};
