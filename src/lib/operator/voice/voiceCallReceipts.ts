import { invokeFlatCommand, isTauriEnvironment } from '../../ipc';
import { loadOperatorConfig } from '../config/storage';
import type { PlannerProvider } from '../providers/types';
import { runLedger } from '../runLedger';
import { voiceSessionStore, VoiceTurnRecord } from './voiceSessionStore';

export const VOICE_CALL_RECEIPTS_STORAGE_KEY = 'kite_voice_call_receipts_v1';
const MAX_STORED_RECEIPTS = 50;
const DEFAULT_SUMMARY_TIMEOUT_MS = 6000;

export type RealtimeVoiceProvider = 'xai' | 'gemini_live' | 'openai';

export interface VoiceCallTurnSnapshot {
  turnId: string;
  userPrompt: string;
  reply?: string;
  createdAt: number;
  durationMs?: number;
  tools?: string[];
  delegatedThreadId?: string;
}

export interface VoiceCallReceipt {
  callId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  turnCount: number;
  ttfaP50Ms?: number | null;
  cacheHitRatio?: number | null;
  toolsExecuted: string[];
  boundThreadId?: string | null;
  transport: 'cascaded' | 'realtime';
  realtimeProvider?: RealtimeVoiceProvider;
  estimatedAudioSec?: number;
  summary?: string;
  summaryPending?: boolean;
  summaryLead?: string;
  summaryPoints?: string[];
  turnsSnapshot?: VoiceCallTurnSnapshot[];
}

export interface GenerateCallSummaryOptions {
  planner?: Pick<PlannerProvider, 'plan'>;
  timeoutMs?: number;
}

let receiptHookRegistered = false;

function normalizeRealtimeProvider(raw: unknown): RealtimeVoiceProvider | undefined {
  if (raw === 'xai' || raw === 'gemini_live' || raw === 'openai') {
    return raw;
  }
  return undefined;
}

function readLocalReceipts(): VoiceCallReceipt[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(VOICE_CALL_RECEIPTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VoiceCallReceipt[]) : [];
  } catch (err) {
    console.warn('[voiceCallReceipts] Failed to read localStorage receipts:', err);
    return [];
  }
}

function writeLocalReceipts(receipts: VoiceCallReceipt[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      VOICE_CALL_RECEIPTS_STORAGE_KEY,
      JSON.stringify(receipts.slice(0, MAX_STORED_RECEIPTS))
    );
  } catch (err) {
    console.warn('[voiceCallReceipts] Failed to write localStorage receipts:', err);
  }
}

function sortNewestFirst(receipts: VoiceCallReceipt[]): VoiceCallReceipt[] {
  return [...receipts].sort(
    (a, b) => b.endedAt - a.endedAt || b.startedAt - a.startedAt
  );
}

function mergeNativeWithLocal(
  remote: VoiceCallReceipt,
  local: VoiceCallReceipt | undefined
): VoiceCallReceipt {
  if (!local) return remote;
  return {
    ...local,
    ...remote,
    realtimeProvider: remote.realtimeProvider ?? local.realtimeProvider,
    estimatedAudioSec: remote.estimatedAudioSec ?? local.estimatedAudioSec,
    summaryPending: remote.summaryPending ?? local.summaryPending,
    summaryLead: remote.summaryLead ?? local.summaryLead,
    summaryPoints: remote.summaryPoints ?? local.summaryPoints,
    turnsSnapshot: remote.turnsSnapshot ?? local.turnsSnapshot,
    summary: remote.summary ?? local.summary,
  };
}

