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
  if (/win/i.test(platform)) return 'Notificaciones de Windows';
  if (/mac/i.test(platform)) return 'Notificaciones de macOS';
  if (/linux/i.test(platform)) return 'Notificaciones de Linux';
  return 'Notificaciones del sistema';
}

export function notificationAuthorizationDetail(authorization: string, osEnabled: boolean): string {
  if (authorization === 'notDetermined') {
    return 'Muestra un aviso cuando un agente termine o te necesite fuera de la tarea que estás viendo.';
  }
  if (authorization === 'denied') {
    return 'Desactivadas en la configuración del sistema. La campana y la lista interna siguen funcionando.';
  }
  return osEnabled
    ? 'Los avisos se muestran para trabajo finalizado y preguntas que aún no has visto.'
    : 'La campana y la lista interna siguen funcionando mientras los avisos estén desactivados.';
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
    void invokeCommand<NotificationCenterSnapshot>('notifications_snapshot')
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
      <h2 className="settings-group__title">Cuando un agente te necesite</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Preguntas de los agentes</h3>
            <p>Recibe un aviso cuando un agente se detenga para preguntarte algo.</p>
          </div>
          <div className="settings-row__control">
            <button
              aria-checked={notifInputRequests}
              aria-label="Preguntas de los agentes"
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
            <h3 className="settings-row__title">Avisos sonoros</h3>
            <p>Un tono suave cuando un agente termine o te necesite mientras miras otra ventana.</p>
          </div>
          <div className="settings-row__control">
            <button
              aria-label="Reproducir sonido de prueba"
              className="settings-control ui-button"
              onClick={handlePlayNotificationSample}
              type="button"
            >
              Probar
            </button>
            <button
              aria-checked={notifSound}
              aria-label="Avisos sonoros"
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
                Habilitar…
              </button>
            ) : notifAuthorization === 'denied' ? (
              <button
                className="settings-control ui-button"
                onClick={handleOpenNotificationSettings}
                type="button"
              >
                Abrir configuración…
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
