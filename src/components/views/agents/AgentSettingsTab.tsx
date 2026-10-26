import React, { useState, useEffect } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import type { AgentProfile } from '../../../types';
import type { AvatarChoice } from '../../AgentAvatar';
import { AgentAvatarCustomizer } from './AgentAvatarCustomizer';
import { SelectMenu } from '../../ui/SelectMenu';
import { EffortPicker } from '../chat/EffortPicker';
import {
  BrandLogo,
  TEAMMATE_ENGINE_IDS,
  getEngineDisplayName,
  getEngineVendor,
  supportsAgentChat,
} from './engineMetadata';
import { AUTOMATIC_MODEL_ID, engineToChatProvider, type ModelOption } from '../chat/types';
import { usePluginConnections } from '../plugins/usePluginConnections';
import { OFFICIAL_PLUGINS } from '../plugins/catalog';

// SVG Icons (Zero Lucide & Zero emojis)
const CheckIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const PuzzleIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M19.439 7.85c0-1.57.802-2.5 1.561-2.5s1.561.93 1.561 2.5h1.439v-3.85a2 2 0 0 0-2-2h-3.85c0 .759-.93 1.561-2.5 1.561s-2.5-.802-2.5-1.561h-3.65a2 2 0 0 0-2 2v3.85c.759 0 1.561.93 1.561 2.5s-.802 2.5-1.561 2.5v3.65a2 2 0 0 0 2 2h3.85c0-.759.93-1.561 2.5-1.561s2.5.802 2.5 1.561h3.65a2 2 0 0 0 2-2v-3.85c-.759 0-1.561-.93-1.561-2.5z" />
  </svg>
);

const ClockIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const TrashIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

// Official Engine Catalog (kept exported for compatibility)
export interface EngineMetaItem {
  id: string;
  name: string;
  provider: string;
  logo: string | null;
}

export const OFFICIAL_ENGINES: EngineMetaItem[] = TEAMMATE_ENGINE_IDS.map((id) => ({
  id,
  name: getEngineDisplayName(id),
  provider: getEngineVendor(id) || '',
  logo: null,
}));

const NOTES_CAPS = [2200, 3500, 6000, 12000];

function formatCap(n: number): string {
  return n >= 1000 ? `${n / 1000}k` : String(n);
}

export interface AgentSettingsDraft {
  name: string;
  purpose: string;
  engine: string;
  memoryBudget: number;
  reflectionMode: string;
  allowAgentScheduling: boolean;
  allowAgentMessaging: boolean;
  defaultMode?: string | null;
  defaultPlan?: boolean;
  defaultModel?: string | null;
  placeDisplayNames?: string[];
  avatar?: AvatarChoice | string | null;
  [key: string]: any;
}

export interface AgentSettingsTabProps {
  settingsDraft: AgentSettingsDraft;
  setSettingsDraft: React.Dispatch<React.SetStateAction<any>>;
  settingsDirty: boolean;
  setSettingsDirty: (dirty: boolean) => void;
  onSaveSettings: () => Promise<void>;
  onRevertSettings: () => void;
  agentId?: string;
  readOnly?: boolean;
  error?: string | null;
  successMessage?: string | null;
  onDeleteAgent?: () => Promise<void> | void;
  onOpenRoutines?: () => void;
}

