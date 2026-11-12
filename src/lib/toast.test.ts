import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast, registerToastNavigator } from './toast';
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

  it('triggers success toast with obsidian dark fill by default', () => {
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

    toast.agentApproval(record);

    expect(sileo.action).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Code thread: Approval Required',
        description: 'Waiting for your approval to proceed.',
        duration: null,
        button: expect.objectContaining({
          title: 'Review',
        }),
      })
    );

    // Call the button onClick
    const callArgs = (sileo.action as unknown as { mock: { calls: Array<[any]> } }).mock.calls[0][0];
    callArgs.button.onClick();
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
});
