import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsView } from '../AgentsView';
import * as ipc from '../../../lib/ipc';

vi.mock('../../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

vi.mock('../ChatView', () => ({
  ChatView: (props: any) => (
    <div
      data-testid="mock-chat-view"
      data-workspace-id={props.workspaceId ?? 'null'}
      data-workspaces-count={props.workspaces ? props.workspaces.length : 0}
    >
      Mock Chat View: {props.agentName}
    </div>
  ),
}));

vi.mock('./AgentTerminalPane', () => ({
  AgentTerminalPane: (props: any) => <div data-testid="mock-terminal">{props.agentName}</div>,
}));

vi.mock('./AgentMemoryTab', () => ({
  AgentMemoryTab: () => <div>Mock Memory</div>,
}));

vi.mock('./AgentSkillsTab', () => ({
  AgentSkillsTab: () => <div>Mock Skills</div>,
}));

vi.mock('./AgentStartersTab', () => ({
  AgentStartersTab: () => <div>Mock Starters</div>,
}));

describe('AgentsView (S4 workspace & places wiring)', () => {
  const mockAgent = {
    id: 'agent-1',
    name: 'Code Specialist',
    engine: 'antigravity',
    purpose: 'Autonomous coding',
    avatar: null,
    createdAtUnixMs: 1000,
    pinned: false,
    order: 0,
    defaultMode: 'fullAccess',
    defaultPlan: true,
    defaultModel: 'gemini-2.5-pro',
    placeDisplayNames: ['Workspace Alpha'],
  };

  const mockFullProfile = {
    ...mockAgent,
    brief: 'Autonomous coding',
    memoryBudget: 2200,
    reflectionMode: 'ask',
    allowAgentScheduling: true,
    allowAgentMessaging: true,
  };

  const mockMind = {
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(ipc, 'invokeCommand').mockImplementation(async (cmd: string) => {
      if (cmd === 'list_agent_profiles') return [mockAgent];
      if (cmd === 'list_starters') return [];
      if (cmd === 'load_agent_profile') return mockFullProfile;
      if (cmd === 'load_agent_mind') return mockMind;
      if (cmd === 'list_active_agent_runs') return [];
      if (cmd === 'update_agent_profile') return mockFullProfile;
      return null;
    });
  });

  it('passes real workspaceId and workspaces down to AgentChatSurface -> ChatView', async () => {
    render(
      <AgentsView
        agents={[mockAgent]}
        workspaceId="ws-repo-99"
        workspaces={[{ id: 'ws-repo-99', displayName: 'Repo 99', createdAtUnixMs: 1, lastOpenedAtUnixMs: 1, pinned: false, available: true }]}
        selectedAgentId="agent-1"
        onSelectAgent={vi.fn()}
      />
    );

    await waitFor(() => {
      const chatView = screen.getByTestId('mock-chat-view');
      expect(chatView).toBeInTheDocument();
      expect(chatView.getAttribute('data-workspace-id')).toBe('ws-repo-99');
      expect(chatView.getAttribute('data-workspaces-count')).toBe('1');
    });
  });

  it('loads placeDisplayNames into settingsDraft and sends them on save', async () => {
    const user = userEvent.setup();
    render(
      <AgentsView
        agents={[mockAgent]}
        workspaceId="ws-repo-99"
        workspaces={[{ id: 'ws-repo-99', displayName: 'Repo 99', createdAtUnixMs: 1, lastOpenedAtUnixMs: 1, pinned: false, available: true }]}
        selectedAgentId="agent-1"
        onSelectAgent={vi.fn()}
        initialMode="settings"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Workspace Alpha')).toBeInTheDocument();
    });

    // Add another place
    const input = screen.getByRole('textbox', { name: /Add folder or place name/i });
    await user.type(input, 'Secondary Place');
    const addBtn = screen.getByRole('button', { name: /^Add$/i });
    await user.click(addBtn);

    expect(screen.getByText('Secondary Place')).toBeInTheDocument();

    // Save settings
    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'update_agent_profile',
        expect.objectContaining({
          placeDisplayNames: ['Workspace Alpha', 'Secondary Place'],
          defaultProviderOptions: expect.any(Array),
          disabledPluginIds: expect.any(Array),
        })
      );
    });
  });

  it('counts live runs matched by profileId without agentId or status fields', async () => {
    vi.spyOn(ipc, 'invokeCommand').mockImplementation(async (cmd: string) => {
      if (cmd === 'list_agent_profiles') return [mockAgent];
      if (cmd === 'list_starters') return [];
      if (cmd === 'load_agent_profile') return mockFullProfile;
      if (cmd === 'load_agent_mind') return mockMind;
      if (cmd === 'list_active_agent_runs') return [];
      if (cmd === 'list_live_chat_runs') {
        return [
          { profileId: 'agent-1', threadId: 't-fg', needsYou: false },
          { profileId: 'agent-1', threadId: 't-routine', needsYou: true },
          { profileId: 'agent-other', threadId: 't-other', needsYou: false },
        ];
      }
      return null;
    });

    render(
      <AgentsView
        agents={[mockAgent]}
        workspaceId="ws-repo-99"
        workspaces={[{ id: 'ws-repo-99', displayName: 'Repo 99', createdAtUnixMs: 1, lastOpenedAtUnixMs: 1, pinned: false, available: true }]}
        selectedAgentId="agent-1"
        onSelectAgent={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('2 working')).toBeInTheDocument();
    });
  });
});