export const AgentSettingsTab: React.FC<AgentSettingsTabProps> = ({
  settingsDraft,
  setSettingsDraft,
  settingsDirty,
  setSettingsDirty,
  onSaveSettings,
  onRevertSettings,
  agentId,
  readOnly = false,
  error = null,
  successMessage = null,
  onDeleteAgent,
  onOpenRoutines,
}) => {
  const [saving, setSaving] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [resolvedAgentId, setResolvedAgentId] = useState<string>(agentId || '');
  const [initialEngine, setInitialEngine] = useState<string>(settingsDraft.engine || 'antigravity');

  const [customAvatar, setCustomAvatar] = useState<AvatarChoice | null>(() => {
    if (settingsDraft.avatar) {
      if (typeof settingsDraft.avatar === 'string') {
        try {
          return JSON.parse(settingsDraft.avatar);
        } catch {
          return null;
        }
      }
      return settingsDraft.avatar;
    }
    return null;
  });

  useEffect(() => {
    if (agentId) {
      setResolvedAgentId(agentId);
      setInitialEngine(settingsDraft.engine || 'antigravity');
      return;
    }
    let isMounted = true;
    invokeCommand<AgentProfile[]>('list_agent_profiles')
      .then((roster) => {
        if (!isMounted || !Array.isArray(roster)) return;
        const match = roster.find((a) => a.name === settingsDraft.name) || roster[0];
        if (match) {
          setResolvedAgentId(match.id);
          setInitialEngine(match.engine);
          if (match.avatar && !settingsDraft.avatar) {
            try {
              const parsed = typeof match.avatar === 'string' ? JSON.parse(match.avatar) : match.avatar;
              setCustomAvatar(parsed);
            } catch {
              // ignore
            }
          }
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [agentId, settingsDraft.name, settingsDraft.avatar]);

  const effectiveId = resolvedAgentId || settingsDraft.name || 'agent-preview';

  const handleUpdateAvatar = (choice: AvatarChoice) => {
    setCustomAvatar(choice);
    setSettingsDraft((prev: any) => ({
      ...prev,
      avatar: choice,
    }));
    setSettingsDirty(true);
  };

  const handleResetAvatar = () => {
    setCustomAvatar(null);
    setSettingsDraft((prev: any) => ({
      ...prev,
      avatar: null,
    }));
    setSettingsDirty(true);
  };

  const handleKeyDownCapture = (e: React.KeyboardEvent) => {
    if (
      e.key === 'Enter' &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat && settingsDirty && !saving && !readOnly) {
        void handleSave();
      }
    }
  };

  const handleSave = async () => {
    if (!settingsDirty || saving || readOnly) return;
    setSaving(true);
    try {
      await onSaveSettings();
      if (resolvedAgentId) {
        try {
          await invokeCommand('update_agent_profile', {
            agentId: resolvedAgentId,
            name: settingsDraft.name,
            brief: settingsDraft.purpose,
            engine: settingsDraft.engine,
            avatar: customAvatar ? JSON.stringify(customAvatar) : (typeof settingsDraft.avatar === 'string' ? settingsDraft.avatar : null),
            memoryBudget: settingsDraft.memoryBudget,
            reflectionMode: settingsDraft.reflectionMode,
            allowAgentScheduling: settingsDraft.allowAgentScheduling,
            allowAgentMessaging: settingsDraft.allowAgentMessaging,
            defaultMode: settingsDraft.defaultMode,
            defaultPlan: settingsDraft.defaultPlan ? 'true' : 'false',
            defaultModel: settingsDraft.defaultModel,
            defaultProviderOptions: settingsDraft.defaultProviderOptions ?? [],
            placeDisplayNames: settingsDraft.placeDisplayNames ?? [],
            disabledPluginIds: settingsDraft.disabledPluginIds ?? [],
          });
        } catch {
          // ignore
        }
      }
      setInitialEngine(settingsDraft.engine);
      setSettingsDirty(false);
    } catch (err) {
      console.error('[AgentSettingsTab] Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (readOnly || saving || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (onDeleteAgent) {
        await onDeleteAgent();
      } else if (resolvedAgentId) {
        await invokeCommand('delete_agent_profile', { agentId: resolvedAgentId });
      }
      window.dispatchEvent(new CustomEvent('kite:agent-deleted', { detail: { agentId: resolvedAgentId } }));
      window.dispatchEvent(new CustomEvent('kite:agents-changed'));
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent profile.');
    } finally {
      setDeleting(false);
    }
  };

  const handleOpenRoutines = () => {
    if (onOpenRoutines) {
      onOpenRoutines();
    } else {
      window.dispatchEvent(new CustomEvent('kite:open-routines'));
      window.dispatchEvent(new CustomEvent('navigate', { detail: { route: 'routines' } }));
    }
  };

  const [allMcpServers, setAllMcpServers] = useState<Array<{
    id: string;
    name: string;
    provider: string;
    providerLabel: string;
    transport?: string;
    status?: string;
    builtin?: boolean;
    description?: string;
    toolCount?: number;
    tools?: string[];
  }>>([]);
  const [mcpScope, setMcpScope] = useState<'provider' | 'all'>('provider');
  const [expandedMcpId, setExpandedMcpId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    invokeCommand<{ allServers?: any[]; servers?: any[] }>('list_provider_mcp_servers', {})
      .then((res) => {
        if (!mounted || !res) return;
        const list = Array.isArray(res.allServers)
          ? res.allServers
          : Array.isArray(res.servers)
            ? res.servers
            : [];
        setAllMcpServers(list);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const isChatCapableEngine = supportsAgentChat(settingsDraft.engine);
  const currentChatProvider = engineToChatProvider(settingsDraft.engine);
  const [liveModels, setLiveModels] = useState<ModelOption[]>([]);
  const [modelsNote, setModelsNote] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLiveModels([]);
    setModelsNote(null);
    invokeCommand<{ models?: ModelOption[] }>('list_chat_provider_models', {
      provider: currentChatProvider,
      forceRefresh: false,
    })
      .then((res) => {
        if (!mounted) return;
        const models = Array.isArray(res?.models) ? res.models : [];
        setLiveModels(models.filter((model) => model.id && model.id !== AUTOMATIC_MODEL_ID));
        setModelsNote(
          models.length > 0 ? null : 'This program has not listed its models yet.'
        );
      })
      .catch(() => {
        if (!mounted) return;
        setLiveModels([]);
        setModelsNote('This program has not listed its models yet.');
      });
    return () => {
      mounted = false;
    };
  }, [currentChatProvider]);

  const modelRows = [
    {
      id: AUTOMATIC_MODEL_ID,
      title: 'Automatic',
      detail: 'The connected program chooses.',
    },
    ...liveModels.map((model) => ({
      id: model.id,
      title: model.name,
      detail: model.description || 'Listed by the connected program',
    })),
  ];
  const selectedLiveModel = liveModels.find((model) => model.id === settingsDraft.defaultModel);

  const { connections: pluginConnections } = usePluginConnections();

  const combinedMcpServers = React.useMemo(() => {
    const pluginMap = new Map(OFFICIAL_PLUGINS.map((p) => [p.id, p]));
    const pluginServers = pluginConnections
      .filter((c) => c.state === 'connected')
      .map((c) => {
        const meta = pluginMap.get(c.id);
        return {
          id: c.id,
          name: meta?.name || c.id,
          provider: 'kite',
          providerLabel: 'Kite Plugin',
          description: c.account ? `${meta?.summary ?? 'Plugin'} (${c.account})` : meta?.summary ?? 'Connected plugin',
          builtin: false,
          toolCount: meta?.permissions?.length ?? 0,
          tools: meta?.permissions ?? [],
        };
      });

    const existingIds = new Set(allMcpServers.map((s) => s.id));
    const uniquePluginServers = pluginServers.filter((s) => !existingIds.has(s.id));
    return [...allMcpServers, ...uniquePluginServers];
  }, [allMcpServers, pluginConnections]);

  const disabledPlugins: string[] = Array.isArray(settingsDraft.disabledPluginIds)
    ? settingsDraft.disabledPluginIds
    : [];

  const visibleMcpServers = combinedMcpServers.filter((srv) => {
    if (mcpScope === 'all') return true;
    return srv.provider === settingsDraft.engine || srv.provider === currentChatProvider || srv.provider === 'kite';
  });

  const toggleMcpServerForAgent = (serverId: string) => {
    if (readOnly || saving) return;
    setSettingsDraft((prev: any) => {
      const current: string[] = Array.isArray(prev.disabledPluginIds) ? [...prev.disabledPluginIds] : [];
      const next = current.includes(serverId)
        ? current.filter((id) => id !== serverId)
        : [...current, serverId];
      return {
        ...prev,
        disabledPluginIds: next,
      };
    });
    setSettingsDirty(true);
  };

  const places = settingsDraft.placeDisplayNames ?? [];

  return (
    <div
      className="agent-face agent-settings agent-settings--profile"
      onKeyDownCapture={handleKeyDownCapture}
    >
      <div className="agent-settings__scroll">
        <div className="agent-settings__column">
          {successMessage ? (
            <p className="sr-only" role="status">
              {successMessage}
            </p>
          ) : null}

          {error || deleteError ? (
            <p className="agent-feedback agent-feedback--error" role="alert">
              {error || deleteError}
            </p>
          ) : null}

          {/* Name */}
          <section className="agent-setting-group">
            <label className="agent-setting-label" htmlFor="agent-settings-name">
              Name
            </label>
            <input
              id="agent-settings-name"
              className="ui-field ui-field--large"
              type="text"
              maxLength={80}
              value={settingsDraft.name}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setSettingsDraft((prev: any) => ({ ...prev, name: value }));
                setSettingsDirty(true);
              }}
              placeholder="X content expert"
              disabled={readOnly || saving}
            />
          </section>

          {/* Face */}
          <section className="agent-setting-group">
            <AgentAvatarCustomizer
              effectiveId={effectiveId}
              customAvatar={customAvatar}
              saving={readOnly || saving}
              onUpdateAvatar={handleUpdateAvatar}
              onResetAvatar={handleResetAvatar}
            />
          </section>

          {/* Powered by */}
          <fieldset className="agent-setting-group">
            <legend className="agent-setting-label">Powered by</legend>
            <div className="agent-settings__engine-grid">
              {settingsDraft.engine === 'terminal' ? (
                <button
                  type="button"
                  aria-pressed="true"
                  className="engine-chip engine-chip--selected"
                  disabled
                >
                  <span aria-hidden="true" className="engine-mark">
                    <BrandLogo engine="terminal" size={14} />
                  </span>
                  <span className="engine-chip__copy">
                    <strong>Terminal</strong>
                    <small>Legacy profile</small>
                  </span>
                  <CheckIcon size={12} className="engine-chip__check" />
                </button>
              ) : null}

              {TEAMMATE_ENGINE_IDS.map((engineId) => {
                const isSelected = settingsDraft.engine === engineId;
                return (
                  <button
                    key={engineId}
                    type="button"
                    aria-pressed={isSelected}
                    className={`engine-chip${isSelected ? ' engine-chip--selected' : ''}`}
                    disabled={readOnly || saving}
                    onClick={() => {
                      setSettingsDraft((prev: any) => ({ ...prev, engine: engineId }));
                      setSettingsDirty(true);
                    }}
                  >
                    <span aria-hidden="true" className="engine-mark">
                      <BrandLogo engine={engineId} size={14} />
                    </span>
                    <span className="engine-chip__copy">
                      <strong>{getEngineDisplayName(engineId)}</strong>
                      <small>{getEngineVendor(engineId)}</small>
                    </span>
                    <CheckIcon size={12} className="engine-chip__check" />
                  </button>
                );
              })}
            </div>
            <p className="agent-setting-hint">
              {settingsDraft.engine === initialEngine
                ? 'The engine that does the work. It decides how well tasks get executed, not what this agent is for.'
                : 'Changing the engine starts this agent’s chats on a fresh session — transcripts stay, continuity doesn’t. Memory and skills carry over.'}
            </p>
          </fieldset>

          {/* Brief */}
          <section className="agent-setting-group">
            <label className="agent-setting-label" htmlFor="agent-settings-brief">
              Brief
            </label>
            <textarea
              id="agent-settings-brief"
              className="ui-field ui-field--area"
              maxLength={4000}
              rows={7}
              value={settingsDraft.purpose}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setSettingsDraft((prev: any) => ({ ...prev, purpose: value }));
                setSettingsDirty(true);
              }}
              placeholder="You write and schedule posts for our X account. Keep the brand voice: builders, ship, vibe coding…"
              disabled={readOnly || saving}
            />
            <p className="agent-setting-hint">
              Leads the briefing on every turn — the job, the standards, the voice. Everything past this the agent learns on its own.
            </p>
          </section>

          {/* Integrations & MCP Servers (By Provider & Agent) */}
          <section className="agent-setting-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <h2 className="agent-setting-label" style={{ margin: 0 }}>Integrations & MCP Servers</h2>
              {combinedMcpServers.length > 0 && (
                <div style={{ display: 'inline-flex', gap: '4px', background: 'var(--chip-fill)', padding: '2px', borderRadius: '6px', border: '1px solid var(--block-stroke)' }}>
                  <button
                    type="button"
                    className={`secondary-button ${mcpScope === 'provider' ? 'choice-pill--selected' : ''}`}
                    style={{ fontSize: '11px', padding: '2px 8px', height: '22px' }}
                    onClick={() => setMcpScope('provider')}
                  >
                    {getEngineDisplayName(settingsDraft.engine)} ({combinedMcpServers.filter((s) => s.provider === settingsDraft.engine || s.provider === currentChatProvider || s.provider === 'kite').length})
                  </button>
                  <button
                    type="button"
                    className={`secondary-button ${mcpScope === 'all' ? 'choice-pill--selected' : ''}`}
                    style={{ fontSize: '11px', padding: '2px 8px', height: '22px' }}
                    onClick={() => setMcpScope('all')}
                  >
                    All Providers ({combinedMcpServers.length})
                  </button>
                </div>
              )}
            </div>

            {visibleMcpServers.length === 0 ? (
              <div className="ui-card agent-settings__readonly-row agent-settings__empty-row">
                <PuzzleIcon size={14} />
                <span>No plugins connected</span>
              </div>
            ) : (
              <div className="ui-card agent-settings__rows">
                {visibleMcpServers.map((srv) => {
                  const isEnabled = !disabledPlugins.includes(srv.id);
                  const isExpanded = expandedMcpId === srv.id;
                  const tools = Array.isArray(srv.tools) ? srv.tools : [];
                  return (
                    <div key={srv.id} style={{ borderBottom: '1px solid var(--block-stroke)' }}>
                      <div className="agent-settings__row" style={{ borderBottom: 'none' }}>
                        <span className="agent-settings__row-copy" style={{ minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <strong>{srv.name}</strong>
                            <span
                              style={{
                                fontSize: '10px',
                                padding: '1px 6px',
                                borderRadius: '999px',
                                background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                                color: 'var(--accent)',
                                fontWeight: 600,
                              }}
                            >
                              {srv.providerLabel || srv.provider}
                            </span>
                            {typeof srv.toolCount === 'number' && srv.toolCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setExpandedMcpId(isExpanded ? null : srv.id)}
                                style={{
                                  fontSize: '10px',
                                  padding: '1px 6px',
                                  borderRadius: '999px',
                                  background: 'var(--chip-fill)',
                                  border: '1px solid var(--block-stroke)',
                                  color: 'var(--text-secondary)',
                                  cursor: 'pointer',
                                }}
                                title="Inspect MCP tools"
                              >
                                {srv.toolCount} tools {isExpanded ? '▴' : '▾'}
                              </button>
                            )}
                          </span>
                          <small>{srv.description || 'Native MCP server integration'}</small>
                        </span>
                        <span className="agent-settings__control">
                          <button
                            type="button"
                            role="switch"
                            aria-label={`Enable ${srv.name} for this agent`}
                            aria-checked={isEnabled}
                            className="ui-switch"
                            disabled={readOnly || saving}
                            onClick={() => toggleMcpServerForAgent(srv.id)}
                          >
                            <span aria-hidden="true" className="ui-switch__knob" />
                          </button>
                        </span>
                      </div>
                      {isExpanded && tools.length > 0 && (
                        <div
                          style={{
                            padding: '0 14px 10px 14px',
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '4px',
                          }}
                        >
                          {tools.slice(0, 36).map((t) => (
                            <code
                              key={t}
                              style={{
                                fontSize: '10px',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: 'var(--chip-fill)',
                                border: '1px solid var(--block-stroke)',
                                color: 'var(--text-secondary)',
                              }}
                            >
                              {t}
                            </code>
                          ))}
                          {tools.length > 36 && (
                            <small style={{ fontSize: '10px', color: 'var(--text-tertiary)', alignSelf: 'center' }}>
                              +{tools.length - 36} more
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="agent-setting-hint">
              Native MCP servers are grouped by provider ({getEngineDisplayName(settingsDraft.engine)}) and can be toggled individually per agent.
            </p>
          </section>

          {/* New chats start with */}
          <section className="agent-setting-group">
            <h2 className="agent-setting-label">New chats start with</h2>
            <div className="ui-card agent-settings__rows">
              {isChatCapableEngine ? (
                <>
                  <div className="agent-settings__row">
                    <span className="agent-settings__row-copy">
                      <strong>Access</strong>
                      <small>How far a turn may go without asking.</small>
                    </span>
                    <span className="agent-settings__control">
                      <SelectMenu
                        variant="field"
                        label="Access"
                        value={settingsDraft.defaultMode || 'automatic'}
                        triggerLabel={
                          settingsDraft.defaultMode === 'fullAccess'
                            ? 'Full access'
                            : settingsDraft.defaultMode === 'readOnly'
                            ? 'Read only'
                            : settingsDraft.defaultMode === 'acceptEdits'
                            ? 'Auto-accept edits'
                            : 'Automatic'
                        }
                        disabled={readOnly || saving}
                        rows={[
                          { id: 'automatic', title: 'Automatic', detail: 'Agent picks execution mode based on task' },
                          { id: 'acceptEdits', title: 'Auto-accept edits', detail: 'Edits are applied without prompt' },
                          { id: 'fullAccess', title: 'Full access', detail: 'Full file and command execution permissions' },
                          { id: 'readOnly', title: 'Read only', detail: 'Discussion and planning only, no file edits' },
                        ]}
                        onSelect={(id) => {
                          setSettingsDraft((prev: any) => ({ ...prev, defaultMode: id === 'automatic' ? null : id }));
                          setSettingsDirty(true);
                        }}
                      />
                    </span>
                  </div>
                  {(settingsDraft.engine === 'claude-code' || settingsDraft.engine === 'antigravity') ? (
                    <div className="agent-settings__row">
                      <span className="agent-settings__row-copy">
                        <strong>Plan first</strong>
                        <small>Start in Plan — think it through before touching anything.</small>
                      </span>
                      <span className="agent-settings__control">
                        <button
                          type="button"
                          role="switch"
                          aria-label="Plan first"
                          aria-checked={Boolean(settingsDraft.defaultPlan)}
                          className="ui-switch"
                          disabled={readOnly || saving}
                          onClick={() => {
                            setSettingsDraft((prev: any) => ({
                              ...prev,
                              defaultPlan: !prev.defaultPlan,
                            }));
                            setSettingsDirty(true);
                          }}
                        >
                          <span aria-hidden="true" className="ui-switch__knob" />
                        </button>
                      </span>
                    </div>
                  ) : null}
                  <div className="agent-settings__row">
                    <span className="agent-settings__row-copy">
                      <strong>Model</strong>
                      <small>Which model {getEngineDisplayName(settingsDraft.engine)} uses.</small>
                    </span>
                    <span className="agent-settings__control">
                      <SelectMenu
                        variant="field"
                        label="Model"
                        value={settingsDraft.defaultModel || AUTOMATIC_MODEL_ID}
                        triggerLabel={
                          modelRows.find((r) => r.id === (settingsDraft.defaultModel || AUTOMATIC_MODEL_ID))?.title ||
                          settingsDraft.defaultModel ||
                          'Automatic'
                        }
                        disabled={readOnly || saving}
                        rows={modelRows}
                        onSelect={(id) => {
                          setSettingsDraft((prev: any) => ({
                            ...prev,
                            defaultModel: id === AUTOMATIC_MODEL_ID ? null : id,
                          }));
                          setSettingsDirty(true);
                        }}
                      />
                      {modelsNote ? <small>{modelsNote}</small> : null}
                    </span>
                  </div>
                  {selectedLiveModel?.supportsEffort ? (
                    <div className="agent-settings__row">
                      <span className="agent-settings__row-copy">
                        <strong>Reasoning effort</strong>
                        <small>How much reasoning this model uses before it answers.</small>
                      </span>
                      <span className="agent-settings__control">
                        <EffortPicker
                          variant="field"
                          label="Reasoning effort"
                          detail="How much reasoning this model uses before it answers."
                          disabled={readOnly || saving}
                          value={
                            settingsDraft.defaultEffort ||
                            settingsDraft.defaultProviderOptions?.find((o: any) => o.effort)?.effort ||
                            'medium'
                          }
                          onSelect={(effortId) => {
                            setSettingsDraft((prev: any) => {
                              const opts = Array.isArray(prev.defaultProviderOptions) ? [...prev.defaultProviderOptions] : [];
                              const provider = prev.engine === 'codex' ? 'openai' : prev.engine === 'claude-code' ? 'anthropic' : prev.engine;
                              const existingIdx = opts.findIndex((o: any) => o.provider === provider || o.effort);
                              if (existingIdx !== -1) {
                                opts[existingIdx] = { ...opts[existingIdx], effort: effortId };
                              } else {
                                opts.push({ provider, effort: effortId });
                              }
                              return {
                                ...prev,
                                defaultEffort: effortId,
                                defaultProviderOptions: opts,
                              };
                            });
                            setSettingsDirty(true);
                          }}
                        />
                      </span>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="agent-settings__row">
                  <span className="agent-settings__row-copy">
                    <strong>Chat defaults</strong>
                    <small>{getEngineDisplayName(settingsDraft.engine)} runs in a terminal in this release.</small>
                  </span>
                  <span className="agent-settings__control">
                    <strong className="agent-settings__row-value">Not applicable</strong>
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* Notes cap */}
          <fieldset className="agent-setting-group">
            <legend className="agent-setting-label">Notes cap</legend>
            <div className="agent-settings__choice-row">
              {NOTES_CAPS.map((cap) => {
                const isPressed = (settingsDraft.memoryBudget ?? 2200) === cap;
                return (
                  <button
                    key={cap}
                    type="button"
                    aria-pressed={isPressed}
                    disabled={readOnly || saving}
                    onClick={() => {
                      setSettingsDraft((prev: any) => ({ ...prev, memoryBudget: cap }));
                      setSettingsDirty(true);
                    }}
                  >
                    <strong>{formatCap(cap)} chars</strong>
                    {cap === 2200 ? <small>default</small> : null}
                  </button>
                );
              })}
            </div>
            <p className="agent-setting-hint">
              Hard limit for Notes. About you stays capped separately at 1.4k characters.
            </p>
          </fieldset>

          {/* Learn after a turn */}
          <fieldset className="agent-setting-group">
            <legend className="agent-setting-label">Learn after a turn</legend>
            <div className="agent-settings__choice-row agent-settings__choice-row--three">
              {(['ask', 'auto', 'off'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={settingsDraft.reflectionMode === mode}
                  disabled={readOnly || saving}
                  onClick={() => {
                    setSettingsDraft((prev: any) => ({ ...prev, reflectionMode: mode }));
                    setSettingsDirty(true);
                  }}
                >
                  <strong>{mode === 'ask' ? 'Ask' : mode === 'auto' ? 'Auto' : 'Off'}</strong>
                  {mode === 'ask' ? <small>default</small> : null}
                </button>
              ))}
            </div>
            <p className="agent-setting-hint">
              Ask shows what it learned; Auto writes; Off skips the reflection pass.
            </p>
          </fieldset>

          {/* Routines */}
          <section className="agent-setting-group">
            <h2 className="agent-setting-label">Routines</h2>
            <div className="ui-card agent-settings__rows">
              <div className="agent-settings__row">
                <span className="agent-settings__row-copy">
                  <strong>May create routines</strong>
                  <small>
                    Lets {settingsDraft.name.trim() || 'this agent'} create and edit recurring jobs.
                  </small>
                </span>
                <span className="agent-settings__control">
                  <button
                    type="button"
                    role="switch"
                    aria-label="May create routines"
                    aria-checked={Boolean(settingsDraft.allowAgentScheduling)}
                    className="ui-switch"
                    disabled={readOnly || saving}
                    onClick={() => {
                      setSettingsDraft((prev: any) => ({
                        ...prev,
                        allowAgentScheduling: !prev.allowAgentScheduling,
                      }));
                      setSettingsDirty(true);
                    }}
                  >
                    <span aria-hidden="true" className="ui-switch__knob" />
                  </button>
                </span>
              </div>

              <div className="agent-settings__row">
                <span className="agent-settings__row-copy">
                  <strong>All routines</strong>
                  <small>Turn on jobs your agents scheduled, add your own, or run one now.</small>
                </span>
                <span className="agent-settings__control">
                  <button
                    type="button"
                    className="secondary-button action-button--row"
                    onClick={handleOpenRoutines}
                    disabled={saving}
                  >
                    <span aria-hidden="true" className="action-button__icon">
                      <ClockIcon size={14} />
                    </span>
                    Open Routines
                  </button>
                </span>
              </div>
            </div>
            <p className="agent-setting-hint">Jobs fire while the app is running.</p>
          </section>

          {/* Teammates */}
          <section className="agent-setting-group">
            <h2 className="agent-setting-label">Teammates</h2>
            <div className="ui-card agent-settings__rows">
              <div className="agent-settings__row">
                <span className="agent-settings__row-copy">
                  <strong>May message teammates</strong>
                  <small>
                    Lets {settingsDraft.name.trim() || 'this agent'} send agent mail — and take mail from other agents.
                  </small>
                </span>
                <span className="agent-settings__control">
                  <button
                    type="button"
                    role="switch"
                    aria-label="May message teammates"
                    aria-checked={Boolean(settingsDraft.allowAgentMessaging)}
                    className="ui-switch"
                    disabled={readOnly || saving}
                    onClick={() => {
                      setSettingsDraft((prev: any) => ({
                        ...prev,
                        allowAgentMessaging: !prev.allowAgentMessaging,
                      }));
                      setSettingsDirty(true);
                    }}
                  >
                    <span aria-hidden="true" className="ui-switch__knob" />
                  </button>
                </span>
              </div>
            </div>
            <p className="agent-setting-hint">
              When this is on, the agent can message your other agents and be messaged back. Both agents need it on.
            </p>
          </section>

          {/* Places */}
          <section className="agent-setting-group">
            <h2 className="agent-setting-label">Places</h2>
            <ul aria-label="Approved place names" className="ui-card agent-settings__places">
              {places.length === 0 ? (
                <li>Home only</li>
              ) : (
                places.map((p) => <li key={p}>{p}</li>)
              )}
            </ul>
            <p className="agent-setting-hint">
              Folders beyond its home that new chats may write in. It always runs from its home and can read anywhere.
            </p>
          </section>

          {/* Delete */}
          <section className="agent-setting-group">
            <h2 className="agent-setting-label">Delete</h2>
            <button
              type="button"
              className="secondary-button action-button--row agent-settings__delete"
              disabled={readOnly || saving || deleting}
              onClick={() => void handleDelete()}
              title={`Delete ${settingsDraft.name || 'this agent'} and everything it learned`}
            >
              <span aria-hidden="true" className="action-button__icon">
                <TrashIcon size={14} />
              </span>
              {deleting ? 'Waiting for confirmation…' : `Delete ${settingsDraft.name || 'Agent'}…`}
            </button>
            <p className="agent-setting-hint">
              Its chats, everything it remembered, and the skills it wrote go with it.
            </p>
          </section>
        </div>
      </div>

      {settingsDirty ? (
        <footer className="agent-settings__footer">
          <span>{readOnly ? 'Saved state is read-only.' : 'Unsaved changes.'}</span>
          <button
            type="button"
            className="secondary-button action-button--row"
            onClick={onRevertSettings}
            disabled={saving}
          >
            Revert
          </button>
          <button
            type="button"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            className="primary-button action-button--row"
            onClick={() => void handleSave()}
            disabled={readOnly || saving || !settingsDraft.name.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      ) : null}
    </div>
  );
};