function extractDelegatedThreadId(turn: VoiceTurnRecord): string | undefined {
  for (const r of turn.receipts || []) {
    if (!r.data || typeof r.data !== 'object') continue;
    const data = r.data as Record<string, unknown>;
    const candidate = data.threadId ?? data.childThreadId ?? data.delegatedThreadId;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function buildTurnsSnapshot(turns: VoiceTurnRecord[], fallbackNow: number): VoiceCallTurnSnapshot[] {
  return turns.map((turn) => {
    const turnTools = Array.from(
      new Set(
        (turn.receipts || [])
          .map((r) => (r.type ? String(r.type).trim() : ''))
          .filter((name) => name.length > 0)
      )
    );
    const delegatedThreadId = extractDelegatedThreadId(turn);
    const hasReply = typeof turn.reply === 'string' && turn.reply.trim().length > 0;
    const hasDuration = typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs);

    return {
      turnId: turn.turnId,
      userPrompt: turn.userPrompt ?? '',
      ...(hasReply ? { reply: turn.reply } : {}),
      createdAt: turn.createdAt || fallbackNow,
      ...(hasDuration ? { durationMs: turn.durationMs } : {}),
      ...(turnTools.length > 0 ? { tools: turnTools } : {}),
      ...(delegatedThreadId ? { delegatedThreadId } : {}),
    };
  });
}

function clipText(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function formatDurationEs(durationMs: number): string {
  const totalSec = Math.max(0, Math.round(durationMs / 1000));
  if (totalSec < 60) return `${totalSec} s`;
  const mins = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return rem > 0 ? `${mins} min ${rem} s` : `${mins} min`;
}

function formatTransportLabelEs(
  transport: 'cascaded' | 'realtime',
  realtimeProvider?: RealtimeVoiceProvider
): string {
  if (transport === 'realtime') {
    if (realtimeProvider === 'gemini_live') return 'Realtime · Gemini Live';
    if (realtimeProvider === 'xai') return 'Realtime · xAI';
    if (realtimeProvider === 'openai') return 'Realtime · OpenAI';
    return 'Realtime';
  }
  return 'Cascaded';
}

function buildDeterministicSummary(
  receipt: VoiceCallReceipt,
  turns?: VoiceTurnRecord[]
): { summaryLead: string; summaryPoints: string[] } {
  const snapshots: VoiceCallTurnSnapshot[] =
    turns && turns.length > 0
      ? buildTurnsSnapshot(turns, receipt.startedAt || Date.now())
      : receipt.turnsSnapshot ?? [];

  const prompts = snapshots
    .map((t) => t.userPrompt.trim())
    .filter((p) => p.length > 0);
  const replies = snapshots
    .map((t) => (t.reply ?? '').trim())
    .filter((r) => r.length > 0);

  const toolsSet = new Set<string>(receipt.toolsExecuted || []);
  const delegatedThreads = new Set<string>();
  let failedActions = 0;

  for (const snap of snapshots) {
    for (const tool of snap.tools ?? []) {
      toolsSet.add(tool);
    }
    if (snap.delegatedThreadId) {
      delegatedThreads.add(snap.delegatedThreadId);
    }
  }

  for (const turn of turns || []) {
    for (const r of turn.receipts || []) {
      if (!r.ok) failedActions += 1;
    }
  }

  const tools = Array.from(toolsSet);
  const turnCount = Math.max(receipt.turnCount, snapshots.length);
  const turnLabel = turnCount === 1 ? '1 turno' : `${turnCount} turnos`;
  const durationLabel = formatDurationEs(receipt.durationMs);
  const transportLabel = formatTransportLabelEs(receipt.transport, receipt.realtimeProvider);

  if (prompts.length === 0 && replies.length === 0 && tools.length === 0) {
    return {
      summaryLead: `Sesión de voz breve (${durationLabel}) sin intervenciones registradas.`,
      summaryPoints: [
        'No se registraron transcripciones de voz en esta llamada.',
        `Sesión en modo ${transportLabel} con duración de ${durationLabel}.`,
      ],
    };
  }

  const mainTopic = prompts[0]
    ? clipText(prompts[0], 78)
    : 'conversación asistida por voz';
  const hasDelegation =
    delegatedThreads.size > 0 ||
    tools.some((t) =>
      ['call_thinker_agent', 'spawn_subagent', 'launch_thread', 'launch_agent'].includes(t)
    );
  const delegationPhrase = hasDelegation
    ? ' con delegación en segundo plano'
    : tools.length > 0
      ? ` usando ${tools.slice(0, 2).join(', ')}`
      : '';

  const summaryLead = `Sesión de ${turnLabel} sobre «${mainTopic}»${delegationPhrase}.`;

  const points: string[] = [];

  if (prompts.length === 1) {
    points.push(`Solicitud: ${clipText(prompts[0], 120)}.`);
  } else if (prompts.length > 1) {
    const first = clipText(prompts[0], 68);
    const last = clipText(prompts[prompts.length - 1], 68);
    points.push(`Consultas (${prompts.length}): «${first}» y «${last}».`);
  }

  if (tools.length > 0 || delegatedThreads.size > 0) {
    const toolText = tools.length > 0 ? tools.slice(0, 4).join(', ') : 'delegación activa';
    const threadNote =
      delegatedThreads.size > 0
        ? ` (${delegatedThreads.size} ${delegatedThreads.size === 1 ? 'hilo derivado' : 'hilos derivados'})`
        : '';
    points.push(`Acciones y delegaciones: ${toolText}${threadNote}.`);
  }

  if (replies.length > 0) {
    const lastReply = clipText(replies[replies.length - 1], 120);
    const failureNote =
      failedActions > 0
        ? ` (${failedActions} ${failedActions === 1 ? 'acción fallida' : 'acciones fallidas'})`
        : '';
    points.push(`Resultado: ${lastReply}${failureNote}`);
  } else if (failedActions > 0) {
    points.push(
      `Resultado: se registraron ${failedActions} ${failedActions === 1 ? 'error' : 'errores'} durante la sesión.`
    );
  }

  if (points.length < 3) {
    points.push(`Duración: ${durationLabel} · ${turnLabel} · ${transportLabel}.`);
  }

  if (points.length < 2) {
    points.push('Conversación completada sin acciones adicionales pendientes.');
  }

  return {
    summaryLead,
    summaryPoints: points.slice(0, 4),
  };
}

function parsePlannerSummaryJson(
  rawText: string
): { summaryLead: string; summaryPoints: string[] } | null {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned) as {
    summaryLead?: unknown;
    summaryPoints?: unknown;
  };
  if (
    typeof parsed?.summaryLead !== 'string' ||
    parsed.summaryLead.trim().length === 0 ||
    !Array.isArray(parsed.summaryPoints)
  ) {
    return null;
  }
  const points = parsed.summaryPoints
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 4);
  if (points.length < 2) {
    return null;
  }
  return {
    summaryLead: parsed.summaryLead.trim(),
    summaryPoints: points,
  };
}

