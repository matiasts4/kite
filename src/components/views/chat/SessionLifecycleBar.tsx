import React from 'react';
import { formatTokens } from './types';
import type { SessionLifecycle, SessionProjection } from '../../../lib/session/types';

export const SESSION_LIFECYCLE_LABELS: Record<SessionLifecycle, string> = {
  creating: 'Creating session',
  attaching: 'Attaching session',
  running: 'Session running',
  waiting: 'Waiting for approval',
  idle: 'Session warm',
  completed: 'Session completed',
  interrupted: 'Session interrupted',
  failed: 'Session failed',
  resumable: 'Session resumable',
  reaped: 'Session sleeping',
  resurrecting: 'Resurrecting session',
  closed: 'Session closed',
};

type LifecycleTone = 'neutral' | 'active' | 'attention' | 'done' | 'error';

const LIFECYCLE_TONES: Record<SessionLifecycle, LifecycleTone> = {
  creating: 'neutral',
  attaching: 'neutral',
  running: 'active',
  waiting: 'attention',
  idle: 'active',
  completed: 'done',
  interrupted: 'done',
  failed: 'error',
  resumable: 'neutral',
  reaped: 'neutral',
  resurrecting: 'active',
  closed: 'done',
};

const TONE_COLORS: Record<LifecycleTone, string> = {
  neutral: 'var(--text-faint)',
  active: 'var(--status-running)',
  attention: 'var(--warning-text)',
  done: 'var(--text-secondary)',
  error: 'var(--status-failed)',
};

function bindingSummary(projection: SessionProjection): string | null {
  const binding = projection.binding;
  if (!binding) return null;
  const parts = [binding.driver, binding.model, binding.effort].filter(
    (part): part is string => Boolean(part && part.trim().length > 0)
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

function approvalSummary(projection: SessionProjection): string | null {
  const count = projection.pendingApprovals.length;
  if (count === 0) return null;
  return count === 1 ? '1 approval waiting' : `${count} approvals waiting`;
}

function usageSummary(projection: SessionProjection): string | null {
  if (!projection.usage) return null;
  const total = projection.usage.inputTokens + projection.usage.outputTokens;
  return total > 0 ? formatTokens(total) : null;
}

export interface SessionLifecycleBarProps {
  projection?: SessionProjection | null;
}

/**
 * A single status line for the provider session attached to an existing thread.
 * It is not a task card: it renders the lifecycle and the binding metadata the
 * projection already carries.
 */
export const SessionLifecycleBar: React.FC<SessionLifecycleBarProps> = ({ projection }) => {
  if (!projection) return null;

  const tone = LIFECYCLE_TONES[projection.lifecycle];
  const binding = bindingSummary(projection);
  const approvals = approvalSummary(projection);
  const usage = usageSummary(projection);
  const trailing = approvals ?? usage;

  return (
    <div
      className="chat-session-lifecycle"
      data-lifecycle={projection.lifecycle}
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        width: '100%',
        maxWidth: 'var(--chat-column, 720px)',
        margin: '0 auto',
        padding: '0 2px var(--space-1)',
        minWidth: 0,
        color: 'var(--text-secondary)',
        fontSize: 'var(--text-caption)',
        lineHeight: 'var(--leading-caption)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: 'none',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: TONE_COLORS[tone],
        }}
      />
      <span
        style={{
          flex: 'none',
          color: 'var(--text-primary)',
          fontWeight: 'var(--weight-medium)',
          whiteSpace: 'nowrap',
        }}
      >
        {SESSION_LIFECYCLE_LABELS[projection.lifecycle]}
      </span>
      {binding && (
        <span
          title={binding}
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {binding}
        </span>
      )}
      {trailing && (
        <span
          title={approvals ? 'Approvals waiting for your decision' : 'Tokens used by this session'}
          style={{
            marginLeft: 'auto',
            flex: 'none',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {trailing}
        </span>
      )}
    </div>
  );
};
