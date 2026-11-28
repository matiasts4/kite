// Kite Code — Closed-Loop Subagent Return Watcher (S2)
// Watches child subagents launched from Voice Mode via Tauri `chat-subagent-event` (with a
// bounded fallback poll only while active subagents are tracked), reads real final output via
// `dispatch_read`, records concise findings into Working Context & Episodic Memory, projects
// a proactive assistant report into the thread timeline, and speaks through `VoiceTurnArbitrator`.

import * as ipc from '../ipc';
import { invokeCommand, listChatSummaries, loadChatThread } from '../ipc';
import type { SubagentDelegationMode } from './contract';
import { ctxClient } from './context/ctxClient';
import { recordDelegation } from './context/episodicMemory';
import { upsertSubagentFinding } from './context/workingContext';
import { ttsNarrator } from './ttsNarrator';
import { normalizeForVoiceSpeech } from './voice/speechProsody';
import { voiceTurnArbitrator } from './voice/turnArbitrator';
import { voiceSessionStore } from './voice/voiceSessionStore';

export interface TrackedSubagentMeta {
  childThreadId: string;
  parentThreadId?: string;
  role: string;
  provider?: string;
  mode?: SubagentDelegationMode;
  task: string;
  workspaceId?: string;
  createdAt?: number;
}

export interface SubagentRunEventPayload {
  kind?: string;
  threadId?: string;
  subagentId?: string;
  childThreadId?: string;
  status?: string;
  run?: {
    subagentId?: string;
    childThreadId?: string;
    role?: string;
    provider?: string;
    status?: string;
    latestActivity?: string;
    items?: Array<{ kind?: string; text?: string; detail?: string }>;
  };
}

export interface SubagentReturnWatcherOptions {
  /** Spoken delivery sink (called through VoiceTurnArbitrator). Defaults to `ttsNarrator.speak`. */
  speak?: (text: string) => void | Promise<void>;
  /** Live flag checking whether a voice session is open. Defaults to `voiceSessionStore`. */
  isVoiceSessionOpen?: () => boolean;
  /** Optional custom reader override for tests. */
  readOutput?: (childThreadId: string, fallbackItems?: Array<{ kind?: string; text?: string }>) => Promise<string>;
  /** Fallback poll interval in ms while tracked subagents are active (default 4000ms). */
  pollIntervalMs?: number;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

interface WatcherRuntime {
  speak: (text: string) => void | Promise<void>;
  isVoiceSessionOpen: () => boolean;
  readOutput: (childThreadId: string, fallbackItems?: Array<{ kind?: string; text?: string }>) => Promise<string>;
  pollIntervalMs: number;
  now: () => number;
}

const FALLBACK_POLL_MS = 4000;
const MAX_TRACKED_AGE_MS = 30 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'waiting']);

const trackedSubagents = new Map<string, TrackedSubagentMeta>();
const handledSettlements = new Set<string>();
const inFlightSettlements = new Set<string>();

let activeRuntime: WatcherRuntime | null = null;
let unlistenTauriEvent: (() => void) | null = null;
let fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
let watcherGeneration = 0;

function extractLastAssistantFromItems(
  items?: Array<{ kind?: string; text?: string }> | null
): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === 'assistant' && typeof it.text === 'string' && it.text.trim()) {
      return it.text.trim();
    }
  }
  return '';
}

/**
 * Reads the final assistant response from a child subagent or workspace thread
 * using Rust's `dispatch_read` (`last: true`), falling back cleanly to `loadChatThread`
 * and optional event-carried `items`.
 */
