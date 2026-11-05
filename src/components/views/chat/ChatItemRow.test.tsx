import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatItemRow, ChatWorkGroup } from './ChatItemRow';
import type { ChatItem } from '../../../types';

function mockItem(partial: Partial<ChatItem> & { id: string; kind: ChatItem['kind']; text: string }): ChatItem {
  return {
    title: null,
    detail: null,
    status: null,
    streaming: false,
    exitCode: null,
    createdAtUnixMs: Date.now(),
    attachments: [],
    ...partial,
  };
}

describe('ChatItemRow Actions and Protocol Filtering', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders user message with Copy and Edit buttons', () => {
    const onEdit = vi.fn();
    const item = mockItem({
      id: 'u1',
      kind: 'user',
      text: 'Explica cómo funciona la arquitectura de agentes',
    });

    render(<ChatItemRow item={item} onEditUserMessage={onEdit} />);

    expect(screen.getByText('Explica cómo funciona la arquitectura de agentes')).toBeInTheDocument();
    const copyBtn = screen.getByTitle('Copiar mensaje');
    expect(copyBtn).toBeInTheDocument();
    const editBtn = screen.getByTitle('Volver al mensaje y reescribirlo');
    expect(editBtn).toBeInTheDocument();

    fireEvent.click(editBtn);
    expect(onEdit).toHaveBeenCalledWith('Explica cómo funciona la arquitectura de agentes');

    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Explica cómo funciona la arquitectura de agentes');
  });

  it('cleans leaked protocol JSON from assistant messages', () => {
    const rawAssistantText = [
      'Aquí está la respuesta a tu consulta:',
      '{"type":"step-finish","reason":"tool-calls","tokens":{"input":120,"output":40}}',
      'Y la conclusión del análisis.',
    ].join('\n');

    const item = mockItem({
      id: 'a1',
      kind: 'assistant',
      text: rawAssistantText,
    });

    render(<ChatItemRow item={item} />);

    expect(screen.getByText(/Aquí está la respuesta a tu consulta:/)).toBeInTheDocument();
    expect(screen.getByText(/Y la conclusión del análisis./)).toBeInTheDocument();
    expect(screen.queryByText(/step-finish/)).not.toBeInTheDocument();

    const copyBtn = screen.getByTitle('Copiar respuesta');
    expect(copyBtn).toBeInTheDocument();
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Aquí está la respuesta a tu consulta:\nY la conclusión del análisis.'
    );
  });

  it('offers to cite a selected passage from one assistant response', () => {
    render(
      <ChatItemRow
        item={mockItem({
          id: 'a2',
          kind: 'assistant',
          text: 'Ship the timer before the summary.',
        })}
      />,
    );
    const passage = screen.getByText('Ship the timer before the summary.');
    const range = document.createRange();
    range.selectNodeContents(passage);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(passage);
    fireEvent.click(screen.getByRole('button', { name: 'Citar en el compositor' }));
    expect(selection?.toString()).toBe('');
  });

  it('shows the latest thought while streaming and Thought when it finishes', () => {
    const streaming = mockItem({
      id: 'r1',
      kind: 'reasoning',
      text: 'Checking the failing test.',
      streaming: true,
      durationSeconds: 4,
    });
    const { rerender } = render(<ChatItemRow item={streaming} />);
    expect(screen.getByRole('button', { name: /Checking the failing test/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Thinking/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Thought for/)).not.toBeInTheDocument();

    rerender(
      <ChatItemRow
        item={mockItem({
          id: 'r1',
          kind: 'reasoning',
          text: 'Checking the failing test.',
          streaming: false,
          durationSeconds: 4,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /^Thought/ })).toBeInTheDocument();
    expect(screen.queryByText(/Thought for/)).not.toBeInTheDocument();
  });

  it('uses Thinking only when a streaming thought has no line yet', () => {
    render(
      <ChatItemRow
        item={mockItem({ id: 'r2', kind: 'reasoning', text: '', streaming: true })}
      />,
    );
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  it('reads the command status and collapses a finished burst', () => {
    render(
      <ChatWorkGroup
        items={[
          mockItem({
            id: 'c1',
            kind: 'command',
            text: '',
            command: 'git status',
            title: 'git status',
            status: 'completed',
            durationSeconds: 1.2,
          }),
          mockItem({
            id: 'c2',
            kind: 'command',
            text: '',
            command: 'cargo test',
            title: 'cargo test',
            status: 'completed',
            durationSeconds: 2,
          }),
        ]}
      />,
    );
    expect(screen.getByText('Ran 2 commands')).toBeInTheDocument();
    expect(screen.getByText('Worked for 3.2s')).toBeInTheDocument();
    expect(screen.queryByText('Ran git')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ran 2 commands/ }));
    expect(screen.getByText('Ran git')).toBeInTheDocument();
    expect(screen.getByText('Ran cargo')).toBeInTheDocument();
  });
});
