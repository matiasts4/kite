import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionProvider } from '../../../motion/standard/context';
import { toast } from '../../../lib/toast';
import { AgentChatSurface } from './AgentChatShell';
import type { ExtendedChatThread } from '../chat/types';

vi.mock('../../../lib/toast', () => ({ toast: { error: vi.fn() } }));

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    invokeCommand: vi.fn().mockResolvedValue(null),
    listWorkspaceBranches: vi.fn().mockResolvedValue({ branches: ['main'], current: 'main' }),
    switchWorkspaceBranch: vi.fn().mockResolvedValue({ branches: ['main'], current: 'main' }),
    createWorkspaceBranch: vi.fn().mockResolvedValue({ branches: ['main'], current: 'main' }),
    listConnections: vi.fn().mockResolvedValue([]),
  };
});

function createAgentThread(id: string, title: string): ExtendedChatThread {
  return {
    schemaVersion: 1,
    revision: '1',
    id,
    profileId: 'agent-1',
    provider: 'claude',
    title,
    items: [
      {
        id: `${id}-m1`,
        kind: 'user',
        text: `Agent prompt for ${title}`,
        title: null,
        detail: null,
        status: null,
        streaming: false,
        exitCode: null,
        createdAtUnixMs: 1000,
        attachments: [],
      },
    ],
    mode: 'acceptEdits',
    plan: false,
    model: null,
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    workspaceId: 'ws-1',
    pinned: false,
    createdAtUnixMs: 1000,
    updatedAtUnixMs: 1000,
  };
}

