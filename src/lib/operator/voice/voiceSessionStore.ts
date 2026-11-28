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
import {
  appendAudioSpan,
  computeSpokenCharCount,
  type AudioSpan,
  type LiveTeleprompterLine,
} from './audioSpanSync';

export type { AudioSpan, LiveTeleprompterLine };

export type VoiceSessionPhase = 'inactive' | 'starting' | 'active' | 'stopping';
export type VoiceSurface = 'orb' | 'thread';
export type VoiceTransportKind = 'cascaded' | 'realtime';
export type RealtimeProviderId = 'xai' | 'gemini_live' | 'openai';

export interface VoiceErrorState {
  message: string;
  at: number;
  retryable?: boolean;
  openPrivacySettings?: boolean;
}

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
  const rawName = (opConfig.persona?.name || '').trim();
  const personaName =
    !rawName || rawName === 'Zed' || rawName === 'Seth' ? 'Argos' : rawName;

  return {
    personaName,
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

export type DraftStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface DraftExecutionStep {
  stepId: string;
  title: string;
  action: Record<string, unknown>;
  dependsOn?: string[];
  enabled: boolean;
  status: DraftStepStatus;
  error?: string;
  summaryEs?: string;
}

export interface DraftTaskProposal {
  proposalId: string;
  status: 'drafting' | 'awaiting_confirmation' | 'executing' | 'confirmed' | 'cancelled';
  targetKind: 'subagent' | 'thread' | 'agent' | 'terminal';
  title: string;
  taskBrief: string;
  role?: string;
  provider?: string;
  mode?: 'explore' | 'odd' | 'execute';
  oddMode?: boolean;
  workspaceMode?: 'inherit' | 'share' | 'branch';
  questionForUser?: string;
  contextRefs?: string[];
  steps?: DraftExecutionStep[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type DraftExecutionPlan = DraftTaskProposal;

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
  /** Exact millisecond offset of assistant audio heard before barge-in truncation. */
  audioEndMs?: number;
  /** True when this turn was generated proactively (e.g. a child subagent return callback) without a user prompt. */
  isProactiveReport?: boolean;
  createdAt: number;
  /** Timestamp when the turn's reply was finalized, so actions/subagents spawned mid-turn sort between user prompt and assistant reply. */
  completedAt?: number;
}

export interface VoiceSessionState {
  phase: VoiceSessionPhase;
  boundThreadId: string | null;
  activeSurface: VoiceSurface;
  micMuted: boolean;
  speakerMuted: boolean;
  isPausedForDictation: boolean;
  liveAudioLevel: number;
  speakerAudioLevel?: number;
  startedAt?: number;
  activeTransport?: VoiceTransportKind;
  activeRealtimeProvider?: RealtimeProviderId;
  activeTurnStage?: string;
  activeTurnDetail?: string;
  isListening?: boolean;
  isTranscribing?: boolean;
  isSpeaking?: boolean;
  micFlatlined?: boolean;
  interimTranscript?: string;
  turnsVersion?: number;
  liveTeleprompterLines?: LiveTeleprompterLine[];
  progressUpdatesEnabled?: boolean;
  voiceError?: VoiceErrorState | null;
  inactivityNotice?: string | null;
  draftProposal?: DraftTaskProposal | null;
  handsFreeReplyUntilMs?: number;
}

export type VoiceTextTurnExecutor = (
  text: string,
  threadId: string,
  workspaceId?: string
) => Promise<void>;

export const MAX_VOICE_HISTORY_THREADS = 8;

class VoiceSessionStore {
  private state: VoiceSessionState = {
    phase: 'inactive',
    boundThreadId: null,
    activeSurface: 'orb',
    micMuted: false,
    speakerMuted: false,
    isPausedForDictation: false,
    liveAudioLevel: 0,
    speakerAudioLevel: 0,
    isListening: false,
    isTranscribing: false,
    isSpeaking: false,
    micFlatlined: false,
    interimTranscript: '',
    turnsVersion: 0,
    liveTeleprompterLines: [],
    progressUpdatesEnabled: true,
    voiceError: null,
    inactivityNotice: null,
  };

  private nextTeleprompterSeq = 1;
  private rawUserTeleprompterBySeq = new Map<number, string>();

  private turnsByThread: Record<string, VoiceTurnRecord[]> = {};
  private voiceTurnsLruOrder: string[] = [];
  private pendingDisambiguationByScope: Record<string, PendingDisambiguationState> = {};
  private draftProposalByScope: Record<string, DraftTaskProposal> = {};
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

    this.nextTeleprompterSeq = 1;
    this.rawUserTeleprompterBySeq.clear();
    this.state = {
      ...this.state,
      phase: 'starting',
      boundThreadId: threadId ?? null,
      activeSurface: surface,
      isPausedForDictation: false,
      activeTurnStage: undefined,
      activeTurnDetail: undefined,
      startedAt: Date.now(),
      activeTransport: undefined,
      activeRealtimeProvider: undefined,
      speakerAudioLevel: 0,
      liveTeleprompterLines: [],
      progressUpdatesEnabled: true,
      voiceError: null,
      inactivityNotice: null,
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

    this.nextTeleprompterSeq = 1;
    this.rawUserTeleprompterBySeq.clear();
    this.state = {
      ...this.state,
      phase: 'inactive',
      boundThreadId: null,
      activeSurface: 'orb',
      isPausedForDictation: false,
      liveAudioLevel: 0,
      speakerAudioLevel: 0,
      startedAt: undefined,
      activeTransport: undefined,
      activeRealtimeProvider: undefined,
      liveTeleprompterLines: [],
      progressUpdatesEnabled: true,
      activeTurnStage: undefined,
      activeTurnDetail: undefined,
      isListening: false,
      isTranscribing: false,
      isSpeaking: false,
      micFlatlined: false,
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

  setActiveTransport(transport: VoiceTransportKind, provider?: RealtimeProviderId) {
    const nextProvider = transport === 'realtime' ? provider : undefined;
    if (
      this.state.activeTransport === transport &&
      this.state.activeRealtimeProvider === nextProvider
    ) {
      return;
    }
    this.state = {
      ...this.state,
      activeTransport: transport,
      activeRealtimeProvider: nextProvider,
    };
    this.notify();
  }

  setSpeakerAudioLevel(level: number) {
    const safe = Number.isFinite(level) ? level : 0;
    const clamped = Math.max(0, Math.min(1, safe));
    if ((this.state.speakerAudioLevel ?? 0) === clamped) return;
    this.state = { ...this.state, speakerAudioLevel: clamped };
    this.notify();
  }

  upsertLiveTeleprompterUser(
    text: string,
    interim: boolean,
    seqOrOpts?: number | { seq?: number; append?: boolean }
  ): string {
    const seq = typeof seqOrOpts === 'number' ? seqOrOpts : seqOrOpts?.seq;
    const append = typeof seqOrOpts === 'object' && Boolean(seqOrOpts?.append);
    const rawIncoming = typeof text === 'string' ? text : '';
    const trimmed = rawIncoming.trim();
    const currentLines = this.state.liveTeleprompterLines ?? [];
    const nowMs = Date.now();

    let targetIdx = -1;
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      this.nextTeleprompterSeq = Math.max(this.nextTeleprompterSeq, seq + 1);
      targetIdx = currentLines.findIndex((line) => line.seq === seq && line.kind === 'user');
    } else if (currentLines.length > 0) {
      const lastIdx = currentLines.length - 1;
      const lastLine = currentLines[lastIdx];
      if (lastLine.kind === 'user' && lastLine.interim) {
        targetIdx = lastIdx;
      }
    }

    if (targetIdx >= 0) {
      const existing = currentLines[targetIdx];
      let nextRaw = rawIncoming;
      let nextText = trimmed || existing.text;
      if (append && rawIncoming) {
        const prevRaw = this.rawUserTeleprompterBySeq.get(existing.seq) ?? existing.text;
        nextRaw =
          trimmed.startsWith(existing.text) && trimmed.length >= existing.text.length
            ? rawIncoming
            : `${prevRaw}${rawIncoming}`;
        nextText = nextRaw.trim() || existing.text;
      }
      if (interim) {
        this.rawUserTeleprompterBySeq.set(existing.seq, nextRaw);
      } else {
        this.rawUserTeleprompterBySeq.delete(existing.seq);
      }
      if (existing.text === nextText && Boolean(existing.interim) === Boolean(interim)) {
        return nextText;
      }
      const nextLines = [...currentLines];
      nextLines[targetIdx] = {
        ...existing,
        text: nextText,
        interim: Boolean(interim),
        timeMs: nowMs,
      };
      this.state = { ...this.state, liveTeleprompterLines: nextLines };
      this.notify();
      return nextText;
    }

    if (!trimmed) {
      return '';
    }

    const assignedSeq =
      typeof seq === 'number' && Number.isFinite(seq) ? seq : this.nextTeleprompterSeq++;
    if (assignedSeq >= this.nextTeleprompterSeq) {
      this.nextTeleprompterSeq = assignedSeq + 1;
    }
    if (interim) {
      this.rawUserTeleprompterBySeq.set(assignedSeq, rawIncoming);
    }

    const created: LiveTeleprompterLine = {
      seq: assignedSeq,
      kind: 'user',
      text: trimmed,
      timeMs: nowMs,
      interim: Boolean(interim),
    };
    const nextLines = [...currentLines, created].slice(-60);
    this.state = { ...this.state, liveTeleprompterLines: nextLines };
    this.notify();
    return trimmed;
  }

  appendLiveTeleprompterVoice(
    deltaOrText: string,
    options?: {
      seq?: number;
      utteranceStart?: number;
      utteranceEnd?: number;
      talkerDuration?: number;
      audioSpans?: AudioSpan[];
      spokenChars?: number;
      replace?: boolean;
    }
  ) {
    const rawText = typeof deltaOrText === 'string' ? deltaOrText : '';
    const currentLines = this.state.liveTeleprompterLines ?? [];
    const nowMs = Date.now();
    const hasMetadata =
      options?.utteranceStart !== undefined ||
      options?.utteranceEnd !== undefined ||
      options?.talkerDuration !== undefined ||
      options?.spokenChars !== undefined ||
      (Array.isArray(options?.audioSpans) && options.audioSpans.length > 0);

    let targetIdx = -1;
    if (typeof options?.seq === 'number' && Number.isFinite(options.seq)) {
      this.nextTeleprompterSeq = Math.max(this.nextTeleprompterSeq, options.seq + 1);
      targetIdx = currentLines.findIndex(
        (line) => line.seq === options.seq && line.kind === 'voice'
      );
    } else if (currentLines.length > 0) {
      const lastIdx = currentLines.length - 1;
      const lastLine = currentLines[lastIdx];
      if (lastLine.kind === 'voice' && (lastLine.spokenChars === undefined || options?.replace)) {
        targetIdx = lastIdx;
      }
    }

    if (targetIdx >= 0) {
      const existing = currentLines[targetIdx];
      const nextText = options?.replace ? rawText : `${existing.text}${rawText}`;
      const nextLine: LiveTeleprompterLine = {
        ...existing,
        text: nextText,
        timeMs: nowMs,
        ...(options?.utteranceStart !== undefined ? { utteranceStart: options.utteranceStart } : {}),
        ...(options?.utteranceEnd !== undefined ? { utteranceEnd: options.utteranceEnd } : {}),
        ...(options?.talkerDuration !== undefined ? { talkerDuration: options.talkerDuration } : {}),
        ...(options?.audioSpans !== undefined ? { audioSpans: [...options.audioSpans] } : {}),
      };
      if (options?.spokenChars !== undefined) {
        nextLine.spokenChars = Math.max(0, Math.min(nextText.length, Math.floor(options.spokenChars)));
      } else if (options?.replace && options?.utteranceStart !== undefined) {
        delete nextLine.spokenChars;
      }
      const nextLines = [...currentLines];
      nextLines[targetIdx] = nextLine;
      this.state = { ...this.state, liveTeleprompterLines: nextLines };
      this.notify();
      return;
    }

    if (!rawText && !hasMetadata) {
      return;
    }

    const assignedSeq =
      typeof options?.seq === 'number' && Number.isFinite(options.seq)
        ? options.seq
        : this.nextTeleprompterSeq++;
    if (assignedSeq >= this.nextTeleprompterSeq) {
      this.nextTeleprompterSeq = assignedSeq + 1;
    }

    const created: LiveTeleprompterLine = {
      seq: assignedSeq,
      kind: 'voice',
      text: rawText,
      timeMs: nowMs,
      ...(options?.utteranceStart !== undefined ? { utteranceStart: options.utteranceStart } : {}),
      ...(options?.utteranceEnd !== undefined ? { utteranceEnd: options.utteranceEnd } : {}),
      ...(options?.talkerDuration !== undefined ? { talkerDuration: options.talkerDuration } : {}),
      ...(options?.audioSpans !== undefined ? { audioSpans: [...options.audioSpans] } : {}),
      ...(options?.spokenChars !== undefined
        ? { spokenChars: Math.max(0, Math.min(rawText.length, Math.floor(options.spokenChars))) }
        : {}),
    };
    const nextLines = [...currentLines, created].slice(-60);
    this.state = { ...this.state, liveTeleprompterLines: nextLines };
    this.notify();
  }

  recordLiveVoiceAudioSpan(startAt: number, endAt: number, playbackSpeed: number = 1) {
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      return;
    }
    const currentLines = this.state.liveTeleprompterLines ?? [];
    if (currentLines.length === 0) return;

    let lastUserIdx = -1;
    for (let i = currentLines.length - 1; i >= 0; i -= 1) {
      if (currentLines[i].kind === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    let targetIdx = -1;
    for (let i = currentLines.length - 1; i > lastUserIdx; i -= 1) {
      const line = currentLines[i];
      if (line.kind === 'voice' && line.spokenChars === undefined) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx === -1) return;

    const target = currentLines[targetIdx];
    const nextSpans = appendAudioSpan(target.audioSpans, startAt, endAt, playbackSpeed);
    const utteranceStart =
      typeof target.utteranceStart === 'number' && Number.isFinite(target.utteranceStart)
        ? Math.min(target.utteranceStart, startAt)
        : nextSpans[0]?.startAt ?? startAt;
    const utteranceEnd =
      typeof target.utteranceEnd === 'number' && Number.isFinite(target.utteranceEnd)
        ? Math.max(target.utteranceEnd, endAt)
        : nextSpans[nextSpans.length - 1]?.endAt ?? endAt;

    const nextLines = [...currentLines];
    nextLines[targetIdx] = {
      ...target,
      audioSpans: nextSpans,
      utteranceStart,
      utteranceEnd,
    };
    this.state = { ...this.state, liveTeleprompterLines: nextLines };
    this.notify();
  }

  freezeLiveVoiceSpokenChars(currentAudioTime: number) {
    const currentLines = this.state.liveTeleprompterLines ?? [];
    if (currentLines.length === 0) return;

    let lastUserIdx = -1;
    for (let i = currentLines.length - 1; i >= 0; i -= 1) {
      if (currentLines[i].kind === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    let changed = false;
    const nextLines = currentLines.map((line, idx) => {
      if (idx <= lastUserIdx || line.kind !== 'voice' || line.spokenChars !== undefined) {
        return line;
      }
      changed = true;
      return {
        ...line,
        spokenChars: computeSpokenCharCount(currentAudioTime, line),
      };
    });

    if (!changed) return;
    this.state = { ...this.state, liveTeleprompterLines: nextLines };
    this.notify();
  }

  completeLiveTeleprompterVoice() {
    const currentLines = this.state.liveTeleprompterLines ?? [];
    if (currentLines.length === 0) return;

    let lastUserIdx = -1;
    for (let i = currentLines.length - 1; i >= 0; i -= 1) {
      if (currentLines[i].kind === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    let changed = false;
    const nextLines = currentLines.map((line, idx) => {
      if (idx <= lastUserIdx || line.kind !== 'voice') {
        return line;
      }
      const fullLen = line.text.length;
      if (line.spokenChars === fullLen) {
        return line;
      }
      changed = true;
      return {
        ...line,
        spokenChars: fullLen,
      };
    });

    if (!changed) return;
    this.state = { ...this.state, liveTeleprompterLines: nextLines };
    this.notify();
  }

  setProgressUpdatesEnabled(enabled: boolean) {
    const next = Boolean(enabled);
    if (this.state.progressUpdatesEnabled === next) return;
    this.state = { ...this.state, progressUpdatesEnabled: next };
    this.notify();
  }

  setVoiceError(error: VoiceSessionState['voiceError']) {
    const next = error ?? null;
    if (next === null && (this.state.voiceError ?? null) === null) return;
    this.state = { ...this.state, voiceError: next };
    this.notify();
  }

  setInactivityNotice(notice: string | null) {
    const next = typeof notice === 'string' && notice.trim().length > 0 ? notice.trim() : null;
    if ((this.state.inactivityNotice ?? null) === next) return;
    this.state = { ...this.state, inactivityNotice: next };
    this.notify();
  }

  setMicFlatlined(flatlined: boolean) {
    const next = Boolean(flatlined);
    if (Boolean(this.state.micFlatlined) === next) return;
    this.state = { ...this.state, micFlatlined: next };
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

  private touchAndPruneVoiceTurnsLru(activeThreadId: string) {
    this.voiceTurnsLruOrder = this.voiceTurnsLruOrder.filter((id) => id !== activeThreadId);
    this.voiceTurnsLruOrder.push(activeThreadId);

    const protectedBoundId = this.state.boundThreadId;
    while (Object.keys(this.turnsByThread).length > MAX_VOICE_HISTORY_THREADS) {
      let evictId: string | undefined;
      for (const candidate of this.voiceTurnsLruOrder) {
        if (candidate !== activeThreadId && candidate !== protectedBoundId) {
          evictId = candidate;
          break;
        }
      }
      if (!evictId) {
        for (const candidate of Object.keys(this.turnsByThread)) {
          if (candidate !== activeThreadId && candidate !== protectedBoundId) {
            evictId = candidate;
            break;
          }
        }
      }
      if (!evictId) break;
      delete this.turnsByThread[evictId];
      this.voiceTurnsLruOrder = this.voiceTurnsLruOrder.filter((id) => id !== evictId);
    }
  }

  getThreadVoiceTurns(threadId: string): VoiceTurnRecord[] {
    if (!threadId) return [];
    if (this.turnsByThread[threadId]) {
      this.touchAndPruneVoiceTurnsLru(threadId);
      return this.turnsByThread[threadId];
    }
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(`kite.voiceTurns.${threadId}`) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.turnsByThread[threadId] = parsed;
          this.touchAndPruneVoiceTurnsLru(threadId);
          return parsed;
        }
      }
    } catch {}
    return [];
  }

  addThreadVoiceTurn(threadId: string, record: VoiceTurnRecord) {
    if (!threadId) return;
    const existing = this.getThreadVoiceTurns(threadId);
    const updated = [...existing.filter((t) => t.turnId !== record.turnId), record];
    this.turnsByThread[threadId] = updated;
    this.touchAndPruneVoiceTurnsLru(threadId);
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

  markTurnInterrupted(
    threadId: string | null | undefined,
    turnId?: string,
    heardText?: string,
    audioEndMs?: number
  ) {
    const targetId = threadId ?? this.state.boundThreadId;
    if (!targetId) return;
    const existing = this.getThreadVoiceTurns(targetId);
    if (existing.length === 0) return;

    const targetTurnId = turnId || existing[existing.length - 1]?.turnId;
    if (!targetTurnId) return;

    const hasAudioEnd = typeof audioEndMs === 'number' && Number.isFinite(audioEndMs);
    const normalizedAudioEndMs = hasAudioEnd ? Math.max(0, Math.round(audioEndMs)) : undefined;
    const trimmedHeard = typeof heardText === 'string' ? heardText.trim() : undefined;
    const shouldTruncateReply =
      trimmedHeard !== undefined && (trimmedHeard.length > 0 || hasAudioEnd);

    let changed = false;
    const updated = existing.map((t) => {
      if (t.turnId !== targetTurnId) return t;
      const nextReply = shouldTruncateReply ? trimmedHeard : t.reply;
      const nextAudioEndMs = hasAudioEnd ? normalizedAudioEndMs : t.audioEndMs;
      if (
        !t.interrupted ||
        nextReply !== t.reply ||
        nextAudioEndMs !== t.audioEndMs
      ) {
        changed = true;
        return {
          ...t,
          interrupted: true,
          reply: nextReply,
          ...(nextAudioEndMs !== undefined ? { audioEndMs: nextAudioEndMs } : {}),
        };
      }
      return t;
    });
    if (!changed) return;

    this.turnsByThread[targetId] = updated;
    this.touchAndPruneVoiceTurnsLru(targetId);
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

  setDraftProposal(
    scopeKey: string | null | undefined,
    proposal: DraftTaskProposal | null
  ) {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    if (!proposal) {
      delete this.draftProposalByScope[key];
      if (this.state.draftProposal) {
        this.state = { ...this.state, draftProposal: null };
        this.notify();
      }
      return;
    }
    this.draftProposalByScope[key] = proposal;
    this.state = { ...this.state, draftProposal: proposal };
    this.notify();
  }

  getDraftProposal(
    scopeKey?: string | null,
    nowMs: number = Date.now()
  ): DraftTaskProposal | null {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    const item = this.draftProposalByScope[key];
    if (!item) return null;
    if (nowMs - item.updatedAt > 300_000 || item.status === 'cancelled' || item.status === 'confirmed') {
      delete this.draftProposalByScope[key];
      return null;
    }
    return item;
  }

  updateDraftProposal(
    scopeKey: string | null | undefined,
    patch: Partial<DraftTaskProposal>
  ): DraftTaskProposal | null {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    const existing = this.draftProposalByScope[key];
    if (!existing) return null;
    const updated: DraftTaskProposal = {
      ...existing,
      ...patch,
      revision: existing.revision + 1,
      updatedAt: Date.now(),
    };
    this.draftProposalByScope[key] = updated;
    this.state = { ...this.state, draftProposal: updated };
    this.notify();
    return updated;
  }

  toggleDraftProposalStep(
    scopeKey: string | null | undefined,
    stepId: string,
    enabled?: boolean
  ): DraftTaskProposal | null {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    const existing = this.draftProposalByScope[key];
    if (!existing || !Array.isArray(existing.steps)) return null;
    const steps = existing.steps.map((step) =>
      step.stepId === stepId
        ? { ...step, enabled: enabled !== undefined ? enabled : !step.enabled }
        : step
    );
    return this.updateDraftProposal(key, { steps });
  }

  updateDraftProposalStep(
    scopeKey: string | null | undefined,
    stepId: string,
    patch: Partial<DraftExecutionStep>
  ): DraftTaskProposal | null {
    const key = scopeKey || this.state.boundThreadId || '__default__';
    const existing = this.draftProposalByScope[key];
    if (!existing || !Array.isArray(existing.steps)) return null;
    const steps = existing.steps.map((step) =>
      step.stepId === stepId ? { ...step, ...patch } : step
    );
    return this.updateDraftProposal(key, { steps });
  }

  clearDraftProposal(scopeKey?: string | null) {
    this.setDraftProposal(scopeKey, null);
  }

  setHandsFreeReplyWindow(durationMs: number, nowMs: number = Date.now()) {
    const until = durationMs > 0 ? nowMs + durationMs : 0;
    if (this.state.handsFreeReplyUntilMs === until) return;
    this.state = { ...this.state, handsFreeReplyUntilMs: until };
    this.notify();
  }

  isInHandsFreeReplyWindow(nowMs: number = Date.now()): boolean {
    return typeof this.state.handsFreeReplyUntilMs === 'number' && this.state.handsFreeReplyUntilMs > nowMs;
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
    this.voiceTurnsLruOrder = this.voiceTurnsLruOrder.filter((id) => id !== threadId);
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
  setMicFlatlined: (flatlined: boolean) => void;
  setActiveTransport: (transport: VoiceTransportKind, provider?: RealtimeProviderId) => void;
  setSpeakerAudioLevel: (level: number) => void;
  upsertLiveTeleprompterUser: (text: string, interim: boolean, seq?: number) => void;
  appendLiveTeleprompterVoice: (
    deltaOrText: string,
    options?: {
      seq?: number;
      utteranceStart?: number;
      utteranceEnd?: number;
      talkerDuration?: number;
      audioSpans?: AudioSpan[];
      replace?: boolean;
    }
  ) => void;
  recordLiveVoiceAudioSpan: (startAt: number, endAt: number, playbackSpeed?: number) => void;
  freezeLiveVoiceSpokenChars: (currentAudioTime: number) => void;
  setProgressUpdatesEnabled: (enabled: boolean) => void;
  setVoiceError: (error: VoiceSessionState['voiceError']) => void;
  setInactivityNotice: (notice: string | null) => void;
  getThreadVoiceTurns: (threadId: string) => VoiceTurnRecord[];
  addThreadVoiceTurn: (threadId: string, record: VoiceTurnRecord) => void;
  clearThreadVoiceTurns: (threadId: string) => void;
  getDraftProposal: (scopeKey?: string | null) => DraftTaskProposal | null;
  setDraftProposal: (scopeKey: string | null | undefined, proposal: DraftTaskProposal | null) => void;
  updateDraftProposal: (scopeKey: string | null | undefined, patch: Partial<DraftTaskProposal>) => DraftTaskProposal | null;
  toggleDraftProposalStep: (scopeKey: string | null | undefined, stepId: string, enabled?: boolean) => DraftTaskProposal | null;
  updateDraftProposalStep: (scopeKey: string | null | undefined, stepId: string, patch: Partial<DraftExecutionStep>) => DraftTaskProposal | null;
  clearDraftProposal: (scopeKey?: string | null) => void;
  setHandsFreeReplyWindow: (durationMs: number) => void;
  isInHandsFreeReplyWindow: () => boolean;
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
    setMicFlatlined: (flatlined) => voiceSessionStore.setMicFlatlined(flatlined),
    setActiveTransport: (transport, provider) =>
      voiceSessionStore.setActiveTransport(transport, provider),
    setSpeakerAudioLevel: (level) => voiceSessionStore.setSpeakerAudioLevel(level),
    upsertLiveTeleprompterUser: (text, interim, seq) =>
      voiceSessionStore.upsertLiveTeleprompterUser(text, interim, seq),
    appendLiveTeleprompterVoice: (deltaOrText, options) =>
      voiceSessionStore.appendLiveTeleprompterVoice(deltaOrText, options),
    recordLiveVoiceAudioSpan: (startAt, endAt, playbackSpeed) =>
      voiceSessionStore.recordLiveVoiceAudioSpan(startAt, endAt, playbackSpeed),
    freezeLiveVoiceSpokenChars: (currentAudioTime) =>
      voiceSessionStore.freezeLiveVoiceSpokenChars(currentAudioTime),
    setProgressUpdatesEnabled: (enabled) => voiceSessionStore.setProgressUpdatesEnabled(enabled),
    setVoiceError: (error) => voiceSessionStore.setVoiceError(error),
    setInactivityNotice: (notice) => voiceSessionStore.setInactivityNotice(notice),
    getThreadVoiceTurns: (threadId) => voiceSessionStore.getThreadVoiceTurns(threadId),
    addThreadVoiceTurn: (threadId, record) => voiceSessionStore.addThreadVoiceTurn(threadId, record),
    clearThreadVoiceTurns: (threadId) => voiceSessionStore.clearThreadVoiceTurns(threadId),
    getDraftProposal: (scopeKey) => voiceSessionStore.getDraftProposal(scopeKey),
    setDraftProposal: (scopeKey, proposal) => voiceSessionStore.setDraftProposal(scopeKey, proposal),
    updateDraftProposal: (scopeKey, patch) => voiceSessionStore.updateDraftProposal(scopeKey, patch),
    toggleDraftProposalStep: (scopeKey, stepId, enabled) =>
      voiceSessionStore.toggleDraftProposalStep(scopeKey, stepId, enabled),
    updateDraftProposalStep: (scopeKey, stepId, patch) =>
      voiceSessionStore.updateDraftProposalStep(scopeKey, stepId, patch),
    clearDraftProposal: (scopeKey) => voiceSessionStore.clearDraftProposal(scopeKey),
    setHandsFreeReplyWindow: (durationMs) => voiceSessionStore.setHandsFreeReplyWindow(durationMs),
    isInHandsFreeReplyWindow: () => voiceSessionStore.isInHandsFreeReplyWindow(),
  };
}
