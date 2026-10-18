import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodePaneHeader } from './CodePaneHeader';
import type { PaneOccupant } from './types';

describe('CodePaneHeader - Behavioral Tests', () => {
  const terminalOccupant: PaneOccupant = {
    kind: 'terminal',
    sessionId: 'session-1',
    label: 'Terminal 1',
  };

  it('renders pane label and identity', () => {
    render(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={terminalOccupant}
        displayName="Terminal 1"
        workspaceName="Core App"
        canSwap={true}
        isFullscreen={false}
        isMenuOpen={false}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    expect(screen.getAllByText('Terminal 1').length).toBeGreaterThan(0);
  });

  it('triggers onToggleFullscreen when fullscreen button is clicked', async () => {
    const user = userEvent.setup();
    const onToggleFullscreen = vi.fn();

    render(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={terminalOccupant}
        displayName="Terminal 1"
        workspaceName="Core App"
        canSwap={true}
        isFullscreen={false}
        isMenuOpen={false}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={onToggleFullscreen}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    const fullscreenBtn = screen.getByRole('button', { name: /fullscreen terminal 1 pane/i });
    await user.click(fullscreenBtn);

    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('opens new pane menu when plus button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenMenu = vi.fn();

    render(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={terminalOccupant}
        displayName="Terminal 1"
        workspaceName="Core App"
        canSwap={false}
        isFullscreen={false}
        isMenuOpen={false}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={onOpenMenu}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    const plusBtn = screen.getByRole('button', { name: /new pane beside terminal 1/i });
    await user.click(plusBtn);

    expect(onOpenMenu).toHaveBeenCalledWith('new');
  });

  it('triggers onClosePane when close button is clicked', async () => {
    const user = userEvent.setup();
    const onClosePane = vi.fn();

    render(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={terminalOccupant}
        displayName="Terminal 1"
        workspaceName="Core App"
        canSwap={false}
        isFullscreen={false}
        isMenuOpen={false}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={onClosePane}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    const closeBtn = screen.getByRole('button', { name: /close terminal 1 pane/i });
    await user.click(closeBtn);

    expect(onClosePane).toHaveBeenCalledTimes(1);
  });

  it('renders rename form when leaf is actively renaming and commits on submit', async () => {
    const user = userEvent.setup();
    const onCommitRename = vi.fn();

    render(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={terminalOccupant}
        displayName="Terminal 1"
        workspaceName="Core App"
        canSwap={false}
        isFullscreen={false}
        isMenuOpen={false}
        paneMenuKind={null}
        renamingLeafId="leaf-1"
        renameValue="Build Runner"
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={onCommitRename}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    const input = screen.getByDisplayValue('Build Runner');
    expect(input).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onCommitRename).toHaveBeenCalledWith('Build Runner');
  });

  it('does not duplicate agent name when displayName starts with agentName', () => {
    const { container } = render(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={{
          kind: 'terminal',
          sessionId: 'session-orion',
          label: 'Orion (Antigravity)',
          runtime: {
            engine: 'antigravity',
            displayName: 'Orion',
            agentName: 'Orion',
          },
        }}
        displayName="Orion (Antigravity)"
        workspaceName="Workspace"
        canSwap={false}
        isFullscreen={false}
        isMenuOpen={false}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    expect(container.querySelectorAll('.code-pane-identity__name').length).toBe(1);
    expect(container.querySelector('.code-pane-identity__name')?.textContent).toBe('Orion');
    expect(container.querySelector('.code-pane-identity__label')).toBeNull();
    expect(container.textContent).not.toContain('Orion Orion');
    expect(container.textContent).not.toContain('(Antigravity)');
  });

  it('renders custom role label when suffix is not an engine in parentheses', () => {
    const { container } = render(
      <CodePaneHeader
        nodeId="leaf-2"
        occupant={{
          kind: 'terminal',
          sessionId: 'session-orion-2',
          label: 'Orion Reviewer',
          runtime: {
            engine: 'antigravity',
            displayName: 'Orion Reviewer',
            agentName: 'Orion',
          },
        }}
        displayName="Orion Reviewer"
        workspaceName="Workspace"
        canSwap={false}
        isFullscreen={false}
        isMenuOpen={false}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    expect(container.querySelector('.code-pane-identity__name')?.textContent).toBe('Orion');
    expect(container.querySelector('.code-pane-identity__label')?.textContent).toBe('Reviewer');
  });

  it('renders actions menu and new pane menu when isMenuOpen is true', () => {
    const { rerender } = render(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={terminalOccupant}
        displayName="Terminal 1"
        workspaceName="Core App"
        canSwap={true}
        isFullscreen={false}
        isMenuOpen={true}
        paneMenuKind="actions"
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    expect(screen.getByText('Split Right')).toBeInTheDocument();
    expect(screen.getByText('Split Down')).toBeInTheDocument();

    rerender(
      <CodePaneHeader
        nodeId="leaf-1"
        occupant={terminalOccupant}
        displayName="Terminal 1"
        workspaceName="Core App"
        canSwap={true}
        isFullscreen={false}
        isMenuOpen={true}
        paneMenuKind="new"
        renamingLeafId={null}
        renameValue=""
        availableEngines={[]}
        onOpenMenu={vi.fn()}
        onCloseMenu={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onClosePane={vi.fn()}
        onSplit={vi.fn()}
        onSwap={vi.fn()}
        onExtractToTab={vi.fn()}
        onEqualize={vi.fn()}
        onStartRename={vi.fn()}
        onChangeRename={vi.fn()}
        onCommitRename={vi.fn()}
        onCancelRename={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchAgent={vi.fn()}
        onNewTab={vi.fn()}
        onNewSession={vi.fn()}
        onPointerDownHeader={vi.fn()}
        onTerminalCommand={vi.fn()}
      />
    );

    expect(screen.getByText('Terminal')).toBeInTheDocument();
    expect(screen.getByText('New Tab')).toBeInTheDocument();
  });
});
