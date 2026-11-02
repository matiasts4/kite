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
});
