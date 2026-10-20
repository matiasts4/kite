import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  listAudioInputDevices,
  startMicrophoneTest,
  startTranscriptionTestSession,
  type AudioInputDeviceInfo,
  type MicrophoneTester,
  type TranscriptionTestResult,
  type TranscriptionTestSession,
} from '../../../lib/operator/voice/zedVoice';
import { ttsNarrator, getAvailableVoices } from '../../../lib/operator/ttsNarrator';
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
  fetchOpenCodeModels,
  VERCEL_MODEL_CATALOG,
  fetchVercelModels,
  CLOUDFLARE_MODEL_CATALOG,
  fetchCloudflareModels,
} from '../../../lib/operator/operatorConfig';
import { probeProviderLatency } from '../../../lib/operator/operatorProviders';

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

  // Microphone & Audio Settings
  const [micDevices, setMicDevices] = useState<AudioInputDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>(() => {
    try {
      return localStorage.getItem('kite_selected_mic_device_id') || 'automatic';
    } catch {
      return 'automatic';
    }
  });
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [testMicLevel, setTestMicLevel] = useState(0);
  const [micTestStatus, setMicTestStatus] = useState<string | null>(null);
  const micTesterRef = useRef<MicrophoneTester | null>(null);
  const [grokTransKey, setGrokTransKey] = useState<string>(() => {
    try {
      return (
        loadOperatorConfig().grokTranscriptionApiKey ||
        localStorage.getItem('kite_grok_transcription_api_key') ||
        ''
      );
    } catch {
      return '';
    }
  });
  const [showGrokTransKey, setShowGrokTransKey] = useState(false);
  const [grokTransSaved, setGrokTransSaved] = useState(false);

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
    listAudioInputDevices().then((devices) => {
      if (isMounted) {
        setMicDevices(devices);
      }
    });

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
      if (micTesterRef.current) {
        micTesterRef.current.stop();
        micTesterRef.current = null;
      }
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
          onEnd: () => setTestingVoice(false),
          onError: () => setTestingVoice(false),
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

  const handleSelectMic = (deviceId: string) => {
    setSelectedMicId(deviceId);
    try {
      localStorage.setItem('kite_selected_mic_device_id', deviceId);
    } catch {}
    if (isTestingMic) {
      if (micTesterRef.current) {
        micTesterRef.current.stop();
        micTesterRef.current = null;
      }
      startMicrophoneTest(deviceId === 'automatic' ? null : deviceId, (lvl) => {
        setTestMicLevel(lvl);
      })
        .then((tester) => {
          micTesterRef.current = tester;
        })
        .catch(() => {
          setMicTestStatus('Error al iniciar prueba en el micrófono seleccionado.');
          setIsTestingMic(false);
        });
    }
  };

  const handleRefreshMicDevices = async () => {
    const devices = await listAudioInputDevices();
    setMicDevices(devices);
  };

  const handleToggleMicTest = async () => {
    if (isTestingMic) {
      if (micTesterRef.current) {
        micTesterRef.current.stop();
        micTesterRef.current = null;
      }
      setIsTestingMic(false);
      setTestMicLevel(0);
      setMicTestStatus(null);
    } else {
      setMicTestStatus(null);
      try {
        const tester = await startMicrophoneTest(
          selectedMicId === 'automatic' ? null : selectedMicId,
          (lvl) => {
            setTestMicLevel(lvl);
          }
        );
        micTesterRef.current = tester;
        setIsTestingMic(true);
      } catch (err: any) {
        setMicTestStatus(
          err?.message || 'No se pudo acceder al micrófono. Verifica los permisos del sistema.'
        );
        setIsTestingMic(false);
        setTestMicLevel(0);
      }
    }
  };

  const handleSaveGrokTransKey = () => {
    try {
      localStorage.setItem('kite_grok_transcription_api_key', grokTransKey.trim());
      handleFieldChange('grokTranscriptionApiKey', grokTransKey.trim());
      setGrokTransSaved(true);
      setTimeout(() => setGrokTransSaved(false), 2000);
    } catch {}
  };

  const [transcriptionTestState, setTranscriptionTestState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [transcriptionTestSeconds, setTranscriptionTestSeconds] = useState(0);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionTestResult | null>(null);
  const transcriptionSessionRef = useRef<TranscriptionTestSession | null>(null);
  const transcriptionTimerRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (transcriptionSessionRef.current) {
        transcriptionSessionRef.current.cancel();
        transcriptionSessionRef.current = null;
      }
      if (transcriptionTimerRef.current) {
        clearInterval(transcriptionTimerRef.current);
        transcriptionTimerRef.current = null;
      }
    };
  }, []);

  const handleToggleTranscriptionTest = async () => {
    if (transcriptionTestState === 'recording') {
      if (transcriptionTimerRef.current) {
        clearInterval(transcriptionTimerRef.current);
        transcriptionTimerRef.current = null;
      }
      const session = transcriptionSessionRef.current;
      transcriptionSessionRef.current = null;
      setTranscriptionTestState('transcribing');

      if (session) {
        try {
          const res = await session.stopAndTranscribe();
          setTranscriptionResult(res);
        } catch (err: any) {
          setTranscriptionResult({
            success: false,
            error: err?.message || 'Error inesperado al transcribir.',
            engine: 'Desconocido',
            latencyMs: 0,
            durationSecs: transcriptionTestSeconds,
          });
        } finally {
          setTranscriptionTestState('idle');
        }
      } else {
        setTranscriptionTestState('idle');
      }
    } else if (transcriptionTestState === 'idle') {
      setTranscriptionResult(null);
      setTranscriptionTestSeconds(0);
      try {
        const session = await startTranscriptionTestSession(
          selectedMicId === 'automatic' ? null : selectedMicId
        );
        transcriptionSessionRef.current = session;
        setTranscriptionTestState('recording');

        let elapsed = 0;
        transcriptionTimerRef.current = setInterval(async () => {
          elapsed += 1;
          setTranscriptionTestSeconds(elapsed);
          if (elapsed >= 8 && transcriptionSessionRef.current) {
            clearInterval(transcriptionTimerRef.current);
            transcriptionTimerRef.current = null;
            const currentSession = transcriptionSessionRef.current;
            transcriptionSessionRef.current = null;
            setTranscriptionTestState('transcribing');
            try {
              const res = await currentSession.stopAndTranscribe();
              setTranscriptionResult(res);
            } catch (err: any) {
              setTranscriptionResult({
                success: false,
                error: err?.message || 'Error al transcribir.',
                engine: 'Desconocido',
                latencyMs: 0,
                durationSecs: elapsed,
              });
            } finally {
              setTranscriptionTestState('idle');
            }
          }
        }, 1000);
      } catch (err: any) {
        setTranscriptionResult({
          success: false,
          error: err?.message || 'No se pudo acceder al micrófono para la prueba.',
          engine: 'Desconocido',
          latencyMs: 0,
          durationSecs: 0,
        });
        setTranscriptionTestState('idle');
      }
    }
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
      const fetched = await fetchOpenCodeModels(config.opencodeApiKey, config.opencodeBaseUrl);
      setModelsList(fetched.models);
      setOpenCodeSavedAt(fetched.savedAt);
      setTestMessage(
        fetched.fresh
          ? `Lista actualizada: ${fetched.models.length} modelos de OpenCode. Queda guardada hasta que vuelvas a actualizar.`
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
      <ZedAudioSection
        micDevices={micDevices}
        selectedMicId={selectedMicId}
        onSelectMic={handleSelectMic}
        onRefreshMicDevices={handleRefreshMicDevices}
        isTestingMic={isTestingMic}
        testMicLevel={testMicLevel}
        micTestStatus={micTestStatus}
        onToggleMicTest={handleToggleMicTest}
        transcriptionTestState={transcriptionTestState}
        transcriptionTestSeconds={transcriptionTestSeconds}
        onToggleTranscriptionTest={handleToggleTranscriptionTest}
        transcriptionResult={transcriptionResult}
        grokTransKey={grokTransKey}
        onGrokTransKeyChange={setGrokTransKey}
        showGrokTransKey={showGrokTransKey}
        onToggleShowGrokTransKey={() => setShowGrokTransKey(!showGrokTransKey)}
        onSaveGrokTransKey={handleSaveGrokTransKey}
        grokTransSaved={grokTransSaved}
      />

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
