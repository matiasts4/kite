import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '../../ipc';
import * as executor from '../executor';
import { RealtimeVoiceBridge } from './realtimeBridge';

vi.mock('../../ipc', async () => {
  const actual = await vi.importActual<typeof import('../../ipc')>('../../ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(),
    isTauriEnvironment: vi.fn(() => true),
  };
});

describe('RealtimeVoiceBridge — 24 kHz S2S Tool Bridge & Cascaded Fallback (S6/T7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('automatically downgrades to cascaded mode when realtime credentials are missing or proxy rejects', async () => {
    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce({
      ok: false,
      fallbackToCascaded: true,
      reason: 'missing_credentials',
    });

    const onFallback = vi.fn();
    const bridge = new RealtimeVoiceBridge({ onTransportFallback: onFallback });
    const res = await bridge.connect({ voice: 'Ara', endpoint: 'wss://api.x.ai/v1/realtime' });

    expect(res.activeTransport).toBe('cascaded');
    expect(res.fallbackReason).toBe('missing_credentials');
    expect(onFallback).toHaveBeenCalledWith('cascaded', 'missing_credentials');
  });

  it('forwards realtime function-call events into executePlan() and submits structured tool output', async () => {
    vi.mocked(ipc.invokeCommand)
      .mockResolvedValueOnce({ ok: true, connected: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    const execSpy = vi.spyOn(executor, 'executePlan').mockResolvedValueOnce({
      overallSuccess: true,
      reply: 'No hay cambios pendientes.',
      receipts: [
        {
          actionIdx: 0,
          type: 'peek_changes',
          ok: true,
          summaryEs: 'Sin cambios sin commitear.',
          data: { branch: 'feat/response-thread' },
        },
      ],
    });

    const bridge = new RealtimeVoiceBridge();
    const conn = await bridge.connect({ voice: 'Ara' });
    expect(conn.activeTransport).toBe('realtime');

    const handled = await bridge.handleToolCallEvent(
      {
        callId: 'call-123',
        name: 'peek_changes',
        arguments: { includeDiff: false },
      },
      { workspaceId: 'ws-kite', mode: 'thread' }
    );

    expect(handled.ok).toBe(true);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'voice_realtime_submit_tool_result',
      expect.objectContaining({
        callId: 'call-123',
        outputJson: expect.stringContaining('Sin cambios sin commitear'),
      })
    );

    await bridge.truncateAssistantAudio('item-99', 1420);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('voice_realtime_truncate', {
      itemId: 'item-99',
      audioEndMs: 1420,
    });
  });
});
