import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { springs, tweens } from '../../../motion/standard/tokens';
import { ttsNarrator, getAvailableVoices } from '../../../lib/operator/ttsNarrator';
import { toast } from '../../../lib/toast';
import {
  OperatorConfig,
  OperatorProviderId,
  OPENCODE_MODEL_CATALOG,
  DEFAULT_ARGOS_PERSONA,
  ArgosPersonaConfig,
  ArgosMemoryNote,
  OPERATOR_CONFIG_DEBOUNCE_MS,
  applyOperatorConfigPatch,
  flushOperatorConfigSave,
  loadOperatorConfig,
  saveOperatorConfig,
  saveOperatorConfigDebounced,
  syncNativeCredentialsWithVault,
  loadLatencyRecords,
  saveLatencyRecords,
  computeLatencySummaries,
  recordProviderLatency,
  buildArgosOpeningPreview,
  loadArgosMemoryNotes,
  saveArgosMemoryNotes,
  loadModelCatalog,
  fetchOpenCodeGoModels,
  VERCEL_MODEL_CATALOG,
  fetchVercelModels,
  CLOUDFLARE_MODEL_CATALOG,
  fetchCloudflareModels,
  ANTIGRAVITY_MODEL_CATALOG,
  fetchAntigravityModels,
} from '../../../lib/operator/operatorConfig';
import { probeProviderLatency } from '../../../lib/operator/operatorProviders';
import { invokeCommand, isTauriEnvironment } from '../../../lib/ipc';
import {
  DEFAULT_COMPANION_GLOBAL_SHORTCUT,
  loadCompanionGlobalShortcut,
  registerOsCompanionGlobalShortcut,
  type CompanionShortcutRegistrationStatus,
} from '../../../lib/operator/voice/companionTransfer';

import { ArgosHeroCard } from './argos/ArgosHeroCard';
import { ArgosProvidersSection } from './argos/ArgosProvidersSection';
import { ArgosLatencySection } from './argos/ArgosLatencySection';
import { ArgosAudioSection } from './argos/ArgosAudioSection';
import { ArgosPersonaSection } from './argos/ArgosPersonaSection';
import { ArgosMemorySection } from './argos/ArgosMemorySection';
import { BrainIcon, CircleUserRoundIcon, GaugeIcon, GlobeIcon, MicIcon } from './icons';

const DEBOUNCED_CONFIG_KEYS = new Set<keyof OperatorConfig>([
  'opencodeApiKey',
  'opencodeBaseUrl',
  'opencodeModel',
  'vercelApiKey',
  'vercelBaseUrl',
  'vercelModel',
  'cloudflareAccountId',
  'cloudflareApiToken',
  'cloudflareGatewaySlug',
  'cloudflareBaseUrl',
  'cloudflareModel',
  'antigravityModel',
  'antigravityCommand',
  'grokApiKey',
  'grokModel',
  'grokTranscriptionApiKey',
  'grokTranscriptionBaseUrl',
  'grokTranscriptionModel',
  'elevenlabsApiKey',
  'elevenlabsVoiceId',
]);

const DEBOUNCED_PERSONA_KEYS = new Set<keyof ArgosPersonaConfig>([
  'name',
  'builderCallMe',
  'standingInstructions',
]);

type ArgosSectionId = 'provider' | 'latency' | 'voice' | 'persona' | 'memory';

const ARGOS_SECTIONS: { id: ArgosSectionId; label: string; icon: React.ReactNode }[] = [
  {
    id: 'provider',
    label: 'Proveedor',
    icon: (
      <span aria-hidden="true">
        <GlobeIcon size={14} />
      </span>
    ),
  },
  {
    id: 'latency',
    label: 'Latencia',
    icon: (
      <span aria-hidden="true">
        <GaugeIcon size={14} />
      </span>
    ),
  },
  {
    id: 'voice',
    label: 'Voz',
    icon: (
      <span aria-hidden="true">
        <MicIcon size={14} />
      </span>
    ),
  },
  {
    id: 'persona',
    label: 'Persona',
    icon: (
      <span aria-hidden="true">
        <CircleUserRoundIcon size={14} />
      </span>
    ),
  },
  {
    id: 'memory',
    label: 'Memoria',
    icon: (
      <span aria-hidden="true">
        <BrainIcon size={14} />
      </span>
    ),
  },
];

