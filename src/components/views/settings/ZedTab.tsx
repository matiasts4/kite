import React, { useState, useEffect, useMemo } from 'react';
import { ttsNarrator, getAvailableVoices } from '../../../lib/operator/ttsNarrator';
import { toast } from '../../../lib/toast';
import {
  OperatorConfig,
  OperatorProviderId,
  OPENCODE_MODEL_CATALOG,
  DEFAULT_ZED_PERSONA,
  ZedPersonaConfig,
  ZedMemoryNote,
  loadOperatorConfig,
  saveOperatorConfig,
  loadLatencyRecords,
  saveLatencyRecords,
  computeLatencySummaries,
  recordProviderLatency,
  buildZedOpeningPreview,
  loadZedMemoryNotes,
  saveZedMemoryNotes,
  loadModelCatalog,
  fetchOpenCodeGoModels,
  VERCEL_MODEL_CATALOG,
  fetchVercelModels,
  CLOUDFLARE_MODEL_CATALOG,
  fetchCloudflareModels,
} from '../../../lib/operator/operatorConfig';
import { probeProviderLatency } from '../../../lib/operator/operatorProviders';
import { invokeCommand, isTauriEnvironment } from '../../../lib/ipc';

import { ZedHeroCard } from './zed/ZedHeroCard';
import { ZedProvidersSection } from './zed/ZedProvidersSection';
import { ZedLatencySection } from './zed/ZedLatencySection';
import { ZedAudioSection } from './zed/ZedAudioSection';
import { ZedPersonaSection } from './zed/ZedPersonaSection';
import { ZedMemorySection } from './zed/ZedMemorySection';

export const ZedTab: React.FC = () => {
  const [config, setConfig] = useState<OperatorConfig>(() => loadOperatorConfig());
  const [records, setRecords] = useState(() => loadLatencyRecords());
  const [memoryNotes, setMemoryNotes] = useState<ZedMemoryNote[]>(() => loadZedMemoryNotes());
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

  // Voice synthesis states
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [testingVoice, setTestingVoice] = useState(false);

  const persona: ZedPersonaConfig = config.persona ?? DEFAULT_ZED_PERSONA;

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

  useEffect(() => {
    setConfig(loadOperatorConfig());
    setRecords(loadLatencyRecords());
    setMemoryNotes(loadZedMemoryNotes());

    let isMounted = true;

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
      const sampleText = `Hola, soy ${persona.name || 'Zed'}. Tu asistente está listo para ayudarte con tus tareas y terminales.`;
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

  const persistConfig = (next: OperatorConfig) => {
    setConfig(next);
    saveOperatorConfig(next);
    setSavedToast(true);
    window.setTimeout(() => setSavedToast(false), 1800);
  };

  const handleFieldChange = <K extends keyof OperatorConfig>(key: K, value: OperatorConfig[K]) => {
    persistConfig({ ...config, [key]: value });
  };

  const handlePersonaChange = <K extends keyof ZedPersonaConfig>(
    key: K,
    value: ZedPersonaConfig[K]
  ) => {
    persistConfig({
      ...config,
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

  const handleClearMetrics = () => {
    saveLatencyRecords([]);
    setRecords([]);
    setTestMessage('Historial de latencia reiniciado.');
  };

  const handleAddMemoryNote = () => {
    const trimmed = newNoteText.trim();
    if (!trimmed) return;
    const next: ZedMemoryNote[] = [
      {
        id: `mem-${Date.now().toString(36)}`,
        content: trimmed,
        createdAt: new Date().toISOString(),
      },
      ...memoryNotes,
    ];
    setMemoryNotes(next);
    saveZedMemoryNotes(next);
    setNewNoteText('');
  };

  const handleDeleteMemoryNote = (id: string) => {
    const next = memoryNotes.filter((n) => n.id !== id);
    setMemoryNotes(next);
    saveZedMemoryNotes(next);
  };

  const summaries = computeLatencySummaries(records);
  const openingPreview = buildZedOpeningPreview(persona);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Hero Banner with Spherical ZedOrb */}
      <ZedHeroCard
        persona={persona}
        config={config}
        savedToast={savedToast}
        testingProvider={testingProvider}
        onRunProbe={handleRunProbe}
      />

      {/* Section 1: Provider Gateway & Multi-Model Selector */}
      <ZedProvidersSection
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
      />

      {/* Section 2: Latency Benchmark per Provider & Task */}
      <ZedLatencySection
        testMessage={testMessage}
        summaries={summaries}
        onClearMetrics={handleClearMetrics}
      />

      {/* Section 3: Audio Input & Mic Controls */}
      <ZedAudioSection />

      {/* Section 4: Identity & Personality */}
      <ZedPersonaSection
        config={config}
        persona={persona}
        onPersonaChange={handlePersonaChange}
        onFieldChange={handleFieldChange}
        systemVoices={systemVoices}
        testingVoice={testingVoice}
        onTestVoice={handleTestVoice}
        openingPreview={openingPreview}
      />

      {/* Section 5: Shared Memory */}
      <ZedMemorySection
        persona={persona}
        onPersonaChange={handlePersonaChange}
        memoryNotes={memoryNotes}
        newNoteText={newNoteText}
        onNewNoteTextChange={setNewNoteText}
        onAddMemoryNote={handleAddMemoryNote}
        onDeleteMemoryNote={handleDeleteMemoryNote}
      />
    </div>
  );
};

export default ZedTab;
