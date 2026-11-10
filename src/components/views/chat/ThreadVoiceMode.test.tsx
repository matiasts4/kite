import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';
import { liveVoiceStageItem, mergeTimeline, voiceTurnsToChatItems } from './voiceTranscript';
import { ZedStripHost } from '../../ZedStrip';
import { voiceSessionStore } from '../../../lib/operator/voice/voiceSessionStore';
import { declarationFromCatalog } from './driverDeclaration';

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

  it('projects voice turns as standard chat items: user, consult, action receipts, assistant (S4)', () => {
    const items = voiceTurnsToChatItems([
      {
        turnId: 'turn-101',
        userPrompt: 'Abrime dos terminales con Grok',
        source: 'voz',
        overallSuccess: true,
        receipts: [
          { actionIdx: 0, type: 'open_terminals', ok: true, summaryEs: '2 terminales con Grok abiertas', durationMs: 140 },
          { actionIdx: 1, type: 'launch_thread', ok: false, summaryEs: 'Hilo con Claude para auth', durationMs: 200 },
        ],
        consultChatsInfo: { kind: 'read', title: 'Configuracion de auth', cli: 'claude' },
        reply: 'Abrí 2 terminales con Grok.',
        createdAt: 1000,
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual(['user', 'tool', 'tool', 'tool', 'assistant']);
    expect(items[0].text).toBe('Abrime dos terminales con Grok');
    expect(items[1].title).toBe('Leyó el chat «Configuracion de auth»');
    expect(items[2]).toMatchObject({ title: '2 terminales con Grok abiertas', status: 'completed' });
    expect(items[3]).toMatchObject({ title: 'Hilo con Claude para auth', status: 'failed' });
    expect(items[4].text).toBe('Abrí 2 terminales con Grok.');
  });

  it('renders the live stage as a streaming reasoning item and interleaves by time (S4)', () => {
    const live = liveVoiceStageItem({ turnId: 'turn-9', stage: 'executing', detail: 'Ejecutando open_terminals…' });
    expect(live).toMatchObject({ kind: 'reasoning', streaming: true, text: 'Ejecutando open_terminals…' });

    const provider = [{ ...live, id: 'p1', kind: 'user' as const, streaming: false, createdAtUnixMs: 2000, text: 'hola' }];
    const voice = voiceTurnsToChatItems([
      { turnId: 't-early', userPrompt: 'antes', source: 'texto', createdAt: 1000 },
      { turnId: 't-late', userPrompt: 'después', source: 'texto', createdAt: 3000 },
    ]);
    expect(mergeTimeline(provider, voice).map((item) => item.text)).toEqual(['antes', 'hola', 'después']);
  });

  it('opens Voice Mode in a new conversation when the current thread already has content (S1)', async () => {
    const onStartVoiceMode = vi.fn();
    render(<ChatComposer {...baseComposerProps} onStartVoiceMode={onStartVoiceMode} />);

    fireEvent.click(screen.getByLabelText('Iniciar sesión de voz'));

    expect(onStartVoiceMode).toHaveBeenCalledTimes(1);
    // The pane decides which thread to bind; the composer must not bind the current one itself.
    expect(voiceSessionStore.getSnapshot().phase).toBe('inactive');
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

  it('mounts ZedStripHost engine in background when Thread Voice Mode starts with operatorOpen=false and hands off to orb on surface switch (S5, S7)', () => {
    render(
      <ZedStripHost
        call={{
          isActive: false,
          status: 'connected',
          toolCalls: [],
        }}
      />
    );

    // Initially inactive -> not mounted
    expect(screen.queryByTestId('zed-card')).not.toBeInTheDocument();

    // Activate Thread Voice Mode
    act(() => {
      voiceSessionStore.startSession('thread-live-1', 'thread');
    });

    // Engine is now mounted in background, with floating orb visually hidden on 'thread' surface
    const zedCard = screen.getByTestId('zed-card');
    expect(zedCard).toBeInTheDocument();
    expect(zedCard).toHaveStyle({ display: 'none' });

    // Switch surface to 'orb' (e.g. user navigates to Code mode) -> floating orb becomes visible
    act(() => {
      voiceSessionStore.setActiveSurface('orb');
    });
    expect(zedCard).not.toHaveStyle({ display: 'none' });
  });
});
