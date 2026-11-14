import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteSubagentRole,
  getSubagentSettings,
  listChatProviderModels,
  saveSubagentRole,
  saveSubagentSettings,
  type ChatProviderModelOption,
  type DiscoveredSubagentProvider,
  type SaveSubagentRoleInput,
  type SubagentOverridePolicy,
  type SubagentRoleRecord,
  type SubagentSettings,
  type SubagentStackEntry,
} from '../../../lib/ipc/chat';
import { SelectMenu, type SelectMenuRow } from '../../ui/SelectMenu';
import { SegmentedIndicator } from '../../ui/SegmentedIndicator';
import { BrandLogo, getEngineDisplayName } from '../agents/engineMetadata';
import { PlusIcon, RefreshCwIcon, TrashIcon } from './icons';

const DEFAULT_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const CUSTOM_MODEL_SENTINEL = '__custom__';
const AUTO_SENTINEL = '__auto__';

const POLICY_OPTIONS: Array<{
  id: SubagentOverridePolicy;
  label: string;
  description: string;
}> = [
  {
    id: 'allow',
    label: 'Allow',
    description: 'Agents may launch any connected provider or model freely.',
  },
  {
    id: 'ask',
    label: 'Ask',
    description:
      'Agents stay inside your enabled stack unless you request an explicit --override-stack run.',
  },
  {
    id: 'strict',
    label: 'Strict',
    description: 'Only enabled models in your curated stack are permitted.',
  },
];

interface RoleDraft {
  editingExisting: boolean;
  scope: 'global' | 'workspace';
  slug: string;
  command: string;
  description: string;
  provider: string;
  model: string;
  effort: string;
  workspace: string;
  body: string;
}

function emptyRoleDraft(defaultScope: 'global' | 'workspace'): RoleDraft {
  return {
    editingExisting: false,
    scope: defaultScope,
    slug: '',
    command: '',
    description: '',
    provider: '',
    model: '',
    effort: '',
    workspace: '',
    body: '',
  };
}

function providerStatusLabel(state: string): string {
  if (state === 'ready') return 'Ready';
  if (state === 'missing-binary') return 'Missing CLI';
  if (state === 'signed-out') return 'Signed out';
  return state;
}

function entryKey(entry: Pick<SubagentStackEntry, 'provider' | 'model'>): string {
  return `${entry.provider}::${entry.model.toLowerCase()}`;
}