export async function readThreadFinalOutput(
  threadId: string,
  fallbackItems?: Array<{ kind?: string; text?: string }>
): Promise<string> {
  const cleanId = (threadId || '').trim();
  if (!cleanId) return '';

  // 1. Primary path: Rust `dispatch_read` with `last: true`
  try {
    const receipt = await invokeCommand<{
      status?: string;
      text?: string;
      error?: string;
    }>('dispatch_read', {
      address: `thread:${cleanId}`,
      last: true,
      lines: 120,
      caller: 'human',
    });
    if (typeof receipt?.text === 'string' && receipt.text.trim()) {
      return receipt.text.trim();
    }
  } catch {
    // Fall through to thread loader fallback
  }

  // 2. Fallback: load persisted thread items and grab the last assistant response
  try {
    const thread = await loadChatThread(cleanId);
    const extracted = extractLastAssistantFromItems(thread?.items as any);
    if (extracted) return extracted;
  } catch {
    // Fall through to event items fallback
  }

  // 3. Last resort: items carried directly on the `subagentRunUpdated` payload
  return extractLastAssistantFromItems(fallbackItems);
}

/**
 * Condenses raw subagent output (potentially markdown with headings, bullets, code fences,
 * file paths, and UUIDs) into clean Spanish prose suitable for Working Context and TTS.
 */
