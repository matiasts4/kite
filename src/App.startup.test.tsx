import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockGetBootstrap, mockGetAuthBootstrap, mockGetCreditsBalance, mockListChatSummaries, mockListArchivedChats } = vi.hoisted(() => ({
  mockGetBootstrap: vi.fn(),
  mockGetAuthBootstrap: vi.fn(),
  mockGetCreditsBalance: vi.fn(),
  mockListChatSummaries: vi.fn(),
  mockListArchivedChats: vi.fn(),
}));

vi.mock('./lib/ipc', () => ({
  getBootstrap: mockGetBootstrap,
  getAuthBootstrap: mockGetAuthBootstrap,
  getCreditsBalance: mockGetCreditsBalance,
  listChatSummaries: mockListChatSummaries,
  listArchivedChats: mockListArchivedChats,
  isTauriEnvironment: () => true,
  invokeCommand: vi.fn().mockResolvedValue(null),
  subscribeEvent: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('./components/TitleBar', () => ({
  TitleBar: ({
    activeMode,
    onModeChange,
  }: {
    activeMode: string;
    onModeChange: (mode: 'agent' | 'code' | 'chat') => void;
  }) => (
    <div data-testid="mock-titlebar" data-active-mode={activeMode}>
      <button type="button" onClick={() => onModeChange('agent')}>Switch Agent</button>
      <button type="button" onClick={() => onModeChange('code')}>Switch Code</button>
      <button type="button" onClick={() => onModeChange('chat')}>Switch Chat</button>
    </div>
  ),
}));

vi.mock('./components/Sidebar', () => ({
  Sidebar: ({
    mode,
    routinesOpen,
    onOpenRoutines,
    onShowModeHome,
    onSelectAgent,
    onSelectWorkspace,
    onSelectThread,
  }: {
    mode: string;
    routinesOpen?: boolean;
    onOpenRoutines?: () => void;
    onShowModeHome?: () => void;
    onSelectAgent?: (id: string) => void;
    onSelectWorkspace?: (id: string) => void;
    onSelectThread?: (id: string) => void;
  }) => (
    <div data-testid="mock-sidebar" data-mode={mode} data-routines-open={String(Boolean(routinesOpen))}>
      <button type="button" onClick={onOpenRoutines}>Sidebar Routines</button>
      <button type="button" onClick={onShowModeHome}>Sidebar Home</button>
      <button type="button" onClick={() => onSelectAgent?.('agent-1')}>Sidebar Agent</button>
      <button type="button" onClick={() => onSelectWorkspace?.('ws-1')}>Sidebar Workspace</button>
      <button type="button" onClick={() => onSelectThread?.('thread-1')}>Sidebar Thread</button>
    </div>
  ),
}));

vi.mock('./components/RightDock', () => ({
  RightDock: () => null,
}));

vi.mock('./components/app/AppMainStage', () => ({
  AppMainStage: ({
    workMode,
    hasOpenedChat,
    routinesOpen,
  }: {
    workMode: string;
    hasOpenedChat: boolean;
    routinesOpen?: boolean;
  }) => (
    <div
      data-testid="mock-main-stage"
      data-work-mode={workMode}
      data-has-opened-chat={String(hasOpenedChat)}
      data-routines-open={String(Boolean(routinesOpen))}
    />
  ),
}));

vi.mock('./components/app/AppModals', () => ({ AppModals: () => null }));
vi.mock('./components/app/AppNotificationsPopover', () => ({ AppNotificationsPopover: () => null }));
vi.mock('./components/views/SettingsView', () => ({ SettingsView: () => null }));
vi.mock('./components/ZedStrip', () => ({ ZedStripHost: () => null }));
vi.mock('./components/quota/GuidedLoginBanner', () => ({ GuidedLoginBanner: () => null }));
vi.mock('./motion/AppIntro', () => ({
  AppIntro: ({ open }: { open: boolean }) => <div data-testid="mock-intro" data-open={String(open)} />,
  releaseBootCover: vi.fn(),
}));
vi.mock('./lib/toast', () => ({ Toaster: () => null }));
vi.mock('./lib/notifications/useNotifications', () => ({
  useNotifications: () => ({ unreadCount: 0, snapshot: null }),
}));
vi.mock('./components/app/useAppShortcuts', () => ({ useAppShortcuts: () => {} }));
vi.mock('./components/app/useAppGlobalEvents', () => ({ useAppGlobalEvents: () => {} }));
vi.mock('./components/app/useAppSidebarHandlers', () => ({
  useAppSidebarHandlers: () => ({
    handleAddWorkspace: vi.fn(),
    handleCopyPath: vi.fn(),
    handleTogglePinWorkspace: vi.fn(),
    handleTogglePinAgent: vi.fn(),
    handleMoveAgent: vi.fn(),
    handleDeleteAgent: vi.fn(),
    handleRenameWorkspace: vi.fn(),
    handleRemoveWorkspaceFromList: vi.fn(),
    handleMoveWorkspace: vi.fn(),
    handleTogglePinThread: vi.fn(),
    handleRenameThread: vi.fn(),
    handleArchiveThread: vi.fn(),
    handleRestoreThread: vi.fn(),
    handleDeleteThread: vi.fn(),
    handleCloseWorkspaceTab: vi.fn(),
    handleRenameWorkspaceTab: vi.fn(),
  }),
}));

import { App } from './App';

describe('App startup workMode persistence and single bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockGetBootstrap.mockResolvedValue({
      workspaces: [{ id: 'ws-1', name: 'kite', path: 'c:/kite' }],
      agents: [{ id: 'agent-1', name: 'Coder', engine: 'claude' }],
      preferences: { workMode: 'code', appearance: 'dark' },
    });
    mockGetAuthBootstrap.mockResolvedValue({});
    mockGetCreditsBalance.mockResolvedValue({});
    mockListChatSummaries.mockResolvedValue([]);
    mockListArchivedChats.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('reopens in Thread (chat) when kite.workMode was last saved as chat', async () => {
    localStorage.setItem('kite.workMode', 'chat');

    render(<App />);

    const stage = screen.getByTestId('mock-main-stage');
    expect(stage.getAttribute('data-work-mode')).toBe('chat');
    expect(stage.getAttribute('data-has-opened-chat')).toBe('true');
    await waitFor(() => expect(mockGetBootstrap).toHaveBeenCalled());
  });

  it('reopens in Agent when kite.workMode was last saved as agent', async () => {
    localStorage.setItem('kite.workMode', 'agent');

    render(<App />);

    const stage = screen.getByTestId('mock-main-stage');
    expect(stage.getAttribute('data-work-mode')).toBe('agent');
    expect(stage.getAttribute('data-has-opened-chat')).toBe('false');
    await waitFor(() => expect(mockGetBootstrap).toHaveBeenCalled());
  });

  it('falls back to backend preferences.workMode when localStorage has no saved mode', async () => {
    mockGetBootstrap.mockResolvedValueOnce({
      workspaces: [{ id: 'ws-1', name: 'kite', path: 'c:/kite' }],
      agents: [{ id: 'agent-1', name: 'Coder', engine: 'claude' }],
      preferences: { workMode: 'chat', appearance: 'dark' },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-main-stage').getAttribute('data-work-mode')).toBe('chat');
    });
  });

  it('persists mode changes to kite.workMode immediately and runs bootstrap only once across startup and mode switches', async () => {
    localStorage.setItem('kite.workMode', 'code');

    render(<App />);

    await waitFor(() => {
      expect(mockGetBootstrap).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByText('Switch Chat'));
    expect(localStorage.getItem('kite.workMode')).toBe('chat');

    fireEvent.click(screen.getByText('Switch Agent'));
    expect(localStorage.getItem('kite.workMode')).toBe('agent');

    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetBootstrap).toHaveBeenCalledTimes(1);
  });

  it('closes routinesOpen when switching work mode, toggling Sidebar Routines, clicking mode home, or selecting an item', async () => {
    localStorage.setItem('kite.workMode', 'agent');
    render(<App />);

    await waitFor(() => expect(mockGetBootstrap).toHaveBeenCalledTimes(1));
    const stage = screen.getByTestId('mock-main-stage');
    expect(stage.getAttribute('data-routines-open')).toBe('false');

    // Open Routines -> click Switch Code closes Routines
    fireEvent.click(screen.getByText('Sidebar Routines'));
    expect(stage.getAttribute('data-routines-open')).toBe('true');
    fireEvent.click(screen.getByText('Switch Code'));
    expect(stage.getAttribute('data-routines-open')).toBe('false');

    // Open Routines -> click Switch Chat closes Routines
    fireEvent.click(screen.getByText('Sidebar Routines'));
    expect(stage.getAttribute('data-routines-open')).toBe('true');
    fireEvent.click(screen.getByText('Switch Chat'));
    expect(stage.getAttribute('data-routines-open')).toBe('false');

    // Open Routines -> click Sidebar Home closes Routines
    fireEvent.click(screen.getByText('Sidebar Routines'));
    expect(stage.getAttribute('data-routines-open')).toBe('true');
    fireEvent.click(screen.getByText('Sidebar Home'));
    expect(stage.getAttribute('data-routines-open')).toBe('false');

    // Open Routines -> clicking Sidebar Routines again toggles closed
    fireEvent.click(screen.getByText('Sidebar Routines'));
    expect(stage.getAttribute('data-routines-open')).toBe('true');
    fireEvent.click(screen.getByText('Sidebar Routines'));
    expect(stage.getAttribute('data-routines-open')).toBe('false');

    // Open Routines -> clicking Agent / Workspace / Thread closes Routines
    for (const label of ['Sidebar Agent', 'Sidebar Workspace', 'Sidebar Thread']) {
      fireEvent.click(screen.getByText('Sidebar Routines'));
      expect(stage.getAttribute('data-routines-open')).toBe('true');
      fireEvent.click(screen.getByText(label));
      expect(stage.getAttribute('data-routines-open')).toBe('false');
    }
  });
});
