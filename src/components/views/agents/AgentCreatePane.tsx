import React, { useEffect, useRef, useState } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import type { AgentProfile } from '../../../types';
import type { AvatarChoice } from '../../AgentAvatar';
import { AgentAvatarCustomizer } from './AgentAvatarCustomizer';
import { SelectMenu } from '../../ui/SelectMenu';
import { AUTOMATIC_MODEL_ID, engineToChatProvider, type ModelOption } from '../chat/types';
import { catalogEmptyMessage, type CatalogEmptyKind } from '../chat/catalogEmptyState';
import {
  BrandLogo,
  TEAMMATE_ENGINE_IDS,
  getEngineDisplayName,
  getEngineVendor,
} from './engineMetadata';
import {
  SparklesIcon,
  UserRoundPlusIcon,
  AudioLinesIcon,
  CheckIcon,
  CloseIcon,
} from './agentIcons';
import {
  SPECIALIST_AGENT_PRESETS,
  type SpecialistAgentPreset,
} from './agentPresets';
import {
  AgentDraftStagePanel,
  type DraftStage,
  type AgentDraftResult,
} from './AgentDraftStagePanel';

const DRAFT_SCHEMA_VERSION = 1;

export interface AgentCreatePaneProps {
  agents?: AgentProfile[];
  onCreated: (agent: AgentProfile) => void;
  onCancel: () => void;
}