export function summarizeSubagentFindingsForVoice(
  rawText: string,
  maxChars: number = 320
): string {
  if (!rawText || !rawText.trim()) return '';

  // Strip fenced code blocks and markdown decorations before prosody cleanup
  const stripped = rawText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*~`]+/g, '')
    .replace(/_/g, ' ')
    .replace(/\r?\n+/g, '. ');

  const voiceClean = normalizeForVoiceSpeech(stripped)
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();

  if (!voiceClean) return '';

  // Keep up to the first 3 informative sentences within maxChars
  const sentences = voiceClean
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

  if (sentences.length === 0) {
    return voiceClean.slice(0, maxChars).trim();
  }

  const chosen: string[] = [];
  let total = 0;
  for (const s of sentences) {
    if (chosen.length >= 3) break;
    if (total > 0 && total + s.length + 1 > maxChars) break;
    chosen.push(s);
    total += s.length + 1;
  }

  let result = chosen.join(' ').trim();
  if (!result) {
    result = sentences[0].slice(0, maxChars).trim();
  }
  if (!/[.!?]$/.test(result)) {
    result = `${result}.`;
  }
  return result;
}

/**
 * Composes a concise, natural 2–4 sentence spoken report when a child subagent settles,
 * including its concrete findings and a conversational next-step proposal.
 */
export function composeSubagentReturnSpeech(params: {
  role?: string;
  status: 'completed' | 'failed' | 'waiting';
  mode?: SubagentDelegationMode;
  findingsSummary?: string;
  errorDetail?: string;
}): string {
  const rawRole = (params.role || '').trim();
  const roleLabel =
    !rawRole || rawRole.toLowerCase() === 'explorer'
      ? 'explorador'
      : rawRole.toLowerCase() === 'subagent'
        ? 'delegado'
        : rawRole;

  if (params.status === 'waiting') {
    const detail = params.findingsSummary ? ` ${params.findingsSummary}` : '';
    return `El subagente ${roleLabel} necesita tu confirmación para seguir.${detail} ¿Cómo querés que proceda?`;
  }

  if (params.status === 'failed') {
    const cleanErr = params.errorDetail
      ? summarizeSubagentFindingsForVoice(params.errorDetail, 140)
      : '';
    return `El subagente ${roleLabel} se detuvo con un problema${cleanErr ? `: ${cleanErr}` : '.'} ¿Querés que lo reintente o ajustamos el enfoque?`;
  }

  const findings = (params.findingsSummary || '').trim();
  const followUp =
    params.mode === 'odd'
      ? '¿Querés que revisemos esa especificación o avanzamos con la implementación?'
      : params.mode === 'execute'
        ? '¿Querés que validemos el resultado o seguimos con el siguiente paso?'
        : '¿Querés que profundicemos en alguno de estos puntos o pasamos a armar el ODD?';

  if (findings) {
    return `Volvió el subagente ${roleLabel}. ${findings} ${followUp}`;
  }
  return `Volvió el subagente ${roleLabel} y terminó su revisión. ${followUp}`;
}

function defaultSpeak(text: string): void {
  try {
    void ttsNarrator.speak(text).catch(() => {});
  } catch {}
}

function defaultIsVoiceOpen(): boolean {
  const snap = voiceSessionStore.getSnapshot();
  return snap.phase === 'active' || snap.phase === 'starting';
}

function stopFallbackPollIfIdle(): void {
  if (trackedSubagents.size === 0 && fallbackPollTimer !== null) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

function ensureFallbackPoll(): void {
  if (!activeRuntime || trackedSubagents.size === 0 || fallbackPollTimer !== null) return;
  fallbackPollTimer = setInterval(() => {
    void pollTrackedSubagentsOnce();
  }, activeRuntime.pollIntervalMs);
}

async function pollTrackedSubagentsOnce(): Promise<void> {
  if (!activeRuntime || trackedSubagents.size === 0) {
    stopFallbackPollIfIdle();
    return;
  }
  const now = activeRuntime.now();
  // Expire very old stale tracked subagents
  for (const [id, meta] of trackedSubagents.entries()) {
    if (meta.createdAt && now - meta.createdAt > MAX_TRACKED_AGE_MS) {
      trackedSubagents.delete(id);
    }
  }
  if (trackedSubagents.size === 0) {
    stopFallbackPollIfIdle();
    return;
  }

  try {
    const summaries = await listChatSummaries();
    if (!Array.isArray(summaries)) return;
    for (const meta of Array.from(trackedSubagents.values())) {
      const match = summaries.find((s) => s.id === meta.childThreadId);
      if (!match) continue;
      const rawStatus = (match.status || '').toLowerCase();
      if (rawStatus === 'running' || rawStatus === 'pending') continue;
      const mappedStatus =
        rawStatus === 'error' || rawStatus === 'failed'
          ? 'failed'
          : rawStatus === 'waiting'
            ? 'waiting'
            : 'completed';
      await handleSubagentSettlementEvent({
        kind: 'subagentRunUpdated',
        threadId: meta.parentThreadId || match.parentThreadId || undefined,
        subagentId: meta.childThreadId,
        run: {
          subagentId: meta.childThreadId,
          childThreadId: meta.childThreadId,
          role: meta.role,
          provider: meta.provider || match.provider,
          status: mappedStatus,
        },
      });
    }
  } catch {
    // Non-fatal fallback poll failure
  }
}

/**
 * Registers a newly dispatched child subagent so the return watcher can capture
 * its findings, persist them, and speak a concise summary when it settles.
 */
export function trackDelegatedSubagent(meta: TrackedSubagentMeta): void {
  const id = (meta.childThreadId || '').trim();
  if (!id) return;
  const now = activeRuntime?.now() ?? Date.now();
  const normalized: TrackedSubagentMeta = {
    ...meta,
    childThreadId: id,
    createdAt: meta.createdAt ?? now,
  };
  trackedSubagents.set(id, normalized);

  if (normalized.parentThreadId) {
    upsertSubagentFinding(normalized.parentThreadId, {
      subagentId: id,
      role: normalized.role,
      provider: normalized.provider,
      mode: normalized.mode,
      status: 'running',
      taskSummary: normalized.task,
      updatedAt: now,
    });
  }

  ensureFallbackPoll();
}

export function untrackDelegatedSubagent(childThreadId: string): void {
  trackedSubagents.delete(childThreadId);
  stopFallbackPollIfIdle();
}

/**
 * Processes a `chat-subagent-event` payload (or fallback poll transition).
 * Reads real findings via `dispatch_read`, records them into Working Context & Episodic Memory,
 * appends a proactive report to the voice thread timeline, and narrates via `VoiceTurnArbitrator`.
 */
export async function handleSubagentSettlementEvent(
  payload: SubagentRunEventPayload
): Promise<boolean> {
  if (!payload) return false;
  const kind = payload.kind || 'subagentRunUpdated';
  if (kind !== 'subagentRunUpdated' && kind !== 'subagentStepsUpdated') {
    return false;
  }

  const run = payload.run;
  const rawStatus = (run?.status || payload.status || '').toLowerCase();
  if (!TERMINAL_STATUSES.has(rawStatus)) {
    return false;
  }
  const status = rawStatus as 'completed' | 'failed' | 'waiting';

  const childThreadId = (
    run?.childThreadId ||
    payload.childThreadId ||
    run?.subagentId ||
    payload.subagentId ||
    ''
  ).trim();
  if (!childThreadId) return false;

  const tracked = trackedSubagents.get(childThreadId);
  const voiceSnap = voiceSessionStore.getSnapshot();
  const parentThreadId = (
    tracked?.parentThreadId ||
    payload.threadId ||
    voiceSnap.boundThreadId ||
    ''
  ).trim();

  // Only handle subagents we explicitly tracked OR child runs belonging to the active voice thread.
  const belongsToActiveVoiceThread =
    Boolean(voiceSnap.boundThreadId) &&
    Boolean(payload.threadId) &&
    payload.threadId === voiceSnap.boundThreadId;
  if (!tracked && !belongsToActiveVoiceThread) {
    return false;
  }

  const dedupeKey = `${childThreadId}:${status}`;
  if (handledSettlements.has(dedupeKey) || inFlightSettlements.has(dedupeKey)) {
    return false;
  }
  inFlightSettlements.add(dedupeKey);

  try {
    const runtime = activeRuntime;
    const now = runtime?.now() ?? Date.now();
    const role = tracked?.role || run?.role || 'Explorer';
    const provider = tracked?.provider || run?.provider;
    const mode = tracked?.mode || 'explore';
    const workspaceId = tracked?.workspaceId;

    const reader = runtime?.readOutput ?? readThreadFinalOutput;
    const rawOutput = await reader(childThreadId, run?.items);
    const findingsSummary =
      summarizeSubagentFindingsForVoice(rawOutput, 340) ||
      (run?.latestActivity ? summarizeSubagentFindingsForVoice(run.latestActivity, 220) : '');

    const speech = composeSubagentReturnSpeech({
      role,
      status,
      mode,
      findingsSummary,
      errorDetail: status === 'failed' ? run?.latestActivity || rawOutput : undefined,
    });

    handledSettlements.add(dedupeKey);
    if (status === 'completed' || status === 'failed') {
      trackedSubagents.delete(childThreadId);
      stopFallbackPollIfIdle();
    }

    // 0. S2.3: Store full output in local CCR & publish `<<ccr:HASH>>` finding in SharedContextStore
    const ccrHash = ctxClient.ccrStoreLocal(rawOutput || findingsSummary || speech);
    void ctxClient
      .sharePut(
        `finding:${childThreadId}`,
        `${findingsSummary || speech} <<ccr:${ccrHash}>>`
      )
      .catch(() => {});

    // 1. Update live session Working Context
    if (parentThreadId) {
      upsertSubagentFinding(parentThreadId, {
        subagentId: childThreadId,
        role,
        provider,
        mode,
        status,
        taskSummary: tracked?.task || `Subagente ${role}`,
        findingsSummary: findingsSummary || speech,
        updatedAt: now,
      });
    }

    // 2. Update workspace-scoped episodic DelegationLedger with real findings
    if (workspaceId) {
      void recordDelegation(workspaceId, {
        kind: 'subagent',
        name: role,
        role,
        provider,
        resourceId: childThreadId,
        taskSummary: tracked?.task || `Subagente ${role}`,
        status: status === 'waiting' ? 'waiting' : status === 'failed' ? 'failed' : 'completed',
        outcomeSummary: findingsSummary || speech,
        updatedAt: now,
      }).catch(() => {});
    }

    // 3. Project proactive assistant report into the voice thread timeline (no fake user bubble)
    if (parentThreadId) {
      voiceSessionStore.addThreadVoiceTurn(parentThreadId, {
        turnId: `subagent-return-${childThreadId}-${status}-${now}`,
        userPrompt: '',
        source: 'voz',
        isProactiveReport: true,
        overallSuccess: status !== 'failed',
        receipts: [
          {
            actionIdx: 0,
            type: 'spawn_subagent',
            ok: status !== 'failed',
            summaryEs:
              status === 'completed'
                ? `Subagente «${role}» volvió con hallazgos`
                : status === 'waiting'
                  ? `Subagente «${role}» espera confirmación`
                  : `Subagente «${role}» finalizó con error`,
            spokenSummaryEs: speech,
            data: {
              via: 'thread',
              role,
              provider,
              mode,
              threadId: childThreadId,
              parentThreadId,
            },
          },
        ],
        reply: speech,
        createdAt: now,
      });
    }

    // 4. Refresh workspace snapshot listeners
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('kite:threads-changed'));
      } catch {}
    }

    // 5. Deliver concise voice synthesis via VoiceTurnArbitrator (folds concurrent updates, never overlaps)
    const shouldSpeak = runtime ? runtime.isVoiceSessionOpen() : defaultIsVoiceOpen();
    if (shouldSpeak && !voiceSessionStore.getSnapshot().speakerMuted) {
      const speakSink = runtime?.speak ?? defaultSpeak;
      voiceTurnArbitrator.requestProactiveSpeech(
        speech,
        (queuedText) => {
          try {
            const res = speakSink(queuedText);
            if (res instanceof Promise) {
              void res.catch(() => {});
            }
          } catch {}
        },
        now,
        {
          role,
          summary: findingsSummary || speech,
          foldable: true,
        }
      );
    }

    return true;
  } finally {
    inFlightSettlements.delete(dedupeKey);
  }
}

/**
 * Starts the closed-loop subagent return watcher. Replaces any previously active watcher instance.
 */
export function startSubagentReturnWatcher(
  options: SubagentReturnWatcherOptions = {}
): () => void {
  stopSubagentReturnWatcher();

  const generation = ++watcherGeneration;
  activeRuntime = {
    speak: options.speak ?? defaultSpeak,
    isVoiceSessionOpen: options.isVoiceSessionOpen ?? defaultIsVoiceOpen,
    readOutput: options.readOutput ?? readThreadFinalOutput,
    pollIntervalMs: options.pollIntervalMs ?? FALLBACK_POLL_MS,
    now: options.now ?? (() => Date.now()),
  };

  let inTauri = false;
  try {
    inTauri = typeof ipc.isTauriEnvironment === 'function' && ipc.isTauriEnvironment();
  } catch {
    inTauri = false;
  }
  if (inTauri) {
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<SubagentRunEventPayload>('chat-subagent-event', (event) => {
          if (generation !== watcherGeneration) return;
          void handleSubagentSettlementEvent(event.payload);
        })
      )
      .then((unlisten) => {
        if (generation !== watcherGeneration) {
          try {
            unlisten();
          } catch {}
          return;
        }
        unlistenTauriEvent = unlisten;
      })
      .catch(() => {
        // Fallback poll covers environments without Tauri event API
      });
  }

  ensureFallbackPoll();

  return () => {
    if (generation === watcherGeneration) {
      stopSubagentReturnWatcher();
    }
  };
}

export function stopSubagentReturnWatcher(): void {
  watcherGeneration += 1;
  activeRuntime = null;
  if (unlistenTauriEvent) {
    try {
      unlistenTauriEvent();
    } catch {}
    unlistenTauriEvent = null;
  }
  if (fallbackPollTimer !== null) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

export function resetSubagentReturnWatcherForTests(): void {
  stopSubagentReturnWatcher();
  trackedSubagents.clear();
  handledSettlements.clear();
  inFlightSettlements.clear();
}
