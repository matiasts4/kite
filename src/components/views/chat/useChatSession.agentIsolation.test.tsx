import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  CHAT_GRID_STORAGE_KEY,
  CHAT_SUMMARIES_STORAGE_KEY,
  CHAT_THREAD_STORAGE_PREFIX,
} from './hooks/useChatGridPersistence';
import { useChatSession } from './useChatSession';
import { invokeCommand } from '../../../lib/ipc';
import type { AgentProfile } from '../../../types';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    invokeCommand: vi.fn(),
    isTauriEnvironment: () => true,
    subscribeEvent: vi.fn().mockResolvedValue(() => {}),
    listConnections: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}));

const SHIP_GUARD: AgentProfile = {
  id: 'ship-guard',
  name: 'Ship Guard',
  engine: 'antigravity',
  purpose: 'Release gate',
  avatar: null,
  createdAtUnixMs: 1,
  pinned: false,
  order: 0,
  defaultMode: 'acceptEdits',
  defaultModel: 'gemini-3-pro',
};

describe('useChatSession agent vs thread isolation', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps handleStartThreadFromHome and handleCreateNewThread in agent mode without overwriting thread grid', async () => {
    localStorage.setItem(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify({ threadIds: ['general-t1'], focusedThreadId: 'general-t1' })
    );

    let seq = 0;
    const selectEvents: Array<{ threadId?: string; agentId?: string; mode?: string }> = [];
    const onSelect = (e: Event) => {
      selectEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener('kite:select-thread', onSelect);

    vi.mocked(invokeCommand).mockImplementation(async (cmd) => {
      if (cmd === 'list_agent_chat_summaries') return { summaries: [] };
      if (cmd === 'create_agent_chat') {
        seq += 1;
        return {
          id: `agent-t-${seq}`,
          title: 'New Agent Chat',
          provider: 'antigravity',
          mode: 'acceptEdits',
          profileId: 'ship-guard',
          status: 'idle',
          items: [],
          createdAtUnixMs: 10 + seq,
          updatedAtUnixMs: 10 + seq,
        };
      }
      if (cmd === 'start_agent_chat_turn') {
        return {
          schemaVersion: 1,
          runId: 'run-agent-1',
          thread: {
            id: 'agent-t-1',
            title: 'Agent Chat',
            provider: 'antigravity',
            mode: 'acceptEdits',
            profileId: 'ship-guard',
            status: 'running',
            items: [{ id: 'u1', kind: 'user', text: 'Check changes' }],
          },
        };
      }
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      return null;
    });

    try {
      const { result } = renderHook(() =>
        useChatSession({
          workspaceId: 'ws-1',
          agentId: 'ship-guard',
          agentEngine: 'antigravity',
          threadId: null,
          agents: [SHIP_GUARD],
        })
      );

      await waitFor(() => {
        expect(result.current.isLoadingInitial).toBe(false);
      });

      await act(async () => {
        await result.current.handleStartThreadFromHome('Check changes');
      });

      await waitFor(() => {
        expect(result.current.threadsMap['agent-t-1']?.items?.length).toBeGreaterThan(0);
      });

      // Creates a second thread (agent-t-2) because agent-t-1 already has messages
      await act(async () => {
        await result.current.handleCreateNewThread('ws-1');
      });

      // Reusing empty draft agent-t-2 still stays in agent mode
      await act(async () => {
        await result.current.handleCreateNewThread('ws-1');
      });

      expect(selectEvents).toEqual([
        { threadId: 'agent-t-1', agentId: 'ship-guard', mode: 'agent' },
        { threadId: 'agent-t-2', agentId: 'ship-guard', mode: 'agent' },
        { threadId: 'agent-t-2', agentId: 'ship-guard', mode: 'agent' },
      ]);
      expect(
        vi.mocked(invokeCommand).mock.calls.filter(([cmd]) => cmd === 'save_thread_grid')
      ).toHaveLength(0);
      expect(JSON.parse(localStorage.getItem(CHAT_GRID_STORAGE_KEY) || '{}')).toEqual({
        threadIds: ['general-t1'],
        focusedThreadId: 'general-t1',
      });
    } finally {
      window.removeEventListener('kite:select-thread', onSelect);
    }
  });

  it('never loads a general Thread-mode chat or foreign agent thread into Agent tabs', async () => {
    const ownedThread = {
      id: 'ship-own-1',
      title: 'Ship Guard Chat',
      provider: 'antigravity',
      profileId: 'ship-guard',
      status: 'idle',
      items: [{ id: 'u-own', kind: 'user', text: 'Own task' }],
    };
    const generalThread = {
      id: 'general-t1',
      title: 'Quiero corregir rápidamente...',
      provider: 'claude',
      profileId: null,
      status: 'idle',
      items: [{ id: 'u-gen', kind: 'user', text: 'General thread' }],
    };
    const foreignAgentThread = {
      id: 'foreign-t1',
      title: 'Other Specialist Chat',
      provider: 'antigravity',
      profileId: 'other-agent',
      status: 'idle',
      items: [{ id: 'u-other', kind: 'user', text: 'Foreign' }],
    };

    localStorage.setItem(
      CHAT_SUMMARIES_STORAGE_KEY,
      JSON.stringify([ownedThread, generalThread, foreignAgentThread])
    );
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}ship-own-1`, JSON.stringify(ownedThread));
    localStorage.setItem(`${CHAT_THREAD_STORAGE_PREFIX}general-t1`, JSON.stringify(generalThread));
    localStorage.setItem(
      `${CHAT_THREAD_STORAGE_PREFIX}foreign-t1`,
      JSON.stringify(foreignAgentThread)
    );

    vi.mocked(invokeCommand).mockImplementation(async (cmd, args) => {
      const tid = (args as { threadId?: string } | undefined)?.threadId;
      if (cmd === 'list_agent_chat_summaries') return { summaries: [ownedThread] };
      if (cmd === 'load_agent_chat_thread') {
        return tid === 'ship-own-1' ? ownedThread : null;
      }
      if (cmd === 'list_chat_provider_models') return { models: [] };
      if (cmd === 'list_provider_agents') return { agents: [] };
      return null;
    });

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) =>
        useChatSession({
          workspaceId: 'ws-1',
          agentId: 'ship-guard',
          agentEngine: 'antigravity',
          threadId,
          agents: [SHIP_GUARD],
        }),
      { initialProps: { threadId: 'general-t1' as string | null } }
    );

    await waitFor(() => {
      expect(result.current.focusedThreadId).toBe('ship-own-1');
    });

    rerender({ threadId: 'general-t1' });
    rerender({ threadId: 'foreign-t1' });

    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.focusedThreadId).toBe('ship-own-1');
    expect(result.current.knownThreadsList.map((t) => t.id)).toEqual(['ship-own-1']);
    expect(result.current.threadsMap['general-t1']).toBeUndefined();
    expect(result.current.threadsMap['foreign-t1']).toBeUndefined();
  });
});