export const ArgosTab: React.FC = () => {
  const [section, setSection] = useState<ArgosSectionId>('provider');
  const [config, setConfig] = useState<OperatorConfig>(() => loadOperatorConfig());
  const [records, setRecords] = useState(() => loadLatencyRecords());
  const [memoryNotes, setMemoryNotes] = useState<ArgosMemoryNote[]>(() => loadArgosMemoryNotes());
  const [newNoteText, setNewNoteText] = useState('');
  const [testingProvider, setTestingProvider] = useState<OperatorProviderId | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [openCodeGoCredential, setOpenCodeGoCredential] = useState<{
    available: boolean;
    source: string | null;
  } | null>(null);
  const [showApiKeys, setShowApiKeys] = useState<Record<string, boolean>>({});
  const [savedToast, setSavedToast] = useState(false);
  const [modelsList, setModelsList] = useState(
    () => loadModelCatalog('opencode')?.models ?? OPENCODE_MODEL_CATALOG
  );
  const [openCodeSavedAt, setOpenCodeSavedAt] = useState<string | null>(
    () => loadModelCatalog('opencode')?.savedAt ?? null
  );
  const [syncingModels, setSyncingModels] = useState(false);
  const [vercelModelsList, setVercelModelsList] = useState(
    () => loadModelCatalog('vercel')?.models ?? VERCEL_MODEL_CATALOG
  );
  const [vercelSavedAt, setVercelSavedAt] = useState<string | null>(
    () => loadModelCatalog('vercel')?.savedAt ?? null
  );
  const [syncingVercelModels, setSyncingVercelModels] = useState(false);
  const [cloudflareModelsList, setCloudflareModelsList] = useState(
    () => loadModelCatalog('cloudflare')?.models ?? CLOUDFLARE_MODEL_CATALOG
  );
  const [cloudflareSavedAt, setCloudflareSavedAt] = useState<string | null>(
    () => loadModelCatalog('cloudflare')?.savedAt ?? null
  );
  const [syncingCloudflareModels, setSyncingCloudflareModels] = useState(false);
  const [antigravityModelsList, setAntigravityModelsList] = useState(
    () => loadModelCatalog('antigravity')?.models ?? ANTIGRAVITY_MODEL_CATALOG
  );
  const [antigravitySavedAt, setAntigravitySavedAt] = useState<string | null>(
    () => loadModelCatalog('antigravity')?.savedAt ?? null
  );
  const [syncingAntigravityModels, setSyncingAntigravityModels] = useState(false);

  // Voice synthesis states
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [testingVoice, setTestingVoice] = useState(false);

  // OS Global Companion Shortcut state (S8)
  const [companionShortcut, setCompanionShortcut] = useState<string>(() =>
    loadCompanionGlobalShortcut()
  );
  const [companionShortcutStatus, setCompanionShortcutStatus] =
    useState<CompanionShortcutRegistrationStatus | null>(null);

  const isMountedRef = useRef(true);
  const savedToastTimerRef = useRef<number | null>(null);

  const persona: ArgosPersonaConfig = config.persona ?? DEFAULT_ARGOS_PERSONA;

  const effectiveOpenCodeModels = useMemo(() => {
    if (!config.opencodeModel) return modelsList;
    const exists = modelsList.some((m) => m.id === config.opencodeModel);
    if (exists) return modelsList;
    return [
      {
        id: config.opencodeModel,
        label: config.opencodeModel,
        tier: 'Activo',
        badge: 'Activo',
        description: 'Modelo configurado',
      },
      ...modelsList,
    ];
  }, [modelsList, config.opencodeModel]);

  const effectiveVercelModels = useMemo(() => {
    if (!config.vercelModel) return vercelModelsList;
    const exists = vercelModelsList.some((m) => m.id === config.vercelModel);
    if (exists) return vercelModelsList;
    return [
      {
        id: config.vercelModel,
        label: config.vercelModel,
        tier: 'Activo',
        badge: 'Activo',
        description: 'Modelo configurado',
      },
      ...vercelModelsList,
    ];
  }, [vercelModelsList, config.vercelModel]);

  const effectiveCloudflareModels = useMemo(() => {
    const custom = config.cloudflareModel?.trim();
    if (!custom) return cloudflareModelsList;
    if (cloudflareModelsList.some((m) => m.id === custom)) {
      return cloudflareModelsList;
    }
    return [
      {
        id: custom,
        label: `${custom} (personalizado)`,
        badge: 'Custom',
        tier: 'Cloudflare Custom',
        description: 'Modelo especificado manualmente.',
      },
      ...cloudflareModelsList,
    ];
  }, [config.cloudflareModel, cloudflareModelsList]);

  const effectiveAntigravityModels = useMemo(() => {
    const custom = config.antigravityModel?.trim();
    if (!custom) return antigravityModelsList;
    if (antigravityModelsList.some((m) => m.id === custom)) {
      return antigravityModelsList;
    }
    return [
      {
        id: custom,
        label: `${custom} (personalizado)`,
        badge: 'Custom',
        tier: 'Antigravity Custom',
        description: 'Modelo especificado manualmente.',
      },
      ...antigravityModelsList,
    ];
  }, [config.antigravityModel, antigravityModelsList]);

  useEffect(() => {
    isMountedRef.current = true;
    let isMounted = true;

    void syncNativeCredentialsWithVault()
      .then((synced) => {
        if (!isMounted) return;
        setConfig((prev) => (JSON.stringify(prev) === JSON.stringify(synced) ? prev : synced));
      })
      .catch(() => {});

    const handleConfigUpdated = (event: Event) => {
      if (!isMounted) return;
      const detail = (event as CustomEvent<OperatorConfig>)?.detail;
      if (detail && typeof detail === 'object') {
        setConfig((prev) =>
          JSON.stringify(prev) === JSON.stringify(detail) ? prev : detail
        );
        return;
      }
      setConfig((prev) => {
        const loaded = loadOperatorConfig();
        return JSON.stringify(prev) === JSON.stringify(loaded) ? prev : loaded;
      });
    };
    window.addEventListener('kite:operator-config-updated', handleConfigUpdated);

    if (isTauriEnvironment()) {
      invokeCommand<{ available: boolean; source: string | null }>(
        'opencode_go_credential_status'
      )
        .then((status) => {
          if (isMounted) setOpenCodeGoCredential(status);
        })
        .catch(() => {
          if (isMounted) setOpenCodeGoCredential({ available: false, source: null });
        });

      void fetchAntigravityModels(false)
        .then((fetched) => {
          if (!isMounted) return;
          setAntigravityModelsList(fetched.models);
          setAntigravitySavedAt(fetched.savedAt);
        })
        .catch(() => {});
    }
    const loadVoices = async () => {
      try {
        const getVoicesFn =
          typeof ttsNarrator?.getAvailableVoices === 'function'
            ? ttsNarrator.getAvailableVoices.bind(ttsNarrator)
            : getAvailableVoices;
        if (typeof getVoicesFn === 'function') {
          const voices = await getVoicesFn();
          if (isMounted && Array.isArray(voices) && voices.length > 0) {
            setSystemVoices(voices);
          }
        }
      } catch {
        // Ignored in non-browser or test environments
      }
    };
    void loadVoices();

    return () => {
      isMounted = false;
      isMountedRef.current = false;
      flushOperatorConfigSave();
      if (savedToastTimerRef.current !== null) {
        window.clearTimeout(savedToastTimerRef.current);
        savedToastTimerRef.current = null;
      }
      window.removeEventListener('kite:operator-config-updated', handleConfigUpdated);
      if (ttsNarrator && typeof ttsNarrator.stop === 'function') {
        ttsNarrator.stop();
      }
    };
  }, []);

  const handleTestVoice = async () => {
    if (testingVoice) {
      if (ttsNarrator && typeof ttsNarrator.stop === 'function') {
        ttsNarrator.stop();
      }
      setTestingVoice(false);
      return;
    }
    setTestingVoice(true);
    try {
      const sampleText = `Hola, soy ${persona.name || 'Argos'}. Tu asistente está listo para ayudarte con tus tareas y terminales.`;
      if (ttsNarrator && typeof ttsNarrator.speak === 'function') {
        await ttsNarrator.speak(sampleText, {
          voiceName: persona.voice,
          rate: config.ttsRate || 1.0,
          lang: persona.language === 'en' ? 'en-US' : 'es-ES',
          engine: config.ttsEngine,
          elevenlabsApiKey: config.elevenlabsApiKey,
          elevenlabsModel: config.elevenlabsModel,
          elevenlabsVoiceId: config.elevenlabsVoiceId,
          elevenlabsStability: config.elevenlabsStability,
          elevenlabsSimilarity: config.elevenlabsSimilarity,
          onEnd: () => setTestingVoice(false),
          onError: () => {
            setTestingVoice(false);
            toast.error('Prueba de voz fallida', 'Verifica la clave de ElevenLabs o el dispositivo de audio.');
          },
        });
      } else {
        setTestingVoice(false);
      }
    } catch {
      setTestingVoice(false);
    }
  };

  const showSavedToast = useCallback(() => {
    setSavedToast(true);
    if (savedToastTimerRef.current !== null) {
      window.clearTimeout(savedToastTimerRef.current);
    }
    savedToastTimerRef.current = window.setTimeout(() => {
      savedToastTimerRef.current = null;
      if (isMountedRef.current) {
        setSavedToast(false);
      }
    }, 1800);
  }, []);

  const persistConfig = (next: Partial<OperatorConfig>) => {
    const saved = saveOperatorConfig(next);
    setConfig(saved);
    showSavedToast();
  };

  const persistConfigDebounced = (patch: Parameters<typeof saveOperatorConfigDebounced>[0]) => {
    setConfig((prev) => applyOperatorConfigPatch(prev, patch));
    saveOperatorConfigDebounced(patch, OPERATOR_CONFIG_DEBOUNCE_MS, () => {
      if (isMountedRef.current) {
        showSavedToast();
      }
    });
  };

  const handleFieldChange = <K extends keyof OperatorConfig>(key: K, value: OperatorConfig[K]) => {
    if (DEBOUNCED_CONFIG_KEYS.has(key)) {
      persistConfigDebounced({ [key]: value });
      return;
    }
    persistConfig({ [key]: value });
  };

  const handlePersonaChange = <K extends keyof ArgosPersonaConfig>(
    key: K,
    value: ArgosPersonaConfig[K]
  ) => {
    if (DEBOUNCED_PERSONA_KEYS.has(key)) {
      persistConfigDebounced({ persona: { [key]: value } });
      return;
    }
    persistConfig({
      persona: {
        ...persona,
        [key]: value,
      },
    });
  };

  const handleRunProbe = async (providerId: OperatorProviderId) => {
    setTestingProvider(providerId);
    setTestMessage(null);
    const res = await probeProviderLatency(providerId, config);
    recordProviderLatency({
      providerId,
      taskType: 'intent-parse',
      latencyMs: res.latencyMs,
      ok: res.ok,
      modelLabel: res.modelLabel,
    });
    setRecords(loadLatencyRecords());
    setTestingProvider(null);
    setTestMessage(
      `${providerId.toUpperCase()} (${res.modelLabel}): ${res.latencyMs}ms — ${res.detail}`
    );
  };

  const handleSyncModels = async () => {
    setSyncingModels(true);
    setTestMessage(null);
    try {
      const fetched = await fetchOpenCodeGoModels(config.opencodeApiKey);
      setModelsList(fetched.models);
      setOpenCodeSavedAt(fetched.savedAt);
      setTestMessage(
        fetched.fresh
          ? `Lista actualizada: ${fetched.models.length} modelos de OpenCode Go. Queda guardada hasta que vuelvas a actualizar.`
          : fetched.detail
      );
    } catch (err: any) {
      setTestMessage(`Error al sincronizar modelos: ${err?.message ?? String(err)}`);
    } finally {
      setSyncingModels(false);
    }
  };

  const handleSyncVercelModels = async () => {
    setSyncingVercelModels(true);
    setTestMessage(null);
    try {
      const fetched = await fetchVercelModels(config.vercelApiKey, config.vercelBaseUrl);
      setVercelModelsList(fetched.models);
      setVercelSavedAt(fetched.savedAt);
      setTestMessage(
        fetched.fresh
          ? `Lista actualizada: ${fetched.models.length} modelos de Vercel. Queda guardada hasta que vuelvas a actualizar.`
          : fetched.detail
      );
    } catch (err: any) {
      setTestMessage(`Error al sincronizar modelos de Vercel: ${err?.message ?? String(err)}`);
    } finally {
      setSyncingVercelModels(false);
    }
  };

  const handleSyncCloudflareModels = async () => {
    setSyncingCloudflareModels(true);
    setTestMessage(null);
    try {
      const fetched = await fetchCloudflareModels(
        config.cloudflareApiToken,
        config.cloudflareAccountId,
        config.cloudflareBaseUrl
      );
      setCloudflareModelsList(fetched.models);
      setCloudflareSavedAt(fetched.savedAt);
      setTestMessage(
        fetched.fresh
          ? `Lista actualizada: ${fetched.models.length} modelos de Cloudflare Workers AI. Queda guardada hasta que vuelvas a actualizar.`
          : fetched.detail
      );
    } catch (err: any) {
      setTestMessage(`Error al sincronizar modelos de Cloudflare: ${err?.message ?? String(err)}`);
    } finally {
      setSyncingCloudflareModels(false);
    }
  };

  const handleSyncAntigravityModels = async () => {
    setSyncingAntigravityModels(true);
    setTestMessage(null);
    try {
      const fetched = await fetchAntigravityModels(true);
      setAntigravityModelsList(fetched.models);
      setAntigravitySavedAt(fetched.savedAt);
      setTestMessage(
        fetched.fresh
          ? `Lista actualizada: ${fetched.models.length} modelos de tu suscripción Antigravity. Queda guardada hasta que vuelvas a actualizar.`
          : fetched.detail
      );
    } catch (err: any) {
      setTestMessage(`Error al sincronizar modelos de Antigravity: ${err?.message ?? String(err)}`);
    } finally {
      setSyncingAntigravityModels(false);
    }
  };

  const handleClearMetrics = () => {
    saveLatencyRecords([]);
    setRecords([]);
    setTestMessage('Historial de latencia reiniciado.');
  };

  const handleAddMemoryNote = () => {
    const trimmed = newNoteText.trim();
    if (!trimmed) return;
    const next: ArgosMemoryNote[] = [
      {
        id: `mem-${Date.now().toString(36)}`,
        content: trimmed,
        createdAt: new Date().toISOString(),
      },
      ...memoryNotes,
    ];
    setMemoryNotes(next);
    saveArgosMemoryNotes(next);
    setNewNoteText('');
  };

  const handleDeleteMemoryNote = (id: string) => {
    const next = memoryNotes.filter((n) => n.id !== id);
    setMemoryNotes(next);
    saveArgosMemoryNotes(next);
  };

  const handleSaveCompanionShortcut = async (nextShortcut?: string) => {
    const target = (nextShortcut ?? companionShortcut).trim() || DEFAULT_COMPANION_GLOBAL_SHORTCUT;
    setCompanionShortcut(target);
    const status = await registerOsCompanionGlobalShortcut(target);
    setCompanionShortcutStatus(status);
    if (status.error) {
      toast.error('No se pudo registrar el atajo global en el SO', status.error);
    } else {
      toast.success(
        status.registered
          ? `Atajo global "${status.shortcut}" registrado`
          : `Atajo "${status.shortcut}" guardado (modo ventana local)`
      );
    }
  };

  const summaries = computeLatencySummaries(records);
  const openingPreview = buildArgosOpeningPreview(persona);

  const providerSection = (
    <ArgosProvidersSection
      config={config}
      onFieldChange={handleFieldChange}
      onPersistConfig={persistConfig}
      showApiKeys={showApiKeys}
      onToggleApiKey={(provider) =>
        setShowApiKeys((prev) => ({ ...prev, [provider]: !prev[provider] }))
      }
      testingProvider={testingProvider}
      onRunProbe={handleRunProbe}
      openCodeGoCredential={openCodeGoCredential}
      effectiveOpenCodeModels={effectiveOpenCodeModels}
      syncingModels={syncingModels}
      openCodeSavedAt={openCodeSavedAt}
      onSyncModels={handleSyncModels}
      effectiveVercelModels={effectiveVercelModels}
      syncingVercelModels={syncingVercelModels}
      vercelSavedAt={vercelSavedAt}
      onSyncVercelModels={handleSyncVercelModels}
      effectiveCloudflareModels={effectiveCloudflareModels}
      syncingCloudflareModels={syncingCloudflareModels}
      cloudflareSavedAt={cloudflareSavedAt}
      onSyncCloudflareModels={handleSyncCloudflareModels}
      effectiveAntigravityModels={effectiveAntigravityModels}
      syncingAntigravityModels={syncingAntigravityModels}
      antigravitySavedAt={antigravitySavedAt}
      onSyncAntigravityModels={handleSyncAntigravityModels}
    />
  );

  const sectionDetail =
    section === 'provider' ? (
      providerSection
    ) : section === 'latency' ? (
      <ArgosLatencySection
        testMessage={testMessage}
        summaries={summaries}
        onClearMetrics={handleClearMetrics}
      />
    ) : section === 'voice' ? (
      <>
        <ArgosAudioSection config={config} onFieldChange={handleFieldChange} />
        <section className="settings-group" data-testid="argos-companion-shortcut-section">
          <h2 className="settings-group__title">Atajo Global de Companion (Sistema)</h2>
          <div className="ui-card">
            <div className="ui-card__row settings-row settings-row--stacked">
              <div className="settings-row__copy">
                <h3 className="settings-row__title">Invocación global del Companion Bar</h3>
                <p>
                  Trae al frente y abre Argos Companion incluso con Kite Code minimizado o sin foco.
                  Estado:{' '}
                  <strong>
                    {companionShortcutStatus?.registered
                      ? `Global OS activo (${companionShortcutStatus.shortcut})`
                      : `Ventana local (${companionShortcut})`}
                  </strong>
                  {companionShortcutStatus?.error ? ` — ${companionShortcutStatus.error}` : ''}
                </p>
              </div>
              <div className="settings-row__control">
                <div className="settings-credential">
                  <input
                    type="text"
                    className="ui-field"
                    value={companionShortcut}
                    onChange={(e) => setCompanionShortcut(e.target.value)}
                    placeholder={DEFAULT_COMPANION_GLOBAL_SHORTCUT}
                    aria-label="Atajo global de Companion"
                  />
                  <button
                    type="button"
                    className="settings-control ui-button"
                    onClick={() => void handleSaveCompanionShortcut(DEFAULT_COMPANION_GLOBAL_SHORTCUT)}
                  >
                    Restablecer
                  </button>
                  <button
                    type="button"
                    className="settings-control ui-button ui-button--primary"
                    onClick={() => void handleSaveCompanionShortcut()}
                  >
                    Guardar atajo
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </>
    ) : section === 'persona' ? (
      <ArgosPersonaSection
        config={config}
        persona={persona}
        onPersonaChange={handlePersonaChange}
        onFieldChange={handleFieldChange}
        systemVoices={systemVoices}
        testingVoice={testingVoice}
        onTestVoice={handleTestVoice}
        openingPreview={openingPreview}
      />
    ) : (
      <ArgosMemorySection
        persona={persona}
        onPersonaChange={handlePersonaChange}
        memoryNotes={memoryNotes}
        newNoteText={newNoteText}
        onNewNoteTextChange={setNewNoteText}
        onAddMemoryNote={handleAddMemoryNote}
        onDeleteMemoryNote={handleDeleteMemoryNote}
      />
    );

  const selectSection = (id: ArgosSectionId) => {
    flushOperatorConfigSave();
    setSection(id);
  };

  const handleFieldBlurCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      flushOperatorConfigSave();
    }
  };

  const moveSection = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ARGOS_SECTIONS.length - 1
          : event.key === 'ArrowRight'
            ? Math.min(index + 1, ARGOS_SECTIONS.length - 1)
            : Math.max(index - 1, 0);
    const next = ARGOS_SECTIONS[nextIndex];
    if (!next || next.id === section) return;
    selectSection(next.id);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[data-zed-section]'
    );
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div className="zed-settings" onBlurCapture={handleFieldBlurCapture}>
      <ArgosHeroCard
        persona={persona}
        config={config}
        savedToast={savedToast}
        testingProvider={testingProvider}
        onRunProbe={handleRunProbe}
      />

      <nav className="zed-section-nav" aria-label="Secciones del asistente">
        {ARGOS_SECTIONS.map((item, index) => {
          const selected = item.id === section;
          return (
            <button
              key={item.id}
              type="button"
              data-zed-section=""
              aria-current={selected ? 'page' : undefined}
              className="zed-section-nav__item"
              onClick={() => selectSection(item.id)}
              onKeyDown={(event) => moveSection(event, index)}
            >
              {selected ? (
                <motion.span
                  layoutId="zed-section-nav-indicator"
                  className="zed-section-nav__indicator"
                  transition={springs.selection}
                  initial={false}
                  aria-hidden="true"
                />
              ) : null}
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <motion.div
        key={section}
        className="zed-section-panel"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={tweens.reveal}
      >
        {sectionDetail}
      </motion.div>
    </div>
  );
};

export const ZedTab = ArgosTab;

export default ArgosTab;
