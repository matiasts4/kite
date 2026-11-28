import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ArgosLatencySection } from './ArgosLatencySection';
import { DEFAULT_OPERATOR_CONFIG } from '../../../../lib/operator/config/storage';
import { runLedger } from '../../../../lib/operator/runLedger';

describe('ArgosLatencySection — Voice Mode SLI/SLO HUD (S1)', () => {
  beforeEach(() => {
    localStorage.clear();
    runLedger.clearHistory();
  });

  afterEach(() => {
    runLedger.clearHistory();
    vi.restoreAllMocks();
  });

  it('displays live TTFA p50/p95/p99, cacheHitRatio, token breakdown, and tier/transport/ttsEngine segments', () => {
    const t0 = 1_700_000_000_000;
    const r1 = runLedger.startRun('hola', { runId: 'hud-turn-1', taskType: 'voice_turn' });
    runLedger.recordVoiceClassification(r1, {
      tier: 'L1',
      transport: 'cascaded',
      ttsEngine: 'elevenlabs_ws',
    });
    runLedger.recordVoiceMilestones(r1, {
      sttFinalizedAt: t0,
      firstTokenAt: t0 + 180,
      firstActionStartAt: t0 + 220,
      firstAudioAt: t0 + 620,
    });
    runLedger.recordTokenBreakdown(r1, {
      systemStaticTokens: 400,
      contextDynamicTokens: 100,
      toolsSchemaTokens: 50,
      historyTokens: 150,
      promptTokensTotal: 700,
      cachedTokens: 490,
      completionTokens: 40,
      cacheHitRatio: 0.7,
    });
    runLedger.completeRun(r1, { outcome: 'success', reply: 'Hola.' });

    render(
      <ArgosLatencySection
        testMessage={null}
        summaries={[]}
        onClearMetrics={vi.fn()}
      />
    );

    expect(screen.getByText(/Rendimiento y Latencia por Proveedor \/ Tarea/i)).toBeInTheDocument();
    expect(screen.getByTestId('voice-sli-hud')).toBeInTheDocument();
    expect(screen.getByTestId('voice-ttfa-p50')).toHaveTextContent('620ms');
    expect(screen.getByTestId('voice-cache-hit-ratio')).toHaveTextContent('70%');
    expect(screen.getByText(/TTS: elevenlabs_ws/i)).toBeInTheDocument();
    expect(screen.getByText(/Transport: cascaded/i)).toBeInTheDocument();
  });

  it('T6/S6: surfaces active transport pill for Cascaded, Gemini Live, xAI, and OpenAI', () => {
    const { rerender } = render(
      <ArgosLatencySection
        testMessage={null}
        summaries={[]}
        onClearMetrics={vi.fn()}
        config={{ ...DEFAULT_OPERATOR_CONFIG, voiceTransportMode: 'cascaded' }}
      />
    );
    expect(screen.getByTestId('voice-active-transport-pill')).toHaveTextContent('Cascaded');

    rerender(
      <ArgosLatencySection
        testMessage={null}
        summaries={[]}
        onClearMetrics={vi.fn()}
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          voiceTransportMode: 'realtime',
          realtimeProvider: 'gemini_live',
        }}
      />
    );
    expect(screen.getByTestId('voice-active-transport-pill')).toHaveTextContent(
      'Realtime · Gemini Live'
    );

    rerender(
      <ArgosLatencySection
        testMessage={null}
        summaries={[]}
        onClearMetrics={vi.fn()}
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          voiceTransportMode: 'realtime',
          realtimeProvider: 'xai',
        }}
      />
    );
    expect(screen.getByTestId('voice-active-transport-pill')).toHaveTextContent('Realtime · xAI');

    rerender(
      <ArgosLatencySection
        testMessage={null}
        summaries={[]}
        onClearMetrics={vi.fn()}
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          voiceTransportMode: 'realtime',
          realtimeProvider: 'openai',
        }}
      />
    );
    expect(screen.getByTestId('voice-active-transport-pill')).toHaveTextContent(
      'Realtime · OpenAI'
    );
  });

  it('T6/S6: displays total and latest estimated audio stream seconds from listVoiceCallReceipts()', async () => {
    localStorage.setItem(
      'kite_voice_call_receipts_v1',
      JSON.stringify([
        {
          callId: 'call_latest',
          startedAt: 2_000_000,
          endedAt: 2_042_000,
          durationMs: 42_000,
          turnCount: 4,
          toolsExecuted: [],
          transport: 'realtime',
        },
        {
          callId: 'call_older',
          startedAt: 1_000_000,
          endedAt: 1_018_000,
          durationMs: 18_000,
          turnCount: 2,
          toolsExecuted: [],
          transport: 'cascaded',
        },
      ])
    );

    render(
      <ArgosLatencySection
        testMessage={null}
        summaries={[]}
        onClearMetrics={vi.fn()}
      />
    );

    await waitFor(() => {
      const el = screen.getByTestId('voice-stream-seconds');
      expect(el).toHaveTextContent('60s total');
      expect(el).toHaveTextContent('42s última');
    });
  });
});
