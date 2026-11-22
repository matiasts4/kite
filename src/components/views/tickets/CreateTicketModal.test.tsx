import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateTicketModal } from './CreateTicketModal';

describe('CreateTicketModal - Form & Behavioral Tests', () => {
  it('disables "Create task" button until title is entered', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onClose = vi.fn();

    render(<CreateTicketModal onClose={onClose} onCreate={onCreate} />);

    const submitBtn = screen.getByRole('button', { name: /create task/i });
    expect(submitBtn).toBeDisabled();

    const titleInput = screen.getByPlaceholderText('Task title');
    await user.type(titleInput, 'Fix PTY resize');

    expect(submitBtn).not.toBeDisabled();
  });

  it('submits filled ticket payload with status and priority selections', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onClose = vi.fn();

    render(<CreateTicketModal onClose={onClose} onCreate={onCreate} />);

    // Type title and description
    await user.type(screen.getByPlaceholderText('Task title'), 'Implement dark mode toggle');
    await user.type(screen.getByPlaceholderText('Add a description…'), 'Ensure CSS tokens update cleanly');

    // Change status to In Progress
    const statusCombobox = screen.getByRole('combobox', { name: /status/i });
    await user.click(statusCombobox);
    const inProgressOption = screen.getByRole('option', { name: /in progress/i });
    await user.click(inProgressOption);

    // Change priority to High
    const priorityCombobox = screen.getByRole('combobox', { name: /priority/i });
    await user.click(priorityCombobox);
    const highOption = screen.getByRole('option', { name: /high/i });
    await user.click(highOption);

    // Type assignee
    await user.type(screen.getByPlaceholderText('Assignee'), 'alice');

    // Submit form
    const submitBtn = screen.getByRole('button', { name: /create task/i });
    await user.click(submitBtn);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Implement dark mode toggle',
        description: 'Ensure CSS tokens update cleanly',
        state: 'In Progress',
        priority: 'High',
        assignee: 'alice',
      })
    );
  });

  it('calls onClose when Cancel button is clicked or Escape is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    const { unmount } = render(<CreateTicketModal onClose={onClose} onCreate={vi.fn()} />);

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    await user.click(cancelBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();

    // Test Escape key
    render(<CreateTicketModal onClose={onClose} onCreate={vi.fn()} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders inside a <dialog> Sheet, supports multi-select labels, project selection, and optional ODD link', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();

    render(<CreateTicketModal onClose={vi.fn()} onCreate={onCreate} />);

    const dialog = document.querySelector('dialog[open]');
    expect(dialog).toBeTruthy();

    await user.type(screen.getByPlaceholderText('Task title'), 'Verify Voice Mode handoff');
    await user.type(
      screen.getByPlaceholderText(/ODD path/i),
      'odd/tasks/qa-task-handoff-and-tickets-ux.md'
    );

    // Multi-select Labels (menu remains open across selections)
    await user.click(screen.getByRole('combobox', { name: /labels/i }));
    await user.click(screen.getByRole('option', { name: 'Frontend' }));
    expect(screen.getByRole('option', { name: 'Backend' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Backend' }));

    // Select Project
    await user.click(screen.getByRole('combobox', { name: /project/i }));
    await user.click(screen.getByRole('option', { name: 'Kite Code' }));

    await user.click(screen.getByRole('button', { name: /create task/i }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Verify Voice Mode handoff',
        oddPath: 'odd/tasks/qa-task-handoff-and-tickets-ux.md',
        labels: ['Frontend', 'Backend'],
        project: 'proj-kite',
      })
    );
  });
});
