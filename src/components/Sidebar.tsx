import React, { useState, useEffect, useRef } from 'react';
import type { AgentProfile } from '../types';

export type {
  WorkMode,
  ChatThreadSummary,
  WorkspaceSessionTab,
  SidebarProps,
  MenuItem,
  MenuHeader,
  ContextMenuState,
} from './sidebar/types';
import {
  type SidebarProps,
  type ContextMenuState,
  type MenuItem,
} from './sidebar/types';
import { SidebarFooter, SidebarContextMenu } from './sidebar/SidebarFooter';
import { WorkspaceRoster } from './sidebar/WorkspaceRoster';
import { AgentRoster } from './sidebar/AgentRoster';
import { ThreadRoster } from './sidebar/ThreadRoster';
import {
  PlusIcon,
  FolderOpenIcon,
  NetworkIcon,
} from './sidebar/sidebarIcons';
import { invokeCommand } from '../lib/ipc';
import { AnimatePresence, motion } from 'motion/react';
import { MOTION_EXIT_MS } from '../motion/contract';
import { surfaceMotion } from '../motion/standard/surfaces';

// ---------------------------------------------------------------------------
// Main Sidebar Component
// ---------------------------------------------------------------------------

export type ThreadSidebarCallbacks = {
  onRegenerateTitle?: (threadId: string) => void;
  titlePending?: boolean;
  onRestoreThread?: (threadId: string) => void;
  onArchiveThread?: (threadId: string) => void;
  archivedCount?: number;
  onOpenRoutines?: () => void;
};

const RoutinesClockIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const SidebarInner: React.FC<
  SidebarProps & ThreadSidebarCallbacks & { routinesOpen?: boolean }
