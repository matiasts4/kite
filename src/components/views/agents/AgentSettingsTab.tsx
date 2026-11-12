import React, { useState, useEffect } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import type { AgentProfile } from '../../../types';
import type { AvatarChoice } from '../../AgentAvatar';
import { AgentAvatarCustomizer } from './AgentAvatarCustomizer';
import {
  BrandLogo,
  TEAMMATE_ENGINE_IDS,
  getEngineDisplayName,
  getEngineVendor,
} from './engineMetadata';
import { CheckIcon, ClockIcon, TrashIcon } from './agentIcons';
import { AgentMcpSection } from './sections/AgentMcpSection';
import { AgentModelDefaultsSection } from './sections/AgentModelDefaultsSection';

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
          <AgentMcpSection
            engine={settingsDraft.engine}
            disabledPluginIds={settingsDraft.disabledPluginIds ?? []}
            readOnly={readOnly}
            saving={saving}
            onToggleServer={toggleMcpServerForAgent}
          />

          {/* New chats start with */}
          <AgentModelDefaultsSection
            settingsDraft={settingsDraft}
            setSettingsDraft={setSettingsDraft}
            setSettingsDirty={setSettingsDirty}
            readOnly={readOnly}
            saving={saving}
          />

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
