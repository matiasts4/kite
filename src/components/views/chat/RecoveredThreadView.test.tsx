import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecoveredThreadView } from './RecoveredThreadView';
import {
  NEW_SESSION_MESSAGE,
  RESUME_ACTION_LABEL,
  parseRecoveredThread,
  recoveryProjection,
} from '../../../lib/session/recovery';

const RECOVERED_PAYLOAD = {
  threadId: 'thread-1',
  source: 'log',
  resumeAvailable: false,
  resumeHandle: null,
  diagnostic: null,
  events: [
    { sequence: 1, kind: 'snapshot', payload: { thread: { id: 'thread-1' } }, atMs: 1000 },
    { sequence: 2, kind: 'field', payload: { name: 'title', value: 'Recovered chat' }, atMs: 1001 },
    {
      sequence: 3,
      kind: 'lifecycle',
      payload: {
        state: 'running',
        binding: { driver: 'codex', provider: 'codex', model: 'gpt-5' },
      },
      atMs: 1002,
    },
    {
      sequence: 4,
      kind: 'item.upsert',
      payload: {
        item: {
          id: 'user-1',
          kind: 'user',
          text: 'Why did the build fail?',
          title: null,
          detail: null,
          status: null,
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 1003,
          attachments: [],
        },
      },
      atMs: 1003,
    },
    {
      sequence: 5,
      kind: 'item.upsert',
      payload: {
        item: {
          id: 'assistant-1',
          kind: 'assistant',
          text: 'The test suite caught a regression.',
          title: null,
          detail: null,
          status: null,
          streaming: false,
          exitCode: null,
          createdAtUnixMs: 1004,
          attachments: [],
        },
      },
      atMs: 1004,
    },
    { sequence: 6, kind: 'lifecycle', payload: { state: 'completed' }, atMs: 1005 },
  ],
  thread: {
    id: 'thread-1',
    title: 'Recovered chat',
    provider: 'codex',
    status: 'idle',
    items: [
      {
        id: 'user-1',
        kind: 'user',
        text: 'Why did the build fail?',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1003,
        attachments: [],
      },
      {
        id: 'assistant-1',
        kind: 'assistant',
        text: 'The test suite caught a regression.',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1004,
        attachments: [],
      },
    ],
    plans: [],
    pendingApproval: null,
    usage: { inputTokens: 12, outputTokens: 34, costUsd: 0 },
  },
};

function loadTwice() {
  const raw = JSON.stringify(RECOVERED_PAYLOAD);
  return [parseRecoveredThread(JSON.parse(raw)), parseRecoveredThread(JSON.parse(raw))] as const;
}

describe('recovered thread view', () => {
  it('renders two views of one recovered thread byte-identically', () => {
    const [first, second] = loadTwice();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).toEqual(second);
    expect(recoveryProjection(first!)).toEqual(recoveryProjection(second!));

    const view = render(
      <div data-view="one">
        <RecoveredThreadView recovered={first!} />
      </div>
    );
    view.rerender(
      <>
        <div data-view="one">
          <RecoveredThreadView recovered={first!} />
        </div>
        <div data-view="two">
          <RecoveredThreadView recovered={second!} />
        </div>
      </>
    );

    const views = view.container.querySelectorAll('[data-view]');
    expect(views).toHaveLength(2);
    const firstMarkup = views[0].innerHTML;
    const secondMarkup = views[1].innerHTML;

    expect(secondMarkup).toBe(firstMarkup);
    expect(secondMarkup.length).toBeGreaterThan(0);
  });

  it('keeps the recovered transcript and lifecycle readable', () => {
    const [recovered] = loadTwice();

    render(<RecoveredThreadView recovered={recovered!} />);

    expect(screen.getByText('Recovered chat')).toBeInTheDocument();
    expect(screen.getByText('Why did the build fail?')).toBeInTheDocument();
    expect(screen.getByText('The test suite caught a regression.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-lifecycle', 'completed');
  });

  it('offers resume only when a provider handle exists', () => {
    const withHandle = parseRecoveredThread({
      ...RECOVERED_PAYLOAD,
      resumeAvailable: true,
      resumeHandle: 'provider-session-1',
    });
    const first = render(<RecoveredThreadView recovered={withHandle!} />);

    expect(screen.getByRole('button', { name: RESUME_ACTION_LABEL })).toBeInTheDocument();
    expect(screen.queryByText(NEW_SESSION_MESSAGE)).not.toBeInTheDocument();
    first.unmount();

    const withoutHandle = parseRecoveredThread({
      ...RECOVERED_PAYLOAD,
      resumeAvailable: false,
      resumeHandle: null,
    });
    render(<RecoveredThreadView recovered={withoutHandle!} />);

    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument();
    expect(screen.getByText(NEW_SESSION_MESSAGE)).toBeInTheDocument();
  });

  it('never invents a handle from a resume flag alone', () => {
    const inconsistent = parseRecoveredThread({
      ...RECOVERED_PAYLOAD,
      resumeAvailable: true,
      resumeHandle: null,
    });

    render(<RecoveredThreadView recovered={inconsistent!} />);

    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument();
    expect(screen.getByText(NEW_SESSION_MESSAGE)).toBeInTheDocument();
  });

  it('shows the compatibility snapshot and its diagnostic when the log was unreadable', () => {
    const recovered = parseRecoveredThread({
      ...RECOVERED_PAYLOAD,
      source: 'snapshot',
      events: [],
      diagnostic: 'the store is corrupt',
    });

    render(<RecoveredThreadView recovered={recovered!} />);

    expect(screen.getByText('Why did the build fail?')).toBeInTheDocument();
    expect(screen.getByText('the store is corrupt')).toBeInTheDocument();
    expect(screen.getByText(NEW_SESSION_MESSAGE)).toBeInTheDocument();
  });
});
