import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { PaneNodeRenderer } from './PaneNodeRenderer';
import { createLeaf, createSplit } from './treeUtils';
import type { Workspace } from '../../types';

// Mock TerminalView to avoid initializing xterm canvas in jsdom
vi.mock('../views/TerminalView', () => ({
  TerminalView: ({ title, sessionId }: { title?: string; sessionId?: string }) => (
    <div data-testid={`terminal-${sessionId}`}>{title || 'Terminal'}</div>
  ),
  releaseTerminal: vi.fn(),
}));

describe('PaneNodeRenderer - Fullscreen / Zoom Aspect Ratio Parity', () => {
  const mockWorkspace: Workspace = {
    id: 'ws-1',
    displayName: 'Test Workspace',
    createdAtUnixMs: Date.now(),
    lastOpenedAtUnixMs: Date.now(),
    pinned: false,
    available: true,
  };

  it('renders split tree with grid template when fullscreenLeafId is null', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 'term-1', label: 'Terminal 1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 'term-2', label: 'Terminal 2' });
    const split = createSplit('vertical', [l1, l2], [0.5, 0.5]);

    const { container } = render(
      <PaneNodeRenderer
        node={split}
        fullscreenLeafId={null}
        focusedLeafId={l1.id}
        paneMenuOpenLeafId={null}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        terminalStatus={{}}
        availableEngines={[]}
        selectedWorkspace={mockWorkspace}
        activeTab={null}
        onFocusLeaf={vi.fn()}
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
        onNewSession={vi.fn()}
        onDividerPointerDown={vi.fn()}
        onSetTerminalStatus={vi.fn()}
      />
    );

    // .pane-tree should exist with grid container and divider
    const paneTree = container.querySelector('.pane-tree');
    expect(paneTree).toBeInTheDocument();
    expect(container.querySelector('.pane-divider')).toBeInTheDocument();
    expect(container.querySelectorAll('.code-pane-panel')).toHaveLength(2);
  });

  it('bypasses .pane-tree grid container when fullscreenLeafId is active, rendering ONLY the zoomed pane', () => {
    const l1 = createLeaf({ kind: 'terminal', sessionId: 'term-1', label: 'Terminal 1' });
    const l2 = createLeaf({ kind: 'terminal', sessionId: 'term-2', label: 'Terminal 2' });
    const split = createSplit('vertical', [l1, l2], [0.5, 0.5]);

    const { container } = render(
      <PaneNodeRenderer
        node={split}
        fullscreenLeafId={l1.id}
        focusedLeafId={l1.id}
        paneMenuOpenLeafId={null}
        paneMenuKind={null}
        renamingLeafId={null}
        renameValue=""
        terminalStatus={{}}
        availableEngines={[]}
        selectedWorkspace={mockWorkspace}
        activeTab={null}
        onFocusLeaf={vi.fn()}
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
        onNewSession={vi.fn()}
        onDividerPointerDown={vi.fn()}
        onSetTerminalStatus={vi.fn()}
      />
    );

    // .pane-tree and .pane-divider must NOT exist: the zoomed pane renders directly at root!
    expect(container.querySelector('.pane-tree')).toBeNull();
    expect(container.querySelector('.pane-divider')).toBeNull();

    // Only 1 pane panel is rendered (the zoomed one)
    const panels = container.querySelectorAll('.code-pane-panel');
    expect(panels).toHaveLength(1);
    expect(panels[0].getAttribute('data-leaf-id')).toBe(l1.id);
  });
});
