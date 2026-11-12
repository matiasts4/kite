import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionLifecycleBar, SESSION_LIFECYCLE_LABELS } from './SessionLifecycleBar';
import {
  SESSION_LIFECYCLES,
  type SessionLifecycle,
  type SessionProjection,
} from '../../../lib/session/types';

function projection(
  lifecycle: SessionLifecycle,
  overrides: Partial<SessionProjection> = {}
): SessionProjection {
  const base: SessionProjection = {
    threadId: 'thread-1',
    lifecycle,
    binding: null,
    items: [],
    plan: null,
    pendingApprovals: [],
    approvalResolutions: [],
    usage: null,
    lastSequence: 0,
    unknownEventCount: 0,
  };
  return { ...base, ...overrides };
}

describe('SessionLifecycleBar', () => {
  it('renders every lifecycle state on the existing thread surface', () => {
    for (const lifecycle of SESSION_LIFECYCLES) {
      const { unmount } = render(<SessionLifecycleBar projection={projection(lifecycle)} />);
      const bar = screen.getByRole('status');
      expect(bar).toHaveAttribute('data-lifecycle', lifecycle);
      expect(bar).toHaveTextContent(SESSION_LIFECYCLE_LABELS[lifecycle]);
      unmount();
    }
  });

  it('renders nothing when no session projection is supplied', () => {
    const { container } = render(<SessionLifecycleBar projection={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the binding and usage the projection carries', () => {
    render(
      <SessionLifecycleBar
        projection={projection('running', {
          binding: { driver: 'codex', model: 'gpt-5', effort: 'high' },
          usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0 },
        })}
      />
    );

    expect(screen.getByText(/codex/)).toBeInTheDocument();
    expect(screen.getByText(/gpt-5/)).toBeInTheDocument();
    expect(screen.getByText(/1\.5k tokens/)).toBeInTheDocument();
  });

  it('shows how many approvals are waiting', () => {
    render(
      <SessionLifecycleBar
        projection={projection('waiting', {
          pendingApprovals: [
            {
              id: 'req-1',
              toolName: 'fileChange',
              title: 'Write one file',
              detail: null,
              risk: 'low',
              impact: 'One file',
            },
          ],
        })}
      />
    );

    expect(screen.getByText(/1 approval/)).toBeInTheDocument();
  });
});
