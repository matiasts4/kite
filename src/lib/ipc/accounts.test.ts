import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoSwitchPolicy,
  saveAutoSwitchPolicy,
  resumeAutoSwitch,
  listPendingAutoSwitches,
  confirmPendingAutoSwitch,
  dismissPendingAutoSwitch,
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

  it('invokes list_pending_auto_switches, confirm_pending_auto_switch, and dismiss_pending_auto_switch cleanly', async () => {
    coreMocks.invokeCommand.mockResolvedValueOnce({
      success: true,
      confirmations: [
        {
          confirmationId: 'conf-1',
          provider: 'agy',
          fromAccountLabel: 'Personal',
          toAccountId: 'acc-2',
          toAccountLabel: 'Work',
          requestedModel: 'claude-opus-4-6',
          suggestedFallbackModel: 'gemini-2.5-flash',
          availableTargetModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
          busySessions: [],
          reason: 'model_mismatch',
          createdAtUnixMs: 1000,
          expiresAtUnixMs: 901000,
        },
      ],
    });

    const listed = await listPendingAutoSwitches('antigravity');
    expect(coreMocks.invokeCommand).toHaveBeenCalledWith('list_pending_auto_switches', {
      provider: 'antigravity',
    });
    expect(listed.success).toBe(true);
    expect(listed.confirmations).toHaveLength(1);

    coreMocks.invokeCommand.mockResolvedValueOnce({
      success: true,
      confirmationId: 'conf-1',
      provider: 'agy',
      toAccountId: 'acc-2',
      toAccountLabel: 'Work',
      appliedModel: 'gemini-2.5-pro',
      modelAdjusted: true,
      resumedThreadId: 'thread-1',
    });

    const confirmed = await confirmPendingAutoSwitch({
      confirmationId: 'conf-1',
      selectedModelId: 'gemini-2.5-pro',
      autoResumeTurn: true,
    });
    expect(coreMocks.invokeCommand).toHaveBeenCalledWith('confirm_pending_auto_switch', {
      confirmationId: 'conf-1',
      selectedModelId: 'gemini-2.5-pro',
      autoResumeTurn: true,
    });
    expect(confirmed.success).toBe(true);
    expect(confirmed.appliedModel).toBe('gemini-2.5-pro');

    coreMocks.invokeCommand.mockResolvedValueOnce({
      success: true,
      dismissed: true,
      confirmationId: 'conf-1',
    });

    const dismissed = await dismissPendingAutoSwitch('conf-1');
    expect(coreMocks.invokeCommand).toHaveBeenCalledWith('dismiss_pending_auto_switch', {
      confirmationId: 'conf-1',
    });
    expect(dismissed.dismissed).toBe(true);
  });

  it('returns safe fallbacks when pending confirmation IPCs throw', async () => {
    coreMocks.invokeCommand.mockRejectedValueOnce(new Error('list failed'));
    const listed = await listPendingAutoSwitches();
    expect(listed).toEqual({ success: false, confirmations: [] });

    coreMocks.invokeCommand.mockRejectedValueOnce(new Error('confirm failed'));
    const confirmed = await confirmPendingAutoSwitch({ confirmationId: 'c1' });
    expect(confirmed.success).toBe(false);
    expect(confirmed.error).toContain('confirm failed');

    coreMocks.invokeCommand.mockRejectedValueOnce(new Error('dismiss failed'));
    const dismissed = await dismissPendingAutoSwitch('c1');
    expect(dismissed.success).toBe(false);
    expect(dismissed.dismissed).toBe(false);
    expect(dismissed.error).toContain('dismiss failed');
  });
});
