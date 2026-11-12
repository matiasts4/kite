import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { springs, tweens } from '../../motion/standard/tokens';
import {
  ChevronLeftIcon,
  SettingsIcon,
  PaletteIcon,
  SquareTerminalIcon,
  BellIcon,
  MicIcon,
  AudioWaveformIcon,
  PuzzleIcon,
  ScrollTextIcon,
  GaugeIcon,
} from './settings/icons';
import { invokeCommand } from '../../lib/ipc';
import { OPEN_SETTINGS_EVENT, type OpenSettingsDetail } from '../../lib/settingsNav';
import { normalizeLegacySettingsTabId } from '../../lib/kiteLegacyIds';
import {
  readDiagnosticsEnabled,
  readKitePref,
  readShowPaneContext,
  writeDiagnosticsEnabled,
  writeKitePref,
} from '../../lib/kitePrefs';
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
import { ChatSettingsTab } from './settings/ChatSettingsTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { VoiceTab } from './settings/VoiceTab';
import { KeybindingsTab } from './settings/KeybindingsTab';
import { AboutTab } from './settings/AboutTab';
import { TelemetryTab } from './settings/TelemetryTab';
import { ChangelogTab } from './settings/ChangelogTab';
import { QuotasTab } from './settings/QuotasTab';
import { ZedTab } from './settings/ZedTab';
import { TerminalTab } from './settings/TerminalTab';
import { NotificationsTab } from './settings/NotificationsTab';
import { PluginsView } from './PluginsView';
import { RoutinesView } from './RoutinesView';
import { listAudioInputDevices } from '../../lib/operator/voice/zedVoice';
import { useFilesAutoSavePreference } from '../../lib/filesAutoSavePreference';
import { useAppUpdater } from '../../hooks/useAppUpdater';
import './settings.css';

const SETTINGS_TABS: SettingsTabConfig[] = [
  { id: 'general', label: 'General', blurb: 'Apariencia, autoguardado y actualizaciones de software.', icon: SettingsIcon },
  { id: 'customizations', label: 'Customizations', blurb: 'Temas, colores y aspecto visual.', icon: PaletteIcon },
  { id: 'terminal', label: 'Terminal', blurb: 'Apariencia, tipografía, motor de renderizado, shell y enlaces web.', icon: SquareTerminalIcon },
  { id: 'notifications', label: 'Notifications', blurb: 'Avisos y alertas sonoras de agentes.', icon: BellIcon },
  { id: 'chat', label: 'Chat', blurb: 'Visibilidad de las acciones del hilo.', icon: BellIcon },
  { id: 'voice', label: 'Voice & Dictado', blurb: 'Dictado por voz, micrófono y transcripción.', icon: MicIcon, hasDividerBefore: true },
  { id: 'zed', label: 'Asistente Zed', blurb: 'Personalidad de Zed, síntesis de voz, pasarela multi-modelo, latencia y memoria.', icon: AudioWaveformIcon },
  { id: 'quotas', label: 'Cuentas y Proveedores', blurb: 'Bóveda de credenciales, cuentas CLI y límites de cuota.', icon: GaugeIcon },
  { id: 'plugins', label: 'Plugins', blurb: 'Herramientas y servicios para los agentes.', icon: PuzzleIcon },
  { id: 'keybindings', label: 'Shortcuts', blurb: 'Atajos de teclado y comandos rápidos.', icon: SquareTerminalIcon },
  { id: 'changelog', label: 'Changelog', blurb: 'Novedades y notas de cada versión.', icon: ScrollTextIcon, hasDividerBefore: true },
];

