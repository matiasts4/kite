import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ZedOrb, type ZedOrbState } from './ZedOrb';
import { type OperatorBrainResponse } from '../lib/operator/operatorBrain';
import { ttsNarrator } from '../lib/operator/ttsNarrator';
import {
  loadOperatorConfig,
  sanitizeArgosFigure,
  type ArgosFigureId,
} from '../lib/operator/operatorConfig';
import { useOperatorTurn } from '../lib/operator/hooks/useOperatorTurn';
import { resolveZedOrbState } from '../lib/operator/hooks/useOperatorTurnLogic';
import { isBrowserTestLane } from '../lib/browserTestLane';
import { useOperatorVoice } from '../lib/operator/hooks/useOperatorVoice';
import {
  releaseOperatorCapture,
  armBargeInMonitor,
  disarmBargeInMonitor,
} from '../lib/operator/voice/zedVoice';
import { subscribeNativeAudioEvents } from '../lib/operator/voice/nativeAudioBridge';
import { voiceTurnArbitrator } from '../lib/operator/voice/turnArbitrator';
import { SpeechSentenceQueue } from '../lib/operator/voice/speechProsody';
import { voiceSessionStore, useVoiceSession } from '../lib/operator/voice/voiceSessionStore';
import {
  playVoiceConnectCue,
  playVoiceDisconnectCue,
  playVoiceErrorCue,
  playVoiceReadyCue,
  startVoiceReconnectPulse,
} from '../lib/operator/voice/voiceSoundCues';
import {
  createPcm24kPlayer,
  registerActiveVoiceAudioTimingGetter,
  type Pcm24kPlayer,
} from '../lib/operator/voice/pcm24kPlayer';
import { RealtimeVoiceBridge } from '../lib/operator/voice/realtimeBridge';
import { VoiceInactivityAutoSleepGuard } from '../lib/operator/voice/callResilience';
import {
  DEFAULT_REALTIME_ENDPOINTS,
  DEFAULT_VOICE_IDLE_TIMEOUT_SEC,
} from '../lib/operator/config/storage';
import { getVoicePalette } from '../lib/operator/config/voicePalettes';
import { readUnifiedAudioSettings } from '../lib/operator/voice/audioSettingsSync';
import { ensureVoiceCallReceiptsHook } from '../lib/operator/voice/voiceCallReceipts';
import { isTauriEnvironment } from '../lib/ipc';
import { startProactiveAgentWatcher } from '../lib/operator/proactiveWatcher';
import { startSubagentReturnWatcher } from '../lib/operator/subagentReturnWatcher';
import { getTurnTrace, type TraceEvent } from '../lib/operator/trace/trace';
import { isTerminalTarget } from '../lib/shortcuts/useGlobalShortcuts';
import { ConsultativeDraftCard } from './views/chat/ConsultativeDraftCard';
import './argosFloat.css';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ArgosToolCallItem {
  id: string;
  name: string;
  summary: string;
  ok: boolean;
  latencyMs?: number;
}

export type ZedToolCallItem = ArgosToolCallItem;

export interface PendingConfirmation {
  id: string;
  summary: string;
  toolName: string;
}

export interface ArgosCallState {
  isActive: boolean;
  status: string;
  orbState?: ZedOrbState;
  statusLine?: string;
  lastError?: string | null;
  muted?: boolean;
  speakerMuted?: boolean;
  toolCalls: ArgosToolCallItem[];
  pendingConfirmation?: PendingConfirmation | null;
}

export type ZedCallState = ArgosCallState;

export interface ArgosStripProps {
  call: ArgosCallState;
  workspaceId?: string | null;
  hideFloatingOrb?: boolean;
  getAudioLevel?: () => number;
  onToggleMute?: () => void;
  onToggleSpeaker?: () => void;
  onEndCall?: () => void;
  onApproveConfirmation?: () => void;
  onCancelConfirmation?: () => void;
  onOpenSettingsZed?: () => void;
  onExecuteCommand?: (input: string) => Promise<OperatorBrainResponse | void>;
}

export type ZedStripProps = ArgosStripProps;

// ── Constants & Helpers ──────────────────────────────────────────────────────

export const POST_TTS_ECHO_GUARD_MS = 180;
const DEFAULT_HANDS_FREE_REPLY_WINDOW_MS = 12_000;
const FLOAT_POS_STORAGE_KEY = 'kite.assistant.floatPos.v5';
const DRAG_THRESHOLD_PX = 4;

interface FloatPoint {
  x: number;
  y: number;
}

function clampPoint(x: number, y: number): FloatPoint {
  const margin = 16;
  const topMin = 40;
  const orbSize = 72;
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const maxX = Math.max(margin, winW - orbSize - margin);
  const maxY = Math.max(topMin, winH - orbSize - margin - 50);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(topMin, y)),
  };
}

function loadSavedPoint(): FloatPoint {
  try {
    const raw = localStorage.getItem(FLOAT_POS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FloatPoint>;
      if (
        typeof parsed?.x === 'number' &&
        Number.isFinite(parsed.x) &&
        typeof parsed?.y === 'number' &&
        Number.isFinite(parsed.y)
      ) {
        const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
        return clampPoint(parsed.x * winW, parsed.y * winH);
      }
    }
  } catch {
    // ignore
  }
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  return clampPoint(winW - 120, 64);
}

