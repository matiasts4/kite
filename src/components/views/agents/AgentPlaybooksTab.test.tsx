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
});
