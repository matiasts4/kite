import React, { useState, useId } from 'react';
import { FileCodeIcon } from './ChatIcons';
import { MarkdownMessage } from './MarkdownMessage';

export type PlanStatus = 'ready' | 'revising' | 'implementing' | 'completed' | 'interrupted' | 'failed';

export interface ProposedPlan {
  id: string;
  revision: number;
  sourceTurnId?: string;
  markdown: string;
  status: PlanStatus;
}

export interface PlanActionPayload {
  kind: 'new' | 'revise' | 'implement';
  planId?: string;
  revision?: number;
}

export interface ChatPlanPanelProps {
  plan: ProposedPlan;
  disabled?: boolean;
  onSend: (text: string, planAction?: PlanActionPayload) => Promise<boolean | void> | void;
}

const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  ready: 'Ready for review',
  revising: 'Revising plan',
  implementing: 'Implementing plan',
  completed: 'Plan completed',
  interrupted: 'Interrupted',
  failed: 'Implementation failed',
};

function extractPlanTitle(markdown: string): string {
  const line = markdown.split('\n').find((l) => l.trim().length > 0);
  if (!line) return 'Proposed Plan';
  const match = line.match(/^#+\s*(.+)$/);
  return match ? match[1].trim() : 'Proposed Plan';
}

export const ChatPlanPanel: React.FC<ChatPlanPanelProps> = ({
  plan,
  disabled = false,
  onSend,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [formMode, setFormMode] = useState<'revise' | 'new' | null>(null);
  const [inputText, setInputText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const contentId = useId();
  const inputId = useId();
  const isBusy = disabled || isSubmitting;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(plan.markdown);
      setStatusMessage('Copied');
      setTimeout(() => setStatusMessage(''), 2000);
    } catch {
      setStatusMessage('Could not copy. Select the plan text to copy it.');
    }
  };

  const executeSend = async (text: string, action: PlanActionPayload) => {
    if (isBusy) return;
    setIsSubmitting(true);
    try {
      await onSend(text, action);
      setFormMode(null);
      setInputText('');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    const action: PlanActionPayload =
      formMode === 'new'
        ? { kind: 'new' }
        : { kind: 'revise', planId: plan.id, revision: plan.revision };
    void executeSend(inputText.trim(), action);
  };

  return (
    <section className="chat-plan-panel" aria-label="Proposed plan">
      <div className="chat-plan-panel__head">
        <button
          type="button"
          className="chat-plan-panel__title"
          aria-controls={expanded ? contentId : undefined}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Hide the plan' : 'Read the full plan'}
        >
          <FileCodeIcon size={12} strokeWidth={2} />
          <span>{extractPlanTitle(plan.markdown)}</span>
        </button>
        <span className="chat-plan-panel__status">
          v{plan.revision} · {PLAN_STATUS_LABELS[plan.status] || plan.status}
        </span>
      </div>

      {expanded && (
        <div className="chat-plan-panel__markdown" id={contentId}>
          <MarkdownMessage text={plan.markdown} />
        </div>
      )}

      <div className="chat-plan-panel__actions">
        <button
          type="button"
          className="secondary-button action-button--row chat-plan-panel__action"
          disabled={isBusy}
          onClick={() => setFormMode('revise')}
        >
          Revise
        </button>
        <button
          type="button"
          className="secondary-button action-button--row chat-plan-panel__action"
          onClick={handleCopy}
        >
          Copy
        </button>
        <button
          type="button"
          className="secondary-button action-button--row chat-plan-panel__action"
          disabled={isBusy}
          onClick={() => setFormMode('new')}
        >
          New plan
        </button>
        <button
          type="button"
          className="secondary-button action-button--row chat-plan-panel__action"
          disabled={isBusy || plan.status !== 'ready'}
          title="Switch to Agent and implement this revision under the current permissions"
          onClick={() =>
            void executeSend('Implement the reviewed plan.', {
              kind: 'implement',
              planId: plan.id,
              revision: plan.revision,
            })
          }
        >
          {isSubmitting ? 'Starting…' : 'Implement'}
        </button>
      </div>

      <span role="status" className="sr-only">
        {statusMessage}
      </span>

      {formMode ? (
        <form className="chat-plan-panel__form" onSubmit={handleFormSubmit}>
          <label htmlFor={inputId}>
            {formMode === 'new'
              ? 'What should the new plan cover?'
              : 'What should change in this plan?'}
          </label>
          <textarea
            id={inputId}
            className="ui-field ui-field--area"
            rows={3}
            maxLength={32000}
            disabled={isBusy}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type instructions for the plan..."
          />
          <div className="chat-plan-panel__form-actions">
            <button
              type="button"
              className="ghost-button action-button--row"
              disabled={isSubmitting}
              onClick={() => setFormMode(null)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button action-button--row"
              disabled={isBusy || !inputText.trim()}
            >
              {formMode === 'new' ? 'Create plan' : 'Revise plan'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
};