describe('AgentChatSurface thread transitions', () => {
  afterEach(() => {
    cleanup();
  });

  it('crossfades transcript swaps between agent tabs and isolates exiting transcript panes', () => {
    const t1 = createAgentThread('agent-t1', 'First Tab');
    const t2 = createAgentThread('agent-t2', 'Second Tab');
    const baseProps = {
      agentId: 'agent-1',
      agentName: 'Builder',
      engineLabel: 'Claude',
      workspaceId: 'ws-1',
      workspaceName: 'Workspace',
      workspaces: [{ id: 'ws-1', name: 'Workspace' }],
      tabs: [
        { id: t1.id, title: t1.title },
        { id: t2.id, title: t2.title },
      ],
      isDraft: false,
      running: false,
      prompt: '',
      attachments: [],
      totalTokens: 0,
      dynamicModels: [],
      onNew: vi.fn(),
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onChangePrompt: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      onPickAttachments: vi.fn(),
      onStageFiles: vi.fn(),
      onStagePaths: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onUpdateConfig: vi.fn(),
    };

    const { rerender } = render(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          ...baseProps,
          activeThread: t1,
          selectedId: t1.id,
        })
      )
    );

    expect(screen.getByText('Agent prompt for First Tab')).toBeInTheDocument();

    rerender(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          ...baseProps,
          activeThread: t2,
          selectedId: t2.id,
        })
      )
    );

    expect(screen.getByText('Agent prompt for Second Tab')).toBeInTheDocument();
    const transcripts = Array.from(document.querySelectorAll('.chat-transcript'));
    const presentTranscript = transcripts.find((el) => el.getAttribute('data-motion-present') === 'true');
    const exitingTranscript = transcripts.find((el) => el.getAttribute('data-motion-present') === 'false');
    expect(presentTranscript).toBeDefined();
    if (exitingTranscript) {
      expect(exitingTranscript).toHaveAttribute('aria-hidden', 'true');
      expect((exitingTranscript as HTMLElement & { inert: boolean }).inert).toBe(true);
    }
  });

  it('queues messages while agent is running and preserves queuedRuns across tab switches', () => {
    const onQueuePrompt = vi.fn();
    const onSendNowQueuedRun = vi.fn();
    const t1: ExtendedChatThread = {
      ...createAgentThread('agent-t1', 'First Tab'),
      status: 'running',
      queuedRuns: [{ id: 'aq-1', text: 'Follow-up after current task' }],
    };
    const t2 = createAgentThread('agent-t2', 'Second Tab');
    const baseProps = {
      agentId: 'agent-1',
      agentName: 'Builder',
      engineLabel: 'Claude',
      workspaceId: 'ws-1',
      workspaceName: 'Workspace',
      workspaces: [{ id: 'ws-1', name: 'Workspace' }],
      tabs: [
        { id: t1.id, title: t1.title, running: true },
        { id: t2.id, title: t2.title, running: false },
      ],
      isDraft: false,
      running: true,
      prompt: 'Second queued instruction',
      attachments: [],
      totalTokens: 0,
      dynamicModels: [],
      onNew: vi.fn(),
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onChangePrompt: vi.fn(),
      onSend: vi.fn(),
      onQueuePrompt,
      onSendNowQueuedRun,
      onStop: vi.fn(),
      onPickAttachments: vi.fn(),
      onStageFiles: vi.fn(),
      onStagePaths: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onUpdateConfig: vi.fn(),
    };

    const { rerender } = render(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          ...baseProps,
          activeThread: t1,
          selectedId: t1.id,
        })
      )
    );

    const queueRegion = screen.getByRole('region', { name: 'Queued messages' });
    expect(within(queueRegion).getByText('Queued (1)')).toBeInTheDocument();
    expect(within(queueRegion).getByText('Follow-up after current task')).toBeInTheDocument();

    const queueBtn = screen.getByRole('button', { name: 'Queue' });
    fireEvent.click(queueBtn);
    expect(onQueuePrompt).toHaveBeenCalledWith('Second queued instruction', []);

    // Switch to Tab 2 and back to Tab 1 -> queued item is still displayed
    rerender(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          ...baseProps,
          running: false,
          prompt: '',
          activeThread: t2,
          selectedId: t2.id,
        })
      )
    );
    expect(screen.queryByRole('region', { name: 'Queued messages' })).not.toBeInTheDocument();

    rerender(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          ...baseProps,
          running: true,
          prompt: '',
          activeThread: t1,
          selectedId: t1.id,
        })
      )
    );
    expect(screen.getByText('Follow-up after current task')).toBeInTheDocument();
  });

  it('toasts generic process failures once per occurrence in Agent Chat', () => {
    vi.mocked(toast.error).mockClear();
    const failedThread: ExtendedChatThread = {
      ...createAgentThread('agent-err-t1', 'Failed Tab'),
      updatedAtUnixMs: 5000,
      turnFailure: {
        kind: 'processError',
        message: 'API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host',
      },
    };
    const { unmount } = render(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          agentId: 'agent-1',
          agentName: 'Builder',
          engineLabel: 'Claude',
          workspaceId: 'ws-1',
          workspaceName: 'Workspace',
          workspaces: [{ id: 'ws-1', name: 'Workspace' }],
          tabs: [{ id: failedThread.id, title: failedThread.title }],
          selectedId: failedThread.id,
          activeThread: failedThread,
          isDraft: false,
          running: false,
          prompt: '',
          attachments: [],
          totalTokens: 0,
          dynamicModels: [],
          onNew: vi.fn(),
          onSelect: vi.fn(),
          onRename: vi.fn(),
          onArchive: vi.fn(),
          onChangePrompt: vi.fn(),
          onSend: vi.fn(),
          onStop: vi.fn(),
          onPickAttachments: vi.fn(),
          onStageFiles: vi.fn(),
          onStagePaths: vi.fn(),
          onRemoveAttachment: vi.fn(),
          onUpdateConfig: vi.fn(),
          onApprovalDecision: vi.fn(),
        })
      )
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('docks usageLimit and authRequired banners above composer in Agent Chat and resets dismissal across tabs', () => {
    vi.mocked(toast.error).mockClear();
    const usageTab: ExtendedChatThread = {
      ...createAgentThread('agent-usage-t1', 'Usage Tab'),
      provider: 'antigravity',
      turnFailure: {
        kind: 'usageLimit',
        message: 'Quota reached on model',
        resetAtUnixMs: null,
      },
    };
    const authTab: ExtendedChatThread = {
      ...createAgentThread('agent-auth-t2', 'Auth Tab'),
      provider: 'antigravity',
      turnFailure: {
        kind: 'authRequired',
        message: 'Please sign in again',
      },
    };
    const onSend = vi.fn();
    const sharedProps = {
      agentId: 'agent-1',
      agentName: 'Builder',
      engineLabel: 'Claude',
      workspaceId: 'ws-1',
      workspaceName: 'Workspace',
      workspaces: [{ id: 'ws-1', name: 'Workspace' }],
      tabs: [
        { id: usageTab.id, title: usageTab.title },
        { id: authTab.id, title: authTab.title },
      ],
      isDraft: false,
      running: false,
      prompt: '',
      attachments: [],
      totalTokens: 0,
      dynamicModels: [],
      onNew: vi.fn(),
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onChangePrompt: vi.fn(),
      onSend,
      onStop: vi.fn(),
      onPickAttachments: vi.fn(),
      onStageFiles: vi.fn(),
      onStagePaths: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onUpdateConfig: vi.fn(),
      onApprovalDecision: vi.fn(),
    };

    const { rerender, unmount } = render(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          ...sharedProps,
          selectedId: usageTab.id,
          activeThread: usageTab,
        })
      )
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Usage limit reached');
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          ...sharedProps,
          selectedId: authTab.id,
          activeThread: authTab,
        })
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in required');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    unmount();
  });

  it('avoids duplicate queue rows when onQueuePrompt is provided, restores unsent draft on edit+save, and steers any provider while running', async () => {
    const { voiceSessionStore } = await import('../../../lib/operator/voice/voiceSessionStore');
    voiceSessionStore.stopSession();
    const onQueuePrompt = vi.fn();
    const onUpdateQueuedRuns = vi.fn();
    const onSteerPrompt = vi.fn();
    const onUpdateConfig = vi.fn();
    const onNew = vi.fn().mockResolvedValue('agent-voice-thread-new');
    const activeThread: ExtendedChatThread = {
      ...createAgentThread('agent-steer-t1', 'Busy Tab'),
      provider: 'antigravity',
      status: 'running',
      queuedRuns: [{ id: 'aq-canonical', text: 'First queued' }],
    };

    function AgentQueueHarness() {
      const [prompt, setPrompt] = useState('Unsent agent draft');
      const [attachments, setAttachments] = useState<any[]>([]);
      return createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          agentId: 'agent-1',
          agentName: 'Builder',
          engineLabel: 'Antigravity',
          workspaceId: 'ws-1',
          workspaceName: 'Workspace',
          workspaces: [{ id: 'ws-1', name: 'Workspace' }],
          tabs: [{ id: activeThread.id, title: activeThread.title, running: true }],
          selectedId: activeThread.id,
          activeThread,
          isDraft: false,
          running: true,
          prompt,
          attachments,
          totalTokens: 0,
          dynamicModels: [],
          onNew,
          onSelect: vi.fn(),
          onRename: vi.fn(),
          onArchive: vi.fn(),
          onChangePrompt: setPrompt,
          onSetAttachments: setAttachments,
          onSend: vi.fn(),
          onQueuePrompt,
          onUpdateQueuedRuns,
          onSteerPrompt,
          onStop: vi.fn(),
          onPickAttachments: vi.fn(),
          onStageFiles: vi.fn(),
          onStagePaths: vi.fn(),
          onRemoveAttachment: vi.fn(),
          onUpdateConfig,
        }),
      );
    }

    render(createElement(AgentQueueHarness));

    // Edit queued message and save -> restores 'Unsent agent draft'
    const queueRegion = screen.getByRole('region', { name: 'Queued messages' });
    fireEvent.click(within(queueRegion).getByRole('button', { name: 'Edit' }));
    const textbox = screen.getByRole('textbox');
    expect(textbox).toHaveValue('First queued');
    fireEvent.change(textbox, { target: { value: 'Updated queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onUpdateQueuedRuns).toHaveBeenCalledWith(
      [{ id: 'aq-canonical', text: 'Updated queued' }],
      undefined,
    );
    expect(screen.getByRole('textbox')).toHaveValue('Unsent agent draft');

    // Queueing delegates to onQueuePrompt without inflating local queue count
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    expect(onQueuePrompt).toHaveBeenCalledWith('Unsent agent draft', []);
    expect(within(queueRegion).getByText('Queued (1)')).toBeInTheDocument();

    // Ctrl+Enter steers even on antigravity while running
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Steer antigravity agent' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    expect(onSteerPrompt).toHaveBeenCalledWith('Steer antigravity agent', []);

    // Config controls remain enabled while running
    expect(screen.getByRole('combobox', { name: /model/i })).not.toBeDisabled();

    // Launching Voice Mode while running opens a fresh voice thread via onNew
    fireEvent.click(screen.getByLabelText('Iniciar sesión de voz'));
    await waitFor(() => {
      expect(onNew).toHaveBeenCalledTimes(1);
      expect(voiceSessionStore.getSnapshot().boundThreadId).toBe('agent-voice-thread-new');
    });
    voiceSessionStore.stopSession();
  });
});

