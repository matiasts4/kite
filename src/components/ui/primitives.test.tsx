import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  InputField,
  Modal,
  SearchField,
  Tabs,
  TextareaField,
  UiKitPreview,
} from './index';

describe('Core UI Primitives', () => {
  it('Button handles click, disabled, and loading states', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="primary" onClick={onClick}>
        Run
      </Button>
    );

    const btn = screen.getByRole('button', { name: 'Run' });
    expect(btn).toHaveClass('kite-btn--primary', 'kite-btn--md');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button variant="danger" size="sm" disabled onClick={onClick}>
        Run
      </Button>
    );
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button loading onClick={onClick}>
        Saving
      </Button>
    );
    const loadingBtn = screen.getByRole('button', { name: 'Saving' });
    expect(loadingBtn).toBeDisabled();
    expect(loadingBtn).toHaveAttribute('aria-busy', 'true');
  });

  it('Field primitives wire labels, hints, aria-invalid, and errors', () => {
    const onClear = vi.fn();
    render(
      <div>
        <InputField
          label="Project Name"
          hint="Use lowercase characters."
          error="Name is required."
          required
        />
        <SearchField
          label="Find File"
          value="main.ts"
          onChange={() => {}}
          onClear={onClear}
        />
        <TextareaField label="Notes" error="Too short." />
      </div>
    );

    const input = screen.getByLabelText(/Project Name/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain('-hint');
    expect(describedBy).toContain('-error');
    expect(screen.getByText('Name is required.')).toHaveAttribute('role', 'alert');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onClear).toHaveBeenCalledTimes(1);

    const textarea = screen.getByLabelText('Notes');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Too short.')).toBeInTheDocument();
  });

  it('Card renders header, body, footer, interactive and selected states', () => {
    render(
      <Card interactive selected data-testid="test-card">
        <CardHeader>Title</CardHeader>
        <CardBody>Body</CardBody>
        <CardFooter>Footer</CardFooter>
      </Card>
    );

    const card = screen.getByTestId('test-card');
    expect(card).toHaveAttribute('data-interactive', 'true');
    expect(card).toHaveAttribute('data-selected', 'true');
    expect(card).toHaveClass('kite-card--interactive', 'kite-card--selected');
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByText('Footer')).toBeInTheDocument();
  });

  it('Modal renders in portal, closes on Escape, backdrop click, and close button', () => {
    const onClose = vi.fn();
    render(
      <Modal
        open
        onClose={onClose}
        title="Confirm Action"
        description="This action cannot be undone."
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <p>Modal body</p>
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Confirm Action')).toBeInTheDocument();
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('Tabs supports click and ArrowRight/ArrowLeft/Home/End keyboard navigation', () => {
    const ControlledTabs = () => {
      const [val, setVal] = useState('one');
      return (
        <Tabs
          ariaLabel="Sample tabs"
          value={val}
          onChange={setVal}
          items={[
            { id: 'one', label: 'One', content: <div>Panel One</div> },
            { id: 'two', label: 'Two', disabled: true, content: <div>Panel Two</div> },
            { id: 'three', label: 'Three', content: <div>Panel Three</div> },
          ]}
        />
      );
    };

    render(<ControlledTabs />);

    const tabOne = screen.getByRole('tab', { name: 'One' });
    const tabThree = screen.getByRole('tab', { name: 'Three' });
    expect(tabOne).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel One');

    tabOne.focus();
    fireEvent.keyDown(tabOne, { key: 'ArrowRight' });
    expect(tabThree).toHaveAttribute('aria-selected', 'true');
    expect(tabThree).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel Three');

    fireEvent.keyDown(tabThree, { key: 'Home' });
    expect(tabOne).toHaveAttribute('aria-selected', 'true');
    expect(tabOne).toHaveFocus();
  });

  it('Badge renders tones, shapes, and dot indicator', () => {
    const { container } = render(
      <div>
        <Badge tone="success" shape="pill" dot>
          Passing
        </Badge>
        <Badge tone="danger">Failed</Badge>
      </div>
    );

    expect(screen.getByText('Passing')).toHaveClass('kite-badge--success', 'kite-badge--pill');
    expect(container.querySelector('.kite-badge__dot')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toHaveClass('kite-badge--danger', 'kite-badge--chip');
  });

  it('EmptyState renders neutral and error tones with action', () => {
    const onRetry = vi.fn();
    render(
      <div>
        <EmptyState title="Nothing here" description="Try creating a task." />
        <EmptyState
          tone="error"
          title="Load error"
          description="Daemon unreachable."
          action={<Button onClick={onRetry}>Retry</Button>}
        />
      </div>
    );

    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Load error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('UiKitPreview renders interactive tabs and modal', () => {
    render(<UiKitPreview />);

    expect(screen.getByTestId('ui-kit-root')).toBeInTheDocument();
    const tabsRoot = screen.getByTestId('ui-kit-tabs');
    expect(tabsRoot).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Controls' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent(/26 px, 32 px, and 38 px/);

    fireEvent.click(screen.getByTestId('ui-kit-open-modal'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Configure Runtime Gate');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
