import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatComposer } from './ChatComposer';

describe('ChatComposer - Behavioral Tests', () => {
  const defaultProps = {
    threadId: 'thread-1',
    threadMode: 'fullAccess' as const,
    threadProvider: 'claude' as const,
    threadModel: 'claude-3-5-sonnet',
    running: false,
    prompt: '',
    attachments: [],
    totalTokens: 1200,
    dynamicModels: [],
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
});
