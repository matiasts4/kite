import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TitleBar } from './components/TitleBar';
import { Sidebar, WorkMode } from './components/Sidebar';
import type { WorkspaceSessionTab, ChatThreadSummary } from './components/sidebar/types';
import { RightDock } from './components/RightDock';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { ChatView } from './components/views/ChatView';
import { CodeWorkspace } from './components/code/CodeWorkspace';
import { AgentsView } from './components/views/AgentsView';
import { SettingsView } from './components/views/SettingsView';
import { OPEN_SETTINGS_EVENT, openSettingsTab } from './lib/settingsNav';
import { OPEN_RIGHT_DOCK_BROWSER_EVENT } from './lib/terminalLinkNav';
import { ZedStripHost, type ZedCallState } from './components/ZedStrip';
import { releaseOperatorCapture } from './lib/operator/voice/zedVoice';
import { RoutinesView } from './components/views/RoutinesView';
import { UsageDashboardModal } from './components/views/modals/UsageDashboardModal';
import { WhatsNewModal } from './components/views/modals/WhatsNewModal';
import { ArchivedChatsModal } from './components/views/modals/ArchivedChatsModal';
import { SshWorkspaceModal } from './components/views/modals/SshWorkspaceModal';
import { NotificationsView } from './components/views/NotificationsView';
import { useNotifications } from './lib/notifications/useNotifications';
import { Toaster, registerToastNavigator } from './lib/toast';
import { ResumeHost } from './components/modals/ResumeHost';
import { PromptProjectileOverlay } from './components/code/PromptProjectileOverlay';
import type { Workspace, AgentProfile, BootstrapResponse } from './types';
import {
  getBootstrap,
  addWorkspace,
  copyWorkspacePath,
  setWorkspacePinned,
  renameWorkspace,
  removeWorkspace,
  moveWorkspace,
  setAgentPinned,
  moveAgent,
  deleteAgentProfile,
  createGeneralChat,
  listChatSummaries,
  renameChatThread,
  setChatThreadPinned,
  deleteChatThread,
  isTauriEnvironment,
  getCreditsBalance,
  getAuthBootstrap,
} from './lib/ipc';
import { isBrowserTestLane } from './lib/browserTestLane';
import { loadOperatorConfig, saveOperatorConfig } from './lib/operator/operatorConfig';
import { sendUiAck, type UiBusRequestPayload } from './lib/operator/executor/ui-bus';
import { APP_INTRO_MIN_MS, pulseZedOrb } from './motion/contract';
import { AppIntro } from './motion/AppIntro';
import { AnimatePresence, motion } from 'motion/react';
import { surfaceMotion } from './motion/standard/surfaces';

export type ShellRoute =
  | { kind: 'agent' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'chat'; threadId?: string | null }
  | { kind: 'destination'; destination: string };

