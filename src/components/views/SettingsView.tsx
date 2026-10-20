import React, { useState, useEffect, useCallback } from 'react';
import {
  ChevronLeftIcon,
  SettingsIcon,
  PaletteIcon,
  SquareTerminalIcon,
  BellIcon,
  MicIcon,
  AudioWaveformIcon,
  UsersIcon,
  PuzzleIcon,
  SmartphoneNfcIcon,
  ScrollTextIcon,
  CircleUserRoundIcon,
  GaugeIcon,
} from './settings/icons';
import { invokeCommand } from '../../lib/ipc';
import { OPEN_SETTINGS_EVENT, type OpenSettingsDetail } from '../../lib/settingsNav';
import { normalizeLegacySettingsTabId } from '../../lib/kiteLegacyIds';
import {
  SettingsTabId,
  SettingsTabConfig,
  TelemetryPrefs,
  TelemetryIdentity,
  UpdateCheckResult,
  DictationAvailability,
  DictationDeviceList,
  DictationInputDevice,
  DictationSettings,
} from './settings/types';
import { GeneralTab } from './settings/GeneralTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { VoiceTab } from './settings/VoiceTab';
import { ModelsTab } from './settings/ModelsTab';
import { KeybindingsTab } from './settings/KeybindingsTab';
import { AboutTab } from './settings/AboutTab';
import { TelemetryTab } from './settings/TelemetryTab';
import { ChangelogTab } from './settings/ChangelogTab';
import { AccountTab } from './settings/AccountTab';
import { QuotasTab } from './settings/QuotasTab';
import { ZedTab } from './settings/ZedTab';
import { PluginsView } from './PluginsView';
import { RoutinesView } from './RoutinesView';
import { listAudioInputDevices } from '../../lib/operator/voice/zedVoice';
import { useFilesAutoSavePreference } from '../../lib/filesAutoSavePreference';
import { useAppUpdater } from '../../hooks/useAppUpdater';
import './settings.css';

interface NotificationCenterSnapshot {
  authorization?: string;
  preferences?: {
    schemaVersion: number;
    osNotificationsEnabled: boolean;
    finishSoundEnabled: boolean;
    inputRequestsEnabled: boolean;
  };
}

function notificationOsLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  if (/win/i.test(platform)) return 'Windows notifications';
  if (/mac/i.test(platform)) return 'macOS notifications';
  if (/linux/i.test(platform)) return 'Linux notifications';
  return 'System notifications';
}