function savePoint(pos: FloatPoint): void {
  try {
    const x = window.innerWidth > 0 ? pos.x / window.innerWidth : 0;
    const y = window.innerHeight > 0 ? pos.y / window.innerHeight : 0;
    localStorage.setItem(FLOAT_POS_STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    // ignore
  }
}

function isHandsFreeReplyActive(): boolean {
  const latest = voiceSessionStore.getSnapshot();
  return (
    latest.draftProposal?.status === 'awaiting_confirmation' ||
    voiceSessionStore.isInHandsFreeReplyWindow()
  );
}

function publishCascadedTeleprompterReply(
  reply: string,
  opts: { willSpeakTts: boolean; rate?: number }
): void {
  const trimmed = (reply || '').trim();
  if (!trimmed) return;
  if (opts.willSpeakTts) {
    const safeRate = Math.max(0.5, opts.rate || 1);
    voiceSessionStore.appendLiveTeleprompterVoice(reply, {
      replace: true,
      utteranceStart: Date.now() / 1000,
      talkerDuration: Math.max(0.8, reply.length / (14.5 * safeRate)),
    });
    return;
  }
  voiceSessionStore.appendLiveTeleprompterVoice(reply, {
    replace: true,
    spokenChars: reply.length,
  });
}

// ── ArgosStrip Component ─────────────────────────────────────────────────────

export const ArgosStrip: React.FC<ArgosStripProps> = ({
  call,
  workspaceId,
  hideFloatingOrb = false,
  getAudioLevel,
  onToggleMute,
  onToggleSpeaker,
  onEndCall,
  onApproveConfirmation,
  onCancelConfirmation,
  onExecuteCommand,
}) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const orbContainerRef = useRef<HTMLDivElement | null>(null);
  const voiceSession = useVoiceSession();

  const [point, setPoint] = useState<FloatPoint>(loadSavedPoint);
  const pointRef = useRef<FloatPoint>(point);
  useEffect(() => {
    pointRef.current = point;
  }, [point]);

  const [isDragging, setIsDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [manualInputValue, setManualInputValue] = useState('');
  const [speakingTts, setSpeakingTts] = useState(false);
  const [orbAck, setOrbAck] = useState(false);
  const [orbPulseKey, setOrbPulseKey] = useState(0);
  const [configuredFigure, setConfiguredFigure] = useState<ArgosFigureId>(() =>
    sanitizeArgosFigure(loadOperatorConfig().persona?.figure)
  );

  useEffect(() => {
    const syncFigure = (event?: Event) => {
      const detail = (event as CustomEvent<{ persona?: { figure?: string } }> | undefined)?.detail;
      const next = detail?.persona?.figure ?? loadOperatorConfig().persona?.figure;
      setConfiguredFigure(sanitizeArgosFigure(next));
    };
    window.addEventListener('kite:operator-config-updated', syncFigure);
    window.addEventListener('kite:operator-config-changed', syncFigure);
    return () => {
      window.removeEventListener('kite:operator-config-updated', syncFigure);
      window.removeEventListener('kite:operator-config-changed', syncFigure);
    };
  }, []);

  useEffect(() => {
    let timer = 0;
    const onAck = () => {
      setOrbAck(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setOrbAck(false), 180);
    };
    window.addEventListener('kite:argos-orb-ack', onAck);
    window.addEventListener('kite:zed-orb-ack', onAck);
    return () => {
      window.removeEventListener('kite:argos-orb-ack', onAck);
      window.removeEventListener('kite:zed-orb-ack', onAck);
      window.clearTimeout(timer);
    };
  }, []);

  const [manualCommandResult, setManualCommandResult] = useState<{
    reply: string;
    latencyMs?: number;
    ok?: boolean;
  } | null>(null);

  const browserTestUi = isBrowserTestLane();

  // Hook for unified turn execution & lifecycle (memoized return keeps store subscription stable)
  const turn = useOperatorTurn(workspaceId ?? null);

  // Voice dictation hook (Grok Cloud / Native Speech Engine)
  const [isVoiceSessionActive, setIsVoiceSessionActive] = useState(false);
  const isVoiceSessionActiveRef = useRef(false);
  const lastSpokenTurnKeyRef = useRef<string | null>(null);
  const activeSpokenTurnRef = useRef<{ threadId: string | null; turnId?: string } | null>(null);
  const activeSpeechQueueRef = useRef<SpeechSentenceQueue | null>(null);
  const consecutiveEmptyCapturesRef = useRef(0);
  const prevListeningRef = useRef(false);
  const prevMutedOrPausedRef = useRef(false);
  const postSpeechRearmTimerRef = useRef<number | null>(null);

  const cancelPostSpeechRearm = useCallback(() => {
    if (postSpeechRearmTimerRef.current !== null) {
      window.clearTimeout(postSpeechRearmTimerRef.current);
      postSpeechRearmTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelPostSpeechRearm();
    };
  }, [cancelPostSpeechRearm]);

  useEffect(() => {
    isVoiceSessionActiveRef.current = isVoiceSessionActive;
    if (typeof window !== 'undefined') {
      (window as any).__kiteVoiceSessionActive = isVoiceSessionActive;
    }
    return () => {
      if (typeof window !== 'undefined') {
        (window as any).__kiteVoiceSessionActive = false;
      }
    };
  }, [isVoiceSessionActive]);

  const recordThreadVoiceTurn = useCallback(
    (
      targetThreadId: string | null | undefined,
      userPrompt: string,
      source: 'voz' | 'texto',
      res: any,
      createdAt?: number
    ) => {
      if (!targetThreadId || !res) return;
      const trace = getTurnTrace(res.turnId);
      const planEv = trace?.events?.find((e: TraceEvent) => e.ev === 'plan.created') as any;
      const consultChatsInfo =
        planEv?.chatReachKind && planEv.chatReachKind !== 'none'
          ? {
              kind: planEv.chatReachKind,
              text: planEv.chatReachText,
            }
          : undefined;

      const now = Date.now();
      const startedAt = createdAt ?? now;
      const completedAt = Math.max(startedAt + 1, now);

      voiceSessionStore.addThreadVoiceTurn(targetThreadId, {
        turnId: res.turnId,
        userPrompt,
        source,
        strategy: res.strategy,
        providerId: res.providerId,
        modelId: planEv?.model,
        durationMs: res.durationMs,
        overallSuccess: res.overallSuccess,
        receipts: res.receipts,
        consultChatsInfo,
        reply: res.reply,
        createdAt: startedAt,
        completedAt,
      });
    },
    []
  );

  const callSpeakerMutedRef = useRef(Boolean(call.speakerMuted));
  callSpeakerMutedRef.current = Boolean(call.speakerMuted);

  const canRearmVoiceSessionMic = useCallback(() => {
    const latest = voiceSessionStore.getSnapshot();
    const sessionActive =
      isVoiceSessionActiveRef.current ||
      latest.phase === 'active' ||
      latest.phase === 'starting';
    const handsFree = isHandsFreeReplyActive();
    if (!sessionActive && !handsFree) return false;
    return (
      !latest.micMuted &&
      !latest.isPausedForDictation &&
      !voiceRef.current.isListening &&
      !voiceRef.current.isTranscribing &&
      !voiceRef.current.isFatalError
    );
  }, []);

  const canRearmVoiceSessionMicRef = useRef(canRearmVoiceSessionMic);
  canRearmVoiceSessionMicRef.current = canRearmVoiceSessionMic;

  /**
   * Consolidates all post-TTS microphone re-arming through a single debounced 180 ms
   * anti-echo settle guard so speaker playback never triggers phantom captures or races.
   */
  const schedulePostSpeechRearm = useCallback(
    (delayMs: number = POST_TTS_ECHO_GUARD_MS) => {
      cancelPostSpeechRearm();
      const latestBefore = voiceSessionStore.getSnapshot();
      if (
        latestBefore.draftProposal?.status === 'awaiting_confirmation' &&
        !voiceSessionStore.isInHandsFreeReplyWindow()
      ) {
        voiceSessionStore.setHandsFreeReplyWindow(DEFAULT_HANDS_FREE_REPLY_WINDOW_MS);
      }
      if (!canRearmVoiceSessionMicRef.current()) {
        return;
      }
      if (isHandsFreeReplyActive()) {
        consecutiveEmptyCapturesRef.current = 0;
      }
      const waitMs = Math.max(0, delayMs);
      const runRearm = () => {
        postSpeechRearmTimerRef.current = null;
        if (!canRearmVoiceSessionMicRef.current()) return;
        const latestNow = voiceSessionStore.getSnapshot();
        const handsFreeNow = isHandsFreeReplyActive();
        if (handsFreeNow) {
          consecutiveEmptyCapturesRef.current = 0;
          if (!latestNow.speakerMuted && !callSpeakerMutedRef.current) {
            playVoiceReadyCue(loadOperatorConfig().voiceVolume ?? 100);
          }
        }
        void voiceRef.current.startListening({
          continuous: isVoiceSessionActiveRef.current,
        });
      };

      if (waitMs === 0) {
        runRearm();
        return;
      }
      postSpeechRearmTimerRef.current = window.setTimeout(runRearm, waitMs);
    },
    [cancelPostSpeechRearm]
  );

  const schedulePostSpeechRearmRef = useRef(schedulePostSpeechRearm);
  schedulePostSpeechRearmRef.current = schedulePostSpeechRearm;

  const configuredLang =
    loadOperatorConfig().persona?.language === 'en' ? 'en-US' : 'es-ES';

  const pcmPlayerRef = useRef<Pcm24kPlayer | null>(null);
  const realtimeBridgeRef = useRef<RealtimeVoiceBridge | null>(null);
  const realtimeActiveRef = useRef(false);
  const realtimeAudioLevelUnsubRef = useRef<(() => void) | null>(null);
  const realtimeActiveTurnRef = useRef<{
    turnId: string;
    userPrompt: string;
    createdAt: number;
    replyAcc: string;
  } | null>(null);
  const autoSleepGuardRef = useRef<VoiceInactivityAutoSleepGuard | null>(null);
  const reconnectPulseStopRef = useRef<(() => void) | null>(null);
  const turnBusyRef = useRef(false);
  const speakingTtsRef = useRef(false);
  const startVoiceTransportRef = useRef<(mutedNow: boolean) => void>(() => {});

  const touchAutoSleep = useCallback((reason?: string) => {
    autoSleepGuardRef.current?.touch(reason);
  }, []);

  const getOrCreatePcmPlayer = useCallback((): Pcm24kPlayer => {
    if (!pcmPlayerRef.current) {
      const cfg = loadOperatorConfig();
      const player = createPcm24kPlayer((cfg.voiceVolume ?? 100) / 100);
      player.setPlaybackRate(cfg.ttsRate || 1);
      pcmPlayerRef.current = player;
      registerActiveVoiceAudioTimingGetter(() => pcmPlayerRef.current?.getTiming().currentTime ?? 0);
    }
    return pcmPlayerRef.current;
  }, []);

  const voice = useOperatorVoice({
    language: configuredLang,
    onFinalTranscript: async (text) => {
      if (!text || text.trim().length === 0) return;
      consecutiveEmptyCapturesRef.current = 0;
      touchAutoSleep('voice-final');
      voiceSessionStore.setVoiceError(null);
      voiceSessionStore.upsertLiveTeleprompterUser(text, false);
      if (onExecuteCommand) {
        const res = await onExecuteCommand(text);
        if (res) {
          setManualCommandResult({
            reply: res.reply,
            latencyMs: res.latencyMs,
            ok: true,
          });
        }
      } else {
        const vsBefore = voiceSessionStore.getSnapshot();
        const targetThreadId = vsBefore.boundThreadId;
        const effectiveMode =
          vsBefore.activeSurface === 'thread' || Boolean(targetThreadId) ? 'thread' : 'code';
        const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const startedAt = Date.now();

        // T20: Immediately project the user's spoken prompt into the thread timeline and clear
        // the composer textarea so long LLM turns never look frozen or unsent.
        if (targetThreadId) {
          voiceSessionStore.addThreadVoiceTurn(targetThreadId, {
            turnId,
            userPrompt: text,
            source: 'voz',
            createdAt: startedAt,
          });
          voiceRef.current.clearTranscript();
          voiceSessionStore.setVoiceRuntimeState({ interimTranscript: '' });
        }

        try {
          const opConfig = loadOperatorConfig();
          const speakerMutedNow = call.speakerMuted || vsBefore.speakerMuted;
          let streamedQueue: SpeechSentenceQueue | null = null;
          let streamedAnySentence = false;

          if (!speakerMutedNow) {
            streamedQueue = new SpeechSentenceQueue({
              onFirstSentence: () => {
                streamedAnySentence = true;
                activeSpokenTurnRef.current = { threadId: targetThreadId, turnId };
                setSpeakingTts(true);
                voiceTurnArbitrator.transition('speaking');
              },
              speakSentence: async (sentence, idx) => {
                await ttsNarrator.speak(sentence, {
                  voiceName: opConfig.persona?.voice || 'Ara',
                  rate: opConfig.ttsRate || 1.0,
                  lang: opConfig.persona?.language === 'en' ? 'en-US' : 'es-ES',
                  turnId: idx === 0 ? turnId : undefined,
                  turnStartedAt: idx === 0 ? startedAt : undefined,
                });
              },
              onComplete: () => {
                if (activeSpeechQueueRef.current === streamedQueue) {
                  activeSpeechQueueRef.current = null;
                }
                if (streamedAnySentence) {
                  setSpeakingTts(false);
                  voiceTurnArbitrator.transition(
                    isVoiceSessionActiveRef.current || isHandsFreeReplyActive() ? 'listening' : 'idle'
                  );
                  schedulePostSpeechRearmRef.current(POST_TTS_ECHO_GUARD_MS);
                }
              },
            });
            activeSpeechQueueRef.current = streamedQueue;
          }

          voiceTurnArbitrator.transition('thinking');
          const res = await turn.runTurn(text, {
            turnId,
            source: 'voz',
            workspaceId,
            mode: effectiveMode,
            onStreamSentence: streamedQueue
              ? (sentence) => {
                  streamedQueue?.enqueue(sentence);
                }
              : undefined,
          });
          if (streamedQueue) {
            if (streamedAnySentence) {
              lastSpokenTurnKeyRef.current = `turn-${res.turnId || res.reply}`;
              void streamedQueue.close();
            } else {
              streamedQueue.abort();
              if (activeSpeechQueueRef.current === streamedQueue) {
                activeSpeechQueueRef.current = null;
              }
            }
          }
          const resolvedThreadId = targetThreadId || voiceSessionStore.getSnapshot().boundThreadId;
          if (res?.reply && !realtimeActiveRef.current) {
            const opCfg = loadOperatorConfig();
            const willSpeakTts =
              opCfg.ttsEnabled !== false &&
              !callSpeakerMutedRef.current &&
              !voiceSessionStore.getSnapshot().speakerMuted;
            publishCascadedTeleprompterReply(`${res.reply}`, {
              willSpeakTts,
              rate: opCfg.ttsRate || 1.0,
            });
          }
          recordThreadVoiceTurn(resolvedThreadId, text, 'voz', res, startedAt);
        } catch (err) {
          activeSpeechQueueRef.current?.abort();
          activeSpeechQueueRef.current = null;
          voiceTurnArbitrator.transition('idle');
          const message =
            err instanceof Error ? err.message : 'No se pudo ejecutar la orden.';
          setManualCommandResult({ reply: message, ok: false });
          const resolvedThreadId = targetThreadId || voiceSessionStore.getSnapshot().boundThreadId;
          if (resolvedThreadId) {
            voiceSessionStore.addThreadVoiceTurn(resolvedThreadId, {
              turnId,
              userPrompt: text,
              source: 'voz',
              overallSuccess: false,
              reply: message,
              createdAt: startedAt,
              completedAt: Math.max(startedAt + 1, Date.now()),
            });
          }
        }
      }
    },
  });

  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  turnBusyRef.current = Boolean(turn.busy);
  speakingTtsRef.current = Boolean(speakingTts);

  useEffect(() => {
    ensureVoiceCallReceiptsHook();
    if (!autoSleepGuardRef.current) {
      autoSleepGuardRef.current = new VoiceInactivityAutoSleepGuard({
        timeoutSec: loadOperatorConfig().voiceIdleTimeoutSec ?? DEFAULT_VOICE_IDLE_TIMEOUT_SEC,
        isBusy: () => Boolean(turnBusyRef.current || speakingTtsRef.current || voiceRef.current.isTranscribing),
        onTimeout: () => {
          voiceSessionStore.setInactivityNotice(
            'Sesión en pausa automática por inactividad para proteger tu cuota de audio.'
          );
          voiceSessionStore.stopSession();
        },
      });
    }
    const syncAudioConfig = () => {
      const cfg = loadOperatorConfig();
      pcmPlayerRef.current?.setVolume((cfg.voiceVolume ?? 100) / 100);
      pcmPlayerRef.current?.setPlaybackRate(cfg.ttsRate || 1);
      autoSleepGuardRef.current?.setTimeoutSec(
        cfg.voiceIdleTimeoutSec ?? DEFAULT_VOICE_IDLE_TIMEOUT_SEC
      );
    };
    window.addEventListener('kite:operator-config-updated', syncAudioConfig);
    return () => {
      window.removeEventListener('kite:operator-config-updated', syncAudioConfig);
      reconnectPulseStopRef.current?.();
      reconnectPulseStopRef.current = null;
      autoSleepGuardRef.current?.stop();
      realtimeActiveRef.current = false;
      realtimeAudioLevelUnsubRef.current?.();
      realtimeAudioLevelUnsubRef.current = null;
      realtimeActiveTurnRef.current = null;
      void realtimeBridgeRef.current?.disconnect();
      realtimeBridgeRef.current = null;
      registerActiveVoiceAudioTimingGetter(null);
      pcmPlayerRef.current?.close();
      pcmPlayerRef.current = null;
    };
  }, []);

  startVoiceTransportRef.current = (mutedNow: boolean) => {
    const cfg = loadOperatorConfig();
    const shouldTryRealtime = cfg.voiceTransportMode === 'realtime' && isTauriEnvironment();
    if (!shouldTryRealtime) {
      realtimeActiveRef.current = false;
      voiceSessionStore.setActiveTransport('cascaded');
      if (!voiceRef.current.isListening && !voiceRef.current.isFatalError && !mutedNow) {
        void voiceRef.current.startListening({ continuous: true });
      }
      return;
    }

    const provider = cfg.realtimeProvider ?? 'xai';
    const endpoint = cfg.realtimeEndpoint?.trim() || DEFAULT_REALTIME_ENDPOINTS[provider];
    const apiKey =
      provider === 'gemini_live'
        ? cfg.geminiLiveApiKey
        : provider === 'openai'
        ? cfg.openaiRealtimeApiKey
        : cfg.grokApiKey;
    const preset = getVoicePalette(cfg.persona?.voice);
    const providerVoice =
      provider === 'gemini_live'
        ? preset.providerHints.geminiLive
        : provider === 'openai'
        ? preset.providerHints.openai
        : preset.providerHints.xai;
    const { micDeviceId } = readUnifiedAudioSettings();

    voiceSessionStore.setActiveTransport('realtime', provider);
    reconnectPulseStopRef.current?.();
    reconnectPulseStopRef.current = startVoiceReconnectPulse(
      () => Boolean(voiceSessionStore.getSnapshot().speakerMuted || callSpeakerMutedRef.current),
      cfg.voiceVolume ?? 100
    );

    const bridge = new RealtimeVoiceBridge({
      onTransportFallback: () => {
        reconnectPulseStopRef.current?.();
        reconnectPulseStopRef.current = null;
        realtimeAudioLevelUnsubRef.current?.();
        realtimeAudioLevelUnsubRef.current = null;
        realtimeActiveTurnRef.current = null;
        realtimeActiveRef.current = false;
        voiceSessionStore.setActiveTransport('cascaded');
        const latestNow = voiceSessionStore.getSnapshot();
        if (
          isVoiceSessionActiveRef.current &&
          !latestNow.micMuted &&
          !latestNow.isPausedForDictation &&
          !voiceRef.current.isListening &&
          !voiceRef.current.isFatalError
        ) {
          void voiceRef.current.startListening({ continuous: true });
        }
      },
      onAudioDelta: (delta, sampleRate) => {
        touchAutoSleep('realtime-audio');
        const player = getOrCreatePcmPlayer();
        const span = player.enqueuePcm24k(delta, sampleRate || 24000);
        const latestRate = loadOperatorConfig().ttsRate || 1;
        if (span) {
          voiceSessionStore.recordLiveVoiceAudioSpan(span.startAt, span.endAt, latestRate);
        }
        voiceSessionStore.setVoiceRuntimeState({ isSpeaking: true });
        voiceSessionStore.setSpeakerAudioLevel(player.getSpeakerLevel());
      },
      onTranscript: (ev) => {
        if (typeof ev.type === 'string' && ev.type.includes('input_audio_transcription')) {
          return;
        }
        const chunk = typeof ev.delta === 'string' ? ev.delta : typeof ev.text === 'string' ? ev.text : '';
        const replace = Boolean(ev.text && !ev.delta);
        if (chunk) {
          voiceSessionStore.appendLiveTeleprompterVoice(chunk, { replace });
          if (realtimeActiveTurnRef.current) {
            realtimeActiveTurnRef.current.replyAcc = replace
              ? chunk
              : `${realtimeActiveTurnRef.current.replyAcc}${chunk}`;
          }
        }
        if (typeof ev.type === 'string' && ev.type.includes('done')) {
          voiceSessionStore.setVoiceRuntimeState({ isSpeaking: false });
          const activeRt = realtimeActiveTurnRef.current;
          const boundTid = voiceSessionStore.getSnapshot().boundThreadId;
          if (activeRt && boundTid && activeRt.replyAcc.trim()) {
            voiceSessionStore.addThreadVoiceTurn(boundTid, {
              turnId: activeRt.turnId,
              userPrompt: activeRt.userPrompt,
              source: 'voz',
              strategy: 'realtime',
              overallSuccess: true,
              reply: activeRt.replyAcc.trim(),
              createdAt: activeRt.createdAt,
              completedAt: Math.max(activeRt.createdAt + 1, Date.now()),
            });
            realtimeActiveTurnRef.current = null;
          }
        }
      },
      onClearAudio: () => {
        const player = pcmPlayerRef.current;
        const currentTime = player ? player.getTiming().currentTime : 0;
        player?.clearWithRamp(20);
        voiceSessionStore.freezeLiveVoiceSpokenChars(currentTime);
        voiceSessionStore.setVoiceRuntimeState({ isSpeaking: false });
        voiceSessionStore.setSpeakerAudioLevel(0);
      },
      onUserSpeech: (ev) => {
        touchAutoSleep('realtime-user-speech');
        if (ev.text || !ev.interim) {
          const fullText = voiceSessionStore.upsertLiveTeleprompterUser(ev.text, ev.interim, {
            append: Boolean(ev.delta),
          });
          voiceSessionStore.setVoiceRuntimeState({
            interimTranscript: ev.interim ? fullText : '',
          });
          if (fullText) {
            voiceSessionStore.setVoiceError(null);
          }
          if (!ev.interim && fullText) {
            const snap = voiceSessionStore.getSnapshot();
            if (snap.boundThreadId) {
              const turnId = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              const createdAt = Date.now();
              realtimeActiveTurnRef.current = {
                turnId,
                userPrompt: fullText,
                createdAt,
                replyAcc: '',
              };
              voiceSessionStore.addThreadVoiceTurn(snap.boundThreadId, {
                turnId,
                userPrompt: fullText,
                source: 'voz',
                strategy: 'realtime',
                createdAt,
              });
            }
          }
        }
      },
      onStatusError: (errMsg) => {
        reconnectPulseStopRef.current?.();
        reconnectPulseStopRef.current = null;
        playVoiceErrorCue(loadOperatorConfig().voiceVolume ?? 100);
        voiceSessionStore.setVoiceError({
          message: errMsg,
          at: Date.now(),
          retryable: true,
          openPrivacySettings: /perm|mic|access|deni/i.test(errMsg),
        });
      },
      onHangUp: () => {
        voiceSessionStore.stopSession();
      },
    });
    realtimeBridgeRef.current = bridge;

    void bridge
      .connect({
        provider,
        apiKey,
        endpoint,
        voice: providerVoice,
        instructions:
          'Eres Argos, asistente de voz en Kite Code. Responde breve en voz alta y delega tareas largas de código con call_thinker_agent sin bloquear la conversación.',
        deviceId: micDeviceId || null,
      })
      .then(async (res) => {
        reconnectPulseStopRef.current?.();
        reconnectPulseStopRef.current = null;
        if (!isVoiceSessionActiveRef.current) {
          void bridge.disconnect();
          return;
        }
        if (res.activeTransport === 'realtime') {
          realtimeActiveRef.current = true;
          voiceSessionStore.setActiveTransport('realtime', res.provider ?? provider);
          realtimeAudioLevelUnsubRef.current?.();
          realtimeAudioLevelUnsubRef.current = await subscribeNativeAudioEvents({
            onAudioLevel: (lvl) => {
              if (!realtimeActiveRef.current) return;
              voiceSessionStore.setLiveAudioLevel(lvl);
            },
          });
          if (!isVoiceSessionActiveRef.current) {
            realtimeAudioLevelUnsubRef.current?.();
            realtimeAudioLevelUnsubRef.current = null;
            void bridge.disconnect();
            return;
          }
          void bridge.subscribeEvents(() => {
            const snap = voiceSessionStore.getSnapshot();
            return {
              workspaceId: workspaceId ?? undefined,
              mode: snap.boundThreadId ? 'thread' : 'code',
              boundThreadId: snap.boundThreadId ?? undefined,
              voiceSessionActive: true,
            };
          });
          const snap = voiceSessionStore.getSnapshot();
          if (snap.micMuted || snap.isPausedForDictation) {
            void bridge.setMuted(true);
          }
        }
      });
  };

  // Register hybrid text turn executor so Thread Voice Mode text inputs share the exact same
  // 14-turn memory, planner, TTS playback, and mic re-arming loop.
  useEffect(() => {
    voiceSessionStore.registerTextTurnExecutor(async (text, threadId, wsId) => {
      touchAutoSleep('text-turn');
      voiceSessionStore.upsertLiveTeleprompterUser(text, false);
      if (voiceRef.current.isListening) {
        voiceRef.current.stopListening();
      }
      const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const startedAt = Date.now();
      if (threadId) {
        voiceSessionStore.addThreadVoiceTurn(threadId, {
          turnId,
          userPrompt: text,
          source: 'texto',
          createdAt: startedAt,
        });
      }
      try {
        const res = await turn.runTurn(text, {
          turnId,
          source: 'texto',
          workspaceId: wsId ?? workspaceId,
          mode: 'thread',
        });
        if (res?.reply && !realtimeActiveRef.current) {
          const opCfg = loadOperatorConfig();
          const willSpeakTts =
            opCfg.ttsEnabled !== false &&
            !callSpeakerMutedRef.current &&
            !voiceSessionStore.getSnapshot().speakerMuted;
          publishCascadedTeleprompterReply(res.reply, {
            willSpeakTts,
            rate: opCfg.ttsRate || 1.0,
          });
        }
        recordThreadVoiceTurn(threadId, text, 'texto', res, startedAt);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'No se pudo ejecutar la orden.';
        if (threadId) {
          voiceSessionStore.addThreadVoiceTurn(threadId, {
            turnId,
            userPrompt: text,
            source: 'texto',
            overallSuccess: false,
            reply: message,
            createdAt: startedAt,
            completedAt: Math.max(startedAt + 1, Date.now()),
          });
        }
        throw err;
      }
    });
    return () => {
      voiceSessionStore.registerTextTurnExecutor(null);
    };
  }, [recordThreadVoiceTurn, turn, workspaceId]);

  useEffect(() => {
    const syncFromStore = () => {
      const vs = voiceSessionStore.getSnapshot();
      const shouldBeActive = vs.phase === 'active' || vs.phase === 'starting';
      const nowMutedOrPaused = vs.isPausedForDictation || vs.micMuted;
      const wasMutedOrPaused = prevMutedOrPausedRef.current;
      prevMutedOrPausedRef.current = nowMutedOrPaused;

      if (shouldBeActive && !isVoiceSessionActiveRef.current) {
        consecutiveEmptyCapturesRef.current = 0;
        setIsVoiceSessionActive(true);
        isVoiceSessionActiveRef.current = true;
        if (typeof window !== 'undefined') {
          (window as any).__kiteVoiceSessionActive = true;
        }
        turn.resetStage();
        if (!vs.speakerMuted && !callSpeakerMutedRef.current) {
          playVoiceConnectCue(loadOperatorConfig().voiceVolume ?? 100);
        }
        autoSleepGuardRef.current?.start();
        startVoiceTransportRef.current(nowMutedOrPaused);
      } else if (!shouldBeActive && isVoiceSessionActiveRef.current) {
        consecutiveEmptyCapturesRef.current = 0;
        cancelPostSpeechRearm();
        setIsVoiceSessionActive(false);
        isVoiceSessionActiveRef.current = false;
        if (typeof window !== 'undefined') {
          (window as any).__kiteVoiceSessionActive = false;
        }
        autoSleepGuardRef.current?.stop();
        reconnectPulseStopRef.current?.();
        reconnectPulseStopRef.current = null;
        realtimeActiveRef.current = false;
        realtimeAudioLevelUnsubRef.current?.();
        realtimeAudioLevelUnsubRef.current = null;
        realtimeActiveTurnRef.current = null;
        void realtimeBridgeRef.current?.disconnect();
        realtimeBridgeRef.current = null;
        pcmPlayerRef.current?.clearWithRamp(20);
        voiceSessionStore.setSpeakerAudioLevel(0);
        if (!vs.speakerMuted && !callSpeakerMutedRef.current) {
          playVoiceDisconnectCue(loadOperatorConfig().voiceVolume ?? 100);
        }
        disarmBargeInMonitor();
        activeSpeechQueueRef.current?.abort();
        activeSpeechQueueRef.current = null;
        voiceRef.current.stopListening({ release: true });
        ttsNarrator.stop();
        setSpeakingTts(false);
        voiceTurnArbitrator.transition('idle');
      } else if (shouldBeActive) {
        if (realtimeActiveRef.current && nowMutedOrPaused !== wasMutedOrPaused) {
          void realtimeBridgeRef.current?.setMuted(nowMutedOrPaused);
        }
        if (nowMutedOrPaused) {
          cancelPostSpeechRearm();
          disarmBargeInMonitor();
          if (voiceRef.current.isListening) {
            voiceRef.current.stopListening({ release: true });
          } else if (!realtimeActiveRef.current) {
            void releaseOperatorCapture();
          }
        } else if (
          wasMutedOrPaused &&
          !realtimeActiveRef.current &&
          !voiceRef.current.isListening &&
          !voiceRef.current.isTranscribing &&
          !voiceRef.current.isFatalError &&
          !turn.busy &&
          !speakingTts
        ) {
          consecutiveEmptyCapturesRef.current = 0;
          void voiceRef.current.startListening({ continuous: true });
        }
        if (vs.speakerMuted) {
          pcmPlayerRef.current?.clearWithRamp(20);
          voiceSessionStore.setSpeakerAudioLevel(0);
        }
        if (vs.speakerMuted && speakingTts) {
          activeSpeechQueueRef.current?.abort();
          activeSpeechQueueRef.current = null;
          ttsNarrator.stop();
          setSpeakingTts(false);
          voiceTurnArbitrator.transition('listening');
        }
      }
    };

    syncFromStore();
    return voiceSessionStore.subscribe(syncFromStore);
  }, [speakingTts, turn, cancelPostSpeechRearm]);

  // Track consecutive empty silence captures so continuous mode backs off calmly instead of spinning
  useEffect(() => {
    const wasListening = prevListeningRef.current;
    prevListeningRef.current = voice.isListening;
    if (
      wasListening &&
      !voice.isListening &&
      !voice.isTranscribing &&
      !turn.busy &&
      !voice.transcript.trim() &&
      !voice.error
    ) {
      if (isHandsFreeReplyActive()) {
        consecutiveEmptyCapturesRef.current = 0;
      } else {
        consecutiveEmptyCapturesRef.current += 1;
      }
    }
  }, [voice.isListening, voice.isTranscribing, voice.transcript, voice.error, turn.busy]);

  // Continuous listening loop: re-arm microphone with calm backoff on silence and stop on fatal STT errors
  useEffect(() => {
    if (!isVoiceSessionActive || realtimeActiveRef.current) return;
    if (postSpeechRearmTimerRef.current !== null) return;
    if (voice.isListening || voice.isTranscribing || turn.busy || speakingTts || voice.error || voice.isFatalError) {
      return;
    }
    const vs = voiceSessionStore.getSnapshot();
    if (vs.micMuted || vs.isPausedForDictation || (vs.phase !== 'active' && vs.phase !== 'starting')) {
      return;
    }

    if (isHandsFreeReplyActive()) {
      consecutiveEmptyCapturesRef.current = 0;
    }

    const delayMs =
      consecutiveEmptyCapturesRef.current > 0
        ? Math.min(3200, 1200 + (consecutiveEmptyCapturesRef.current - 1) * 400)
        : 350;

    const timer = window.setTimeout(() => {
      const latest = voiceSessionStore.getSnapshot();
      if (
        isVoiceSessionActiveRef.current &&
        (latest.phase === 'active' || latest.phase === 'starting') &&
        !latest.micMuted &&
        !latest.isPausedForDictation &&
        !voiceRef.current.isListening &&
        !voiceRef.current.isTranscribing &&
        !voiceRef.current.isFatalError
      ) {
        void voiceRef.current.startListening({ continuous: true });
      }
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [
    isVoiceSessionActive,
    voice.isListening,
    voice.isTranscribing,
    voice.error,
    voice.isFatalError,
    turn.busy,
    speakingTts,
  ]);

  useEffect(() => {
    const trimmed = voice.interimTranscript.trim();
    if (isVoiceSessionActive && trimmed) {
      touchAutoSleep('interim-transcript');
      voiceSessionStore.setVoiceError(null);
      voiceSessionStore.upsertLiveTeleprompterUser(trimmed, true);
    }
  }, [isVoiceSessionActive, voice.interimTranscript, touchAutoSleep]);

  useEffect(() => {
    if (!voice.error) return;
    const msg = voice.error;
    playVoiceErrorCue(loadOperatorConfig().voiceVolume ?? 100);
    voiceSessionStore.setVoiceError({
      message: msg,
      at: Date.now(),
      retryable: true,
      openPrivacySettings: /perm|mic|access|deni/i.test(msg),
    });
  }, [voice.error]);

  useEffect(() => {
    if (!isVoiceSessionActive) return;
    const player = pcmPlayerRef.current;
    if (!player) return;
    const timer = window.setInterval(() => {
      const level = player.getSpeakerLevel();
      const timing = player.getTiming();
      const isPlaying = timing.scheduledEnd > timing.currentTime + 0.02;
      if (isPlaying || level > 0.005) {
        voiceSessionStore.setSpeakerAudioLevel(level);
      } else if (voiceSessionStore.getSnapshot().speakerAudioLevel) {
        voiceSessionStore.setSpeakerAudioLevel(0);
        if (realtimeActiveRef.current) {
          voiceSessionStore.setVoiceRuntimeState({ isSpeaking: false });
        }
      }
    }, 60);
    return () => window.clearInterval(timer);
  }, [isVoiceSessionActive, speakingTts]);

  useEffect(() => {
    voiceSessionStore.setVoiceRuntimeState({
      isListening: voice.isListening,
      isTranscribing: voice.isTranscribing,
      isSpeaking: speakingTts,
      interimTranscript: voice.interimTranscript,
    });
  }, [voice.isListening, voice.isTranscribing, speakingTts, voice.interimTranscript]);

  useEffect(() => {
    voiceSessionStore.setLiveAudioLevel(voice.audioLevel);
  }, [voice.audioLevel]);

  useEffect(() => {
    voiceSessionStore.setActiveTurnStage(turn.stage, turn.stageLabel);
  }, [turn.stage, turn.stageLabel]);

  // S2: Proactive speech callback shared by subagent return watcher & terminal watcher.
  // Coordinates speakingTts, VoiceTurnArbitrator, acoustic barge-in, and mic re-arming with 180ms echo guard.
  const speakProactiveInSession = useCallback((text: string) => {
    const vs = voiceSessionStore.getSnapshot();
    if (callSpeakerMutedRef.current || vs.speakerMuted) return;
    if (voiceRef.current.isListening) {
      voiceRef.current.stopListening();
    }
    activeSpokenTurnRef.current = { threadId: vs.boundThreadId };
    setSpeakingTts(true);
    voiceTurnArbitrator.transition('speaking');
    const opConfig = loadOperatorConfig();
    ttsNarrator.speak(text, {
      voiceName: opConfig.persona?.voice || 'Ara',
      rate: opConfig.ttsRate || 1.0,
      lang: opConfig.persona?.language === 'en' ? 'en-US' : 'es-ES',
      onEnd: () => {
        setSpeakingTts(false);
        voiceTurnArbitrator.transition(
          isVoiceSessionActiveRef.current || isHandsFreeReplyActive() ? 'listening' : 'idle'
        );
        schedulePostSpeechRearmRef.current(POST_TTS_ECHO_GUARD_MS);
      },
      onError: () => {
        setSpeakingTts(false);
        voiceTurnArbitrator.transition(
          isVoiceSessionActiveRef.current || isHandsFreeReplyActive() ? 'listening' : 'idle'
        );
        schedulePostSpeechRearmRef.current(POST_TTS_ECHO_GUARD_MS);
      },
    });
  }, []);

  // S2: Mount closed-loop subagent return watcher and terminal proactive watcher while ArgosStrip is active.
  useEffect(() => {
    const isVoiceOpen = () => {
      const vs = voiceSessionStore.getSnapshot();
      return isVoiceSessionActiveRef.current || vs.phase === 'active' || vs.phase === 'starting';
    };
    const stopSubagentWatcher = startSubagentReturnWatcher({
      speak: speakProactiveInSession,
      isVoiceSessionOpen: isVoiceOpen,
    });
    const stopTerminalWatcher = startProactiveAgentWatcher({
      isVoiceSessionOpen: isVoiceOpen,
      sessionSpeak: speakProactiveInSession,
      speak: speakProactiveInSession,
      reportAttention: () => {},
    });
    return () => {
      stopSubagentWatcher();
      stopTerminalWatcher();
    };
  }, [speakProactiveInSession]);

  // S1: Acoustic full-duplex barge-in while Argos is speaking in an active voice session.
  useEffect(() => {
    if (!speakingTts || !isVoiceSessionActive) {
      disarmBargeInMonitor();
      return;
    }
    const vs = voiceSessionStore.getSnapshot();
    if (vs.micMuted || vs.isPausedForDictation || vs.phase !== 'active') {
      disarmBargeInMonitor();
      return;
    }

    armBargeInMonitor(() => {
      cancelPostSpeechRearm();
      activeSpeechQueueRef.current?.abort();
      activeSpeechQueueRef.current = null;
      ttsNarrator.stop();
      setSpeakingTts(false);

      const spokenTurn = activeSpokenTurnRef.current;
      if (spokenTurn?.threadId) {
        voiceSessionStore.markTurnInterrupted(spokenTurn.threadId, spokenTurn.turnId);
      }

      const latest = voiceSessionStore.getSnapshot();
      if (
        isVoiceSessionActiveRef.current &&
        latest.phase === 'active' &&
        !latest.micMuted &&
        !latest.isPausedForDictation
      ) {
        void voiceRef.current.startListening({ continuous: true, fromBargeIn: true });
      }
    });

    return () => {
      disarmBargeInMonitor();
    };
  }, [speakingTts, isVoiceSessionActive, cancelPostSpeechRearm]);

  // When turn finishes with reply, auto-speak if TTS is enabled and not muted
  useEffect(() => {
    const reply = manualCommandResult?.reply || turn.lastTurn?.reply;
    const turnKey = manualCommandResult
      ? `manual-${manualCommandResult.reply}`
      : turn.lastTurn
        ? `turn-${turn.lastTurn.turnId || turn.lastTurn.reply}`
        : null;

    const vs = voiceSessionStore.getSnapshot();
    if (turn.stage === 'done' && reply && !call.speakerMuted && !vs.speakerMuted) {
      if (turnKey && lastSpokenTurnKeyRef.current === turnKey) {
        return;
      }
      lastSpokenTurnKeyRef.current = turnKey;
      activeSpokenTurnRef.current = {
        threadId: vs.boundThreadId,
        turnId: turn.lastTurn?.turnId,
      };
      setSpeakingTts(true);
      voiceTurnArbitrator.transition('speaking');
      const opConfig = loadOperatorConfig();
      touchAutoSleep('tts-start');
      if (!realtimeActiveRef.current) {
        publishCascadedTeleprompterReply(reply, {
          willSpeakTts: opConfig.ttsEnabled !== false,
          rate: opConfig.ttsRate || 1.0,
        });
      }
      ttsNarrator.speak(reply, {
        voiceName: opConfig.persona?.voice || 'Ara',
        rate: opConfig.ttsRate || 1.0,
        lang: opConfig.persona?.language === 'en' ? 'en-US' : 'es-ES',
        turnId: turn.lastTurn?.turnId,
        onEnd: () => {
          setSpeakingTts(false);
          if (!realtimeActiveRef.current) {
            voiceSessionStore.completeLiveTeleprompterVoice();
          }
          touchAutoSleep('tts-end');
          voiceTurnArbitrator.transition(
            isVoiceSessionActiveRef.current || isHandsFreeReplyActive() ? 'listening' : 'idle'
          );
          schedulePostSpeechRearm(POST_TTS_ECHO_GUARD_MS);
        },
        onError: () => {
          setSpeakingTts(false);
          if (!realtimeActiveRef.current) {
            voiceSessionStore.completeLiveTeleprompterVoice();
          }
          touchAutoSleep('tts-error');
          voiceTurnArbitrator.transition(
            isVoiceSessionActiveRef.current || isHandsFreeReplyActive() ? 'listening' : 'idle'
          );
          schedulePostSpeechRearm(POST_TTS_ECHO_GUARD_MS);
        },
      });
    } else if (turn.stage === 'done' && canRearmVoiceSessionMic()) {
      voiceTurnArbitrator.transition('listening');
      // Re-arm microphone immediately if TTS was muted or had no reply
      schedulePostSpeechRearm(0);
    }
  }, [
    turn.stage,
    turn.lastTurn,
    manualCommandResult,
    call.speakerMuted,
    canRearmVoiceSessionMic,
    schedulePostSpeechRearm,
  ]);

  // Toggle continuous voice session (S5)
  const handleToggleVoiceSession = useCallback(async () => {
    if (isVoiceSessionActiveRef.current) {
      cancelPostSpeechRearm();
      voiceSessionStore.stopSession();
      setIsVoiceSessionActive(false);
      isVoiceSessionActiveRef.current = false;
      if (typeof window !== 'undefined') {
        (window as any).__kiteVoiceSessionActive = false;
      }
      disarmBargeInMonitor();
      activeSpeechQueueRef.current?.abort();
      activeSpeechQueueRef.current = null;
      voice.stopListening({ release: true });
      ttsNarrator.stop();
      setSpeakingTts(false);
      voiceTurnArbitrator.transition('idle');
      return;
    }

    cancelPostSpeechRearm();
    ttsNarrator.stop();
    setSpeakingTts(false);
    if (call.muted && onToggleMute) {
      onToggleMute();
    } else if (voiceSessionStore.getSnapshot().micMuted) {
      voiceSessionStore.setMicMuted(false);
    }
    if (voice.error) {
      voice.clearError();
    }
    turn.resetStage();
    voiceSessionStore.startSession(null, 'orb');
    setIsVoiceSessionActive(true);
    isVoiceSessionActiveRef.current = true;
    if (typeof window !== 'undefined') {
      (window as any).__kiteVoiceSessionActive = true;
    }

    try {
      const cfgNow = loadOperatorConfig();
      if (!(cfgNow.voiceTransportMode === 'realtime' && isTauriEnvironment()) && !voice.isListening) {
        await voice.startListening({ continuous: true });
      }
    } catch {
      voiceSessionStore.stopSession();
      setIsVoiceSessionActive(false);
      isVoiceSessionActiveRef.current = false;
      if (typeof window !== 'undefined') {
        (window as any).__kiteVoiceSessionActive = false;
      }
    }
  }, [call.muted, onToggleMute, turn, voice, cancelPostSpeechRearm]);

  // Toggle one-shot voice dictation
  const handleToggleVoice = useCallback(async () => {
    // Unconditionally stop TTS on user interruption (barge-in)
    cancelPostSpeechRearm();
    ttsNarrator.stop();
    setSpeakingTts(false);

    if (call.muted && onToggleMute) {
      onToggleMute();
    } else if (voiceSessionStore.getSnapshot().micMuted) {
      voiceSessionStore.setMicMuted(false);
    }
    if (voice.error) {
      voice.clearError();
    }
    if (voice.isListening) {
      voice.stopListening();
      return;
    }
    setOrbPulseKey((k) => k + 1);
    turn.resetStage();
    await voice.startListening();
  }, [voice, call.muted, onToggleMute, turn, cancelPostSpeechRearm]);

  // Handle speaker toggle (TTS aloud narration)
  const handleToggleSpeaker = useCallback(() => {
    if (speakingTts) {
      ttsNarrator.stop();
      setSpeakingTts(false);
    }
    if (onToggleSpeaker) {
      onToggleSpeaker();
    } else {
      voiceSessionStore.toggleSpeakerMuted();
    }
  }, [speakingTts, onToggleSpeaker]);

  // Universal pointer drag handler with window-level listeners
  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't drag if clicking directly on a button
    if (target.tagName === 'BUTTON' || target.closest('button')) return;

    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const initialPos = { ...pointRef.current };
    let hasDragged = false;

    const isOrbHandle =
      target.classList.contains('zed-float__handle') ||
      target.classList.contains('argos-float__handle') ||
      !!target.closest('.zed-float__orb-container');

    let isHoldingToTalk = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const pressStartTime = Date.now();

    if (isOrbHandle && !voice.isListening) {
      if (voice.error) {
        voice.clearError();
      }
      turn.resetStage();
      holdTimer = setTimeout(async () => {
        if (!hasDragged) {
          isHoldingToTalk = true;
          ttsNarrator.stop();
          setSpeakingTts(false);
          if (call.muted && onToggleMute) {
            onToggleMute();
          }
          await voice.startListening();
        }
      }, 400);
    }

    const onPointerMove = (moveEv: PointerEvent) => {
      const dx = moveEv.clientX - startX;
      const dy = moveEv.clientY - startY;

      if (!hasDragged) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        hasDragged = true;
        setIsDragging(true);

        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        if (isHoldingToTalk) {
          isHoldingToTalk = false;
          voice.stopListening();
        }
      }

      const nextPos = clampPoint(initialPos.x + dx, initialPos.y + dy);
      setPoint(nextPos);
      pointRef.current = nextPos;
    };

    const onPointerUp = async () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }

      if (hasDragged) {
        savePoint(pointRef.current);
      } else if (isHoldingToTalk) {
        isHoldingToTalk = false;
        const elapsed = Date.now() - pressStartTime;
        // A short press starts listening and stays open. Only a real hold sends.
        if (elapsed > 900) {
          voice.stopListening();
        }
      } else if (isOrbHandle) {
        // Clean tap on sphere (< 400ms) -> toggle voice dictation
        await handleToggleVoice();
      }

      setIsDragging(false);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  // Global keyboard shortcuts while the floating assistant is visible
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent repeated firing when holding down key
      if (e.repeat) return;

      // Escape: Close/Hide floating assistant orb only when the orb itself is visible
      // (never kill an active Thread Voice Mode session when pressing Escape in Thread UI).
      if (e.key === 'Escape') {
        if (hideFloatingOrb || isTerminalTarget(e.target)) {
          return;
        }
        e.preventDefault();
        cancelPostSpeechRearm();
        voiceSessionStore.stopSession();
        ttsNarrator.stop();
        voice.stopListening();
        void releaseOperatorCapture();
        onEndCall?.();
        return;
      }

      // Ctrl+Shift+V or Alt+V: Toggle voice dictation
      const isVoiceShortcut =
        ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) ||
        (e.altKey && (e.key === 'v' || e.key === 'V'));

      if (isVoiceShortcut) {
        e.preventDefault();
        void handleToggleVoice();
      }
    };

    const handleVoiceEvent = () => {
      void handleToggleVoice();
    };
    const handleVoiceSessionEvent = () => {
      void handleToggleVoiceSession();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('kite:toggle-voice', handleVoiceEvent);
    window.addEventListener('kite:toggle-voice-session', handleVoiceSessionEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('kite:toggle-voice', handleVoiceEvent);
      window.removeEventListener('kite:toggle-voice-session', handleVoiceSessionEvent);
    };
  }, [handleToggleVoice, handleToggleVoiceSession, hideFloatingOrb, onEndCall, voice, cancelPostSpeechRearm]);

  // Keep orb within bounds on window resize
  useEffect(() => {
    const onResize = () => setPoint((prev) => clampPoint(prev.x, prev.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const effectiveMicMuted = Boolean(call.muted || voiceSession.micMuted);
  const effectiveSpeakerMuted = Boolean(call.speakerMuted || voiceSession.speakerMuted);

  // Determine effective Orb visual state (electric cyan 'listening' when recording, violet plasma when thinking!)
  const effectiveOrbState: ZedOrbState = resolveZedOrbState({
    callLastError: call.lastError,
    turnStage: turn.stage,
    voiceError: voice.error,
    turnBusy: turn.busy,
    isListening: voice.isListening,
    isTranscribing: voice.isTranscribing,
    speakingTts,
    callOrbState: call.orbState,
    callMuted: effectiveMicMuted,
  });

  const effectiveAudioLevel = voice.isListening
    ? () => voice.audioLevel
    : getAudioLevel;

  // Active status text note: returns null when idle so NO bottom bar appears!
  const displayedNote: string | null = (() => {
    if (voice.error) {
      return voice.error;
    }
    if (call.lastError) {
      return call.lastError;
    }
    if (turn.stage === 'error') {
      return turn.stageLabel || 'Ocurrió un error al procesar la acción';
    }
    if (voice.isListening) {
      return voice.interimTranscript
        ? `«${voice.interimTranscript}»`
        : 'Escuchando… (habla o haz clic para enviar)';
    }
    if (voice.isTranscribing) {
      return 'Transcribiendo tu voz en la nube…';
    }
    if (turn.busy) {
      return turn.stageLabel || 'Procesando…';
    }
    if (manualCommandResult?.reply) {
      return manualCommandResult.reply;
    }
    if (turn.lastTurn?.reply) {
      return turn.lastTurn.reply;
    }
    if (call.statusLine) {
      return call.statusLine;
    }
    return null;
  })();

  // Latency to show in note badge
  const displayedLatency: number | undefined =
    manualCommandResult?.latencyMs ?? turn.lastTurn?.durationMs;

  // Handle command submission
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = manualInputValue.trim();
    if (!text) return;
    setManualInputValue('');
    if (onExecuteCommand) {
      const res = await onExecuteCommand(text);
      if (res) {
        setManualCommandResult({
          reply: res.reply,
          latencyMs: res.latencyMs,
          ok: true,
        });
      }
    } else {
      const vsBefore = voiceSessionStore.getSnapshot();
      const startedAt = Date.now();
      const res = await turn.runTurn(text, {
        source: 'texto',
        workspaceId,
        mode: vsBefore.activeSurface === 'thread' ? 'thread' : 'code',
      });
      const vs = voiceSessionStore.getSnapshot();
      recordThreadVoiceTurn(vs.boundThreadId, text, 'texto', res, startedAt);
    }
  };

  return (
    <aside
      ref={rootRef}
      className={`argos-float zed-float ${isDragging ? 'argos-float--dragging zed-float--dragging' : ''} ${hovering ? 'argos-float--hovering zed-float--hovering' : ''}${browserTestUi ? ' argos-float--browser-test zed-float--browser-test' : ''}`}
      data-testid="zed-card"
      style={{
        left: `${point.x}px`,
        top: `${point.y}px`,
        ...(hideFloatingOrb ? { display: 'none' } : {}),
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* 1. Pure 72px Spherical Orb Container (Mathematically Centered) */}
      <div ref={orbContainerRef} className="argos-float__orb-container zed-float__orb-container">
        <div className={`argos-float__orb zed-float__orb${orbAck ? ' motion-orb-ack' : ''}`}>
          {!hideFloatingOrb && (
            <ZedOrb
              figure={configuredFigure}
              state={effectiveOrbState}
              size={72}
              getLevel={effectiveAudioLevel}
              pointerTargetRef={orbContainerRef}
              pulseKey={orbPulseKey}
              interactive={false}
            />
          )}
        </div>

        {/* Circular Drag Handle & Push-to-Talk / Click-to-Speak Trigger */}
        <div
          className="argos-float__handle zed-float__handle"
          onPointerDown={handlePointerDown}
          role="button"
          tabIndex={0}
          title={
            voice.error
              ? voice.error
              : voice.isListening
                ? 'Escuchando voz… Suelta o haz clic para enviar (Ctrl+Shift+V)'
                : 'Mantén presionado para hablar, haz clic o arrastra (Ctrl+Shift+V)'
          }
          aria-label={
            voice.isListening
              ? 'Detener y enviar dictado de voz'
              : 'Iniciar dictado de voz'
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void handleToggleVoice();
            }
          }}
        />

        {/* Microphone Mute Pip */}
        {effectiveMicMuted && !voice.isListening && (
          <span className="argos-float__mute-pip zed-float__mute-pip" title="Micrófono silenciado" aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="2" y1="2" x2="22" y2="22" />
              <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
              <path d="M5 10v2a7 7 0 0 0 12 5" />
            </svg>
          </span>
        )}
      </div>

      {/* 2. Micro-Controls Dock Directly Below Sphere: [Mic] [VoiceSession] [Speaker] [Close] */}
      <div
        className="argos-float__controls zed-float__controls"
        data-shown="true"
        onPointerDown={handlePointerDown}
        title="Arrastra para mover a Argos"
      >
        {/* Button 1: Micrófono (Voice Dictation Toggle) */}
        <button
          type="button"
          className={`argos-float__control zed-float__control ${voice.isListening ? 'argos-float__control--active zed-float__control--active' : ''} ${effectiveMicMuted && !voice.isListening ? 'argos-float__control--muted zed-float__control--muted' : ''}`}
          onClick={handleToggleVoice}
          title={voice.isListening ? 'Escuchando voz… (clic para enviar)' : 'Hablar con Argos (Ctrl+Shift+V)'}
          aria-label={voice.isListening ? 'Detener y enviar dictado de voz' : 'Dictar por voz a Argos'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        </button>

        {/* Button 1b: Modo Voz Continuo / Voice Session (S5) */}
        <button
          type="button"
          className={`argos-float__control zed-float__control ${isVoiceSessionActive ? 'argos-float__control--active zed-float__control--active zed-float__control--live' : ''}`}
          onClick={handleToggleVoiceSession}
          title={
            isVoiceSessionActive
              ? 'Finalizar sesión de voz continua'
              : 'Iniciar sesión de voz continua en tiempo real'
          }
          aria-label={
            isVoiceSessionActive
              ? 'Finalizar sesión de voz'
              : 'Iniciar sesión de voz'
          }
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 10v3" />
            <path d="M6 6v11" />
            <path d="M10 3v18" />
            <path d="M14 8v7" />
            <path d="M18 5v13" />
            <path d="M22 10v3" />
          </svg>
        </button>

        {/* Button 2: Parlante / Speaker (Toggle Agent Speaking Aloud via TTS) */}
        <button
          type="button"
          className={`argos-float__control zed-float__control ${effectiveSpeakerMuted ? 'argos-float__control--muted zed-float__control--muted' : ''}`}
          onClick={handleToggleSpeaker}
          title={effectiveSpeakerMuted ? 'Activar voz en altavoz (TTS)' : 'Silenciar voz en altavoz (TTS)'}
          aria-label={effectiveSpeakerMuted ? 'Activar voz en altavoz' : 'Silenciar voz en altavoz'}
        >
          {effectiveSpeakerMuted ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="22" y1="9" x2="16" y2="15" />
              <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          )}
        </button>

        {/* Button 3: Cerrar (✕ Close Assistant) */}
        <button
          type="button"
          className="argos-float__control zed-float__control argos-float__control--end zed-float__control--end"
          onClick={() => {
            cancelPostSpeechRearm();
            voiceSessionStore.stopSession();
            ttsNarrator.stop();
            voice.stopListening();
            void releaseOperatorCapture();
            onEndCall?.();
          }}
          title="Cerrar Asistente (Esc)"
          aria-label="Cerrar Asistente"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 3. Active Floating Status Note Pill (Omitted when idle; dismissible when completed) */}
      {(displayedNote || (browserTestUi && turn.stageLabel)) && (
        <div
          className={
            browserTestUi
              ? 'argos-float__browser-status zed-float__browser-status'
              : `argos-float__note zed-float__note${
                  voice.error || call.lastError || turn.stage === 'error'
                    ? ' argos-float__note--error zed-float__note--error'
                    : voice.isListening || voice.isTranscribing
                    ? ' argos-float__note--listening zed-float__note--listening'
                    : ''
                }`
          }
          data-testid="zed-status"
          role="status"
          aria-live="polite"
          title={
            !voice.isListening && !voice.isTranscribing && !turn.busy
              ? 'Clic para ocultar mensaje'
              : undefined
          }
          onClick={() => {
            if (voice.isListening || voice.isTranscribing || turn.busy) return;
            if (voice.error) voice.clearError();
            setManualCommandResult(null);
            turn.resetStage();
          }}
        >
          <span className="argos-float__note-text zed-float__note-text">
            {displayedNote || turn.stageLabel}
          </span>
          {typeof displayedLatency === 'number' && displayedLatency > 0 && (
            <span className="argos-float__latency-badge zed-float__latency-badge">
              {displayedLatency}ms
            </span>
          )}
        </div>
      )}

      {/* Consultative Draft Proposal Card when floating in Code mode */}
      {!hideFloatingOrb && voiceSession.draftProposal && (
        <ConsultativeDraftCard
          compact
          threadId={voiceSession.boundThreadId}
          onConfirm={async () => {
            if (onExecuteCommand) {
              const res = await onExecuteCommand('confirmar');
              if (res) {
                setManualCommandResult({
                  reply: res.reply,
                  latencyMs: res.latencyMs,
                  ok: true,
                });
              }
            } else {
              const vsBefore = voiceSessionStore.getSnapshot();
              const startedAt = Date.now();
              const res = await turn.runTurn('confirmar', {
                source: 'texto',
                workspaceId,
                mode: vsBefore.activeSurface === 'thread' ? 'thread' : 'code',
              });
              const vs = voiceSessionStore.getSnapshot();
              recordThreadVoiceTurn(vs.boundThreadId, 'confirmar', 'texto', res, startedAt);
            }
          }}
        />
      )}

      {/* Action Confirmation Buttons (Rendered only when explicit confirmation is required) */}
      {call.pendingConfirmation && (
        <div className="argos-float__answers zed-float__answers">
          <button
            type="button"
            className="argos-float__action-btn zed-float__action-btn argos-float__action-btn--primary zed-float__action-btn--primary"
            onClick={onApproveConfirmation}
          >
            Aceptar
          </button>
          <button
            type="button"
            className="argos-float__action-btn zed-float__action-btn argos-float__action-btn--secondary zed-float__action-btn--secondary"
            onClick={onCancelConfirmation}
          >
            Cancelar
          </button>
        </div>
      )}

      {/* Accessible Command Form (Always available for programmatic input, tests, and assistive tech) */}
      <form
        onSubmit={handleFormSubmit}
        className={`argos-float__accessible-form zed-float__accessible-form${browserTestUi ? ' argos-float__accessible-form--visible zed-float__accessible-form--visible' : ''}`}
        aria-hidden={browserTestUi ? undefined : true}
      >
        <input
          type="text"
          className="argos-float__accessible-input zed-float__accessible-input"
          data-testid="zed-input"
          placeholder="Ej: abre 2 terminales con grok y ejecuta los test"
          value={manualInputValue}
          onChange={(e) => setManualInputValue(e.target.value)}
          aria-label="Comando de texto para Argos"
          tabIndex={browserTestUi ? 0 : -1}
        />
        <button
          type="submit"
          className="argos-float__accessible-send zed-float__accessible-send"
          data-testid="zed-send"
          aria-label="Enviar comando accesible"
          tabIndex={browserTestUi ? 0 : -1}
        >
          Enviar
        </button>
      </form>
    </aside>
  );
};

export const ZedStrip = ArgosStrip;

// ── ArgosStripHost Component ─────────────────────────────────────────────────

export interface ArgosStripHostProps extends Omit<ArgosStripProps, 'call'> {
  call?: ArgosCallState | null;
}

export type ZedStripHostProps = ArgosStripHostProps;

export const ArgosStripHost: React.FC<ArgosStripHostProps> = ({ call, ...rest }) => {
  const voiceSession = useVoiceSession();
  const isVoiceSessionRunning =
    voiceSession.phase === 'active' || voiceSession.phase === 'starting';

  if ((!call || !call.isActive) && !isVoiceSessionRunning) return null;

  const effectiveCall: ArgosCallState = call ?? {
    isActive: false,
    status: 'listening',
    toolCalls: [],
  };
  const hideFloatingOrb = isVoiceSessionRunning && voiceSession.activeSurface === 'thread';

  return <ArgosStrip call={effectiveCall} hideFloatingOrb={hideFloatingOrb} {...rest} />;
};

export const ZedStripHost = ArgosStripHost;

export default ArgosStripHost;
