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
      data-thread-id={props.threadId ?? 'null'}
    >
      Mock Chat View: {props.agentName}
    </div>
  ),
}));

vi.mock('./AgentTerminalPane', () => ({
  AgentTerminalPane: (props: any) => <div data-testid="mock-terminal">{props.agentName}</div>,
}));

vi.mock('./AgentMemoryTab', () => ({
  AgentMemoryTab: (props: any) => (
    <div
      data-testid="mock-memory-tab"
      data-agent-id={props.agentId ?? ''}
      data-workspace-id={props.workspaceId ?? ''}
      data-places={JSON.stringify(props.placeDisplayNames ?? [])}
    >
      Mock Memory
    </div>
  ),
}));

vi.mock('./AgentSkillsTab', () => ({
  AgentSkillsTab: (props: any) => (
    <div
      data-testid="mock-skills-tab"
      data-agent-id={props.agentId ?? ''}
      data-workspace-id={props.workspaceId ?? ''}
    >
      Mock Skills
    </div>
  ),
}));

vi.mock('./AgentStartersTab', () => ({
  AgentStartersTab: () => <div>Mock Starters</div>,
}));

vi.mock('./AgentPlaybooksTab', () => ({
  AgentPlaybooksTab: (props: any) => (
    <div data-testid="mock-playbooks-tab">
      <button type="button" onClick={() => props.onOpenThread?.('pb-thread-1')}>
        Open Playbook Thread
      </button>
    </div>
  ),
}));

vi.mock('./AgentAuditTab', () => ({
  AgentAuditTab: (props: any) => (
    <div data-testid="mock-audit-tab">
      <button type="button" onClick={() => props.onOpenThread?.('audit-thread-1')}>
        Open Audit Thread
      </button>
    </div>
  ),
}));

vi.mock('./AgentBundleModal', () => ({
  AgentBundleModal: (props: any) => (
    <div data-testid="mock-bundle-modal" data-open={props.isOpen ? 'true' : 'false'}>
      <button type="button" onClick={() => props.onImported?.()}>
        Trigger Bundle Imported
      </button>
    </div>
  ),
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

    await waitFor(
      () => {
        expect(screen.getByText('Workspace Alpha')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

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

  it('hides module tabs and terminal toggle in chats mode, opens 5 config modules under Edit, forwards selectedThreadId, and wires onOpenThread', async () => {
    const user = userEvent.setup();
    const selectedThreadEvents: unknown[] = [];
    const agentsChangedSpy = vi.fn();
    const onSelectThread = (e: Event) => {
      selectedThreadEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener('kite:select-thread', onSelectThread);
    window.addEventListener('kite:agents-changed', agentsChangedSpy);

    try {
      render(
        <AgentsView
          agents={[mockAgent]}
          workspaceId="ws-repo-99"
          workspaces={[{ id: 'ws-repo-99', displayName: 'Repo 99', createdAtUnixMs: 1, lastOpenedAtUnixMs: 1, pinned: false, available: true }]}
          selectedAgentId="agent-1"
          selectedThreadId="agent-thread-77"
          onSelectAgent={vi.fn()}
        />
      );

      // Module tabs and Chat | Terminal switcher stay hidden during normal chatting
      expect(screen.queryByRole('button', { name: 'Agent Chats' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Agent Skills' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Agent Memory' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Interaction surface' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('mock-terminal')).not.toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByTestId('mock-chat-view').getAttribute('data-thread-id')).toBe('agent-thread-77');
      });

      // Clicking Edit opens the configuration module tabs (Settings, Skills, Memory, Playbooks, Audit)
      await user.click(screen.getByRole('button', { name: 'Edit agent' }));
      expect(screen.getByRole('button', { name: 'Back to chat' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent Settings' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent Skills' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent Memory' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent Playbooks' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Agent Audit' })).toBeInTheDocument();

      // Skills and Memory receive agent/workspace context props
      await user.click(screen.getByRole('button', { name: 'Agent Skills' }));
      expect(screen.getByTestId('mock-skills-tab')).toHaveAttribute('data-agent-id', 'agent-1');
      expect(screen.getByTestId('mock-skills-tab')).toHaveAttribute('data-workspace-id', 'ws-repo-99');

      await user.click(screen.getByRole('button', { name: 'Agent Memory' }));
      expect(screen.getByTestId('mock-memory-tab')).toHaveAttribute('data-agent-id', 'agent-1');
      expect(screen.getByTestId('mock-memory-tab')).toHaveAttribute('data-workspace-id', 'ws-repo-99');
      expect(screen.getByTestId('mock-memory-tab')).toHaveAttribute('data-places', '["Workspace Alpha"]');

      // Playbooks and Audit wire onOpenThread via kite:select-thread
      await user.click(screen.getByRole('button', { name: 'Agent Playbooks' }));
      await user.click(screen.getByRole('button', { name: 'Open Playbook Thread' }));
      await user.click(screen.getByRole('button', { name: 'Agent Audit' }));
      await user.click(screen.getByRole('button', { name: 'Open Audit Thread' }));
      expect(selectedThreadEvents).toEqual([
        { threadId: 'pb-thread-1', mode: 'chat' },
        { threadId: 'audit-thread-1', mode: 'chat' },
      ]);

      // Bundle modal onImported dispatches kite:agents-changed and refreshes starters
      await user.click(screen.getByRole('button', { name: 'Trigger Bundle Imported' }));
      expect(agentsChangedSpy).toHaveBeenCalledTimes(1);

      // Returning to chat hides the config modules bar again
      await user.click(screen.getByRole('button', { name: 'Back to chat' }));
      expect(screen.queryByRole('button', { name: 'Agent Skills' })).not.toBeInTheDocument();
      expect(screen.getByTestId('mock-chat-view')).toBeInTheDocument();
    } finally {
      window.removeEventListener('kite:select-thread', onSelectThread);
      window.removeEventListener('kite:agents-changed', agentsChangedSpy);
    }
  });

  it('defers non-chat starter, profile, and mind IPC calls until entering config/skills views', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_agent_starters') return [];
      if (cmd === 'load_agent_profile') return mockFullProfile;
      if (cmd === 'load_agent_mind') return mockMind;
      return null;
    });

    render(
      <AgentsView
        agents={[mockAgent]}
        selectedAgentId="a1"
        onSelectAgent={vi.fn()}
      />
    );

    expect(await screen.findByTestId('mock-chat-view')).toBeInTheDocument();
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('list_agent_starters', expect.anything());
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('load_agent_profile', expect.anything());
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('load_agent_mind', expect.anything());

    await user.click(screen.getByRole('button', { name: 'Edit agent' }));
    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith('load_agent_profile', { agentId: 'a1' });
      expect(ipc.invokeCommand).toHaveBeenCalledWith('load_agent_mind', { agentId: 'a1' });
    });

    await user.click(screen.getByRole('button', { name: 'Agent Skills' }));
    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith('list_agent_starters', { supportedCatalogVersion: 1 });
    });
  });
});
