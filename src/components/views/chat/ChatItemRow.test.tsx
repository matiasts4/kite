import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows, liveActivityRowIndex } from './ChatItemRow';
import type { ChatItem } from '../../../types';
import { OPEN_RIGHT_DOCK_FILE_EVENT, type FilePreviewRequest } from '../../../lib/filePreviewNav';

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
    const writeText = vi.fn().mockResolvedValue(undefined);
    if (navigator.clipboard) {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      return;
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
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

  it('keeps every action visible while the turn is running', () => {
    render(
      <ChatWorkGroup
        running
        items={[
          mockItem({
            id: 'c1',
            kind: 'command',
            text: '',
            command: 'git status',
            title: 'git status',
            status: 'running',
            streaming: true,
          }),
          mockItem({
            id: 'c2',
            kind: 'command',
            text: '',
            command: 'cargo test',
            title: 'cargo test',
            status: 'running',
            streaming: true,
          }),
        ]}
      />,
    );
    expect(screen.getByText('Running git')).toBeInTheDocument();
    expect(screen.getByText('Running cargo')).toBeInTheDocument();
    expect(screen.queryByText(/\bearlier\b/)).not.toBeInTheDocument();
  });

  it('reads a file as one line', () => {
    render(
      <ChatWorkGroup
        items={[
          mockItem({
            id: 'r1',
            kind: 'tool',
            text: '',
            title: 'Read',
            detail: 'src/main.ts',
            status: 'completed',
          }),
        ]}
      />,
    );
    expect(screen.getByText('Read src/main.ts')).toBeInTheDocument();
    expect(screen.queryByText('Tool execution')).not.toBeInTheDocument();
  });

  it('puts the file and a quiet count on a read, and keeps the stat out of the body', () => {
    render(
      <ChatWorkGroup
        items={[
          mockItem({
            id: 'r2',
            kind: 'tool',
            text: '1 lines, 569 bytes',
            title: 'read file',
            toolName: 'read_file',
            detail: '{\n  "Path": "src/notifications/foo.ts",\n  "StartLine": 1\n}',
            status: 'completed',
          }),
        ]}
      />,
    );
    expect(screen.getByText('Read src/notifications/foo.ts')).toBeInTheDocument();
    expect(screen.getByText('1 line · 569 B')).toBeInTheDocument();
    expect(screen.queryByText('1 lines, 569 bytes')).not.toBeInTheDocument();
  });

  it('opens a created markdown in the files sidebar and keeps the document out of the chat', async () => {
    const user = userEvent.setup();
    const opened: FilePreviewRequest[] = [];
    const onOpen = (event: Event) => {
      opened.push((event as CustomEvent<FilePreviewRequest>).detail);
    };
    window.addEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, onOpen);
    const documentText = '# Walkthrough\n\nThe notification bus fans out to the tray.';
    render(
      <ChatWorkGroup
        items={[
          mockItem({
            id: 'md1',
            kind: 'tool',
            text: documentText,
            title: 'write file',
            toolName: 'write_file',
            detail: '{"Path":"C:/Users/PC/.gemini/antigravity-cli/brain/walkthrough.md"}',
            status: 'completed',
          }),
        ]}
      />,
    );

    expect(screen.queryByText(/notification bus/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /walkthrough\.md/i }));

    expect(screen.queryByText(/notification bus/)).not.toBeInTheDocument();
    expect(opened).toEqual([
      expect.objectContaining({
        candidate: 'C:/Users/PC/.gemini/antigravity-cli/brain/walkthrough.md',
        preferRendered: true,
      }),
    ]);
    expect(opened[0]?.line).toBeUndefined();
    window.removeEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, onOpen);
  });

  it('keeps a source read in the chat until ctrl-click', () => {
    const opened: FilePreviewRequest[] = [];
    const onOpen = (event: Event) => {
      opened.push((event as CustomEvent<FilePreviewRequest>).detail);
    };
    window.addEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, onOpen);
    render(
      <ChatWorkGroup
        items={[
          mockItem({
            id: 'r2',
            kind: 'tool',
            text: '1 lines, 569 bytes',
            title: 'read file',
            toolName: 'read_file',
            detail: '{"Path":"src/notifications/foo.ts"}',
            status: 'completed',
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Read src\/notifications\/foo.ts/ }));
    expect(opened).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Read src\/notifications\/foo.ts/ }), { ctrlKey: true });
    expect(opened[0]?.candidate).toBe('src/notifications/foo.ts');
    window.removeEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, onOpen);
  });

  it('opens command output from the row', () => {
    render(
      <ChatWorkGroup
        items={[
          mockItem({
            id: 'c3',
            kind: 'command',
            text: 'Command output:\nTrue',
            command: 'Test-Path .codegraph',
            title: 'Test-Path .codegraph',
            status: 'completed',
          }),
        ]}
      />,
    );
    expect(screen.queryByText(/True/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Ran Test-Path/ }));
    expect(screen.getByText(/True/)).toBeInTheDocument();
  });

  it('points the working caption at the trailing action group', () => {
    const rows = groupTranscriptRows([
      mockItem({ id: 'u', kind: 'user', text: 'go' }),
      mockItem({ id: 't', kind: 'tool', text: '', title: 'Read src/a.ts', status: 'completed' }),
    ]);
    expect(liveActivityRowIndex(rows)).toBe(1);
    expect(liveActivityRowIndex(groupTranscriptRows([mockItem({ id: 'a', kind: 'assistant', text: 'done' })]))).toBe(-1);
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
    expect(screen.queryByText(/completadas/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ran 2 commands/ }));
    expect(screen.getByText('Ran git')).toBeInTheDocument();
    expect(screen.getByText('Ran cargo')).toBeInTheDocument();
  });
});