export interface SettingsViewProps {
  isOpen?: boolean;
  onClose?: () => void;
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
  embedded?: boolean;
  initialTab?: SettingsTabId | null;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  isOpen,
  onClose,
  onBack,
  onOpenWhatsNew,
  mode: propMode,
  palette: propPalette,
  onToggleMode: propOnToggleMode,
  onSelectTheme: propOnSelectTheme,
  embedded = false,
  initialTab,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() => {
    if (initialTab) return initialTab;
    try {
      const savedTabRaw = readKitePref('settingsTab');
      const savedTab = normalizeLegacySettingsTabId(savedTabRaw);
      if (savedTab && SETTINGS_TABS.some((t) => t.id === savedTab)) {
        return savedTab as SettingsTabId;
      }
    } catch {
      // Ignore
    }
    return 'general';
  });
  const [paneDirection, setPaneDirection] = useState(1);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
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
  // General settings state
  const [autoSaveFiles, setAutoSaveFiles] = useFilesAutoSavePreference();
  const [automaticUpdates, setAutomaticUpdates] = useState<boolean>(true);

  // Telemetry local offline state (Zero external network calls)
  const [telemetryPrefs, setTelemetryPrefs] = useState<TelemetryPrefs>(() => ({
    diagnostics: readDiagnosticsEnabled(),
    analytics: false,
  }));
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

  // Load preferences from localStorage and IPC on mount
  useEffect(() => {
    let isMounted = true;

    try {
      const savedPalette = readKitePref('palette');
      if (savedPalette) setLocalPalette(savedPalette);

      const savedTheme = readKitePref('theme') as 'dark' | 'light' | null;
      if (savedTheme === 'dark' || savedTheme === 'light') setLocalMode(savedTheme);

      readShowPaneContext();
      const savedTabRaw = readKitePref('settingsTab');
      const savedTab = normalizeLegacySettingsTabId(savedTabRaw);
      if (savedTab && savedTab !== savedTabRaw) writeKitePref('settingsTab', savedTab);
      if (savedTab && SETTINGS_TABS.some((t) => t.id === savedTab)) {
        setActiveTab(savedTab as SettingsTabId);
      }
    } catch {
      // Ignore localStorage errors
    }

    const onOpenTab = (e: Event) => {
      const requested = (e as CustomEvent<OpenSettingsDetail>).detail?.tab ?? null;
      const tab = normalizeLegacySettingsTabId(requested);
      if (tab) setActiveTab(tab as SettingsTabId);
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
    }

    loadIpcData();

    return () => {
      isMounted = false;
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenTab);
    };
  }, []);

  const handleSelectTab = useCallback((tabId: SettingsTabId) => {
    const next = SETTINGS_TABS.findIndex((tab) => tab.id === tabId);
    const prev = SETTINGS_TABS.findIndex((tab) => tab.id === activeTabRef.current);
    setPaneDirection(next >= prev ? 1 : -1);
    setActiveTab(tabId);
    try {
      writeKitePref('settingsTab', tabId);
    } catch {
      // Ignore
    }
  }, []);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
    } else if (onBack) {
      onBack();
    } else {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  }, [onClose, onBack]);

  useEffect(() => {
    if (isOpen === false) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, isOpen]);

  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }, [handleClose]);

  const handleSelectTheme = (paletteId: string, themeMode?: 'dark' | 'light') => {
    const nextMode = themeMode ?? currentMode;
    setLocalPalette(paletteId);
    if (themeMode) setLocalMode(themeMode);

    if (propOnSelectTheme) {
      propOnSelectTheme(paletteId, themeMode);
    } else {
      try {
        writeKitePref('palette', paletteId);
        if (themeMode) writeKitePref('theme', nextMode);
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
    setTelemetryPrefs((prev) => {
      const enabled = !prev[key];
      if (key === 'diagnostics') writeDiagnosticsEnabled(enabled);
      return { ...prev, [key]: enabled };
    });
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

  // Determine current display tab and metadata
  const currentTab =
    SETTINGS_TABS.find((t) => t.id === activeTab) || {
      id: activeTab,
      label: activeTab.charAt(0).toUpperCase() + activeTab.slice(1),
      blurb: 'Manage Kite settings and preferences.',
      icon: SettingsIcon,
    };

  const ActiveIcon = currentTab.icon;

  const dialogContent = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-heading"
      className={`settings-view${embedded ? '' : ' settings-modal-window'}`}
      data-palette={currentPalette}
      data-theme={currentMode}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Settings Rail Sidebar */}
      <aside className="SettingsSidebar sidebar--settings" data-testid="settings-sidebar">
        <section aria-labelledby="settings-heading" className="sidebar__primary">
          <div className="sidebar__section-heading">
            <h1 className="settings-rail__title" id="settings-heading">
              Settings
            </h1>
            <button
              className="settings-rail__back"
              onClick={handleClose}
              title="Close (Esc)"
              type="button"
              aria-label="Close settings"
            >
              <ChevronLeftIcon aria-hidden="true" size={12} strokeWidth={2.2} />
              Close
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
                    data-settings-nav={tab.id}
                    className={`sidebar-row settings-rail__row${isSelected ? ' sidebar-row--selected' : ''}`}
                    onClick={() => handleSelectTab(tab.id)}
                    onKeyDown={(event) => {
                      if (
                        event.key !== 'ArrowDown' &&
                        event.key !== 'ArrowUp' &&
                        event.key !== 'Home' &&
                        event.key !== 'End'
                      ) {
                        return;
                      }
                      event.preventDefault();
                      const index = SETTINGS_TABS.findIndex((item) => item.id === tab.id);
                      const nextIndex =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? SETTINGS_TABS.length - 1
                            : event.key === 'ArrowDown'
                              ? Math.min(index + 1, SETTINGS_TABS.length - 1)
                              : Math.max(index - 1, 0);
                      const next = SETTINGS_TABS[nextIndex];
                      if (!next || next.id === tab.id) return;
                      handleSelectTab(next.id);
                      const rail = event.currentTarget.closest('.settings-rail');
                      queueMicrotask(() => {
                        rail
                          ?.querySelector<HTMLButtonElement>(`[data-settings-nav="${next.id}"]`)
                          ?.focus();
                      });
                    }}
                    type="button"
                  >
                    {isSelected && (
                      <motion.span
                        layoutId="settings-rail-indicator"
                        className="settings-rail__indicator"
                        transition={springs.selection}
                        initial={false}
                        aria-hidden="true"
                      />
                    )}
                    <span className="settings-rail__glyph">
                      <TabIcon aria-hidden="true" size={14} strokeWidth={1.75} />
                    </span>
                    <span className="settings-rail__label">{tab.label}</span>
                  </button>
                </React.Fragment>
              );
            })}
          </nav>

          <footer className="settings-rail__footer">
            <span className="settings-rail__version">Kite {appVersion ? `v${appVersion}` : ''}</span>
          </footer>
        </section>
      </aside>

      {/* Main Settings Content Pane */}
      <section className="application-settings-pane" data-settings-tab={activeTab}>
        <div className="application-settings scroll-quiet">
          <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeTab}
            className={`application-settings__column${
              activeTab === 'plugins' ||
              activeTab === 'quotas' ||
              activeTab === 'zed' ||
              activeTab === 'customizations' ||
              activeTab === 'appearance'
                ? ' application-settings__column--wide'
                : ''
            }`}
            initial={{ opacity: 0, x: paneDirection * 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: paneDirection * -10 }}
            transition={tweens.panelIn}
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
              <button
                type="button"
                className="settings-modal-close"
                onClick={handleClose}
                aria-label="Cerrar modal de configuración"
                title="Cerrar (Esc)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                <kbd className="settings-modal-close__kbd">Esc</kbd>
              </button>
            </header>

            {activeTab === 'chat' && <ChatSettingsTab />}

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

            {activeTab === 'terminal' && <TerminalTab />}

            {activeTab === 'notifications' && <NotificationsTab />}

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


          </motion.div>
          </AnimatePresence>
        </div>
      </section>
    </div>
  );

  if (isOpen === false) {
    return null;
  }

  if (embedded) {
    return dialogContent;
  }

  const modalNode = (
    <div
      className="settings-modal-backdrop"
      data-palette={currentPalette}
      data-theme={currentMode}
      data-testid="settings-modal-backdrop"
      onClick={handleBackdropClick}
    >
      {dialogContent}
    </div>
  );

  if (typeof document !== 'undefined') {
    const portalTarget = document.querySelector('.app-frame--scaled') ?? document.body;
    return createPortal(modalNode, portalTarget);
  }

  return modalNode;
};

export const SettingsModal = SettingsView;