export const AgentCreatePane: React.FC<AgentCreatePaneProps> = ({
  agents = [],
  onCreated,
  onCancel,
}) => {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [engine, setEngine] = useState('antigravity');
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [liveModels, setLiveModels] = useState<ModelOption[]>([]);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [catalogKind, setCatalogKind] = useState<CatalogEmptyKind>('loading');
  const [avatar, setAvatar] = useState<AvatarChoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<DraftStage | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  const faceSeed = useRef<string>(
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : '00000000-0000-4000-8000-000000000000'
  ).current;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<DraftStage | null>(null);
  stageRef.current = stage;

  useEffect(() => {
    nameInputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    return () => {
      const current = stageRef.current;
      if (current?.kind === 'drafting') {
        void invokeCommand('cancel_agent_draft', {
          supportedSchemaVersion: DRAFT_SCHEMA_VERSION,
          requestId: current.requestId,
        }).catch(() => undefined);
      } else if (current?.kind === 'ready') {
        void invokeCommand('abandon_agent_draft', {
          supportedSchemaVersion: DRAFT_SCHEMA_VERSION,
          requestId: current.requestId,
        }).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    setLiveModels([]);
    setModelsNote(catalogEmptyMessage('loading', engineToChatProvider(engine)));
    setCatalogKind('loading');
    setDefaultModel(null);
    const provider = engineToChatProvider(engine);
    invokeCommand<{ models?: ModelOption[]; catalogState?: CatalogEmptyKind }>('list_chat_provider_models', {
      provider,
      forceRefresh: false,
    })
      .then((res) => {
        if (!mounted) return;
        const models = Array.isArray(res?.models) ? res.models : [];
        const listed = models.filter((model) => model.id && model.id !== AUTOMATIC_MODEL_ID);
        setLiveModels(listed);
        const kind: CatalogEmptyKind =
          listed.length > 0
            ? 'empty'
            : res?.catalogState === 'missing-binary' || res?.catalogState === 'signed-out'
              ? res.catalogState
              : 'empty';
        setCatalogKind(kind);
        setModelsNote(listed.length > 0 ? null : catalogEmptyMessage(kind, provider));
      })
      .catch(() => {
        if (!mounted) return;
        setLiveModels([]);
        setCatalogKind('empty');
        setModelsNote(catalogEmptyMessage('empty', provider));
      });
    return () => {
      mounted = false;
    };
  }, [engine]);

  const modelRows = [
    { id: AUTOMATIC_MODEL_ID, title: 'Automatic', detail: 'The connected program chooses.' },
    ...liveModels.map((model) => ({
      id: model.id,
      title: model.name,
      detail: model.description || 'Listed by the connected program',
    })),
  ];

  const trimmedName = name.trim();
  const duplicateName =
    trimmedName.length > 0 &&
    agents.some((a) => a.name.toLowerCase() === trimmedName.toLowerCase());
  const canSubmit = trimmedName.length > 0 && !duplicateName && !creating;

  const handleApplyPreset = (preset: SpecialistAgentPreset) => {
    setSelectedPresetId(preset.id);
    const exists = agents.some((a) => a.name.toLowerCase() === preset.name.toLowerCase());
    setName(exists ? `${preset.name} (${preset.roleBadge})` : preset.name);
    setPurpose(preset.brief);
    setEngine(preset.engine);
    setError(null);
  };

  const handleCreate = async () => {
    if (!canSubmit) return;
    setCreating(true);
    setError(null);
    try {
      const created = await invokeCommand<AgentProfile>('create_agent', {
        supportedSchemaVersion: 1,
        name: trimmedName,
        engine,
        purpose: purpose.trim(),
        avatar,
        defaultModel,
        confirmedByBuilder: true,
      });
      onCreated(created);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'This agent could not be created.');
    } finally {
      setCreating(false);
    }
  };

  const handleStartDraft = async (seedText: string) => {
    const trimmedSeed = seedText.trim();
    if (!trimmedSeed) {
      setError('Describe the teammate you want to create.');
      return;
    }
    setError(null);
    const requestId = globalThis.crypto.randomUUID();
    setStage({ kind: 'drafting', requestId, seed: trimmedSeed, cancelling: false });
    try {
      const result = await invokeCommand<AgentDraftResult>('draft_agent_with_ai', {
        supportedSchemaVersion: DRAFT_SCHEMA_VERSION,
        requestId,
        seed: trimmedSeed,
        desiredEngine: engine,
      });
      setStage({
        kind: 'ready',
        requestId,
        seed: trimmedSeed,
        draft: result.draft,
        accepting: false,
        abandoning: false,
        error: null,
      });
    } catch (err: unknown) {
      setStage({
        kind: 'error',
        seed: trimmedSeed,
        message:
          err instanceof Error
            ? err.message
            : 'Create with AI could not finish this draft. Try again.',
      });
    }
  };

  const handleCancelDraft = async () => {
    if (stage?.kind !== 'drafting' || stage.cancelling) return;
    const { requestId, seed } = stage;
    setStage({ ...stage, cancelling: true });
    try {
      await invokeCommand('cancel_agent_draft', {
        supportedSchemaVersion: DRAFT_SCHEMA_VERSION,
        requestId,
      });
      setStage({ kind: 'idle', seed });
    } catch (err: unknown) {
      setStage({
        kind: 'error',
        seed,
        message:
          err instanceof Error
            ? err.message
            : 'The draft could not be cancelled safely. Restart Kite before retrying.',
      });
    }
  };

  const handleAbandonReady = async (closeAfter: boolean) => {
    if (stage?.kind !== 'ready' || stage.accepting || stage.abandoning) return;
    setStage({ ...stage, abandoning: true, error: null });
    try {
      await invokeCommand('abandon_agent_draft', {
        supportedSchemaVersion: DRAFT_SCHEMA_VERSION,
        requestId: stage.requestId,
      });
      stageRef.current = null;
      setStage(null);
      if (closeAfter) {
        onCancel();
      }
    } catch (err: unknown) {
      setStage({
        kind: 'cleanupRequired',
        message:
          err instanceof Error
            ? err.message
            : 'The hosted draft still needs cleanup. Retry before leaving this editor.',
        retrying: false,
      });
    }
  };

  const handleAcceptReady = async () => {
    if (stage?.kind !== 'ready' || stage.accepting || stage.abandoning) return;
    setStage({ ...stage, accepting: true, error: null });
    try {
      const created = await invokeCommand<AgentProfile>('accept_agent_draft', {
        supportedSchemaVersion: DRAFT_SCHEMA_VERSION,
        requestId: stage.requestId,
        idempotencyKey: globalThis.crypto.randomUUID(),
        name: stage.draft.name,
        brief: stage.draft.brief,
        engine,
        confirmedByBuilder: true,
      });
      stageRef.current = null;
      setStage(null);
      onCreated(created);
    } catch (err: unknown) {
      setStage({
        ...stage,
        accepting: false,
        error: err instanceof Error ? err.message : 'This Agent could not be saved. Try again.',
      });
    }
  };

  const handleRetryCleanup = async () => {
    if (stage?.kind !== 'cleanupRequired' || stage.retrying) return;
    setStage({ ...stage, retrying: true });
    try {
      await invokeCommand('retry_agent_draft_cleanup', {
        supportedSchemaVersion: DRAFT_SCHEMA_VERSION,
      });
      stageRef.current = null;
      setStage(null);
      onCancel();
    } catch (err: unknown) {
      setStage({
        kind: 'cleanupRequired',
        message:
          err instanceof Error
            ? err.message
            : 'The hosted draft still needs cleanup. Check your connection and try again.',
        retrying: false,
      });
    }
  };

  const handleDismissEditor = () => {
    if (creating || stage?.kind === 'cleanupRequired') return;
    if (stage?.kind === 'drafting') {
      void handleCancelDraft().then(() => onCancel());
      return;
    }
    if (stage?.kind === 'ready') {
      void handleAbandonReady(true);
      return;
    }
    onCancel();
  };

  return (
    <section aria-labelledby="agent-editor-title" className="pane agent-editor">
      <header className="pane-titlebar pane-titlebar--large">
        <span aria-hidden="true" className="pane-titlebar__icon">
          {stage ? <SparklesIcon size={14} /> : <UserRoundPlusIcon size={14} />}
        </span>
        <span className="pane-titlebar__copy">
          <strong id="agent-editor-title">{stage ? 'Create with AI' : 'New Agent'}</strong>
          <small>
            {stage
              ? 'Describe the job. Kite writes the name and brief; you can refine both before saving.'
              : 'Pick a specialist template, generate one with AI, or configure your teammate below.'}
          </small>
        </span>
        <button
          type="button"
          aria-label="Cancel agent creation"
          className="chrome-button"
          disabled={creating || stage?.kind === 'cleanupRequired'}
          onClick={handleDismissEditor}
          title={
            stage?.kind === 'cleanupRequired'
              ? 'Cleanup must finish before closing'
              : 'Cancel (Esc)'
          }
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {stage === null ? (
        <form
          className="agent-editor__form"
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              (e.ctrlKey || e.metaKey) &&
              !e.altKey &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              !e.repeat
            ) {
              e.preventDefault();
              void handleCreate();
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <div className="agent-editor__scroll">
            <div className="agent-editor__fields">
              <button
                type="button"
                className="ai-create-row"
                disabled={creating}
                onClick={() => {
                  setError(null);
                  setStage({ kind: 'idle', seed: purpose });
                }}
                title="Say what the job is — Kite writes the name and the brief"
              >
                <span aria-hidden="true" className="ai-create-row__icon">
                  <SparklesIcon size={12} strokeWidth={2.25} />
                </span>
                <span className="ai-create-row__copy">
                  <strong>Create with AI</strong>
                  <small>Describe the role in Spanish or English — we’ll generate the name and charter.</small>
                </span>
                <AudioLinesIcon size={13} className="ai-create-row__wave" />
              </button>

              {/* Preset Specialist Templates */}
              <fieldset className="form-field">
                <legend>Specialist Templates (1-Click Preset)</legend>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                    gap: '8px',
                  }}
                >
                  {SPECIALIST_AGENT_PRESETS.map((preset) => {
                    const isSelected = selectedPresetId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={creating}
                        onClick={() => handleApplyPreset(preset)}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: '4px',
                          padding: '10px 12px',
                          borderRadius: '8px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          border: isSelected
                            ? '1px solid var(--accent, #58a6ff)'
                            : '1px solid var(--block-stroke, rgba(255,255,255,0.08))',
                          background: isSelected
                            ? 'var(--selected-fill, rgba(88,166,255,0.1))'
                            : 'var(--block-fill, rgba(255,255,255,0.03))',
                          transition: 'border-color 0.15s ease, background 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%' }}>
                          <BrandLogo engine={preset.engine} size={13} />
                          <strong style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
                            {preset.name}
                          </strong>
                          <span
                            style={{
                              marginLeft: 'auto',
                              fontSize: '10.5px',
                              padding: '1px 6px',
                              borderRadius: '999px',
                              background: 'var(--chip-fill, rgba(255,255,255,0.06))',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {preset.roleBadge}
                          </span>
                        </div>
                        <small
                          style={{
                            fontSize: '11.5px',
                            lineHeight: 1.35,
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {preset.summary}
                        </small>
                      </button>
                    );
                  })}
                </div>
                <p className="form-field__hint">
                  Pick a preset to pre-fill a specialized teammate, or customize any field below.
                </p>
              </fieldset>

              <div className="form-field">
                <label htmlFor="agent-name">Name</label>
                <input
                  ref={nameInputRef}
                  id="agent-name"
                  className="ui-field ui-field--large"
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    setName(e.currentTarget.value);
                    setError(null);
                  }}
                  placeholder="e.g. Orion, Frontend Specialist, Security Auditor"
                />
              </div>

              <AgentAvatarCustomizer
                effectiveId={faceSeed}
                customAvatar={avatar}
                saving={creating}
                onUpdateAvatar={setAvatar}
                onResetAvatar={() => setAvatar(null)}
              />

              <fieldset className="form-field">
                <legend>Powered by</legend>
                <div className="engine-grid">
                  {TEAMMATE_ENGINE_IDS.map((engineId) => {
                    const isSelected = engine === engineId;
                    return (
                      <button
                        key={engineId}
                        type="button"
                        aria-pressed={isSelected}
                        className={`engine-chip${isSelected ? ' engine-chip--selected' : ''}`}
                        disabled={creating}
                        onClick={() => setEngine(engineId)}
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
                <p className="form-field__hint">
                  Antigravity, Claude Code, Codex, Grok, OpenCode, Cursor, and Gemini all support direct Agent Chat with memory and skills.
                </p>
              </fieldset>

              <div className="form-field">
                <label htmlFor="agent-model">Model</label>
                <SelectMenu
                  variant="field"
                  label="Model"
                  value={defaultModel || AUTOMATIC_MODEL_ID}
                  triggerLabel={
                    modelRows.find((row) => row.id === (defaultModel || AUTOMATIC_MODEL_ID))?.title ||
                    'Automatic'
                  }
                  disabled={creating}
                  rows={modelRows}
                  emptyLabel={modelsNote || catalogEmptyMessage(catalogKind, engineToChatProvider(engine))}
                  onSelect={(id) => setDefaultModel(id === AUTOMATIC_MODEL_ID ? null : id)}
                />
                {modelsNote ? <p className="form-field__hint">{modelsNote}</p> : null}
              </div>

              <div className="form-field">
                <label htmlFor="agent-purpose">Brief</label>
                <textarea
                  id="agent-purpose"
                  className="ui-field ui-field--area"
                  maxLength={4000}
                  rows={6}
                  value={purpose}
                  onChange={(e) => setPurpose(e.currentTarget.value)}
                  placeholder="Describe this agent's mission, coding standards, and responsibilities…"
                />
                <p className="form-field__hint">
                  Optional, and worth writing. It leads the briefing on every turn — the job, the standards, the voice. Everything past this the agent learns on its own.
                </p>
              </div>

              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </div>

          <footer className="agent-editor__footer">
            <p data-tone={duplicateName ? 'warning' : undefined} role="status">
              {duplicateName
                ? 'An agent with this name already exists.'
                : 'Chat-enabled engines (Antigravity, Claude Code, Grok, OpenCode, Codex, Cursor, Gemini) include persistent memory and skills.'}
            </p>
            <button
              type="button"
              className="secondary-button action-button--row agent-editor__cancel"
              disabled={creating}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="secondary-button action-button--row agent-editor__ai"
              disabled={creating}
              onClick={() => {
                setError(null);
                setStage({ kind: 'idle', seed: purpose });
              }}
              title="Say what the job is — Kite writes the name and the brief"
            >
              <span aria-hidden="true" className="action-button__icon">
                <SparklesIcon strokeWidth={2.25} />
              </span>
              Create with AI
            </button>
            <button
              type="submit"
              className="primary-button action-button--row agent-editor__create"
              disabled={!canSubmit}
              title="Create Agent (Ctrl+Enter)"
            >
              {creating ? 'Creating…' : 'Create Agent'}
            </button>
          </footer>
        </form>
      ) : (
        <AgentDraftStagePanel
          stage={stage}
          engine={engine}
          error={error}
          onStartDraft={handleStartDraft}
          onCancelDraft={handleCancelDraft}
          onAbandonReady={handleAbandonReady}
          onAcceptReady={handleAcceptReady}
          onRetryCleanup={handleRetryCleanup}
          onBackToDetails={() => setStage(null)}
          onUpdateDraftName={(draftName) => {
            if (stage.kind === 'ready') {
              setStage({
                ...stage,
                draft: { ...stage.draft, name: draftName },
              });
            }
          }}
          onUpdateDraftBrief={(draftBrief) => {
            if (stage.kind === 'ready') {
              setStage({
                ...stage,
                draft: { ...stage.draft, brief: draftBrief },
              });
            }
          }}
          onSelectPresetForDraft={(preset) => {
            setEngine(preset.engine);
          }}
        />
      )}
    </section>
  );
};
