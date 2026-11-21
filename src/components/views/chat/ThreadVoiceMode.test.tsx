import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';
import { ChatItemRow } from './ChatItemRow';
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

vi.mock('../../../lib/operator/operatorConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/operator/operatorConfig')>();
  return {
    ...actual,
    loadOperatorConfig: () => ({
      ...actual.DEFAULT_OPERATOR_CONFIG,
      activeProvider: 'grok',
      ttsEngine: 'elevenlabs',
      persona: {
        ...actual.DEFAULT_ZED_PERSONA,
        name: 'Zed',
        voice: 'Ara',
        language: 'es',
      },
    }),
  };
});

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

    // Live voice status from VoiceModeFooterBar is displayed without Zed/model pills
    expect(screen.getByTestId('voice-live-status-pill')).toHaveTextContent('Escuchando en vivo');
    expect(screen.queryByTestId('voice-locked-assistant-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('voice-engine-badge')).not.toBeInTheDocument();
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
    expect(items[0].inputSource).toBe('voice');
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

  it('renders a subtle voice badge only on spoken user messages (S4)', () => {
    const items = voiceTurnsToChatItems([
      {
        turnId: 'vt-spoken',
        userPrompt: 'Abrí una terminal',
        source: 'voz',
        createdAt: 1000,
      },
      {
        turnId: 'vt-typed',
        userPrompt: 'Listo por texto',
        source: 'texto',
        createdAt: 2000,
      },
    ]);

    const { rerender } = render(<ChatItemRow item={items[0]} />);
    expect(screen.getByLabelText('Mensaje por voz')).toHaveTextContent('Voz');

    rerender(<ChatItemRow item={items[1]} />);
    expect(screen.queryByLabelText('Mensaje por voz')).not.toBeInTheDocument();
  });

  it('builds thread-scoped conversation history without cross-thread leakage or discarded captures (S10)', () => {
    voiceSessionStore.clearThreadVoiceTurns('thread-hist-a');
    voiceSessionStore.clearThreadVoiceTurns('thread-hist-b');

    voiceSessionStore.addThreadVoiceTurn('thread-hist-a', {
      turnId: 'h-1',
      userPrompt: 'Queremos armar notificaciones',
      source: 'voz',
      reply: 'Perfecto, ¿delegamos el ODD a un hilo con AntiGravity?',
      createdAt: 1000,
    });
    voiceSessionStore.addThreadVoiceTurn('thread-hist-a', {
      turnId: 'h-discard',
      userPrompt: '[captura de voz descartada: silencio]',
      source: 'voz',
      createdAt: 1500,
    });
    voiceSessionStore.addThreadVoiceTurn('thread-hist-b', {
      turnId: 'h-other',
      userPrompt: 'Otro hilo distinto',
      source: 'voz',
      reply: 'Respuesta de otro hilo',
      createdAt: 2000,
    });

    const historyA = voiceSessionStore.getConversationHistory('thread-hist-a');
    expect(historyA).toEqual([
      { role: 'user', content: 'Queremos armar notificaciones' },
      { role: 'assistant', content: 'Perfecto, ¿delegamos el ODD a un hilo con AntiGravity?' },
    ]);
  });

  it('projects delegated thread, subagent, and autonomous agent receipts with rich metadata (S4, S10)', () => {
    const items = voiceTurnsToChatItems([
      {
        turnId: 'vt-del-1',
        userPrompt: 'Delega el ODD a un subagente y al agente Security auditor',
        source: 'voz',
        receipts: [
          {
            actionIdx: 0,
            type: 'spawn_subagent',
            ok: true,
            summaryEs: 'Subagente «ODD Planner» con Antigravity con enfoque ODD iniciado.',
            durationMs: 120,
            data: { role: 'ODD Planner', provider: 'antigravity', oddMode: true, threadId: 'sub-thread-101' },
          },
          {
            actionIdx: 1,
            type: 'launch_agent',
            ok: true,
            summaryEs: 'Delegué la tarea al agente Security auditor (claude) con enfoque ODD.',
            durationMs: 95,
            data: { agentName: 'Security auditor', provider: 'claude', oddMode: true, threadId: 'agent-thread-202' },
          },
        ],
        reply: 'Listo, ambos están trabajando en segundo plano.',
        createdAt: 3000,
      },
    ]);

    const toolItems = items.filter((i) => i.kind === 'tool');
    expect(toolItems).toHaveLength(2);
    expect(toolItems[0].detail).toBe('Subagente · ODD Planner · antigravity · ODD · 120 ms');
    expect(toolItems[0].delegatedThreadId).toBe('sub-thread-101');
    expect(toolItems[1].detail).toBe('Agente · Security auditor · claude · ODD · 95 ms');
    expect(toolItems[1].delegatedThreadId).toBe('agent-thread-202');

    // Verify clicking a delegated receipt row opens the delegated thread via kite:select-thread
    const selected: unknown[] = [];
    const onSelect = (e: Event) => selected.push((e as CustomEvent).detail);
    window.addEventListener('kite:select-thread', onSelect);

    const { rerender } = render(<ChatItemRow item={toolItems[0]} />);
    fireEvent.click(screen.getByRole('button', { name: /Abrir hilo/i }));
    rerender(<ChatItemRow item={toolItems[1]} />);
    fireEvent.click(screen.getByRole('button', { name: /Abrir agente/i }));

    window.removeEventListener('kite:select-thread', onSelect);
    expect(selected).toEqual([
      { threadId: 'sub-thread-101', mode: 'chat' },
      { threadId: 'agent-thread-202', mode: 'agents' },
    ]);
  });
});
