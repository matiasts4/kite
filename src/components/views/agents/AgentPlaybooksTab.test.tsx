import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentPlaybooksTab } from './AgentPlaybooksTab';
import type { AgentProfile } from '../../../types';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

describe('AgentPlaybooksTab (T5 Multi-Agent Playbooks & Live Graph)', () => {
  const agents: AgentProfile[] = [
    {
      id: 'ag-1',
      name: 'Explorer',
      engine: 'grok',
      purpose: 'Map repo',
      avatar: null,
      createdAtUnixMs: 1,
      pinned: false,
      order: 0,
    },
    {
      id: 'ag-2',
      name: 'Implementer',
      engine: 'codex',
      purpose: 'Write patch',
      avatar: null,
      createdAtUnixMs: 1,
      pinned: false,
      order: 1,
    },
  ];

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('creates, runs a Playbook, and renders live stage handoff graph + retry control', async () => {
    const savedPb = {
      id: 'pb-1',
      name: 'ODD Swarm',
      description: 'Explore -> Implement',
      stages: [
        {
          stageId: 'explore',
          title: 'Explore',
          agentProfileId: 'ag-1',
          promptTemplate: 'Map files',
          dependsOn: [],
          workspaceMode: 'inherit',
          handoffKeys: ['explore-map'],
        },
      ],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 10,
    };

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_agent_playbooks') return { playbooks: [] };
      if (cmd === 'list_playbook_runs') return { runs: [] };
      if (cmd === 'save_agent_playbook') return { playbooks: [savedPb] };
      if (cmd === 'run_agent_playbook') {
        return {
          run: {
            runId: 'pbrun-1',
            playbookId: 'pb-1',
            playbookName: 'ODD Swarm',
            status: 'halted',
            startedAtUnixMs: Date.now() - 3000,
            finishedAtUnixMs: Date.now(),
            workspaceId: null,
            stages: [
              {
                stageId: 'explore',
                title: 'Explore',
                agentProfileId: 'ag-1',
                provider: 'grok',
                model: null,
                status: 'succeeded',
                threadId: 'thread-exp',
                startedAtUnixMs: Date.now() - 3000,
                finishedAtUnixMs: Date.now() - 1000,
                handoffKeys: ['playbook:pbrun-1:stage:explore'],
                summary: 'Mapped files',
                error: null,
              },
              {
                stageId: 'implement',
                title: 'Implement',
                agentProfileId: 'ag-2',
                provider: 'codex',
                model: 'gpt-5-codex',
                status: 'failed',
                threadId: null,
                startedAtUnixMs: Date.now() - 1000,
                finishedAtUnixMs: Date.now(),
                handoffKeys: ['playbook:pbrun-1:stage:implement'],
                summary: null,
                error: 'Compile error',
              },
            ],
          },
        };
      }
      return null;
    });

    render(<AgentPlaybooksTab agentId="ag-1" agents={agents} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('list_agent_playbooks');
    });

    fireEvent.change(screen.getByPlaceholderText('ODD Multi-Provider Pipeline'), {
      target: { value: 'ODD Swarm' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Playbook' }));

    await waitFor(() => {
      expect(screen.getByText('ODD Swarm')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run Playbook' }));

    await waitFor(() => {
      expect(screen.getByText(/playbook:pbrun-1:stage:explore/i)).toBeInTheDocument();
      expect(screen.getByText('Compile error')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry stage' })).toBeInTheDocument();
    });
  });

  it('supports full stage fields, editing/deleting playbooks, open thread, and 2.5s active-run poll', async () => {
    const existingPb = {
      id: 'pb-existing',
      name: 'Release Pipeline',
      description: 'Verify and release',
      stages: [
        {
          stageId: 'audit',
          title: 'Audit',
          agentProfileId: 'ag-1',
          promptTemplate: 'Check diff {{input}}',
          dependsOn: [],
          workspaceMode: 'inherit',
          handoffKeys: ['audit-summary'],
        },
      ],
      createdAtUnixMs: 10,
      updatedAtUnixMs: 10,
    };

    let pollCount = 0;
    let deleted = false;

    mockInvoke.mockImplementation(async (cmd: string, payload?: any) => {
      if (cmd === 'list_agent_playbooks') {
        return { playbooks: deleted ? [] : [existingPb] };
      }
      if (cmd === 'list_playbook_runs') {
        pollCount += 1;
        return {
          runs: [
            {
              runId: 'pbrun-active',
              playbookId: 'pb-existing',
              playbookName: 'Release Pipeline',
              status: pollCount >= 2 ? 'succeeded' : 'running',
              startedAtUnixMs: Date.now() - 2000,
              finishedAtUnixMs: pollCount >= 2 ? Date.now() : null,
              workspaceId: null,
              stages: [
                {
                  stageId: 'audit',
                  title: 'Audit',
                  agentProfileId: 'ag-1',
                  provider: 'grok',
                  model: null,
                  status: pollCount >= 2 ? 'succeeded' : 'running',
                  threadId: 'thread-stage-1',
                  startedAtUnixMs: Date.now() - 2000,
                  finishedAtUnixMs: pollCount >= 2 ? Date.now() : null,
                  handoffKeys: ['audit-summary'],
                  summary: 'Checked',
                  error: null,
                },
              ],
            },
          ],
        };
      }
      if (cmd === 'save_agent_playbook') {
        return {
          playbooks: [
            {
              ...existingPb,
              name: payload?.request?.playbook?.name || existingPb.name,
              stages: payload?.request?.playbook?.stages || existingPb.stages,
            },
          ],
        };
      }
      if (cmd === 'delete_agent_playbook') {
        deleted = true;
        return { playbooks: [] };
      }
      return null;
    });

    const onOpenThread = vi.fn();
    render(<AgentPlaybooksTab agentId="ag-1" agents={agents} onOpenThread={onOpenThread} />);

    expect(
      await screen.findByRole('button', { name: 'Edit playbook Release Pipeline' })
    ).toBeInTheDocument();
    expect(screen.getAllByText('Release Pipeline').length).toBeGreaterThanOrEqual(1);

    // Open thread button on running stage
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-stage-1');

    // Edit existing playbook + stage metadata + reorder
    fireEvent.click(screen.getByRole('button', { name: 'Edit playbook Release Pipeline' }));
    expect(screen.getByRole('button', { name: 'Update Playbook' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Stage 1 ID'), { target: { value: 'explore-root' } });
    fireEvent.change(screen.getByLabelText('Stage 1 depends on'), { target: { value: 'prep' } });
    fireEvent.change(screen.getByLabelText('Stage 1 handoff keys'), { target: { value: 'map-out' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add Stage' }));
    expect(screen.getByLabelText('Stage 2 ID')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move stage 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove stage 2' }));

    fireEvent.click(screen.getByRole('button', { name: 'Update Playbook' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_agent_playbook', {
        request: {
          playbook: expect.objectContaining({
            id: 'pb-existing',
            name: 'Release Pipeline',
          }),
        },
      });
    });

    // Active run poll after 2.5s flips running -> succeeded
    await waitFor(
      () => {
        expect(pollCount).toBeGreaterThanOrEqual(2);
        expect(screen.getAllByText('succeeded').length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 4000 }
    );

    // Delete playbook updates state cleanly even when backend returns []
    fireEvent.click(screen.getByRole('button', { name: 'Delete playbook Release Pipeline' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('delete_agent_playbook', {
        request: { playbookId: 'pb-existing' },
      });
      expect(screen.getByText(/No Playbooks created yet/i)).toBeInTheDocument();
    });
  });
});
