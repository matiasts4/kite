// Kite Code — Voice Session Coordinator (Thread Voice Mode & Orb Handshake)
// Single authoritative source of truth for live continuous voice sessions across Thread and Code modes.

import { useSyncExternalStore } from 'react';
import type { ActionReceipt } from '../contract';
import type { ProviderMessage } from '../providers/types';
import { loadOperatorConfig } from '../operatorConfig';
import { resolveVerifiedModel } from '../providers/resolvePlanner';
import {
  clearSessionWorkingContext,
  recordTurnIntoWorkingContext,
} from '../context/workingContext';

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

export interface PendingDisambiguationState {
  question: string;
  missingSlot: 'target' | 'task' | 'surface' | 'provider' | 'workspace';
  originalInput: string;
  candidates?: string[];
  draftAction?: Record<string, unknown>;
  createdAt: number;
  remainingTurns: number;
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
  interrupted?: boolean;
  /** True when this turn was generated proactively (e.g. a child subagent return callback) without a user prompt. */
  isProactiveReport?: boolean;
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
  private pendingDisambiguationByScope: Record<string, PendingDisambiguationState> = {};
  private textTurnExecutor: VoiceTextTurnExecutor | null = null;
  private onSessionEndedListeners = new Set<(info: { threadId: string | null; turns: VoiceTurnRecord[] }) => void>();

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

    const closingThreadId = this.state.boundThreadId;
    const closingTurns = closingThreadId ? this.getThreadVoiceTurns(closingThreadId) : [];

    this.state = {
      ...this.state,
      phase: 'stopping',
    };
    this.notify();

    this.state = {
      ...this.state,
      phase: 'inactive',
      boundThreadId: null,
      activeSurface: 'orb',
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

    for (const cb of this.onSessionEndedListeners) {
      try {
        cb({ threadId: closingThreadId, turns: closingTurns });
      } catch {}
    }
  }

  onSessionEnded(
    listener: (info: { threadId: string | null; turns: VoiceTurnRecord[] }) => void
  ): () => void {
    this.onSessionEndedListeners.add(listener);
    return () => this.onSessionEndedListeners.delete(listener);
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
    if (record.reply && record.reply.trim()) {
      recordTurnIntoWorkingContext(threadId, record, updated);
    }
    this.state = {
      ...this.state,
      turnsVersion: (this.state.turnsVersion || 0) + 1,
    };
    this.notify();
  }

  markTurnInterrupted(threadId: string | null | undefined, turnId?: string) {
    const targetId = threadId ?? this.state.boundThreadId;
    if (!targetId) return;
    const existing = this.getThreadVoiceTurns(targetId);
    if (existing.length === 0) return;

    const targetTurnId = turnId || existing[existing.length - 1]?.turnId;
    if (!targetTurnId) return;

    let changed = false;
    const updated = existing.map((t) => {
      if (t.turnId === targetTurnId && !t.interrupted) {
        changed = true;
        return { ...t, interrupted: true };
      }
      return t;
    });
    if (!changed) return;

    this.turnsByThread[targetId] = updated;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`kite.voiceTurns.${targetId}`, JSON.stringify(updated));
      }
    } catch {}
    this.state = {
      ...this.state,
      turnsVersion: (this.state.turnsVersion || 0) + 1,
    };
    this.notify();
  }

  setPendingDisambiguation(
    scopeKey: string | null | undefined,
    pending: PendingDisambiguationState | null
  ) {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    if (!pending) {
      delete this.pendingDisambiguationByScope[key];
      return;
    }
    this.pendingDisambiguationByScope[key] = pending;
  }

  getPendingDisambiguation(
    scopeKey?: string | null,
    nowMs: number = Date.now()
  ): PendingDisambiguationState | null {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    const item = this.pendingDisambiguationByScope[key];
    if (!item) return null;
    if (nowMs - item.createdAt > 90_000 || item.remainingTurns <= 0) {
      delete this.pendingDisambiguationByScope[key];
      return null;
    }
    return item;
  }

  clearPendingDisambiguation(scopeKey?: string | null) {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    delete this.pendingDisambiguationByScope[key];
  }

  getConversationHistory(threadId?: string | null, maxTurns: number = 8): ProviderMessage[] {
    const targetId = threadId ?? this.state.boundThreadId;
    if (!targetId) return [];
    const turns = this.getThreadVoiceTurns(targetId);
    if (turns.length === 0) return [];

    const recent = [...turns]
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((t) => {
        const prompt = (t.userPrompt || '').trim();
        if (prompt.startsWith('[captura de voz descartada')) return false;
        if (!prompt && !t.isProactiveReport) return false;
        return true;
      })
      .slice(-Math.max(1, maxTurns));

    const messages: ProviderMessage[] = [];
    for (const turn of recent) {
      const reply = (turn.reply || '').trim();
      // Skip in-flight optimistic user bubbles (no reply yet) so the current turn is never duplicated in history.
      if (!reply) continue;
      if (turn.isProactiveReport && !(turn.userPrompt || '').trim()) {
        // Merge proactive assistant reports onto the preceding assistant message to preserve
        // strict user/assistant alternation across all LLM providers (and avoid orphan leading assistant turns).
        const prev = messages[messages.length - 1];
        if (prev && prev.role === 'assistant') {
          prev.content = `${prev.content}\n\n[Reporte automático]: ${reply}`;
        }
        continue;
      }
      messages.push({ role: 'user', content: turn.userPrompt });
      messages.push({
        role: 'assistant',
        content: turn.interrupted ? `${reply} [respuesta interrumpida por el usuario]` : reply,
      });
    }
    return messages;
  }

  clearThreadVoiceTurns(threadId: string) {
    if (!threadId) return;
    delete this.turnsByThread[threadId];
    clearSessionWorkingContext(threadId);
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
