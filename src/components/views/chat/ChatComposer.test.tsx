import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatComposer } from './ChatComposer';
import { declarationFromCatalog } from './driverDeclaration';
import { listConnections, type ConnectionSummary } from '../../../lib/ipc';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return { ...actual, listConnections: vi.fn(async () => []) };
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
        prompt="Running task..."
        onStop={onStop}
      />
    );

    const stopBtn = screen.getByTitle(/Stop execution/i);
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

    const option = await screen.findByText(/Claude Opus 5.5/i);
    await user.click(option);

    expect(onUpdateConfig).toHaveBeenCalledWith({ model: 'claude-opus-5-5' });
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
    await user.click(dictationBtn);
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
    expect(await screen.findByText(/Claude Opus 5.5/i)).toBeInTheDocument();

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
});
