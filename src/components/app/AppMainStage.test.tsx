import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AppMainStage } from './AppMainStage';

const { mockThrowChat } = vi.hoisted(() => ({
  mockThrowChat: { value: false },
}));

vi.mock('../../lib/ipc', () => ({
  isTauriEnvironment: () => true,
  invokeCommand: vi.fn(),
  subscribeEvent: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('../views/AgentsView', () => ({
  AgentsView: () => <div data-testid="stage-agents-view" />,
}));
vi.mock('../code/CodeWorkspace', () => ({
  CodeWorkspace: () => <div data-testid="stage-code-view" />,
}));
vi.mock('../views/ChatView', () => ({
  ChatView: () => {
    if (mockThrowChat.value) {
      throw new Error('Synthetic ChatView render crash');
    }
    return <div data-testid="stage-chat-view" />;
  },
}));
vi.mock('../views/RoutinesView', () => ({
  RoutinesView: () => <div data-testid="stage-routines-view" />,
}));

describe('AppMainStage lazy mode mounting', () => {
  afterEach(() => {
    cleanup();
  });

  it('mounts only the initial active mode on startup and preserves visited modes across switches', async () => {
    const baseProps = {
      setWorkMode: vi.fn(),
      loading: false,
      error: null,
      workspaces: [{ id: 'ws-1', displayName: 'kite', createdAtUnixMs: 1, lastOpenedAtUnixMs: 1, pinned: false, available: true }],
      agents: [{ id: 'a-1', name: 'Agent', engine: 'claude', purpose: '', avatar: null, createdAtUnixMs: 1, pinned: false, order: 0 }],
      setAgents: vi.fn(),
      selectedWorkspaceId: 'ws-1',
      setSelectedWorkspaceId: vi.fn(),
      selectedAgentId: 'a-1',
      setSelectedAgentId: vi.fn(),
      selectedThreadId: null,
      agentEditorOpen: false,
      setAgentEditorOpen: vi.fn(),
      agentViewMode: 'chats' as const,
      setAgentViewMode: vi.fn(),
      routinesOpen: false,
      setRoutinesOpen: vi.fn(),
      setSettingsOpen: vi.fn(),
      hasOpenedChat: true,
      loadBootstrap: vi.fn(),
      loadThreads: vi.fn(),
      handleAddWorkspace: vi.fn(),
      handleCodeSessions: vi.fn(),
      requestedCodeTabId: null,
      setRequestedCodeTabId: vi.fn(),
      newSessionRequest: 0,
    };

    const { rerender } = render(<AppMainStage {...baseProps} workMode="chat" />);

    expect(await screen.findByTestId('stage-chat-view')).toBeInTheDocument();
    expect(screen.queryByTestId('stage-code-view')).toBeNull();
    expect(screen.queryByTestId('stage-agents-view')).toBeNull();

    rerender(<AppMainStage {...baseProps} workMode="code" />);
    expect(await screen.findByTestId('stage-code-view')).toBeInTheDocument();
    expect(screen.getByTestId('stage-chat-view')).toBeInTheDocument();

    const chatLayer = screen.getByTestId('stage-chat-view').closest('.mode-layer');
    const codeLayer = screen.getByTestId('stage-code-view').closest('.mode-layer');
    expect(chatLayer).toHaveAttribute('aria-hidden', 'true');
    expect(chatLayer).not.toHaveClass('mode-layer--visible');
    expect(codeLayer).toHaveAttribute('aria-hidden', 'false');
    expect(codeLayer).toHaveClass('mode-layer--visible');
  });

  it('isolates view render errors inside an ErrorBoundary instead of blanking the shell', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockThrowChat.value = true;
    try {
      const baseProps = {
        setWorkMode: vi.fn(),
        loading: false,
        error: null,
        workspaces: [{ id: 'ws-1', displayName: 'kite', createdAtUnixMs: 1, lastOpenedAtUnixMs: 1, pinned: false, available: true }],
        agents: [{ id: 'a-1', name: 'Agent', engine: 'claude', purpose: '', avatar: null, createdAtUnixMs: 1, pinned: false, order: 0 }],
        setAgents: vi.fn(),
        selectedWorkspaceId: 'ws-1',
        setSelectedWorkspaceId: vi.fn(),
        selectedAgentId: 'a-1',
        setSelectedAgentId: vi.fn(),
        selectedThreadId: null,
        agentEditorOpen: false,
        setAgentEditorOpen: vi.fn(),
        agentViewMode: 'chats' as const,
        setAgentViewMode: vi.fn(),
        routinesOpen: false,
        setRoutinesOpen: vi.fn(),
        setSettingsOpen: vi.fn(),
        hasOpenedChat: true,
        loadBootstrap: vi.fn(),
        loadThreads: vi.fn(),
        handleAddWorkspace: vi.fn(),
        handleCodeSessions: vi.fn(),
        requestedCodeTabId: null,
        setRequestedCodeTabId: vi.fn(),
        newSessionRequest: 0,
      };

      render(<AppMainStage {...baseProps} workMode="chat" />);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('ChatView failed to display')).toBeInTheDocument();
      expect(screen.getByText('Synthetic ChatView render crash')).toBeInTheDocument();
    } finally {
      mockThrowChat.value = false;
      errSpy.mockRestore();
    }
  });
});
