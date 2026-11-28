import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListen } = vi.hoisted(() => ({
  mockListen: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

import {
  REMOTE_ARGOS_TURN_REQUEST_EVENT,
  handleArgosRemoteTurnRequest,
  initArgosRemoteBridge,
} from './argosRemoteBridge';
import type { OperatorTurnResult } from '../operator/index';
import type { DraftTaskProposal, VoiceSessionState } from '../operator/voice/voiceSessionStore';

function makeBaseSnapshot(overrides: Partial<VoiceSessionState> = {}): VoiceSessionState {
  return {
    phase: 'inactive',
    boundThreadId: null,
    activeSurface: 'orb',
    micMuted: false,
    speakerMuted: false,
    isPausedForDictation: false,
    liveAudioLevel: 0,
    ...overrides,
  };
}

describe('argosRemoteBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  });

  it('executes runOperatorTurn with source voz + ttsEnabled false and replies with receipts and active proposal', async () => {
    const proposal: DraftTaskProposal = {
      proposalId: 'prop-1',
      status: 'awaiting_confirmation',
      targetKind: 'subagent',
      title: 'Revisar pruebas de auth',
      taskBrief: 'Ejecutar suite de auth y reportar hallazgos.',
      revision: 1,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const turnResult: OperatorTurnResult = {
      turnId: 'turn-123',
      plan: {
        strategy: 'llm',
        actions: [],
        reply: 'Propuesta lista para confirmar.',
      },
      receipts: [
        {
          actionIdx: 0,
          type: 'propose_task',
          ok: true,
          summaryEs: 'Propuesta preparada: Revisar pruebas de auth',
          data: { proposalId: 'prop-1' },
        },
      ],
      reply: 'Propuesta lista para confirmar.',
      overallSuccess: true,
      durationMs: 320,
      strategy: 'llm',
      providerId: 'grok',
    };

    const runTurn = vi.fn().mockResolvedValue(turnResult);
    const sendReply = vi.fn().mockResolvedValue(undefined);
    const history = [{ role: 'user' as const, content: 'Hola Argos' }];

    const result = await handleArgosRemoteTurnRequest(
      {
        requestId: 'req-42',
        transcript: '  Prepara un subagente para revisar auth  ',
        workspaceId: 'ws-kite',
        history,
      },
      {
        runOperatorTurn: runTurn,
        getSnapshot: () => ({ ...makeBaseSnapshot(), activeProposal: proposal }),
        getDraftProposal: () => null,
        replyRemoteArgosTurn: sendReply,
      }
    );

    expect(runTurn).toHaveBeenCalledWith('Prepara un subagente para revisar auth', {
      source: 'voz',
      ttsEnabled: false,
      workspaceId: 'ws-kite',
      history,
      turnId: undefined,
      mode: undefined,
    });

    expect(sendReply).toHaveBeenCalledWith('req-42', {
      ok: true,
      turnId: 'turn-123',
      transcript: 'Prepara un subagente para revisar auth',
      reply: 'Propuesta lista para confirmar.',
      receipts: turnResult.receipts,
      proposal,
      strategy: 'llm',
      durationMs: 320,
      overallSuccess: true,
      providerId: 'grok',
      model: undefined,
    });
    expect(result?.ok).toBe(true);
  });

  it('falls back to voiceSessionStore draftProposal when activeProposal is not set', async () => {
    const draft: DraftTaskProposal = {
      proposalId: 'prop-draft-2',
      status: 'awaiting_confirmation',
      targetKind: 'thread',
      title: 'Hilo de refactor',
      taskBrief: 'Refactorizar módulo remoto.',
      revision: 2,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const sendReply = vi.fn().mockResolvedValue(undefined);
    const runTurn = vi.fn().mockResolvedValue({
      turnId: 'turn-200',
      plan: { strategy: 'heuristic', actions: [] },
      receipts: [],
      reply: 'Listo.',
      overallSuccess: true,
      durationMs: 95,
      strategy: 'heuristic',
    } satisfies OperatorTurnResult);

    await handleArgosRemoteTurnRequest(
      { requestId: 'req-draft', transcript: 'Crea un hilo' },
      {
        runOperatorTurn: runTurn,
        getSnapshot: () => makeBaseSnapshot({ draftProposal: draft }),
        getDraftProposal: () => null,
        replyRemoteArgosTurn: sendReply,
      }
    );

    expect(sendReply).toHaveBeenCalledWith(
      'req-draft',
      expect.objectContaining({ ok: true, proposal: draft })
    );
  });

  it('always replies with ok false when runOperatorTurn throws so mobile never times out', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTurn = vi.fn().mockRejectedValue(new Error('Proveedor sin cuota disponible'));
    const sendReply = vi.fn().mockResolvedValue(undefined);

    const outcome = await handleArgosRemoteTurnRequest(
      {
        requestId: 'req-err-1',
        turnId: 'turn-err',
        transcript: 'Abre un agente',
      },
      {
        runOperatorTurn: runTurn,
        replyRemoteArgosTurn: sendReply,
      }
    );

    expect(sendReply).toHaveBeenCalledWith('req-err-1', {
      ok: false,
      error: 'Proveedor sin cuota disponible',
      turnId: 'turn-err',
      transcript: 'Abre un agente',
      receipts: [],
      proposal: null,
    });
    expect(outcome).toEqual(
      expect.objectContaining({ ok: false, error: 'Proveedor sin cuota disponible' })
    );
    warnSpy.mockRestore();
  });

  it('replies with ok false when transcript is empty', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTurn = vi.fn();
    const sendReply = vi.fn().mockResolvedValue(undefined);

    await handleArgosRemoteTurnRequest(
      { requestId: 'req-empty', transcript: '   ' },
      { runOperatorTurn: runTurn, replyRemoteArgosTurn: sendReply }
    );

    expect(runTurn).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(
      'req-empty',
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/transcripción/i),
      })
    );
    warnSpy.mockRestore();
  });

  it('subscribes to remote:argos-turn-request via Tauri listen and cleans up cleanly', async () => {
    let listenerCb: ((event: { payload: any }) => void) | null = null;
    const unlistenSpy = vi.fn();
    mockListen.mockImplementation(async (_eventName: string, cb: (event: { payload: any }) => void) => {
      listenerCb = cb;
      return unlistenSpy;
    });

    const runTurn = vi.fn().mockResolvedValue({
      turnId: 'turn-bridge',
      plan: { strategy: 'heuristic', actions: [] },
      receipts: [],
      reply: 'Todo en orden.',
      overallSuccess: true,
      durationMs: 42,
      strategy: 'heuristic',
    } satisfies OperatorTurnResult);
    const sendReply = vi.fn().mockResolvedValue(undefined);

    const cleanup = initArgosRemoteBridge({
      runOperatorTurn: runTurn,
      getSnapshot: () => makeBaseSnapshot(),
      getDraftProposal: () => null,
      replyRemoteArgosTurn: sendReply,
    });

    expect(mockListen).toHaveBeenCalledWith(REMOTE_ARGOS_TURN_REQUEST_EVENT, expect.any(Function));
    await vi.waitFor(() => {
      expect(listenerCb).not.toBeNull();
    });

    listenerCb!({ payload: { requestId: 'req-live', transcript: 'Estado del proyecto' } });
    await vi.waitFor(() => {
      expect(sendReply).toHaveBeenCalledWith(
        'req-live',
        expect.objectContaining({ ok: true, reply: 'Todo en orden.' })
      );
    });

    cleanup();
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});
