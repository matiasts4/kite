import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ExtendedChatThread } from '../types';
import { useChatTurnActions } from './useChatTurnActions';
import { invokeCommand } from '../../../../lib/ipc';

vi.mock('../../../../lib/ipc', () => ({
  invokeCommand: vi.fn(),
}));

describe('useChatTurnActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles approval response correctly', async () => {
    const thread: ExtendedChatThread = {
      id: 't-1',
      provider: 'antigravity',
      mode: 'agent',
      status: 'waiting_for_approval',
      items: [],
    } as unknown as ExtendedChatThread;

    const updatedThread: ExtendedChatThread = {
      ...thread,
      status: 'running',
    };

    vi.mocked(invokeCommand).mockResolvedValueOnce(updatedThread);

    let threadsMap = { 't-1': thread };
    const setThreadsMap = vi.fn((updater) => {
      threadsMap = typeof updater === 'function' ? updater(threadsMap) : updater;
    });

    const promptMap = { 't-1': '' };
    const setPromptMap = vi.fn();
    const attachmentsMap = { 't-1': [] };
    const writeAttachments = vi.fn();
    const threadWithResolvedBinding = (t: ExtendedChatThread) => t;
    const notifyThreadsChanged = vi.fn();
    const isMountedRef = { current: true };
    const activePollRunsRef = { current: new Set<string>() };

    const { result } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap,
        setThreadsMap,
        promptMap,
        setPromptMap,
        attachmentsMap,
        writeAttachments,
        threadWithResolvedBinding,
        notifyThreadsChanged,
        isMountedRef,
        activePollRunsRef,
      })
    );

    await act(async () => {
      await result.current.handleApproval('t-1', 'allowOnce', 'req-1');
    });

    expect(invokeCommand).toHaveBeenCalledWith('respond_chat_approval', {
      threadId: 't-1',
      decision: 'allowOnce',
      requestId: 'req-1',
    });
    expect(setThreadsMap).toHaveBeenCalled();
  });

  it('handles cancelling turn correctly', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce(undefined);

    const thread: ExtendedChatThread = {
      id: 't-1',
      provider: 'antigravity',
      mode: 'agent',
      status: 'running',
      items: [],
    } as unknown as ExtendedChatThread;

    const setThreadsMap = vi.fn();
    const isMountedRef = { current: true };
    const activePollRunsRef = { current: new Set<string>(['run-1']) };

    const { result } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap: { 't-1': thread },
        setThreadsMap,
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef,
        activePollRunsRef,
      })
    );

    await act(async () => {
      await result.current.handleCancelTurn('t-1');
    });

    expect(activePollRunsRef.current.size).toBe(0);
    expect(invokeCommand).toHaveBeenCalledWith('cancel_chat_turn', { threadId: 't-1' });
    expect(result.current.isRunning['t-1']).toBe(false);
  });

  it('handles user input response', async () => {
    vi.mocked(invokeCommand).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() =>
      useChatTurnActions({
        agentId: null,
        threadsMap: {},
        setThreadsMap: vi.fn(),
        promptMap: {},
        setPromptMap: vi.fn(),
        attachmentsMap: {},
        writeAttachments: vi.fn(),
        threadWithResolvedBinding: (t) => t,
        notifyThreadsChanged: vi.fn(),
        isMountedRef: { current: true },
        activePollRunsRef: { current: new Set() },
      })
    );

    await act(async () => {
      await result.current.handleUserInputResponse('t-1', { question1: 'answer1' });
    });

    expect(invokeCommand).toHaveBeenCalledWith('respond_chat_user_input', {
      threadId: 't-1',
      answers: { question1: 'answer1' },
    });
  });
});