function buildPlannerSummaryPrompt(
  receipt: VoiceCallReceipt,
  turns?: VoiceTurnRecord[]
): string {
  const snapshots =
    turns && turns.length > 0
      ? buildTurnsSnapshot(turns, receipt.startedAt || Date.now())
      : receipt.turnsSnapshot ?? [];
  const lines = snapshots.slice(0, 12).map((snap, idx) => {
    const toolsText = snap.tools && snap.tools.length > 0 ? ` [tools: ${snap.tools.join(', ')}]` : '';
    const threadText = snap.delegatedThreadId ? ` [thread: ${snap.delegatedThreadId}]` : '';
    const replyText = snap.reply ? ` => ${clipText(snap.reply, 160)}` : '';
    return `${idx + 1}. Tú: ${clipText(snap.userPrompt, 160)}${toolsText}${threadText}${replyText}`;
  });
  return [
    'Resume esta llamada de voz en español como JSON estricto con { "summaryLead": string, "summaryPoints": string[] }.',
    'Reglas: summaryLead de 1 oración concisa; summaryPoints de 2 a 4 bullets claros sobre solicitudes, herramientas/delegaciones y resultado.',
    `Duración: ${formatDurationEs(receipt.durationMs)}, Modo: ${receipt.transport}.`,
    lines.join('\n'),
  ].join('\n');
}

export function buildCallReceiptFromSession(params: {
  callId?: string;
  threadId: string | null;
  turns: VoiceTurnRecord[];
  transport?: 'cascaded' | 'realtime';
  realtimeProvider?: RealtimeVoiceProvider;
}): VoiceCallReceipt {
  const { turns, threadId } = params;
  const now = Date.now();
  const startedAt =
    turns.length > 0
      ? Math.min(...turns.map((t) => t.createdAt || now))
      : now;
  const endedAt =
    turns.length > 0
      ? Math.max(now, ...turns.map((t) => t.completedAt || t.createdAt || now))
      : now;
  const summedTurnDuration = turns.reduce((acc, t) => acc + (t.durationMs || 0), 0);
  const durationMs = Math.max(endedAt - startedAt, summedTurnDuration);

  const tools = new Set<string>();
  for (const turn of turns) {
    for (const r of turn.receipts || []) {
      if (r.type) tools.add(String(r.type));
    }
  }

  const turnIds = new Set(turns.map((t) => t.turnId));
  const matchingRuns = runLedger.getRuns().filter((r) => turnIds.has(r.runId));
  const latencyReport = runLedger.getVoiceLatencyReport(
    matchingRuns.length > 0 ? matchingRuns : undefined
  );

  const lastReply = [...turns]
    .reverse()
    .find((t) => typeof t.reply === 'string' && t.reply.trim().length > 0)?.reply;
  const opConfig = loadOperatorConfig() as {
    voiceTransportMode?: 'cascaded' | 'realtime';
    realtimeProvider?: unknown;
  };
  const transport = params.transport ?? opConfig.voiceTransportMode ?? 'cascaded';
  const realtimeProvider =
    normalizeRealtimeProvider(params.realtimeProvider) ??
    normalizeRealtimeProvider(opConfig.realtimeProvider);
  const estimatedAudioSec = Math.max(0, Math.round(durationMs / 1000));
  const turnsSnapshot = buildTurnsSnapshot(turns, startedAt);
  const callId =
    params.callId ||
    `call_${startedAt}_${Math.random().toString(36).slice(2, 7)}`;

  return {
    callId,
    startedAt,
    endedAt,
    durationMs,
    turnCount: turns.length,
    ttfaP50Ms: latencyReport.ttfaAudio.count > 0 ? latencyReport.ttfaAudio.p50 : null,
    cacheHitRatio:
      latencyReport.sampleCount > 0 ? latencyReport.tokenAverages.cacheHitRatio : null,
    toolsExecuted: Array.from(tools),
    boundThreadId: threadId,
    transport,
    ...(realtimeProvider ? { realtimeProvider } : {}),
    estimatedAudioSec,
    summary: lastReply ? lastReply.trim().slice(0, 180) : undefined,
    turnsSnapshot,
  };
}

