// Kite Code — Voice Session Coordinator (Thread Voice Mode & Orb Handshake)
// Single authoritative source of truth for live continuous voice sessions across Thread and Code modes.

import { useSyncExternalStore } from 'react';
import type { ActionReceipt } from '../contract';
import { loadOperatorConfig } from '../operatorConfig';
import { resolveVerifiedModel } from '../providers/resolvePlanner';

export type VoiceSessionPhase = 'inactive' | 'starting' | 'active' | 'stopping';
export type VoiceSurface = 'orb' | 'thread';

export interface ConfiguredAssistantDisplay {
  personaName: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  ttsEngine: 'native' | 'elevenlabs';
  ttsLabel: string;
  voiceName: string;
  language: 'es-ES' | 'en-US';
}

const PROVIDER_LABELS: Record<string, string> = {
  grok: 'Grok',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  vercel: 'Vercel',
  cloudflare: 'Cloudflare',
  local: 'Local',
};

export function getConfiguredAssistantDisplay(): ConfiguredAssistantDisplay {
  const opConfig = loadOperatorConfig();
  const activeId = opConfig.activeProvider || 'grok';
  const requestedModel =
    activeId === 'opencode'
      ? opConfig.opencodeModel
      : activeId === 'vercel'
      ? opConfig.vercelModel
      : activeId === 'cloudflare'
      ? opConfig.cloudflareModel
      : activeId === 'antigravity'
      ? opConfig.antigravityModel
      : activeId === 'grok'
      ? opConfig.grokModel
      : undefined;
  const providerLabel = PROVIDER_LABELS[activeId] || activeId.toUpperCase();
  const modelId =
    activeId === 'local'
      ? 'heurístico'
      : resolveVerifiedModel(activeId, requestedModel);
  const ttsEngine = opConfig.ttsEngine === 'elevenlabs' ? 'elevenlabs' : 'native';
  const ttsLabel = ttsEngine === 'elevenlabs' ? 'ElevenLabs' : 'Voz Nativa';
  const voiceName = opConfig.persona?.voice || 'Ara';
  const language = opConfig.persona?.language === 'en' ? 'en-US' : 'es-ES';

  return {
    personaName: opConfig.persona?.name || 'Zed',
    providerId: activeId,
    providerLabel,
    modelId,
    ttsEngine,
    ttsLabel,
    voiceName,
    language,
  };
}

export interface VoiceTurnRecord {
  turnId: string;
  userPrompt: string;
  source: 'voz' | 'texto';
  strategy?: string;
  providerId?: string;
  modelId?: string;
  durationMs?: number;
  overallSuccess?: boolean;
  receipts?: ActionReceipt[];
  consultChatsInfo?: {
    kind: string;
    text?: string;
    title?: string;
    cli?: string;
  };
  reply?: string;
  createdAt: number;
}

export interface VoiceSessionState {
  phase: VoiceSessionPhase;
  boundThreadId: string | null;
  activeSurface: VoiceSurface;
  micMuted: boolean;
  speakerMuted: boolean;
  isPausedForDictation: boolean;
  liveAudioLevel: number;
  activeTurnStage?: string;
  activeTurnDetail?: string;
  isListening?: boolean;
  isTranscribing?: boolean;
  isSpeaking?: boolean;
  interimTranscript?: string;
  turnsVersion?: number;
}

export type VoiceTextTurnExecutor = (
  text: string,
  threadId: string,
  workspaceId?: string
) => Promise<void>;

class VoiceSessionStore {
  private state: VoiceSessionState = {
    phase: 'inactive',
    boundThreadId: null,
    activeSurface: 'orb',
    micMuted: false,
    speakerMuted: false,
    isPausedForDictation: false,
    liveAudioLevel: 0,
    isListening: false,
    isTranscribing: false,
    isSpeaking: false,
    interimTranscript: '',
    turnsVersion: 0,
  };

  private turnsByThread: Record<string, VoiceTurnRecord[]> = {};
  private textTurnExecutor: VoiceTextTurnExecutor | null = null;

  private listeners = new Set<() => void>();

  constructor() {
    if (typeof window !== 'undefined') {
      // Sync legacy window flag
      (window as any).__kiteVoiceSessionActive = false;
    }
  }

