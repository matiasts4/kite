import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RightDock } from './RightDock';
import { OPEN_RIGHT_DOCK_BROWSER_EVENT } from '../lib/terminalLinkNav';

// Mock sub-views to avoid canvas / native / network dependencies in jsdom
vi.mock('./views/BrowserView', () => ({
  BrowserView: () => <div data-testid="mock-browser-view">Browser View</div>,
}));
vi.mock('./views/FilesView', () => ({
  FilesView: () => <div data-testid="mock-files-view">Files View</div>,
}));
vi.mock('./views/diffs/DiffsView', () => ({
  DiffsView: () => <div data-testid="mock-diffs-view">Diffs View</div>,
}));
vi.mock('./views/TicketsView', () => ({
  TicketsView: () => <div data-testid="mock-tickets-view">Tickets View</div>,
}));
vi.mock('./views/PromptsView', () => ({
  PromptsView: () => <div data-testid="mock-prompts-view">Prompts View</div>,
}));
vi.mock('./views/SidePanelAppsView', () => ({
  SidePanelAppsView: () => <div data-testid="mock-apps-view">Apps View</div>,
}));
vi.mock('./views/apps/AgentDashboardView', () => ({
  AgentDashboardView: () => <div data-testid="mock-dashboard-view">Dashboard View</div>,
}));
vi.mock('../lib/terminalRegistry', () => ({
  getActiveAgentTerminals: () => [],
}));

describe('RightDock - Fullscreen & Maximized Behavior Tests', () => {
  it('renders nothing when visible is false', () => {
    const { container } = render(
      <RightDock
        visible={false}
        onClose={vi.fn()}
        workspaceId="ws-1"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('toggles visible from false to true without violating rules of hooks', () => {
    const { rerender } = render(
      <RightDock
        visible={false}
        onClose={vi.fn()}
        workspaceId="ws-1"
      />
    );
    expect(screen.queryByTestId('app-browser-sidebar')).toBeNull();

    rerender(
      <RightDock
        visible={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
      />
    );
    expect(screen.getByTestId('app-browser-sidebar')).toBeInTheDocument();
  });

  it('renders dock aside with resize grip when visible is true and not fullscreen', () => {
    render(
      <RightDock
        visible={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
      />
    );

    const aside = screen.getByTestId('app-browser-sidebar');
    expect(aside).toBeInTheDocument();
    expect(aside.classList.contains('app-browser-sidebar--fullscreen')).toBe(false);

    const grip = screen.getByLabelText('Resize side panel');
    expect(grip).toBeInTheDocument();

    // Spacer should not exist when not fullscreen
    expect(document.querySelector('.app-browser-sidebar__spacer')).toBeNull();
  });

  it('toggles fullscreen mode, renders spacer, and hides resize grip on maximize button click', () => {
    render(
      <div className="workspace-shell">
        <div data-testid="sibling-pane">Main Pane</div>
        <RightDock
          visible={true}
          onClose={vi.fn()}
          workspaceId="ws-1"
        />
      </div>
    );

    const fullscreenBtn = screen.getByTitle('Full screen');
    expect(fullscreenBtn).toBeInTheDocument();

    // Click to enter fullscreen
    fireEvent.click(fullscreenBtn);

    const aside = screen.getByTestId('app-browser-sidebar');
    expect(aside.classList.contains('app-browser-sidebar--fullscreen')).toBe(true);

    // Spacer should now be rendered in the DOM
    const spacer = document.querySelector('.app-browser-sidebar__spacer');
    expect(spacer).not.toBeNull();

    // Resize grip should be hidden while in fullscreen
    expect(screen.queryByLabelText('Resize side panel')).toBeNull();

    // Background sibling should have inert attribute
    const sibling = screen.getByTestId('sibling-pane');
    expect(sibling.hasAttribute('inert')).toBe(true);

    // Button title changes to Exit full screen
    const exitBtn = screen.getByTitle('Exit full screen');
    expect(exitBtn).toBeInTheDocument();

    // Pressing Escape should exit fullscreen
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(aside.classList.contains('app-browser-sidebar--fullscreen')).toBe(false);
    expect(document.querySelector('.app-browser-sidebar__spacer')).toBeNull();
    expect(screen.getByLabelText('Resize side panel')).toBeInTheDocument();
    expect(sibling.hasAttribute('inert')).toBe(false);
  });

  it('opens and renders DiffsView when triggered via Ctrl+Alt+D shortcut', () => {
    render(
      <RightDock
        visible={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
      />
    );

    // Trigger shortcut Ctrl+Alt+D
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, altKey: true });

    expect(screen.getByTestId('mock-diffs-view')).toBeInTheDocument();
  });

  it('opens New tab menu, renders authentic ui-menu rows and handles selection and Escape', () => {
    render(
      <RightDock
        visible={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
      />
    );

    const newTabBtn = screen.getByLabelText('New tab');
    expect(newTabBtn).toBeInTheDocument();

    // Click to open menu
    fireEvent.click(newTabBtn);

    const menu = screen.getByRole('menu', { name: 'New tab' });
    expect(menu).toBeInTheDocument();
    expect(menu.classList.contains('side-panel-add-menu')).toBe(true);
    expect(menu.classList.contains('ui-menu')).toBe(true);

    // Verify rows exist and have proper structure
    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.length).toBeGreaterThanOrEqual(9);

    const browserItem = screen.getByText('Browser').closest('[role="menuitem"]');
    expect(browserItem).not.toBeNull();
    expect(browserItem?.classList.contains('ui-menu__row')).toBe(true);
    expect(browserItem?.querySelector('.ui-menu__icon')).not.toBeNull();
    expect(browserItem?.querySelector('.ui-menu__row-title')).toHaveTextContent('Browser');

    // Arrow navigation
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(browserItem?.getAttribute('data-highlighted')).toBe('true');

    // Press Escape to close menu
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'New tab' })).toBeNull();
  });

  it('opens and switches to Browser tab when OPEN_RIGHT_DOCK_BROWSER_EVENT is fired', () => {
    render(
      <RightDock
        visible={true}
        onClose={vi.fn()}
        workspaceId="ws-1"
      />
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_RIGHT_DOCK_BROWSER_EVENT, {
          detail: { url: 'https://example.com' },
        })
      );
    });

    expect(screen.getByTestId('mock-browser-view')).toBeInTheDocument();
  });
});

