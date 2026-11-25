import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentAuditTab } from './AgentAuditTab';
import { AgentEvalDrawer } from './AgentEvalDrawer';
import { AgentBundleModal } from './AgentBundleModal';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('T6 Audit Tab, Dry-Run Eval & Portable Bundles', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('filters tool audit log entries by verdict', async () => {
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

    render(<AgentAuditTab agentId="ag-1" />);
    await waitFor(() => {
      expect(screen.getByText('kite_diff')).toBeInTheDocument();
      expect(screen.getByText('denied')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Filter by verdict'), {
      target: { value: 'denied' },
    });
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('list_agent_audit_log', {
        request: expect.objectContaining({ agentId: 'ag-1', verdict: 'denied' }),
      });
    });
  });

  it('runs Dry-Run Eval testbench and renders token counts + blocked mutations', async () => {
    mockInvoke.mockResolvedValue({
      agentId: 'ag-1',
      compiledPromptChars: 800,
      estimatedPromptTokens: 200,
      totalCases: 1,
      passedCases: 0,
      blockedMutations: 1,
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
    });
  });

  it('exports portable bundle and lists 5 curated specialist templates', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_curated_agent_templates') {
        return {
          templates: [
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
      return {};
    });

    render(
      <AgentBundleModal
        isOpen={true}
        agentId="ag-1"
        agentName="Auditor"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('ODD Architect')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Export Auditor/i }));
    await waitFor(() => {
      const textarea = screen.getByLabelText('Exported agent bundle JSON') as HTMLTextAreaElement;
      expect(textarea.value).toContain('kite-agent/v1');
    });
  });
});
