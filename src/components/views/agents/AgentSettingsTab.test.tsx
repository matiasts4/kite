import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentSettingsTab, type AgentSettingsDraft } from './AgentSettingsTab';
import * as pluginHook from '../plugins/usePluginConnections';
import * as ipc from '../../../lib/ipc';

vi.mock('../../../lib/ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({}),
}));

describe('AgentSettingsTab - Plugin & MCP Integration', () => {
  const defaultDraft: AgentSettingsDraft = {
    name: 'Research Agent',
    purpose: 'Assists with technical deep dives',
    engine: 'claude',
    memoryBudget: 32000,
    reflectionMode: 'balanced',
    allowAgentScheduling: true,
    allowAgentMessaging: true,
    disabledPluginIds: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(ipc, 'invokeCommand').mockResolvedValue({ allServers: [] });
  });

  it('renders connected plugins from usePluginConnections in the MCP list', () => {
    vi.spyOn(pluginHook, 'usePluginConnections').mockReturnValue({
      connections: [
        { id: 'github', state: 'connected', account: 'octocat', message: null },
        { id: 'stripe', state: 'connected', account: 'acct_123', message: null },
        { id: 'slack', state: 'disconnected', account: null, message: null },
      ],
      ready: true,
      error: null,
      pending: false,
      action: vi.fn(),
      refresh: vi.fn(),
    });

    const setSettingsDraft = vi.fn();
    const setSettingsDirty = vi.fn();

    render(
      <AgentSettingsTab
        settingsDraft={defaultDraft}
        setSettingsDraft={setSettingsDraft}
        settingsDirty={false}
        setSettingsDirty={setSettingsDirty}
        onSaveSettings={vi.fn()}
        onRevertSettings={vi.fn()}
      />
    );

    // GitHub and Stripe should be rendered as connected plugins in the MCP list with switches
    expect(screen.getByRole('switch', { name: /Enable GitHub for this agent/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Enable Stripe for this agent/i })).toBeInTheDocument();

    // Disconnected slack should NOT be shown in the connected plugins list
    expect(screen.queryByRole('switch', { name: /Enable Slack for this agent/i })).not.toBeInTheDocument();

    // The badge shows Kite Plugin
    const pluginBadges = screen.getAllByText('Kite Plugin');
    expect(pluginBadges.length).toBe(2);
  });

  it('allows toggling individual plugins via disabledPluginIds', async () => {
    const user = userEvent.setup();

    vi.spyOn(pluginHook, 'usePluginConnections').mockReturnValue({
      connections: [
        { id: 'github', state: 'connected', account: 'octocat', message: null },
      ],
      ready: true,
      error: null,
      pending: false,
      action: vi.fn(),
      refresh: vi.fn(),
    });

    let currentDraft = { ...defaultDraft, disabledPluginIds: [] as string[] };
    const setSettingsDraft = vi.fn((updater) => {
      currentDraft = typeof updater === 'function' ? updater(currentDraft) : updater;
    });
    const setSettingsDirty = vi.fn();

    const { rerender } = render(
      <AgentSettingsTab
        settingsDraft={currentDraft}
        setSettingsDraft={setSettingsDraft}
        settingsDirty={false}
        setSettingsDirty={setSettingsDirty}
        onSaveSettings={vi.fn()}
        onRevertSettings={vi.fn()}
      />
    );

    const switchBtn = screen.getByRole('switch', { name: /Enable GitHub for this agent/i });
    expect(switchBtn).toHaveAttribute('aria-checked', 'true');

    // Click to disable GitHub
    await user.click(switchBtn);
    expect(setSettingsDirty).toHaveBeenCalledWith(true);
    expect(setSettingsDraft).toHaveBeenCalled();
    expect(currentDraft.disabledPluginIds).toContain('github');

    // Re-render with updated draft
    rerender(
      <AgentSettingsTab
        settingsDraft={currentDraft}
        setSettingsDraft={setSettingsDraft}
        settingsDirty={true}
        setSettingsDirty={setSettingsDirty}
        onSaveSettings={vi.fn()}
        onRevertSettings={vi.fn()}
      />
    );

    expect(screen.getByRole('switch', { name: /Enable GitHub for this agent/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  describe('Places Configuration (S4)', () => {
    it('renders "Home only" when placeDisplayNames is empty', () => {
      render(
        <AgentSettingsTab
          settingsDraft={{ ...defaultDraft, placeDisplayNames: [] }}
          setSettingsDraft={vi.fn()}
          settingsDirty={false}
          setSettingsDirty={vi.fn()}
          onSaveSettings={vi.fn()}
          onRevertSettings={vi.fn()}
        />
      );

      expect(screen.getByText('Home only')).toBeInTheDocument();
    });

    it('renders existing place chips with remove buttons and allows removing a place', async () => {
      const user = userEvent.setup();
      let currentDraft: AgentSettingsDraft = {
        ...defaultDraft,
        placeDisplayNames: ['Backend Repo', 'Docs Folder'],
      };
      const setSettingsDraft = vi.fn((updater) => {
        currentDraft = typeof updater === 'function' ? updater(currentDraft) : updater;
      });
      const setSettingsDirty = vi.fn();

      const { rerender } = render(
        <AgentSettingsTab
          settingsDraft={currentDraft}
          setSettingsDraft={setSettingsDraft}
          settingsDirty={false}
          setSettingsDirty={setSettingsDirty}
          onSaveSettings={vi.fn()}
          onRevertSettings={vi.fn()}
        />
      );

      expect(screen.getByText('Backend Repo')).toBeInTheDocument();
      expect(screen.getByText('Docs Folder')).toBeInTheDocument();

      const removeBtn = screen.getByRole('button', { name: /Remove Backend Repo/i });
      await user.click(removeBtn);

      expect(setSettingsDirty).toHaveBeenCalledWith(true);
      expect(currentDraft.placeDisplayNames).toEqual(['Docs Folder']);

      rerender(
        <AgentSettingsTab
          settingsDraft={currentDraft}
          setSettingsDraft={setSettingsDraft}
          settingsDirty={true}
          setSettingsDirty={setSettingsDirty}
          onSaveSettings={vi.fn()}
          onRevertSettings={vi.fn()}
        />
      );

      expect(screen.queryByText('Backend Repo')).not.toBeInTheDocument();
      expect(screen.getByText('Docs Folder')).toBeInTheDocument();
    });

    it('allows adding a new place via text input and Add button', async () => {
      const user = userEvent.setup();
      let currentDraft: AgentSettingsDraft = {
        ...defaultDraft,
        placeDisplayNames: [],
      };
      const setSettingsDraft = vi.fn((updater) => {
        currentDraft = typeof updater === 'function' ? updater(currentDraft) : updater;
      });
      const setSettingsDirty = vi.fn();

      render(
        <AgentSettingsTab
          settingsDraft={currentDraft}
          setSettingsDraft={setSettingsDraft}
          settingsDirty={false}
          setSettingsDirty={setSettingsDirty}
          onSaveSettings={vi.fn()}
          onRevertSettings={vi.fn()}
        />
      );

      const input = screen.getByRole('textbox', { name: /Add folder or place name/i });
      await user.type(input, 'Frontend App');

      const addBtn = screen.getByRole('button', { name: /^Add$/i });
      await user.click(addBtn);

      expect(setSettingsDirty).toHaveBeenCalledWith(true);
      expect(currentDraft.placeDisplayNames).toEqual(['Frontend App']);
    });

    it('allows adding a place from available workspaces dropdown', async () => {
      const user = userEvent.setup();
      let currentDraft: AgentSettingsDraft = {
        ...defaultDraft,
        placeDisplayNames: [],
      };
      const setSettingsDraft = vi.fn((updater) => {
        currentDraft = typeof updater === 'function' ? updater(currentDraft) : updater;
      });
      const setSettingsDirty = vi.fn();

      render(
        <AgentSettingsTab
          settingsDraft={currentDraft}
          setSettingsDraft={setSettingsDraft}
          settingsDirty={false}
          setSettingsDirty={setSettingsDirty}
          onSaveSettings={vi.fn()}
          onRevertSettings={vi.fn()}
          workspaces={[{ id: 'ws-1', displayName: 'Project Kite' } as any]}
        />
      );

      const select = screen.getByRole('combobox', { name: /Add from workspace/i });
      await user.selectOptions(select, 'Project Kite');

      expect(setSettingsDirty).toHaveBeenCalledWith(true);
      expect(currentDraft.placeDisplayNames).toEqual(['Project Kite']);
    });

    it('calls onSaveSettings without firing a duplicate update_agent_profile IPC call', async () => {
      const user = userEvent.setup();
      vi.spyOn(pluginHook, 'usePluginConnections').mockReturnValue({
        connections: [],
        ready: true,
        error: null,
        pending: false,
        action: vi.fn(),
        refresh: vi.fn(),
      });
      const onSaveSettings = vi.fn().mockResolvedValue(undefined);
      const setSettingsDirty = vi.fn();

      render(
        <AgentSettingsTab
          agentId="agent-1"
          settingsDraft={defaultDraft}
          setSettingsDraft={vi.fn()}
          settingsDirty={true}
          setSettingsDirty={setSettingsDirty}
          onSaveSettings={onSaveSettings}
          onRevertSettings={vi.fn()}
        />
      );

      const saveBtn = screen.getByRole('button', { name: /^Save$/i });
      await user.click(saveBtn);

      expect(onSaveSettings).toHaveBeenCalledTimes(1);
      expect(ipc.invokeCommand).not.toHaveBeenCalledWith(
        'update_agent_profile',
        expect.anything()
      );
    });
  });
});
