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
    label: 'Permitir',
    description: 'Los agentes pueden iniciar cualquier proveedor o modelo conectado libremente.',
  },
  {
    id: 'ask',
    label: 'Preguntar',
    description:
      'Los agentes permanecen dentro de tu stack habilitado salvo que solicites explícitamente una ejecución con --override-stack.',
  },
  {
    id: 'strict',
    label: 'Estricto',
    description: 'Solo se permiten los modelos habilitados en tu stack curado.',
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
  if (state === 'ready') return 'Listo';
  if (state === 'missing-binary') return 'Falta CLI';
  if (state === 'signed-out') return 'Sesión cerrada';
  return state;
}

function entryKey(entry: Pick<SubagentStackEntry, 'provider' | 'model'>): string {
  return `${entry.provider}::${entry.model.toLowerCase()}`;
}

interface CachedSubagentSnapshot {
  settings: SubagentSettings;
  providers: DiscoveredSubagentProvider[];
  roles: SubagentRoleRecord[];
  workspacePath: string | null;
}

let cachedSnapshot: CachedSubagentSnapshot | null = null;
const cachedModelsByProvider = new Map<string, ChatProviderModelOption[]>();

export function resetSubagentsTabCacheForTest(): void {
  cachedSnapshot = null;
  cachedModelsByProvider.clear();
}

