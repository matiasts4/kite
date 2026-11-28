import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArgosAudioSection } from './ArgosAudioSection';
import { DEFAULT_OPERATOR_CONFIG } from '../../../../lib/operator/config/storage';
import * as ipc from '../../../../lib/ipc';

vi.mock('../../../../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/ipc')>('../../../../lib/ipc');
  return {
    ...actual,
    invokeCommand: vi.fn(),
    isTauriEnvironment: vi.fn(() => true),
  };
});

describe('ArgosAudioSection — Offline STT, Realtime Mode, Unified Audio & Receipts (S5-S7)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'read_dictation_availability') {
        return {
          schemaVersion: 1,
          state: 'ready',
          canStart: true,
          localEngines: [
            { id: 'whisper', label: 'Whisper', available: true, detail: 'Model ready: ggml-base.bin' },
            { id: 'parakeet', label: 'Parakeet', available: false, detail: 'Not installed' },
          ],
        };
      }
      if (cmd === 'read_dictation_settings' || cmd === 'update_dictation_settings') {
        return { schemaVersion: 1, mode: 'local', language: 'es', deviceId: null };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T6: renders local offline STT readiness badges, engine selector without raw <select>, and saves model path', async () => {
    const onFieldChange = vi.fn();
    const { container } = render(
      <ArgosAudioSection
        config={{ ...DEFAULT_OPERATOR_CONFIG, offlineSttEngine: 'whisper', offlineSttModelPath: '' }}
        onFieldChange={onFieldChange}
      />
    );

    expect(screen.getByText(/Entrada de Audio y Micrófono del Asistente/i)).toBeInTheDocument();
    expect(container.querySelectorAll('select')).toHaveLength(0);

    await waitFor(() => {
      expect(screen.getByTestId('offline-stt-badge-whisper')).toHaveTextContent(/Disponible/i);
    });

    const modelInput = screen.getByLabelText(/Ruta del modelo local/i) as HTMLInputElement;
    fireEvent.change(modelInput, { target: { value: 'C:\\models\\ggml-base.bin' } });
    expect(onFieldChange).toHaveBeenCalledWith('offlineSttModelPath', 'C:\\models\\ggml-base.bin');

    const saveModelBtn = screen.getByTestId('save-offline-stt-model-btn');
    fireEvent.click(saveModelBtn);

    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'select_dictation_whisper_model',
        expect.objectContaining({ modelPath: expect.any(String) })
      );
    });
  });

  it('T7: exposes Voice Transport Mode selector (cascaded vs realtime) without raw <select>', () => {
    const { container } = render(
      <ArgosAudioSection
        config={{ ...DEFAULT_OPERATOR_CONFIG, voiceTransportMode: 'cascaded' }}
        onFieldChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Modo de Transporte de Voz/i)).toBeInTheDocument();
    expect(screen.getByTestId('voice-transport-select')).toBeInTheDocument();
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });

  it('T8: renders unified mic/speaker/language SelectMenus and clickable Post-Call Receipt Cards without raw <select>', async () => {
    localStorage.setItem(
      'kite_voice_call_receipts_v1',
      JSON.stringify([
        {
          callId: 'call_e2e_rec_1',
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_012_500,
          durationMs: 12_500,
          turnCount: 3,
          ttfaP50Ms: 540,
          cacheHitRatio: 0.75,
          toolsExecuted: ['peek_workspace', 'manage_tasks'],
          boundThreadId: 'thr-receipt-1',
          transport: 'cascaded',
          summary: 'Auditoría de autenticación completada.',
        },
      ])
    );

    const { container } = render(
      <ArgosAudioSection
        config={{ ...DEFAULT_OPERATOR_CONFIG, voiceTransportMode: 'cascaded' }}
        onFieldChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('unified-mic-select')).toBeInTheDocument();
    expect(screen.getByTestId('unified-speaker-select')).toBeInTheDocument();
    expect(screen.getByTestId('unified-language-select')).toBeInTheDocument();
    expect(container.querySelectorAll('select')).toHaveLength(0);

    await waitFor(() => {
      expect(screen.getByTestId('voice-call-receipts-section')).toBeInTheDocument();
      expect(screen.getByTestId('voice-call-receipt-call_e2e_rec_1')).toBeInTheDocument();
    });

    const receiptBtn = screen.getByTestId('voice-call-receipt-call_e2e_rec_1');
    fireEvent.click(receiptBtn);
    await waitFor(() => {
      expect(screen.getByText(/thr-receipt-1/i)).toBeInTheDocument();
      expect(screen.getByText(/peek_workspace/i)).toBeInTheDocument();
    });
  });

  it('T6/S5: renders Proveedor Talker Realtime SelectMenu, auto-updates default endpoints, and exposes Gemini Live / OpenAI key inputs', async () => {
    const onFieldChange = vi.fn();
    const { container, rerender } = render(
      <ArgosAudioSection
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          voiceTransportMode: 'realtime',
          realtimeProvider: 'xai',
          realtimeEndpoint: 'wss://api.x.ai/v1/realtime',
        }}
        onFieldChange={onFieldChange}
      />
    );

    expect(container.querySelectorAll('select')).toHaveLength(0);
    const providerWrap = screen.getByTestId('realtime-provider-select');
    const providerTrigger = providerWrap.querySelector('[role="combobox"]') as HTMLElement;
    expect(providerTrigger).toBeInTheDocument();
    expect(providerTrigger).toHaveTextContent(/xAI Realtime \(24 kHz\)/i);

    fireEvent.click(providerTrigger);
    const geminiOption = await screen.findByText(/Google Gemini Live API \(16\/24 kHz\)/i);
    fireEvent.click(geminiOption);

    expect(onFieldChange).toHaveBeenCalledWith('realtimeProvider', 'gemini_live');
    expect(onFieldChange).toHaveBeenCalledWith(
      'realtimeEndpoint',
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
    );

    rerender(
      <ArgosAudioSection
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          voiceTransportMode: 'realtime',
          realtimeProvider: 'gemini_live',
          geminiLiveApiKey: '',
        }}
        onFieldChange={onFieldChange}
      />
    );

    const geminiInput = screen.getByTestId('gemini-live-api-key-input') as HTMLInputElement;
    expect(geminiInput).toHaveAttribute('type', 'password');
    fireEvent.change(geminiInput, { target: { value: 'AIza-test-key' } });
    expect(onFieldChange).toHaveBeenCalledWith('geminiLiveApiKey', 'AIza-test-key');

    rerender(
      <ArgosAudioSection
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          voiceTransportMode: 'realtime',
          realtimeProvider: 'openai',
          openaiRealtimeApiKey: '',
        }}
        onFieldChange={onFieldChange}
      />
    );

    const openaiInput = screen.getByTestId('openai-realtime-api-key-input') as HTMLInputElement;
    expect(openaiInput).toHaveAttribute('type', 'password');
    fireEvent.change(openaiInput, { target: { value: 'sk-realtime-test' } });
    expect(onFieldChange).toHaveBeenCalledWith('openaiRealtimeApiKey', 'sk-realtime-test');

    // Switching providers when a custom endpoint is set must NOT overwrite the custom URL
    onFieldChange.mockClear();
    rerender(
      <ArgosAudioSection
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          voiceTransportMode: 'realtime',
          realtimeProvider: 'xai',
          realtimeEndpoint: 'wss://custom-proxy.internal/realtime',
        }}
        onFieldChange={onFieldChange}
      />
    );
    fireEvent.click(screen.getByTestId('realtime-provider-select').querySelector('[role="combobox"]') as HTMLElement);
    fireEvent.click(await screen.findByText(/OpenAI Realtime \(24 kHz\)/i));
    expect(onFieldChange).toHaveBeenCalledWith('realtimeProvider', 'openai');
    expect(onFieldChange).not.toHaveBeenCalledWith('realtimeEndpoint', expect.any(String));
  });

  it('T6/S6: renders Auto-pausa por inactividad SelectMenu and syncs voiceIdleTimeoutSec via updateUnifiedAudioSettings', async () => {
    const onFieldChange = vi.fn();
    render(
      <ArgosAudioSection
        config={{ ...DEFAULT_OPERATOR_CONFIG, voiceIdleTimeoutSec: 180 }}
        onFieldChange={onFieldChange}
      />
    );

    const idleWrap = screen.getByTestId('voice-idle-timeout-select');
    const idleTrigger = idleWrap.querySelector('[role="combobox"]') as HTMLElement;
    expect(idleTrigger).toHaveTextContent(/3 min \(Recomendado\)/i);

    fireEvent.click(idleTrigger);
    expect(await screen.findByText('1 min')).toBeInTheDocument();
    expect(screen.getByText('5 min')).toBeInTheDocument();
    expect(screen.getByText('Desactivado')).toBeInTheDocument();

    fireEvent.click(screen.getByText('1 min'));

    expect(onFieldChange).toHaveBeenCalledWith('voiceIdleTimeoutSec', 60);
    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'update_dictation_settings',
        expect.objectContaining({
          settings: expect.objectContaining({
            voiceIdleTimeoutSec: 60,
          }),
        })
      );
    });

    fireEvent.click(idleTrigger);
    fireEvent.click(await screen.findByText('Desactivado'));
    expect(onFieldChange).toHaveBeenCalledWith('voiceIdleTimeoutSec', 0);
  });

  it('T6/S8: opens VoicePickerModal from "Elegir voz y paleta" and updates persona.voice', async () => {
    const onFieldChange = vi.fn();
    render(
      <ArgosAudioSection
        config={{
          ...DEFAULT_OPERATOR_CONFIG,
          persona: { ...DEFAULT_OPERATOR_CONFIG.persona, voice: 'Ara' },
        }}
        onFieldChange={onFieldChange}
      />
    );

    expect(screen.getByTestId('current-voice-summary')).toHaveTextContent(/Ara/i);
    expect(screen.getByTestId('current-voice-summary')).toHaveTextContent(/Clara y cercana/i);

    fireEvent.click(screen.getByTestId('open-voice-picker-btn'));
    expect(await screen.findByTestId('voice-picker')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('voice-picker-next'));
    expect(screen.getByTestId('voice-picker-name')).toHaveTextContent('Vega');

    fireEvent.click(screen.getByTestId('voice-picker-use'));

    expect(onFieldChange).toHaveBeenCalledWith(
      'persona',
      expect.objectContaining({ voice: 'Vega' })
    );
    await waitFor(() => {
      expect(screen.queryByTestId('voice-picker')).not.toBeInTheDocument();
    });
  });
});
