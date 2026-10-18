import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentSkillsTab } from './AgentSkillsTab';
import type { AgentMindSnapshot, StarterSummary } from './types';

describe('AgentSkillsTab - Single Starter Control & Empty State Parity', () => {
  const mockStarters: StarterSummary[] = [
    { id: 'starter-1', title: 'Code Reviewer', summary: 'Reviews pull requests' },
    { id: 'starter-2', title: 'Test Generator', summary: 'Generates unit tests' },
  ];

  it('renders exactly ONE Add Starter button when skills are empty (no duplicate in tab strip)', () => {
    const emptyMind: AgentMindSnapshot = {
      schemaVersion: 1,
      agentId: 'agent-1',
      memory: '',
      user: '',
      skills: [],
      memoryUpdatedAtUnixMs: null,
      userUpdatedAtUnixMs: null,
      memoryRevision: null,
      userRevision: null,
      readIssues: [],
    };

    const { container } = render(
      <AgentSkillsTab
        agentName="Claude"
        mind={emptyMind}
        selectedSkillId={null}
        skillDocument={null}
        skillLoading={false}
        skillSaving={false}
        onSelectSkill={vi.fn()}
        onSaveSkill={vi.fn()}
        onDeleteSkill={vi.fn()}
        onClearSelectedSkill={vi.fn()}
        starters={mockStarters}
        onInstallStarter={vi.fn()}
      />
    );

    // Assert the empty state is displayed
    expect(screen.getByText(/Claude hasn’t written a skill yet/i)).toBeInTheDocument();

    // Assert that .ui-tabs__trailing is NOT rendered when empty
    expect(container.querySelector('.ui-tabs__trailing')).toBeNull();

    // Assert there is exactly ONE starter button on screen (in empty state)
    const starterButtons = screen.getAllByRole('button', { name: /Add starter/i });
    expect(starterButtons).toHaveLength(1);
    expect(starterButtons[0]).toHaveTextContent('Add starter');
  });

  it('renders starter control in ui-tabs__trailing when agent already has skills', () => {
    const mindWithSkill: AgentMindSnapshot = {
      schemaVersion: 1,
      agentId: 'agent-1',
      memory: '',
      user: '',
      skills: [
        {
          id: 'skill-1',
          name: 'git-commit-helper',
          description: 'Formats conventional commits',
          uses: 3,
          updatedAtUnixMs: Date.now() - 3600000,
          revision: 'rev-1',
          lastUsed: null,
          lastOutcome: null,
        },
      ],
      memoryUpdatedAtUnixMs: null,
      userUpdatedAtUnixMs: null,
      memoryRevision: null,
      userRevision: null,
      readIssues: [],
    };

    const { container } = render(
      <AgentSkillsTab
        agentName="Claude"
        mind={mindWithSkill}
        selectedSkillId={null}
        skillDocument={null}
        skillLoading={false}
        skillSaving={false}
        onSelectSkill={vi.fn()}
        onSaveSkill={vi.fn()}
        onDeleteSkill={vi.fn()}
        onClearSelectedSkill={vi.fn()}
        starters={mockStarters}
        onInstallStarter={vi.fn()}
      />
    );

    // Empty state should NOT be rendered
    expect(screen.queryByText(/Claude hasn’t written a skill yet/i)).toBeNull();

    // Tab trailing button SHOULD be rendered
    const tabTrailing = container.querySelector('.ui-tabs__trailing');
    expect(tabTrailing).toBeInTheDocument();
    expect(tabTrailing?.querySelector('button')).toBeInTheDocument();

    // Skill row is displayed
    expect(screen.getByText('git-commit-helper')).toBeInTheDocument();
  });

  it('opens starters menu when clicking the Add starter button', async () => {
    const user = userEvent.setup();
    const emptyMind: AgentMindSnapshot = {
      schemaVersion: 1,
      agentId: 'agent-1',
      memory: '',
      user: '',
      skills: [],
      memoryUpdatedAtUnixMs: null,
      userUpdatedAtUnixMs: null,
      memoryRevision: null,
      userRevision: null,
      readIssues: [],
    };

    render(
      <AgentSkillsTab
        agentName="Claude"
        mind={emptyMind}
        selectedSkillId={null}
        skillDocument={null}
        skillLoading={false}
        skillSaving={false}
        onSelectSkill={vi.fn()}
        onSaveSkill={vi.fn()}
        onDeleteSkill={vi.fn()}
        onClearSelectedSkill={vi.fn()}
        starters={mockStarters}
        onInstallStarter={vi.fn()}
      />
    );

    const starterBtn = screen.getByRole('button', { name: /Add starter skill/i });
    await user.click(starterBtn);

    // Menu options should now appear
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Test Generator')).toBeInTheDocument();
  });
});
