import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatComposer } from './ChatComposer';
import { expandCitations, insertCitationAtCaret } from './citationChip';
import { declarationFromCatalog } from './driverDeclaration';
import { invokeCommand, listConnections, type ConnectionSummary } from '../../../lib/ipc';
import {
  decodeMention,
  encodeMention,
  KITE_MENTION_MIME,
  mentionFromTerminalExcerpt,
} from './mentionChip';
import { composerGoalStop, type StashEntry } from './threadInteraction';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    invokeCommand: vi.fn(async () => null),
    listConnections: vi.fn(async () => []),
  };
});

function claudeConnection(connectionId: string, displayName: string): ConnectionSummary {
  return {
    connectionId,
    driverKind: 'claude',
    displayName,
    authMethod: 'cli_session',
    accountIdentity: {},
    credentialRef: 'vault',
    endpoints: [{ endpointId: 'claude -p', ok: true }],
    status: 'connected',
  };
}

describe('ChatComposer - Behavioral Tests', () => {
  beforeEach(() => {
    vi.mocked(invokeCommand).mockResolvedValue(null);
    vi.mocked(listConnections).mockResolvedValue([]);
  });

  const defaultProps = {
    threadId: 'thread-1',
    threadMode: 'fullAccess' as const,
    threadProvider: 'claude' as const,
    threadModel: 'claude-3-5-sonnet',
    declaration: declarationFromCatalog({ provider: 'claude', selectedModel: 'claude-3-5-sonnet' }),
    running: false,
    prompt: '',
    attachments: [],
    totalTokens: 1200,
    activeDropdown: null,
    onChangePrompt: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onPickAttachments: vi.fn(),
    onStageFiles: vi.fn(),
    onStagePaths: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onDropdownToggle: vi.fn(),
    onUpdateConfig: vi.fn(),
  };

  it('disables send button when prompt is empty', () => {
    render(<ChatComposer {...defaultProps} prompt="" />);

    const sendBtn = screen.getByTitle(/Send prompt/i);
    expect(sendBtn).toBeDisabled();
  });

  it('does not render a misleading connect button when using inherited CLI sessions', () => {
    render(<ChatComposer {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
  });

  it('calls onSend when send button is clicked or Enter is pressed', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onChangePrompt = vi.fn();

    render(
      <ChatComposer
        {...defaultProps}
        prompt="Explain quantum annealing"
        onSend={onSend}
        onChangePrompt={onChangePrompt}
      />
    );

    const sendBtn = screen.getByTitle(/Send prompt/i);
    expect(sendBtn).not.toBeDisabled();
    await user.click(sendBtn);

    expect(onSend).toHaveBeenCalledTimes(1);

    // Test Enter key on textarea
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, '{Enter}');

    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('renders Stop button when running is true and triggers onStop', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();

    render(
      <ChatComposer
        {...defaultProps}
        running={true}
        prompt=""
        onStop={onStop}
      />
    );

    const stopBtn = screen.getByTitle(/Interrupt/i);
    expect(stopBtn).toBeInTheDocument();

    await user.click(stopBtn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('opens model select menu and updates model on selection', async () => {
    const user = userEvent.setup();
    const onUpdateConfig = vi.fn();

    render(
      <ChatComposer
        {...defaultProps}
        onUpdateConfig={onUpdateConfig}
      />
    );

    const modelBtn = screen.getByRole('combobox', { name: /model/i });
    expect(modelBtn).toBeInTheDocument();
    await user.click(modelBtn);

    const option = await screen.findByRole('option', { name: /Automatic/i });
    await user.click(option);

    expect(onUpdateConfig).toHaveBeenCalledWith({ model: null });
    expect(screen.queryByText(/Claude Opus 5.5/i)).toBeNull();
  });

  it('navigates user prompt history with ArrowUp and ArrowDown', async () => {
    const user = userEvent.setup();
    const onChangePrompt = vi.fn();
    const threadItems = [
      {
        id: '1',
        kind: 'user' as const,
        text: 'First user prompt',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1000,
        attachments: [],
      },
      {
        id: '2',
        kind: 'assistant' as const,
        text: 'Assistant answer',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 2000,
        attachments: [],
      },
      {
        id: '3',
        kind: 'user' as const,
        text: 'Second user prompt',
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 3000,
        attachments: [],
      },
    ];

    render(
      <ChatComposer
        {...defaultProps}
        prompt=""
        threadItems={threadItems}
        onChangePrompt={onChangePrompt}
      />
    );

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.keyboard('{ArrowUp}');

    expect(onChangePrompt).toHaveBeenCalledWith('Second user prompt');
  });

  it('renders the dictation button and allows clicking it', async () => {
    const user = userEvent.setup();

    render(<ChatComposer {...defaultProps} prompt="" />);

    const dictationBtn = screen.getByRole('button', { name: /dictate message/i });
    expect(dictationBtn).toBeInTheDocument();
    expect(dictationBtn.className).toContain('size-8');
    expect(dictationBtn.className).toContain('rounded-control');
    expect(dictationBtn.className).toContain('chat-dictate-control');
    const micSvg = dictationBtn.querySelector('svg');
    expect(micSvg).toHaveAttribute('width', '14');
    expect(micSvg).toHaveAttribute('height', '14');
    // Optical full-height 24x24 Lucide bounds (y=2..22) so MicIcon matches PaperclipIcon & Voice Mode
    expect(micSvg?.querySelector('rect[y="2"][height="13"]')).not.toBeNull();
    await user.click(dictationBtn);
  });

  it('inserts a cited passage at the caret and keeps the surrounding draft', () => {
    const onChangePrompt = vi.fn();
    render(<ChatComposer {...defaultProps} prompt="Hello world" onChangePrompt={onChangePrompt} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(6, 6);
    window.dispatchEvent(new CustomEvent('kite:cite', { detail: 'the patch' }));
    const next = insertCitationAtCaret('Hello world', 6, 6, 'the patch');
    expect(onChangePrompt).toHaveBeenCalledWith(next.text);
    expect(expandCitations(next.text)).toBe('Hello > the patchworld');
  });

  it('stages pasted image files from clipboardData.files', () => {
    const onStageFiles = vi.fn();
    render(<ChatComposer {...defaultProps} prompt="" onStageFiles={onStageFiles} />);

    const textarea = screen.getByRole('textbox');
    const fakeFile = new File(['fake-png-content'], 'screenshot.png', { type: 'image/png' });

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [fakeFile],
        items: [],
      },
    });

    textarea.dispatchEvent(pasteEvent);
    expect(onStageFiles).toHaveBeenCalledWith([fakeFile]);
  });

  it('stages pasted image files from clipboardData.items when files array is empty', () => {
    const onStageFiles = vi.fn();
    render(<ChatComposer {...defaultProps} prompt="" onStageFiles={onStageFiles} />);

    const textarea = screen.getByRole('textbox');
    const fakeFile = new File(['fake-screenshot'], 'image.png', { type: 'image/png' });

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        files: [],
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => fakeFile,
          },
        ],
      },
    });

    textarea.dispatchEvent(pasteEvent);
    expect(onStageFiles).toHaveBeenCalledWith([fakeFile]);
  });

  it('asks the user to choose when two connections verified the spawn endpoint', async () => {
    const user = userEvent.setup();
    const onSelectConnection = vi.fn();
    vi.mocked(listConnections).mockResolvedValue([
      claudeConnection('conn-a', 'Claude work'),
      claudeConnection('conn-b', 'Claude personal'),
    ]);

    render(
      <ChatComposer
        {...defaultProps}
        prompt=""
        onSelectConnection={onSelectConnection}
      />
    );

    const trigger = await screen.findByRole('combobox', { name: /connection/i });
    expect(trigger).toHaveTextContent('Choose connection');

    await user.click(trigger);
    await user.click(await screen.findByText('Claude personal'));

    expect(onSelectConnection).toHaveBeenCalledWith('conn-b');
  });

  it('binds without asking when a single connection verified the spawn endpoint', async () => {
    vi.mocked(listConnections).mockResolvedValue([claudeConnection('conn-a', 'Claude work')]);

    render(<ChatComposer {...defaultProps} prompt="" onSelectConnection={vi.fn()} />);

    await waitFor(() => expect(listConnections).toHaveBeenCalled());
    expect(screen.queryByRole('combobox', { name: /connection/i })).toBeNull();
  });

  it('does not render a manual refresh row in the model menu', async () => {
    const user = userEvent.setup();
    const onRefreshModels = vi.fn();

    render(
      <ChatComposer
        {...defaultProps}
        prompt=""
        onRefreshModels={onRefreshModels}
        isRefreshingModels={true}
      />
    );

    await user.click(screen.getByRole('combobox', { name: /model/i }));
    expect(await screen.findByRole('option', { name: /Automatic/i })).toBeInTheDocument();
    expect(screen.queryByText(/Claude Opus 5.5/i)).toBeNull();

    expect(screen.queryByText(/refresh available models/i)).toBeNull();
    expect(screen.queryByText(/checking live models/i)).toBeNull();
    expect(screen.queryByText(/syncing/i)).toBeNull();
    expect(onRefreshModels).not.toHaveBeenCalled();
  });

  it('renders model rows from the supplied driver declaration', async () => {
    const user = userEvent.setup();
    const declaration = {
      ...declarationFromCatalog({ provider: 'claude' }),
      models: [{ id: 'declared-model', label: 'Declared Model', detail: 'Supplied by the session' }],
    };

    render(<ChatComposer {...defaultProps} declaration={declaration} prompt="" />);

    await user.click(screen.getByRole('combobox', { name: /model/i }));
    expect(await screen.findByText('Declared Model')).toBeInTheDocument();
    expect(screen.queryByText('Claude Opus 5.5')).toBeNull();
  });

  it('renders permission rows from the supplied driver declaration', async () => {
    const user = userEvent.setup();
    const declaration = {
      ...declarationFromCatalog({ provider: 'claude' }),
      permission: [{ id: 'readOnly', label: 'Read only only', detail: 'No changes' }],
    };

    render(<ChatComposer {...defaultProps} declaration={declaration} prompt="" />);

    await user.click(screen.getByRole('combobox', { name: /permission/i }));
    expect(await screen.findByText('Read only only')).toBeInTheDocument();
    expect(screen.queryByText('Full access')).toBeNull();
  });

  it('disables a control the declaration does not list and shows its reason', () => {
    const reason = 'The connected driver did not declare reasoning effort levels.';
    const declaration = {
      ...declarationFromCatalog({ provider: 'claude' }),
      effort: null,
      unlistedReasons: { effort: reason },
    };

    render(<ChatComposer {...defaultProps} declaration={declaration} prompt="" />);

    const effort = screen.getByRole('combobox', { name: /reasoning effort/i });
    expect(effort).toBeDisabled();
    expect(effort).toHaveAttribute('title', reason);
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it('keeps the previous send behavior with a declaration-driven composer', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();

    render(<ChatComposer {...defaultProps} prompt="Explain this file" onSend={onSend} />);

    await user.click(screen.getByTitle(/Send prompt/i));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('filters the @ menu and inserts a thread id without sending or mutating the list', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const threads = [{ id: 'auth-1', title: 'Auth flow' }];
    const before = threads.map((thread) => ({ ...thread }));

    function Harness() {
      const [prompt, setPrompt] = useState('');
      return (
        <ChatComposer
          {...defaultProps}
          prompt={prompt}
          onChangePrompt={setPrompt}
          onSend={onSend}
          files={['src/main.rs', 'README.md']}
          threads={threads}
          models={['gpt-5']}
        />
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), '@src');

    expect(screen.getByRole('listbox', { name: 'Mentions' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'src/main.rs' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'README.md' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Auth flow' })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), '@Auth');
    await user.click(screen.getByRole('option', { name: 'Auth flow' }));

    expect(onSend).not.toHaveBeenCalled();
    expect(threads).toEqual(before);
    expect(screen.getByText('auth-1')).toBeInTheDocument();
    expect(screen.queryByText('@Auth')).not.toBeInTheDocument();
    expect(screen.queryByText('@auth-1')).not.toBeInTheDocument();
  });

  it('inserts a file or thread chip at the caret when the drag payload is a Kite entry', () => {
    const onChangePrompt = vi.fn();
    render(<ChatComposer {...defaultProps} prompt="Hello world" onChangePrompt={onChangePrompt} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(6, 6);
    fireEvent.select(textarea);

    fireEvent.drop(document.querySelector('[data-slot="composer-main"]') as Element, {
      dataTransfer: {
        types: ['application/x-kite-files-entry'],
        getData: (type: string) =>
          type === 'application/x-kite-files-entry' ? JSON.stringify({ relativePath: 'src/main.rs' }) : '',
      },
    });

    const fileDraft = onChangePrompt.mock.calls[onChangePrompt.mock.calls.length - 1]?.[0] as string;
    expect(fileDraft).not.toContain('@src/main.rs');
    expect(fileDraft.startsWith('Hello ')).toBe(true);
    expect(fileDraft.endsWith('world')).toBe(true);
    expect(decodeMention(fileDraft.slice(6, fileDraft.indexOf('world')))?.id).toBe('src/main.rs');

    onChangePrompt.mockClear();
    textarea.setSelectionRange(6, 6);
    fireEvent.select(textarea);
    fireEvent.drop(document.querySelector('[data-slot="composer-main"]') as Element, {
      dataTransfer: {
        types: ['application/x-kite-thread'],
        getData: (type: string) => (type === 'application/x-kite-thread' ? 'auth-1' : ''),
      },
    });
    const threadDraft = onChangePrompt.mock.calls[onChangePrompt.mock.calls.length - 1]?.[0] as string;
    expect(threadDraft).not.toContain('@auth-1');
    expect(decodeMention(threadDraft.slice(6, threadDraft.indexOf('world')))?.kind).toBe('thread');
  });

  it('inserts a terminal excerpt chip from kite:terminal-excerpt', () => {
    const onChangePrompt = vi.fn();
    render(<ChatComposer {...defaultProps} prompt="Hello world" onChangePrompt={onChangePrompt} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(6, 6);
    fireEvent.select(textarea);
    window.dispatchEvent(
      new CustomEvent('kite:terminal-excerpt', {
        detail: { terminalId: '1', startLine: 12, endLine: 28 },
      }),
    );
    const next = onChangePrompt.mock.calls[onChangePrompt.mock.calls.length - 1]?.[0] as string;
    const mention = mentionFromTerminalExcerpt({ terminalId: '1', startLine: 12, endLine: 28 });
    expect(next).not.toContain('@');
    expect(decodeMention(next.slice(6, next.indexOf('world')))).toEqual(mention);
  });

  it('deletes a rendered mention chip with one Backspace and copies a markdown link', () => {
    const onChangePrompt = vi.fn();
    const token = encodeMention({ kind: 'file', id: 'src/main.rs', label: 'src/main.rs' });
    render(<ChatComposer {...defaultProps} prompt={`x${token}y`} onChangePrompt={onChangePrompt} />);
    expect(screen.getByText('src/main.rs')).toBeInTheDocument();
    expect(screen.queryByText(token)).not.toBeInTheDocument();

    const after = screen.getAllByRole('textbox')[1] as HTMLTextAreaElement;
    after.focus();
    after.setSelectionRange(0, 0);
    fireEvent.keyDown(after, { key: 'Backspace' });
    expect(onChangePrompt).toHaveBeenCalledWith('xy');

    const setData = vi.fn();
    fireEvent.copy(screen.getByText('src/main.rs'), {
      clipboardData: { setData, getData: () => '' },
    });
    expect(setData).toHaveBeenCalledWith('text/plain', '[src/main.rs](src/main.rs)');
    expect(setData).toHaveBeenCalledWith(KITE_MENTION_MIME, token);
  });

  it('offers Attach again when a stashed upload is older than 24 hours', async () => {
    const user = userEvent.setup();
    const onChangePrompt = vi.fn();
    const onPickAttachments = vi.fn();
    const initialStashes: StashEntry[] = [
      { id: 'stash-0', text: 'remember this', savedAt: 0, filesUploadedHere: 'lab' },
    ];
    render(
      <ChatComposer
        {...defaultProps}
        prompt=""
        onChangePrompt={onChangePrompt}
        onPickAttachments={onPickAttachments}
        initialStashes={initialStashes}
        stashEnvironment="lab"
      />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Control>}s{/Control}');
    expect(onChangePrompt).toHaveBeenCalledWith('remember this');
    await user.click(screen.getByRole('button', { name: 'Attach again' }));
    expect(onPickAttachments).toHaveBeenCalled();
  });

  it('does not restore uploaded stash files from another environment', async () => {
    const user = userEvent.setup();
    const onChangePrompt = vi.fn();
    render(
      <ChatComposer
        {...defaultProps}
        prompt=""
        onChangePrompt={onChangePrompt}
        initialStashes={[
          { id: 'stash-1', text: 'remember this', savedAt: Date.now(), filesUploadedHere: 'lab' },
        ]}
        stashEnvironment="other"
      />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Control>}s{/Control}');
    expect(onChangePrompt).toHaveBeenCalledWith('remember this');
    expect(screen.getByText('Uploaded files stay in the environment that saved them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach again' })).not.toBeInTheDocument();
  });

  it('still restores a text-only stash without asking to attach again', async () => {
    const user = userEvent.setup();
    const onChangePrompt = vi.fn();
    render(
      <ChatComposer
        {...defaultProps}
        prompt=""
        onChangePrompt={onChangePrompt}
        initialStashes={[{ id: 'stash-2', text: 'remember this', savedAt: 0 }]}
      />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Control>}s{/Control}');
    expect(onChangePrompt).toHaveBeenCalledWith('remember this');
    expect(screen.queryByRole('button', { name: 'Attach again' })).not.toBeInTheDocument();
  });

  it('sends a mid-message /goal as a normal message and still opens a leading /side', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onChangePrompt = vi.fn();
    const view = render(
      <ChatComposer
        {...defaultProps}
        threadProvider="codex"
        prompt="ship /goal now"
        onSend={onSend}
        onChangePrompt={onChangePrompt}
      />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status', { name: /goal/i })).not.toBeInTheDocument();

    onSend.mockClear();
    view.rerender(
      <ChatComposer
        {...defaultProps}
        prompt="/side look"
        onSend={onSend}
        onChangePrompt={onChangePrompt}
      />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(onChangePrompt).toHaveBeenCalledWith('');
    expect(screen.getByText('Side: look')).toBeInTheDocument();
  });

  it('reports goal stop from the interrupt button without dropping the goal', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onGoalStop = vi.fn();
    render(
      <ChatComposer
        {...defaultProps}
        running
        prompt=""
        goal="tests pass"
        onStop={onStop}
        onGoalStop={onGoalStop}
      />,
    );
    await user.click(screen.getByTitle(/Interrupt/i));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onGoalStop).toHaveBeenCalledWith(composerGoalStop('claude', 'tests pass'));
  });

  it('inserts dropped prompts, file/thread mentions, and files while running', () => {
    const onChangePrompt = vi.fn();
    const onStageFiles = vi.fn();
    const view = render(
      <ChatComposer
        {...defaultProps}
        prompt=""
        onChangePrompt={onChangePrompt}
        onStageFiles={onStageFiles}
      />,
    );
    fireEvent.drop(document.querySelector('[data-slot="composer-main"]') as Element, {
      dataTransfer: {
        types: ['application/x-kite-prompt'],
        getData: (type: string) => (type === 'application/x-kite-prompt' ? 'saved prompt' : ''),
      },
    });
    expect(onChangePrompt).toHaveBeenCalledWith('saved prompt');

    onChangePrompt.mockClear();
    view.rerender(
      <ChatComposer
        {...defaultProps}
        running
        prompt="Hello"
        onChangePrompt={onChangePrompt}
        onStageFiles={onStageFiles}
      />,
    );
    fireEvent.drop(document.querySelector('[data-slot="composer-main"]') as Element, {
      dataTransfer: {
        types: ['application/x-kite-files-entry'],
        getData: () => JSON.stringify({ relativePath: 'src/main.rs' }),
      },
    });
    const droppedDraft = onChangePrompt.mock.calls[0]?.[0] as string;
    expect(droppedDraft).toBeDefined();
    expect(decodeMention(droppedDraft.slice('Hello'.length))?.id).toBe('src/main.rs');

    const droppedFile = new File(['abc'], 'diagram.png', { type: 'image/png' });
    fireEvent.drop(document.querySelector('[data-slot="composer-main"]') as Element, {
      dataTransfer: {
        types: ['Files'],
        files: [droppedFile],
      },
    });
    expect(onStageFiles).toHaveBeenCalledWith([droppedFile]);
  });

  it('refuses /compact on other providers and asks codex or claude to compact without sending the slash text', async () => {
    const user = userEvent.setup();
    const refusedSends: string[] = [];
    const onCompact = vi.fn();

    function PromptHarness({
      provider,
      initial,
      onSend,
      compact,
    }: {
      provider: 'grok' | 'codex';
      initial: string;
      onSend: (text: string) => void;
      compact?: () => void;
    }) {
      const [prompt, setPrompt] = useState(initial);
      return (
        <ChatComposer
          {...defaultProps}
          threadProvider={provider}
          prompt={prompt}
          onChangePrompt={setPrompt}
          onSend={() => onSend(prompt)}
          onCompact={compact}
        />
      );
    }

    const refused = render(
      <PromptHarness key="grok" provider="grok" initial="/compact" onSend={(text) => refusedSends.push(text)} compact={onCompact} />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(screen.getByText('This provider cannot compact.')).toBeInTheDocument();
    expect(refusedSends).toEqual([]);
    expect(onCompact).not.toHaveBeenCalled();

    onCompact.mockClear();
    const askedSends: string[] = [];
    refused.rerender(
      <PromptHarness key="codex" provider="codex" initial="  /compact  " onSend={(text) => askedSends.push(text)} compact={onCompact} />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(askedSends).toEqual([]);
    expect(screen.queryByText('This provider cannot compact.')).not.toBeInTheDocument();
  });

  it('arms a dismissible New session notice and marks only the next real message fresh', async () => {
    const user = userEvent.setup();
    const onFreshContext = vi.fn();
    const sent: string[] = [];

    function ClearHarness() {
      const [prompt, setPrompt] = useState('/clear');
      return (
        <ChatComposer
          {...defaultProps}
          threadProvider="grok"
          prompt={prompt}
          onChangePrompt={setPrompt}
          onSend={() => {
            sent.push(prompt);
            setPrompt('');
          }}
          onFreshContext={onFreshContext}
        />
      );
    }

    render(<ClearHarness />);
    const textbox = screen.getByRole('textbox');
    await user.click(textbox);
    await user.keyboard('{Enter}');
    expect(screen.getByText('New session')).toBeInTheDocument();
    expect(sent).toEqual([]);
    expect(onFreshContext).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('New session')).not.toBeInTheDocument();
    await user.type(textbox, 'kept');
    await user.keyboard('{Enter}');
    expect(onFreshContext).not.toHaveBeenCalled();
    expect(sent).toEqual(['kept']);

    sent.length = 0;
    await user.clear(textbox);
    await user.type(textbox, '/clear');
    await user.keyboard('{Enter}');
    expect(screen.getByText('New session')).toBeInTheDocument();
    await user.type(textbox, 'hello');
    await user.keyboard('{Enter}');
    expect(onFreshContext).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['hello']);
    expect(screen.queryByText('New session')).not.toBeInTheDocument();

    await user.type(textbox, 'again');
    await user.keyboard('{Enter}');
    expect(onFreshContext).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['hello', 'again']);
  });

  it('keeps /compact and /clear in the middle of a message as normal text', async () => {
    const user = userEvent.setup();
    const sent: string[] = [];
    const onCompact = vi.fn();
    const onFreshContext = vi.fn();

    function MidHarness({ initial }: { initial: string }) {
      const [prompt, setPrompt] = useState(initial);
      return (
        <ChatComposer
          {...defaultProps}
          threadProvider="codex"
          prompt={prompt}
          onChangePrompt={setPrompt}
          onSend={() => sent.push(prompt)}
          onCompact={onCompact}
          onFreshContext={onFreshContext}
        />
      );
    }

    const view = render(<MidHarness key="compact" initial="please /compact" />);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(sent).toEqual(['please /compact']);
    expect(onCompact).not.toHaveBeenCalled();
    expect(screen.queryByText('This provider cannot compact.')).not.toBeInTheDocument();

    view.rerender(<MidHarness key="clear" initial="see /clear later" />);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(sent).toEqual(['please /compact', 'see /clear later']);
    expect(screen.queryByText('New session')).not.toBeInTheDocument();
    expect(onFreshContext).not.toHaveBeenCalled();
  });

  it('does not queue a whole-message /clear while a turn is running', async () => {
    const user = userEvent.setup();
    const onQueue = vi.fn();
    const onSend = vi.fn();
    render(
      <ChatComposer
        {...defaultProps}
        running
        threadProvider="claude"
        prompt="/clear"
        onSend={onSend}
        onQueue={onQueue}
      />,
    );
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(onQueue).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('enables sending and queueing for attachment-only messages and renders image thumbnails', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const imageAtt = {
      resourceId: 'att-img-1',
      displayName: 'pasted-image.png',
      isDirectory: false,
      byteSize: 2048,
      mimeType: 'image/png',
      path: 'C:/tmp/pasted-image.png',
      previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    };

    const { rerender } = render(
      <ChatComposer
        {...defaultProps}
        running={false}
        prompt=""
        attachments={[imageAtt]}
        onSend={onSend}
        onQueue={onQueue}
      />,
    );

    const thumb = document.querySelector('.kite-composer-attachment-thumb') as HTMLImageElement | null;
    expect(thumb).not.toBeNull();
    expect(thumb?.getAttribute('src')).toContain('data:image/png;base64,');

    const sendBtn = screen.getByTitle(/Send prompt/i);
    expect(sendBtn).not.toBeDisabled();
    await user.click(sendBtn);
    expect(onSend).toHaveBeenCalledTimes(1);

    rerender(
      <ChatComposer
        {...defaultProps}
        running={true}
        prompt=""
        attachments={[imageAtt]}
        onSend={onSend}
        onQueue={onQueue}
      />,
    );

    const queueBtn = screen.getByRole('button', { name: 'Queue' });
    expect(queueBtn).not.toBeDisabled();
    await user.click(queueBtn);
    expect(onQueue).toHaveBeenCalledWith('', [imageAtt]);
  });

  it('supports Steer on Ctrl+Enter while running, Alt+ArrowUp to edit last queued item, and Escape to cancel queue edit', async () => {
    const onSteer = vi.fn();
    const onEditLastQueued = vi.fn();
    const onCancelQueueEdit = vi.fn();
    const imageAtt = {
      resourceId: 'att-1',
      displayName: 'diagram.png',
      isDirectory: false,
      byteSize: 512,
    };

    const { rerender } = render(
      <ChatComposer
        {...defaultProps}
        running={true}
        prompt="Redirect focus to auth"
        attachments={[imageAtt]}
        onSteer={onSteer}
        onEditLastQueued={onEditLastQueued}
      />,
    );

    const textbox = screen.getByRole('textbox');
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSteer).toHaveBeenCalledWith('Redirect focus to auth', [imageAtt]);

    rerender(
      <ChatComposer
        {...defaultProps}
        running={true}
        prompt=""
        attachments={[]}
        onEditLastQueued={onEditLastQueued}
      />,
    );
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp', altKey: true });
    expect(onEditLastQueued).toHaveBeenCalledTimes(1);

    rerender(
      <ChatComposer
        {...defaultProps}
        running={true}
        prompt="Editing queued row"
        editingQueuedId="q-1"
        onQueue={vi.fn()}
        onCancelQueueEdit={onCancelQueueEdit}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onCancelQueueEdit).toHaveBeenCalledTimes(1);
  });

  it('shows ComposerContextStrip on draft conversations and hides it once the conversation starts', async () => {
    const { rerender } = render(
      <ChatComposer
        {...defaultProps}
        threadItems={[]}
        running={false}
        threadWorkspaceId="ws-1"
        threadWorkspaceName="kite"
        threadBranch="feat/response-thread"
      />,
    );

    expect(screen.getByTitle('Select workspace environment')).toBeInTheDocument();
    expect(screen.getByTitle(/Git branch: feat\/response-thread/i)).toBeInTheDocument();

    // Open branch menu before starting to ensure starting dismisses any open strip menu
    fireEvent.click(screen.getByTitle(/Git branch: feat\/response-thread/i));
    expect(screen.getByRole('dialog', { name: 'Select Git Branch' })).toBeInTheDocument();

    rerender(
      <ChatComposer
        {...defaultProps}
        threadItems={[
          {
            id: 'u-start',
            kind: 'user',
            text: 'Start the task',
            title: null,
            detail: null,
            status: null,
            streaming: false,
            exitCode: null,
            createdAtUnixMs: 1000,
            attachments: [],
          },
        ]}
        running={true}
        threadWorkspaceId="ws-1"
        threadWorkspaceName="kite"
        threadBranch="feat/response-thread"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Select Git Branch' })).not.toBeInTheDocument();
      expect(screen.queryByTitle('Select workspace environment')).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Git branch: feat\/response-thread/i)).not.toBeInTheDocument();
    });

    // Mounting an already-started conversation keeps the strip unmounted immediately
    const startedView = render(
      <ChatComposer
        {...defaultProps}
        threadId="thread-started"
        conversationStarted={true}
        threadWorkspaceId="ws-1"
        threadWorkspaceName="kite"
        threadBranch="main"
      />,
    );
    expect(
      startedView.container.querySelector('[data-slot="composer-context-strip"]'),
    ).toBeNull();
  });

  it('keeps paste, attach menu, dictation, voice mode, config pickers, and follow-up placeholder interactive while running', async () => {
    const user = userEvent.setup();
    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'read_dictation_availability') {
        return { canStart: true, canRequestPermission: false, guidance: '' };
      }
      if (cmd === 'start_dictation') return { ok: true };
      return null;
    });
    const onStageFiles = vi.fn();
    const onPickAttachments = vi.fn();
    const onStartVoiceMode = vi.fn();
    const onUpdateConfig = vi.fn();

    render(
      <ChatComposer
        {...defaultProps}
        running={true}
        prompt=""
        onQueue={vi.fn()}
        onSteer={vi.fn()}
        onStageFiles={onStageFiles}
        onPickAttachments={onPickAttachments}
        onStartVoiceMode={onStartVoiceMode}
        onUpdateConfig={onUpdateConfig}
      />,
    );

    const textbox = screen.getByRole('textbox');
    expect(textbox).toHaveAttribute('placeholder', 'Write a follow-up while your agent works…');

    // Paste image while running
    const pastedImage = new File(['png'], 'screenshot.png', { type: 'image/png' });
    const imgPaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(imgPaste, 'clipboardData', {
      value: { files: [pastedImage], items: [] },
    });
    textbox.dispatchEvent(imgPaste);
    expect(onStageFiles).toHaveBeenCalledWith([pastedImage]);

    // Paste >=32 KiB text while running converts to file
    onStageFiles.mockClear();
    const bigText = 'x'.repeat(32 * 1024);
    const textPaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, 'clipboardData', {
      value: { files: [], items: [], getData: (t: string) => (t === 'text/plain' ? bigText : '') },
    });
    textbox.dispatchEvent(textPaste);
    expect(onStageFiles).toHaveBeenCalledTimes(1);
    expect(onStageFiles.mock.calls[0]?.[0]?.[0]?.name).toBe('pasted-text.txt');

    // Attach menu works while running
    const attachBtn = screen.getByRole('button', { name: 'Attach files or a folder' });
    expect(attachBtn).not.toBeDisabled();
    await user.click(attachBtn);
    await user.click(await screen.findByText('Add files…'));
    expect(onPickAttachments).toHaveBeenCalledWith('files');

    // Dictation works while running
    const dictateBtn = screen.getByRole('button', { name: 'Dictate message' });
    await waitFor(() => expect(dictateBtn).not.toBeDisabled());
    await user.click(dictateBtn);
    expect(invokeCommand).toHaveBeenCalledWith(
      'start_dictation',
      expect.objectContaining({ supportedSchemaVersion: 1 }),
    );

    // Voice mode works while running
    const voiceBtn = screen.getByLabelText('Iniciar sesión de voz');
    expect(voiceBtn).not.toBeDisabled();
    await user.click(voiceBtn);
    expect(onStartVoiceMode).toHaveBeenCalledTimes(1);

    // Config pickers stay enabled while running
    const modelPicker = screen.getByRole('combobox', { name: /model/i });
    expect(modelPicker).not.toBeDisabled();
    await user.click(modelPicker);
    await user.click(await screen.findByRole('option', { name: /Automatic/i }));
    expect(onUpdateConfig).toHaveBeenCalledWith({ model: null });
  });

  it('supports Steer across any provider with onSteer and disables queue/steer when draft exceeds 120,000 chars', () => {
    const onSteer = vi.fn();
    const onQueue = vi.fn();
    const { rerender } = render(
      <ChatComposer
        {...defaultProps}
        threadProvider="antigravity"
        declaration={declarationFromCatalog({ provider: 'antigravity' })}
        running={true}
        prompt="Steer antigravity now"
        onSteer={onSteer}
        onQueue={onQueue}
      />,
    );

    const textbox = screen.getByRole('textbox');
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSteer).toHaveBeenCalledWith('Steer antigravity now', []);

    // Holding Ctrl flips Queue -> Steer even on gemini
    rerender(
      <ChatComposer
        {...defaultProps}
        threadProvider="gemini"
        declaration={declarationFromCatalog({ provider: 'gemini' })}
        running={true}
        prompt="Steer gemini"
        onSteer={onSteer}
        onQueue={onQueue}
      />,
    );
    fireEvent.keyDown(window, { key: 'Control' });
    const steerBtn = screen.getByRole('button', { name: 'Steer' });
    expect(steerBtn).not.toBeDisabled();
    fireEvent.click(steerBtn);
    expect(onSteer).toHaveBeenCalledWith('Steer gemini', []);

    // Over 120,000 chars disables Steer and Queue buttons
    rerender(
      <ChatComposer
        {...defaultProps}
        threadProvider="gemini"
        declaration={declarationFromCatalog({ provider: 'gemini' })}
        running={true}
        prompt={'a'.repeat(120_001)}
        onSteer={onSteer}
        onQueue={onQueue}
      />,
    );
    expect(screen.getByRole('button', { name: 'Steer' })).toBeDisabled();

    fireEvent.keyUp(window, { key: 'Control' });
    expect(screen.getByRole('button', { name: 'Queue' })).toBeDisabled();
  });

  it('switches default running follow-up button between Queue and Steer from saved preference', () => {
    localStorage.setItem('kite_default_follow_up', 'steer');
    try {
      const onSteer = vi.fn();
      const onQueue = vi.fn();
      render(
        <ChatComposer
          {...defaultProps}
          threadProvider="antigravity"
          declaration={declarationFromCatalog({ provider: 'antigravity' })}
          running={true}
          prompt="Steer by default"
          onSteer={onSteer}
          onQueue={onQueue}
        />,
      );

      const steerBtn = screen.getByRole('button', { name: 'Steer' });
      fireEvent.click(steerBtn);
      expect(onSteer).toHaveBeenCalledWith('Steer by default', []);

      // Holding Ctrl flips default Steer -> Queue
      fireEvent.keyDown(window, { key: 'Control' });
      const queueBtn = screen.getByRole('button', { name: 'Queue' });
      fireEvent.click(queueBtn);
      expect(onQueue).toHaveBeenCalledWith('Steer by default', []);
      fireEvent.keyUp(window, { key: 'Control' });

      // Plain Enter steers when default preference is Steer, and Ctrl+Enter flips to Queue
      onSteer.mockClear();
      onQueue.mockClear();
      const textbox = screen.getByRole('textbox');
      fireEvent.keyDown(textbox, { key: 'Enter' });
      expect(onSteer).toHaveBeenCalledWith('Steer by default', []);
      fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
      expect(onQueue).toHaveBeenCalledWith('Steer by default', []);
    } finally {
      localStorage.removeItem('kite_default_follow_up');
    }
  });

  it('preserves composer prompt text when async onSteer resolves false after cancel failure', async () => {
    const onChangePrompt = vi.fn();
    const onSteer = vi.fn().mockResolvedValue(false);
    render(
      <ChatComposer
        {...defaultProps}
        running={true}
        prompt="Keep my text if abort fails"
        onChangePrompt={onChangePrompt}
        onSteer={onSteer}
        onQueue={vi.fn()}
      />,
    );

    const textbox = screen.getByRole('textbox');
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSteer).toHaveBeenCalledWith('Keep my text if abort fails', []);
    await Promise.resolve();
    await Promise.resolve();
    expect(onChangePrompt).not.toHaveBeenCalledWith('');
  });

  it('connects changedFiles directly atop ComposerSurface.Main and expands cleanly', async () => {
    const onOpenTurnDiff = vi.fn();
    const onOpenChangedFile = vi.fn();
    const { container } = render(
      <ChatComposer
        {...defaultProps}
        changedFiles={[
          { path: 'src/App.tsx', additions: 9, deletions: 2 },
          { path: 'src/index.css', additions: 3, deletions: 1 },
        ]}
        changedFilesWorkspaceName="kite"
        onOpenTurnDiff={onOpenTurnDiff}
        onOpenChangedFile={onOpenChangedFile}
      />,
    );

    const shell = container.querySelector('[data-slot="composer-shell"]') ?? container.querySelector('.kite-composer-shell');
    const topStrip = container.querySelector('[data-slot="composer-top-strip"]');
    const mainCard = container.querySelector('[data-slot="composer-main"]');
    expect(shell).not.toBeNull();
    expect(topStrip).not.toBeNull();
    expect(mainCard).not.toBeNull();
    expect(shell!.contains(topStrip!)).toBe(true);
    expect(topStrip!.compareDocumentPosition(mainCard!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    expect(screen.getByText('2 changed files')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand changed files' }));
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /src\/App\.tsx/i }));
    expect(onOpenChangedFile).toHaveBeenCalledWith('src/App.tsx');

    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(onOpenTurnDiff).toHaveBeenCalledTimes(1);
  });
});
