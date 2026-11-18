import React, { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
import { springs, tweens } from '../../motion/standard/tokens';
import {
  ChevronLeftIcon,
  SettingsIcon,
  PaletteIcon,
  SquareTerminalIcon,
  BellIcon,
  MessageSquareIcon,
  MicIcon,
  AudioWaveformIcon,
  UsersIcon,
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
import { listAudioInputDevices } from '../../lib/operator/voice/zedVoice';
import { useFilesAutoSavePreference } from '../../lib/filesAutoSavePreference';
import { useAppUpdater } from '../../hooks/useAppUpdater';
import {
  DEFAULT_THEME_CUSTOMIZATIONS,
  applyThemeCustomizationsToDocument,
  isDarkThemeId,
  isLightThemeId,
  readThemeCustomizations,
  sanitizeThemeCustomizations,
  writeThemeCustomizations,
  type AppearanceMode,
  type KiteThemeCustomizations,
} from '../../lib/themeCustomizations';
import './settings.css';

const tabLoaders = {
  general: () => import('./settings/GeneralTab').then((m) => ({ default: m.GeneralTab })),
  chat: () => import('./settings/ChatSettingsTab').then((m) => ({ default: m.ChatSettingsTab })),
  subagents: () => import('./settings/SubagentsTab').then((m) => ({ default: m.SubagentsTab })),
  appearance: () => import('./settings/AppearanceTab').then((m) => ({ default: m.AppearanceTab })),
  voice: () => import('./settings/VoiceTab').then((m) => ({ default: m.VoiceTab })),
  keybindings: () => import('./settings/KeybindingsTab').then((m) => ({ default: m.KeybindingsTab })),
  about: () => import('./settings/AboutTab').then((m) => ({ default: m.AboutTab })),
  telemetry: () => import('./settings/TelemetryTab').then((m) => ({ default: m.TelemetryTab })),
  changelog: () => import('./settings/ChangelogTab').then((m) => ({ default: m.ChangelogTab })),
  quotas: () => import('./settings/QuotasTab').then((m) => ({ default: m.QuotasTab })),
  zed: () => import('./settings/ZedTab').then((m) => ({ default: m.ZedTab })),
  terminal: () => import('./settings/TerminalTab').then((m) => ({ default: m.TerminalTab })),
  notifications: () => import('./settings/NotificationsTab').then((m) => ({ default: m.NotificationsTab })),
  plugins: () => import('./PluginsView').then((m) => ({ default: m.PluginsView })),
  routines: () => import('./RoutinesView').then((m) => ({ default: m.RoutinesView })),
} as const;

type TabLoaderKey = keyof typeof tabLoaders;

const GeneralTab = lazy(tabLoaders.general);
const ChatSettingsTab = lazy(tabLoaders.chat);
const SubagentsTab = lazy(tabLoaders.subagents);
const AppearanceTab = lazy(tabLoaders.appearance);
const VoiceTab = lazy(tabLoaders.voice);
const KeybindingsTab = lazy(tabLoaders.keybindings);
const AboutTab = lazy(tabLoaders.about);
const TelemetryTab = lazy(tabLoaders.telemetry);
const ChangelogTab = lazy(tabLoaders.changelog);
const QuotasTab = lazy(tabLoaders.quotas);
const ZedTab = lazy(tabLoaders.zed);
const TerminalTab = lazy(tabLoaders.terminal);
const NotificationsTab = lazy(tabLoaders.notifications);
const PluginsView = lazy(tabLoaders.plugins);
const RoutinesView = lazy(tabLoaders.routines);

const prefetchedTabs = new Set<TabLoaderKey>();

function resolveTabLoaderKey(tabId: SettingsTabId | string): TabLoaderKey | null {
  if (tabId === 'customizations') return 'appearance';
  if (tabId === 'dictation') return 'voice';
  if (tabId === 'integrations') return 'plugins';
  return tabId in tabLoaders ? (tabId as TabLoaderKey) : null;
}

function prefetchTab(tabId: SettingsTabId): void {
  const key = resolveTabLoaderKey(tabId);
  if (!key || prefetchedTabs.has(key)) return;
  prefetchedTabs.add(key);
  void tabLoaders[key]().catch(() => {
    prefetchedTabs.delete(key);
  });
}

const DEFAULT_DICTATION_AVAILABILITY: DictationAvailability = {
  state: 'unavailable',
  canRequestPermission: false,
  canStart: false,
  guidance: 'No hay ningún motor de transcripción local instalado y listo.',
  localEngines: [],
};

const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  schemaVersion: 1,
  mode: 'local',
  localEngine: null,
  language: 'auto',
  deviceId: null,
  cuesEnabled: true,
  shortcut: { kind: 'standard' },
};

interface DictationCacheState {
  loaded: boolean;
  availability: DictationAvailability;
  settings: DictationSettings;
  devices: DictationInputDevice[];
}

let dictationCache: DictationCacheState = {
  loaded: false,
  availability: DEFAULT_DICTATION_AVAILABILITY,
  settings: DEFAULT_DICTATION_SETTINGS,
  devices: [],
};

let dictationLoadInFlight: Promise<DictationCacheState> | null = null;

/** Clears cached dictation state so tests or callers can force fresh Voice IPC discovery. */
export function resetSettingsDictationCache(): void {
  dictationCache = {
    loaded: false,
    availability: DEFAULT_DICTATION_AVAILABILITY,
    settings: DEFAULT_DICTATION_SETTINGS,
    devices: [],
  };
  dictationLoadInFlight = null;
}

async function loadDictationSnapshot(): Promise<DictationCacheState> {
  if (dictationCache.loaded) return dictationCache;
  if (dictationLoadInFlight) return dictationLoadInFlight;

  dictationLoadInFlight = (async () => {
    let nextAvailability = dictationCache.availability;
    let nextSettings = dictationCache.settings;
    let nextDevices = dictationCache.devices;

    const [availRes, settingsRes, devicesRes] = await Promise.allSettled([
      invokeCommand<DictationAvailability>('read_dictation_availability', {
        supportedSchemaVersion: 1,
      }),
      invokeCommand<DictationSettings>('read_dictation_settings', {
        supportedSchemaVersion: 1,
      }),
      invokeCommand<DictationDeviceList>('list_dictation_input_devices', {
        supportedSchemaVersion: 1,
      }),
    ]);

    if (availRes.status === 'fulfilled' && availRes.value) {
      nextAvailability = availRes.value;
    } else if (availRes.status === 'rejected') {
      console.warn('[SettingsView] Error reading dictation availability:', availRes.reason);
    }

    if (settingsRes.status === 'fulfilled' && settingsRes.value) {
      nextSettings = settingsRes.value;
    } else if (settingsRes.status === 'rejected') {
      console.warn('[SettingsView] Error reading dictation settings:', settingsRes.reason);
    }

    if (
      devicesRes.status === 'fulfilled' &&
      devicesRes.value &&
      devicesRes.value.devices &&
      devicesRes.value.devices.length > 0
    ) {
      nextDevices = devicesRes.value.devices;
      if (devicesRes.value.selectedId) {
        nextSettings = { ...nextSettings, deviceId: devicesRes.value.selectedId };
      }
    } else if (devicesRes.status === 'rejected') {
      console.warn('[SettingsView] Error listing dictation devices:', devicesRes.reason);
    } else {
      try {
        const browserDevices = await listAudioInputDevices();
        if (browserDevices.length > 0) {
          nextDevices = browserDevices.map((d) => ({
            id: d.deviceId,
            name: d.label,
            isBluetooth: /bluetooth/i.test(d.label),
          }));
          const savedMic = localStorage.getItem('kite_selected_mic_device_id');
          if (savedMic && savedMic !== 'automatic') {
            nextSettings = { ...nextSettings, deviceId: savedMic };
          }
        }
      } catch (err) {
        console.warn('[SettingsView] Error listing dictation devices:', err);
      }
    }

    dictationCache = {
      loaded: true,
      availability: nextAvailability,
      settings: nextSettings,
      devices: nextDevices,
    };
    return dictationCache;
  })().finally(() => {
    dictationLoadInFlight = null;
  });

  return dictationLoadInFlight;
}

const SettingsTabFallback: React.FC = () => (
  <div
    className="settings-tab-fallback"
    role="status"
    aria-busy="true"
    aria-label="Cargando sección de configuración"
  >
    <div className="settings-tab-fallback__card" aria-hidden="true">
      <span className="settings-tab-fallback__line settings-tab-fallback__line--title" />
      <span className="settings-tab-fallback__line" />
      <span className="settings-tab-fallback__line settings-tab-fallback__line--short" />
    </div>
  </div>
);

const SETTINGS_TABS: SettingsTabConfig[] = [
  { id: 'general', label: 'General', blurb: 'Apariencia, autoguardado y actualizaciones de software.', icon: SettingsIcon },
  {
    id: 'customizations',
    label: 'Personalización',
    blurb: 'Temas visuales, fondos de escenario, figuras, vidrio esmerilado e importar/exportar.',
    icon: PaletteIcon,
  },
  { id: 'terminal', label: 'Terminal', blurb: 'Apariencia, tipografía, motor de renderizado, shell y enlaces web.', icon: SquareTerminalIcon },
  { id: 'notifications', label: 'Notificaciones', blurb: 'Avisos y alertas sonoras de agentes.', icon: BellIcon },
  { id: 'chat', label: 'Chat', blurb: 'Visibilidad de las acciones del hilo.', icon: MessageSquareIcon },
  {
    id: 'subagents',
    label: 'Subagentes',
    blurb: 'Stack de modelos, modelo de delegación por defecto, política de cambios y perfiles de rol.',
    icon: UsersIcon,
  },
  { id: 'voice', label: 'Voz y Dictado', blurb: 'Dictado por voz, micrófono y transcripción.', icon: MicIcon, hasDividerBefore: true },
  { id: 'zed', label: 'Asistente Zed', blurb: 'Personalidad de Zed, síntesis de voz, pasarela multi-modelo, latencia y memoria.', icon: AudioWaveformIcon },
  { id: 'quotas', label: 'Cuentas y Proveedores', blurb: 'Bóveda de credenciales, cuentas CLI y límites de cuota.', icon: GaugeIcon },
  { id: 'plugins', label: 'Plugins', blurb: 'Herramientas y servicios para los agentes.', icon: PuzzleIcon },
  { id: 'keybindings', label: 'Atajos', blurb: 'Atajos de teclado y comandos rápidos.', icon: SquareTerminalIcon },
  { id: 'changelog', label: 'Novedades', blurb: 'Novedades y notas de cada versión.', icon: ScrollTextIcon, hasDividerBefore: true },
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
  appearanceMode?: AppearanceMode;
  palette?: string;
  customizations?: KiteThemeCustomizations;
  onToggleMode?: (newMode: AppearanceMode) => void;
  onSelectTheme?: (paletteId: string, themeMode?: 'dark' | 'light') => void;
  onUpdateCustomizations?: (patch: Partial<KiteThemeCustomizations>) => void;
  onResetThemeOverrides?: () => void;
  onResetAllCustomizations?: () => void;
  embedded?: boolean;
  initialTab?: SettingsTabId | null;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  isOpen,
  onClose,
  onBack,
  onOpenWhatsNew,
  mode: propMode,
  appearanceMode: propAppearanceMode,
  palette: propPalette,
  customizations: propCustomizations,
  onToggleMode: propOnToggleMode,
  onSelectTheme: propOnSelectTheme,
  onUpdateCustomizations: propOnUpdateCustomizations,
  onResetThemeOverrides: propOnResetThemeOverrides,
  onResetAllCustomizations: propOnResetAllCustomizations,
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
  const reduceMotion = useReducedMotion();
  const [localCustomizations, setLocalCustomizations] = useState<KiteThemeCustomizations>(() =>
    readThemeCustomizations()
  );
  const [localMode, setLocalMode] = useState<'dark' | 'light'>('dark');
  const [localPalette, setLocalPalette] = useState<string>('kite-dark');

  const currentCustomizations = propCustomizations ?? localCustomizations;
  const currentAppearanceMode = propAppearanceMode ?? currentCustomizations.appearanceMode;
  const currentMode = propMode ?? localMode;
  const currentPalette = propPalette ?? localPalette;

  useEffect(() => {
    if (propCustomizations) setLocalCustomizations(propCustomizations);
  }, [propCustomizations]);

  useEffect(() => {
    if (propMode) setLocalMode(propMode);
  }, [propMode]);

  useEffect(() => {
    if (propPalette) setLocalPalette(propPalette);
  }, [propPalette]);

  useEffect(() => {
    const handleThemeEvent = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          theme?: 'dark' | 'light';
          palette?: string;
          customizations?: KiteThemeCustomizations;
        }>
      ).detail;
      if (detail?.theme) setLocalMode(detail.theme);
      if (detail?.palette) setLocalPalette(detail.palette);
      if (detail?.customizations) setLocalCustomizations(detail.customizations);
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

  // Voice & Dictation IPC state (initialized from module cache when previously loaded)
  const [dictationAvailability, setDictationAvailability] = useState<DictationAvailability>(
    () => dictationCache.availability
  );
  const [dictationSettings, setDictationSettings] = useState<DictationSettings>(
    () => dictationCache.settings
  );
  const [dictationDevices, setDictationDevices] = useState<DictationInputDevice[]>(
    () => dictationCache.devices
  );

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Load preferences from localStorage and register navigation listener on mount
  useEffect(() => {
    try {
      const savedPalette = readKitePref('palette');
      if (savedPalette) setLocalPalette(savedPalette);

      const savedTheme = readKitePref('theme') as 'dark' | 'light' | null;
      if (savedTheme === 'dark' || savedTheme === 'light') setLocalMode(savedTheme);

      readShowPaneContext();
      if (!initialTab) {
        const savedTabRaw = readKitePref('settingsTab');
        const savedTab = normalizeLegacySettingsTabId(savedTabRaw);
        if (savedTab && savedTab !== savedTabRaw) writeKitePref('settingsTab', savedTab);
        if (savedTab && SETTINGS_TABS.some((t) => t.id === savedTab)) {
          setActiveTab(savedTab as SettingsTabId);
        }
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

    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenTab);
    };
  }, [initialTab]);

  // Defer Voice/Dictation IPC discovery strictly until the modal is open on the Voice tab
  const isVoiceTab = activeTab === 'voice' || (activeTab as string) === 'dictation';
  useEffect(() => {
    if (isOpen === false || !isVoiceTab) return;

    if (dictationCache.loaded) {
      setDictationAvailability(dictationCache.availability);
      setDictationSettings(dictationCache.settings);
      setDictationDevices(dictationCache.devices);
      return;
    }

    let isMounted = true;
    void loadDictationSnapshot().then((snapshot) => {
      if (!isMounted) return;
      setDictationAvailability(snapshot.availability);
      setDictationSettings(snapshot.settings);
      setDictationDevices(snapshot.devices);
    });

    return () => {
      isMounted = false;
    };
  }, [isOpen, isVoiceTab]);

  const handleSelectTab = useCallback((tabId: SettingsTabId) => {
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

  const commitLocalCustomizations = useCallback((nextRaw: KiteThemeCustomizations) => {
    const sanitized = sanitizeThemeCustomizations(nextRaw);
    setLocalCustomizations(sanitized);
    writeThemeCustomizations(sanitized);
    const applied = applyThemeCustomizationsToDocument(sanitized);
    setLocalMode(applied.resolvedMode);
    setLocalPalette(applied.activePalette);
    window.dispatchEvent(
      new CustomEvent('kite:theme-changed', {
        detail: {
          theme: applied.resolvedMode,
          palette: applied.activePalette,
          appearanceMode: sanitized.appearanceMode,
          customizations: sanitized,
        },
      })
    );
  }, []);

  const handleSelectTheme = (paletteId: string, themeMode?: 'dark' | 'light') => {
    if (propOnSelectTheme) {
      propOnSelectTheme(paletteId, themeMode);
    } else {
      const inferredMode =
        themeMode ??
        (isLightThemeId(paletteId)
          ? 'light'
          : isDarkThemeId(paletteId)
            ? 'dark'
            : currentMode);
      commitLocalCustomizations({
        ...currentCustomizations,
        appearanceMode: inferredMode,
        darkThemeId: inferredMode === 'dark' ? paletteId : currentCustomizations.darkThemeId,
        lightThemeId: inferredMode === 'light' ? paletteId : currentCustomizations.lightThemeId,
      });
    }
  };

  const handleToggleMode = (newMode: AppearanceMode) => {
    if (propOnToggleMode) {
      propOnToggleMode(newMode);
    } else {
      commitLocalCustomizations({
        ...currentCustomizations,
        appearanceMode: newMode,
      });
    }
  };

  const handleUpdateCustomizations = (patch: Partial<KiteThemeCustomizations>) => {
    if (propOnUpdateCustomizations) {
      propOnUpdateCustomizations(patch);
    } else {
      commitLocalCustomizations({
        ...currentCustomizations,
        ...patch,
        backdrop: patch.backdrop
          ? { ...currentCustomizations.backdrop, ...patch.backdrop }
          : currentCustomizations.backdrop,
        figure: patch.figure
          ? { ...currentCustomizations.figure, ...patch.figure }
          : currentCustomizations.figure,
        surface: patch.surface
          ? { ...currentCustomizations.surface, ...patch.surface }
          : currentCustomizations.surface,
        overrides: patch.overrides
          ? { ...currentCustomizations.overrides, ...patch.overrides }
          : currentCustomizations.overrides,
      });
    }
  };

  const handleResetThemeOverrides = () => {
    if (propOnResetThemeOverrides) {
      propOnResetThemeOverrides();
    } else {
      commitLocalCustomizations({
        ...currentCustomizations,
        overrides: { ...DEFAULT_THEME_CUSTOMIZATIONS.overrides },
      });
    }
  };

  const handleResetAllCustomizations = () => {
    if (propOnResetAllCustomizations) {
      propOnResetAllCustomizations();
    } else {
      commitLocalCustomizations({ ...DEFAULT_THEME_CUSTOMIZATIONS });
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
    dictationCache = { ...dictationCache, settings: next };
    try {
      const updated = await invokeCommand<DictationSettings>('update_dictation_settings', {
        supportedSchemaVersion: 1,
        settings: next,
      });
      if (updated) {
        setDictationSettings(updated);
        dictationCache = { ...dictationCache, settings: updated };
      }
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
        dictationCache = { ...dictationCache, devices: devices.devices };
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
      if (avail) {
        setDictationAvailability(avail);
        dictationCache = { ...dictationCache, availability: avail };
      }
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
      if (avail) {
        setDictationAvailability(avail);
        dictationCache = { ...dictationCache, availability: avail };
      }
    } catch (err) {
      console.warn('[SettingsView] Failed to request microphone permission:', err);
    }
  };

  if (isOpen === false) {
    return null;
  }

  // Determine current display tab and metadata
  const currentTab =
    SETTINGS_TABS.find((t) => t.id === activeTab) || {
      id: activeTab,
      label: activeTab.charAt(0).toUpperCase() + activeTab.slice(1),
      blurb: 'Administra la configuración y preferencias de Kite.',
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
              Configuración
            </h1>
            <button
              className="settings-rail__back"
              onClick={handleClose}
              title="Cerrar (Esc)"
              type="button"
              aria-label="Cerrar configuración"
            >
              <ChevronLeftIcon aria-hidden="true" size={12} strokeWidth={2.2} />
              Cerrar
            </button>
          </div>

          <nav aria-label="Secciones de configuración" className="sidebar__list settings-rail">
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
                    onMouseEnter={() => prefetchTab(tab.id)}
                    onFocus={() => prefetchTab(tab.id)}
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
          <div
            className={`application-settings__column${
              activeTab === 'plugins' ||
              activeTab === 'quotas' ||
              activeTab === 'zed' ||
              activeTab === 'customizations' ||
              activeTab === 'appearance'
                ? ' application-settings__column--wide'
                : ''
            }`}
          >
            {/* Header stays synchronous across tab switches */}
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

            <Suspense fallback={<SettingsTabFallback />}>
              <motion.div
                key={activeTab}
                className="application-settings__tab-body"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={reduceMotion ? tweens.instant : tweens.fade}
              >
                {activeTab === 'chat' && <ChatSettingsTab />}

                {activeTab === 'subagents' && <SubagentsTab />}

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
                    appearanceMode={currentAppearanceMode}
                    customizations={currentCustomizations}
                    mode={currentMode}
                    onResetAllCustomizations={handleResetAllCustomizations}
                    onResetThemeOverrides={handleResetThemeOverrides}
                    onSelectTheme={handleSelectTheme}
                    onToggleMode={handleToggleMode}
                    onUpdateCustomizations={handleUpdateCustomizations}
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
            </Suspense>
          </div>
        </div>
      </section>
    </div>
  );

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
