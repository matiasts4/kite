import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAppGlobalEvents } from './useAppGlobalEvents';
import { OPEN_RIGHT_DOCK_SUBAGENT_EVENT } from '../../lib/subagentNav';

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

  it('opens RightDock and selects workspace when kite:open-right-dock-subagent fires', () => {
    const setRightDockVisible = vi.fn();
    const setSelectedWorkspaceId = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId,
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible,
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, {
          detail: { threadId: 't-1', subagentId: 'sub-1', workspaceId: 'ws-9' },
        })
      );
    });

    expect(setRightDockVisible).toHaveBeenCalledWith(true);
    expect(setSelectedWorkspaceId).toHaveBeenCalledWith('ws-9');
  });

  it('opens RightDock on kite:open-right-dock-diffs, kite:open-diffs, and Ctrl+Alt+S', () => {
    const setRightDockVisible = vi.fn();

    renderHook(() =>
      useAppGlobalEvents({
        setWorkMode: vi.fn(),
        setSettingsOpen: vi.fn(),
        setRoutinesOpen: vi.fn(),
        setSelectedWorkspaceId: vi.fn(),
        setSelectedAgentId: vi.fn(),
        setSelectedThreadId: vi.fn(),
        setRightDockVisible,
        setIsCommandPaletteOpen: vi.fn(),
        onAddWorkspace: vi.fn(),
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        setAgents: vi.fn(),
        selectedAgentId: null,
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('kite:open-right-dock-diffs'));
      window.dispatchEvent(new CustomEvent('kite:open-diffs'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, altKey: true }));
    });

    expect(setRightDockVisible).toHaveBeenCalledTimes(3);
    expect(setRightDockVisible).toHaveBeenNthCalledWith(1, true);
    expect(setRightDockVisible).toHaveBeenNthCalledWith(2, true);
    expect(setRightDockVisible).toHaveBeenNthCalledWith(3, true);
  });
});