  getSnapshot = (): VoiceSessionState => {
    return this.state;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify() {
    if (typeof window !== 'undefined') {
      (window as any).__kiteVoiceSessionActive = this.state.phase === 'active' || this.state.phase === 'starting';
      try {
        window.dispatchEvent(
          new CustomEvent('kite:voice-session-changed', {
            detail: { ...this.state },
          })
        );
      } catch {}
    }
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {}
    });
  }

  startSession(threadId?: string | null, surface: VoiceSurface = 'orb') {
    if (this.state.phase === 'active' || this.state.phase === 'starting') {
      if (threadId !== undefined && threadId !== this.state.boundThreadId) {
        this.state = {
          ...this.state,
          boundThreadId: threadId,
          activeSurface: surface,
        };
        this.notify();
      }
      return;
    }

    this.state = {
      ...this.state,
      phase: 'starting',
      boundThreadId: threadId ?? null,
      activeSurface: surface,
      isPausedForDictation: false,
      activeTurnStage: undefined,
      activeTurnDetail: undefined,
    };
    this.notify();

    // Transition to active cleanly
    this.state = {
      ...this.state,
      phase: 'active',
    };
    this.notify();
  }

  stopSession() {
    if (this.state.phase === 'inactive' || this.state.phase === 'stopping') {
      return;
    }

    this.state = {
      ...this.state,
      phase: 'stopping',
    };
    this.notify();

    this.state = {
      ...this.state,
      phase: 'inactive',
      isPausedForDictation: false,
      liveAudioLevel: 0,
      activeTurnStage: undefined,
      activeTurnDetail: undefined,
      isListening: false,
      isTranscribing: false,
      isSpeaking: false,
      interimTranscript: '',
    };
    this.notify();
  }

  toggleSession(threadId?: string | null, surface: VoiceSurface = 'orb') {
    if (this.state.phase === 'active' || this.state.phase === 'starting') {
      this.stopSession();
    } else {
      this.startSession(threadId, surface);
    }
  }

  setMicMuted(muted: boolean) {
    if (this.state.micMuted === muted) return;
    this.state = { ...this.state, micMuted: muted };
    this.notify();
  }

  toggleMicMuted() {
    this.setMicMuted(!this.state.micMuted);
  }

  setSpeakerMuted(muted: boolean) {
    if (this.state.speakerMuted === muted) return;
    this.state = { ...this.state, speakerMuted: muted };
    this.notify();
  }

  toggleSpeakerMuted() {
    this.setSpeakerMuted(!this.state.speakerMuted);
  }

  pauseForDictation() {
    if (this.state.isPausedForDictation) return;
    this.state = { ...this.state, isPausedForDictation: true };
    this.notify();
  }

  resumeFromDictation() {
    if (!this.state.isPausedForDictation) return;
    this.state = { ...this.state, isPausedForDictation: false };
    this.notify();
  }

  setBoundThreadId(threadId: string | null) {
    if (this.state.boundThreadId === threadId) return;
    this.state = { ...this.state, boundThreadId: threadId };
    this.notify();
  }

  setActiveSurface(surface: VoiceSurface) {
    if (this.state.activeSurface === surface) return;
    this.state = { ...this.state, activeSurface: surface };
    this.notify();
  }

  setLiveAudioLevel(level: number) {
    const clamped = Math.max(0, Math.min(1, level));
    if (Math.abs(this.state.liveAudioLevel - clamped) < 0.02) return;
    this.state = { ...this.state, liveAudioLevel: clamped };
    this.notify();
  }

  setActiveTurnStage(stage?: string, detail?: string) {
    if (this.state.activeTurnStage === stage && this.state.activeTurnDetail === detail) return;
    this.state = {
      ...this.state,
      activeTurnStage: stage,
      activeTurnDetail: detail,
    };
    this.notify();
  }

  setVoiceRuntimeState(
    patch: Partial<
      Pick<VoiceSessionState, 'isListening' | 'isTranscribing' | 'isSpeaking' | 'interimTranscript'>
    >
  ) {
    const next = { ...this.state, ...patch };
    if (
      next.isListening === this.state.isListening &&
      next.isTranscribing === this.state.isTranscribing &&
      next.isSpeaking === this.state.isSpeaking &&
      next.interimTranscript === this.state.interimTranscript
    ) {
      return;
    }
    this.state = next;
    this.notify();
  }

  registerTextTurnExecutor(executor: VoiceTextTurnExecutor | null) {
    this.textTurnExecutor = executor;
  }

  hasTextTurnExecutor(): boolean {
    return this.textTurnExecutor !== null;
  }

  async submitTextTurn(text: string, threadId: string, workspaceId?: string): Promise<boolean> {
    if (!this.textTurnExecutor) return false;
    await this.textTurnExecutor(text, threadId, workspaceId);
    return true;
  }

  getThreadVoiceTurns(threadId: string): VoiceTurnRecord[] {
    if (!threadId) return [];
    if (!this.turnsByThread[threadId]) {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(`kite.voiceTurns.${threadId}`) : null;
        if (raw) {
          this.turnsByThread[threadId] = JSON.parse(raw);
        }
      } catch {}
    }
    return this.turnsByThread[threadId] || [];
  }

  addThreadVoiceTurn(threadId: string, record: VoiceTurnRecord) {
    if (!threadId) return;
    const existing = this.getThreadVoiceTurns(threadId);
    const updated = [...existing.filter((t) => t.turnId !== record.turnId), record];
    this.turnsByThread[threadId] = updated;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`kite.voiceTurns.${threadId}`, JSON.stringify(updated));
      }
    } catch {}
    this.state = {
      ...this.state,
      turnsVersion: (this.state.turnsVersion || 0) + 1,
    };
    this.notify();
  }

  clearThreadVoiceTurns(threadId: string) {
    if (!threadId) return;
    delete this.turnsByThread[threadId];
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(`kite.voiceTurns.${threadId}`);
      }
    } catch {}
    this.state = {
      ...this.state,
      turnsVersion: (this.state.turnsVersion || 0) + 1,
    };
    this.notify();
  }
}