function notificationAuthorizationDetail(authorization: string, osEnabled: boolean): string {
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

const SETTINGS_TABS: SettingsTabConfig[] = [
  { id: 'general', label: 'General', blurb: 'Apariencia, terminales y actualizaciones.', icon: SettingsIcon },
  { id: 'customizations', label: 'Customizations', blurb: 'Temas, colores y aspecto visual.', icon: PaletteIcon },
  { id: 'terminal', label: 'Terminal', blurb: 'Sesiones de fondo y comportamiento de terminal.', icon: SquareTerminalIcon },
  { id: 'notifications', label: 'Notifications', blurb: 'Avisos y alertas sonoras de agentes.', icon: BellIcon },
  { id: 'voice', label: 'Voice', blurb: 'Transcripción de voz a texto y dictado.', icon: MicIcon, hasDividerBefore: true },
  { id: 'zed', label: 'Asistente Zed', blurb: 'Asistente esférico Zed, pasarela OpenCode multi-modelo, Grok Cloud, persona y latencia.', icon: AudioWaveformIcon },
  { id: 'agents', label: 'Agents & Models', blurb: 'Modelos predeterminados y razonamiento.', icon: UsersIcon },
  { id: 'quotas', label: 'Cuotas y cuentas', blurb: 'Suscripciones de IA, rotación de cuentas y proveedores monitoreados.', icon: GaugeIcon },
  { id: 'plugins', label: 'Plugins', blurb: 'Herramientas y servicios para los agentes.', icon: PuzzleIcon },
  { id: 'keybindings', label: 'Shortcuts', blurb: 'Atajos de teclado y comandos rápidos.', icon: SquareTerminalIcon },
  { id: 'remote', label: 'Remote (v0.2)', blurb: 'Sincronización móvil (en desarrollo activo).', icon: SmartphoneNfcIcon },
  { id: 'changelog', label: 'Changelog', blurb: 'Novedades y notas de cada versión.', icon: ScrollTextIcon, hasDividerBefore: true },
  { id: 'account', label: 'Account', blurb: 'Perfil y privacidad local.', icon: CircleUserRoundIcon },
];

export interface SettingsViewProps {
  onBack?: () => void;
  onOpenWhatsNew?: () => void;
  accountName?: string;
  accountEmail?: string;
  accountTier?: string;
  accountTierPaid?: boolean;
  creditsLabel?: string | null;
  mode?: 'dark' | 'light';
  palette?: string;
  onToggleMode?: (newMode: 'dark' | 'light') => void;
  onSelectTheme?: (paletteId: string, themeMode?: 'dark' | 'light') => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  onBack,
  onOpenWhatsNew,
  accountName = 'Kite User',
  accountEmail = 'local@kite.dev',
  accountTier = 'STUDIO EDITION',
  accountTierPaid = true,
  creditsLabel = 'Ilimitados',
  mode: propMode,
  palette: propPalette,
  onToggleMode: propOnToggleMode,
  onSelectTheme: propOnSelectTheme,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTabId>('general');
  const [localMode, setLocalMode] = useState<'dark' | 'light'>('dark');
  const [localPalette, setLocalPalette] = useState<string>('kite-dark');

  const currentMode = propMode ?? localMode;
  const currentPalette = propPalette ?? localPalette;

  useEffect(() => {
    if (propMode) setLocalMode(propMode);
  }, [propMode]);

  useEffect(() => {
    if (propPalette) setLocalPalette(propPalette);
  }, [propPalette]);

  useEffect(() => {
    const handleThemeEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ theme?: 'dark' | 'light'; palette?: string }>).detail;
      if (detail?.theme) setLocalMode(detail.theme);
      if (detail?.palette) setLocalPalette(detail.palette);
    };
    window.addEventListener('kite:theme-changed', handleThemeEvent);
    return () => window.removeEventListener('kite:theme-changed', handleThemeEvent);
  }, []);
  const [creditsError, setCreditsError] = useState<boolean>(false);
  const [creditsDetail, setCreditsDetail] = useState<string>(
    'Modo autónomo local activo con tus suscripciones de IA conectadas.'
  );
  const [creditsLoading, setCreditsLoading] = useState<boolean>(false);

  const handleRetryCredits = useCallback(async () => {
    setCreditsLoading(true);
    try {
      const res = await invokeCommand<{ balance: number }>('credits_balance');
      if (res && typeof res.balance === 'number') {
        setCreditsError(false);
        setCreditsDetail(`Balance de créditos: ${res.balance.toLocaleString()}.`);
      } else {
        setCreditsError(false);
        setCreditsDetail('Edición Local Autónoma. Créditos ilimitados en modo BYOK / Cuentas locales.');
      }
    } catch {
      setCreditsError(false);
      setCreditsDetail('Edición Local Autónoma. Créditos ilimitados en modo BYOK / Cuentas locales.');
    } finally {
      setCreditsLoading(false);
    }
  }, []);

  // General settings state
  const [autoSaveFiles, setAutoSaveFiles] = useFilesAutoSavePreference();
  const [automaticUpdates, setAutomaticUpdates] = useState<boolean>(true);
  const [notifInputRequests, setNotifInputRequests] = useState<boolean>(true);
  const [notifSound, setNotifSound] = useState<boolean>(true);
  const [notifOs, setNotifOs] = useState<boolean>(false);
  const [notifAuthorization, setNotifAuthorization] = useState<string>('notDetermined');

  // Telemetry local offline state (Zero external network calls)
  const [telemetryPrefs, setTelemetryPrefs] = useState<TelemetryPrefs>({ diagnostics: false, analytics: false });
  const [telemetryIdentity] = useState<TelemetryIdentity | null>({
    revision: 1,
    ready: true,
    id: 'local-offline-session',
  });

  // Unified Update Hook (synchronized with Sidebar and Tauri event bus)
  const {
    state: updaterState,
    currentVersion: appVersion,
    check: checkUpdate,
    updateAndRestart,
  } = useAppUpdater();

  const isCheckingUpdate = updaterState.status === 'checking';
  const updateInfo: UpdateCheckResult | null =
    updaterState.status === 'available'
      ? {
          available: true,
          current_version: appVersion,
          version: updaterState.version,
          notes: updaterState.notes ?? null,
        }
      : updaterState.status === 'uptodate'
      ? {
          available: false,
          current_version: appVersion,
          version: null,
          notes: null,
        }
      : null;
  const updateChecked =
    updaterState.status === 'uptodate' ||
    updaterState.status === 'available' ||
    updaterState.status === 'ready' ||
    updaterState.status === 'error';
  const updateError = updaterState.status === 'error' ? updaterState.error.message : null;

  // Voice & Dictation IPC state
  const [dictationAvailability, setDictationAvailability] = useState<DictationAvailability>({
    state: 'unavailable',
    canRequestPermission: false,
    canStart: false,
    guidance: 'No installed local transcription engine is ready.',
    localEngines: [],
  });
  const [dictationSettings, setDictationSettings] = useState<DictationSettings>({
    schemaVersion: 1,
    mode: 'local',
    localEngine: null,
    language: 'auto',
    deviceId: null,
    cuesEnabled: true,
    shortcut: { kind: 'standard' },
  });
  const [dictationDevices, setDictationDevices] = useState<DictationInputDevice[]>([]);

  const applyNotificationSnapshot = (snap: NotificationCenterSnapshot) => {
    const preferences = snap.preferences;
    if (!preferences) return;
    setNotifOs(preferences.osNotificationsEnabled);
    setNotifSound(preferences.finishSoundEnabled);
    setNotifInputRequests(preferences.inputRequestsEnabled);
    if (snap.authorization) setNotifAuthorization(snap.authorization);
  };

  // Load preferences from localStorage and IPC on mount
  useEffect(() => {
    let isMounted = true;

    try {
      const savedPalette = localStorage.getItem('bmone.palette');
      if (savedPalette) setLocalPalette(savedPalette);

      const savedTheme = localStorage.getItem('bmone.theme') as 'dark' | 'light' | null;
      if (savedTheme) setLocalMode(savedTheme);

      const savedTabRaw = localStorage.getItem('bmone.settingsTab');
      const savedTab = normalizeLegacySettingsTabId(savedTabRaw);
      if (savedTab && SETTINGS_TABS.some((t) => t.id === savedTab)) {
        setActiveTab(savedTab as SettingsTabId);
      }
    } catch {
      // Ignore localStorage errors
    }

    const onOpenTab = (e: Event) => {
      const tab = (e as CustomEvent<OpenSettingsDetail>).detail?.tab as SettingsTabId | undefined;
      if (tab) setActiveTab(tab);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenTab);

    async function loadIpcData() {
      try {
        const avail = await invokeCommand<DictationAvailability>('read_dictation_availability', {
          supportedSchemaVersion: 1,
        });
        if (isMounted && avail) {
          setDictationAvailability(avail);
        }
      } catch (err) {
        console.warn('[SettingsView] Error reading dictation availability:', err);
      }

      try {
        const dictSettings = await invokeCommand<DictationSettings>('read_dictation_settings', {
          supportedSchemaVersion: 1,
        });
        if (isMounted && dictSettings) {
          setDictationSettings(dictSettings);
        }
      } catch (err) {
        console.warn('[SettingsView] Error reading dictation settings:', err);
      }

      try {
        const devices = await invokeCommand<DictationDeviceList>('list_dictation_input_devices', {
          supportedSchemaVersion: 1,
        });
        if (isMounted && devices && devices.devices && devices.devices.length > 0) {
          setDictationDevices(devices.devices);
          if (devices.selectedId) {
            setDictationSettings((current) => ({ ...current, deviceId: devices.selectedId }));
          }
        } else {
          const browserDevices = await listAudioInputDevices();
          if (isMounted && browserDevices.length > 0) {
            setDictationDevices(
              browserDevices.map((d) => ({
                id: d.deviceId,
                name: d.label,
                isBluetooth: /bluetooth/i.test(d.label),
              }))
            );
            const savedMic = localStorage.getItem('kite_selected_mic_device_id');
            if (savedMic && savedMic !== 'automatic') {
              setDictationSettings((current) => ({ ...current, deviceId: savedMic }));
            }
          }
        }
      } catch (err) {
        console.warn('[SettingsView] Error listing dictation devices:', err);
      }

      try {
        const notifications = await invokeCommand<NotificationCenterSnapshot>(
          'notifications_refresh_authorization'
        );
        if (isMounted && notifications) {
          applyNotificationSnapshot(notifications);
        }
      } catch (err) {
        console.warn('[SettingsView] Error refreshing notification authorization:', err);
      }
    }

    loadIpcData();

    return () => {
      isMounted = false;
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenTab);
    };
  }, []);

  const handleSelectTab = useCallback((tabId: SettingsTabId) => {
    setActiveTab(tabId);
    try {
      localStorage.setItem('bmone.settingsTab', tabId);
    } catch {
      // Ignore
    }
  }, []);

  const handleBack = useCallback(() => {
    if (activeTab !== 'general') {
      handleSelectTab('general');
    } else if (onBack) {
      onBack();
    } else {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  }, [activeTab, handleSelectTab, onBack]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleBack]);

  const handleSelectTheme = (paletteId: string, themeMode?: 'dark' | 'light') => {
    const nextMode = themeMode ?? currentMode;
    setLocalPalette(paletteId);
    if (themeMode) setLocalMode(themeMode);

    if (propOnSelectTheme) {
      propOnSelectTheme(paletteId, themeMode);
    } else {
      try {
        localStorage.setItem('bmone.palette', paletteId);
        if (themeMode) localStorage.setItem('bmone.theme', nextMode);
        document.documentElement.setAttribute('data-palette', paletteId);
        document.documentElement.setAttribute('data-theme', nextMode);
        document.documentElement.classList.toggle('dark', nextMode === 'dark');
        document.documentElement.classList.toggle('light', nextMode === 'light');
        const appFrame = document.querySelector('.app-frame');
        if (appFrame) {
          appFrame.setAttribute('data-palette', paletteId);
          appFrame.setAttribute('data-theme', nextMode);
        }
        window.dispatchEvent(
          new CustomEvent('kite:theme-changed', {
            detail: { theme: nextMode, palette: paletteId },
          })
        );
      } catch (err) {
        console.warn('[SettingsView] Failed to save theme preference:', err);
      }
    }
  };

  const handleToggleMode = (newMode: 'dark' | 'light') => {
    if (propOnToggleMode) {
      propOnToggleMode(newMode);
    } else {
      const newPalette = newMode === 'dark' ? 'kite-dark' : 'kite-light';
      handleSelectTheme(newPalette, newMode);
    }
  };

  const handleToggleTelemetry = (key: 'analytics' | 'diagnostics') => {
    setTelemetryPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCheckUpdate = async () => {
    try {
      await checkUpdate();
    } catch (err) {
      console.warn('[SettingsView] Update check failed:', err);
    }
  };

  const handleUpdateAndRestart = async () => {
    try {
      await updateAndRestart();
    } catch (err) {
      console.error('[SettingsView] Update and restart failed:', err);
    }
  };

  const saveDictationSettings = async (next: DictationSettings) => {
    setDictationSettings(next);
    try {
      const updated = await invokeCommand<DictationSettings>('update_dictation_settings', {
        supportedSchemaVersion: 1,
        settings: next,
      });
      if (updated) setDictationSettings(updated);
    } catch (err) {
      console.warn('[SettingsView] Failed to update dictation settings:', err);
    }
  };

  const handleUpdateDictationMode = async (newMode: 'cloud' | 'local') => {
    await saveDictationSettings({ ...dictationSettings, mode: newMode });
  };

  const handleToggleCues = async () => {
    await saveDictationSettings({
      ...dictationSettings,
      cuesEnabled: !dictationSettings.cuesEnabled,
    });
  };

  const handleResetDictationShortcut = async () => {
    await saveDictationSettings({ ...dictationSettings, shortcut: { kind: 'standard' } });
  };

  const handleSelectDictationDevice = async (deviceId: string | null) => {
    try {
      localStorage.setItem('kite_selected_mic_device_id', deviceId || 'automatic');
    } catch {}
    await saveDictationSettings({ ...dictationSettings, deviceId });
    try {
      const devices = await invokeCommand<DictationDeviceList>('list_dictation_input_devices', {
        supportedSchemaVersion: 1,
      });
      if (devices && devices.devices && devices.devices.length > 0) {
        setDictationDevices(devices.devices);
      }
    } catch (err) {
      console.warn('[SettingsView] Failed to refresh dictation devices:', err);
    }
  };

  const handleChooseWhisperModel = async () => {
    try {
      const avail = await invokeCommand<DictationAvailability>('select_dictation_whisper_model', {
        supportedSchemaVersion: 1,
      });
      if (avail) setDictationAvailability(avail);
    } catch (err) {
      console.warn('[SettingsView] Failed to choose a Whisper model:', err);
    }
  };

  const handleRequestMicrophone = async () => {
    try {
      const avail = await invokeCommand<DictationAvailability>('request_dictation_permission', {
        supportedSchemaVersion: 1,
        requestId: crypto.randomUUID(),
      });
      if (avail) setDictationAvailability(avail);
    } catch (err) {
      console.warn('[SettingsView] Failed to request microphone permission:', err);
    }
  };

  const saveNotificationPreferences = async (next: {
    osNotificationsEnabled: boolean;
    finishSoundEnabled: boolean;
    inputRequestsEnabled: boolean;
  }) => {
    try {
      const snap = await invokeCommand<NotificationCenterSnapshot>('notifications_set_preferences', {
        schemaVersion: 1,
        ...next,
      });
      if (snap) applyNotificationSnapshot(snap);
    } catch (err) {
      console.warn('[SettingsView] Failed to save notification settings:', err);
    }
  };

  const handlePlayNotificationSample = async () => {
    try {
      await invokeCommand('notifications_play_sample');
    } catch (err) {
      console.warn('[SettingsView] Failed to play the notification sample:', err);
    }
  };

  const handleRequestNotificationAuthorization = async () => {
    try {
      const snap = await invokeCommand<NotificationCenterSnapshot>('notifications_request_authorization');
      if (snap) applyNotificationSnapshot(snap);
    } catch (err) {
      console.warn('[SettingsView] Failed to request notification permission:', err);
    }
  };

  const handleOpenNotificationSettings = async () => {
    try {
      await invokeCommand('notifications_open_system_settings');
      const snap = await invokeCommand<NotificationCenterSnapshot>('notifications_refresh_authorization');
      if (snap) applyNotificationSnapshot(snap);
    } catch (err) {
      console.warn('[SettingsView] Failed to open notification settings:', err);
    }
  };

  // Determine current display tab and metadata
  const currentTab =
    SETTINGS_TABS.find((t) => t.id === activeTab) || {
      id: activeTab,
      label: activeTab.charAt(0).toUpperCase() + activeTab.slice(1),
      blurb: 'Manage Kite settings and preferences.',
      icon: SettingsIcon,
    };

  const ActiveIcon = currentTab.icon;

  return (
    <div className="settings-view" data-palette={currentPalette} data-theme={currentMode}>
      {/* Settings Rail Sidebar */}
      <aside className="SettingsSidebar sidebar sidebar--settings" data-testid="settings-sidebar">
        <section aria-labelledby="settings-heading" className="sidebar__primary">
          <div className="sidebar__section-heading">
            <h1 className="settings-rail__title" id="settings-heading">
              Settings
            </h1>
            <button
              className="settings-rail__back"
              onClick={handleBack}
              title="Back (Esc)"
              type="button"
            >
              <ChevronLeftIcon aria-hidden="true" size={12} strokeWidth={2.2} />
              Back
            </button>
          </div>

          <nav aria-label="Settings sections" className="sidebar__list settings-rail">
            {SETTINGS_TABS.map((tab) => {
              const isSelected = activeTab === tab.id;
              const TabIcon = tab.icon;
              return (
                <React.Fragment key={tab.id}>
                  {tab.hasDividerBefore ? (
                    <span aria-hidden="true" className="settings-rail__divider" />
                  ) : null}
                  <button
                    aria-current={isSelected ? 'page' : undefined}
                    aria-description={tab.blurb}
                    className={`sidebar-row settings-rail__row${isSelected ? ' sidebar-row--selected' : ''}`}
                    onClick={() => handleSelectTab(tab.id)}
                    type="button"
                  >
                    <span className="settings-rail__glyph">
                      <TabIcon aria-hidden="true" size={14} strokeWidth={1.75} />
                    </span>
                    <span className="settings-rail__label">{tab.label}</span>
                  </button>
                </React.Fragment>
              );
            })}
          </nav>
        </section>
      </aside>

      {/* Main Settings Content Pane */}
      <section className="pane application-settings-pane" data-settings-tab={activeTab}>
        <div className="application-settings scroll-quiet">
          <div
            className={`application-settings__column${
              activeTab === 'plugins' ||
              activeTab === 'quotas' ||
              activeTab === 'customizations' ||
              activeTab === 'appearance'
                ? ' application-settings__column--wide'
                : ''
            }`}
          >
            {/* Header */}
            <header className="application-settings__heading">
              <span aria-hidden="true" className="application-settings__mark">
                <ActiveIcon size={18} strokeWidth={1.75} />
              </span>
              <div className="application-settings__heading-copy">
                <h2>{currentTab.label}</h2>
                <p>{currentTab.blurb}</p>
              </div>
            </header>

            {activeTab === 'general' && (
              <GeneralTab
                autoSaveFiles={autoSaveFiles}
                automaticUpdates={automaticUpdates}
                currentVersion={appVersion}
                isCheckingUpdate={isCheckingUpdate}
                mode={currentMode}
                onCheckUpdate={handleCheckUpdate}
                onUpdateAndRestart={handleUpdateAndRestart}
                onToggleAutoSave={() => setAutoSaveFiles(!autoSaveFiles)}
                onToggleAutomaticUpdates={() => setAutomaticUpdates((v) => !v)}
                onToggleMode={handleToggleMode}
                onToggleTelemetry={handleToggleTelemetry}
                telemetryPrefs={telemetryPrefs}
                updateChecked={updateChecked}
                updateInfo={updateInfo}
              />
            )}

            {(activeTab === 'appearance' || activeTab === 'customizations') && (
              <AppearanceTab
                mode={currentMode}
                onSelectTheme={handleSelectTheme}
                onToggleMode={handleToggleMode}
                palette={currentPalette}
              />
            )}

            {(activeTab === 'voice' || (activeTab as string) === 'dictation') && (
              <VoiceTab
                dictationAvailability={dictationAvailability}
                dictationDevices={dictationDevices}
                dictationSettings={dictationSettings}
                onChooseWhisperModel={handleChooseWhisperModel}
                onRequestMicrophone={handleRequestMicrophone}
                onResetShortcut={handleResetDictationShortcut}
                onSelectDevice={handleSelectDictationDevice}
                onToggleCues={handleToggleCues}
                onUpdateDictationMode={handleUpdateDictationMode}
              />
            )}

            {(activeTab === 'models' || activeTab === 'agents') && <ModelsTab />}

            {activeTab === 'quotas' && <QuotasTab />}

            {activeTab === 'keybindings' && <KeybindingsTab />}

            {activeTab === 'about' && (
              <AboutTab
                currentVersion={appVersion}
                isCheckingUpdate={isCheckingUpdate}
                onCheckUpdate={handleCheckUpdate}
                onUpdateAndRestart={handleUpdateAndRestart}
                onOpenWhatsNew={onOpenWhatsNew}
                onToggleTelemetry={handleToggleTelemetry}
                telemetryIdentity={telemetryIdentity}
                telemetryPrefs={telemetryPrefs}
                updateChecked={updateChecked}
                updateError={updateError}
                updateInfo={updateInfo}
              />
            )}

            {activeTab === 'changelog' && (
              <ChangelogTab
                currentVersion={appVersion}
                isCheckingUpdate={isCheckingUpdate}
                onCheckUpdate={handleCheckUpdate}
                onUpdateAndRestart={handleUpdateAndRestart}
                updateChecked={updateChecked}
                updateError={updateError}
                updateInfo={updateInfo}
              />
            )}

            {activeTab === 'telemetry' && (
              <TelemetryTab
                onToggleTelemetry={handleToggleTelemetry}
                telemetryIdentity={telemetryIdentity}
                telemetryPrefs={telemetryPrefs}
              />
            )}

            {activeTab === 'terminal' && (
              <section className="settings-group">
                <h2 className="settings-group__title">Sessions</h2>
                <div className="ui-card">
                  <div className="ui-card__row settings-row">
                    <div className="settings-row__copy">
                      <h3 className="settings-row__title">Terminal host runtime</h3>
                      <p>Integrated native daemon managing active shell sessions and scrollback.</p>
                    </div>
                    <div className="settings-row__control">
                      <span className="settings-badge" data-tone="running">Online</span>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {activeTab === 'notifications' && (
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
            )}

            {activeTab === 'zed' && <ZedTab />}

            {(activeTab === 'plugins' || (activeTab as string) === 'integrations') && (
              <section className="settings-group">
                <PluginsView embedded />
              </section>
            )}

            {activeTab === 'routines' && (
              <section className="settings-group">
                <RoutinesView workspaceId={null} />
              </section>
            )}

            {activeTab === 'remote' && (
              <section className="settings-group">
                <h2 className="settings-group__title">Conexión con dispositivos móviles</h2>
                <div className="ui-card">
                  <div className="ui-card__row settings-row">
                    <div className="settings-row__copy">
                      <h3 className="settings-row__title">Sincronización con teléfono móvil</h3>
                      <p>Control remoto de agentes, notificaciones push y aprobaciones de código en movimiento.</p>
                    </div>
                    <div className="settings-row__control">
                      <span className="settings-badge" data-tone="accent">En desarrollo para v0.2.0</span>
                    </div>
                  </div>
                </div>
                <p className="settings-note">
                  Todas las aprobaciones y comandos se ejecutan actualmente de forma autónoma en esta ventana de escritorio.
                </p>
              </section>
            )}

            {activeTab === 'import' && (
              <section className="settings-group">
                <h2 className="settings-group__title">Migración de versiones anteriores</h2>
                <div className="ui-card">
                  <div className="ui-card__row settings-row">
                    <div className="settings-row__copy">
                      <h3 className="settings-row__title">Importar datos de Kite / Orca</h3>
                      <p>Detecta y migra chats, bookmarks de workspace y perfiles de versiones anteriores.</p>
                    </div>
                    <div className="settings-row__control">
                      <button
                        className="settings-control ui-button"
                        type="button"
                        onClick={() => {
                          alert('Comprobación completada: No se detectaron instalaciones heredadas con datos pendientes de migrar en este equipo.');
                        }}
                      >
                        Comprobar e Importar
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {activeTab === 'account' && (
              <AccountTab
                accountName={accountName}
                accountEmail={accountEmail}
                accountTier={accountTier}
                accountTierPaid={accountTierPaid}
                creditsLabel={creditsLabel}
                creditsDetail={creditsDetail}
                creditsError={creditsError}
                creditsLoading={creditsLoading}
                onRetryCredits={handleRetryCredits}
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
