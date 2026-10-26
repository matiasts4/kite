import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatItemRow } from './ChatItemRow';
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
});
