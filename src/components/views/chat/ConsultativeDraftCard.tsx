import React from 'react';
import {
  useVoiceSession,
  voiceSessionStore,
  type DraftStepStatus,
  type DraftTaskProposal,
} from '../../../lib/operator/voice/voiceSessionStore';

export interface ConsultativeDraftCardProps {
  threadId?: string | null;
  compact?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
}

const TARGET_LABELS: Record<DraftTaskProposal['targetKind'], string> = {
  subagent: 'Subagente',
  thread: 'Hilo',
  agent: 'Agente',
  terminal: 'Terminal',
};

const STEP_STATUS_META: Record<
  DraftStepStatus,
  { label: string; bg: string; color: string }
> = {
  pending: {
    label: 'Pendiente',
    bg: 'var(--chip-fill, rgba(255, 255, 255, 0.08))',
    color: 'var(--text-secondary, #c4c4cc)',
  },
  running: {
    label: 'Ejecutando',
    bg: 'var(--accent-tint, rgba(59, 130, 246, 0.18))',
    color: 'var(--accent, #60a5fa)',
  },
  done: {
    label: 'Listo',
    bg: 'rgba(16, 185, 129, 0.16)',
    color: '#34d399',
  },
  failed: {
    label: 'Error',
    bg: 'rgba(239, 68, 68, 0.16)',
    color: '#f87171',
  },
  skipped: {
    label: 'Omitido',
    bg: 'rgba(148, 163, 184, 0.14)',
    color: 'var(--text-secondary, #94a3b8)',
  },
};

