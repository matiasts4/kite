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
});
