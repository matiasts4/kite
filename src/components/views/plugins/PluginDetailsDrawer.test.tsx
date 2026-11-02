import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PluginDetailsDrawer } from './PluginDetailsDrawer';
import type { ActivePlugin } from './types';
import type { AgentProfile } from '../../../types';

vi.mock('../../../lib/ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue(null),
}));

describe('PluginDetailsDrawer - Credentials & Governance Tests', () => {
  const mockPlugin: ActivePlugin = {
    id: 'fal',
    name: 'fal',
    vendor: 'fal.ai',
    version: 'v2.0.1',
    category: 'creative',
    summary: 'Generate images and videos with your fal.ai key.',
    description: 'Run blazing-fast diffusion inference.',
    authentication: 'apiKey',
    prefersDarkTile: false,
    logo: { file: 'plugin-fal' },
    fallbackIcon: null,
    initialState: 'disconnected',
    permissions: ['Execute image diffusion pipelines'],
    status: 'available',
  };

  const mockAgents: AgentProfile[] = [
    {
      id: 'agent-1',
      name: 'Claude Assistant',
      engine: 'claude-code',
      purpose: 'Coding agent',
      avatar: null,
      createdAtUnixMs: 12345,
      pinned: false,
      order: 0,
      disabledPluginIds: [],
    },
    {
      id: 'agent-2',
      name: 'Antigravity Architect',
      engine: 'antigravity',
      purpose: 'System design',
      avatar: null,
      createdAtUnixMs: 12346,
      pinned: true,
      order: 1,
      disabledPluginIds: ['fal'],
    },
  ];

  it('prevents connecting without API key and shows validation warning', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onSaveConfig = vi.fn();

    render(
      <PluginDetailsDrawer
        plugin={mockPlugin}
        isOpen={true}
        onClose={vi.fn()}
        onAction={onAction}
        onSaveConfig={onSaveConfig}
        agents={mockAgents}
      />
    );

    // Try to connect without entering key
    const connectBtn = screen.getByRole('button', { name: /Conectar Servicio/i });
    await user.click(connectBtn);

    // Should NOT have called onAction
    expect(onAction).not.toHaveBeenCalled();

    // Should display validation error
    expect(screen.getByText(/Se requiere una clave de API válida/i)).toBeInTheDocument();
  });

  it('connects successfully after typing API key', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onSaveConfig = vi.fn();

    render(
      <PluginDetailsDrawer
        plugin={mockPlugin}
        isOpen={true}
        onClose={vi.fn()}
        onAction={onAction}
        onSaveConfig={onSaveConfig}
        agents={mockAgents}
      />
    );

    const input = screen.getByPlaceholderText(/Ingresa tu clave de API/i);
    await user.type(input, 'fal-secret-key-123');

    const connectBtn = screen.getByRole('button', { name: /Conectar Servicio/i });
    await user.click(connectBtn);

    expect(onAction).toHaveBeenCalledWith('fal', 'connect');
    expect(onSaveConfig).toHaveBeenCalledWith('fal', expect.objectContaining({ apiKey: 'fal-secret-key-123' }));
  });

  it('allows toggling providers in the providers tab and syncs with matching agents', async () => {
    const user = userEvent.setup();
    const onTogglePluginForAgent = vi.fn().mockResolvedValue(undefined);

    render(
      <PluginDetailsDrawer
        plugin={mockPlugin}
        isOpen={true}
        onClose={vi.fn()}
        agents={mockAgents}
        onTogglePluginForAgent={onTogglePluginForAgent}
      />
    );

    // Click on Proveedores tab
    const providersTab = screen.getByRole('button', { name: /Proveedores/i });
    await user.click(providersTab);

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Antigravity')).toBeInTheDocument();

    // Toggle switch for Claude Code
    const claudeSwitch = screen.getByRole('switch', { name: /Habilitar fal para Claude Code/i });
    await user.click(claudeSwitch);

    // Should sync with agent-1 which uses claude-code
    expect(onTogglePluginForAgent).toHaveBeenCalledWith('agent-1', 'fal', expect.any(Boolean));
  });

  it('allows toggling individual agents in the agents tab', async () => {
    const user = userEvent.setup();
    const onTogglePluginForAgent = vi.fn().mockResolvedValue(undefined);

    render(
      <PluginDetailsDrawer
        plugin={mockPlugin}
        isOpen={true}
        onClose={vi.fn()}
        agents={mockAgents}
        onTogglePluginForAgent={onTogglePluginForAgent}
      />
    );

    // Click on Agentes tab
    const agentsTab = screen.getByRole('button', { name: /Agentes/i });
    await user.click(agentsTab);

    expect(screen.getByText('Claude Assistant')).toBeInTheDocument();
    expect(screen.getByText('Antigravity Architect')).toBeInTheDocument();

    // Toggle switch for Claude Assistant
    const agentSwitch = screen.getByRole('switch', { name: /Habilitar fal para Claude Assistant/i });
    await user.click(agentSwitch);

    expect(onTogglePluginForAgent).toHaveBeenCalledWith('agent-1', 'fal', false);
  });
});
