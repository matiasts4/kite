import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AppModals } from './AppModals';

// Mock inner modals that require heavy dependencies or browser APIs
vi.mock('../modals/CommandPaletteModal', () => ({
  CommandPaletteModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="command-palette-modal">Command Palette</div> : null,
}));

vi.mock('../views/modals/UsageDashboardModal', () => ({
  UsageDashboardModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="usage-dashboard-modal">Usage Modal</div> : null,
}));

vi.mock('../views/modals/WhatsNewModal', () => ({
  WhatsNewModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="whats-new-modal">Whats New Modal</div> : null,
}));

vi.mock('../views/modals/ArchivedChatsModal', () => ({
  ArchivedChatsModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="archived-chats-modal">Archived Chats Modal</div> : null,
}));

vi.mock('../views/modals/SshWorkspaceModal', () => ({
  SshWorkspaceModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="ssh-workspace-modal">SSH Modal</div> : null,
}));

vi.mock('../code/PromptProjectileOverlay', () => ({
  PromptProjectileOverlay: () => <div data-testid="prompt-projectile-overlay" />,
}));

vi.mock('../modals/ResumeHost', () => ({
  ResumeHost: () => <div data-testid="resume-host" />,
}));

describe('AppModals Component', () => {
  it('renders overlay hosts and conditionally mounts modals based on isOpen flags', () => {
    const { rerender } = render(
      <AppModals
        isCommandPaletteOpen={false}
        onCloseCommandPalette={vi.fn()}
        agents={[]}
        workMode="code"
        setWorkMode={vi.fn()}
        setSettingsOpen={vi.fn()}
        setRoutinesOpen={vi.fn()}
        setSelectedAgentId={vi.fn()}
        selectedAgentId={null}
        setSidebarVisible={vi.fn()}
        setRightDockVisible={vi.fn()}
        operatorOpen={false}
        setOperatorOpen={vi.fn()}
        platform="windows"
        isUsageModalOpen={false}
        onCloseUsageModal={vi.fn()}
        isWhatsNewOpen={false}
        onCloseWhatsNew={vi.fn()}
        isArchivedChatsOpen={false}
        onCloseArchivedChats={vi.fn()}
        onRestoredArchivedChat={vi.fn()}
        isSshModalOpen={false}
        onCloseSshModal={vi.fn()}
        onConnectSsh={vi.fn()}
      />
    );

    // Persistent overlays should be present
    expect(screen.getByTestId('prompt-projectile-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('resume-host')).toBeInTheDocument();

    // Modals should not be open
    expect(screen.queryByTestId('command-palette-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usage-dashboard-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('archived-chats-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ssh-workspace-modal')).not.toBeInTheDocument();

    // Rerender with all modals open
    rerender(
      <AppModals
        isCommandPaletteOpen={true}
        onCloseCommandPalette={vi.fn()}
        agents={[]}
        workMode="code"
        setWorkMode={vi.fn()}
        setSettingsOpen={vi.fn()}
        setRoutinesOpen={vi.fn()}
        setSelectedAgentId={vi.fn()}
        selectedAgentId={null}
        setSidebarVisible={vi.fn()}
        setRightDockVisible={vi.fn()}
        operatorOpen={false}
        setOperatorOpen={vi.fn()}
        platform="windows"
        isUsageModalOpen={true}
        onCloseUsageModal={vi.fn()}
        isWhatsNewOpen={true}
        onCloseWhatsNew={vi.fn()}
        isArchivedChatsOpen={true}
        onCloseArchivedChats={vi.fn()}
        onRestoredArchivedChat={vi.fn()}
        isSshModalOpen={true}
        onCloseSshModal={vi.fn()}
        onConnectSsh={vi.fn()}
      />
    );

    expect(screen.getByTestId('command-palette-modal')).toBeInTheDocument();
    expect(screen.getByTestId('usage-dashboard-modal')).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-modal')).toBeInTheDocument();
    expect(screen.getByTestId('archived-chats-modal')).toBeInTheDocument();
    expect(screen.getByTestId('ssh-workspace-modal')).toBeInTheDocument();
  });
});