describe('AgentChatSurface teammate inbox deep-links', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('navigates to threadId via onSelect or kite:select-thread while keeping legacy null threadId safe', async () => {
    const ipc = await import('../../../lib/ipc');
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_message_inbox') {
        return {
          schemaVersion: 1,
          profileId: 'agent-1',
          messages: [
            {
              id: 'm-remote',
              senderName: 'Reviewer',
              body: 'Finished audit on remote thread.',
              delivered: true,
              threadId: 'thread-remote-42',
              direction: 'incoming',
            },
            {
              id: 'm-local',
              senderName: 'Planner',
              body: 'Updated local tab.',
              delivered: true,
              threadId: 'agent-t1',
              direction: 'outgoing',
            },
            {
              id: 'm-legacy',
              senderName: 'Legacy Bot',
              body: 'Historical audit message without thread.',
              delivered: true,
              threadId: null,
            },
          ],
          nextCursor: null,
        };
      }
      if (cmd === 'agent_messaging_preference') {
        return { schemaVersion: 1, enabled: true, readOnly: false, revision: '1' };
      }
      return null;
    });

    const t1 = createAgentThread('agent-t1', 'First Tab');
    const onSelect = vi.fn();
    const selectThreadListener = vi.fn();
    window.addEventListener('kite:select-thread', selectThreadListener);

    render(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          agentId: 'agent-1',
          agentName: 'Builder',
          engineLabel: 'Claude',
          workspaceId: 'ws-1',
          workspaceName: 'Workspace',
          workspaces: [{ id: 'ws-1', name: 'Workspace' }],
          activeThread: t1,
          tabs: [{ id: t1.id, title: t1.title }],
          selectedId: t1.id,
          isDraft: false,
          running: false,
          prompt: '',
          attachments: [],
          totalTokens: 0,
          dynamicModels: [],
          onNew: vi.fn(),
          onSelect,
          onRename: vi.fn(),
          onArchive: vi.fn(),
          onChangePrompt: vi.fn(),
          onSend: vi.fn(),
          onStop: vi.fn(),
          onPickAttachments: vi.fn(),
          onStageFiles: vi.fn(),
          onStagePaths: vi.fn(),
          onRemoveAttachment: vi.fn(),
          onUpdateConfig: vi.fn(),
        })
      )
    );

    const summary = screen.getByText('Teammate inbox');
    fireEvent.click(summary);

    await waitFor(() => {
      expect(screen.getByText('Finished audit on remote thread.')).toBeInTheDocument();
      expect(screen.getByText('Historical audit message without thread.')).toBeInTheDocument();
    });

    const remoteBtn = screen.getByRole('button', { name: /Open thread for message from Reviewer/i });
    fireEvent.click(remoteBtn);
    expect(selectThreadListener).toHaveBeenCalledTimes(1);
    const dispatchedEvent = selectThreadListener.mock.calls[0][0] as CustomEvent;
    expect(dispatchedEvent.detail).toEqual({ threadId: 'thread-remote-42', mode: 'chat' });

    const localBtn = screen.getByRole('button', { name: /Open thread for message from Planner/i });
    fireEvent.click(localBtn);
    expect(onSelect).toHaveBeenCalledWith('agent-t1');

    expect(screen.queryByRole('button', { name: /Legacy Bot/i })).not.toBeInTheDocument();

    window.removeEventListener('kite:select-thread', selectThreadListener);
  });

  it('renders voice turns in AgentChatSurface and exits draft hero (T20)', async () => {
    const { voiceSessionStore } = await import('../../../lib/operator/voice/voiceSessionStore');
    voiceSessionStore.stopSession();
    voiceSessionStore.clearThreadVoiceTurns('agent-voice-t1');

    const t1 = createAgentThread('agent-voice-t1', 'Sesión de voz');
    voiceSessionStore.startSession('agent-voice-t1', 'thread');
    voiceSessionStore.addThreadVoiceTurn('agent-voice-t1', {
      turnId: 'vt-agent-1',
      userPrompt: 'Revisemos los próximos pasos del ODD',
      source: 'voz',
      reply: 'Propongo empezar definiendo el ODD de orquestación.',
      createdAt: Date.now(),
    });

    try {
      render(
        createElement(
          MotionProvider,
          null,
          createElement(AgentChatSurface, {
            agentId: 'agent-1',
            agentName: 'Builder',
            engineLabel: 'Claude',
            workspaceId: 'ws-1',
            workspaceName: 'Workspace',
            workspaces: [{ id: 'ws-1', name: 'Workspace' }],
            activeThread: t1,
            tabs: [{ id: t1.id, title: t1.title }],
            selectedId: t1.id,
            isDraft: true,
            running: false,
            prompt: '',
            attachments: [],
            totalTokens: 0,
            dynamicModels: [],
            onNew: vi.fn(),
            onSelect: vi.fn(),
            onRename: vi.fn(),
            onArchive: vi.fn(),
            onChangePrompt: vi.fn(),
            onSend: vi.fn(),
            onStop: vi.fn(),
            onPickAttachments: vi.fn(),
            onStageFiles: vi.fn(),
            onStagePaths: vi.fn(),
            onRemoveAttachment: vi.fn(),
            onUpdateConfig: vi.fn(),
          })
        )
      );

      expect(screen.getByText('Revisemos los próximos pasos del ODD')).toBeInTheDocument();
      expect(screen.getByText('Propongo empezar definiendo el ODD de orquestación.')).toBeInTheDocument();
      expect(screen.queryByText('What should we build?')).not.toBeInTheDocument();
    } finally {
      voiceSessionStore.stopSession();
      voiceSessionStore.clearThreadVoiceTurns('agent-voice-t1');
    }
  });

  it('renders Thread AutoPilot bar in AgentChatSurface and wires thread prompt submission', () => {
    const t1 = createAgentThread('agent-auto-t1', 'Auto Thread');
    render(
      createElement(
        MotionProvider,
        null,
        createElement(AgentChatSurface, {
          agentId: 'agent-1',
          agentName: 'Orion',
          engineLabel: 'Antigravity',
          workspaceId: 'ws-1',
          workspaceName: 'Workspace',
          workspaces: [{ id: 'ws-1', name: 'Workspace' }],
          activeThread: t1,
          tabs: [{ id: t1.id, title: t1.title }],
          selectedId: t1.id,
          isDraft: false,
          running: false,
          prompt: '',
          attachments: [],
          totalTokens: 0,
          dynamicModels: [],
          onNew: vi.fn(),
          onSelect: vi.fn(),
          onRename: vi.fn(),
          onArchive: vi.fn(),
          onChangePrompt: vi.fn(),
          onSend: vi.fn(),
          onStop: vi.fn(),
          onPickAttachments: vi.fn(),
          onStageFiles: vi.fn(),
          onStagePaths: vi.fn(),
          onRemoveAttachment: vi.fn(),
          onUpdateConfig: vi.fn(),
        })
      )
    );

    expect(screen.getByText('Thread Autonomy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Auto$/i })).toBeInTheDocument();
  });
});
