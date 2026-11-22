import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TicketDetailView } from './TicketDetailView';
import { formatMcpToml, type TicketIssue } from './types';
import { OPEN_RIGHT_DOCK_FILE_EVENT, consumePendingFilePreview } from '../../../lib/filePreviewNav';

function makeIssue(overrides: Partial<TicketIssue> = {}): TicketIssue {
  return {
    id: 'KITE-42',
    uuid: 'uuid-42',
    revision: 1,
    title: 'Verify QA handoff workflow',
    description: 'Check odd/tasks/qa-task-handoff-and-tickets-ux.md and .kite/tasks/notes.md for details.',
    state: 'Review',
    priority: 'High',
    assignee: 'alice',
    delegate: null,
    projectId: null,
    labels: ['qa-manual'],
    blocks: [],
    relatedTo: [],
    oddPath: 'odd/tasks/qa-task-handoff-and-tickets-ux.md',
    sourceAgent: 'Antigravity',
    sourceThreadId: 'thread:th-999',
    createdAt: '2026-11-22T12:00:00.000Z',
    updatedAt: '2026-11-22T12:00:00.000Z',
    ...overrides,
  };
}

describe('TicketDetailView selectors & traceability', () => {
  beforeEach(() => {
    localStorage.clear();
    consumePendingFilePreview();
  });

  it('keeps Labels and Project selectors enabled with fallback defaults and saves updates', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(true);

    render(
      <TicketDetailView
        issue={makeIssue({ labels: [] })}
        snapshot={null}
        onBack={vi.fn()}
        onSave={onSave}
        onArchive={vi.fn()}
      />
    );

    const labelsTrigger = screen.getByRole('combobox', { name: 'Labels' });
    const projectTrigger = screen.getByRole('combobox', { name: 'Project' });
    expect(labelsTrigger).not.toBeDisabled();
    expect(projectTrigger).not.toBeDisabled();

    await user.click(labelsTrigger);
    const menu = document.querySelector('[data-select-menu]') as HTMLElement;
    expect(menu).toBeTruthy();
    expect(Number.parseInt(menu.style.zIndex, 10)).toBeGreaterThanOrEqual(10200);

    await user.click(screen.getByRole('option', { name: 'Frontend' }));
    expect(onSave).toHaveBeenCalledWith('save_issue', {
      id: 'KITE-42',
      labels: ['Frontend'],
    });
  });

  it('opens oddPath and inline ODD links in RightDock Files and dispatches thread navigation', async () => {
    const user = userEvent.setup();
    const fileEvents: unknown[] = [];
    const modeEvents: unknown[] = [];
    const threadEvents: unknown[] = [];

    const onFile = (e: Event) => fileEvents.push((e as CustomEvent).detail);
    const onMode = (e: Event) => modeEvents.push((e as CustomEvent).detail);
    const onThread = (e: Event) => threadEvents.push((e as CustomEvent).detail);

    window.addEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, onFile);
    window.addEventListener('kite:navigate-mode', onMode);
    window.addEventListener('kite:select-thread', onThread);

    render(
      <TicketDetailView
        issue={makeIssue()}
        onBack={vi.fn()}
        onSave={vi.fn()}
        onArchive={vi.fn()}
      />
    );

    // Traceability bar oddPath button & Agent badge
    const traceabilityBar = screen.getByLabelText('Traceability');
    const traceabilityBtn = within(traceabilityBar).getByRole('button', {
      name: 'odd/tasks/qa-task-handoff-and-tickets-ux.md',
    });
    expect(within(traceabilityBar).getByText('Antigravity')).toBeInTheDocument();

    await user.click(traceabilityBtn);
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]).toEqual(
      expect.objectContaining({ candidate: 'odd/tasks/qa-task-handoff-and-tickets-ux.md' })
    );

    // Inline .kite/tasks/*.md link inside description
    const descriptionRegion = screen.getByLabelText('Description');
    const inlineKiteBtn = within(descriptionRegion).getByRole('button', {
      name: '.kite/tasks/notes.md',
    });
    await user.click(inlineKiteBtn);
    expect(fileEvents).toHaveLength(2);
    expect(fileEvents[1]).toEqual(
      expect.objectContaining({ candidate: '.kite/tasks/notes.md' })
    );

    // Open thread button strips "thread:" prefix and dispatches both events
    await user.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(modeEvents).toEqual(['chat']);
    expect(threadEvents).toEqual([{ threadId: 'th-999', mode: 'chat' }]);

    window.removeEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, onFile);
    window.removeEventListener('kite:navigate-mode', onMode);
    window.removeEventListener('kite:select-thread', onThread);
  });

  it('displays external sourceThreadId URIs with a copy button instead of Open thread', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(
      <TicketDetailView
        issue={makeIssue({
          oddPath: null,
          sourceAgent: 'OpenCode',
          sourceThreadId: 'conversation://ext-abc-123',
        })}
        onBack={vi.fn()}
        onSave={vi.fn()}
        onArchive={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Open thread' })).toBeNull();
    expect(screen.getByText('conversation://ext-abc-123')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('conversation://ext-abc-123');
  });

  it('displays scheme-less external session IDs (e.g. ses_123) with Copy instead of Open thread', () => {
    render(
      <TicketDetailView
        issue={makeIssue({
          oddPath: null,
          sourceAgent: 'OpenCode',
          sourceThreadId: 'ses_opencode_123',
        })}
        onBack={vi.fn()}
        onSave={vi.fn()}
        onArchive={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Open thread' })).toBeNull();
    expect(screen.getByText('ses_opencode_123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('formats MCP TOML using kite command fallback', () => {
    expect(formatMcpToml('invalid-json')).toContain('command = "kite"');
    expect(formatMcpToml('{"mcpServers":{}}')).toContain('command = "kite"');
  });
});
