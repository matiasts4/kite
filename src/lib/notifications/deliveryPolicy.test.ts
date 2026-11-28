import { describe, it, expect } from 'vitest';
import type { NotificationRecord } from '../../types';
import {
  evaluateNotificationDelivery,
  type ActiveNotificationContext,
  type NotificationDeliveryPreferences,
} from './deliveryPolicy';

function makeRecord(overrides: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: 'n-1',
    createdAtUnixMs: 1_700_000_000_000,
    isRead: false,
    ...overrides,
  };
}

const defaultPrefs: NotificationDeliveryPreferences = {
  finishSoundEnabled: true,
  osNotificationsEnabled: true,
  inputRequestsEnabled: true,
};

function makeContext(overrides: Partial<ActiveNotificationContext> = {}): ActiveNotificationContext {
  return {
    workMode: 'agent',
    settingsOpen: false,
    routinesOpen: false,
    isWindowFocused: true,
    isWindowHidden: false,
    ...overrides,
  };
}

describe('notifications/deliveryPolicy', () => {
  it('plays audio only when settled notification matches active focused module without overlays', () => {
    const agentRec = makeRecord({
      target: { source: 'agentChat', id: 't1' },
      profileId: 'a1',
      kind: { kind: 'settled', outcome: 'completed' },
    });

    expect(evaluateNotificationDelivery(agentRec, makeContext({ workMode: 'agent' }), defaultPrefs)).toEqual({
      playSound: 'completion_success',
      showInAppToast: false,
      showOsNotification: false,
      osToastSilent: true,
    });

    const failedAgentRec = makeRecord({
      target: { source: 'agentChat', id: 't1' },
      profileId: 'a1',
      kind: { kind: 'settled', outcome: 'failed' },
    });

    expect(evaluateNotificationDelivery(failedAgentRec, makeContext({ workMode: 'agent' }), defaultPrefs)).toEqual({
      playSound: 'completion_error',
      showInAppToast: false,
      showOsNotification: false,
      osToastSilent: true,
    });
  });

  it('shows in-app toast and plays audio when focused in a different module or covered by Settings/Routines', () => {
    const agentRec = makeRecord({
      target: { source: 'agentChat', id: 't1' },
      profileId: 'a1',
      kind: { kind: 'settled', outcome: 'completed' },
    });

    expect(evaluateNotificationDelivery(agentRec, makeContext({ workMode: 'code' }), defaultPrefs)).toEqual({
      playSound: 'completion_success',
      showInAppToast: true,
      showOsNotification: false,
      osToastSilent: true,
    });

    expect(
      evaluateNotificationDelivery(agentRec, makeContext({ workMode: 'agent', settingsOpen: true }), defaultPrefs)
    ).toEqual({
      playSound: 'completion_success',
      showInAppToast: true,
      showOsNotification: false,
      osToastSilent: true,
    });

    expect(
      evaluateNotificationDelivery(agentRec, makeContext({ workMode: 'agent', routinesOpen: true }), defaultPrefs)
    ).toEqual({
      playSound: 'completion_success',
      showInAppToast: true,
      showOsNotification: false,
      osToastSilent: true,
    });
  });

  it('dispatches Windows OS toast outside Kite and defers audio to OS toast only when hidden', () => {
    const terminalRec = makeRecord({
      target: { source: 'terminal', id: 's1' },
      kind: { kind: 'settled', outcome: 'completed' },
    });

    // Window blurred but visible: WebView chime + silent OS toast
    expect(
      evaluateNotificationDelivery(
        terminalRec,
        makeContext({ isWindowFocused: false, isWindowHidden: false }),
        defaultPrefs
      )
    ).toEqual({
      playSound: 'completion_success',
      showInAppToast: false,
      showOsNotification: true,
      osToastSilent: true,
    });

    // Window minimized/hidden: OS toast handles sound so WebView doesn't double-chime or get suspended
    expect(
      evaluateNotificationDelivery(
        terminalRec,
        makeContext({ isWindowFocused: false, isWindowHidden: true }),
        defaultPrefs
      )
    ).toEqual({
      playSound: null,
      showInAppToast: false,
      showOsNotification: true,
      osToastSilent: false,
    });

    // OS notifications disabled while unfocused: no OS toast, WebView chime still plays if enabled
    expect(
      evaluateNotificationDelivery(
        terminalRec,
        makeContext({ isWindowFocused: false, isWindowHidden: true }),
        { ...defaultPrefs, osNotificationsEnabled: false }
      )
    ).toEqual({
      playSound: 'completion_success',
      showInAppToast: false,
      showOsNotification: false,
      osToastSilent: true,
    });
  });

  it('ignores cancelled settled records', () => {
    const cancelledRec = makeRecord({
      target: { source: 'agentChat', id: 't1' },
      kind: { kind: 'settled', outcome: 'cancelled' },
    });

    expect(evaluateNotificationDelivery(cancelledRec, makeContext({ workMode: 'code' }), defaultPrefs)).toEqual({
      playSound: null,
      showInAppToast: false,
      showOsNotification: false,
      osToastSilent: true,
    });
  });

  it('handles needsInput across focused, cross-module, unfocused, and disabled input preferences', () => {
    const approvalRec = makeRecord({
      target: { source: 'codeThread', id: 'thread-1' },
      kind: { kind: 'needsInput', requestKind: 'toolApproval' },
      isWaitingForInput: true,
    });

    // Same module ('chat')
    expect(evaluateNotificationDelivery(approvalRec, makeContext({ workMode: 'chat' }), defaultPrefs)).toEqual({
      playSound: 'approval',
      showInAppToast: false,
      showOsNotification: false,
      osToastSilent: true,
    });

    // Different module ('code')
    expect(evaluateNotificationDelivery(approvalRec, makeContext({ workMode: 'code' }), defaultPrefs)).toEqual({
      playSound: 'approval',
      showInAppToast: true,
      showOsNotification: false,
      osToastSilent: true,
    });

    // Outside Kite (blurred)
    expect(
      evaluateNotificationDelivery(
        approvalRec,
        makeContext({ isWindowFocused: false, isWindowHidden: false }),
        defaultPrefs
      )
    ).toEqual({
      playSound: 'approval',
      showInAppToast: true,
      showOsNotification: true,
      osToastSilent: true,
    });

    // Outside Kite (minimized)
    expect(
      evaluateNotificationDelivery(
        approvalRec,
        makeContext({ isWindowFocused: false, isWindowHidden: true }),
        defaultPrefs
      )
    ).toEqual({
      playSound: null,
      showInAppToast: true,
      showOsNotification: true,
      osToastSilent: false,
    });

    // Disabled input requests
    expect(
      evaluateNotificationDelivery(
        approvalRec,
        makeContext({ isWindowFocused: false }),
        { ...defaultPrefs, inputRequestsEnabled: false }
      )
    ).toEqual({
      playSound: null,
      showInAppToast: false,
      showOsNotification: false,
      osToastSilent: true,
    });
  });

  it('handles autoSwitchConfirm and modelQuotaExhausted without duplicating in-app toasts', () => {
    const autoSwitchRec = makeRecord({
      kind: { kind: 'autoSwitchConfirm', requestKind: 'model_mismatch' },
      isWaitingForInput: true,
    });
    const quotaRec = makeRecord({
      kind: { kind: 'modelQuotaExhausted', requestKind: 'antigravity' },
    });

    expect(
      evaluateNotificationDelivery(autoSwitchRec, makeContext({ isWindowFocused: false }), defaultPrefs)
    ).toEqual({
      playSound: null,
      showInAppToast: false,
      showOsNotification: true,
      osToastSilent: false,
    });

    expect(evaluateNotificationDelivery(quotaRec, makeContext({ isWindowFocused: true }), defaultPrefs)).toEqual({
      playSound: null,
      showInAppToast: false,
      showOsNotification: false,
      osToastSilent: false,
    });

    expect(
      evaluateNotificationDelivery(
        quotaRec,
        makeContext({ isWindowFocused: false }),
        { ...defaultPrefs, finishSoundEnabled: false }
      )
    ).toEqual({
      playSound: null,
      showInAppToast: false,
      showOsNotification: true,
      osToastSilent: true,
    });
  });
});
