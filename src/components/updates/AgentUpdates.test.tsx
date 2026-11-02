import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentUpdatesBadge } from './AgentUpdatesBadge';
import { AgentUpdatesPopover } from './AgentUpdatesPopover';
import type { AgentUpdatesSummary } from '../../types/agentUpdates';

vi.mock('../../lib/agentUpdates', () => {
  const mockSummary: AgentUpdatesSummary = {
    totalSupported: 8,
    installedCount: 4,
    outdatedCount: 2,
    advisories: {
      antigravity: {
        engine: 'antigravity',
        displayName: 'Antigravity',
        state: 'outdated',
        currentVersion: '1.4.5',
        latestVersion: '1.4.12',
        updateCommand: 'agy update',
        checkedAtUnixMs: Date.now(),
      },
      codex: {
        engine: 'codex',
        displayName: 'Codex',
        state: 'outdated',
        currentVersion: '0.164.0',
        latestVersion: '0.166.0',
        updateCommand: 'codex update',
        checkedAtUnixMs: Date.now(),
      },
      grok: {
        engine: 'grok',
        displayName: 'Grok Build',
        state: 'up_to_date',
        currentVersion: '1.0.70',
        latestVersion: '1.0.70',
        updateCommand: 'grok update',
        checkedAtUnixMs: Date.now(),
      },
    },
    lastCheckedUnixMs: Date.now(),
  };

  return {
    useAgentUpdates: vi.fn(() => ({
      summary: mockSummary,
      activeJobs: {},
      isChecking: false,
      refresh: vi.fn(),
      triggerJob: vi.fn(),
    })),
    triggerAgentToolJob: vi.fn().mockResolvedValue({
      jobId: 'mock-1',
      engine: 'antigravity',
      action: 'update',
      status: 'running',
      startedAtUnixMs: Date.now(),
    }),
  };
});

describe('AgentUpdatesBadge', () => {
  it('renders badge with count when outdated engines exist', () => {
    render(<AgentUpdatesBadge />);
    const badge = screen.getByRole('button', { name: /2 actualizaciones de agentes disponibles/i });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('2');
  });

  it('opens AgentUpdatesPopover when clicked', () => {
    render(<AgentUpdatesBadge />);
    const badge = screen.getByRole('button', { name: /2 actualizaciones de agentes disponibles/i });
    fireEvent.click(badge);

    expect(screen.getByRole('dialog', { name: /actualizaciones de agentes/i })).toBeInTheDocument();
    expect(screen.getByText('Antigravity')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.queryByText('Grok Build')).not.toBeInTheDocument(); // Only outdated in popover
  });
});

describe('AgentUpdatesPopover', () => {
  const mockSummary: AgentUpdatesSummary = {
    totalSupported: 3,
    installedCount: 2,
    outdatedCount: 1,
    advisories: {
      antigravity: {
        engine: 'antigravity',
        displayName: 'Antigravity',
        state: 'outdated',
        currentVersion: '1.4.5',
        latestVersion: '1.4.12',
        updateCommand: 'agy update',
        checkedAtUnixMs: Date.now(),
      },
    },
    lastCheckedUnixMs: Date.now(),
  };

  it('renders outdated agent row and triggers update on click', async () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    render(
      <AgentUpdatesPopover
        summary={mockSummary}
        activeJobs={{}}
        isChecking={false}
        onRefresh={onRefresh}
        onClose={onClose}
      />
    );

    expect(screen.getByText('Antigravity')).toBeInTheDocument();
    expect(screen.getByText(/v1.4.5/)).toBeInTheDocument();
    expect(screen.getByText(/v1.4.12/)).toBeInTheDocument();

    const updateBtn = screen.getByRole('button', { name: /actualizar/i });
    fireEvent.click(updateBtn);
    expect(screen.getByText(/actualizando/i)).toBeInTheDocument();
  });
});
