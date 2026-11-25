import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoutinesView } from '../RoutinesView';

const mockInvokeCommand = vi.fn();
const mockInvoke = vi.fn();

vi.mock('../../../lib/ipc', () => ({
  invokeCommand: (...args: unknown[]) => mockInvokeCommand(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('RoutinesView (T4 Cron, Event Triggers & Run History)', () => {
  beforeEach(() => {
    mockInvokeCommand.mockReset();
    mockInvoke.mockReset();
    mockInvokeCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_routines') {
        return {
          schemaVersion: 1,
          routines: [
            {
              id: 'routine-1',
              agentId: 'agent-1',
              name: 'Commit Sanity Check',
              prompt: 'Inspect git commit diff',
              cadence: { kind: 'event', eventKind: 'on_git_commit', debounceSecs: 30 },
              enabled: true,
              author: 'builder',
              workspaceId: null,
              createdAtUnixMs: 1000,
              nextRunAtUnixMs: Date.now() + 60000,
              lastRunAtUnixMs: null,
              lastRunThreadId: null,
              lastError: null,
              triggerType: 'event',
              outputActions: ['notify_desktop', 'announce_via_argos'],
            },
          ],
          agentRevisions: [{ agentId: 'agent-1', revision: 'a'.repeat(64) }],
          runNowAvailability: { available: true, reason: '' },
        };
      }
      if (cmd === 'list_agent_profiles') {
        return [
          {
            id: 'agent-1',
            name: 'Reviewer',
            engine: 'claude',
            purpose: 'Review diffs',
            createdAtUnixMs: 1000,
            pinned: false,
            order: 0,
          },
        ];
      }
      return null;
    });
  });

  it('renders event cadence summary and opens SQLite Run History drawer', async () => {
    mockInvoke.mockResolvedValue({
      runs: [
        {
          runId: 'run-100',
          routineId: 'routine-1',
          agentId: 'agent-1',
          triggerKind: 'on_git_commit',
          status: 'succeeded',
          startedAtUnixMs: Date.now() - 5000,
          finishedAtUnixMs: Date.now() - 1000,
          threadId: 'thread-abc',
          summary: 'Verified clean commit.',
          changedFilesCount: 2,
          retryAttempt: 0,
          error: null,
        },
      ],
    });

    render(<RoutinesView />);

    await waitFor(() => {
      expect(screen.getByText('Commit Sanity Check')).toBeInTheDocument();
      expect(screen.getByText('on_git_commit')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /History for Commit Sanity Check/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('list_routine_runs', {
        request: { routineId: 'routine-1', limit: 30 },
      });
      expect(screen.getByText('Verified clean commit.')).toBeInTheDocument();
      expect(screen.getByText(/Trigger: on_git_commit/i)).toBeInTheDocument();
    });
  });

  it('allows configuring Cron 5-field expressions and output actions in the editor drawer', async () => {
    render(<RoutinesView />);
    await waitFor(() => {
      expect(screen.getByText('Commit Sanity Check')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /\+ New routine/i }));
    fireEvent.click(screen.getByRole('button', { name: '5-Field Cron' }));
    expect(screen.getByLabelText(/UTC Cron Expression/i)).toBeInTheDocument();
    expect(screen.getByText('Announce via Argos')).toBeInTheDocument();
    expect(screen.getByText('Create Kite Task on findings')).toBeInTheDocument();
  });
});
