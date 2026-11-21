import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows, liveActivityRowIndex } from './ChatItemRow';
import { SubagentGroupRow } from './SubagentActivityCard';
import type { ChatItem } from '../../../types';
import { OPEN_RIGHT_DOCK_FILE_EVENT, type FilePreviewRequest } from '../../../lib/filePreviewNav';
import { encodeCitation } from './citationChip';

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

    const message = screen.getByText('Explica cómo funciona la arquitectura de agentes');
    expect(message).toBeInTheDocument();
    expect(message.closest('article')).toHaveClass('chat-user-row--bubble');
    const copyBtn = screen.getByTitle('Copy message');
    expect(copyBtn).toBeInTheDocument();
    const editBtn = screen.getByTitle('Edit from here');
    expect(editBtn).toBeInTheDocument();

    fireEvent.click(editBtn);
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit from here' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rewind and keep file changes' }));
    expect(onEdit).toHaveBeenCalledWith('Explica cómo funciona la arquitectura de agentes');
    expect(screen.getByRole('button', { name: 'Restore files too' })).toBeDisabled();

    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Explica cómo funciona la arquitectura de agentes');
  });

  it('styles user conversation bubbles with translucent 3D depth, directional bevels, and semantic radius without backdrop blur', async () => {
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const chatCoreCss = fs.readFileSync('src/components/views/chat/styles/chat-core.css', 'utf8');
    const visualLangCss = fs.readFileSync('src/visual-language.css', 'utf8');

    const bubbleMatch = chatCoreCss.match(
      /\.chat-user-row\.chat-user-row--bubble:not\(\.subagent-brief-card\)\s*\{[^}]*\}/,
    );
    expect(bubbleMatch).not.toBeNull();
    const bubbleBlock = bubbleMatch?.[0] ?? '';
    expect(bubbleBlock).toContain('var(--dialog-radius');
    expect(bubbleBlock).toContain('linear-gradient(');
    expect(bubbleBlock).toContain('var(--chat-user-bubble-base');
    expect(bubbleBlock).toContain('inset 0 1px 0');
    expect(bubbleBlock).toContain('backdrop-filter: none;');

    expect(visualLangCss).toContain('--chat-user-bubble-base:');
    expect(visualLangCss).toContain('--chat-user-bubble-bg:');
    expect(visualLangCss).toContain('--chat-user-bubble-shadow:');
    expect(visualLangCss).toMatch(
      /html\[data-surface-glass='true'\]\s+body\.kite-app\s+\.chat-user-row\.chat-user-row--bubble:not\(\.subagent-brief-card\)\s*\{[^}]*var\(--chat-user-bubble-bg\)[^}]*\}/,
    );
    expect(visualLangCss).not.toMatch(
      /html\[data-surface-glass='true'\]\s+body\.kite-app\s+\.chat-user-row,\s*\r?\n\s*html\[data-surface-glass='true'\]\s+body\.kite-app\s+\.chat-user-row--bubble,/,
    );
  });

  it('anchors user message actions below the bubble without text overlap and styles Edit-from-here rewind dialog cleanly', async () => {
    const onEdit = vi.fn();
    render(
      <ChatItemRow
        item={mockItem({ id: 'u-actions', kind: 'user', text: 'Check action placement' })}
        onEditUserMessage={onEdit}
      />,
    );

    const editBtn = screen.getByTitle('Edit from here');
    const actionsBar = editBtn.closest('.chat-turn__actions') as HTMLElement | null;
    expect(actionsBar).not.toBeNull();
    expect(editBtn).toHaveAttribute('aria-expanded', 'false');
    expect(actionsBar).not.toHaveAttribute('data-open');

    fireEvent.click(editBtn);
    expect(editBtn).toHaveAttribute('aria-expanded', 'true');
    expect(actionsBar).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('dialog', { name: 'Edit from here' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Edit from here' })).not.toBeInTheDocument();
    expect(editBtn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(editBtn);
    expect(screen.getByRole('dialog', { name: 'Edit from here' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Edit from here' })).not.toBeInTheDocument();

    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const chatCoreCss = fs.readFileSync('src/components/views/chat/styles/chat-core.css', 'utf8');
    const mdActionsCss = fs.readFileSync('src/components/views/chat/styles/chat-markdown-actions.css', 'utf8');

    const bubbleBlock =
      chatCoreCss.match(/\.chat-user-row\.chat-user-row--bubble:not\(\.subagent-brief-card\)\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bubbleBlock).toContain('overflow: visible;');

    expect(mdActionsCss).toMatch(/\.chat-turn--user\s*>\s*\.chat-turn__actions\s*\{[^}]*top:\s*calc\(100%\s*\+/);
    const actionsBlock = mdActionsCss.match(/\.chat-turn__actions\s*\{[^}]*\}/)?.[0] ?? '';
    expect(actionsBlock).toContain('var(--menu-plate');
    expect(actionsBlock).toContain('backdrop-filter: var(--glass-overlay-blur');

    const rewindBlock = mdActionsCss.match(/\.chat-rewind\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rewindBlock).toContain('position: absolute;');
    expect(rewindBlock).toContain('flex-direction: column;');
    expect(rewindBlock).toContain('var(--menu-plate');
  });

  it('cleans leaked protocol JSON from assistant messages', () => {
    const rawAssistantText = [
      'Here is the answer to your question:',
      '{"type":"step-finish","reason":"tool-calls","tokens":{"input":120,"output":40}}',
      'And the analysis conclusion.',
    ].join('\n');

    const item = mockItem({
      id: 'a1',
      kind: 'assistant',
      text: rawAssistantText,
    });

    render(<ChatItemRow item={item} />);

    expect(screen.getByText(/Here is the answer to your question:/)).toBeInTheDocument();
    expect(screen.getByText(/And the analysis conclusion./)).toBeInTheDocument();
    expect(screen.queryByText(/step-finish/)).not.toBeInTheDocument();

    const copyBtn = screen.getByTitle('Copy response');
    expect(copyBtn).toBeInTheDocument();
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Here is the answer to your question:\nAnd the analysis conclusion.'
    );
  });

  it('suppresses multi-sentence dotted waiting prose once follow-up text arrives, while keeping standalone notices', () => {
    const leaked = [
      'The provider has not sent an update. Stop the turn if this stays quiet.',
      '',
      'Lancé el subagente con grok (grok-4.7-build-fast) para revisar package.json. Estoy esperando su respuesta. El subagente revisó package.json y devolvió este resumen.',
    ].join('\n');

    const { container, rerender } = render(
      <ChatItemRow item={mockItem({ id: 'a-wait-1', kind: 'assistant', text: leaked })} />,
    );
    expect(screen.queryByText(/Stop the turn if this stays quiet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estoy esperando su respuesta/i)).not.toBeInTheDocument();
    expect(container.querySelector('.md-body')?.textContent).toContain(
      'El subagente revisó package.json y devolvió este resumen.'
    );

    rerender(
      <ChatItemRow
        item={mockItem({
          id: 'a-wait-2',
          kind: 'assistant',
          text: 'The provider has not sent an update. Stop the turn if this stays quiet.',
        })}
      />,
    );
    expect(
      screen.getByText('The provider has not sent an update. Stop the turn if this stays quiet.'),
    ).toBeInTheDocument();
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
    expect(document.querySelector('[data-message-id="a2"]')).toBeInTheDocument();
    const range = document.createRange();
    range.selectNodeContents(passage);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(passage);
    fireEvent.click(screen.getByRole('button', { name: 'Quote in composer' }));
    expect(selection?.toString()).toBe('');
  });

  it('keeps file restore disabled unless the thread can restore files', () => {
    const item = mockItem({ id: 'u3', kind: 'user', text: 'rewrite this' });
    const { rerender } = render(<ChatItemRow item={item} onEditUserMessage={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Edit from here'));
    expect(screen.getByRole('button', { name: 'Restore files too' })).toBeDisabled();
    rerender(<ChatItemRow item={item} onEditUserMessage={vi.fn()} fileRestoreEnabled />);
    expect(screen.getByRole('button', { name: 'Restore files too' })).toBeEnabled();
  });

  it('does not call restore when file restore is off', () => {
    const onRestore = vi.fn();
    const item = mockItem({ id: 'u4', kind: 'user', text: 'rewrite this' });
    render(
      <ChatItemRow
        item={item}
        onEditUserMessage={vi.fn()}
        fileRestoreEnabled={false}
        onRestoreFiles={onRestore}
      />,
    );
    fireEvent.click(screen.getByTitle('Edit from here'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore files too' }));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('shows a restore refusal and does not claim files changed', async () => {
    const onEdit = vi.fn();
    const onRestore = vi.fn().mockRejectedValue(new Error('The provider cannot rewind this conversation.'));
    const item = mockItem({ id: 'u5', kind: 'user', text: 'rewrite this' });
    render(
      <ChatItemRow item={item} onEditUserMessage={onEdit} fileRestoreEnabled onRestoreFiles={onRestore} />,
    );
    fireEvent.click(screen.getByTitle('Edit from here'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore files too' }));
    expect(await screen.findByText('The provider cannot rewind this conversation.')).toBeInTheDocument();
    expect(screen.queryByText(/files changed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/archivos restaurados/i)).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('renders a sent citation chip and keeps the quote readable when the source is gone', () => {
    const token = encodeCitation({ messageId: '', quote: 'saved passage', comment: '' });
    render(<ChatItemRow item={mockItem({ id: 'u-cite', kind: 'user', text: `See ${token} please` })} />);
    fireEvent.click(screen.getByRole('button', { name: 'saved passage' }));
    expect(screen.getByRole('dialog', { name: 'Saved quote' })).toHaveTextContent('saved passage');
  });

  it('shows the latest thought while streaming and Thought when it finishes', () => {
    const streaming = mockItem({
      id: 'r1',
      kind: 'reasoning',
      text: 'Checking the failing test. The fixture is stale.',
      streaming: true,
      durationSeconds: 4,
    });
    const { rerender } = render(<ChatItemRow item={streaming} />);
    const liveThought = screen.getByRole('button', { name: /Checking the failing test/ });
    expect(liveThought).toBeInTheDocument();
    expect(liveThought.textContent?.match(/Checking the failing test/g)?.length).toBe(1);
    expect(liveThought).toHaveTextContent('The fixture is stale.');
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

  it('renders no brain row until the thought has text', () => {
    const { container, rerender } = render(
      <ChatItemRow
        item={mockItem({ id: 'r2', kind: 'reasoning', text: '', streaming: true })}
      />,
    );
    expect(container.querySelector('.chat-reasoning-row')).toBeNull();
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();

    rerender(
      <ChatItemRow
        item={mockItem({ id: 'r2', kind: 'reasoning', text: 'Checking the fixture.', streaming: true })}
      />,
    );
    expect(container.querySelector('.chat-reasoning-row')).not.toBeNull();
  });

  it('collapses actions into a single live-updating line while running and reveals each step on expand', () => {
    const c1 = mockItem({
      id: 'c1',
      kind: 'command',
      text: '',
      command: 'git status',
      title: 'git status',
      status: 'completed',
      streaming: false,
    });
    const c2 = mockItem({
      id: 'c2',
      kind: 'command',
      text: '',
      command: 'cargo test',
      title: 'cargo test',
      status: 'running',
      streaming: true,
    });
    const rOut = mockItem({
      id: 'r-out',
      kind: 'tool',
      title: 'read file',
      toolName: 'read_file',
      detail: '{"Path":"C:/tmp/logs/output.txt","StartLine":1,"EndLine":250}',
      text: '',
      status: 'running',
      streaming: true,
    });

    const { rerender, container } = render(<ChatWorkGroup running items={[c1, c2]} />);
    const toggle = container.querySelector('.chat-work-group__toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Running cargo');
    expect(screen.queryByTitle('Ran git')).not.toBeInTheDocument();
    expect(screen.queryByText(/\bearlier\b/)).not.toBeInTheDocument();

    rerender(
      <ChatWorkGroup
        running
        items={[
          c1,
          { ...c2, status: 'completed', streaming: false },
          rOut,
        ]}
      />,
    );
    expect(toggle).toHaveTextContent('Reading output.txt');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTitle('Ran git')).toBeInTheDocument();
    expect(screen.getByTitle('Ran cargo')).toBeInTheDocument();
    expect(screen.getByTitle('Read tmp/logs/output.txt')).toBeInTheDocument();
    expect(screen.getByText('#L1-250')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Working');
  });

  it('keeps the collapsed label non-empty across live placeholder/reasoning steps and uses visible CSS colors', async () => {
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const chatWorkCss = fs.readFileSync('src/components/views/chat/styles/chat-work.css', 'utf8');
    const visualLangCss = fs.readFileSync('src/visual-language.css', 'utf8');
    expect(visualLangCss).toContain('--text-tertiary:');
    const shineMatch = chatWorkCss.match(/\.chat-activity-shine\s*\{[\s\S]*?\}/);
    expect(shineMatch?.[0]).toContain('color: var(--text-secondary');
    expect(shineMatch?.[0]).not.toContain('color: transparent');
    expect(chatWorkCss).not.toMatch(/linear-gradient\([\s\S]*?var\(--text-tertiary\)/);

    const { rerender, container } = render(
      <ChatWorkGroup
        running
        items={[
          mockItem({ id: 'p1', kind: 'tool', title: '', text: '', status: 'running', streaming: true }),
        ]}
      />,
    );
    const label = container.querySelector('.chat-work-group__label');
    expect(label?.textContent).toBe('Working');

    rerender(
      <ChatWorkGroup
        running
        items={[
          mockItem({ id: 'p1', kind: 'tool', title: '', text: '', status: 'completed' }),
          mockItem({
            id: 'r-stream',
            kind: 'reasoning',
            text: '**Inspecting styles**\nLooking for transparent color rules.',
            streaming: true,
          }),
        ]}
      />,
    );
    expect(label?.textContent).toBe('Inspecting styles');
  });

  it('reads a file as one line when expanded', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Read 1 file/i }));
    expect(screen.getByTitle('Read src/main.ts')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /Read 1 file/i }));
    expect(screen.getByTitle('Read src/notifications/foo.ts')).toBeInTheDocument();
    expect(screen.getByText('#L1')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Changed 1 file/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /Read 1 file/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /Ran 1 command/i }));
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
    expect(screen.getByTitle('Ran git')).toBeInTheDocument();
    expect(screen.getByTitle('Ran cargo')).toBeInTheDocument();
  });

  it('exempts subagent and swarm items from ChatWorkGroup post-turn burst folding', () => {
    const rows = groupTranscriptRows([
      mockItem({ id: 't1', kind: 'tool', toolKind: 'read', title: 'Read a.ts', text: '', status: 'completed' }),
      mockItem({ id: 't2', kind: 'tool', toolKind: 'read', title: 'Read b.ts', text: '', status: 'completed' }),
      mockItem({
        id: 'sub-1',
        kind: 'tool',
        toolKind: 'subagent',
        title: 'Researcher',
        text: '',
        status: 'completed',
        subagentMeta: {
          subagentId: 'sub_1',
          action: 'spawn',
          role: 'Codebase Researcher',
          model: 'gemini-2.5-flash',
          workspaceMode: 'inherit',
          status: 'completed',
          stepCount: 4,
        },
      }),
      mockItem({
        id: 'sw-1',
        kind: 'tool',
        toolKind: 'swarm',
        title: 'Swarm',
        text: '',
        status: 'completed',
        swarmMeta: {
          swarmId: 'swarm_1',
          action: 'post_message',
          channel: 'main',
          memberName: 'coordinator',
          postText: '@worker inspect crates',
          seq: 1,
        },
      }),
      mockItem({ id: 't3', kind: 'tool', toolKind: 'edit', title: 'Edit c.ts', text: '', status: 'completed' }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(['work', 'item', 'item', 'work']);
    expect(rows[1]?.kind === 'item' ? rows[1].item.id : null).toBe('sub-1');
    expect(rows[2]?.kind === 'item' ? rows[2].item.id : null).toBe('sw-1');
  });

  it('groups two or more consecutive subagent items into an expandable subagentGroup row', () => {
    const rows = groupTranscriptRows([
      mockItem({
        id: 'sub-1',
        kind: 'tool',
        toolKind: 'subagent',
        title: 'Explorer',
        text: '',
        status: 'completed',
        subagentMeta: { subagentId: 'sub_1', action: 'spawn', role: 'Explorer', status: 'completed', stepCount: 0 },
      }),
      mockItem({
        id: 'sub-2',
        kind: 'tool',
        toolKind: 'subagent',
        title: 'Reviewer',
        text: '',
        status: 'running',
        subagentMeta: { subagentId: 'sub_2', action: 'spawn', role: 'Reviewer', status: 'running', stepCount: 0 },
      }),
      mockItem({ id: 'a-1', kind: 'assistant', text: 'Merged findings.' }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(['subagentGroup', 'item']);
    expect(rows[0]?.kind === 'subagentGroup' ? rows[0].items.map((i) => i.id) : []).toEqual([
      'sub-1',
      'sub-2',
    ]);
  });

  it('keeps interleaved reasoning items inside the same work group while keeping standalone reasoning separate', () => {
    const withTools = groupTranscriptRows([
      mockItem({ id: 'u1', kind: 'user', text: 'inspect' }),
      mockItem({ id: 'r1', kind: 'reasoning', text: 'Checking files first.' }),
      mockItem({ id: 't1', kind: 'tool', toolKind: 'read', title: 'Read a.ts', text: '', status: 'completed' }),
      mockItem({ id: 'r2', kind: 'reasoning', text: 'Running tests next.' }),
      mockItem({ id: 'c1', kind: 'command', command: 'npm test', title: 'npm test', text: '', status: 'completed' }),
      mockItem({ id: 'a1', kind: 'assistant', text: 'All good.' }),
    ]);

    expect(withTools.map((r) => r.kind)).toEqual(['item', 'work', 'item']);
    expect(withTools[1]?.kind === 'work' ? withTools[1].items.map((i) => i.id) : []).toEqual([
      'r1',
      't1',
      'r2',
      'c1',
    ]);

    const standalone = groupTranscriptRows([
      mockItem({ id: 'u2', kind: 'user', text: 'explain' }),
      mockItem({ id: 'r3', kind: 'reasoning', text: 'Thinking without tools.' }),
      mockItem({ id: 'a2', kind: 'assistant', text: 'Here is why.' }),
    ]);

    expect(standalone.map((r) => r.kind)).toEqual(['item', 'item', 'item']);
  });

  it('keeps tool executions unified across non-rendered notices, quiet notes, and empty/protocol assistant chunks while splitting on visible text', () => {
    const unified = groupTranscriptRows([
      mockItem({ id: 'u1', kind: 'user', text: 'inspect codebase' }),
      mockItem({ id: 't1', kind: 'tool', toolKind: 'read', title: 'Read a.ts', filePath: 'a.ts', text: '', status: 'completed' }),
      mockItem({ id: 't2', kind: 'tool', toolKind: 'read', title: 'Read b.ts', filePath: 'b.ts', text: '', status: 'completed' }),
      mockItem({ id: 'n1', kind: 'notice' as ChatItem['kind'], text: 'unrecognized frame telemetry' }),
      mockItem({ id: 't3', kind: 'tool', toolKind: 'read', title: 'Read c.ts', filePath: 'c.ts', text: '', status: 'completed' }),
      mockItem({
        id: 'note-quiet',
        kind: 'note',
        text: 'The provider has not sent an update. Stop the turn if this stays quiet.',
        streaming: false,
      }),
      mockItem({ id: 'a-ws', kind: 'assistant', text: '   \n\n  ', streaming: true }),
      mockItem({
        id: 'a-proto',
        kind: 'assistant',
        text: '{"type":"step-finish","reason":"tool-calls","tokens":{"input":10,"output":5}}',
      }),
      mockItem({ id: 'r1', kind: 'reasoning', text: 'Running verification command.' }),
      mockItem({ id: 'c1', kind: 'command', command: 'cargo test', title: 'cargo test', text: '', status: 'running', streaming: true }),
      mockItem({ id: 'n2', kind: 'notice' as ChatItem['kind'], text: 'trailing unrecognized frame' }),
    ]);

    expect(unified.map((r) => r.kind)).toEqual(['item', 'work']);
    expect(unified[1]?.kind === 'work' ? unified[1].items.map((i) => i.id) : []).toEqual([
      't1',
      't2',
      't3',
      'r1',
      'c1',
    ]);
    expect(liveActivityRowIndex(unified)).toBe(1);

    const interrupted = groupTranscriptRows([
      mockItem({ id: 'u2', kind: 'user', text: 'check and fix' }),
      mockItem({ id: 't4', kind: 'tool', toolKind: 'read', title: 'Read x.ts', filePath: 'x.ts', text: '', status: 'completed' }),
      mockItem({ id: 'a-real', kind: 'assistant', text: 'Found the issue in x.ts. Updating y.ts now.' }),
      mockItem({ id: 't5', kind: 'tool', toolKind: 'edit', title: 'Edit y.ts', filePath: 'y.ts', text: '', status: 'completed' }),
    ]);

    expect(interrupted.map((r) => r.kind)).toEqual(['item', 'work', 'item', 'work']);
  });
});

describe('ChatItemRow Diff Rendering', () => {
  it('expands a tool diff item with UnifiedDiffView single gutter and syntax highlighting', async () => {
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,3 @@',
      ' export function run() {',
      '-  return false;',
      '+  return true;',
      ' }',
    ].join('\n');

    const { container } = render(
      <ChatWorkGroup
        items={[
          mockItem({
            id: 'edit-1',
            kind: 'tool',
            toolKind: 'edit',
            title: 'Edit src/app.ts',
            detail: 'src/app.ts',
            text: patch,
            status: 'completed',
          }),
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Changed 1 file/i }));
    fireEvent.click(screen.getByRole('button', { name: /app\.ts/i }));

    await waitFor(() => {
      const shadowRoot = container.querySelector('diffs-container')?.shadowRoot;
      expect(shadowRoot).toBeTruthy();
      expect(shadowRoot?.querySelector('[data-diff-type="single"]')).toBeTruthy();
      expect(shadowRoot?.querySelectorAll('[data-gutter]').length).toBe(1);
      const code = shadowRoot?.querySelector('[data-code]');
      expect(code?.textContent).toContain('return true;');
    });
  });

  it('hides internal [kite from=...] dispatch envelopes and coordinator wakeups while keeping human user messages', () => {
    const internalEnvelope = [
      '[kite from="thread:b7451eb8-6aa9-46df-84f7-d05bee3eace8"]',
      'This is another agent, not the person.',
      'To reply: kite dispatch send thread:b7451eb8-6aa9-46df-84f7-d05bee3eace8 "<reply>"',
      'Irreversible and privileged actions still wait for the person.',
      'BODY:',
      'state: done',
      'CHILD REPORT:',
      'Subagent summary',
    ].join('\n');
    const coordinatorWakeup = '[Swarm Coordinator Wakeup — Swarm #main]\n@worker finished.';

    const envelopeRender = render(
      <ChatItemRow
        item={mockItem({ id: 'u-env', kind: 'user', text: internalEnvelope })}
      />,
    );
    expect(envelopeRender.container.innerHTML).toBe('');

    const taggedRender = render(
      <ChatItemRow
        item={mockItem({
          id: 'u-tagged',
          kind: 'user',
          text: 'internal tagged prompt',
          internalDispatch: true,
        })}
      />,
    );
    expect(taggedRender.container.innerHTML).toBe('');

    const rows = groupTranscriptRows([
      mockItem({ id: 'u-human', kind: 'user', text: 'Run two subagents' }),
      mockItem({ id: 'a1', kind: 'assistant', text: 'Here is the summary table.' }),
      mockItem({ id: 'u-env', kind: 'user', text: internalEnvelope }),
      mockItem({ id: 'u-swarm', kind: 'user', text: coordinatorWakeup }),
      mockItem({ id: 'a2', kind: 'assistant', text: 'Received report.' }),
    ]);

    expect(
      rows.map((row) => (row.kind === 'item' ? row.item.id : row.kind)),
    ).toEqual(['u-human', 'a1', 'a2']);
  });

  it('renders SubagentRoleIcon and 4-dot orbital spinner on running SubagentActivityCard and SubagentGroupRow', () => {
    const runningItem = mockItem({
      id: 'sub-live-1',
      kind: 'tool',
      toolKind: 'subagent',
      title: 'Subagent · Codebase Scout',
      text: '',
      status: 'running',
      streaming: true,
      subagentMeta: {
        subagentId: 'sub_live_1',
        action: 'spawn',
        role: 'Codebase Scout',
        typeName: 'research',
        status: 'running',
        stepCount: 1,
      },
    });
    const secondItem = mockItem({
      id: 'sub-live-2',
      kind: 'tool',
      toolKind: 'subagent',
      title: 'Subagent · Auditor',
      text: '',
      status: 'completed',
      subagentMeta: {
        subagentId: 'sub_live_2',
        action: 'spawn',
        role: 'Security Auditor',
        typeName: 'review',
        status: 'completed',
        stepCount: 2,
      },
    });

    const single = render(<ChatItemRow item={runningItem} />);
    expect(single.getByTestId('subagent-role-icon')).toHaveAttribute('data-role-kind', 'explore');
    expect(single.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'running');

    const group = render(<SubagentGroupRow items={[runningItem, secondItem]} />);
    expect(
      group.container.querySelectorAll('[data-testid="agent-status-indicator"][data-status="running"]').length
    ).toBeGreaterThanOrEqual(2);
    const icons = group.getAllByTestId('subagent-role-icon');
    expect(icons.some((el) => el.getAttribute('data-role-kind') === 'review')).toBe(true);
  });

  it('strips leaked SYSTEM_MESSAGE envelopes and unwraps all proposed_plan tags while preserving inline mentions', async () => {
    const legacyLeaked = [
      'Revisando módulos.',
      '',
      'user',
      'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.',
      '',
      '<SYSTEM_MESSAGE>',
      '[Message] timestamp=2026-11-18T01:00:00Z sender=sub1 content=done',
      '</SYSTEM_MESSAGE>Confirmado, ya terminó.',
      '',
      '<proposed_plan>Plan A</proposed_plan>',
      '',
      '<proposed_plan>Plan B</proposed_plan>',
      '',
      'user',
      '<SYSTEM_MESSAGE>',
      '[Message] unclosed trailing envelope',
    ].join('\n');

    const { container } = render(
      <ChatItemRow item={mockItem({ id: 'a-sys-1', kind: 'assistant', text: legacyLeaked })} />,
    );
    const body = container.querySelector('.md-body')?.textContent ?? '';
    expect(body).toContain('Revisando módulos.');
    expect(body).toContain('Confirmado, ya terminó.');
    expect(body).toContain('Plan A');
    expect(body).toContain('Plan B');
    expect(body).not.toContain('not actually sent by the user');
    expect(body).not.toContain('<SYSTEM_MESSAGE>');
    expect(body).not.toContain('</SYSTEM_MESSAGE>');
    expect(body).not.toContain('[Message]');
    expect(body).not.toContain('<proposed_plan>');
    expect(body).not.toContain('</proposed_plan>');

    const paragraphs = Array.from(container.querySelectorAll('.md-body p')).map((p) => p.textContent);
    expect(paragraphs).toContain('Revisando módulos.');
    expect(paragraphs).toContain('Confirmado, ya terminó.');

    const mentionText = 'Explaining `<SYSTEM_MESSAGE>` and <SYSTEM_MESSAGE> prose stays intact.';
    const mentionRender = render(
      <ChatItemRow item={mockItem({ id: 'a-mention', kind: 'assistant', text: mentionText })} />,
    );
    expect(mentionRender.container.querySelector('.md-body')?.textContent).toContain('<SYSTEM_MESSAGE>');

    // Protocol-only assistant items must not split work groups or render an empty wrapper.
    const protocolOnly = mockItem({
      id: 'a-proto-only',
      kind: 'assistant',
      text: 'user\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] pending',
    });
    const protoRender = render(<ChatItemRow item={protocolOnly} />);
    expect(protoRender.container.innerHTML).toBe('');

    const grouped = groupTranscriptRows([
      mockItem({ id: 't-pre', kind: 'tool', toolKind: 'read', title: 'Read a.ts', text: '', status: 'completed' }),
      protocolOnly,
      mockItem({ id: 't-post', kind: 'tool', toolKind: 'read', title: 'Read b.ts', text: '', status: 'completed' }),
    ]);
    expect(grouped.map((r) => r.kind)).toEqual(['work']);

    // CSS wrapping parity on long inline code / paths without arbitrary radii or heights.
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const mdCss = fs.readFileSync('src/components/views/chat/styles/chat-markdown-actions.css', 'utf8');
    expect(mdCss).toContain('min-width: 0');
    expect(mdCss).toContain('box-decoration-break: clone');
  });

  it('renders GFM markdown tables with safe cell breaks, word-preserving column sizing, and wide transcript expansion', async () => {
    const tableMarkdown = [
      '| # | Superficie | Cómo funciona | Cómo se convierte | Propuesta |',
      '| --- | --- | --- | --- | --- |',
      '| S11 | Empaquetado como plugin | Usa `plugins/<name>/` en `~/.gemini/config/plugins/` | • Borrar `SKILL.md` sueltos.<br>• Instalar plugin unificado.<br>• Mantener `<br>` literal dentro de código. | Incluir |',
    ].join('\n');

    const { container } = render(
      <ChatItemRow item={mockItem({ id: 'a-table', kind: 'assistant', text: tableMarkdown })} />,
    );

    const anchor = container.querySelector('.md-body .md-table-anchor');
    const wrap = anchor?.querySelector(':scope > .md-table-wrap');
    const table = wrap?.querySelector(':scope > table');
    expect(anchor).toBeInTheDocument();
    expect(wrap).toBeInTheDocument();
    expect(table).toBeInTheDocument();

    const cells = Array.from(container.querySelectorAll('.md-body td'));
    expect(cells).toHaveLength(5);
    const detailCell = cells[3];
    expect(detailCell.querySelectorAll('br')).toHaveLength(2);
    expect(detailCell.textContent).not.toContain('sueltos.<br>');
    expect(Array.from(detailCell.querySelectorAll('code')).map((c) => c.textContent)).toEqual([
      'SKILL.md',
      '<br>',
    ]);

    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const mdCss = fs.readFileSync('src/components/views/chat/styles/chat-markdown-actions.css', 'utf8');

    expect(mdCss).toMatch(/\.md-body th,\s*\.md-body td\s*\{[^}]*overflow-wrap:\s*break-word;/);
    expect(mdCss).toMatch(/\.md-body th,\s*\.md-body td\s*\{[^}]*word-break:\s*normal;/);
    expect(mdCss).not.toMatch(/\.md-body th,\s*\.md-body td\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    expect(mdCss).toMatch(/\.md-body th\s*\{[^}]*overflow-wrap:\s*normal;/);
    expect(mdCss).toMatch(/\.md-body table \.md-inline-code[\s\S]*overflow-wrap:\s*break-word;/);
    expect(mdCss).toContain('container-name: chat-transcript;');
    expect(mdCss).toMatch(/@container chat-transcript \(width > 760px\)/);
  });

  it('preserves Markdown paragraph DOM nodes and active text selection across Quote-on-mouseUp and streaming/poll re-renders', () => {
    const initialItem = mockItem({
      id: 'a-sel-1',
      kind: 'assistant',
      text: 'First stable paragraph to select.\n\nSecond paragraph still streaming.',
      streaming: false,
    });
    const { container, rerender } = render(
      <ChatItemRow item={initialItem} subagentRuns={[]} />,
    );

    const firstParagraph = Array.from(container.querySelectorAll('.md-body p')).find((el) =>
      el.textContent?.includes('First stable paragraph'),
    )!;
    expect(firstParagraph).toBeTruthy();

    const range = document.createRange();
    range.selectNodeContents(firstParagraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(firstParagraph);

    // Releasing mouse updates local citation state, and polling/streaming re-renders with new item/subagentRuns refs
    expect(screen.getByRole('button', { name: 'Quote in composer' })).toBeInTheDocument();
    expect(container.querySelectorAll('.md-body p')[0]).toBe(firstParagraph);
    expect(window.getSelection()?.toString()).toContain('First stable paragraph');

    rerender(
      <ChatItemRow
        item={mockItem({
          id: 'a-sel-1',
          kind: 'assistant',
          text: 'First stable paragraph to select.\n\nSecond paragraph still streaming with more tokens.',
          streaming: true,
        })}
        subagentRuns={[
          {
            subagentId: 'sub-tick',
            parentThreadId: 't-1',
            parentToolCallId: 'call-tick',
            role: 'Explorer',
            status: 'running',
            stepCount: 2,
            items: [],
            startedAtUnixMs: 1_700_000_000_000,
            updatedAtUnixMs: 1_700_000_001_000,
          },
        ]}
      />,
    );

    expect(container.querySelectorAll('.md-body p')[0]).toBe(firstParagraph);
    expect(window.getSelection()?.toString()).toContain('First stable paragraph');
  });
});

describe('ChatItemRow smooth streaming reveal', () => {
  it('paces newly appended streaming text across animation frames and snaps on completion or reset', () => {
    let nextId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });

    const flushNextFrame = () => {
      const first = frames.entries().next();
      if (first.done) return false;
      const [id, cb] = first.value;
      frames.delete(id);
      act(() => {
        cb(performance.now());
      });
      return true;
    };

    try {
      // 1. Initial mount renders initial text immediately without replaying from 0.
      const base = mockItem({
        id: 'stream-1',
        kind: 'assistant',
        streaming: true,
        text: 'Hello',
      });
      const { container, rerender } = render(<ChatItemRow item={base} />);
      expect(container.textContent).toContain('Hello');
      expect(frames.size).toBe(0);

      // 2. Appending a bursty chunk reveals smoothly over multiple frames instead of jumping at once.
      const fullText = 'Hello from the smooth streaming assistant pipeline across frames';
      rerender(<ChatItemRow item={{ ...base, text: fullText }} />);
      expect(container.querySelector('.md-body')?.textContent).toBe('Hello');
      expect(frames.size).toBeGreaterThan(0);

      expect(flushNextFrame()).toBe(true);
      const afterFirstFrame = container.querySelector('.md-body')?.textContent ?? '';
      expect(afterFirstFrame.length).toBeGreaterThan('Hello'.length);
      expect(afterFirstFrame.length).toBeLessThan(fullText.length);

      // Drain remaining frames to finish revealing the chunk.
      let guard = 0;
      while (flushNextFrame() && guard < 100) {
        guard += 1;
      }
      expect(container.querySelector('.md-body')?.textContent).toBe(fullText);

      // 3. Non-monotonic replacement snaps immediately without waiting for frames.
      const appended = `${fullText} with another chunk incoming soon`;
      rerender(<ChatItemRow item={{ ...base, text: appended }} />);
      expect(container.querySelector('.md-body')?.textContent).toBe(fullText);

      const replaced = 'Replaced answer cleanly';
      rerender(<ChatItemRow item={{ ...base, text: replaced }} />);
      expect(container.querySelector('.md-body')?.textContent).toBe(replaced);

      // 4. Turning streaming=false snaps any buffered suffix to 100% immediately.
      const trailingBurst = `${replaced} and even more buffered tokens waiting to appear`;
      rerender(<ChatItemRow item={{ ...base, text: trailingBurst }} />);
      expect(container.querySelector('.md-body')?.textContent).toBe(replaced);

      rerender(<ChatItemRow item={{ ...base, streaming: false, text: trailingBurst }} />);
      expect(container.querySelector('.md-body')?.textContent).toBe(trailingBurst);

      // 5. Reduced-motion mode bypasses rAF buffering and renders appended text synchronously.
      document.documentElement.dataset.motion = 'reduce';
      const reduceBase = mockItem({
        id: 'stream-reduce',
        kind: 'assistant',
        streaming: true,
        text: 'Start',
      });
      rerender(<ChatItemRow item={reduceBase} />);
      const reduceFull = 'Start plus instant full text when reduced motion is enabled';
      rerender(<ChatItemRow item={{ ...reduceBase, text: reduceFull }} />);
      expect(container.querySelector('.md-body')?.textContent).toBe(reduceFull);
    } finally {
      delete document.documentElement.dataset.motion;
      vi.unstubAllGlobals();
    }
  });

  it('prevents full-width horizontal scrollbars on chat transcripts and bounds child rows', async () => {
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };
    const chatCoreCss = fs.readFileSync('src/components/views/chat/styles/chat-core.css', 'utf8');
    const chatWorkCss = fs.readFileSync('src/components/views/chat/styles/chat-work.css', 'utf8');
    const chatMdCss = fs.readFileSync('src/components/views/chat/styles/chat-markdown-actions.css', 'utf8');
    const chatSubagentsCss = fs.readFileSync('src/components/views/chat/styles/chat-subagents.css', 'utf8');
    const inspectorCss = fs.readFileSync('src/components/views/subagents/inspector.css', 'utf8');

    expect(chatCoreCss).toMatch(/\.chat-thread-layout\{[^}]*min-width:\s*0[^}]*overflow-x:\s*hidden/);
    expect(chatCoreCss).toMatch(/\.chat-thread-layout__body\{[^}]*min-width:\s*0/);
    expect(chatCoreCss).toMatch(/\.chat-transcript\{[^}]*min-width:\s*0[^}]*overflow-x:\s*hidden/);
    expect(chatCoreCss).toMatch(/\.chat-transcript__column\s*\{[\s\S]*?min-width:\s*0;\s*max-width:\s*100%;/);
    expect(chatCoreCss).toMatch(/\.chat-turn\s*\{[\s\S]*?min-width:\s*0;\s*max-width:\s*100%;/);
    expect(chatCoreCss).toMatch(/\.chat-error-row > div\s*\{\s*flex:\s*1;\s*min-width:\s*0;\s*\}/);
    expect(chatCoreCss).toMatch(/\.chat-error-row p\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
    expect(chatCoreCss).toMatch(/\.chat-approval-card__body\s*\{\s*min-width:\s*0;\s*\}/);
    expect(chatCoreCss).toMatch(/\.chat-user-row pre\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-x:\s*auto;/);

    expect(chatMdCss).toMatch(/\.md-body img[\s\S]*?max-width:\s*100%;\s*height:\s*auto;/);
    expect(chatMdCss).toMatch(/\.md-table-wrap\s*\{[\s\S]*?box-sizing:\s*border-box;/);
    expect(chatMdCss).toMatch(/\.md-body :is\(ul, ol, blockquote\) \.md-table-wrap\s*\{[\s\S]*?max-width:\s*100%;/);
    expect(chatMdCss).toMatch(/\.chat-rewind\s*\{[\s\S]*?min-width:\s*min\(224px,\s*100%\);[\s\S]*?max-width:\s*100%;/);

    expect(chatWorkCss).toMatch(/\.chat-collapsible\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);[\s\S]*?min-width:\s*0;/);
    expect(chatWorkCss).toMatch(/\.chat-collapsible__inner\s*\{[\s\S]*?min-width:\s*0;\s*max-width:\s*100%;/);
    expect(chatWorkCss).toMatch(/\.chat-reasoning-row__content\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
    expect(chatWorkCss).toMatch(/\.chat-work-group,\s*\.chat-work-group__items\s*\{\s*min-width:\s*0;\s*max-width:\s*100%;\s*\}/);
    expect(chatWorkCss).toMatch(/\.chat-work-entry\s*\{[\s\S]*?min-width:\s*0;\s*max-width:\s*100%;/);
    expect(chatWorkCss).toMatch(/\.chat-working-caption\s*\{[\s\S]*?max-width:\s*100%;\s*overflow:\s*hidden;/);

    expect(chatSubagentsCss).toMatch(/\.chat-subagent-card\s*\{[\s\S]*?min-width:\s*0;\s*max-width:\s*100%;/);
    expect(chatSubagentsCss).toMatch(/\.chat-subagent-card__pill\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?text-overflow:\s*ellipsis;/);
    expect(inspectorCss).toMatch(/\.subagent-inspector__stream\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-x:\s*hidden;/);
  });
});
