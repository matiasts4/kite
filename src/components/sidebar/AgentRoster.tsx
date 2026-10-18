import React from 'react';
import { AgentAvatar } from '../AgentAvatar';
import { invokeCommand } from '../../lib/ipc';
import type { AgentProfile } from '../../types';
import type { MenuItem, ContextMenuState, SidebarProps } from './types';
import {
  engineDisplayNames,
  formatAgentPurpose,
  formatRelativeTime,
} from './types';
import {
  PlusIcon,
  PinIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  DownloadIcon,
  MessageSquareIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from './sidebarIcons';

export interface AgentRosterProps {
  agents: AgentProfile[];
  createdAgents?: AgentProfile[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onNewAgent: () => void;
  onNewAgentChat?: (agentId: string) => void;
  onOpenAgentSettings?: (agentId: string) => void;
  onTogglePinAgent?: (id: string, pinned: boolean) => void;
  onMoveAgent?: (id: string, toIndex: number) => void;
  onDeleteAgent?: (id: string) => void;
  onInstallAgent?: (engine: string) => void;
  agentActivity?: Record<string, { runningCount?: number; needsYou?: boolean; atUnixMs?: number; line?: string }>;
  railActivity?: NonNullable<SidebarProps['agentActivity']>;
  availability?: { hasProbed?: boolean } & Record<string, boolean>;
  probedAvailability?: SidebarProps['availability'];
  onOpenMenu?: (menu: ContextMenuState) => void;
  onOpenContextMenu?: (menu: ContextMenuState) => void;
  contextMenuTargetId?: string | null;
  activeContextMenuTargetId?: string | null;
  onUpdateAvailability?: (availability: SidebarProps['availability']) => void;
}

export const AgentRoster: React.FC<AgentRosterProps> = ({
  agents,
  createdAgents = [],
  selectedAgentId,
  onSelectAgent,
  onNewAgent,
  onNewAgentChat,
  onOpenAgentSettings,
  onTogglePinAgent,
  onMoveAgent,
  onDeleteAgent,
  onInstallAgent,
  agentActivity = {},
  railActivity = {},
  availability,
  probedAvailability,
  onOpenMenu,
  onOpenContextMenu,
  contextMenuTargetId,
  activeContextMenuTargetId,
  onUpdateAvailability,
}) => {
  const openMenu = onOpenMenu ?? onOpenContextMenu;
  const menuTargetId = contextMenuTargetId ?? activeContextMenuTargetId;

  const shownAvailability = probedAvailability ?? availability;
  const shownActivity = { ...agentActivity, ...railActivity };

  const allAgents = (() => {
    const ids = new Set(agents.map((a) => a.id));
    const extra = createdAgents.filter((a) => !ids.has(a.id));
    return [...agents, ...extra];
  })();

  const pinnedAgents = allAgents.filter((a) => a.pinned);
  const unpinnedAgents = allAgents.filter((a) => !a.pinned);

  const handleInstallEngine = async (engine: string) => {
    if (onInstallAgent) {
      onInstallAgent(engine);
      return;
    }
    try {
      await invokeCommand('request_agent_install', { supportedSchemaVersion: 1, engine });
      if (onUpdateAvailability && shownAvailability) {
        onUpdateAvailability({ ...shownAvailability, [engine]: true });
      }
    } catch (err) {
      console.warn('[AgentRoster] request_agent_install notice:', err);
    }
  };

  const handleOpenAgentMenu = (
    agent: AgentProfile,
    e: React.MouseEvent,
    isPinnedGroup: boolean,
    indexInGroup: number
  ) => {
    e.preventDefault();
    e.stopPropagation();

    if (!openMenu) return;

    const isProbed = shownAvailability?.hasProbed ?? true;
    const isInstalled = isProbed ? (shownAvailability ? shownAvailability[agent.engine] ?? true : true) : true;
    const group = isPinnedGroup ? pinnedAgents : unpinnedAgents;

    const sections: MenuItem[][] = [
      [
        !isInstalled
          ? {
              id: 'install',
              title: `Install ${engineDisplayNames[agent.engine] || agent.engine}…`,
              icon: <DownloadIcon size={12} />,
              action: () => void handleInstallEngine(agent.engine),
            }
          : null,
        isInstalled && onNewAgentChat
          ? {
              id: 'chat',
              title: 'New Chat',
              icon: <MessageSquareIcon size={13} />,
              action: () => onNewAgentChat(agent.id),
            }
          : null,
        onOpenAgentSettings
          ? {
              id: 'settings',
              title: 'Agent Settings…',
              icon: <SlidersHorizontalIcon size={13} />,
              action: () => onOpenAgentSettings(agent.id),
            }
          : null,
      ].filter(Boolean) as MenuItem[],
      [
        onTogglePinAgent
          ? {
              id: 'pin-agent',
              title: agent.pinned ? 'Unpin Agent' : 'Pin Agent',
              icon: <PinIcon size={12} filled={agent.pinned} />,
              action: () => onTogglePinAgent(agent.id, !agent.pinned),
            }
          : null,
        onMoveAgent
          ? {
              id: 'move-agent-up',
              title: agent.pinned ? 'Move Left' : 'Move Up',
              icon: <ArrowUpIcon size={12} />,
              disabled: indexInGroup <= 0,
              action: () => onMoveAgent(agent.id, indexInGroup - 1),
            }
          : null,
        onMoveAgent
          ? {
              id: 'move-agent-down',
              title: agent.pinned ? 'Move Right' : 'Move Down',
              icon: <ArrowDownIcon size={12} />,
              disabled: indexInGroup >= group.length - 1,
              action: () => onMoveAgent(agent.id, indexInGroup + 1),
            }
          : null,
      ].filter(Boolean) as MenuItem[],
      [
        onDeleteAgent
          ? {
              id: 'delete',
              title: 'Delete Agent…',
              role: 'destructive',
              icon: <TrashIcon size={13} />,
              action: () => onDeleteAgent(agent.id),
            }
          : null,
      ].filter(Boolean) as MenuItem[],
    ].filter((sec) => sec.length > 0);

    openMenu({
      x: e.clientX,
      y: e.clientY,
      targetId: agent.id,
      header: {
        title: agent.name,
        subtitle: !isInstalled
          ? `${engineDisplayNames[agent.engine] || agent.engine} — not installed`
          : `Powered by ${engineDisplayNames[agent.engine] || agent.engine}`,
      },
      sections,
    });
  };

  if (allAgents.length === 0) {
    return (
      <div className="sidebar-empty sidebar-empty--agent">
        <p>No agents yet. Name one, say what it’s for, and hand it work.</p>
        <button className="sidebar-empty__primary" onClick={onNewAgent} type="button">
          <PlusIcon size={12} strokeWidth={2.5} />
          New Agent
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Pinned Agents Section */}
      {pinnedAgents.length > 0 && (
        <section aria-label="Pinned agents">
          <h3 className="chat-rail__band-title">Pinned</h3>
          <div>
            {pinnedAgents.map((agent, idx) => {
              const isSelected = selectedAgentId === agent.id;
              const isProbed = shownAvailability?.hasProbed ?? true;
              const isInstalled = isProbed ? (shownAvailability ? shownAvailability[agent.engine] ?? true : true) : true;
              const act = shownActivity[agent.id];
              const runningCount = act?.runningCount ?? 0;
              const needsYou = runningCount === 0 && (act?.needsYou ?? false);
              const relativeTime =
                runningCount === 0 && !needsYou && act?.atUnixMs != null
                  ? formatRelativeTime(act.atUnixMs)
                  : null;
              const purposeText = formatAgentPurpose(agent, act, isInstalled);

              return (
                <div
                  key={agent.id}
                  className={`entity-row entity-row--agent${
                    isSelected ? ' entity-row--selected' : ''
                  }${!isInstalled ? ' entity-row--runtime-unavailable' : ''}${
                    menuTargetId === agent.id ? ' entity-row--menu-open' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="entity-row__select"
                    onClick={() => onSelectAgent(agent.id)}
                    onContextMenu={(e) => handleOpenAgentMenu(agent, e, true, idx)}
                    title={`${agent.name} (Pinned) · Powered by ${engineDisplayNames[agent.engine] || agent.engine}`}
                  >
                    <AgentAvatar
                      id={agent.id}
                      choice={agent.avatar}
                      size={30}
                      state={runningCount > 0 ? 'running' : needsYou ? 'needsYou' : 'idle'}
                    />
                    <span className="entity-row__copy">
                      <span className="entity-row__line">
                        <strong>{agent.name}</strong>
                        {runningCount > 0 ? (
                          <span className="entity-row__count">{runningCount}</span>
                        ) : needsYou ? (
                          <span className="entity-row__needs-you">
                            <i aria-hidden="true" />
                            Needs you
                          </span>
                        ) : relativeTime ? (
                          <time className="entity-row__stamp">{relativeTime}</time>
                        ) : null}
                      </span>
                      <small>{purposeText}</small>
                    </span>
                  </button>

                  {onNewAgentChat ? (
                    <button
                      aria-label={`New chat with ${agent.name}`}
                      className="entity-row__add"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewAgentChat(agent.id);
                      }}
                      title={`New chat with ${agent.name}`}
                      type="button"
                    >
                      <PlusIcon size={9} strokeWidth={3} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="sidebar__rule" />
        </section>
      )}

      {/* Roster of Agents (Unpinned) */}
      <section aria-label="Agents">
        <div>
          {unpinnedAgents.map((agent, idx) => {
            const isSelected = selectedAgentId === agent.id;
            const isProbed = shownAvailability?.hasProbed ?? true;
            const isInstalled = isProbed ? (shownAvailability ? shownAvailability[agent.engine] ?? true : true) : true;
            const act = shownActivity[agent.id];
            const runningCount = act?.runningCount ?? 0;
            const needsYou = runningCount === 0 && (act?.needsYou ?? false);
            const relativeTime =
              runningCount === 0 && !needsYou && act?.atUnixMs != null
                ? formatRelativeTime(act.atUnixMs)
                : null;
            const purposeText = formatAgentPurpose(agent, act, isInstalled);

            return (
              <div
                key={agent.id}
                className={`entity-row entity-row--agent${
                  isSelected ? ' entity-row--selected' : ''
                }${!isInstalled ? ' entity-row--runtime-unavailable' : ''}${
                  menuTargetId === agent.id ? ' entity-row--menu-open' : ''
                }`}
              >
                <button
                  className="entity-row__select"
                  type="button"
                  onClick={() => onSelectAgent(agent.id)}
                  onContextMenu={(e) => handleOpenAgentMenu(agent, e, false, idx)}
                  title={
                    !isInstalled
                      ? `${engineDisplayNames[agent.engine] || agent.engine} — not installed`
                      : `Powered by ${engineDisplayNames[agent.engine] || agent.engine}`
                  }
                >
                  <AgentAvatar
                    id={agent.id}
                    choice={agent.avatar}
                    size={30}
                    state={runningCount > 0 ? 'running' : needsYou ? 'needsYou' : 'idle'}
                  />
                  <span className="entity-row__copy">
                    <span className="entity-row__line">
                      <strong>{agent.name}</strong>
                      {runningCount > 0 ? (
                        <span className="entity-row__count">{runningCount}</span>
                      ) : needsYou ? (
                        <span className="entity-row__needs-you">
                          <i aria-hidden="true" />
                          Needs you
                        </span>
                      ) : relativeTime ? (
                        <time className="entity-row__stamp">{relativeTime}</time>
                      ) : null}
                    </span>
                    <small>{purposeText}</small>
                  </span>
                </button>

                {onNewAgentChat ? (
                  <button
                    aria-label={`New chat with ${agent.name}`}
                    className="entity-row__add"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewAgentChat(agent.id);
                    }}
                    title={`New chat with ${agent.name}`}
                    type="button"
                  >
                    <PlusIcon size={9} strokeWidth={3} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
};

export default AgentRoster;