export const voiceSessionStore = new VoiceSessionStore();

export function useVoiceSession(): VoiceSessionState & {
  startSession: (threadId?: string | null, surface?: VoiceSurface) => void;
  stopSession: () => void;
  toggleSession: (threadId?: string | null, surface?: VoiceSurface) => void;
  toggleMicMuted: () => void;
  setMicMuted: (muted: boolean) => void;
  toggleSpeakerMuted: () => void;
  setSpeakerMuted: (muted: boolean) => void;
  pauseForDictation: () => void;
  resumeFromDictation: () => void;
  setBoundThreadId: (threadId: string | null) => void;
  setActiveSurface: (surface: VoiceSurface) => void;
  getThreadVoiceTurns: (threadId: string) => VoiceTurnRecord[];
  addThreadVoiceTurn: (threadId: string, record: VoiceTurnRecord) => void;
  clearThreadVoiceTurns: (threadId: string) => void;
} {
  const snapshot = useSyncExternalStore(
    voiceSessionStore.subscribe,
    voiceSessionStore.getSnapshot,
    voiceSessionStore.getSnapshot
  );

  return {
    ...snapshot,
    startSession: (threadId, surface) => voiceSessionStore.startSession(threadId, surface),
    stopSession: () => voiceSessionStore.stopSession(),
    toggleSession: (threadId, surface) => voiceSessionStore.toggleSession(threadId, surface),
    toggleMicMuted: () => voiceSessionStore.toggleMicMuted(),
    setMicMuted: (muted) => voiceSessionStore.setMicMuted(muted),
    toggleSpeakerMuted: () => voiceSessionStore.toggleSpeakerMuted(),
    setSpeakerMuted: (muted) => voiceSessionStore.setSpeakerMuted(muted),
    pauseForDictation: () => voiceSessionStore.pauseForDictation(),
    resumeFromDictation: () => voiceSessionStore.resumeFromDictation(),
    setBoundThreadId: (threadId) => voiceSessionStore.setBoundThreadId(threadId),
    setActiveSurface: (surface) => voiceSessionStore.setActiveSurface(surface),
    getThreadVoiceTurns: (threadId) => voiceSessionStore.getThreadVoiceTurns(threadId),
    addThreadVoiceTurn: (threadId, record) => voiceSessionStore.addThreadVoiceTurn(threadId, record),
    clearThreadVoiceTurns: (threadId) => voiceSessionStore.clearThreadVoiceTurns(threadId),
  };
}
