import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPaletteModal } from './CommandPaletteModal';
import type { AgentProfile } from '../../types';

describe('CommandPaletteModal', () => {
  it('renders command palette with commands and agent launch options when open', () => {
    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={vi.fn()}
        platform="windows"
      />
    );

    expect(screen.getByPlaceholderText(/Escribe un comando/)).toBeDefined();
    expect(screen.getByText('Switch to Agent Mode')).toBeDefined();
    expect(screen.getByText('Spawn Antigravity')).toBeDefined();
    expect(screen.getByText('Spawn Claude Code')).toBeDefined();
    expect(screen.getByText('Spawn OpenCode')).toBeDefined();
  });

  it('filters command list when user types query', () => {
    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={vi.fn()}
        platform="windows"
      />
    );

    const input = screen.getByPlaceholderText(/Escribe un comando/);
    fireEvent.change(input, { target: { value: 'terminal' } });

    expect(screen.getByText('Open New Terminal Session')).toBeDefined();
    expect(screen.queryByText('Switch to Agent Mode')).toBeNull();
  });

  it('finds Antigravity when searching "antigravity" or "anti gravity"', () => {
    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={vi.fn()}
        platform="windows"
      />
    );

    const input = screen.getByPlaceholderText(/Escribe un comando/);
    fireEvent.change(input, { target: { value: 'anti gravity' } });

    expect(screen.getByText('Spawn Antigravity')).toBeDefined();
    expect(screen.queryByText('Switch to Agent Mode')).toBeNull();
  });

  it('finds Claude Code when searching "cloud"', () => {
    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={vi.fn()}
        platform="windows"
      />
    );

    const input = screen.getByPlaceholderText(/Escribe un comando/);
    fireEvent.change(input, { target: { value: 'cloud' } });

    expect(screen.getByText('Spawn Claude Code')).toBeDefined();
  });

  it('spawns agent when clicking an agent engine item', () => {
    const onLaunchAgent = vi.fn();
    const onClose = vi.fn();

    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={onClose}
        onLaunchAgent={onLaunchAgent}
        platform="windows"
      />
    );

    const antigravityBtn = screen.getByText('Spawn Antigravity');
    fireEvent.click(antigravityBtn);

    expect(onLaunchAgent).toHaveBeenCalledWith('antigravity', 'Antigravity');
    expect(onClose).toHaveBeenCalled();
  });

  it('supports selecting custom saved agent profiles', () => {
    const onSelectAgent = vi.fn();
    const dummyAgent: AgentProfile = {
      id: 'agent-123',
      name: 'Arquitecto Backend',
      engine: 'claude-code',
      purpose: 'Diseño de arquitectura',
      avatar: null,
      createdAtUnixMs: Date.now(),
      pinned: true,
      order: 0,
    };

    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={vi.fn()}
        agents={[dummyAgent]}
        onSelectAgent={onSelectAgent}
        platform="windows"
      />
    );

    const input = screen.getByPlaceholderText(/Escribe un comando/);
    fireEvent.change(input, { target: { value: 'Arquitecto' } });

    const agentItem = screen.getByText('Abrir agente Arquitecto Backend');
    expect(agentItem).toBeDefined();

    fireEvent.click(agentItem);
    expect(onSelectAgent).toHaveBeenCalledWith('agent-123');
  });

  it('navigates with keyboard and executes with Enter', () => {
    const onToggleSidebar = vi.fn();
    const onClose = vi.fn();

    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={onClose}
        onToggleSidebar={onToggleSidebar}
        platform="windows"
      />
    );

    const input = screen.getByPlaceholderText(/Escribe un comando/);
    fireEvent.change(input, { target: { value: 'lateral' } });

    // Press Enter to execute the filtered top command
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onToggleSidebar).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={onClose}
        platform="windows"
      />
    );

    const input = screen.getByPlaceholderText(/Escribe un comando/);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
