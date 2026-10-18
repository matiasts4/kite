import React, { useEffect, useRef, useState } from 'react';
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

const DRAFT_SCHEMA_VERSION = 1;

interface AgentDraftResult {
  requestId: string;
  draft: { name: string; brief: string };
}

type DraftStage =
  | { kind: 'idle'; seed: string }
  | { kind: 'drafting'; requestId: string; seed: string; cancelling: boolean }
  | {
      kind: 'ready';
      requestId: string;
      seed: string;
      draft: { name: string; brief: string };
      accepting: boolean;
      abandoning: boolean;
      error: string | null;
    }
  | { kind: 'cleanupRequired'; message: string; retrying: boolean }
  | { kind: 'error'; seed: string; message: string };

export interface AgentCreatePaneProps {
  agents?: AgentProfile[];
  onCreated: (agent: AgentProfile) => void;
  onCancel: () => void;
}

const SparklesIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({
  size = 14,
  strokeWidth = 2,
}) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    <path d="M20 3v4" />
    <path d="M22 5h-4" />
    <path d="M4 17v2" />
    <path d="M5 18H3" />
  </svg>
);

const UserRoundPlusIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
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
    <path d="M2 21a8 8 0 0 1 13.292-6" />
    <circle cx="10" cy="8" r="5" />
    <path d="M19 16v6" />
    <path d="M22 19h-6" />
  </svg>
);

const AudioLinesIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 13,
  className = '',
}) => (
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
    className={className}
  >
    <path d="M2 10v3" />
    <path d="M6 6v11" />
    <path d="M10 3v18" />
    <path d="M14 8v7" />
    <path d="M18 5v13" />
    <path d="M22 10v3" />
  </svg>
);

const CheckIcon: React.FC<{ size?: number; className?: string }> = ({
  size = 12,
  className = '',
}) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const CloseIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
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
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const ArrowLeftIcon: React.FC<{ size?: number }> = ({ size = 13 }) => (
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
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </svg>
);

