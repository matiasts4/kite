import React, { useRef } from 'react';
import {
  SparklesIcon,
  CheckIcon,
  CloseIcon,
  RotateCcwIcon,
  ArrowLeftIcon,
} from './agentIcons';
import { getEngineDisplayName } from './engineMetadata';
import { SPECIALIST_AGENT_PRESETS, type SpecialistAgentPreset } from './agentPresets';

export interface AgentDraftResult {
  requestId: string;
  draft: { name: string; brief: string };
}

export type DraftStage =
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

export interface AgentDraftStagePanelProps {
  stage: DraftStage;
  engine: string;
  error: string | null;
  onStartDraft: (seedText: string) => void;
  onCancelDraft: () => void;
  onAbandonReady: (closeAfter: boolean) => void;
  onAcceptReady: () => void;
  onRetryCleanup: () => void;
  onBackToDetails: () => void;
  onUpdateDraftName: (name: string) => void;
  onUpdateDraftBrief: (brief: string) => void;
  onSelectPresetForDraft: (preset: SpecialistAgentPreset) => void;
}

export const AgentDraftStagePanel: React.FC<AgentDraftStagePanelProps> = ({
  stage,
  engine,
  error,
  onStartDraft,
  onCancelDraft,
  onAbandonReady,
  onAcceptReady,
  onRetryCleanup,
  onBackToDetails,
  onUpdateDraftName,
  onUpdateDraftBrief,
  onSelectPresetForDraft,
}) => {
  const seedInputRef = useRef<HTMLTextAreaElement>(null);

  if (stage.kind === 'idle') {
    return (
      <form
        className="ai-create-stage"
        data-state="idle"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            void onStartDraft(String(fd.get('seed') ?? ''));
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void onStartDraft(String(fd.get('seed') ?? ''));
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
                    onSelectPresetForDraft(preset);
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
            onClick={onBackToDetails}
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
    );
  }

  if (stage.kind === 'drafting') {
    return (
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
            onClick={onCancelDraft}
          >
            {stage.cancelling ? 'Cancelling…' : 'Cancel request'}
          </button>
        </footer>
      </div>
    );
  }

  if (stage.kind === 'ready') {
    return (
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
                  onChange={(e) => onUpdateDraftName(e.target.value)}
                  style={{ marginTop: '4px', width: '100%' }}
                />
              </div>
              <div>
                <span>Brief</span>
                <textarea
                  className="ui-field ui-field--area"
                  rows={6}
                  value={stage.draft.brief}
                  onChange={(e) => onUpdateDraftBrief(e.target.value)}
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
            onClick={() => onAbandonReady(false)}
          >
            {stage.abandoning ? 'Cleaning up…' : 'Discard draft'}
          </button>
          <button
            type="button"
            className="primary-button action-button--row"
            disabled={stage.accepting || stage.abandoning || !stage.draft.name.trim()}
            onClick={onAcceptReady}
          >
            {stage.accepting ? <span aria-hidden="true" className="button-spinner" /> : null}
            {stage.accepting ? 'Saving…' : 'Accept Agent'}
          </button>
        </footer>
      </div>
    );
  }

  if (stage.kind === 'cleanupRequired') {
    return (
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
            onClick={onRetryCleanup}
          >
            <RotateCcwIcon size={13} />
            {stage.retrying ? 'Retrying cleanup…' : 'Retry cleanup'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-create-stage ai-create-stage--center" data-state="error">
      <div aria-live="assertive" className="ai-create-stage__problem" role="alert">
        <CloseIcon size={22} />
        <h2>The draft did not finish</h2>
        <p>{stage.message}</p>
        <div className="ai-create-stage__problem-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onBackToDetails}
          >
            Back to details
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => onStartDraft(stage.seed)}
          >
            <RotateCcwIcon size={13} />
            Try again
          </button>
        </div>
      </div>
    </div>
  );
};
