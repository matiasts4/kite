import React from 'react';
import { ShieldIcon } from './ChatIcons';
import { UnifiedDiffView } from './UnifiedDiffView';
import type { ApprovalRequest } from './types';

const RISK_LABELS: Record<string, string> = {
  creditUse: 'May use credits',
  externalWrite: 'External action',
  command: 'Command',
  fileChange: 'File change',
  unknown: 'Approval needed',
};

interface ChatApprovalCardProps {
  approval: ApprovalRequest;
  busy?: boolean;
  disabled?: boolean;
  onDecision: (
    decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
    requestId: string
  ) => void;
}

export const ChatApprovalCard: React.FC<ChatApprovalCardProps> = ({
  approval,
  busy = false,
  disabled = false,
  onDecision,
}) => {
  const isLocked = busy || disabled;
  const isDiff = approval.detail && (
    approval.risk === 'fileChange' ||
    approval.toolName === 'edit' ||
    approval.toolName === 'write' ||
    approval.detail.includes('@@') ||
    approval.detail.startsWith('diff --git') ||
    approval.detail.startsWith('---')
  );

  return (
    <section
      className="chat-approval-card motion-row-in"
      role="alert"
      aria-busy={busy || undefined}
      aria-label={`Approval needed for ${approval.title || approval.toolName}`}
      data-testid="chat-approval-card"
    >
      <header className="chat-approval-card__band">
        <ShieldIcon size={12} strokeWidth={2.4} style={{ color: 'var(--warning-text, #fbbf24)' }} />
        <span>{RISK_LABELS[approval.risk] || 'Approval needed'}</span>
      </header>

      <div className="chat-approval-card__body">
        <strong>{approval.title || approval.toolName}</strong>
        {approval.impact && <p>{approval.impact}</p>}
        {approval.detail && (
          isDiff ? (
            <div style={{ margin: 'var(--space-2) 0', borderRadius: 'var(--radius-card)', border: '1px solid var(--block-stroke)', background: 'var(--block-fill)', overflowX: 'auto', padding: 'var(--space-2)' }}>
              <UnifiedDiffView diff={approval.detail} />
            </div>
          ) : (
            <code
              className="chat-approval-card__detail"
              data-testid="chat-approval-detail"
              tabIndex={0}
            >
              {approval.detail}
            </code>
          )
        )}
      </div>

      <footer className="chat-approval-card__actions">
        <button
          type="button"
          disabled={isLocked}
          onClick={() => onDecision('allowOnce', approval.id)}
          className="chat-approval-card__button primary-button"
        >
          Allow
        </button>
        <button
          type="button"
          disabled={isLocked}
          onClick={() => onDecision('allowForSession', approval.id)}
          className="chat-approval-card__button ghost-button"
        >
          Allow for session
        </button>
        <span aria-hidden="true" className="chat-approval-card__spacer" />
        <button
          type="button"
          disabled={isLocked}
          onClick={() => onDecision('deny', approval.id)}
          className="chat-approval-card__button ghost-button"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={isLocked}
          onClick={() => onDecision('denyAndStop', approval.id)}
          className="chat-approval-card__button danger danger-button"
        >
          Deny and stop
        </button>
      </footer>
    </section>
  );
};