export const SubagentsTab: React.FC = () => {
  const [settings, setSettings] = useState<SubagentSettings>({
    stack: [],
    defaultDelegation: null,
    overridePolicy: 'ask',
  });
  const [providers, setProviders] = useState<DiscoveredSubagentProvider[]>([]);
  const [roles, setRoles] = useState<SubagentRoleRecord[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedProvider, setSelectedProvider] = useState('grok');
  const [providerModels, setProviderModels] = useState<ChatProviderModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(CUSTOM_MODEL_SENTINEL);
  const [customModel, setCustomModel] = useState('');
  const [selectedEffort, setSelectedEffort] = useState<string>(AUTO_SENTINEL);

  const [roleDraft, setRoleDraft] = useState<RoleDraft | null>(null);

  const applySnapshot = useCallback(
    (snap: {
      settings: SubagentSettings;
      providers: DiscoveredSubagentProvider[];
      roles: SubagentRoleRecord[];
      workspacePath?: string | null;
    }) => {
      setSettings(snap.settings);
      setProviders(snap.providers);
      setRoles(snap.roles);
      setWorkspacePath(snap.workspacePath ?? null);
      setSelectedProvider((prev) => {
        if (snap.providers.some((p) => p.provider === prev)) return prev;
        const firstReady = snap.providers.find((p) => p.state === 'ready');
        return firstReady?.provider ?? snap.providers[0]?.provider ?? prev;
      });
    },
    []
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    getSubagentSettings()
      .then((snap) => {
        if (!active) return;
        applySnapshot(snap);
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load subagent settings.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applySnapshot]);

  const fetchModelsForProvider = useCallback(
    async (provider: string, forceRefresh = false) => {
      if (!provider) return;
      setLoadingModels(true);
      try {
        const res = await listChatProviderModels(provider, forceRefresh);
        const list = res.models ?? [];
        setProviderModels(list);
        if (list.length > 0) {
          setSelectedModel(list[0].id);
        } else {
          setSelectedModel(CUSTOM_MODEL_SENTINEL);
        }
      } catch {
        setProviderModels([]);
        setSelectedModel(CUSTOM_MODEL_SENTINEL);
      } finally {
        setLoadingModels(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!selectedProvider) return;
    void fetchModelsForProvider(selectedProvider, false);
  }, [selectedProvider, fetchModelsForProvider]);

  const persistSettings = useCallback(
    async (next: SubagentSettings) => {
      setSaving(true);
      setError(null);
      try {
        const snap = await saveSubagentSettings(next, { workspacePath });
        applySnapshot(snap);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save subagent settings.');
      } finally {
        setSaving(false);
      }
    },
    [applySnapshot, workspacePath]
  );

  const handlePolicyChange = (policy: SubagentOverridePolicy) => {
    if (policy === settings.overridePolicy || saving) return;
    void persistSettings({ ...settings, overridePolicy: policy });
  };

  const resolvedModelInput =
    selectedModel === CUSTOM_MODEL_SENTINEL ? customModel.trim() : selectedModel.trim();

  const handleAddStackEntry = () => {
    if (!selectedProvider || !resolvedModelInput || saving) return;
    const effort = selectedEffort === AUTO_SENTINEL ? null : selectedEffort;
    const candidate: SubagentStackEntry = {
      provider: selectedProvider,
      model: resolvedModelInput,
      effort,
      enabled: true,
    };
    const key = entryKey(candidate);
    const existingIdx = settings.stack.findIndex((item) => entryKey(item) === key);
    const wasEmpty = settings.stack.length === 0;
    const nextStack =
      existingIdx >= 0
        ? settings.stack.map((item, idx) => (idx === existingIdx ? { ...candidate } : item))
        : [...settings.stack, candidate];
    setCustomModel('');
    void persistSettings({
      ...settings,
      stack: nextStack,
      defaultDelegation:
        wasEmpty && !settings.defaultDelegation
          ? { provider: candidate.provider, model: candidate.model, effort: candidate.effort ?? null }
          : settings.defaultDelegation,
      overridePolicy:
        wasEmpty && settings.overridePolicy === 'allow' ? 'ask' : settings.overridePolicy,
    });
  };

  const handleToggleEntry = (idx: number) => {
    if (saving) return;
    const target = settings.stack[idx];
    const nextStack = settings.stack.map((entry, i) =>
      i === idx ? { ...entry, enabled: !entry.enabled } : entry
    );
    const disablingDefault =
      target &&
      target.enabled &&
      settings.defaultDelegation &&
      settings.defaultDelegation.provider === target.provider &&
      settings.defaultDelegation.model.toLowerCase() === target.model.toLowerCase();
    void persistSettings({
      ...settings,
      stack: nextStack,
      defaultDelegation: disablingDefault ? null : settings.defaultDelegation,
    });
  };

  const handleRemoveEntry = (idx: number) => {
    if (saving) return;
    const removed = settings.stack[idx];
    const nextStack = settings.stack.filter((_, i) => i !== idx);
    const clearDefault =
      removed &&
      settings.defaultDelegation &&
      settings.defaultDelegation.provider === removed.provider &&
      settings.defaultDelegation.model.toLowerCase() === removed.model.toLowerCase();
    void persistSettings({
      ...settings,
      stack: nextStack,
      defaultDelegation: clearDefault ? null : settings.defaultDelegation,
    });
  };

  const handleDefaultDelegationSelect = (id: string) => {
    if (saving) return;
    if (id === AUTO_SENTINEL) {
      void persistSettings({ ...settings, defaultDelegation: null });
      return;
    }
    const splitAt = id.indexOf('::');
    if (splitAt <= 0) return;
    const provider = id.slice(0, splitAt);
    const model = id.slice(splitAt + 2);
    const matchIdx = settings.stack.findIndex(
      (e) => entryKey(e) === id.toLowerCase() || (e.provider === provider && e.model === model)
    );
    const match = matchIdx >= 0 ? settings.stack[matchIdx] : undefined;
    const nextStack =
      matchIdx >= 0
        ? settings.stack.map((entry, idx) =>
            idx === matchIdx ? { ...entry, enabled: true } : entry
          )
        : [
            ...settings.stack,
            {
              provider,
              model,
              effort: null,
              enabled: true,
            },
          ];
    const nextPolicy =
      settings.stack.length === 0 && settings.overridePolicy === 'allow'
        ? 'ask'
        : settings.overridePolicy;
    void persistSettings({
      ...settings,
      stack: nextStack,
      overridePolicy: nextPolicy,
      defaultDelegation: {
        provider,
        model,
        effort: match?.effort ?? null,
      },
    });
  };

  const handleSaveRoleDraft = async () => {
    if (!roleDraft || saving) return;
    const slug = roleDraft.slug.trim();
    if (!slug) {
      setError('Role slug is required.');
      return;
    }
    const provider = roleDraft.provider.trim() || null;
    const command = roleDraft.command.trim() || provider || 'auto';
    setSaving(true);
    setError(null);
    try {
      const payload: SaveSubagentRoleInput = {
        scope: roleDraft.scope,
        slug,
        command,
        description: roleDraft.description.trim() || null,
        provider,
        model: roleDraft.model.trim() || null,
        effort: roleDraft.effort.trim() || null,
        workspace: roleDraft.workspace.trim() || null,
        body: roleDraft.body,
      };
      const res = await saveSubagentRole(payload, { workspacePath });
      setRoles(res.roles);
      setRoleDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save role profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRole = async (role: SubagentRoleRecord) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await deleteSubagentRole(role.scope, role.slug, { workspacePath });
      setRoles(next);
      if (roleDraft && roleDraft.slug === role.slug && roleDraft.scope === role.scope) {
        setRoleDraft(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete role profile.');
    } finally {
      setSaving(false);
    }
  };

  const providerRows: SelectMenuRow[] = useMemo(
    () =>
      providers.map((p) => ({
        id: p.provider,
        title: getEngineDisplayName(p.provider),
        detail: `${providerStatusLabel(p.state)}${p.modelCount > 0 ? ` · ${p.modelCount} models` : ''}`,
        badge: providerStatusLabel(p.state),
        engine: p.provider,
      })),
    [providers]
  );

  const selectedModelMeta = useMemo(
    () => providerModels.find((m) => m.id === selectedModel) ?? null,
    [providerModels, selectedModel]
  );

  const effortOptions = useMemo(() => {
    const levels =
      selectedModelMeta?.effortLevels && selectedModelMeta.effortLevels.length > 0
        ? selectedModelMeta.effortLevels
        : DEFAULT_EFFORT_LEVELS;
    return [
      { id: AUTO_SENTINEL, title: 'Provider default', detail: 'Use model default effort' },
      ...levels.map((level) => ({ id: level, title: level })),
    ];
  }, [selectedModelMeta]);

  const modelRows: SelectMenuRow[] = useMemo(() => {
    const rows: SelectMenuRow[] = providerModels.map((m) => ({
      id: m.id,
      title: m.label || m.name || m.id,
      detail: m.name && m.name !== m.id ? m.id : undefined,
      badge: m.defaultEffort ? `default: ${m.defaultEffort}` : undefined,
    }));
    rows.push({
      id: CUSTOM_MODEL_SENTINEL,
      title: 'Custom model ID...',
      detail: 'Type an exact model identifier for this provider',
      ruleBefore: rows.length > 0,
    });
    return rows;
  }, [providerModels]);

  const defaultDelegationRows: SelectMenuRow[] = useMemo(() => {
    const rows: SelectMenuRow[] = [
      {
        id: AUTO_SENTINEL,
        title: 'Automatic',
        detail: 'Orchestrator chooses a connected provider and model dynamically',
      },
    ];
    for (const entry of settings.stack.filter((s) => s.enabled)) {
      rows.push({
        id: `${entry.provider}::${entry.model}`,
        title: `${getEngineDisplayName(entry.provider)} · ${entry.model}`,
        detail: entry.effort ? `Effort: ${entry.effort} (Curated stack)` : 'Curated stack entry',
        badge: 'Stack',
        engine: entry.provider,
      });
    }
    if (settings.stack.length === 0) {
      const existingKeys = new Set(rows.map((r) => r.id.toLowerCase()));
      for (const p of providers) {
        for (const sample of p.sampleModels) {
          const key = `${p.provider}::${sample}`;
          if (existingKeys.has(key.toLowerCase())) continue;
          rows.push({
            id: key,
            title: `${getEngineDisplayName(p.provider)} · ${sample}`,
            detail: `Connected ${providerStatusLabel(p.state).toLowerCase()}`,
            engine: p.provider,
          });
        }
      }
    }
    return rows;
  }, [settings.stack, providers]);

  const activeDefaultValue = settings.defaultDelegation
    ? `${settings.defaultDelegation.provider}::${settings.defaultDelegation.model}`
    : AUTO_SENTINEL;

  const activeDefaultLabel = settings.defaultDelegation
    ? `${getEngineDisplayName(settings.defaultDelegation.provider)} · ${settings.defaultDelegation.model}`
    : 'Automatic';

  const activePolicyMeta =
    POLICY_OPTIONS.find((opt) => opt.id === settings.overridePolicy) ?? POLICY_OPTIONS[0];

  const roleProviderRows: SelectMenuRow[] = useMemo(
    () => [
      { id: AUTO_SENTINEL, title: 'Inherit / Stack default', detail: 'Use configured stack default' },
      ...providers.map((p) => ({
        id: p.provider,
        title: getEngineDisplayName(p.provider),
        detail: providerStatusLabel(p.state),
        engine: p.provider,
      })),
    ],
    [providers]
  );

  const roleWorkspaceRows: SelectMenuRow[] = [
    { id: AUTO_SENTINEL, title: 'Default (inherit)', detail: 'Let caller decide workspace mode' },
    { id: 'inherit', title: 'inherit', detail: 'Share the active repository directory' },
    { id: 'share', title: 'share', detail: 'Create an isolated shared worktree' },
    { id: 'branch', title: 'branch', detail: 'Clone an isolated git branch copy' },
  ];

  const roleEffortRows: SelectMenuRow[] = [
    { id: AUTO_SENTINEL, title: 'Default effort', detail: 'Inherit provider default effort' },
    ...DEFAULT_EFFORT_LEVELS.map((level) => ({ id: level, title: level })),
  ];

  return (
    <>
      {error && (
        <div className="subagent-settings__error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="ghost-button subagent-settings__dismiss"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 1. Override Policy & Default Lightweight Delegation */}
      <section className="settings-group" aria-labelledby="settings-subagents-policy-title">
        <h2 id="settings-subagents-policy-title" className="settings-group__title">
          Delegation Policy &amp; Default
        </h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Stack override policy</h3>
              <p>{activePolicyMeta.description}</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Stack override policy" className="ui-segmented">
                {POLICY_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={settings.overridePolicy === option.id}
                    className="ui-segmented__item"
                    disabled={saving || loading}
                    onClick={() => handlePolicyChange(option.id)}
                  >
                    {settings.overridePolicy === option.id && (
                      <SegmentedIndicator group="settings-subagents-policy" />
                    )}
                    <span>{option.label}</span>
                  </button>
                ))}
              </fieldset>
            </div>
          </div>

          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Default lightweight model</h3>
              <p>Used when an agent delegates without specifying `--provider` or `--model`.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <SelectMenu
                label="Default lightweight model"
                variant="field"
                className="settings-select"
                searchable
                value={activeDefaultValue}
                triggerLabel={activeDefaultLabel}
                triggerEngine={settings.defaultDelegation?.provider}
                rows={defaultDelegationRows}
                disabled={saving || loading}
                onSelect={handleDefaultDelegationSelect}
              />
            </div>
          </div>
        </div>
      </section>

      {/* 2. Curated Model Stack */}
      <section className="settings-group" aria-labelledby="settings-subagents-stack-title">
        <div className="subagent-settings__section-head">
          <h2 id="settings-subagents-stack-title" className="settings-group__title">
            Curated Model Stack ({settings.stack.filter((s) => s.enabled).length} enabled)
          </h2>
          <span className="subagent-settings__hint">
            Leave empty to allow any discovered model when policy is Allow.
          </span>
        </div>

        <div className="ui-card">
          {settings.stack.length === 0 ? (
            <div className="ui-card__row settings-row">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">No curated stack entries yet</h3>
                <p>
                  Add preferred models below so orchestrators and swarms stay on your chosen
                  subscriptions.
                </p>
              </div>
            </div>
          ) : (
            settings.stack.map((entry, idx) => (
              <div key={`${entry.provider}:${entry.model}`} className="ui-card__row settings-row">
                <div className="settings-row__copy">
                  <h3 className="settings-row__title">
                    <BrandLogo engine={entry.provider} size={14} />
                    <span>{getEngineDisplayName(entry.provider)}</span>
                    <code className="subagent-settings__code">{entry.model}</code>
                    {entry.effort && (
                      <span className="subagent-settings__chip">{entry.effort}</span>
                    )}
                  </h3>
                  <p>
                    Provider: {entry.provider}
                    {entry.enabled ? ' · Active in stack' : ' · Paused'}
                  </p>
                </div>
                <div className="settings-row__control">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={entry.enabled}
                    aria-label={`Toggle ${entry.provider}/${entry.model}`}
                    className="ui-switch"
                    disabled={saving}
                    onClick={() => handleToggleEntry(idx)}
                  >
                    <span aria-hidden="true" className="ui-switch__knob" />
                  </button>
                  <button
                    type="button"
                    className="ghost-button subagent-settings__icon-btn"
                    aria-label={`Remove ${entry.provider}/${entry.model}`}
                    title="Remove from stack"
                    disabled={saving}
                    onClick={() => handleRemoveEntry(idx)}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
            ))
          )}

          <div className="ui-card__row settings-row settings-row--stacked">
            <div className="subagent-settings__builder">
              <div className="subagent-settings__builder-field">
                <SelectMenu
                  label="Provider"
                  variant="field"
                  className="settings-select"
                  value={selectedProvider}
                  triggerEngine={selectedProvider}
                  triggerLabel={getEngineDisplayName(selectedProvider)}
                  rows={providerRows}
                  disabled={saving}
                  onSelect={(id) => {
                    setSelectedProvider(id);
                    setCustomModel('');
                    setSelectedEffort(AUTO_SENTINEL);
                  }}
                />
              </div>

              <div className="subagent-settings__builder-field subagent-settings__builder-field--wide">
                <SelectMenu
                  label="Model"
                  variant="field"
                  className="settings-select"
                  searchable
                  value={selectedModel}
                  triggerLabel={
                    loadingModels
                      ? 'Loading models...'
                      : selectedModel === CUSTOM_MODEL_SENTINEL
                        ? customModel.trim() || 'Custom model ID...'
                        : selectedModelMeta?.label ||
                          selectedModelMeta?.name ||
                          selectedModel
                  }
                  rows={modelRows}
                  disabled={saving}
                  onSelect={(id) => setSelectedModel(id)}
                />
              </div>

              <button
                type="button"
                className="ghost-button subagent-settings__icon-btn"
                aria-label="Refresh provider models"
                title="Refresh model list"
                disabled={loadingModels || saving}
                onClick={() => void fetchModelsForProvider(selectedProvider, true)}
              >
                <RefreshCwIcon size={13} />
              </button>

              <div className="subagent-settings__builder-field">
                <SelectMenu
                  label="Effort"
                  variant="field"
                  className="settings-select"
                  value={selectedEffort}
                  triggerLabel={
                    selectedEffort === AUTO_SENTINEL ? 'Effort: Default' : `Effort: ${selectedEffort}`
                  }
                  rows={effortOptions}
                  disabled={saving}
                  onSelect={(id) => setSelectedEffort(id)}
                />
              </div>

              <button
                type="button"
                className="primary-button subagent-settings__add-btn"
                disabled={!resolvedModelInput || saving}
                onClick={handleAddStackEntry}
              >
                <PlusIcon size={13} />
                <span>Add to stack</span>
              </button>
            </div>

            {selectedModel === CUSTOM_MODEL_SENTINEL && (
              <div className="subagent-settings__custom-row">
                <input
                  type="text"
                  className="ui-field subagent-settings__input"
                  aria-label="Custom model ID"
                  placeholder={`Enter exact model ID for ${getEngineDisplayName(selectedProvider)}...`}
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 3. Role Profiles (.md) */}
      <section className="settings-group" aria-labelledby="settings-subagents-roles-title">
        <div className="subagent-settings__section-head">
          <h2 id="settings-subagents-roles-title" className="settings-group__title">
            Role Profiles ({roles.length})
          </h2>
          {!roleDraft && (
            <button
              type="button"
              className="secondary-button subagent-settings__new-role-btn"
              onClick={() => setRoleDraft(emptyRoleDraft(workspacePath ? 'workspace' : 'global'))}
            >
              <PlusIcon size={13} />
              <span>New role</span>
            </button>
          )}
        </div>

        {roleDraft && (
          <div className="ui-card">
            <div className="ui-card__row settings-row settings-row--stacked">
              <div className="subagent-settings__role-form">
                <div className="subagent-settings__role-row">
                  <div className="subagent-settings__field-group">
                    <label className="subagent-settings__label" htmlFor="role-slug-input">
                      Role slug (--role)
                    </label>
                    <input
                      id="role-slug-input"
                      type="text"
                      className="ui-field subagent-settings__input"
                      placeholder="fast-reviewer"
                      value={roleDraft.slug}
                      disabled={roleDraft.editingExisting || saving}
                      onChange={(e) =>
                        setRoleDraft((prev) => (prev ? { ...prev, slug: e.target.value } : prev))
                      }
                    />
                  </div>

                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">Scope</span>
                    <fieldset aria-label="Role scope" className="ui-segmented">
                      <button
                        type="button"
                        className="ui-segmented__item"
                        aria-pressed={roleDraft.scope === 'global'}
                        disabled={roleDraft.editingExisting || saving}
                        onClick={() =>
                          setRoleDraft((prev) => (prev ? { ...prev, scope: 'global' } : prev))
                        }
                      >
                        {roleDraft.scope === 'global' && (
                          <SegmentedIndicator group="settings-subagents-role-scope" />
                        )}
                        <span>Global</span>
                      </button>
                      <button
                        type="button"
                        className="ui-segmented__item"
                        aria-pressed={roleDraft.scope === 'workspace'}
                        disabled={roleDraft.editingExisting || !workspacePath || saving}
                        title={workspacePath ? `Save under ${workspacePath}` : 'Open a workspace to create workspace roles'}
                        onClick={() =>
                          setRoleDraft((prev) => (prev ? { ...prev, scope: 'workspace' } : prev))
                        }
                      >
                        {roleDraft.scope === 'workspace' && (
                          <SegmentedIndicator group="settings-subagents-role-scope" />
                        )}
                        <span>Workspace</span>
                      </button>
                    </fieldset>
                  </div>
                </div>

                <div className="subagent-settings__role-row">
                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">Provider</span>
                    <SelectMenu
                      label="Role provider"
                      variant="field"
                      className="settings-select"
                      value={roleDraft.provider || AUTO_SENTINEL}
                      triggerLabel={
                        roleDraft.provider
                          ? getEngineDisplayName(roleDraft.provider)
                          : 'Inherit / Stack default'
                      }
                      triggerEngine={roleDraft.provider || undefined}
                      rows={roleProviderRows}
                      disabled={saving}
                      onSelect={(id) =>
                        setRoleDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                provider: id === AUTO_SENTINEL ? '' : id,
                                command:
                                  id === AUTO_SENTINEL
                                    ? prev.command === prev.provider || prev.command === 'auto'
                                      ? ''
                                      : prev.command
                                    : !prev.command ||
                                        prev.command === prev.provider ||
                                        prev.command === 'auto'
                                      ? id
                                      : prev.command,
                              }
                            : prev
                        )
                      }
                    />
                  </div>

                  <div className="subagent-settings__field-group">
                    <label className="subagent-settings__label" htmlFor="role-command-input">
                      Command (optional)
                    </label>
                    <input
                      id="role-command-input"
                      type="text"
                      className="ui-field subagent-settings__input"
                      placeholder={roleDraft.provider || 'auto (inherit stack default)'}
                      value={roleDraft.command === 'auto' && !roleDraft.provider ? '' : roleDraft.command}
                      disabled={saving}
                      onChange={(e) =>
                        setRoleDraft((prev) => (prev ? { ...prev, command: e.target.value } : prev))
                      }
                    />
                  </div>

                  <div className="subagent-settings__field-group">
                    <label className="subagent-settings__label" htmlFor="role-model-input">
                      Model (optional)
                    </label>
                    <input
                      id="role-model-input"
                      type="text"
                      className="ui-field subagent-settings__input"
                      placeholder="e.g. grok-4.7-build-fast"
                      value={roleDraft.model}
                      disabled={saving}
                      onChange={(e) =>
                        setRoleDraft((prev) => (prev ? { ...prev, model: e.target.value } : prev))
                      }
                    />
                  </div>

                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">Effort</span>
                    <SelectMenu
                      label="Role effort"
                      variant="field"
                      className="settings-select"
                      value={roleDraft.effort || AUTO_SENTINEL}
                      triggerLabel={roleDraft.effort || 'Default'}
                      rows={roleEffortRows}
                      disabled={saving}
                      onSelect={(id) =>
                        setRoleDraft((prev) =>
                          prev ? { ...prev, effort: id === AUTO_SENTINEL ? '' : id } : prev
                        )
                      }
                    />
                  </div>

                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">Workspace mode</span>
                    <SelectMenu
                      label="Role workspace mode"
                      variant="field"
                      className="settings-select"
                      value={roleDraft.workspace || AUTO_SENTINEL}
                      triggerLabel={roleDraft.workspace || 'inherit'}
                      rows={roleWorkspaceRows}
                      disabled={saving}
                      onSelect={(id) =>
                        setRoleDraft((prev) =>
                          prev ? { ...prev, workspace: id === AUTO_SENTINEL ? '' : id } : prev
                        )
                      }
                    />
                  </div>
                </div>

                <div className="subagent-settings__field-group">
                  <label className="subagent-settings__label" htmlFor="role-desc-input">
                    Description
                  </label>
                  <input
                    id="role-desc-input"
                    type="text"
                    className="ui-field subagent-settings__input"
                    placeholder="Concise description shown in skills and Settings"
                    value={roleDraft.description}
                    disabled={saving}
                    onChange={(e) =>
                      setRoleDraft((prev) =>
                        prev ? { ...prev, description: e.target.value } : prev
                      )
                    }
                  />
                </div>

                <div className="subagent-settings__field-group">
                  <label className="subagent-settings__label" htmlFor="role-body-input">
                    System prompt instructions (.md body)
                  </label>
                  <textarea
                    id="role-body-input"
                    rows={4}
                    className="ui-field ui-field--area subagent-settings__textarea"
                    placeholder="Instructions prepended when launching --role <slug>..."
                    value={roleDraft.body}
                    disabled={saving}
                    onChange={(e) =>
                      setRoleDraft((prev) => (prev ? { ...prev, body: e.target.value } : prev))
                    }
                  />
                </div>

                <div className="subagent-settings__role-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={saving}
                    onClick={() => setRoleDraft(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={saving || !roleDraft.slug.trim()}
                    onClick={() => void handleSaveRoleDraft()}
                  >
                    Save role
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="ui-card">
          {roles.length === 0 ? (
            <div className="ui-card__row settings-row">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">No role profiles found</h3>
                <p>
                  Define reusable `.md` specialist profiles in global settings or `.kite/agents/`
                  for `--role &lt;slug&gt;`.
                </p>
              </div>
            </div>
          ) : (
            roles.map((role) => (
              <div key={`${role.scope}:${role.slug}`} className="ui-card__row settings-row">
                <div className="settings-row__copy">
                  <h3 className="settings-row__title">
                    {role.provider && <BrandLogo engine={role.provider} size={14} />}
                    <code className="subagent-settings__code">{role.slug}</code>
                    <span className="subagent-settings__chip">{role.scope}</span>
                    {role.model && <span className="subagent-settings__chip">{role.model}</span>}
                    {role.workspace && (
                      <span className="subagent-settings__chip">{role.workspace}</span>
                    )}
                  </h3>
                  <p>
                    {role.description || role.body || role.path}
                  </p>
                </div>
                <div className="settings-row__control">
                  <button
                    type="button"
                    className="secondary-button subagent-settings__role-btn"
                    disabled={saving}
                    onClick={() =>
                      setRoleDraft({
                        editingExisting: true,
                        scope: role.scope === 'workspace' ? 'workspace' : 'global',
                        slug: role.slug,
                        command: role.command,
                        description: role.description ?? '',
                        provider: role.provider ?? '',
                        model: role.model ?? '',
                        effort: role.effort ?? '',
                        workspace: role.workspace ?? '',
                        body: role.body ?? '',
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost-button subagent-settings__icon-btn"
                    aria-label={`Delete role ${role.slug}`}
                    title="Delete role profile"
                    disabled={saving}
                    onClick={() => void handleDeleteRole(role)}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
};