> = ({
  hidden = false,
  onRailPresenceChange,
  mode,
  workspaces,
  agents,
  threads = [],
  selectedWorkspaceId,
  onSelectWorkspace,
  selectedAgentId,
  onSelectAgent,
  selectedThreadId,
  onSelectThread,
  onNewAgent,
  onAddWorkspace,
  onNewChat,
  onNewChatInWorkspace,
  onNewAgentChat,
  onCopyWorkspacePath,
  onTogglePinWorkspace,
  onTogglePinAgent,
  onTogglePinThread,
  onOpenSettings,
  appearance,
  onToggleAppearance,
  accountName = '',
  accountTier = '',
  accountTierPaid = false,
  creditsLabel = '',
  onShowModeHome,
  onConnectSsh,
  onRenameWorkspace,
  onRemoveWorkspaceFromList,
  onNewWorkspaceSession,
  onSelectWorkspaceTab,
  onCloseWorkspaceTab,
  onRenameWorkspaceTab,
  workspaceSessions,
  onDeleteAgent,
  onOpenAgentSettings,
  onInstallAgent,
  agentActivity = {},
  availability,
  onOpenArchivedChats,
  archivedCount,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
  onMoveWorkspace,
  onMoveAgent,
  onRegenerateTitle,
  titlePending = false,
  onRestoreThread,
  onOpenRoutines,
  routinesOpen = false,
}) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [createdAgents, setCreatedAgents] = useState<AgentProfile[]>([]);
  const [probedAvailability, setProbedAvailability] = useState<SidebarProps['availability']>();
  const [railActivity, setRailActivity] = useState<NonNullable<SidebarProps['agentActivity']>>({});
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [railMounted, setRailMounted] = useState(!hidden);

  useEffect(() => {
    if (!hidden) setRailMounted(true);
  }, [hidden]);

  useEffect(() => {
    onRailPresenceChange?.(railMounted);
  }, [railMounted, onRailPresenceChange]);

  // Listen for agent creation events
  useEffect(() => {
    const onCreated = (event: Event) => {
      const agent = (event as CustomEvent<AgentProfile>).detail;
      if (!agent?.id) return;
      setCreatedAgents((current) =>
        current.some((item) => item.id === agent.id) ? current : [...current, agent]
      );
      onSelectAgent(agent.id);
    };
    window.addEventListener('studio-agent-created', onCreated);
    return () => window.removeEventListener('studio-agent-created', onCreated);
  }, [onSelectAgent]);

  const availabilityProbedRef = useRef(false);

  // Probe agent engine availability once per session instead of re-probing on every mode switch
  useEffect(() => {
    if (mode !== 'agent' || availabilityProbedRef.current) return;
    let cancelled = false;

    const apply = (
      payload: {
        hasProbed?: boolean;
        phase?: string;
        teammates?: Array<{ engine?: string; installed?: boolean }>;
      } | null
    ) => {
      if (!payload?.teammates) return;
      const next: NonNullable<SidebarProps['availability']> = {
        hasProbed: payload.hasProbed ?? payload.phase === 'ready',
      };
      for (const teammate of payload.teammates) {
        if (teammate.engine) next[teammate.engine] = teammate.installed === true;
      }
      setProbedAvailability(next);
    };

    const loadAvailability = async () => {
      let cachedProbed = false;
      try {
        const cached = await invokeCommand<{
          hasProbed?: boolean;
          phase?: string;
          teammates?: Array<{ engine?: string; installed?: boolean }>;
        }>('get_agent_availability', {
          supportedSchemaVersion: 1,
        });
        if (!cancelled) {
          apply(cached);
          cachedProbed = Boolean(cached?.hasProbed ?? cached?.phase === 'ready');
          if (cachedProbed) {
            availabilityProbedRef.current = true;
          }
        }
      } catch (err) {
        console.warn('[Sidebar] get_agent_availability notice:', err);
      }
      if (cancelled || availabilityProbedRef.current) return;
      try {
        const probed = await invokeCommand<{
          hasProbed?: boolean;
          phase?: string;
          teammates?: Array<{ engine?: string; installed?: boolean }>;
        }>('probe_agent_availability', {
          supportedSchemaVersion: 1,
          force: false,
        });
        if (!cancelled) {
          apply(probed);
          availabilityProbedRef.current = true;
        }
      } catch (err) {
        console.warn('[Sidebar] probe_agent_availability notice:', err);
      }
    };

    void loadAvailability();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Poll agent rail activity only when Sidebar is visible and document is visible
  useEffect(() => {
    if (mode !== 'agent' || hidden) return;
    let cancelled = false;
    let timer: number | null = null;

    const isPageVisible = () =>
      typeof document === 'undefined' ||
      (!document.hidden && document.visibilityState === 'visible');

    let wasVisible = isPageVisible();

    const loadActivity = async () => {
      if (cancelled || !isPageVisible()) return;
      try {
        const rows = await invokeCommand<
          Array<{
            agentId?: string;
            runningCount?: number;
            needsYou?: boolean;
            atUnixMs?: number | null;
            line?: string | null;
          }>
        >('list_agent_rail_activity', {
          supportedSchemaVersion: 1,
        });
        if (cancelled || !Array.isArray(rows)) return;
        const next: NonNullable<SidebarProps['agentActivity']> = {};
        for (const row of rows) {
          if (!row.agentId) continue;
          next[row.agentId] = {
            runningCount: row.runningCount ?? 0,
            needsYou: row.needsYou ?? false,
            atUnixMs: row.atUnixMs ?? undefined,
            line: row.line ?? undefined,
          };
        }
        setRailActivity(next);
      } catch (err) {
        console.warn('[Sidebar] list_agent_rail_activity notice:', err);
      }
    };

    const stopPolling = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const startPolling = () => {
      if (cancelled || timer !== null || !isPageVisible()) return;
      timer = window.setInterval(() => {
        if (!cancelled && isPageVisible()) {
          void loadActivity();
        }
      }, 4000);
    };

    const handleVisibilityChange = () => {
      const visibleNow = isPageVisible();
      if (visibleNow) {
        if (!wasVisible) {
          void loadActivity();
        }
        wasVisible = true;
        startPolling();
      } else {
        wasVisible = false;
        stopPolling();
      }
    };

    if (wasVisible) {
      void loadActivity();
      startPolling();
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      cancelled = true;
      stopPolling();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [mode, hidden]);

  // Global listener to close context menu
  useEffect(() => {
    if (!contextMenu && !addMenuOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.ui-menu')) return;
      setContextMenu(null);
      setAddMenuOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setAddMenuOpen(false);
      }
    };

    const handleCloseMenu = () => {
      setContextMenu(null);
      setAddMenuOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleCloseMenu);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleCloseMenu);
    };
  }, [contextMenu, addMenuOpen]);

  const headingTitle = mode === 'agent' ? 'Agents' : mode === 'code' ? 'Workspaces' : 'Threads';
  const addTitle = mode === 'agent' ? 'New agent' : mode === 'code' ? 'Add workspace' : 'New thread';

  const openNewAgent = () => {
    window.dispatchEvent(new CustomEvent('studio-new-agent'));
    onNewAgent();
  };

  const handleAddClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (mode === 'agent') {
      openNewAgent();
    } else if (mode === 'chat') {
      onNewChat();
    } else if (mode === 'code') {
      // Toggle menu for Local Folder, SSH
      const rect = e.currentTarget.getBoundingClientRect();
      setContextMenu({
        x: rect.left,
        y: rect.bottom + 4,
        sections: [
          [
            {
              id: 'local',
              title: 'Local Folder…',
              icon: <FolderOpenIcon size={14} />,
              action: () => {
                setContextMenu(null);
                setAddMenuOpen(false);
                onAddWorkspace();
              },
            },
            onConnectSsh
              ? {
                  id: 'ssh',
                  title: 'Connect via SSH…',
                  icon: <NetworkIcon size={14} />,
                  action: () => {
                    setContextMenu(null);
                    setAddMenuOpen(false);
                    onConnectSsh();
                  },
                }
              : null,
          ].filter(Boolean) as MenuItem[],
        ],
      });
      setAddMenuOpen(true);
    } else {
      onNewChat();
    }
  };

  return (
    <AnimatePresence onExitComplete={() => setRailMounted(false)}>
      {!hidden && (
        <motion.aside
          key="sidebar"
          {...surfaceMotion('panel-left', { exitMs: MOTION_EXIT_MS })}
          className="sidebar"
          data-testid="sidebar"
          style={{ width: 'var(--sidebar-width, 232px)' }}
        >
          {/* Primary Rail Section */}
          <section aria-labelledby="rail-heading" className="sidebar__primary">
            <div className="sidebar__section-heading">
              <button className="sidebar__heading-button" onClick={onShowModeHome} type="button">
                <span id="rail-heading">{headingTitle}</span>
              </button>
              {mode === 'agent' && (
                <button
                  type="button"
                  className={`sidebar__routines-button${routinesOpen ? ' sidebar__routines-button--active' : ''}`}
                  aria-pressed={routinesOpen}
                  onClick={() => {
                    if (onOpenRoutines) {
                      onOpenRoutines();
                    } else {
                      window.dispatchEvent(
                        new CustomEvent('kite:op-request', {
                          detail: {
                            reqId: 'sidebar-routines',
                            kind: 'navigate-view',
                            payload: { view: 'routines' },
                          },
                        })
                      );
                    }
                  }}
                  aria-label="Routines"
                  title={routinesOpen ? 'Back to Agents' : 'Open Routines'}
                >
                  <RoutinesClockIcon size={12} />
                  <span>Routines</span>
                </button>
              )}
              <button
                ref={addBtnRef}
                aria-label={addTitle}
                className="sidebar__add"
                onClick={handleAddClick}
                title={addTitle}
                type="button"
              >
                <PlusIcon size={13} strokeWidth={2.4} />
              </button>
            </div>

            <div className="sidebar__list">
              {/* ======================= AGENT MODE ======================= */}
              {mode === 'agent' && (
                <AgentRoster
                  agents={agents}
                  createdAgents={createdAgents}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={onSelectAgent}
                  onNewAgent={openNewAgent}
                  onNewAgentChat={onNewAgentChat}
                  onTogglePinAgent={onTogglePinAgent}
                  onMoveAgent={onMoveAgent}
                  onDeleteAgent={onDeleteAgent}
                  onOpenAgentSettings={onOpenAgentSettings}
                  onInstallAgent={onInstallAgent}
                  availability={availability}
                  probedAvailability={probedAvailability}
                  agentActivity={agentActivity}
                  railActivity={railActivity}
                  onOpenMenu={setContextMenu}
                  contextMenuTargetId={contextMenu?.targetId}
                  onUpdateAvailability={setProbedAvailability}
                />
              )}

              {/* ======================= CODE MODE ======================= */}
              {mode === 'code' && (
                <WorkspaceRoster
                  workspaces={workspaces}
                  selectedWorkspaceId={selectedWorkspaceId}
                  onSelectWorkspace={onSelectWorkspace}
                  onCopyWorkspacePath={onCopyWorkspacePath}
                  onTogglePinWorkspace={onTogglePinWorkspace}
                  onRenameWorkspace={onRenameWorkspace}
                  onRemoveWorkspaceFromList={onRemoveWorkspaceFromList}
                  onMoveWorkspace={onMoveWorkspace}
                  onNewWorkspaceSession={onNewWorkspaceSession}
                  onSelectWorkspaceTab={onSelectWorkspaceTab}
                  onCloseWorkspaceTab={onCloseWorkspaceTab}
                  onRenameWorkspaceTab={onRenameWorkspaceTab}
                  workspaceSessions={workspaceSessions}
                />
              )}

              {/* ======================= CHAT MODE ======================= */}
              {mode === 'chat' && (
                <ThreadRoster
                  threads={threads}
                  workspaces={workspaces}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={onSelectThread}
                  onNewChat={onNewChat}
                  onNewChatInWorkspace={onNewChatInWorkspace}
                  onAddWorkspace={onAddWorkspace}
                  onTogglePinThread={onTogglePinThread}
                  onRenameThread={onRenameThread}
                  onArchiveThread={onArchiveThread}
                  onDeleteThread={onDeleteThread}
                  onRestoreThread={onRestoreThread}
                  onRegenerateTitle={onRegenerateTitle}
                  titlePending={titlePending}
                  onOpenArchivedChats={onOpenArchivedChats}
                  archivedCount={archivedCount}
                  onOpenMenu={setContextMenu}
                  contextMenuTargetId={contextMenu?.targetId}
                />
              )}
            </div>
          </section>

          {/* Authentic Sidebar Footer */}
          <SidebarFooter
            accountName={accountName}
            accountTier={accountTier}
            accountTierPaid={accountTierPaid}
            creditsLabel={creditsLabel}
            appearance={appearance}
            onToggleAppearance={onToggleAppearance}
            onOpenSettings={onOpenSettings}
          />

          {/* Context Menu / Add Popup Menu Overlay */}
          <SidebarContextMenu
            contextMenu={contextMenu}
            onClose={() => {
              setContextMenu(null);
              setAddMenuOpen(false);
            }}
          />
        </motion.aside>
      )}
    </AnimatePresence>
  );
};

export const Sidebar = React.memo(SidebarInner);
