import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast, registerToastNavigator, APPROVAL_TOAST_DURATION_MS } from './toast';
import { sileo } from 'sileo';
import type { NotificationRecord } from '../types';

vi.mock('sileo', () => {
  return {
    sileo: {
      success: vi.fn().mockReturnValue('toast-1'),
      error: vi.fn().mockReturnValue('toast-2'),
      warning: vi.fn().mockReturnValue('toast-3'),
      info: vi.fn().mockReturnValue('toast-4'),
      action: vi.fn().mockReturnValue('toast-5'),
      promise: vi.fn().mockImplementation((p) => (typeof p === 'function' ? p() : p)),
      dismiss: vi.fn(),
      clear: vi.fn(),
    },
    Toaster: vi.fn().mockReturnValue(null),
  };
});

describe('Kite Toast System (Sileo integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers success toast resolving fill from the active theme surface token with dark fallback', () => {
    const id = toast.success('Operation Complete', 'Files were indexed.');
    expect(id).toBe('toast-1');
    expect(sileo.success).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Operation Complete',
        description: 'Files were indexed.',
        fill: '#161922',
        duration: 4500,
      })
    );

    document.documentElement.style.setProperty('--menu-plate', '#ffffff');
    try {
      toast.info('Tema claro', 'Adaptado al tema activo.');
      expect(sileo.info).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Tema claro',
          fill: '#ffffff',
        })
      );
    } finally {
      document.documentElement.style.removeProperty('--menu-plate');
    }
  });

  it('triggers error toast with longer duration', () => {
    const id = toast.error('Connection Failed', 'Could not reach server.');
    expect(id).toBe('toast-2');
    expect(sileo.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Connection Failed',
        description: 'Could not reach server.',
        fill: '#161922',
        duration: 6000,
      })
    );
  });

  it('triggers action toast with interactive button', () => {
    const onClick = vi.fn();
    const id = toast.action('Review Changes', { title: 'View Diff', onClick }, '3 files staged.');
    expect(id).toBe('toast-5');
    expect(sileo.action).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review Changes',
        description: '3 files staged.',
        button: { title: 'View Diff', onClick },
      })
    );
  });

  it('formats agent approval notifications correctly and connects navigation', () => {
    const onNavigateThread = vi.fn();
    const unregister = registerToastNavigator({ onNavigateThread });

    const record: NotificationRecord = {
      id: 'notif-1',
      runId: 'run-99',
      target: {
        source: 'codeThread',
        id: 'thread-42',
      },
      kind: {
        kind: 'needsInput',
        requestKind: 'toolApproval',
      },
      createdAtUnixMs: Date.now(),
      isRead: false,
      isWaitingForInput: true,
    };

    const toastId = toast.agentApproval(record);
    expect(toastId).toBe('toast-5');

    expect(sileo.action).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Approval needed',
        description: 'Waiting for your approval to proceed.',
        roundness: 12,
        duration: APPROVAL_TOAST_DURATION_MS,
        autopilot: expect.objectContaining({
          expand: 120,
          collapse: APPROVAL_TOAST_DURATION_MS - 800,
        }),
        styles: expect.objectContaining({
          badge: 'kite-toast-approval__badge',
          title: 'kite-toast-approval__title',
          button: 'kite-toast-approval__button',
        }),
        button: expect.objectContaining({
          title: 'Review',
        }),
      })
    );

    // Clicking Review dismisses the toast and navigates to the thread
    const callArgs = (sileo.action as unknown as { mock: { calls: Array<[any]> } }).mock.calls[0][0];
    callArgs.button.onClick();
    expect(sileo.dismiss).toHaveBeenCalledWith('toast-5');
    expect(onNavigateThread).toHaveBeenCalledWith('thread-42', undefined);

    unregister();
  });

  it('formats agent settled notification for successful and failed outcomes', () => {
    const successRecord: NotificationRecord = {
      id: 'notif-2',
      target: {
        source: 'agentChat',
        id: 'chat-1',
      },
      profileId: 'agent-alpha',
      kind: {
        kind: 'settled',
        outcome: 'completed',
      },
      createdAtUnixMs: Date.now(),
      isRead: false,
    };

    toast.agentSettled(successRecord);
    expect(sileo.success).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Agent chat: Completed',
        description: 'Execution completed successfully.',
        button: expect.objectContaining({
          title: 'Open',
        }),
      })
    );

    const failRecord: NotificationRecord = {
      id: 'notif-3',
      target: {
        source: 'codeTerminal',
        id: 'term-1',
      },
      kind: {
        kind: 'settled',
        outcome: 'failed',
      },
      createdAtUnixMs: Date.now(),
      isRead: false,
    };

    toast.agentSettled(failRecord);
    expect(sileo.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Terminal runner: Attention Required',
        description: 'Agent execution stopped with errors.',
        button: expect.objectContaining({
          title: 'Inspect',
        }),
      })
    );
  });

  it('handles clipboard copy and notification', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    const ok = await toast.copy('test text to copy');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('test text to copy');
    expect(sileo.success).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Copied to clipboard',
      })
    );
  });

  it('uses characteristic actor names and navigates directly to agentChat threads and terminal sessions', () => {
    const onNavigateThread = vi.fn();
    const onNavigateTerminal = vi.fn();
    const unregister = registerToastNavigator({ onNavigateThread, onNavigateTerminal });

    const agentSettledRecord: NotificationRecord = {
      id: 'notif-agent-1',
      runId: 'run-should-not-win',
      target: {
        source: 'agentChat',
        id: 'agent-thread-7',
      },
      profileId: 'agent-chip',
      threadTitle: 'Refactor auth',
      kind: {
        kind: 'settled',
        outcome: 'completed',
      },
      createdAtUnixMs: Date.now(),
      isRead: false,
    };

    toast.agentSettled(agentSettledRecord, undefined, {
      agents: [{ id: 'agent-chip', name: 'Chip Worker' }],
    });

    expect(sileo.success).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Chip Worker finished',
        description: 'Refactor auth',
      })
    );

    const agentCall = (sileo.success as unknown as { mock: { calls: Array<[any]> } }).mock.calls[0][0];
    agentCall.button.onClick();
    expect(onNavigateThread).toHaveBeenCalledWith('agent-thread-7', 'agent-chip');

    const terminalApprovalRecord: NotificationRecord = {
      id: 'notif-term-1',
      target: {
        source: 'terminal',
        id: 'term-sess-9',
      },
      workspaceId: 'ws-kite',
      actorName: 'Orion · Codex',
      body: 'Approve running vitest?',
      kind: {
        kind: 'needsInput',
        requestKind: 'question',
      },
      createdAtUnixMs: Date.now(),
      isRead: false,
      isWaitingForInput: true,
    };

    toast.agentApproval(terminalApprovalRecord);

    expect(sileo.action).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Orion · Codex has a question',
        description: 'Approve running vitest?',
      })
    );

    const termCall = (sileo.action as unknown as { mock: { calls: Array<[any]> } }).mock.calls[0][0];
    termCall.button.onClick();
    expect(onNavigateTerminal).toHaveBeenCalledWith('term-sess-9', 'ws-kite');

    unregister();
  });
});