export const App: React.FC = () => {
  const [workMode, setWorkMode] = useState<WorkMode>(() => {
    try {
      // Default to 'code' on app launch; ignore previously persisted 'chat' (Thread) mode
      const saved = localStorage.getItem('bmone.workMode');
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
      localStorage.setItem('bmone.workMode', workMode);
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
  const [appearance, setAppearance] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('bmone.theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {}
    return 'dark';
  });
  const [palette, setPalette] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('bmone.palette');
      if (saved) return saved;
    } catch {}
    return 'kite-dark';
  });

  const applyTheme = useCallback((nextTheme: 'dark' | 'light', nextPalette?: string) => {
    const effectivePalette =
      nextPalette ?? (nextTheme === 'light' ? 'kite-light' : 'kite-dark');
    setAppearance(nextTheme);
    setPalette(effectivePalette);

    try {
      localStorage.setItem('bmone.theme', nextTheme);
      localStorage.setItem('bmone.palette', effectivePalette);
    } catch {}

    document.documentElement.setAttribute('data-theme', nextTheme);
    document.documentElement.setAttribute('data-palette', effectivePalette);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    document.documentElement.classList.toggle('light', nextTheme === 'light');

    const appFrame = document.querySelector('.app-frame');
    if (appFrame) {
      appFrame.setAttribute('data-theme', nextTheme);
      appFrame.setAttribute('data-palette', effectivePalette);
    }

    const zoomViewport = document.querySelector('.zoom-viewport');
    if (zoomViewport) {
      zoomViewport.setAttribute('data-theme', nextTheme);
      zoomViewport.setAttribute('data-palette', effectivePalette);
    }

    window.dispatchEvent(
      new CustomEvent('kite:theme-changed', {
        detail: { theme: nextTheme, palette: effectivePalette },
      })
    );
  }, []);

  useEffect(() => {
    applyTheme(appearance, palette);
  }, []);

  useEffect(() => {
    const handleThemeEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ theme?: 'dark' | 'light'; palette?: string }>).detail;
      if (detail?.theme && (detail.theme === 'dark' || detail.theme === 'light')) {
        setAppearance(detail.theme);
        if (detail.palette) setPalette(detail.palette);
      }
    };
    window.addEventListener('kite:theme-changed', handleThemeEvent);
    return () => window.removeEventListener('kite:theme-changed', handleThemeEvent);
  }, []);

  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => {
    try {
      const saved = localStorage.getItem('bmone.cached_workspaces');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [agents, setAgents] = useState<AgentProfile[]>(() => {
    try {
      const saved = localStorage.getItem('bmone.cached_agents');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('bmone.selectedWorkspaceId') || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (selectedWorkspaceId) {
      try {
        localStorage.setItem('bmone.selectedWorkspaceId', selectedWorkspaceId);
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
  }, []);

  const handleCodeSessions = useCallback((workspaceId: string, sessions: WorkspaceSessionTab[]) => {
    setWorkspaceSessions((prev) => {
      const current = prev[workspaceId] ?? [];
      const same =
        current.length === sessions.length &&
        current.every(
          (item, index) =>
            item.id === sessions[index]?.id &&
            item.title === sessions[index]?.title &&
            item.isActive === sessions[index]?.isActive &&
            item.paneCount === sessions[index]?.paneCount
        );
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
  const [isSshModalOpen, setIsSshModalOpen] = useState<boolean>(false);
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
      const saved = localStorage.getItem('kite.cached_workspaces') || localStorage.getItem('bmone.cached_workspaces');
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

  // Global keyboard shortcuts:
  // - Ctrl+Shift+K or Cmd+Shift+K: Toggle Asistente Zed (abrir / cerrar)
  // - Ctrl+Shift+V or Alt+V: Abrir Asistente Zed para dictar si está cerrado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOperatorOpen((prev) => !prev);
        return;
      }

      const isVoiceShortcut =
        ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) ||
        (e.altKey && (e.key === 'v' || e.key === 'V'));

      if (isVoiceShortcut && !operatorOpen) {
        e.preventDefault();
        setOperatorOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [operatorOpen]);

  const bootstrappedRef = useRef(false);

  const loadThreads = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    try {
      const list = await listChatSummaries();
      setThreads(list);
      if (list.length > 0) {
        setSelectedThreadId((prev) => (prev && list.some((t) => t.id === prev) ? prev : list[0].id));
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
        localStorage.setItem('bmone.cached_workspaces', JSON.stringify(data.workspaces || []));
        localStorage.setItem('bmone.cached_agents', JSON.stringify(data.agents || []));
      } catch {}

      if (data.preferences) {
        if (
          !bootstrappedRef.current &&
          data.preferences.workMode &&
          ['agent', 'code', 'chat'].includes(data.preferences.workMode)
        ) {
          const hasSavedMode = Boolean(localStorage.getItem('bmone.workMode'));
          if (!hasSavedMode && data.preferences.workMode === 'code') {
            setWorkMode('code');
          }
        }
        if (typeof data.preferences.sidebarVisible === 'boolean') {
          setSidebarVisible(data.preferences.sidebarVisible);
        }
        if (data.preferences.appearance) {
          const hasLocalTheme = Boolean(localStorage.getItem('bmone.theme'));
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
          const saved = localStorage.getItem('bmone.selectedWorkspaceId');
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

  // Handle global shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle browser/dock with Ctrl+Shift+B
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setRightDockVisible((v) => !v);
      }
      // Escape closes the topmost overlay
      if (e.key === 'Escape') {
        if (isNotificationsOpen) {
          setIsNotificationsOpen(false);
        } else if (isUsageModalOpen) {
          setIsUsageModalOpen(false);
        } else if (isWhatsNewOpen) {
          setIsWhatsNewOpen(false);
        } else if (isArchivedChatsOpen) {
          setIsArchivedChatsOpen(false);
        } else if (isSshModalOpen) {
          setIsSshModalOpen(false);
        } else if (settingsOpen) {
          setSettingsOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [settingsOpen, isNotificationsOpen, isUsageModalOpen, isWhatsNewOpen, isArchivedChatsOpen, isSshModalOpen]);

  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  }, []);

  useEffect(() => {
    const handleNavigate = (e: Event) => {
      const custom = e as CustomEvent<WorkMode>;
      if (custom.detail && ['agent', 'code', 'chat'].includes(custom.detail)) {
        setWorkMode(custom.detail);
        setSettingsOpen(false);
      }
    };
    const handleSelectWorkspace = (e: Event) => {
      const custom = e as CustomEvent<string>;
      if (custom.detail) {
        setSelectedWorkspaceId(custom.detail);
      }
    };
    window.addEventListener('kite:navigate-mode', handleNavigate);
    window.addEventListener('kite:select-workspace', handleSelectWorkspace);

    const handleOpenFilePreview = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };
    window.addEventListener('kite:open-right-dock-file', handleOpenFilePreview);

    const handleOpenBrowserInDock = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null; url?: string }>;
      setRightDockVisible(true);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };
    window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowserInDock);

    const handleSpawnAgentTerminal = (e: Event) => {
      const custom = e as CustomEvent<{ workspaceId?: string | null }>;
      setWorkMode('code');
      setSettingsOpen(false);
      setRoutinesOpen(false);
      if (custom.detail?.workspaceId) {
        setSelectedWorkspaceId(custom.detail.workspaceId);
      }
    };
    window.addEventListener('kite:spawn-agent-terminal', handleSpawnAgentTerminal);

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
            reason: `Modo inválido: ${targetMode}`,
          });
        }
      }
    };
    window.addEventListener('kite:op-request', handleOpRequest);

    return () => {
      window.removeEventListener('kite:navigate-mode', handleNavigate);
      window.removeEventListener('kite:select-workspace', handleSelectWorkspace);
      window.removeEventListener('kite:open-right-dock-file', handleOpenFilePreview);
      window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, handleOpenBrowserInDock);
      window.removeEventListener('kite:spawn-agent-terminal', handleSpawnAgentTerminal);
      window.removeEventListener('kite:op-request', handleOpRequest);
    };
  }, []);

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
  }, [loadBootstrap, selectedAgentId]);

  useEffect(() => {
    const handleThreadsChanged = () => {
      void loadThreads();
    };
    window.addEventListener('kite:threads-changed', handleThreadsChanged);
    return () => window.removeEventListener('kite:threads-changed', handleThreadsChanged);
  }, [loadThreads]);

  const handleNewChatInWorkspace = useCallback(
    async (targetWorkspaceId: string | null) => {
      // Find existing draft thread with no content for this workspace
      const existingDraft = threads.find(
        (t) =>
          (t.workspaceId ?? null) === (targetWorkspaceId ?? null) &&
          (!t.hasContent &&
            (t.status === 'idle' ||
              (t as any).status === 'draft' ||
              !t.title ||
              t.title.toLowerCase().includes('draft') ||
              t.title === 'New Chat'))
      );
      if (existingDraft) {
        setSelectedThreadId(existingDraft.id);
        setSelectedWorkspaceId(targetWorkspaceId);
        setWorkMode('chat');
        setSettingsOpen(false);
        setRoutinesOpen(false);
        return;
      }

      try {
        const created = await createGeneralChat('claude', targetWorkspaceId);
        if (created?.id) {
          await loadThreads();
          setSelectedThreadId(created.id);
          setSelectedWorkspaceId(targetWorkspaceId);
        }
      } catch (_) {}
      setWorkMode('chat');
      setSettingsOpen(false);
      setRoutinesOpen(false);
    },
    [threads, loadThreads]
  );

  const handleToggleAppearance = () => {
    const next = appearance === 'dark' ? 'light' : 'dark';
    const nextPalette = next === 'dark' ? 'kite-dark' : 'kite-light';
    applyTheme(next, nextPalette);
  };

  const handleToggleMode = (newMode: 'dark' | 'light') => {
    const nextPalette = newMode === 'dark' ? 'kite-dark' : 'kite-light';
    applyTheme(newMode, nextPalette);
  };

  const handleSelectTheme = (paletteId: string, themeMode?: 'dark' | 'light') => {
    const nextMode = themeMode ?? appearance;
    applyTheme(nextMode, paletteId);
  };

  const handleAddWorkspace = async () => {
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
  };

  const handleCopyPath = async (id: string) => {
    try {
      const path = await copyWorkspacePath(id);
      if (path) {
        await navigator.clipboard.writeText(path);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTogglePinWorkspace = async (id: string, pinned: boolean) => {
    try {
      await setWorkspacePinned(id, pinned);
      await loadBootstrap();
    } catch (e) {
      console.error(e);
    }
  };

  const renderActiveView = () => {
    if (!isTauriEnvironment()) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--pane)', padding: '32px', height: '100%' }}>
          <div style={{ maxWidth: '440px', width: '100%', background: 'var(--block-fill)', border: '1px solid var(--block-stroke)', borderRadius: 'var(--radius-card)', padding: '24px', boxShadow: 'var(--shadow-sheet)', textAlign: 'center' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--accent-tint)', border: '1px solid var(--accent-tint-strong)', color: 'var(--accent)', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="20" height="14" x="2" y="3" rx="2" />
                <line x1="8" x2="16" y1="21" y2="21" />
                <line x1="12" x2="12" y1="17" y2="21" />
              </svg>
            </div>
            <h3 style={{ fontSize: 'var(--text-body)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', marginBottom: '8px' }}>
              Kite Code Runs in Tauri Window
            </h3>
            <p style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)', lineHeight: 'var(--leading-body)', marginBottom: '16px' }}>
              This page is running in a standard web browser at http://localhost:1420. Native desktop capabilities (frameless window cromo, child WebView2, ConPTY terminal, and local SQLite IPC) require launching the desktop application.
            </p>
            <div style={{ background: 'var(--terminal-canvas, #0d1117)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-chip)', padding: '12px', fontSize: 'var(--text-mono)', fontFamily: 'var(--font-mono)', color: 'var(--accent)', userSelect: 'all', marginBottom: '16px', textAlign: 'left' }}>
              npm run tauri dev
            </div>
            <p style={{ fontSize: 'var(--text-meta)', color: 'var(--text-faint)', margin: 0 }}>
              Studio runs in the frameless desktop window. Close any lingering background instances first.
            </p>
          </div>
        </div>
      );
    }

    if (loading && workspaces.length === 0 && agents.length === 0) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--pane)', height: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <div className="loading-spinner" style={{ width: '24px', height: '24px', borderWidth: '2px' }} />
            <span style={{ fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' }}>Connecting to Kite Code...</span>
          </div>
        </div>
      );
    }

    if (error && workspaces.length === 0 && agents.length === 0) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--pane)', padding: '24px', height: '100%' }}>
          <div className="ui-status-notice ui-status-notice--warning">
            <h3 className="ui-status-notice__title">Backend Connection Issue</h3>
            <p className="ui-status-notice__message">{error}</p>
            <button onClick={loadBootstrap} className="primary-button" style={{ marginTop: '16px' }}>
              Retry Connection
            </button>
          </div>
        </div>
      );
    }

    if (settingsOpen) {
      return (
        <SettingsView
          onBack={() => setSettingsOpen(false)}
          onOpenWhatsNew={() => setIsWhatsNewOpen(true)}
          accountName={accountName}
          accountEmail={accountEmail || 'developer@kite.local'}
          accountTier={accountTier}
          accountTierPaid={accountTierPaid}
          creditsLabel={creditsLabel}
        />
      );
    }

    switch (workMode) {
      case 'agent':
        return (
          <AgentsView
            agents={agents}
            workspaceId={selectedWorkspaceId}
            selectedAgentId={selectedAgentId}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setAgentEditorOpen(false);
            }}
            agentEditorOpen={agentEditorOpen}
            onCloseAgentEditor={() => setAgentEditorOpen(false)}
            onAgentCreated={(agent) => {
              setAgents((prev) => (prev.some((a) => a.id === agent.id) ? prev : [...prev, agent]));
              setSelectedAgentId(agent.id);
              setAgentEditorOpen(false);
            }}
            onAgentUpdated={(updated) => {
              setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
            }}
            onAgentDeleted={(agentId) => {
              setAgents((prev) => {
                const remaining = prev.filter((a) => a.id !== agentId);
                if (selectedAgentId === agentId) {
                  setSelectedAgentId(remaining[0]?.id ?? null);
                }
                return remaining;
              });
            }}
            viewMode={agentViewMode}
            onViewModeChange={setAgentViewMode}
            onOpenRoutines={() => {
              setWorkMode('agent');
              setAgentViewMode('settings');
            }}
          />
        );
      case 'code':
        return (
          <CodeWorkspace
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={setSelectedWorkspaceId}
            onRefresh={loadBootstrap}
            onAddWorkspace={handleAddWorkspace}
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSessionsChange={handleCodeSessions}
            requestedTabId={requestedCodeTabId}
          />
        );
      case 'chat':
        return (
          <ChatView
            workspaceId={selectedWorkspaceId}
            threadId={selectedThreadId}
            agents={agents}
          />
        );
      default:
        return (
          <AgentsView
            agents={agents}
            workspaceId={selectedWorkspaceId}
            selectedAgentId={selectedAgentId}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setAgentEditorOpen(false);
            }}
            agentEditorOpen={agentEditorOpen}
            onCloseAgentEditor={() => setAgentEditorOpen(false)}
            onAgentCreated={(agent) => {
              setAgents((prev) => (prev.some((a) => a.id === agent.id) ? prev : [...prev, agent]));
              setSelectedAgentId(agent.id);
              setAgentEditorOpen(false);
            }}
            onAgentUpdated={(updated) => {
              setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
            }}
            onAgentDeleted={(agentId) => {
              setAgents((prev) => {
                const remaining = prev.filter((a) => a.id !== agentId);
                if (selectedAgentId === agentId) {
                  setSelectedAgentId(remaining[0]?.id ?? null);
                }
                return remaining;
              });
            }}
            viewMode={agentViewMode}
            onViewModeChange={setAgentViewMode}
            onOpenRoutines={() => {
              setWorkMode('agent');
              setAgentViewMode('settings');
            }}
          />
        );
    }
  };

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
          browserVisible={rightDockVisible}
          onToggleBrowser={() => setRightDockVisible((v) => !v)}
          operatorVisible={operatorOpen}
          onToggleOperator={toggleOperator}
          settingsOpen={settingsOpen}
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
          {!settingsOpen && (
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
              onAddWorkspace={handleAddWorkspace}
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
              onCopyWorkspacePath={handleCopyPath}
              onTogglePinWorkspace={handleTogglePinWorkspace}
              onTogglePinAgent={async (id, pinned) => {
                try {
                  const updated = await setAgentPinned(id, pinned);
                  setAgents(updated);
                } catch (e) {
                  console.error(e);
                }
              }}
              onMoveAgent={async (id, toIndex) => {
                try {
                  const updated = await moveAgent(id, toIndex);
                  setAgents(updated);
                } catch (e) {
                  console.error(e);
                }
              }}
              onDeleteAgent={async (id) => {
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
              }}
              onOpenAgentSettings={(id) => {
                setSelectedAgentId(id);
                setWorkMode('agent');
                setAgentEditorOpen(false);
                setAgentViewMode('settings');
                setSettingsOpen(false);
              }}
              onRenameWorkspace={async (id, newName) => {
                try {
                  const updated = await renameWorkspace(id, newName);
                  setWorkspaces(updated);
                } catch (e) {
                  console.error(e);
                }
              }}
              onRemoveWorkspaceFromList={async (id) => {
                try {
                  const updated = await removeWorkspace(id);
                  setWorkspaces(updated);
                  if (selectedWorkspaceId === id) {
                    setSelectedWorkspaceId(updated[0]?.id ?? null);
                  }
                } catch (e) {
                  console.error(e);
                }
              }}
              onMoveWorkspace={async (id, toIndex) => {
                try {
                  const updated = await moveWorkspace(id, toIndex);
                  setWorkspaces(updated);
                } catch (e) {
                  console.error(e);
                }
              }}
              onTogglePinThread={async (id, pinned) => {
                try {
                  await setChatThreadPinned(id, pinned);
                  await loadThreads();
                } catch (e) {
                  console.error(e);
                }
              }}
              onRenameThread={async (id, newTitle) => {
                try {
                  await renameChatThread(id, newTitle);
                  await loadThreads();
                } catch (e) {
                  console.error(e);
                }
              }}
              onDeleteThread={async (id) => {
                try {
                  await deleteChatThread(id);
                  await loadThreads();
                  if (selectedThreadId === id) {
                    setSelectedThreadId(null);
                  }
                } catch (e) {
                  console.error(e);
                }
              }}
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
              onCloseWorkspaceTab={(workspaceId, tabId) => {
                window.dispatchEvent(
                  new CustomEvent('kite:close-workspace-tab', {
                    detail: { workspaceId, tabId },
                  })
                );
              }}
              onRenameWorkspaceTab={(workspaceId, tabId, newTitle) => {
                window.dispatchEvent(
                  new CustomEvent('kite:rename-workspace-tab', {
                    detail: { workspaceId, tabId, newTitle },
                  })
                );
              }}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenArchivedChats={() => setIsArchivedChatsOpen(true)}
              onConnectSsh={() => setIsSshModalOpen(true)}
              appearance={appearance}
              onToggleAppearance={handleToggleAppearance}
            />
          )}

          {/* Center stage. Agent, Code, and Thread stay mounted so a terminal is hidden, not killed, when the mode changes. */}
          <main className="main-pane main-pane--stacked">
            {isTauriEnvironment() &&
            !(loading && workspaces.length === 0 && agents.length === 0) &&
            !(error && workspaces.length === 0 && agents.length === 0) ? (
              <>
                <div className={`mode-layer${workMode === 'agent' && !settingsOpen && !routinesOpen ? ' mode-layer--visible' : ''}`}>
                  <AgentsView
                    agents={agents}
                    workspaceId={selectedWorkspaceId}
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={(id) => {
                      setSelectedAgentId(id);
                      setAgentEditorOpen(false);
                    }}
                    agentEditorOpen={agentEditorOpen}
                    onCloseAgentEditor={() => setAgentEditorOpen(false)}
                    onAgentCreated={(agent) => {
                      setAgents((prev) => (prev.some((a) => a.id === agent.id) ? prev : [...prev, agent]));
                      setSelectedAgentId(agent.id);
                      setAgentEditorOpen(false);
                    }}
                    onAgentUpdated={(updated) => {
                      setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
                    }}
                    onAgentDeleted={(agentId) => {
                      setAgents((prev) => {
                        const remaining = prev.filter((a) => a.id !== agentId);
                        if (selectedAgentId === agentId) {
                          setSelectedAgentId(remaining[0]?.id ?? null);
                        }
                        return remaining;
                      });
                    }}
                    viewMode={agentViewMode}
                    onViewModeChange={setAgentViewMode}
                    onOpenRoutines={() => {
                      setRoutinesOpen(true);
                      setSettingsOpen(false);
                    }}
                  />
                </div>
                <div className={`mode-layer${workMode === 'code' && !settingsOpen && !routinesOpen ? ' mode-layer--visible' : ''}`}>
                  <CodeWorkspace
                    workspaces={workspaces}
                    selectedWorkspaceId={selectedWorkspaceId}
                    onSelectWorkspace={setSelectedWorkspaceId}
                    onRefresh={loadBootstrap}
                    onAddWorkspace={handleAddWorkspace}
                    agents={agents}
                    selectedAgentId={selectedAgentId}
                    onSessionsChange={handleCodeSessions}
                    requestedTabId={requestedCodeTabId}
                    newSessionRequest={newSessionRequest}
                  />
                </div>
                <div className={`mode-layer${workMode === 'chat' && !settingsOpen && !routinesOpen ? ' mode-layer--visible' : ''}`}>
                  {hasOpenedChat && (
                    <ChatView
                      workspaceId={selectedWorkspaceId}
                      threadId={selectedThreadId}
                      agents={agents}
                      workspaces={workspaces}
                      onThreadsChanged={loadThreads}
                    />
                  )}
                </div>
                {routinesOpen && (
                  <div className="mode-layer mode-layer--visible">
                    <div className="main-pane__surface">
                      <RoutinesView
                        workspaceId={selectedWorkspaceId}
                        onOpenThread={(agentId, _threadId) => {
                          setRoutinesOpen(false);
                          setSelectedAgentId(agentId);
                          setWorkMode('agent');
                          setAgentViewMode('chats');
                        }}
                      />
                    </div>
                  </div>
                )}
                {settingsOpen && (
                  <div className="mode-layer mode-layer--visible">
                    <SettingsView
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
                  </div>
                )}
              </>
            ) : (
              <div className="mode-layer mode-layer--visible">
                <div className="main-pane__surface">{renderActiveView()}</div>
              </div>
            )}
          </main>

          {/* Authentic Right Tools & Browser Dock */}
          <ErrorBoundary name="RightDock">
            <RightDock
              visible={rightDockVisible}
              onClose={() => setRightDockVisible(false)}
              workspaceId={selectedWorkspaceId}
              isOccluded={
                isUsageModalOpen ||
                isWhatsNewOpen ||
                isArchivedChatsOpen ||
                isSshModalOpen ||
                isNotificationsOpen ||
                settingsOpen
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

        {/* Auxiliary Dialogs */}
        <UsageDashboardModal
          isOpen={isUsageModalOpen}
          onClose={() => setIsUsageModalOpen(false)}
        />
        <WhatsNewModal
          isOpen={isWhatsNewOpen}
          onClose={() => setIsWhatsNewOpen(false)}
        />
        <ArchivedChatsModal
          isOpen={isArchivedChatsOpen}
          onClose={() => setIsArchivedChatsOpen(false)}
          profileId={workMode === 'agent' ? selectedAgentId : null}
          onRestored={() => setWorkMode('chat')}
        />
        <SshWorkspaceModal
          isOpen={isSshModalOpen}
          onClose={() => setIsSshModalOpen(false)}
          onConnect={(ws) => {
            setIsSshModalOpen(false);
            void loadBootstrap();
            setSelectedWorkspaceId(ws.id);
            setWorkMode('code');
          }}
        />

        {/* Notifications Popover. Render only while open */}
        <AnimatePresence>
          {isNotificationsOpen && (
            <motion.div
              className="notification-popover-overlay"
              {...surfaceMotion('scrim')}
              onClick={() => {
              setIsNotificationsOpen(false);
              setNotificationsAnchor(null);
            }}
          >
            {(() => {
              const popoverWidth = 320;
              const margin = 10;
              let top = '38px';
              let right = '12px';
              let arrowRight = 24;

              if (notificationsAnchor) {
                // Snug 2px offset under the bell button: caret tip sits directly against button bottom
                top = `${Math.round(notificationsAnchor.bottom + 2)}px`;
                const bellCenter = notificationsAnchor.left + notificationsAnchor.width / 2;
                // Target arrow at ~24px from popover right edge (half-width of 10px arrow = 5px, so center is at 29px)
                const targetPopoverRight = window.innerWidth - bellCenter - 29;
                const clampedPopoverRight = Math.max(
                  margin,
                  Math.min(window.innerWidth - popoverWidth - margin, targetPopoverRight)
                );
                right = `${Math.round(clampedPopoverRight)}px`;

                const cardRightEdge = window.innerWidth - clampedPopoverRight;
                const calculatedArrowRight = cardRightEdge - bellCenter - 5;
                arrowRight = Math.max(16, Math.min(popoverWidth - 26, Math.round(calculatedArrowRight)));
              }

              return (
                <motion.div
                  {...surfaceMotion('popover')}
                  className="notification-popover-anchor"
                  style={{
                    top,
                    right,
                    ['--arrow-right' as any]: `${arrowRight}px`,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <NotificationsView
                    externalSnapshot={notifSnapshot}
                    onClose={() => {
                      setIsNotificationsOpen(false);
                      setNotificationsAnchor(null);
                    }}
                    onNavigateAgent={(id) => {
                      setSelectedAgentId(id);
                      setWorkMode('agent');
                      setIsNotificationsOpen(false);
                      setNotificationsAnchor(null);
                    }}
                    onNavigateThread={(threadId, agentId) => {
                      if (agentId) {
                        setSelectedAgentId(agentId);
                        setWorkMode('agent');
                      } else {
                        setWorkMode('code');
                      }
                      setSelectedThreadId(threadId);
                      setIsNotificationsOpen(false);
                      setNotificationsAnchor(null);
                    }}
                    onNavigateMode={(m) => {
                      setWorkMode(m);
                      setIsNotificationsOpen(false);
                      setNotificationsAnchor(null);
                    }}
                    onOpenSettings={() => {
                      setIsNotificationsOpen(false);
                      setNotificationsAnchor(null);
                      setSettingsOpen(true);
                      try {
                        localStorage.setItem('bmone.settingsTab', 'notifications');
                      } catch (_) {}
                    }}
                  />
                </motion.div>
              );
            })()}
            </motion.div>
          )}
        </AnimatePresence>

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

        {/* Visual Spark Projectile Overlay for Dispatched Prompts */}
        <PromptProjectileOverlay />

        {/* Startup Agent Recovery Sheet */}
        <ResumeHost />

        <AppIntro open={!introDismissed} />

        {/* Ambient Sileo Toast System */}
        <Toaster position="bottom-right" theme="dark" offset={{ bottom: 24, right: 24 }} />
      </div>
    </div>
  );
};
