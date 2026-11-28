import type { NotificationRecord } from '../../types';
import { resolveNotificationModule } from './presentation';

export interface ActiveNotificationContext {
  workMode: 'agent' | 'code' | 'chat';
  selectedAgentId?: string | null;
  selectedAgentThreadId?: string | null;
  selectedThreadId?: string | null;
  selectedWorkspaceId?: string | null;
  settingsOpen?: boolean;
  routinesOpen?: boolean;
  isWindowFocused: boolean;
  isWindowHidden?: boolean;
}

export interface NotificationDeliveryPreferences {
  osNotificationsEnabled?: boolean;
  finishSoundEnabled?: boolean;
  inputRequestsEnabled?: boolean;
}

export type NotificationAudioCue = 'completion_success' | 'completion_error' | 'approval' | null;

export interface NotificationDeliveryPlan {
  playSound: NotificationAudioCue;
  showInAppToast: boolean;
  showOsNotification: boolean;
  osToastSilent: boolean;
}

const QUIET_PLAN: NotificationDeliveryPlan = {
  playSound: null,
  showInAppToast: false,
  showOsNotification: false,
  osToastSilent: true,
};

function computeModuleDeliveryPlan(
  cue: Exclude<NotificationAudioCue, null>,
  opts: {
    isWindowFocused: boolean;
    isWindowHidden: boolean;
    inSameModule: boolean;
    soundEnabled: boolean;
    osEnabled: boolean;
    toastWhenUnfocused: boolean;
  }
): NotificationDeliveryPlan {
  if (!opts.isWindowFocused) {
    const showOsNotification = opts.osEnabled;
    const deferAudioToOsToast = opts.soundEnabled && opts.isWindowHidden && showOsNotification;
    return {
      playSound: opts.soundEnabled && !deferAudioToOsToast ? cue : null,
      showInAppToast: opts.toastWhenUnfocused,
      showOsNotification,
      osToastSilent: !deferAudioToOsToast,
    };
  }

  return {
    playSound: opts.soundEnabled ? cue : null,
    showInAppToast: !opts.inSameModule,
    showOsNotification: false,
    osToastSilent: true,
  };
}

/**
 * Evaluates which delivery channels (Web Audio cue, in-app toast, native OS toast)
 * should fire for a newly arrived unread notification given the active Kite context.
 */
export function evaluateNotificationDelivery(
  rec: NotificationRecord,
  context: ActiveNotificationContext | null | undefined,
  prefs?: NotificationDeliveryPreferences | null
): NotificationDeliveryPlan {
  const soundEnabled = prefs?.finishSoundEnabled ?? true;
  const osEnabled = Boolean(prefs?.osNotificationsEnabled);
  const inputRequestsEnabled = prefs?.inputRequestsEnabled !== false;

  const isWindowFocused = context
    ? context.isWindowFocused
    : typeof document === 'undefined' || typeof document.hasFocus !== 'function'
      ? true
      : document.hasFocus();
  const isWindowHidden = context
    ? Boolean(context.isWindowHidden)
    : typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const kindName = rec.kind?.kind;

  if (kindName === 'autoSwitchConfirm' || kindName === 'modelQuotaExhausted') {
    return {
      playSound: null,
      showInAppToast: false,
      showOsNotification: !isWindowFocused && osEnabled,
      osToastSilent: !soundEnabled,
    };
  }

  const targetModule = resolveNotificationModule(rec);
  const inSameModule =
    isWindowFocused &&
    (context == null ||
      (!context.settingsOpen &&
        !context.routinesOpen &&
        (targetModule === null || targetModule === context.workMode)));

  if (rec.isWaitingForInput === true && kindName === 'needsInput') {
    if (!inputRequestsEnabled) {
      return QUIET_PLAN;
    }
    return computeModuleDeliveryPlan('approval', {
      isWindowFocused,
      isWindowHidden,
      inSameModule,
      soundEnabled,
      osEnabled,
      toastWhenUnfocused: true,
    });
  }

  if (kindName === 'settled') {
    const outcome = rec.kind?.outcome;
    if (outcome !== 'completed' && outcome !== 'failed') {
      return QUIET_PLAN;
    }
    const cue: Exclude<NotificationAudioCue, null> =
      outcome === 'failed' ? 'completion_error' : 'completion_success';
    return computeModuleDeliveryPlan(cue, {
      isWindowFocused,
      isWindowHidden,
      inSameModule,
      soundEnabled,
      osEnabled,
      toastWhenUnfocused: false,
    });
  }

  return QUIET_PLAN;
}
