import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NewSessionPane } from './NewSessionPane';
import type { AgentEngineDescriptor } from './types';

// Mock ipc
vi.mock('../../lib/ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({ teammates: [] }),
}));

describe('NewSessionPane - Launch Presets Behavioral Tests', () => {
  const dummyEngines: AgentEngineDescriptor[] = [
    { wireId: 'antigravity', displayName: 'Antigravity', shortDisplayName: 'AGY', vendor: 'Google', installed: true },
    { wireId: 'claude-code', displayName: 'Claude Code', shortDisplayName: 'Claude', vendor: 'Anthropic', installed: true },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  it('deduplicates presets when clicking New preset with same configuration', async () => {
    render(
      <NewSessionPane
        workspaceId="ws-test-1"
        workspaceName="Test Workspace"
        engines={dummyEngines}
        onCancel={vi.fn()}
        onLaunch={vi.fn()}
      />
    );

    const newPresetBtn = screen.getByText('New preset').closest('button');
    expect(newPresetBtn).not.toBeNull();

    // Click "New preset" twice with default engine and count
    await act(async () => {
      fireEvent.click(newPresetBtn!);
    });
    await act(async () => {
      fireEvent.click(newPresetBtn!);
    });

    // Check localStorage
    const saved = JSON.parse(localStorage.getItem('kite.launchPresets.ws-test-1') || '[]');
    // Exactly 1 preset should be stored, not duplicated!
    expect(saved.length).toBe(1);
  });

  it('deletes preset when clicking delete button on preset chip', async () => {
    render(
      <NewSessionPane
        workspaceId="ws-test-2"
        workspaceName="Test Workspace"
        engines={dummyEngines}
        onCancel={vi.fn()}
        onLaunch={vi.fn()}
      />
    );

    const newPresetBtn = screen.getByText('New preset').closest('button');
    await act(async () => {
      fireEvent.click(newPresetBtn!);
    });

    const deleteBtn = screen.getByTitle('Delete preset');
    expect(deleteBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    const saved = JSON.parse(localStorage.getItem('kite.launchPresets.ws-test-2') || '[]');
    expect(saved.length).toBe(0);
    expect(screen.queryByTitle('Delete preset')).toBeNull();
  });
});
