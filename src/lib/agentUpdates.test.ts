import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  AGENT_UPDATES_AUTO_CHECK_COOLDOWN_MS,
  AGENT_UPDATES_INITIAL_DELAY_MS,
  fetchAgentUpdatesSummary,
  resetAgentUpdatesForTest,
  triggerAgentToolJob,
  useAgentUpdates,
  type AgentUpdatesSummary,
} from './agentUpdates';

const { invokeCommandMock, isTauriEnvironmentMock } = vi.hoisted(() => ({
  invokeCommandMock: vi.fn(),
  isTauriEnvironmentMock: vi.fn(() => true),
}));

vi.mock('./ipc', () => ({
  invokeCommand: (...args: unknown[]) => invokeCommandMock(...args),
  isTauriEnvironment: () => isTauriEnvironmentMock(),
}));

const sampleSummary: AgentUpdatesSummary = {
  totalSupported: 2,
  installedCount: 1,
  outdatedCount: 1,
  lastCheckedUnixMs: 1_000,
  advisories: {
    claude: {
      engine: 'claude',
      displayName: 'Claude Code',
      state: 'outdated',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateCommand: 'claude update',
      installCommand: 'curl ...',
      binaryPath: '/usr/bin/claude',
      checkedAtUnixMs: 1_000,
    },
  },
};

describe('agentUpdates singleton store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetAgentUpdatesForTest();
    isTauriEnvironmentMock.mockReturnValue(true);
    invokeCommandMock.mockResolvedValue(sampleSummary);
  });

  afterEach(() => {
    resetAgentUpdatesForTest();
    vi.useRealTimers();
  });

  it('shares one auto-check timer and one IPC call across multiple hook instances', async () => {
    const h1 = renderHook(() => useAgentUpdates());
    const h2 = renderHook(() => useAgentUpdates());
    const h3 = renderHook(() => useAgentUpdates());

    expect(invokeCommandMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_UPDATES_INITIAL_DELAY_MS);
    });

    expect(invokeCommandMock).toHaveBeenCalledTimes(1);
    expect(invokeCommandMock).toHaveBeenCalledWith('get_agent_updates_summary', {
      forceRefresh: false,
    });
    expect(h1.result.current.summary?.outdatedCount).toBe(1);
    expect(h2.result.current.summary?.outdatedCount).toBe(1);
    expect(h3.result.current.summary?.outdatedCount).toBe(1);

    h1.unmount();
    h2.unmount();
    h3.unmount();
  });

  it('respects cooldown across remounts while allowing explicit forced refresh', async () => {
    const first = renderHook(() => useAgentUpdates());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_UPDATES_INITIAL_DELAY_MS);
    });
    expect(invokeCommandMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // Remount within cooldown: receives cached summary immediately without another auto IPC
    const second = renderHook(() => useAgentUpdates());
    expect(second.result.current.summary?.outdatedCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_UPDATES_INITIAL_DELAY_MS + 100);
    });
    expect(invokeCommandMock).toHaveBeenCalledTimes(1);

    // Explicit refresh(true) always bypasses cooldown
    await act(async () => {
      await second.result.current.refresh(true);
    });
    expect(invokeCommandMock).toHaveBeenCalledTimes(2);
    expect(invokeCommandMock).toHaveBeenLastCalledWith('get_agent_updates_summary', {
      forceRefresh: true,
    });

    second.unmount();

    // After cooldown expires, a fresh mount triggers the scheduled check again
    await vi.advanceTimersByTimeAsync(AGENT_UPDATES_AUTO_CHECK_COOLDOWN_MS + 100);
    const third = renderHook(() => useAgentUpdates());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_UPDATES_INITIAL_DELAY_MS);
    });
    expect(invokeCommandMock).toHaveBeenCalledTimes(3);
    third.unmount();
  });

  it('coalesces concurrent fetchAgentUpdatesSummary calls cleanly', async () => {
    let resolveFirst!: (val: AgentUpdatesSummary) => void;
    const firstPromise = new Promise<AgentUpdatesSummary>((resolve) => {
      resolveFirst = resolve;
    });
    invokeCommandMock
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({ ...sampleSummary, outdatedCount: 0 });

    const p1 = fetchAgentUpdatesSummary(false);
    const p2 = fetchAgentUpdatesSummary(false);
    expect(p1).toBe(p2);

    const pForcedA = fetchAgentUpdatesSummary(true);
    const pForcedB = fetchAgentUpdatesSummary(true);
    expect(pForcedA).toBe(pForcedB);
    expect(invokeCommandMock).toHaveBeenCalledTimes(1);

    resolveFirst(sampleSummary);
    await p1;
    const finalSummary = await pForcedB;
    expect(invokeCommandMock).toHaveBeenCalledTimes(2);
    expect(finalSummary.outdatedCount).toBe(0);
  });

  it('publishes initial running job from triggerAgentToolJob without overwriting newer terminal events', async () => {
    const h = renderHook(() => useAgentUpdates());

    invokeCommandMock.mockResolvedValueOnce({
      jobId: 'job-1',
      engine: 'antigravity',
      action: 'update',
      status: 'running',
      startedAtUnixMs: 1_000,
    });

    await act(async () => {
      await triggerAgentToolJob('antigravity', 'update');
    });

    expect(h.result.current.activeJobs.antigravity?.status).toBe('running');
    h.unmount();
  });
});
