import React, { useState, useEffect } from 'react';
import { invokeCommand } from '../../../lib/ipc';
import { playCompletionChime } from '../../../lib/notifications/audioCues';

export interface NotificationCenterSnapshot {
  authorization: string;
  preferences: {
    osNotificationsEnabled: boolean;
    finishSoundEnabled: boolean;
    inputRequestsEnabled: boolean;
  };
}

export function notificationOsLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  if (/win/i.test(platform)) return 'Windows notifications';
  if (/mac/i.test(platform)) return 'macOS notifications';
  if (/linux/i.test(platform)) return 'Linux notifications';
  return 'System notifications';
}

export function notificationAuthorizationDetail(authorization: string, osEnabled: boolean): string {
  if (authorization === 'notDetermined') {
    return 'Show a banner when an agent finishes or needs you outside the task you are viewing.';
  }
  if (authorization === 'denied') {
    return 'Turned off in system settings. The bell and the in-app list still work.';
  }
  return osEnabled
    ? "Banners show for finished work and questions you haven't seen yet."
    : 'The bell and the in-app list still work while banners are off.';
}

export const NotificationsTab: React.FC = () => {
  const [notifInputRequests, setNotifInputRequests] = useState<boolean>(true);
  const [notifSound, setNotifSound] = useState<boolean>(true);
  const [notifOs, setNotifOs] = useState<boolean>(false);
  const [notifAuthorization, setNotifAuthorization] = useState<string>('notDetermined');

  const applyNotificationSnapshot = (snap: NotificationCenterSnapshot) => {
    const preferences = snap.preferences;
    if (!preferences) return;
    setNotifOs(preferences.osNotificationsEnabled);
    setNotifSound(preferences.finishSoundEnabled);
    setNotifInputRequests(preferences.inputRequestsEnabled);
    if (snap.authorization) setNotifAuthorization(snap.authorization);
  };

  useEffect(() => {
    let isMounted = true;
    void invokeCommand<NotificationCenterSnapshot>('notifications_get_snapshot')
      .then((snap) => {
        if (snap && isMounted) applyNotificationSnapshot(snap);
      })
      .catch((err) => {
        console.warn('[NotificationsTab] Failed to load snapshot:', err);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const saveNotificationPreferences = async (next: {
    osNotificationsEnabled: boolean;
    finishSoundEnabled: boolean;
    inputRequestsEnabled: boolean;
  }) => {
    try {
      const snap = await invokeCommand<NotificationCenterSnapshot>(
        'notifications_set_preferences',
        {
          schemaVersion: 1,
          ...next,
        }
      );
      if (snap) applyNotificationSnapshot(snap);
    } catch (err) {
      console.warn('[NotificationsTab] Failed to save notification settings:', err);
    }
  };

  const handlePlayNotificationSample = async () => {
    try {
      playCompletionChime(true, true);
      await invokeCommand('notifications_play_sample');
    } catch (err) {
      console.warn('[NotificationsTab] Failed to play the notification sample:', err);
    }
  };

  const handleRequestNotificationAuthorization = async () => {
    try {
      const snap = await invokeCommand<NotificationCenterSnapshot>(
        'notifications_request_authorization'
      );
      if (snap) applyNotificationSnapshot(snap);
    } catch (err) {
      console.warn('[NotificationsTab] Failed to request notification permission:', err);
    }
  };

  const handleOpenNotificationSettings = async () => {
    try {
      await invokeCommand('notifications_open_system_settings');
      const snap = await invokeCommand<NotificationCenterSnapshot>(
        'notifications_refresh_authorization'
      );
      if (snap) applyNotificationSnapshot(snap);
    } catch (err) {
      console.warn('[NotificationsTab] Failed to open notification settings:', err);
    }
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">When an agent needs you</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Questions from agents</h3>
            <p>Get notified when an agent stops to ask you something.</p>
          </div>
          <div className="settings-row__control">
            <button
              aria-checked={notifInputRequests}
              aria-label="Questions from agents"
              className="ui-switch"
              onClick={() =>
                saveNotificationPreferences({
                  osNotificationsEnabled: notifOs,
                  finishSoundEnabled: notifSound,
                  inputRequestsEnabled: !notifInputRequests,
                })
              }
              role="switch"
              type="button"
            >
              <span aria-hidden="true" className="ui-switch__knob" />
            </button>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Sound cues</h3>
            <p>A soft bell when an agent finishes or needs you while you&apos;re looking elsewhere.</p>
          </div>
          <div className="settings-row__control">
            <button
              aria-label="Play sample sound"
              className="settings-control ui-button"
              onClick={handlePlayNotificationSample}
              type="button"
            >
              Play
            </button>
            <button
              aria-checked={notifSound}
              aria-label="Sound"
              className="ui-switch"
              onClick={() =>
                saveNotificationPreferences({
                  osNotificationsEnabled: notifOs,
                  finishSoundEnabled: !notifSound,
                  inputRequestsEnabled: notifInputRequests,
                })
              }
              role="switch"
              type="button"
            >
              <span aria-hidden="true" className="ui-switch__knob" />
            </button>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">{notificationOsLabel()}</h3>
            <p>{notificationAuthorizationDetail(notifAuthorization, notifOs)}</p>
          </div>
          <div className="settings-row__control">
            {notifAuthorization === 'notDetermined' ? (
              <button
                className="settings-control ui-button"
                onClick={handleRequestNotificationAuthorization}
                type="button"
              >
                Enable…
              </button>
            ) : notifAuthorization === 'denied' ? (
              <button
                className="settings-control ui-button"
                onClick={handleOpenNotificationSettings}
                type="button"
              >
                Open Settings…
              </button>
            ) : (
              <button
                aria-checked={notifOs}
                aria-label={notificationOsLabel()}
                className="ui-switch"
                onClick={() =>
                  saveNotificationPreferences({
                    osNotificationsEnabled: !notifOs,
                    finishSoundEnabled: notifSound,
                    inputRequestsEnabled: notifInputRequests,
                  })
                }
                role="switch"
                type="button"
              >
                <span aria-hidden="true" className="ui-switch__knob" />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