const RotateCcwIcon: React.FC<{ size?: number }> = ({ size = 13 }) => (
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
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export interface SpecialistAgentPreset {
  id: string;
  name: string;
  roleBadge: string;
  engine: string;
  summary: string;
  brief: string;
}

export const SPECIALIST_AGENT_PRESETS: SpecialistAgentPreset[] = [
  {
    id: 'architect',
    name: 'Orion',
    roleBadge: 'Software Architect',
    engine: 'antigravity',
    summary: 'System design, CodeGraph dependency analysis, and clean module boundaries.',
    brief:
      'Own system architecture, structural refactoring, and dependency health across the codebase.\n\n## Execution Standards\n- Inspect call graphs and blast radius before proposing structural changes.\n- Keep module boundaries explicit, decoupled, and easy to reason about.\n- Document trade-offs clearly and verify no regressions are introduced.',
  },
  {
    id: 'frontend',
    name: 'Nova',
    roleBadge: 'Frontend & UI Specialist',
    engine: 'claude-code',
    summary: 'React, TypeScript, CSS layout polish, responsive UI, and visual bug fixes.',
    brief:
      'Own frontend interfaces, React components, CSS styling, layout fidelity, and UX interactions.\n\n## Execution Standards\n- Build accessible, responsive, and visually polished interfaces.\n- Eliminate layout shifts, flexbox/grid overflow issues, and visual glitches.\n- Follow the project design system tokens and verify component behavior.',
  },
  {
    id: 'debugger',
    name: 'Sherlock',
    roleBadge: 'Root-Cause Debugger',
    engine: 'antigravity',
    summary: 'Trace crashes, errors, and regressions back to the exact producing change.',
    brief:
      'Investigate bugs, runtime errors, and test failures down to their exact root cause.\n\n## Execution Standards\n- Reproduce or trace the failure path before writing any fix.\n- Fix the underlying cause rather than masking symptoms with workarounds.\n- Add or run targeted tests to ensure the bug cannot silently return.',
  },
  {
    id: 'reviewer',
    name: 'Aegis',
    roleBadge: 'Code & Security Auditor',
    engine: 'claude-code',
    summary: 'Strict PR reviews, security checks, edge cases, and maintainability.',
    brief:
      'Audit code changes for bugs, security vulnerabilities, race conditions, and maintainability.\n\n## Execution Standards\n- Prioritize P0/P1 correctness, security, and data-safety issues.\n- Flag unhandled edge cases, type unsafety, and performance bottlenecks.\n- Provide concrete, actionable fixes for every finding.',
  },
  {
    id: 'backend',
    name: 'Atlas',
    roleBadge: 'Backend & Systems',
    engine: 'codex',
    summary: 'Rust, Tauri IPC commands, state persistence, concurrency, and performance.',
    brief:
      'Own Rust backend modules, Tauri IPC commands, file persistence, and process management.\n\n## Execution Standards\n- Write safe, idiomatic Rust with clear error handling and no panics on user input.\n- Keep IPC contracts deterministic and backwards-compatible.\n- Validate concurrency, locks, and resource cleanup.',
  },
  {
    id: 'release',
    name: 'Hermes',
    roleBadge: 'Release & Automation',
    engine: 'grok',
    summary: 'Build pipelines, CI/CD scripts, versioning, changelogs, and fast automation.',
    brief:
      'Manage build scripts, release workflows, version bumps, and developer automation.\n\n## Execution Standards\n- Keep build and release pipelines reproducible and fast.\n- Verify compilation, tests, and artifact integrity before publishing.\n- Write clear, concrete release notes for builders.',
  },
];

export const AgentCreatePane: React.FC<AgentCreatePaneProps> = ({
  agents = [],
  onCreated,
  onCancel,
}) => {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [engine, setEngine] = useState('antigravity');
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
  const seedInputRef = useRef<HTMLTextAreaElement>(null);
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

  const trimmedName = name.trim();
  const duplicateName =
    trimmedName.length > 0 &&
    agents.some((a) => a.name.toLowerCase() === trimmedName.toLowerCase());
  const canSubmit = trimmedName.length > 0 && !duplicateName && !creating;

  const handleApplyPreset = (preset: SpecialistAgentPreset) => {
    setSelectedPresetId(preset.id);
    // Avoid duplicate name if preset name is already taken
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
      ) : stage.kind === 'idle' ? (
        <form
          className="ai-create-stage"
          data-state="idle"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              void handleStartDraft(String(fd.get('seed') ?? ''));
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            void handleStartDraft(String(fd.get('seed') ?? ''));
          }}
        >
          <div className="ai-create-stage__scroll">
            <div className="ai-create-stage__column">
              <div className="ai-create-stage__intro">
                <span aria-hidden="true" className="ai-create-stage__mark">
                  <SparklesIcon size={22} />
                </span>
                <div>
                  <h2>What should this teammate own?</h2>
                  <p>
                    Describe the role, responsibilities, and standards (in Spanish or English). Kite synthesizes a focused specialist name and charter that you can refine before saving.
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '4px' }}>
                {SPECIALIST_AGENT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="secondary-button"
                    style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                    onClick={() => {
                      if (seedInputRef.current) {
                        seedInputRef.current.value = `${preset.roleBadge}: ${preset.summary}`;
                        seedInputRef.current.focus();
                      }
                      setEngine(preset.engine);
                    }}
                  >
                    + {preset.roleBadge}
                  </button>
                ))}
              </div>

              <label htmlFor="agent-ai-seed">Agent description</label>
              <textarea
                ref={seedInputRef}
                defaultValue={stage.seed}
                id="agent-ai-seed"
                maxLength={8192}
                name="seed"
                rows={7}
                placeholder="Ej: Especialista en Frontend React y CSS que corrige bugs visuales, cuida el diseño responsive y mantiene componentes limpios…"
              />
              <p className="ai-create-stage__engine">
                The saved Agent will be powered by <strong>{getEngineDisplayName(engine)}</strong>.
              </p>
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
          <footer className="agent-editor__footer">
            <p>Use Ctrl+Enter to draft.</p>
            <button
              type="button"
              className="secondary-button action-button--row"
              onClick={() => setStage(null)}
            >
              <span aria-hidden="true" className="action-button__icon">
                <ArrowLeftIcon />
              </span>
              Back to details
            </button>
            <button type="submit" className="primary-button action-button--row">
              <span aria-hidden="true" className="action-button__icon">
                <SparklesIcon strokeWidth={2.25} />
              </span>
              Draft Agent
            </button>
          </footer>
        </form>
      ) : stage.kind === 'drafting' ? (
        <div aria-busy="true" className="ai-create-stage ai-create-stage--center" data-state="drafting">
          <div aria-live="polite" className="ai-create-stage__working" role="status">
            <span aria-hidden="true" className="loading-spinner ai-create-stage__spinner" />
            <h2>{stage.cancelling ? 'Stopping safely…' : 'Writing the charter…'}</h2>
            <p>
              {stage.cancelling
                ? 'Kite is retiring this request before another draft can begin.'
                : 'Kite is turning the job into a focused name and working brief.'}
            </p>
          </div>
          <footer className="agent-editor__footer">
            <p>The native runtime enforces the deadline and ignores stale completions.</p>
            <button
              type="button"
              className="secondary-button action-button--row"
              disabled={stage.cancelling}
              onClick={() => void handleCancelDraft()}
            >
              {stage.cancelling ? 'Cancelling…' : 'Cancel request'}
            </button>
          </footer>
        </div>
      ) : stage.kind === 'ready' ? (
        <div className="ai-create-stage" data-state="ready">
          <div className="ai-create-stage__scroll">
            <div className="ai-create-stage__column ai-create-stage__column--ready">
              <div aria-live="polite" className="ai-create-stage__ready-heading" role="status">
                <span aria-hidden="true">
                  <CheckIcon size={16} />
                </span>
                <div>
                  <h2>Meet {stage.draft.name}</h2>
                  <p>Review or customize the generated name and charter before saving.</p>
                </div>
              </div>
              <div className="ai-draft-preview" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <span>Name</span>
                  <input
                    type="text"
                    className="ui-field"
                    value={stage.draft.name}
                    onChange={(e) =>
                      setStage({
                        ...stage,
                        draft: { ...stage.draft, name: e.target.value },
                      })
                    }
                    style={{ marginTop: '4px', width: '100%' }}
                  />
                </div>
                <div>
                  <span>Brief</span>
                  <textarea
                    className="ui-field ui-field--area"
                    rows={6}
                    value={stage.draft.brief}
                    onChange={(e) =>
                      setStage({
                        ...stage,
                        draft: { ...stage.draft, brief: e.target.value },
                      })
                    }
                    style={{ marginTop: '4px', width: '100%' }}
                  />
                </div>
                <div>
                  <span>Powered by</span>
                  <strong>{getEngineDisplayName(engine)}</strong>
                </div>
              </div>
              {stage.error ? (
                <p className="form-error" role="alert">
                  {stage.error}
                </p>
              ) : null}
            </div>
          </div>
          <footer className="agent-editor__footer">
            <p>Accepting saves this Agent once and opens its Chats face.</p>
            <button
              type="button"
              className="secondary-button action-button--row"
              disabled={stage.accepting || stage.abandoning}
              onClick={() => void handleAbandonReady(false)}
            >
              {stage.abandoning ? 'Cleaning up…' : 'Discard draft'}
            </button>
            <button
              type="button"
              className="primary-button action-button--row"
              disabled={stage.accepting || stage.abandoning || !stage.draft.name.trim()}
              onClick={() => void handleAcceptReady()}
            >
              {stage.accepting ? <span aria-hidden="true" className="button-spinner" /> : null}
              {stage.accepting ? 'Saving…' : 'Accept Agent'}
            </button>
          </footer>
        </div>
      ) : stage.kind === 'cleanupRequired' ? (
        <div className="ai-create-stage ai-create-stage--center" data-state="cleanup-required">
          <div aria-live="assertive" className="ai-create-stage__problem" role="alert">
            <RotateCcwIcon size={22} />
            <h2>Cleanup needs your connection</h2>
            <p>{stage.message}</p>
            <p>The editor will stay open so a hosted Agent row is never silently orphaned.</p>
            <button
              type="button"
              className="primary-button"
              disabled={stage.retrying}
              onClick={() => void handleRetryCleanup()}
            >
              <RotateCcwIcon size={13} />
              {stage.retrying ? 'Retrying cleanup…' : 'Retry cleanup'}
            </button>
          </div>
        </div>
      ) : (
        <div className="ai-create-stage ai-create-stage--center" data-state="error">
          <div aria-live="assertive" className="ai-create-stage__problem" role="alert">
            <CloseIcon size={22} />
            <h2>The draft did not finish</h2>
            <p>{stage.message}</p>
            <div className="ai-create-stage__problem-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStage(null)}
              >
                Back to details
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleStartDraft(stage.seed)}
              >
                <RotateCcwIcon size={13} />
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
