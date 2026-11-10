import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';
import { VoiceTurnTraceCard } from './VoiceTurnTraceCard';
import { VoiceCommentaryRow } from './VoiceCommentaryRow';
import { voiceSessionStore } from '../../../lib/operator/voice/voiceSessionStore';
import { declarationFromCatalog } from './driverDeclaration';
import { invokeCommand, listConnections } from '../../../lib/ipc';

vi.mock('../../../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/ipc')>();
  return {
    ...actual,
    listConnections: vi.fn(async () => []),
    invokeCommand: vi.fn(async (cmd: string) => {
      if (cmd === 'read_dictation_availability') {
        return { canStart: true, canRequestPermission: false, guidance: '' };
      }
      if (cmd === 'start_dictation') return { ok: true };
      if (cmd === 'stop_dictation') return { ok: true };
      if (cmd === 'read_dictation') {
        return { phase: 'done', transcript: 'texto dictado' };
      }
      return {};
    }),
  };
});

vi.mock('../../../lib/operator/operatorConfig', () => ({
  loadOperatorConfig: () => ({
    activeProvider: 'grok',
    ttsEngine: 'elevenlabs',
    persona: {
      name: 'Zed',
      voice: 'Ara',
      language: 'es',
    },
  }),
}));

describe('Thread Voice Mode — Integration & Surface Tests', () => {
  beforeEach(() => {
    voiceSessionStore.stopSession();
    voiceSessionStore.setMicMuted(false);
    voiceSessionStore.setSpeakerMuted(false);
    vi.clearAllMocks();
  });

  const baseComposerProps = {
    threadId: 'thread-test-vm',
    threadMode: 'fullAccess' as const,
    threadProvider: 'claude' as const,
    threadModel: 'claude-3-5-sonnet',
    declaration: declarationFromCatalog({ provider: 'claude', selectedModel: 'claude-3-5-sonnet' }),
    running: false,
    prompt: '',
    attachments: [],
    totalTokens: 1200,
    onChangePrompt: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onPickAttachments: vi.fn(),
    onStageFiles: vi.fn(),
    onStagePaths: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onUpdateConfig: vi.fn(),
  };

  it('renders 32px Voice Mode trigger button in thread composer next to dictation (S1, S7)', () => {
    render(<ChatComposer {...baseComposerProps} />);

    const voiceBtn = screen.getByLabelText('Iniciar sesión de voz');
    expect(voiceBtn).toBeInTheDocument();
    expect(voiceBtn).toHaveClass('chat-voice-mode-control');
    expect(voiceBtn).toHaveClass('size-8'); // 32px standard control height
  });

  it('clicking Voice Mode button enters active voice mode and swaps footer (S1, S2)', () => {
    render(<ChatComposer {...baseComposerProps} />);

    const voiceBtn = screen.getByLabelText('Iniciar sesión de voz');
    fireEvent.click(voiceBtn);

    expect(voiceSessionStore.getSnapshot().phase).toBe('active');
    expect(voiceSessionStore.getSnapshot().boundThreadId).toBe('thread-test-vm');

    // Locked assistant badge from VoiceModeFooterBar is displayed
    expect(screen.getByTestId('voice-locked-assistant-badge')).toBeInTheDocument();
    // Normal model picker popover is hidden
    expect(screen.queryByTestId('model-picker-trigger')).not.toBeInTheDocument();
  });

  it('changes textarea placeholder to "Escribir en la sesión de voz…" while in Voice Mode (S3)', () => {
    voiceSessionStore.startSession('thread-test-vm', 'thread');

    render(<ChatComposer {...baseComposerProps} />);

    const textarea = screen.getByPlaceholderText('Escribir en la sesión de voz…');
    expect(textarea).toBeInTheDocument();
  });

  it('dispatches hybrid typed text to onSendVoiceTurn when submitted in Voice Mode (S3)', () => {
    voiceSessionStore.startSession('thread-test-vm', 'thread');
    const onSendVoiceTurn = vi.fn();

    render(
      <ChatComposer
        {...baseComposerProps}
        prompt="Abrime dos terminales con Grok"
        onSendVoiceTurn={onSendVoiceTurn}
      />
    );

    // Primary Send button appears because prompt is non-empty
    const sendBtn = screen.getByLabelText('Enviar a la sesión de voz');
    expect(sendBtn).toBeInTheDocument();

    fireEvent.click(sendBtn);
    expect(onSendVoiceTurn).toHaveBeenCalledWith('Abrime dos terminales con Grok');
  });

  it('pauses continuous voice microphone during one-shot dictation and resumes after (S1)', async () => {
    // Continuous voice session is active in the background (e.g. on orb surface)
    voiceSessionStore.startSession(null, 'orb');
    expect(voiceSessionStore.getSnapshot().isPausedForDictation).toBe(false);

    render(<ChatComposer {...baseComposerProps} />);

    // Click dictation button in thread composer
    const dictateBtn = screen.getByLabelText('Dictate message');
    await fireEvent.click(dictateBtn);

    // Continuous voice is paused during dictation
    expect(voiceSessionStore.getSnapshot().isPausedForDictation).toBe(true);

    // Wait for dictation poll to finish and resume
    await waitFor(() => {
      expect(voiceSessionStore.getSnapshot().isPausedForDictation).toBe(false);
    });
  });

  it('renders VoiceTurnTraceCard with ActionReceipts, badges, and reach details (S4)', () => {
    const receipts = [
      {
        actionIdx: 0,
        type: 'open_terminals',
        ok: true,
        summaryEs: '2 terminales con Grok abiertas',
        durationMs: 140,
      },
      {
        actionIdx: 1,
        type: 'launch_thread',
        ok: true,
        summaryEs: 'Hilo con Claude para auth',
        durationMs: 200,
      },
    ];

    const consultChatsInfo = {
      kind: 'read',
      title: 'Configuracion de auth',
      cli: 'claude',
    };

    render(
      <VoiceTurnTraceCard
        turnId="turn-101"
        strategy="llm"
        providerId="grok"
        durationMs={340}
        overallSuccess={true}
        receipts={receipts}
        consultChatsInfo={consultChatsInfo}
      />
    );

    expect(screen.getByText('Traza del Asistente Zed')).toBeInTheDocument();
    expect(screen.getByText('(2 acciones · 1 consulta · 340 ms)')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();

    // Expand trace card
    fireEvent.click(screen.getByText('Traza del Asistente Zed'));

    expect(screen.getByText('2 terminales con Grok abiertas')).toBeInTheDocument();
    expect(screen.getByText('Hilo con Claude para auth')).toBeInTheDocument();
    expect(screen.getAllByText('Verificado')).toHaveLength(2);
    expect(screen.getByText(/Configuracion de auth/)).toBeInTheDocument();
  });

  it('renders VoiceCommentaryRow with live stage indicator and detail (S4)', () => {
    const { rerender } = render(
      <VoiceCommentaryRow stage="planning" detail="Planificando con Grok…" />
    );

    expect(screen.getByTestId('voice-commentary-row')).toHaveTextContent('Planificando con Grok…');

    rerender(<VoiceCommentaryRow stage="executing" detail="Ejecutando open_terminals…" />);
    expect(screen.getByTestId('voice-commentary-row')).toHaveTextContent('Ejecutando open_terminals…');
  });

  it('persists thread voice turns in voiceSessionStore across re-mounts (S6)', () => {
    voiceSessionStore.clearThreadVoiceTurns('thread-persist-1');

    voiceSessionStore.addThreadVoiceTurn('thread-persist-1', {
      turnId: 'vt-1',
      userPrompt: 'Hola asistente',
      source: 'voz',
      strategy: 'heuristic',
      providerId: 'local',
      durationMs: 80,
      overallSuccess: true,
      receipts: [],
      reply: '¡Hola! ¿En qué puedo ayudarte?',
      createdAt: Date.now(),
    });

    const turns = voiceSessionStore.getThreadVoiceTurns('thread-persist-1');
    expect(turns).toHaveLength(1);
    expect(turns[0].userPrompt).toBe('Hola asistente');
    expect(turns[0].reply).toBe('¡Hola! ¿En qué puedo ayudarte?');
  });
});