export const SubagentsTab: React.FC = () => {
  const [settings, setSettings] = useState<SubagentSettings>(
    () =>
      cachedSnapshot?.settings ?? {
        stack: [],
        defaultDelegation: null,
        overridePolicy: 'ask',
      }
  );
  const [providers, setProviders] = useState<DiscoveredSubagentProvider[]>(
    () => cachedSnapshot?.providers ?? []
  );
  const [roles, setRoles] = useState<SubagentRoleRecord[]>(() => cachedSnapshot?.roles ?? []);
  const [workspacePath, setWorkspacePath] = useState<string | null>(
    () => cachedSnapshot?.workspacePath ?? null
  );
  const [loading, setLoading] = useState(() => cachedSnapshot === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedProvider, setSelectedProvider] = useState(() => {
    const initialProviders = cachedSnapshot?.providers ?? [];
    const firstReady = initialProviders.find((p) => p.state === 'ready');
    return firstReady?.provider ?? initialProviders[0]?.provider ?? 'grok';
  });
  const [providerModels, setProviderModels] = useState<ChatProviderModelOption[]>(
    () => cachedModelsByProvider.get(selectedProvider) ?? []
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(
    () => cachedModelsByProvider.get(selectedProvider)?.[0]?.id ?? CUSTOM_MODEL_SENTINEL
  );
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
      const normalizedWorkspace = snap.workspacePath ?? null;
      cachedSnapshot = {
        settings: snap.settings,
        providers: snap.providers,
        roles: snap.roles,
        workspacePath: normalizedWorkspace,
      };
      setSettings(snap.settings);
      setProviders(snap.providers);
      setRoles(snap.roles);
      setWorkspacePath(normalizedWorkspace);
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
    if (cachedSnapshot === null) {
      setLoading(true);
    }
    getSubagentSettings()
      .then((snap) => {
        if (!active) return;
        applySnapshot(snap);
        setError(null);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'No se pudo cargar la configuración de subagentes.');
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
      const cached = cachedModelsByProvider.get(provider);
      if (cached && !forceRefresh) {
        setProviderModels(cached);
        setSelectedModel((prev) =>
          cached.some((m) => m.id === prev) ? prev : (cached[0]?.id ?? CUSTOM_MODEL_SENTINEL)
        );
      } else {
        setLoadingModels(true);
      }
      try {
        const res = await listChatProviderModels(provider, forceRefresh);
        const list = res.models ?? [];
        cachedModelsByProvider.set(provider, list);
        setProviderModels(list);
        setSelectedModel((prev) => {
          if (prev !== CUSTOM_MODEL_SENTINEL && list.some((m) => m.id === prev)) {
            return prev;
          }
          return list.length > 0 ? list[0].id : CUSTOM_MODEL_SENTINEL;
        });
      } catch {
        if (!cached) {
          setProviderModels([]);
          setSelectedModel(CUSTOM_MODEL_SENTINEL);
        }
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
        setError(err instanceof Error ? err.message : 'No se pudo guardar la configuración de subagentes.');
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
      setError('El identificador del rol es obligatorio.');
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
      setError(err instanceof Error ? err.message : 'No se pudo guardar el perfil de rol.');
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
      setError(err instanceof Error ? err.message : 'No se pudo eliminar el perfil de rol.');
    } finally {
      setSaving(false);
    }
  };

  const providerRows: SelectMenuRow[] = useMemo(
    () =>
      providers.map((p) => ({
        id: p.provider,
        title: getEngineDisplayName(p.provider),
        detail: `${providerStatusLabel(p.state)}${p.modelCount > 0 ? ` · ${p.modelCount} modelos` : ''}`,
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
      { id: AUTO_SENTINEL, title: 'Por defecto del proveedor', detail: 'Usar el esfuerzo predeterminado del modelo' },
      ...levels.map((level) => ({ id: level, title: level })),
    ];
  }, [selectedModelMeta]);

  const modelRows: SelectMenuRow[] = useMemo(() => {
    const rows: SelectMenuRow[] = providerModels.map((m) => ({
      id: m.id,
      title: m.label || m.name || m.id,
      detail: m.name && m.name !== m.id ? m.id : undefined,
      badge: m.defaultEffort ? `por defecto: ${m.defaultEffort}` : undefined,
    }));
    rows.push({
      id: CUSTOM_MODEL_SENTINEL,
      title: 'ID de modelo personalizado...',
      detail: 'Escribe el identificador exacto del modelo para este proveedor',
      ruleBefore: rows.length > 0,
    });
    return rows;
  }, [providerModels]);

  const defaultDelegationRows: SelectMenuRow[] = useMemo(() => {
    const rows: SelectMenuRow[] = [
      {
        id: AUTO_SENTINEL,
        title: 'Automático',
        detail: 'El orquestador elige dinámicamente un proveedor y modelo conectado',
      },
    ];
    for (const entry of settings.stack.filter((s) => s.enabled)) {
      rows.push({
        id: `${entry.provider}::${entry.model}`,
        title: `${getEngineDisplayName(entry.provider)} · ${entry.model}`,
        detail: entry.effort ? `Esfuerzo: ${entry.effort} (Stack curado)` : 'Entrada del stack curado',
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
            detail: `Conectado · ${providerStatusLabel(p.state).toLowerCase()}`,
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
    : 'Automático';

  const activePolicyMeta =
    POLICY_OPTIONS.find((opt) => opt.id === settings.overridePolicy) ?? POLICY_OPTIONS[0];

  const roleProviderRows: SelectMenuRow[] = useMemo(
    () => [
      { id: AUTO_SENTINEL, title: 'Heredar / Por defecto del stack', detail: 'Usar el valor predeterminado configurado en el stack' },
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
    { id: AUTO_SENTINEL, title: 'Por defecto (heredar)', detail: 'Permitir que quien delega decida el modo de espacio de trabajo' },
    { id: 'inherit', title: 'inherit', detail: 'Compartir el directorio del repositorio activo' },
    { id: 'share', title: 'share', detail: 'Crear un worktree compartido aislado' },
    { id: 'branch', title: 'branch', detail: 'Clonar una copia aislada en rama git' },
  ];

  const roleEffortRows: SelectMenuRow[] = [
    { id: AUTO_SENTINEL, title: 'Esfuerzo por defecto', detail: 'Heredar el esfuerzo predeterminado del proveedor' },
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
            Descartar
          </button>
        </div>
      )}

      {/* 1. Override Policy & Default Lightweight Delegation */}
      <section className="settings-group" aria-labelledby="settings-subagents-policy-title">
        <h2 id="settings-subagents-policy-title" className="settings-group__title">
          Política de delegación y modelo predeterminado
        </h2>
        <div className="ui-card">
          <div className="ui-card__row settings-row">
            <div className="settings-row__copy">
              <h3 className="settings-row__title">Política de cambios del stack</h3>
              <p>{activePolicyMeta.description}</p>
            </div>
            <div className="settings-row__control">
              <fieldset aria-label="Política de cambios del stack" className="ui-segmented">
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
              <h3 className="settings-row__title">Modelo predeterminado de subagentes</h3>
              <p>Se usa cuando un agente delega sin especificar `--provider` ni `--model`.</p>
            </div>
            <div className="settings-row__control settings-row__control--menu">
              <SelectMenu
                label="Modelo predeterminado de subagentes"
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
            Stack de modelos curado ({settings.stack.filter((s) => s.enabled).length} habilitados)
          </h2>
          <span className="subagent-settings__hint">
            Déjalo vacío para permitir cualquier modelo detectado cuando la política es Permitir.
          </span>
        </div>

        <div className="ui-card">
          {settings.stack.length === 0 ? (
            <div className="ui-card__row settings-row">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">Aún no hay modelos en el stack curado</h3>
                <p>
                  Agrega abajo tus modelos preferidos para que los orquestadores y enjambres usen
                  tus suscripciones elegidas.
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
                    Proveedor: {entry.provider}
                    {entry.enabled ? ' · Activo en el stack' : ' · En pausa'}
                  </p>
                </div>
                <div className="settings-row__control">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={entry.enabled}
                    aria-label={`Alternar ${entry.provider}/${entry.model}`}
                    className="ui-switch"
                    disabled={saving}
                    onClick={() => handleToggleEntry(idx)}
                  >
                    <span aria-hidden="true" className="ui-switch__knob" />
                  </button>
                  <button
                    type="button"
                    className="ghost-button subagent-settings__icon-btn"
                    aria-label={`Quitar ${entry.provider}/${entry.model}`}
                    title="Quitar del stack"
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
                  label="Proveedor"
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
                  label="Modelo"
                  variant="field"
                  className="settings-select"
                  searchable
                  value={selectedModel}
                  triggerLabel={
                    loadingModels
                      ? 'Cargando modelos...'
                      : selectedModel === CUSTOM_MODEL_SENTINEL
                        ? customModel.trim() || 'ID de modelo personalizado...'
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
                aria-label="Actualizar modelos del proveedor"
                title="Actualizar lista de modelos"
                disabled={loadingModels || saving}
                onClick={() => void fetchModelsForProvider(selectedProvider, true)}
              >
                <RefreshCwIcon size={13} />
              </button>

              <div className="subagent-settings__builder-field">
                <SelectMenu
                  label="Esfuerzo"
                  variant="field"
                  className="settings-select"
                  value={selectedEffort}
                  triggerLabel={
                    selectedEffort === AUTO_SENTINEL ? 'Esfuerzo: Por defecto' : `Esfuerzo: ${selectedEffort}`
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
                <span>Agregar al stack</span>
              </button>
            </div>

            {selectedModel === CUSTOM_MODEL_SENTINEL && (
              <div className="subagent-settings__custom-row">
                <input
                  type="text"
                  className="ui-field subagent-settings__input"
                  aria-label="ID de modelo personalizado"
                  placeholder={`Ingresa el ID exacto del modelo para ${getEngineDisplayName(selectedProvider)}...`}
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
            Perfiles de rol ({roles.length})
          </h2>
          {!roleDraft && (
            <button
              type="button"
              className="secondary-button subagent-settings__new-role-btn"
              onClick={() => setRoleDraft(emptyRoleDraft(workspacePath ? 'workspace' : 'global'))}
            >
              <PlusIcon size={13} />
              <span>Nuevo rol</span>
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
                      Identificador del rol (--role)
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
                    <span className="subagent-settings__label">Ámbito</span>
                    <fieldset aria-label="Ámbito del rol" className="ui-segmented">
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
                        title={workspacePath ? `Guardar en ${workspacePath}` : 'Abre un espacio de trabajo para crear roles locales'}
                        onClick={() =>
                          setRoleDraft((prev) => (prev ? { ...prev, scope: 'workspace' } : prev))
                        }
                      >
                        {roleDraft.scope === 'workspace' && (
                          <SegmentedIndicator group="settings-subagents-role-scope" />
                        )}
                        <span>Espacio de trabajo</span>
                      </button>
                    </fieldset>
                  </div>
                </div>

                <div className="subagent-settings__role-row">
                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">Proveedor</span>
                    <SelectMenu
                      label="Proveedor del rol"
                      variant="field"
                      className="settings-select"
                      value={roleDraft.provider || AUTO_SENTINEL}
                      triggerLabel={
                        roleDraft.provider
                          ? getEngineDisplayName(roleDraft.provider)
                          : 'Heredar / Por defecto del stack'
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
                      Comando (opcional)
                    </label>
                    <input
                      id="role-command-input"
                      type="text"
                      className="ui-field subagent-settings__input"
                      placeholder={roleDraft.provider || 'auto (heredar por defecto del stack)'}
                      value={roleDraft.command === 'auto' && !roleDraft.provider ? '' : roleDraft.command}
                      disabled={saving}
                      onChange={(e) =>
                        setRoleDraft((prev) => (prev ? { ...prev, command: e.target.value } : prev))
                      }
                    />
                  </div>

                  <div className="subagent-settings__field-group">
                    <label className="subagent-settings__label" htmlFor="role-model-input">
                      Modelo (opcional)
                    </label>
                    <input
                      id="role-model-input"
                      type="text"
                      className="ui-field subagent-settings__input"
                      placeholder="ej. grok-4.7-build-fast"
                      value={roleDraft.model}
                      disabled={saving}
                      onChange={(e) =>
                        setRoleDraft((prev) => (prev ? { ...prev, model: e.target.value } : prev))
                      }
                    />
                  </div>

                  <div className="subagent-settings__field-group">
                    <span className="subagent-settings__label">Esfuerzo</span>
                    <SelectMenu
                      label="Esfuerzo del rol"
                      variant="field"
                      className="settings-select"
                      value={roleDraft.effort || AUTO_SENTINEL}
                      triggerLabel={roleDraft.effort || 'Por defecto'}
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
                    <span className="subagent-settings__label">Modo de espacio de trabajo</span>
                    <SelectMenu
                      label="Modo de espacio de trabajo del rol"
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
                    Descripción
                  </label>
                  <input
                    id="role-desc-input"
                    type="text"
                    className="ui-field subagent-settings__input"
                    placeholder="Descripción breve visible en skills y Configuración"
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
                    Instrucciones de sistema (cuerpo .md)
                  </label>
                  <textarea
                    id="role-body-input"
                    rows={4}
                    className="ui-field ui-field--area subagent-settings__textarea"
                    placeholder="Instrucciones antepuestas al iniciar --role <slug>..."
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
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={saving || !roleDraft.slug.trim()}
                    onClick={() => void handleSaveRoleDraft()}
                  >
                    Guardar rol
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
                <h3 className="settings-row__title">No se encontraron perfiles de rol</h3>
                <p>
                  Define perfiles especialistas reutilizables `.md` en la configuración global o en
                  `.kite/agents/` para `--role &lt;slug&gt;`.
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
                    Editar
                  </button>
                  <button
                    type="button"
                    className="ghost-button subagent-settings__icon-btn"
                    aria-label={`Eliminar rol ${role.slug}`}
                    title="Eliminar perfil de rol"
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
