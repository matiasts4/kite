import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoSwitchPolicy,
  saveAutoSwitchPolicy,
  resumeAutoSwitch,
} from './accounts';

const coreMocks = vi.hoisted(() => ({
  invokeCommand: vi.fn(),
  isTauriEnvironment: vi.fn(() => true),
}));

vi.mock('./core', () => coreMocks);

describe('Auto-switch account IPC helpers (T1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes get_auto_switch_policy, save_auto_switch_policy, and resume_auto_switch cleanly', async () => {
    coreMocks.invokeCommand.mockResolvedValueOnce({
      provider: 'agy',
      policy: {
        enabled: false,
        triggerThresholdPercent: 0,
        selectionStrategy: 'highest_quota',
        priorityOrder: [],
        excludedAccountIds: [],
        modelMismatchPolicy: 'confirm_notification',
        busyTerminalsPolicy: 'wait_idle',
        autoContinueChatTurn: true,
        cooldownSeconds: 120,
        maxConsecutiveSwitches: 3,
      },
      status: {
        paused: false,
        pauseReason: null,
        cooldownUntilMs: null,
        recentSwitchCount: 0,
      },
    });

    const got = await getAutoSwitchPolicy('antigravity');
    expect(coreMocks.invokeCommand).toHaveBeenCalledWith('get_auto_switch_policy', {
      provider: 'antigravity',
    });
    expect(got.provider).toBe('agy');
    expect(got.policy.enabled).toBe(false);

    coreMocks.invokeCommand.mockResolvedValueOnce({
      success: true,
      provider: 'agy',
      policy: { ...got.policy, enabled: true },
    });
    const saved = await saveAutoSwitchPolicy('antigravity', { ...got.policy, enabled: true });
    expect(saved.success).toBe(true);

    coreMocks.invokeCommand.mockResolvedValueOnce({
      success: true,
      provider: 'agy',
    });
    const resumed = await resumeAutoSwitch('antigravity');
    expect(resumed.success).toBe(true);
    expect(coreMocks.invokeCommand).toHaveBeenCalledWith('resume_auto_switch', {
      provider: 'antigravity',
    });
  });

  it('normalizes invoke errors safely', async () => {
    coreMocks.invokeCommand.mockRejectedValueOnce(new Error('IPC down'));
    const saved = await saveAutoSwitchPolicy('agy', {
      enabled: true,
      triggerThresholdPercent: 0,
      selectionStrategy: 'highest_quota',
      priorityOrder: [],
      excludedAccountIds: [],
      modelMismatchPolicy: 'confirm_notification',
      busyTerminalsPolicy: 'wait_idle',
      autoContinueChatTurn: true,
      cooldownSeconds: 120,
      maxConsecutiveSwitches: 3,
    });
    expect(saved.success).toBe(false);
    expect(saved.error).toContain('IPC down');
  });
});
