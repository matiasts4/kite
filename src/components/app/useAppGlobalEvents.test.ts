import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAppGlobalEvents } from './useAppGlobalEvents';

describe('useAppGlobalEvents Hook', () => {
  it('handles kite:navigate-mode event with aliases', () => {
    const setWorkMode = vi.fn();
    const setSettingsOpen = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode,
        setSettingsOpen,
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'threads' }));
    });

    expect(setWorkMode).toHaveBeenCalledWith('chat');
    expect(setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('handles kite:open-settings event', () => {
    const setSettingsOpen = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen,
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:open-settings'));
    });

    expect(setSettingsOpen).toHaveBeenCalledWith(true);
  });

  it('handles kite:open-command-palette event', () => {
    const setIsCommandPaletteOpen = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible: vi.fn(),
        setIsCommandPaletteOpen,
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:open-command-palette'));
    });

    expect(setIsCommandPaletteOpen).toHaveBeenCalledWith(true);
  });
});
