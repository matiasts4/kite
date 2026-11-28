import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentAuditTab } from './AgentAuditTab';
import { AgentEvalDrawer } from './AgentEvalDrawer';
import { AgentBundleModal } from './AgentBundleModal';
import { AgentCreatePane } from './AgentCreatePane';
import { RECOMMENDED_SPECIALIST_TEMPLATES } from './agentPresets';

const mockInvoke = vi.fn();
const mockInvokeCommand = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/ipc')>('../../../lib/ipc');
  return {
    ...actual,
    invokeCommand: (...args: unknown[]) => mockInvokeCommand(...args),
  };
});

describe('T6 Audit Tab, Dry-Run Eval & Portable Bundles', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvokeCommand.mockReset();
    mockInvokeCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_chat_provider_models') {
        return { models: [], catalogState: 'empty' };
      }
      return {};
    });
  });

  it('filters tool audit log entries by verdict and tool family SelectMenus, and opens thread', async () => {
    const onOpenThread = vi.fn();
    mockInvoke.mockResolvedValue({
      entries: [
        {
          id: 'aud-1',
          agentId: 'ag-1',
          threadId: 'thread-9',
          toolName: 'kite_diff',
          toolFamily: 'diff',
          verdict: 'denied',
          reason: 'Policy denied',
          durationMs: 3,
          skillEvent: null,
          createdAtUnixMs: Date.now(),
        },
      ],
    });

    render(<AgentAuditTab agentId="ag-1" onOpenThread={onOpenThread} />);
    await waitFor(() => {
      expect(screen.getByText('kite_diff')).toBeInTheDocument();
      expect(screen.getByText('denied')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(onOpenThread).toHaveBeenCalledWith('thread-9');

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by verdict' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Denied' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('list_agent_audit_log', {
        request: expect.objectContaining({ agentId: 'ag-1', verdict: 'denied' }),
      });
    });

    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by tool family' }));
    for (const family of [
      'thread',
      'memory',
      'routine',
      'teammate',
      'tasks',
      'ctx',
      'diff',
      'subagents',
      'filesystem_write',
      'shell',
    ]) {
      expect(await screen.findByRole('option', { name: family })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('option', { name: 'subagents' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('list_agent_audit_log', {
        request: expect.objectContaining({ agentId: 'ag-1', toolFamily: 'subagents' }),
      });
    });
  });

  it('runs Dry-Run Eval testbench and renders token counts, blocked mutations, and 8-pillar Readiness Score', async () => {
    mockInvoke.mockResolvedValue({
      agentId: 'ag-1',
      compiledPromptChars: 800,
      estimatedPromptTokens: 200,
      totalCases: 1,
      passedCases: 0,
      blockedMutations: 1,
      readinessScore: 92,
      readinessPillars: [
        { id: 'charter', label: 'Purpose & Charter', score: 15, maxScore: 15, passed: true, hint: 'Charter set' },
        { id: 'engine', label: 'Provider & Model', score: 15, maxScore: 15, passed: true, hint: 'Model bound' },
        { id: 'skills', label: 'Skills Linked', score: 15, maxScore: 15, passed: true, hint: '2 skills' },
        { id: 'places', label: 'Places Authorized', score: 15, maxScore: 15, passed: true, hint: 'Repo authorized' },
        { id: 'packs', label: 'Knowledge Packs', score: 10, maxScore: 10, passed: true, hint: '1 pack' },
        { id: 'tools', label: 'Tool Guardrails', score: 10, maxScore: 10, passed: true, hint: 'Explicit policies' },
        { id: 'memory', label: 'Memory Notes', score: 7, maxScore: 10, passed: true, hint: 'Memory loaded' },
        { id: 'eval', label: 'Dry-Run Gate', score: 5, maxScore: 10, passed: false, hint: 'Verify write guard' },
      ],
      results: [
        {
          prompt: 'Write file',
          predictedTools: [
            {
              tool: 'filesystem_write',
              family: 'filesystem_write',
              policy: 'ask',
              mutating: true,
              blockedInDryRun: true,
            },
          ],
          policyViolations: ["Dry-run read-only guard blocked mutating call 'filesystem_write'."],
          matchedSkills: ['odd-workflow'],
          passed: false,
        },
      ],
    });

    render(
      <AgentEvalDrawer
        isOpen={true}
        agentId="ag-1"
        agentName="Auditor"
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run Read-Only Eval' }));
    await waitFor(() => {
      expect(screen.getByText(/200 tokens/i)).toBeInTheDocument();
      expect(screen.getByText(/Dry-run read-only guard blocked/i)).toBeInTheDocument();
      expect(screen.getByText('Readiness Score: 92/100')).toBeInTheDocument();
      expect(screen.getByText('8-Pillar Readiness Checklist')).toBeInTheDocument();
      expect(screen.getByText('Purpose & Charter')).toBeInTheDocument();
      expect(screen.getByText('Verify write guard')).toBeInTheDocument();
    });
  });

  it('exports portable bundle, installs Recommended Specialists (Ship Guard / Discovery Architect), and keeps core templates', async () => {
    const onImported = vi.fn();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_curated_agent_templates') {
        return {
          templates: [
            {
              id: 'ship-guard',
              name: 'Ship Guard',
              engine: 'antigravity',
              roleBadge: 'Verify & Review',
              summary: 'Guards ship readiness',
              brief: 'Brief',
              toolPolicies: {},
              knowledgePackGlobs: ['odd/tasks/*.md'],
            },
            {
              id: 'discovery-architect',
              name: 'Discovery Architect',
              engine: 'antigravity',
              roleBadge: 'Research & Specs',
              summary: 'Explores architecture',
              brief: 'Brief',
              toolPolicies: {},
              knowledgePackGlobs: ['docs/**'],
            },
            {
              id: 'odd-architect',
              name: 'ODD Architect',
              engine: 'antigravity',
              roleBadge: 'Architecture & ODDs',
              summary: 'Writes clean-room ODD specs',
              brief: 'Brief',
              toolPolicies: {},
              knowledgePackGlobs: ['odd/tasks/*.md'],
            },
          ],
        };
      }
      if (cmd === 'export_agent_bundle') {
        return {
          schema: 'kite-agent/v1',
          bundleVersion: 1,
          agent: { name: 'Auditor', engine: 'claude-code' },
        };
      }
      if (cmd === 'install_curated_agent_template') {
        return { installed: true, created: true, templateId: 'ship-guard', readinessScore: 95 };
      }
      return {};
    });

    render(
      <AgentBundleModal
        isOpen={true}
        agentId="ag-1"
        agentName="Auditor"
        onClose={vi.fn()}
        onImported={onImported}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('ODD Architect')).toBeInTheDocument();
      expect(screen.getByText('Ship Guard')).toBeInTheDocument();
      expect(screen.getByText('Discovery Architect')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Install Ship Guard' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('install_curated_agent_template', {
        request: { templateId: 'ship-guard' },
      });
      expect(onImported).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: /Export Auditor/i }));
    await waitFor(() => {
      const textarea = screen.getByLabelText('Exported agent bundle JSON') as HTMLTextAreaElement;
      expect(textarea.value).toContain('kite-agent/v1');
    });
  });

  it('surfaces ONLY Ship Guard and Discovery Architect for 1-click install in AgentCreatePane', async () => {
    expect(RECOMMENDED_SPECIALIST_TEMPLATES.map((t) => t.id)).toEqual([
      'ship-guard',
      'discovery-architect',
    ]);
    expect(RECOMMENDED_SPECIALIST_TEMPLATES.every((t) => t.engine === 'antigravity')).toBe(true);

    const createdProfile = {
      id: 'ag-guard',
      name: 'Ship Guard',
      engine: 'antigravity',
      purpose: 'Verify releases',
      avatar: null,
      createdAtUnixMs: 1,
      pinned: false,
      order: 0,
    };

    mockInvokeCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_chat_provider_models') {
        return { models: [], catalogState: 'empty' };
      }
      if (cmd === 'install_curated_agent_template') {
        return {
          installed: true,
          created: true,
          templateId: 'ship-guard',
          agentId: 'ag-guard',
          agent: createdProfile,
        };
      }
      return {};
    });

    const onCreated = vi.fn();
    render(<AgentCreatePane onCreated={onCreated} onCancel={vi.fn()} />);

    expect(screen.getByText('Install Recommended Specialist (Antigravity)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install Ship Guard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install Discovery Architect' })).toBeInTheDocument();
    expect(screen.queryByText(/Blind Judge/i)).toBeNull();
    expect(screen.queryByText(/Bug & QA Hunter/i)).toBeNull();
    expect(screen.queryByText(/Repo Watchdog/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Install Ship Guard' }));
    await waitFor(() => {
      expect(mockInvokeCommand).toHaveBeenCalledWith('install_curated_agent_template', {
        templateId: 'ship-guard',
      });
      expect(onCreated).toHaveBeenCalledWith(createdProfile);
    });
  });
});
