import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveVoiceCallReceipt,
  type VoiceCallReceipt,
} from '../../../lib/operator/voice/voiceCallReceipts';
import { VoiceTranscriptPane } from './VoiceTranscriptPane';

describe('VoiceTranscriptPane (S7)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders clean empty state when no call transcript exists for threadId', async () => {
    await saveVoiceCallReceipt({
      callId: 'call_other_thread',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_010_000,
      durationMs: 10_000,
      turnCount: 1,
      toolsExecuted: [],
      boundThreadId: 'thr-other',
      transport: 'cascaded',
    });

    render(<VoiceTranscriptPane threadId="thr-empty" />);

    const pane = await screen.findByTestId('voice-transcript-pane');
    expect(pane).toBeInTheDocument();
    expect(await screen.findByTestId('voice-transcript-empty')).toBeInTheDocument();
    expect(screen.getByText(/No hay transcripciones de voz/i)).toBeInTheDocument();
  });

  it('loads receipt by callId, displays metadata, summary, chronological turns, worked pills, tools, and thread links', async () => {
    const receipt: VoiceCallReceipt = {
      callId: 'call_pane_1',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_045_000,
      durationMs: 45_000,
      estimatedAudioSec: 45,
      turnCount: 2,
      toolsExecuted: ['call_thinker_agent', 'peek_changes'],
      boundThreadId: 'thr-main',
      transport: 'realtime',
      realtimeProvider: 'gemini_live',
      summaryPending: false,
      summaryLead: 'Revisión de cambios y delegación al Thinker.',
      summaryPoints: [
        'Solicitud: revisar diff actual y lanzar tarea de pruebas.',
        'Delegaciones: call_thinker_agent abrió hilo thr-sub-99.',
      ],
      turnsSnapshot: [
        // Intentionally out of chronological order to verify sorting
        {
          turnId: 'turn-2',
          userPrompt: 'Lanza al thinker para correr las pruebas.',
          reply: 'Listo, el hilo ya está corriendo la suite.',
          createdAt: 1_700_000_020_000,
          durationMs: 2400,
          tools: ['call_thinker_agent'],
          delegatedThreadId: 'thr-sub-99',
        },
        {
          turnId: 'turn-1',
          userPrompt: '¿Qué archivos cambiamos hoy?',
          reply: 'Modificamos tres archivos en el módulo de voz.',
          createdAt: 1_700_000_005_000,
          durationMs: 650,
          tools: ['peek_changes'],
        },
      ],
    };
    await saveVoiceCallReceipt(receipt);

    render(<VoiceTranscriptPane callId="call_pane_1" />);

    expect(await screen.findByText('Transcripción de voz')).toBeInTheDocument();
    expect(screen.getByText('Realtime · Gemini Live')).toBeInTheDocument();
    expect(screen.getByText('45 s')).toBeInTheDocument();
    expect(screen.getByText('Revisión de cambios y delegación al Thinker.')).toBeInTheDocument();

    const turns = screen.getAllByTestId('voice-transcript-turn');
    expect(turns).toHaveLength(2);
    // Chronological order: turn-1 first, turn-2 second
    expect(turns[0]).toHaveTextContent('¿Qué archivos cambiamos hoy?');
    expect(turns[0]).toHaveTextContent('Modificamos tres archivos en el módulo de voz.');
    expect(turns[0]).toHaveTextContent('peek_changes');
    // 650ms < 1000ms => formatWorkedForLabel returns null
    expect(turns[0]).not.toHaveTextContent(/Trabajó/);

    expect(turns[1]).toHaveTextContent('Lanza al thinker para correr las pruebas.');
    expect(turns[1]).toHaveTextContent('Listo, el hilo ya está corriendo la suite.');
    expect(turns[1]).toHaveTextContent('Trabajó 2.4 s');
    expect(turns[1]).toHaveTextContent('call_thinker_agent');

    // Clickable "Abrir hilo" dispatches kite:select-thread
    const selected: unknown[] = [];
    const onSelect = (e: Event) => selected.push((e as CustomEvent).detail);
    window.addEventListener('kite:select-thread', onSelect);

    fireEvent.click(screen.getByRole('button', { name: /Abrir hilo/i }));
    window.removeEventListener('kite:select-thread', onSelect);

    expect(selected).toEqual([{ threadId: 'thr-sub-99' }]);
  });

  it('loads latest receipt matching threadId and stays live on kite:voice-receipt-updated and kite:open-voice-transcript', async () => {
    await saveVoiceCallReceipt({
      callId: 'call_older',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_005_000,
      durationMs: 5_000,
      turnCount: 1,
      toolsExecuted: [],
      boundThreadId: 'thr-live',
      transport: 'cascaded',
      summaryLead: 'Llamada anterior',
    });

    await saveVoiceCallReceipt({
      callId: 'call_latest',
      startedAt: 1_700_000_100_000,
      endedAt: 1_700_000_112_000,
      durationMs: 12_000,
      turnCount: 1,
      toolsExecuted: [],
      boundThreadId: 'thr-live',
      transport: 'cascaded',
      summaryPending: true,
      turnsSnapshot: [
        {
          turnId: 't-live-1',
          userPrompt: 'Hola Argos',
          reply: 'Hola, ¿en qué trabajamos?',
          createdAt: 1_700_000_101_000,
        },
      ],
    });

    render(<VoiceTranscriptPane threadId="thr-live" />);

    expect(await screen.findByText('Cascaded')).toBeInTheDocument();
    expect(screen.getByText('Resumiendo llamada…')).toBeInTheDocument();
    expect(screen.getByText('Hola Argos')).toBeInTheDocument();

    // Live update arrives for call_latest
    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:voice-receipt-updated', {
          detail: {
            callId: 'call_latest',
            startedAt: 1_700_000_100_000,
            endedAt: 1_700_000_112_000,
            durationMs: 12_000,
            turnCount: 1,
            toolsExecuted: [],
            boundThreadId: 'thr-live',
            transport: 'cascaded',
            summaryPending: false,
            summaryLead: 'Saludo inicial de voz listo.',
            summaryPoints: ['Consulta inicial: Hola Argos', 'Duración: 12 s · Cascaded'],
            turnsSnapshot: [
              {
                turnId: 't-live-1',
                userPrompt: 'Hola Argos',
                reply: 'Hola, ¿en qué trabajamos?',
                createdAt: 1_700_000_101_000,
              },
            ],
          } satisfies VoiceCallReceipt,
        })
      );
    });

    expect(screen.queryByText('Resumiendo llamada…')).not.toBeInTheDocument();
    expect(screen.getByText('Saludo inicial de voz listo.')).toBeInTheDocument();

    // Opening a specific older call via window event switches the pane
    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:open-voice-transcript', {
          detail: { callId: 'call_older', threadId: 'thr-live' },
        })
      );
    });

    expect(await screen.findByText('Llamada anterior')).toBeInTheDocument();
  });

  it('copies formatted transcript to clipboard and shows temporary Copiado feedback', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await saveVoiceCallReceipt({
      callId: 'call_copy_1',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_015_000,
      durationMs: 15_000,
      turnCount: 1,
      toolsExecuted: ['peek_runs'],
      boundThreadId: 'thr-copy',
      transport: 'realtime',
      realtimeProvider: 'xai',
      summaryLead: 'Resumen de copia.',
      summaryPoints: ['Revisó ejecuciones recientes.', 'Sin errores detectados.'],
      turnsSnapshot: [
        {
          turnId: 'tc-1',
          userPrompt: '¿Cómo van los runs?',
          reply: 'Todos completaron bien.',
          createdAt: 1_700_000_002_000,
          durationMs: 1500,
          tools: ['peek_runs'],
        },
      ],
    });

    render(<VoiceTranscriptPane callId="call_copy_1" />);

    const copyBtn = await screen.findByRole('button', { name: /Copiar transcripción/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copiedPayload = writeText.mock.calls[0]?.[0] ?? '';
    expect(copiedPayload).toContain('Transcripción de voz');
    expect(copiedPayload).toContain('Resumen de copia.');
    expect(copiedPayload).toContain('¿Cómo van los runs?');
    expect(copiedPayload).toContain('Todos completaron bien.');

    expect(await screen.findByRole('button', { name: /Copiado/i })).toBeInTheDocument();
  });

  it('loads the latest receipt overall when neither callId nor threadId is provided', async () => {
    await saveVoiceCallReceipt({
      callId: 'call_global_old',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_005_000,
      durationMs: 5_000,
      turnCount: 1,
      toolsExecuted: [],
      boundThreadId: 'thr-1',
      transport: 'cascaded',
      summaryLead: 'Llamada antigua global',
    });
    await saveVoiceCallReceipt({
      callId: 'call_global_new',
      startedAt: 1_700_000_100_000,
      endedAt: 1_700_000_120_000,
      durationMs: 20_000,
      turnCount: 1,
      toolsExecuted: [],
      boundThreadId: 'thr-2',
      transport: 'realtime',
      realtimeProvider: 'openai',
      summaryLead: 'Última llamada global',
    });

    render(<VoiceTranscriptPane />);

    expect(await screen.findByText('Realtime · OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Última llamada global')).toBeInTheDocument();
  });
});
