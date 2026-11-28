import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VOICE_CALL_RECEIPTS_STORAGE_KEY,
  buildCallReceiptFromSession,
  ensureVoiceCallReceiptsHook,
  generateAsyncCallSummary,
  getVoiceCallReceipt,
  listVoiceCallReceipts,
  saveVoiceCallReceipt,
} from './voiceCallReceipts';
import { voiceSessionStore } from './voiceSessionStore';
import { runLedger } from '../runLedger';
import * as ipc from '../../ipc';
import * as configStorage from '../config/storage';

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(async () => null),
    invokeFlatCommand: vi.fn(async () => null),
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

  it('invokes Tauri voice_call_receipt_save and voice_call_receipt_list via flat IPC when Tauri runtime is active', async () => {
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
    vi.mocked(ipc.invokeFlatCommand).mockImplementation(async (cmd: string) => {
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
    expect(ipc.invokeFlatCommand).toHaveBeenCalledWith(
      'voice_call_receipt_save',
      expect.objectContaining({ receipt: expect.objectContaining({ callId: 'call_tauri_99' }) })
    );
  });

  it('populates turnsSnapshot, estimatedAudioSec, and realtimeProvider from param or operator config', () => {
    const loadSpy = vi.spyOn(configStorage, 'loadOperatorConfig').mockReturnValue({
      ...configStorage.DEFAULT_OPERATOR_CONFIG,
      voiceTransportMode: 'realtime',
      realtimeProvider: 'gemini_live',
    } as typeof configStorage.DEFAULT_OPERATOR_CONFIG & { realtimeProvider: 'gemini_live' });

    const now = Date.now();
    const t0 = now - 3600;
    const fromConfig = buildCallReceiptFromSession({
      callId: 'call_snap_1',
      threadId: 'thr-snap',
      turns: [
        {
          turnId: 'turn-s1',
          userPrompt: 'Revisa los cambios y delega al thinker',
          source: 'voz',
          durationMs: 3600,
          overallSuccess: true,
          reply: 'Revisé el diff y lancé el hilo en segundo plano.',
          receipts: [
            { actionIdx: 0, type: 'peek_changes', summaryEs: 'Diff leído', ok: true, durationMs: 40 },
            {
              actionIdx: 1,
              type: 'call_thinker_agent',
              summaryEs: 'Delegado al Thinker',
              ok: true,
              durationMs: 90,
              data: { threadId: 'thr-child-77' },
            },
          ],
          createdAt: t0,
          completedAt: now,
        },
      ],
    });

    expect(fromConfig.transport).toBe('realtime');
    expect(fromConfig.realtimeProvider).toBe('gemini_live');
    expect(fromConfig.estimatedAudioSec).toBe(Math.round(fromConfig.durationMs / 1000));
    expect(fromConfig.estimatedAudioSec).toBe(4);
    expect(fromConfig.turnsSnapshot).toEqual([
      {
        turnId: 'turn-s1',
        userPrompt: 'Revisa los cambios y delega al thinker',
        reply: 'Revisé el diff y lancé el hilo en segundo plano.',
        createdAt: t0,
        durationMs: 3600,
        tools: ['peek_changes', 'call_thinker_agent'],
        delegatedThreadId: 'thr-child-77',
      },
    ]);

    const t1 = Date.now() - 1200;
    const explicitOverride = buildCallReceiptFromSession({
      callId: 'call_snap_2',
      threadId: 'thr-snap',
      transport: 'realtime',
      realtimeProvider: 'xai',
      turns: [
        {
          turnId: 'turn-s2',
          userPrompt: 'Hola',
          source: 'voz',
          durationMs: 1200,
          createdAt: t1,
          completedAt: t1 + 1200,
        },
      ],
    });
    expect(explicitOverride.realtimeProvider).toBe('xai');
    expect(explicitOverride.estimatedAudioSec).toBe(Math.round(explicitOverride.durationMs / 1000));
    expect(explicitOverride.estimatedAudioSec).toBe(1);
    loadSpy.mockRestore();
  });

  it('generates deterministic Spanish summaryLead + 2-4 summaryPoints, persists, and emits kite:voice-receipt-updated', async () => {
    const t0 = 1_700_000_000_000;
    const turns = [
      {
        turnId: 't-sum-1',
        userPrompt: 'Revisa la arquitectura de voz y abre un subagente para tests',
        source: 'voz' as const,
        durationMs: 2800,
        overallSuccess: true,
        reply: 'Revisé la arquitectura y lancé el subagente de pruebas.',
        receipts: [
          {
            actionIdx: 0,
            type: 'spawn_subagent',
            summaryEs: 'Subagente iniciado',
            ok: true,
            data: { threadId: 'thr-sub-55' },
          },
        ],
        createdAt: t0,
        completedAt: t0 + 2800,
      },
    ];
    const pending = {
      ...buildCallReceiptFromSession({
        callId: 'call_summary_1',
        threadId: 'thr-sum',
        transport: 'realtime',
        realtimeProvider: 'openai',
        turns,
      }),
      summaryPending: true,
    };
    await saveVoiceCallReceipt(pending);

    const emitted: unknown[] = [];
    const onUpdated = (e: Event) => emitted.push((e as CustomEvent).detail);
    window.addEventListener('kite:voice-receipt-updated', onUpdated);

    const updated = await generateAsyncCallSummary(pending, turns);
    window.removeEventListener('kite:voice-receipt-updated', onUpdated);

    expect(updated.summaryPending).toBe(false);
    expect(typeof updated.summaryLead).toBe('string');
    expect((updated.summaryLead ?? '').length).toBeGreaterThan(10);
    expect(Array.isArray(updated.summaryPoints)).toBe(true);
    expect((updated.summaryPoints ?? []).length).toBeGreaterThanOrEqual(2);
    expect((updated.summaryPoints ?? []).length).toBeLessThanOrEqual(4);
    expect(updated.summaryPoints?.join(' ')).toContain('spawn_subagent');

    const stored = await getVoiceCallReceipt('call_summary_1');
    expect(stored?.summaryPending).toBe(false);
    expect(stored?.summaryLead).toBe(updated.summaryLead);
    expect(stored?.summaryPoints).toEqual(updated.summaryPoints);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { callId: string; summaryPending: boolean }).callId).toBe(
      'call_summary_1'
    );
    expect((emitted[0] as { summaryPending: boolean }).summaryPending).toBe(false);
  });

  it('uses optional L1 planner hook when provided and falls back cleanly on error without throwing', async () => {
    const t0 = 1_700_000_000_000;
    const base = buildCallReceiptFromSession({
      callId: 'call_l1_1',
      threadId: 'thr-l1',
      turns: [
        {
          turnId: 't-l1',
          userPrompt: 'Verifica el estado del repo',
          source: 'voz',
          reply: 'Repositorio limpio.',
          durationMs: 1400,
          createdAt: t0,
          completedAt: t0 + 1400,
        },
      ],
    });

    const fromPlanner = await generateAsyncCallSummary(base, undefined, {
      planner: {
        plan: vi.fn(async () => ({
          rawText: JSON.stringify({
            summaryLead: 'Verificación rápida del estado del repositorio.',
            summaryPoints: [
              'Se consultó el estado actual del workspace.',
              'El repositorio no presentó cambios pendientes.',
            ],
          }),
          latencyMs: 120,
          model: 'fast-l1',
        })),
      },
    });

    expect(fromPlanner.summaryLead).toBe('Verificación rápida del estado del repositorio.');
    expect(fromPlanner.summaryPoints).toEqual([
      'Se consultó el estado actual del workspace.',
      'El repositorio no presentó cambios pendientes.',
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallbackResult = await generateAsyncCallSummary(base, undefined, {
      planner: {
        plan: vi.fn(async () => {
          throw new Error('planner_offline');
        }),
      },
    });
    expect(fallbackResult.summaryPending).toBe(false);
    expect(typeof fallbackResult.summaryLead).toBe('string');
    expect((fallbackResult.summaryPoints ?? []).length).toBeGreaterThanOrEqual(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ensureVoiceCallReceiptsHook saves summaryPending=true immediately and resolves summary asynchronously', async () => {
    ensureVoiceCallReceiptsHook();
    const updatedEvents: Array<{ callId: string; summaryPending?: boolean }> = [];
    const onUpdated = (e: Event) => {
      updatedEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener('kite:voice-receipt-updated', onUpdated);

    voiceSessionStore.startSession('thread-async-hook');
    voiceSessionStore.addThreadVoiceTurn('thread-async-hook', {
      turnId: 'turn-hook-1',
      userPrompt: 'Prepara los receipts de llamada',
      source: 'voz',
      reply: 'Receipts listos y guardados.',
      durationMs: 1500,
      overallSuccess: true,
      createdAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_500,
    });
    voiceSessionStore.stopSession();

    // Immediately after stopSession, localStorage has the pending receipt synchronously
    const rawImmediate = localStorage.getItem(VOICE_CALL_RECEIPTS_STORAGE_KEY);
    expect(rawImmediate).toBeTruthy();
    const immediateParsed = JSON.parse(rawImmediate!) as Array<{
      boundThreadId?: string;
      summaryPending?: boolean;
    }>;
    const immediateItem = immediateParsed.find((r) => r.boundThreadId === 'thread-async-hook');
    expect(immediateItem?.summaryPending).toBe(true);

    // Wait for async summary generation
    await new Promise((r) => setTimeout(r, 30));
    window.removeEventListener('kite:voice-receipt-updated', onUpdated);

    const list = await listVoiceCallReceipts(10);
    const finalized = list.find((r) => r.boundThreadId === 'thread-async-hook');
    expect(finalized?.summaryPending).toBe(false);
    expect(typeof finalized?.summaryLead).toBe('string');
    expect((finalized?.summaryPoints ?? []).length).toBeGreaterThanOrEqual(2);
    expect(updatedEvents.some((e) => e.summaryPending === false)).toBe(true);
  });

  it('logs console.warn on Tauri IPC failures instead of catching silently', async () => {
    vi.mocked(ipc.isTauriEnvironment).mockReturnValue(true);
    vi.mocked(ipc.invokeFlatCommand).mockRejectedValue(new Error('ipc_down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const receipt = buildCallReceiptFromSession({
      callId: 'call_warn_1',
      threadId: 'thr-warn',
      turns: [],
    });
    await saveVoiceCallReceipt(receipt);
    await listVoiceCallReceipts(5);
    await getVoiceCallReceipt('call_warn_1');

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });
});
