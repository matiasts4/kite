import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArgosLatencySection } from './ArgosLatencySection';
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
});
