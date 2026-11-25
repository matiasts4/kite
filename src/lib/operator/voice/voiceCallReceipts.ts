import { invokeCommand, isTauriEnvironment } from '../../ipc';
import { loadOperatorConfig } from '../config/storage';
import { runLedger } from '../runLedger';
import { voiceSessionStore, VoiceTurnRecord } from './voiceSessionStore';

export const VOICE_CALL_RECEIPTS_STORAGE_KEY = 'kite_voice_call_receipts_v1';
const MAX_STORED_RECEIPTS = 50;

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
  summary?: string;
}

let receiptHookRegistered = false;

function readLocalReceipts(): VoiceCallReceipt[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(VOICE_CALL_RECEIPTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VoiceCallReceipt[]) : [];
  } catch {
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
  } catch {
    // ignore storage errors
  }
}

function sortNewestFirst(receipts: VoiceCallReceipt[]): VoiceCallReceipt[] {
  return [...receipts].sort(
    (a, b) => b.endedAt - a.endedAt || b.startedAt - a.startedAt
  );
}

export function buildCallReceiptFromSession(params: {
  callId?: string;
  threadId: string | null;
  turns: VoiceTurnRecord[];
  transport?: 'cascaded' | 'realtime';
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
  const transport =
    params.transport ?? loadOperatorConfig().voiceTransportMode ?? 'cascaded';
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
    summary: lastReply ? lastReply.trim().slice(0, 180) : undefined,
  };
}

export async function saveVoiceCallReceipt(receipt: VoiceCallReceipt): Promise<void> {
  const existing = readLocalReceipts().filter((r) => r.callId !== receipt.callId);
  writeLocalReceipts(sortNewestFirst([receipt, ...existing]));

  if (isTauriEnvironment()) {
    try {
      await invokeCommand('voice_call_receipt_save', { receipt });
    } catch {
      // localStorage already persisted fallback
    }
  }
}

export async function listVoiceCallReceipts(limit = 25): Promise<VoiceCallReceipt[]> {
  if (isTauriEnvironment()) {
    try {
      const native = await invokeCommand<VoiceCallReceipt[]>('voice_call_receipt_list', {
        limit,
      });
      if (Array.isArray(native) && native.length > 0) {
        return sortNewestFirst(native).slice(0, limit);
      }
    } catch {
      // fallback to local receipts
    }
  }
  return sortNewestFirst(readLocalReceipts()).slice(0, limit);
}

export async function getVoiceCallReceipt(callId: string): Promise<VoiceCallReceipt | null> {
  if (isTauriEnvironment()) {
    try {
      const native = await invokeCommand<VoiceCallReceipt | null>('voice_call_receipt_get', {
        callId,
      });
      if (native) return native;
    } catch {
      // fallback
    }
  }
  return readLocalReceipts().find((r) => r.callId === callId) ?? null;
}

export function ensureVoiceCallReceiptsHook(): void {
  if (receiptHookRegistered) return;
  receiptHookRegistered = true;
  voiceSessionStore.onSessionEnded(({ threadId, turns }) => {
    if (!turns || turns.length === 0) return;
    const receipt = buildCallReceiptFromSession({ threadId, turns });
    void saveVoiceCallReceipt(receipt);
  });
}