export const ConsultativeDraftCard: React.FC<ConsultativeDraftCardProps> = ({
  threadId,
  compact = false,
  onConfirm,
  onCancel,
}) => {
  const voice = useVoiceSession();
  const proposal = voice.draftProposal;

  if (
    !proposal ||
    (proposal.status !== 'awaiting_confirmation' &&
      proposal.status !== 'drafting' &&
      proposal.status !== 'executing')
  ) {
    return null;
  }

  const steps = Array.isArray(proposal.steps) ? proposal.steps : [];
  const isMultiStep = steps.length > 0;
  const enabledStepsCount = steps.filter((s) => s.enabled).length;
  const isExecuting = proposal.status === 'executing';
  const confirmDisabled = isExecuting || (isMultiStep && enabledStepsCount === 0);

  const targetLabel = isMultiStep
    ? `Plan (${enabledStepsCount}/${steps.length})`
    : TARGET_LABELS[proposal.targetKind] ?? 'Subagente';
  const statusLabel =
    proposal.status === 'executing'
      ? 'Ejecutando plan'
      : proposal.status === 'awaiting_confirmation'
        ? 'Esperando confirmación'
        : 'Borrador';

  const effectiveScope = threadId ?? voice.boundThreadId;

  const handleConfirm = () => {
    if (confirmDisabled) return;
    if (onConfirm) {
      void onConfirm();
      return;
    }
    if (effectiveScope && voiceSessionStore.hasTextTurnExecutor()) {
      void voiceSessionStore.submitTextTurn('confirmar', effectiveScope);
    }
  };

  const handleCancel = () => {
    voiceSessionStore.clearDraftProposal(effectiveScope);
    onCancel?.();
  };

  const handleToggleStep = (stepId: string) => {
    if (isExecuting) return;
    voiceSessionStore.toggleDraftProposalStep(effectiveScope, stepId);
  };

  return (
    <section
      data-testid="consultative-draft-card"
      data-status={proposal.status}
      data-target={proposal.targetKind}
      aria-label={`Propuesta de ${targetLabel}: ${proposal.title}`}
      style={{
        width: compact ? '100%' : undefined,
        maxWidth: compact ? '340px' : '720px',
        margin: compact ? '8px 0 0' : '0 auto 8px',
        padding: compact ? '10px 12px' : '12px 14px',
        borderRadius: 'var(--card-radius, 12px)',
        border: '1px solid var(--glass-border, var(--block-stroke, rgba(255, 255, 255, 0.14)))',
        background: 'var(--glass-elevated-bg, var(--composer, rgba(24, 28, 38, 0.94)))',
        color: 'var(--text-primary, #f4f4f6)',
        boxShadow: 'var(--glass-shadow, 0 6px 20px rgba(0, 0, 0, 0.35))',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        pointerEvents: 'auto',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              padding: '2px 7px',
              borderRadius: 'var(--vl-radius-sm, 6px)',
              background: 'var(--accent-tint, rgba(59, 130, 246, 0.16))',
              color: 'var(--accent, #60a5fa)',
            }}
          >
            {targetLabel}
          </span>
          {proposal.role ? (
            <span
              style={{
                fontSize: '11px',
                fontWeight: 500,
                padding: '2px 7px',
                borderRadius: 'var(--vl-radius-sm, 6px)',
                background: 'var(--chip-fill, rgba(255, 255, 255, 0.08))',
                color: 'var(--text-primary, #f4f4f6)',
              }}
            >
              {proposal.role}
            </span>
          ) : null}
          {proposal.provider ? (
            <span
              style={{
                fontSize: '11px',
                fontWeight: 500,
                padding: '2px 7px',
                borderRadius: 'var(--vl-radius-sm, 6px)',
                background: 'var(--chip-fill, rgba(255, 255, 255, 0.06))',
                color: 'var(--text-secondary, #c4c4cc)',
              }}
            >
              {proposal.provider}
            </span>
          ) : null}
          {proposal.oddMode ? (
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '2px 7px',
                borderRadius: 'var(--vl-radius-sm, 6px)',
                background: 'rgba(16, 185, 129, 0.14)',
                color: '#34d399',
              }}
            >
              ODD
            </span>
          ) : null}
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary, #c4c4cc)' }}>
          {statusLabel}
        </span>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <strong style={{ fontSize: '13px', fontWeight: 600, lineHeight: 1.35 }}>
          {proposal.title}
        </strong>
        {proposal.taskBrief ? (
          <p
            style={{
              margin: 0,
              fontSize: '12px',
              lineHeight: 1.45,
              color: 'var(--text-secondary, #c4c4cc)',
            }}
          >
            {proposal.taskBrief}
          </p>
        ) : null}

        {isMultiStep ? (
          <ul
            data-testid="consultative-draft-steps"
            style={{
              listStyle: 'none',
              margin: '4px 0 0',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            {steps.map((step, index) => {
              const badge = STEP_STATUS_META[step.status] ?? STEP_STATUS_META.pending;
              return (
                <li
                  key={step.stepId}
                  data-testid={`draft-step-row-${step.stepId}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '6px 8px',
                    borderRadius: 'var(--control-radius, 8px)',
                    background: 'var(--chip-fill, rgba(255, 255, 255, 0.04))',
                    border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
                    opacity: step.enabled ? 1 : 0.6,
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '12px',
                      cursor: isExecuting ? 'default' : 'pointer',
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      data-testid={`draft-step-toggle-${step.stepId}`}
                      checked={step.enabled}
                      disabled={isExecuting}
                      onChange={() => handleToggleStep(step.stepId)}
                      style={{
                        borderRadius: 'var(--vl-radius-xs, 4px)',
                      }}
                    />
                    <span style={{ color: 'var(--text-secondary, #c4c4cc)', fontWeight: 600 }}>
                      {index + 1}.
                    </span>
                    <span
                      style={{
                        textDecoration: step.enabled ? 'none' : 'line-through',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {step.title}
                    </span>
                  </label>
                  <span
                    data-testid={`draft-step-status-${step.stepId}`}
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '2px 7px',
                      borderRadius: 'var(--vl-radius-sm, 6px)',
                      background: badge.bg,
                      color: badge.color,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {badge.label}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        {proposal.questionForUser ? (
          <p
            style={{
              margin: '2px 0 0',
              fontSize: '12px',
              lineHeight: 1.4,
              color: 'var(--text-primary, #f4f4f6)',
            }}
          >
            {proposal.questionForUser}
          </p>
        ) : null}
      </div>

      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '8px',
        }}
      >
        <button
          type="button"
          className="secondary-button"
          onClick={handleCancel}
          disabled={isExecuting}
          style={{
            height: '32px',
            borderRadius: 'var(--control-radius, 8px)',
            padding: '0 12px',
          }}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={handleConfirm}
          disabled={confirmDisabled}
          style={{
            height: '32px',
            borderRadius: 'var(--control-radius, 8px)',
            padding: '0 14px',
          }}
        >
          Confirmar
        </button>
      </footer>
    </section>
  );
};

export default ConsultativeDraftCard;
