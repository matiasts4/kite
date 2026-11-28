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
      if (cmd === 'list_routine_runs') {
        return { runs: [] };
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

    fireEvent.click(screen.getByRole('button', { name: /New routine/i }));
    fireEvent.click(screen.getByRole('button', { name: '5-Field Cron' }));
    expect(screen.getByLabelText(/UTC Cron Expression/i)).toBeInTheDocument();
    expect(screen.getByText('Announce via Argos')).toBeInTheDocument();
    expect(screen.getByText('Create Kite Task on findings')).toBeInTheDocument();
  });

  it('tracks quiet HEARTBEAT_OK runs and toggles Actionable only in RoutinesView and RoutineRunHistoryDrawer', async () => {
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
              outputActions: ['notify_desktop'],
            },
            {
              id: 'routine-2',
              agentId: 'agent-1',
              name: 'Quiet Watcher',
              prompt: 'Poll repo status quietly',
              cadence: { kind: 'cron', expr: '*/15 * * * *' },
              enabled: true,
              author: 'builder',
              workspaceId: null,
              createdAtUnixMs: 2000,
              nextRunAtUnixMs: Date.now() + 120000,
              lastRunAtUnixMs: null,
              lastRunThreadId: null,
              lastError: null,
              triggerType: 'schedule',
              outputActions: [],
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
      if (cmd === 'list_routine_runs') {
        return {
          runs: [
            {
              runId: 'run-q-global',
              routineId: 'routine-2',
              agentId: 'agent-1',
              triggerKind: 'cron',
              status: 'quiet',
              startedAtUnixMs: Date.now() - 4000,
              finishedAtUnixMs: Date.now() - 3000,
              threadId: null,
              summary: 'HEARTBEAT_OK',
              changedFilesCount: 0,
              retryAttempt: 0,
              error: null,
            },
          ],
        };
      }
      return null;
    });

    mockInvoke.mockImplementation(async (cmd: string, payload?: any) => {
      if (cmd === 'list_routine_runs') {
        if (payload?.request?.routineId === 'routine-2') {
          return {
            runs: [
              {
                runId: 'run-q-1',
                routineId: 'routine-2',
                agentId: 'agent-1',
                triggerKind: 'cron',
                status: 'quiet',
                startedAtUnixMs: Date.now() - 4000,
                finishedAtUnixMs: Date.now() - 3000,
                threadId: null,
                summary: 'HEARTBEAT_OK',
                changedFilesCount: 0,
                retryAttempt: 0,
                error: null,
              },
              {
                runId: 'run-s-1',
                routineId: 'routine-2',
                agentId: 'agent-1',
                triggerKind: 'cron',
                status: 'succeeded',
                startedAtUnixMs: Date.now() - 9000,
                finishedAtUnixMs: Date.now() - 8000,
                threadId: 'thread-r2',
                summary: 'Detected doc mismatch',
                changedFilesCount: 1,
                retryAttempt: 0,
                error: null,
              },
            ],
          };
        }
        return {
          runs: [
            {
              runId: 'run-q-global',
              routineId: 'routine-2',
              agentId: 'agent-1',
              triggerKind: 'cron',
              status: 'quiet',
              startedAtUnixMs: Date.now() - 4000,
              finishedAtUnixMs: Date.now() - 3000,
              threadId: null,
              summary: 'HEARTBEAT_OK',
              changedFilesCount: 0,
              retryAttempt: 0,
              error: null,
            },
          ],
        };
      }
      return null;
    });

    render(<RoutinesView />);

    await waitFor(() => {
      expect(screen.getByText('Commit Sanity Check')).toBeInTheDocument();
      expect(screen.getByText('Quiet Watcher')).toBeInTheDocument();
      expect(screen.getByText('1 quiet ticks auto-archived')).toBeInTheDocument();
    });

    // Enable Actionable only triage in main list -> hides Quiet Watcher
    const listToggle = screen.getByRole('button', { name: 'Actionable only' });
    expect(listToggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(listToggle);
    expect(listToggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Quiet Watcher')).toBeNull();
    expect(screen.getByText('Commit Sanity Check')).toBeInTheDocument();

    // Toggle back to inspect Quiet Watcher history drawer
    fireEvent.click(listToggle);
    expect(screen.getByText('Quiet Watcher')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'History for Quiet Watcher' }));
    expect(await screen.findByText('Detected doc mismatch')).toBeInTheDocument();
    // Drawer defaults Actionable only = true -> quiet HEARTBEAT_OK hidden until toggled
    expect(screen.queryByText('quiet · HEARTBEAT_OK')).toBeNull();

    const drawerToggles = screen.getAllByRole('button', { name: 'Actionable only' });
    const drawerToggle = drawerToggles[drawerToggles.length - 1];
    expect(drawerToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(drawerToggle);

    expect(await screen.findByText('quiet · HEARTBEAT_OK')).toBeInTheDocument();
  });

  it('supports Back button and Escape navigation, clean button labels, triage styling, error unwrapping, and conflict retry', async () => {
    const onBack = vi.fn();
    let toggleAttempts = 0;

    mockInvokeCommand.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'list_routines') {
        return {
          schemaVersion: 1,
          routines: [
            {
              id: 'c1111111-1111-4111-8111-111111111111',
              agentId: 'agent-1',
              name: 'Daily Project Health Check',
              prompt: 'Inspect codebase health',
              cadence: { kind: 'interval', seconds: 86400 },
              enabled: true,
              author: 'builder',
              workspaceId: null,
              createdAtUnixMs: 1000,
              nextRunAtUnixMs: Date.now() + 60000,
              lastRunAtUnixMs: null,
              lastRunThreadId: null,
              lastError: null,
              triggerType: 'schedule',
              outputActions: [],
            },
          ],
          agentRevisions: [{ agentId: 'agent-1', revision: toggleAttempts === 0 ? 'a'.repeat(64) : 'b'.repeat(64) }],
          runNowAvailability: { available: true, reason: '' },
        };
      }
      if (cmd === 'list_agent_profiles') {
        return [
          {
            id: 'agent-1',
            name: 'Reviewer',
            engine: 'antigravity',
            purpose: 'Review code',
            createdAtUnixMs: 1000,
            pinned: false,
            order: 0,
          },
        ];
      }
      if (cmd === 'list_routine_runs') {
        return { runs: [] };
      }
      if (cmd === 'set_routine_enabled') {
        toggleAttempts += 1;
        if (toggleAttempts === 1) {
          throw { code: 'routine_conflict', message: 'These routines changed.' };
        }
        if (toggleAttempts === 2) {
          return {
            schemaVersion: 1,
            routines: [
              {
                id: 'c1111111-1111-4111-8111-111111111111',
                agentId: 'agent-1',
                name: 'Daily Project Health Check',
                prompt: 'Inspect codebase health',
                cadence: { kind: 'interval', seconds: 86400 },
                enabled: false,
                author: 'builder',
                workspaceId: null,
                createdAtUnixMs: 1000,
                nextRunAtUnixMs: Date.now() + 60000,
                lastRunAtUnixMs: null,
                lastRunThreadId: null,
                lastError: null,
                triggerType: 'schedule',
                outputActions: [],
              },
            ],
            agentRevisions: [{ agentId: 'agent-1', revision: 'b'.repeat(64) }],
            runNowAvailability: { available: true, reason: '' },
          };
        }
        throw { code: 'invalid_request', message: 'Routine request is invalid.' };
      }
      return args ?? null;
    });

    render(<RoutinesView onBack={onBack} />);

    await waitFor(() => {
      expect(screen.getByText('Daily Project Health Check')).toBeInTheDocument();
    });

    // Duplicate '+' removed from New routine label
    const newRoutineBtn = screen.getByRole('button', { name: /New routine/i });
    expect(newRoutineBtn.textContent?.trim()).toBe('New routine');

    // Text filter button must not use square .chrome-button
    const actionableBtn = screen.getByRole('button', { name: 'Actionable only' });
    expect(actionableBtn).not.toHaveClass('chrome-button');
    expect(actionableBtn).toHaveClass('routine-triage-btn');

    // Toggle retries once on routine_conflict and then extracts real Tauri error messages without [object Object]
    const switchBtn = screen.getByRole('switch', { name: /Pause Daily Project Health Check/i });
    fireEvent.click(switchBtn);
    await waitFor(() => {
      expect(screen.getByText(/Routine "Daily Project Health Check" paused/i)).toBeInTheDocument();
    });
    expect(toggleAttempts).toBe(2);

    const resumeSwitch = screen.getByRole('switch', { name: /Resume Daily Project Health Check/i });
    fireEvent.click(resumeSwitch);
    await waitFor(() => {
      const alertText = screen.getByRole('alert').textContent || '';
      expect(alertText).toContain('Routine request is invalid.');
      expect(alertText).not.toContain('[object Object]');
    });

    // Clicking Back closes Routines
    const backBtn = screen.getByRole('button', { name: /Back to Agents/i });
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledTimes(1);

    // Escape closes editor drawer first before calling onBack
    fireEvent.click(newRoutineBtn);
    fireEvent.click(screen.getByRole('button', { name: '5-Field Cron' }));
    const cronPresetBtn = screen.getByRole('button', { name: 'Every 15m (UTC)' });
    expect(cronPresetBtn).not.toHaveClass('chrome-button');
    expect(cronPresetBtn).toHaveClass('routine-triage-btn');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(2);

    // Verify History drawer buttons and CSS contracts in notifications.css + visual-language.css
    fireEvent.click(screen.getByRole('button', { name: /History for Daily Project Health Check/i }));
    await waitFor(() => {
      const refreshBtn = screen.getByRole('button', { name: 'Refresh run history' });
      expect(refreshBtn).not.toHaveClass('chrome-button');
      expect(refreshBtn).toHaveClass('routine-drawer__refresh-btn');
    });
    const drawerActionableButtons = screen.getAllByRole('button', { name: 'Actionable only' });
    const drawerActionable = drawerActionableButtons[drawerActionableButtons.length - 1];
    expect(drawerActionable).not.toHaveClass('chrome-button');
    expect(drawerActionable).toHaveClass('routine-triage-btn');

    const fsSpecifier = ['node', 'fs'].join(':');
    const fsMod = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const notifCss = fsMod.readFileSync('src/components/views/notifications.css', 'utf8');
    expect(notifCss).toMatch(/\.routine-triage-btn\s*\{[^}]*width:\s*auto/s);
    expect(notifCss).toMatch(/\.routine-triage-btn\s*\{[^}]*white-space:\s*nowrap/s);
    expect(notifCss).toMatch(/\.routine-row__actions\s*\{[^}]*opacity:\s*1/s);
  });
});
