import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceCallReceipt } from '../../../lib/operator/voice/voiceCallReceipts';
import { VoiceTranscriptCard } from './VoiceTranscriptCard';

function makeReceipt(overrides: Partial<VoiceCallReceipt> = {}): VoiceCallReceipt {
  return {
    callId: 'call_card_1',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_042_000,
    durationMs: 42_000,
    turnCount: 2,
    toolsExecuted: ['call_thinker_agent'],
    boundThreadId: 'thr-voice-1',
    transport: 'realtime',
    realtimeProvider: 'gemini_live',
    estimatedAudioSec: 42,
    ...overrides,
  };
}

describe('VoiceTranscriptCard (S7)', () => {
  it('renders header, formatted duration pill, Abrir chip, and pending summary shimmer', () => {
    const receipt = makeReceipt({ summaryPending: true });
    render(<VoiceTranscriptCard receipt={receipt} />);

    const card = screen.getByTestId('voice-transcript-card');
    expect(card.tagName).toBe('BUTTON');
    expect(card).toHaveAttribute('type', 'button');
    expect(screen.getByText('Transcripción de voz')).toBeInTheDocument();
    expect(screen.getByText('42 s')).toBeInTheDocument();
    expect(screen.getByText('Abrir')).toBeInTheDocument();

    const shimmer = screen.getByTestId('voice-transcript-summary-pending');
    expect(shimmer).toHaveTextContent('Resumiendo llamada…');
    expect(shimmer).toHaveClass('kite-voice-transcript-card__shimmer');
  });

  it('renders summaryLead and bullet points when summary is resolved', () => {
    const receipt = makeReceipt({
      summaryPending: false,
      summaryLead: 'Se revisó el build y se lanzó un subagente para los tests.',
      summaryPoints: [
        'Solicitud: verificar errores de TypeScript en el módulo de voz.',
        'Delegaciones: call_thinker_agent en hilo secundario.',
        'Resultado: suite verificada sin regresiones.',
      ],
    });
    render(<VoiceTranscriptCard receipt={receipt} />);

    expect(screen.queryByTestId('voice-transcript-summary-pending')).not.toBeInTheDocument();
    expect(
      screen.getByText('Se revisó el build y se lanzó un subagente para los tests.')
    ).toBeInTheDocument();
    const points = screen.getAllByTestId('voice-transcript-summary-point');
    expect(points).toHaveLength(3);
    expect(points[0]).toHaveTextContent('Solicitud: verificar errores de TypeScript');
    expect(points[1]).toHaveTextContent('Delegaciones: call_thinker_agent');
    expect(points[2]).toHaveTextContent('Resultado: suite verificada');
  });

  it('falls back to receipt.summary when no structured summaryLead/summaryPoints exist', () => {
    const receipt = makeReceipt({
      summaryPending: false,
      summary: 'Todo listo en la rama actual.',
    });
    render(<VoiceTranscriptCard receipt={receipt} />);

    expect(screen.queryByTestId('voice-transcript-summary-pending')).not.toBeInTheDocument();
    expect(screen.getByText('Todo listo en la rama actual.')).toBeInTheDocument();
  });

  it('invokes onOpen and dispatches kite:open-voice-transcript when clicked', () => {
    const onOpen = vi.fn();
    const events: unknown[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('kite:open-voice-transcript', listener);

    const receipt = makeReceipt({
      summaryLead: 'Resumen breve de prueba.',
      summaryPoints: ['Punto A', 'Punto B'],
    });
    render(<VoiceTranscriptCard receipt={receipt} onOpen={onOpen} className="custom-card" />);

    const card = screen.getByTestId('voice-transcript-card');
    expect(card).toHaveClass('kite-voice-transcript-card', 'custom-card');
    fireEvent.click(card);

    window.removeEventListener('kite:open-voice-transcript', listener);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(receipt);
    expect(events).toEqual([{ callId: 'call_card_1', threadId: 'thr-voice-1' }]);
  });

  it('hides pending shimmer when summaryLead or summaryPoints are already populated', () => {
    const receipt = makeReceipt({
      summaryPending: true,
      summaryLead: 'Resumen disponible aunque siga marcando pendiente.',
      summaryPoints: ['Punto único confirmado'],
    });
    render(<VoiceTranscriptCard receipt={receipt} />);

    expect(screen.queryByTestId('voice-transcript-summary-pending')).not.toBeInTheDocument();
    expect(
      screen.getByText('Resumen disponible aunque siga marcando pendiente.')
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('voice-transcript-summary-point')).toHaveLength(1);
  });
});
