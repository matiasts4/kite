import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_CALL_RECEIPTS_STORAGE_KEY,
  buildCallReceiptFromSession,
  ensureVoiceCallReceiptsHook,
  getVoiceCallReceipt,
  listVoiceCallReceipts,
  saveVoiceCallReceipt,
} from './voiceCallReceipts';
import { voiceSessionStore } from './voiceSessionStore';
import { runLedger } from '../runLedger';
import * as ipc from '../../ipc';

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(async () => null),
    isTauriEnvironment: vi.fn(() => false),
  };
});

describe('voiceCallReceipts (T8 — Post-Call Persistence & History)', () => {
  beforeEach(() => {
    localStorage.clear();
    runLedger.clearHistory();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a receipt from voice session turns and runLedger metrics, and persists/reads in newest-first order', async () => {
    const t0 = 1_700_000_000_000;
    runLedger.startRun('revisar status', { runId: 'turn-r1', taskType: 'voice_turn' });
    runLedger.recordVoiceMilestones('turn-r1', {
      sttFinalizedAt: t0,
      firstTokenAt: t0 + 180,
      firstActionStartAt: t0 + 210,
      firstAudioAt: t0 + 520,
    });
    runLedger.recordVoiceClassification('turn-r1', { transport: 'cascaded' });
    runLedger.recordTokenBreakdown('turn-r1', {
      systemStaticTokens: 700,
      contextDynamicTokens: 120,
      toolsSchemaTokens: 0,
      historyTokens: 80,
      promptTokensTotal: 900,
      cachedTokens: 700,
      completionTokens: 40,
      cacheHitRatio: 700 / 900,
    });
    runLedger.completeRun('turn-r1', { outcome: 'success' });

    const receipt = buildCallReceiptFromSession({
      callId: 'call_test_1',
      threadId: 'thread-abc',
      transport: 'cascaded',
      turns: [
        {
          turnId: 'turn-r1',
          userPrompt: 'revisar status',
          source: 'voz',
          durationMs: 2400,
          overallSuccess: true,
          reply: 'Todo limpio en el workspace.',
          receipts: [
            { actionIdx: 0, type: 'peek_workspace', summaryEs: 'OK', ok: true, durationMs: 30 },
          ],
          createdAt: t0,
          completedAt: t0 + 2400,
        },
      ],
    });

    expect(receipt.callId).toBe('call_test_1');
    expect(receipt.boundThreadId).toBe('thread-abc');
    expect(receipt.turnCount).toBe(1);
    expect(receipt.durationMs).toBeGreaterThanOrEqual(2400);
    expect(receipt.toolsExecuted).toEqual(['peek_workspace']);
    expect(receipt.ttfaP50Ms).toBe(520);
    expect(receipt.cacheHitRatio).toBeGreaterThan(0.7);

    await saveVoiceCallReceipt(receipt);
    const list = await listVoiceCallReceipts(10);
    expect(list).toHaveLength(1);
    expect(list[0].callId).toBe('call_test_1');

    const loaded = await getVoiceCallReceipt('call_test_1');
    expect(loaded?.summary).toContain('Todo limpio');
    expect(localStorage.getItem(VOICE_CALL_RECEIPTS_STORAGE_KEY)).toContain('call_test_1');
  });

  it('persists receipt automatically when voiceSessionStore ends a session with turns', async () => {
    ensureVoiceCallReceiptsHook();
    voiceSessionStore.startSession('thread-live-9');
    voiceSessionStore.addThreadVoiceTurn('thread-live-9', {
      turnId: 'turn-live-1',
      userPrompt: 'hola argos',
      source: 'voz',
      reply: 'Hola, decime en qué te ayudo.',
      durationMs: 900,
      overallSuccess: true,
      createdAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_900,
    });
    voiceSessionStore.stopSession();

    await new Promise((r) => setTimeout(r, 20));
    const list = await listVoiceCallReceipts(10);
    expect(list.some((item) => item.boundThreadId === 'thread-live-9' && item.turnCount === 1)).toBe(
      true
    );
  });

  it('invokes Tauri voice_call_receipt_save and voice_call_receipt_list when Tauri runtime is active', async () => {
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'voice_call_receipt_list') {
        return [
          {
            callId: 'call_tauri_99',
            startedAt: 1000,
            endedAt: 5000,
            durationMs: 4000,
            turnCount: 3,
            ttfaP50Ms: 490,
            cacheHitRatio: 0.72,
            toolsExecuted: ['manage_tasks'],
            boundThreadId: 'thr-tauri',
            transport: 'realtime',
            summary: 'Sesión realtime Tauri',
          },
        ];
      }
      return 'ok';
    });

    const listed = await listVoiceCallReceipts(5);
    expect(listed[0]?.callId).toBe('call_tauri_99');
    await saveVoiceCallReceipt(listed[0]);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'voice_call_receipt_save',
      expect.objectContaining({ receipt: expect.objectContaining({ callId: 'call_tauri_99' }) })
    );
  });
});