export async function generateAsyncCallSummary(
  receipt: VoiceCallReceipt,
  turns?: VoiceTurnRecord[],
  options?: GenerateCallSummaryOptions
): Promise<VoiceCallReceipt> {
  const fallbackSummary = buildDeterministicSummary(receipt, turns);
  let resolvedSummary = fallbackSummary;

  if (options?.planner) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    try {
      const plannerPromise = options.planner.plan(
        [
          {
            role: 'system',
            content:
              'Eres un asistente conciso que devuelve únicamente JSON válido con summaryLead y summaryPoints en español.',
          },
          {
            role: 'user',
            content: buildPlannerSummaryPrompt(receipt, turns),
          },
        ],
        {
          timeoutSecs: Math.max(1, Math.ceil(timeoutMs / 1000)),
          ...(controller ? { signal: controller.signal } : {}),
        }
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          controller?.abort();
          reject(new Error('summary_planner_timeout'));
        }, timeoutMs);
      });

      const result = await Promise.race([plannerPromise, timeoutPromise]);
      const parsed = parsePlannerSummaryJson(result.rawText);
      if (parsed) {
        resolvedSummary = parsed;
      }
    } catch (err) {
      console.warn('[voiceCallReceipts] L1 summary planner failed, using deterministic fallback:', err);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  const updated: VoiceCallReceipt = {
    ...receipt,
    summaryPending: false,
    summaryLead: resolvedSummary.summaryLead,
    summaryPoints: resolvedSummary.summaryPoints,
    summary: receipt.summary ?? resolvedSummary.summaryLead,
  };

  await saveVoiceCallReceipt(updated);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('kite:voice-receipt-updated', { detail: updated })
    );
  }

  return updated;
}

export async function saveVoiceCallReceipt(receipt: VoiceCallReceipt): Promise<void> {
  const existing = readLocalReceipts().filter((r) => r.callId !== receipt.callId);
  writeLocalReceipts(sortNewestFirst([receipt, ...existing]));

  if (isTauriEnvironment()) {
    try {
      await invokeFlatCommand('voice_call_receipt_save', { receipt });
    } catch (err) {
      console.warn('[voiceCallReceipts] voice_call_receipt_save failed, kept localStorage fallback:', err);
    }
  }
}

export async function listVoiceCallReceipts(limit = 25): Promise<VoiceCallReceipt[]> {
  const localReceipts = readLocalReceipts();
  if (isTauriEnvironment()) {
    try {
      const native = await invokeFlatCommand<VoiceCallReceipt[]>('voice_call_receipt_list', {
        limit,
      });
      if (Array.isArray(native) && native.length > 0) {
        const localById = new Map(localReceipts.map((r) => [r.callId, r]));
        return sortNewestFirst(
          native.map((r) => mergeNativeWithLocal(r, localById.get(r.callId)))
        ).slice(0, limit);
      }
    } catch (err) {
      console.warn('[voiceCallReceipts] voice_call_receipt_list failed, falling back to localStorage:', err);
    }
  }
  return sortNewestFirst(localReceipts).slice(0, limit);
}

export async function getVoiceCallReceipt(callId: string): Promise<VoiceCallReceipt | null> {
  const localMatch = readLocalReceipts().find((r) => r.callId === callId);
  if (isTauriEnvironment()) {
    try {
      const native = await invokeFlatCommand<VoiceCallReceipt | null>('voice_call_receipt_get', {
        callId,
      });
      if (native) return mergeNativeWithLocal(native, localMatch);
    } catch (err) {
      console.warn('[voiceCallReceipts] voice_call_receipt_get failed, falling back to localStorage:', err);
    }
  }
  return localMatch ?? null;
}

export function ensureVoiceCallReceiptsHook(): void {
  if (receiptHookRegistered) return;
  receiptHookRegistered = true;
  voiceSessionStore.onSessionEnded(({ threadId, turns }) => {
    if (!turns || turns.length === 0) return;
    const baseReceipt = buildCallReceiptFromSession({ threadId, turns });
    const pendingReceipt: VoiceCallReceipt = {
      ...baseReceipt,
      summaryPending: turns.length > 0,
    };

    const initialSave = saveVoiceCallReceipt(pendingReceipt);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kite:voice-receipt-updated', { detail: pendingReceipt })
      );
    }

    void initialSave
      .then(() => generateAsyncCallSummary(pendingReceipt, turns))
      .catch((err) => {
        console.warn('[voiceCallReceipts] Failed to finalize async call summary:', err);
      });
  });
}
