import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentPluginCoverage } from './useAgentPluginCoverage';
import * as ipc from '../../../lib/ipc';
import type { AgentProfile } from '../../../types';

vi.mock('../../../lib/ipc', () => ({
  listAgentProfiles: vi.fn(),
  invokeCommand: vi.fn(),
}));

describe('useAgentPluginCoverage', () => {
  const mockAgents: AgentProfile[] = [
    {
      id: 'agent-1',
      name: 'Orion',
      engine: 'antigravity',
      purpose: 'Software engineering',
      avatar: null,
      createdAtUnixMs: 12345678,
      pinned: true,
      order: 0,
      disabledPluginIds: ['stripe'],
    },
    {
      id: 'agent-2',
      name: 'Atlas',
      engine: 'codex',
      purpose: 'Architecture & Design',
      avatar: null,
      createdAtUnixMs: 12345679,
      pinned: false,
      order: 1,
      disabledPluginIds: [],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches agents on mount and correctly computes active agents per plugin', async () => {
    vi.mocked(ipc.listAgentProfiles).mockResolvedValueOnce(mockAgents);
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd, args: any) => {
      if (cmd === 'load_agent_profile') {
        const found = mockAgents.find((a) => a.id === args?.agentId);
        return { disabledPluginIds: found?.disabledPluginIds ?? [] };
      }
      return {};
    });

    const { result } = renderHook(() => useAgentPluginCoverage());

    expect(result.current.loading).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.agents).toHaveLength(2);

    // Stripe is disabled for agent-1, enabled for agent-2
    expect(result.current.isPluginEnabledForAgent('agent-1', 'stripe')).toBe(false);
    expect(result.current.isPluginEnabledForAgent('agent-2', 'stripe')).toBe(true);

    const stripeAgents = result.current.activeAgentsForPlugin('stripe');
    expect(stripeAgents).toHaveLength(1);
    expect(stripeAgents[0].id).toBe('agent-2');

    // GitHub is enabled for both
    const githubAgents = result.current.activeAgentsForPlugin('github');
    expect(githubAgents).toHaveLength(2);
  });

  it('optimistically toggles plugin and invokes update_agent_profile', async () => {
    vi.mocked(ipc.listAgentProfiles).mockResolvedValueOnce(mockAgents);
    vi.mocked(ipc.invokeCommand).mockResolvedValue({});

    const { result } = renderHook(() => useAgentPluginCoverage());

    await act(async () => {
      await Promise.resolve();
    });

    // Disable github for agent-2
    await act(async () => {
      await result.current.togglePluginForAgent('agent-2', 'github', false);
    });

    expect(result.current.isPluginEnabledForAgent('agent-2', 'github')).toBe(false);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('update_agent_profile', {
      agentId: 'agent-2',
      disabledPluginIds: ['github'],
    });

    // Enable stripe for agent-1
    await act(async () => {
      await result.current.togglePluginForAgent('agent-1', 'stripe', true);
    });

    expect(result.current.isPluginEnabledForAgent('agent-1', 'stripe')).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('update_agent_profile', {
      agentId: 'agent-1',
      disabledPluginIds: [],
    });
  });

  it('rolls back optimistic state when update_agent_profile fails', async () => {
    vi.mocked(ipc.listAgentProfiles).mockResolvedValueOnce(mockAgents);
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'update_agent_profile') {
        throw new Error('Database locked');
      }
      return {};
    });

    const { result } = renderHook(() => useAgentPluginCoverage());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isPluginEnabledForAgent('agent-2', 'github')).toBe(true);

    let caughtError: any = null;
    await act(async () => {
      try {
        await result.current.togglePluginForAgent('agent-2', 'github', false);
      } catch (err) {
        caughtError = err;
      }
    });

    expect(caughtError).toBeTruthy();
    expect(result.current.error).toBe('Database locked');
    // Rolled back to true
    expect(result.current.isPluginEnabledForAgent('agent-2', 'github')).toBe(true);
  });

  it('falls back to default agents when IPC fails', async () => {
    vi.mocked(ipc.listAgentProfiles).mockRejectedValueOnce(new Error('Outside Tauri'));

    const { result } = renderHook(() => useAgentPluginCoverage());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.agents.length).toBeGreaterThan(0);
    expect(result.current.agents[0].name).toBe('Orion');
  });
});
