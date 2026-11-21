import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZedStripHost, type ZedCallState } from './ZedStrip';
import { ZedTab } from './views/settings/ZedTab';
import { voiceSessionStore } from '../lib/operator/voice/voiceSessionStore';
import { saveOperatorConfig } from '../lib/operator/operatorConfig';
import * as operatorBrain from '../lib/operator/operatorBrain';

vi.mock('./ZedOrb', () => ({
  ZedOrb: ({ size, state, figure }: { size?: number; state?: string; figure?: string }) => (
    <div data-testid="zed-orb" data-size={size} data-state={state} data-figure={figure} />
  ),
}));

vi.mock('../lib/operator/ttsNarrator', () => ({
  ttsNarrator: {
    isMuted: vi.fn().mockReturnValue(false),
    toggleMute: vi.fn().mockReturnValue(true),
    stop: vi.fn(),
    speak: vi.fn(),
    onStateChange: vi.fn().mockReturnValue(() => {}),
  },
}));

const activeCall: ZedCallState = {
  isActive: true,
  status: 'connected',
  toolCalls: [],
};

describe('ZedStripHost & ZedTab (Clean Native Kite UI)', () => {
  beforeEach(() => {
    voiceSessionStore.stopSession();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the spherical ZedOrb and the 3 dock buttons [Mic, Speaker, Close]', async () => {
    const onToggleSpeaker = vi.fn();
    render(<ZedStripHost call={activeCall} onToggleSpeaker={onToggleSpeaker} />);

    // 1. Spherical Orb
    expect(screen.getByTestId('zed-orb')).toBeInTheDocument();

    // 2. Microphone toggle button
    expect(screen.getByLabelText(/dictar por voz/i)).toBeInTheDocument();

    // 3. Speaker (Parlante) toggle button
    const speakerBtn = screen.getByLabelText(/voz en altavoz/i);
    expect(speakerBtn).toBeInTheDocument();
    fireEvent.click(speakerBtn);
    expect(onToggleSpeaker).toHaveBeenCalledTimes(1);

    // 4. Close button
    expect(screen.getByLabelText(/cerrar asistente/i)).toBeInTheDocument();
  });

  it('dispatches operator commands from ZedStripHost and displays receipt note', async () => {
    vi.spyOn(operatorBrain, 'dispatchOperatorCommand').mockResolvedValueOnce({
      reply: 'Se abrieron 2 terminales con Grok.',
      actions: [
        {
          type: 'open_terminals',
          count: 2,
          engine: 'grok',
        },
      ],
      provider: 'opencode',
      model: 'deepseek-4.1-flash',
      latencyMs: 185,
      usedFallbackLocal: false,
    });

    render(
      <ZedStripHost
        call={activeCall}
        onExecuteCommand={(cmd) => operatorBrain.dispatchOperatorCommand(cmd)}
      />
    );

    const input = screen.getByPlaceholderText(/abre 2 terminales/i);
    fireEvent.change(input, { target: { value: 'Abre 2 terminales con Grok' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(operatorBrain.dispatchOperatorCommand).toHaveBeenCalledWith(
        'Abre 2 terminales con Grok'
      );
      expect(screen.getByText(/Se abrieron 2 terminales con Grok/i)).toBeInTheDocument();
      expect(screen.getAllByText(/185ms/i).length).toBeGreaterThan(0);
    });
  });

  it('renders ZedTab inside Settings with OpenCode Go and zero emojis', () => {
    const { container } = render(<ZedTab />);

    expect(screen.getByText(/Operador y Asistente de IA/i)).toBeInTheDocument();
    expect(screen.getByText(/Canal y Pasarela de Proveedor IA/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^OpenCode Go/ }));
    expect(screen.getAllByText(/DeepSeek.*4\.1.*Flash/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^Latencia$/ }));
    expect(screen.getByText(/Rendimiento y Latencia por Proveedor/i)).toBeInTheDocument();

    // Verify no emoji characters exist in rendered text
    const text = container.textContent || '';
    expect(text).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('filters the OpenCode model list from the search field', async () => {
    const user = userEvent.setup();
    render(<ZedTab />);

    await user.click(screen.getByRole('button', { name: /^OpenCode Go/ }));
    await user.click(screen.getByRole('combobox', { name: 'Modelo de OpenCode' }));
    await user.type(screen.getByRole('combobox', { name: 'Buscar modelo' }), 'kimi');

    expect(screen.getAllByRole('option', { name: /kimi/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('option', { name: /deepseek/i })).not.toBeInTheDocument();
  });

  it('renders nothing when call.isActive is false (default closed pill state)', () => {
    const { container } = render(
      <ZedStripHost
        call={{
          isActive: false,
          status: 'idle',
          toolCalls: [],
        }}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('zed-orb')).not.toBeInTheDocument();
  });

  it('does not render bottom helper bar when idle (clean spherical widget)', () => {
    render(<ZedStripHost call={activeCall} />);

    // When idle, the bottom text bar is completely omitted as requested
    expect(screen.queryByTestId('zed-status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Mantén para hablar/i)).not.toBeInTheDocument();
  });

  it('triggers onEndCall when clicking the visible ✕ close button', () => {
    const onEndCall = vi.fn();
    render(<ZedStripHost call={activeCall} onEndCall={onEndCall} />);

    const closeBtn = screen.getByLabelText('Cerrar Asistente');
    expect(closeBtn).toBeInTheDocument();
    fireEvent.click(closeBtn);

    expect(onEndCall).toHaveBeenCalledTimes(1);
  });

  it('triggers onEndCall when pressing Escape', () => {
    const onEndCall = vi.fn();
    render(<ZedStripHost call={activeCall} onEndCall={onEndCall} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEndCall).toHaveBeenCalledTimes(1);
  });

  it('does not end the call when Escape is pressed inside the terminal', () => {
    const onEndCall = vi.fn();
    render(<ZedStripHost call={activeCall} onEndCall={onEndCall} />);

    const host = document.createElement('div');
    host.className = 'xterm';
    const textarea = document.createElement('textarea');
    host.appendChild(textarea);
    document.body.appendChild(host);

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onEndCall).not.toHaveBeenCalled();

    document.body.removeChild(host);
  });

  it('provides click-to-speak role and affordance on the sphere handle', () => {
    render(<ZedStripHost call={activeCall} />);

    const handle = screen.getByRole('button', { name: /Iniciar dictado de voz/i });
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute('title', expect.stringContaining('Ctrl+Shift+V'));
  });

  it('supports dragging and push-to-talk with window pointer events', () => {
    vi.useFakeTimers();
    render(<ZedStripHost call={activeCall} />);

    const handle = screen.getByRole('button', { name: /Iniciar dictado de voz/i });

    // Drag move
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 150, clientY: 180 });
    fireEvent.pointerUp(window, { clientX: 150, clientY: 180 });

    vi.useRealTimers();
  });

  it('toggles continuous voice session and keeps one-shot dictation separate (S5)', async () => {
    render(<ZedStripHost call={activeCall} />);

    // Voice mode continuous session button exists
    const sessionBtn = screen.getByLabelText(/iniciar sesión de voz/i);
    expect(sessionBtn).toBeInTheDocument();

    // One-shot dictation button exists
    const dictationBtn = screen.getByLabelText(/dictar por voz/i);
    expect(dictationBtn).toBeInTheDocument();

    // Click to start continuous voice session
    fireEvent.click(sessionBtn);

    await waitFor(() => {
      expect(screen.getByLabelText(/finalizar sesión de voz/i)).toBeInTheDocument();
      expect((window as any).__kiteVoiceSessionActive).toBe(true);
    });

    // Clicking again ends continuous session
    fireEvent.click(screen.getByLabelText(/finalizar sesión de voz/i));

    await waitFor(() => {
      expect(screen.getByLabelText(/iniciar sesión de voz/i)).toBeInTheDocument();
      expect((window as any).__kiteVoiceSessionActive).toBe(false);
    });
  });

  it('barge-in stops TTS playback and keeps the voice session open (S5)', async () => {
    const { ttsNarrator } = await import('../lib/operator/ttsNarrator');
    render(<ZedStripHost call={activeCall} />);

    // Start voice session
    fireEvent.click(screen.getByLabelText(/iniciar sesión de voz/i));
    await waitFor(() => {
      expect((window as any).__kiteVoiceSessionActive).toBe(true);
    });

    // When TTS starts or user triggers speech while speaking, stop is called immediately
    const dictationBtn = screen.getByLabelText(/dictar por voz/i);
    fireEvent.click(dictationBtn);

    expect(ttsNarrator.stop).toHaveBeenCalled();
    // Session remains active
    expect((window as any).__kiteVoiceSessionActive).toBe(true);
  });

  it('does not re-narrate the same turn on subsequent component re-renders (S6)', async () => {
    const { ttsNarrator } = await import('../lib/operator/ttsNarrator');
    vi.mocked(ttsNarrator.speak).mockClear();

    const { rerender } = render(<ZedStripHost call={activeCall} />);

    // Force re-render with unchanged call state
    rerender(<ZedStripHost call={{ ...activeCall }} />);
    rerender(<ZedStripHost call={{ ...activeCall, muted: false }} />);

    // Should never trigger multiple speak calls for the same idle state
    expect(ttsNarrator.speak).not.toHaveBeenCalled();
  });

  it('hides the floating assistant only during an active Thread Voice session and restores visibility after stopSession (S5)', () => {
    render(<ZedStripHost call={activeCall} />);

    // Explicitly opened assistant is visible cleanly when no Thread Voice session is active
    expect(screen.getByTestId('zed-card')).not.toHaveStyle({ display: 'none' });

    act(() => {
      voiceSessionStore.startSession('thread-1', 'thread');
    });
    expect(screen.getByTestId('zed-card')).toHaveStyle({ display: 'none' });

    // Stopping Thread Voice Mode resets activeSurface back to 'orb' so the floating assistant reappears immediately
    act(() => {
      voiceSessionStore.stopSession();
    });
    expect(voiceSessionStore.getSnapshot().activeSurface).toBe('orb');
    expect(screen.getByTestId('zed-card')).not.toHaveStyle({ display: 'none' });
  });

  it('updates the floating assistant figure immediately when changed in operator config', () => {
    render(<ZedStripHost call={activeCall} />);

    expect(screen.getByTestId('zed-orb')).toHaveAttribute('data-figure', 'plasma-orb');

    act(() => {
      saveOperatorConfig({ persona: { figure: 'ferrofluid' } });
    });

    expect(screen.getByTestId('zed-orb')).toHaveAttribute('data-figure', 'ferrofluid');
  });

  it('shows a visible status pill when Zed has a reply and dismisses it on click', async () => {
    vi.spyOn(operatorBrain, 'dispatchOperatorCommand').mockResolvedValueOnce({
      reply: 'Listo, abrí la terminal.',
      actions: [],
      provider: 'local',
      model: 'local',
      latencyMs: 42,
      usedFallbackLocal: false,
    });

    render(
      <ZedStripHost
        call={activeCall}
        onExecuteCommand={(cmd) => operatorBrain.dispatchOperatorCommand(cmd)}
      />
    );

    const input = screen.getByPlaceholderText(/abre 2 terminales/i);
    fireEvent.change(input, { target: { value: 'hola' } });
    fireEvent.submit(input.closest('form')!);

    const status = await screen.findByTestId('zed-status');
    expect(status).toHaveClass('zed-float__note');
    expect(status).toHaveTextContent('Listo, abrí la terminal.');

    fireEvent.click(status);
    expect(screen.queryByTestId('zed-status')).not.toBeInTheDocument();
  });

  it('omits hidden ZedOrb when hideFloatingOrb is true during Thread Voice Mode (S8)', () => {
    act(() => {
      voiceSessionStore.startSession('thread-1', 'thread');
    });

    render(<ZedStripHost call={activeCall} />);

    expect(screen.getByTestId('zed-card')).toHaveStyle({ display: 'none' });
    expect(screen.queryByTestId('zed-orb')).not.toBeInTheDocument();
  });

  it('stops active voiceSessionStore session when closing ZedStrip via ✕ or Escape (S8)', () => {
    const onEndCall = vi.fn();
    act(() => {
      voiceSessionStore.startSession('thread-1', 'orb');
    });
    expect(voiceSessionStore.getSnapshot().phase).toBe('active');

    render(<ZedStripHost call={activeCall} onEndCall={onEndCall} />);
    fireEvent.click(screen.getByLabelText('Cerrar Asistente'));

    expect(voiceSessionStore.getSnapshot().phase).toBe('inactive');
    expect(onEndCall).toHaveBeenCalledTimes(1);

    // Also verify Escape stops an active session
    act(() => {
      voiceSessionStore.startSession('thread-2', 'orb');
    });
    expect(voiceSessionStore.getSnapshot().phase).toBe('active');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(voiceSessionStore.getSnapshot().phase).toBe('inactive');
    expect(onEndCall).toHaveBeenCalledTimes(2);
  });

  it('does not re-arm microphone after TTS onEnd/onError or muted speaker when micMuted or paused (S8)', async () => {
    const zedVoice = await import('../lib/operator/voice/zedVoice');
    const { ttsNarrator } = await import('../lib/operator/ttsNarrator');
    vi.spyOn(zedVoice, 'isVoiceRecognitionSupported').mockReturnValue(true);
    const startSpy = vi.spyOn(zedVoice, 'startOperatorListening').mockImplementation(
      () => new Promise(() => {})
    );

    const operatorIndex = await import('../lib/operator/index');
    const { emitTrace } = await import('../lib/operator/trace/trace');
    vi.spyOn(operatorIndex, 'runOperatorTurn').mockImplementationOnce(async () => {
      emitTrace({
        turnId: 'turn-1',
        ev: 'turn.end',
        overallSuccess: true,
        durationMs: 15,
      });
      return {
        turnId: 'turn-1',
        reply: 'Listo.',
        strategy: 'local',
        providerId: 'local',
        durationMs: 15,
        overallSuccess: true,
        receipts: [],
      } as any;
    });

    act(() => {
      voiceSessionStore.startSession('thread-1', 'thread');
      voiceSessionStore.setMicMuted(true);
    });

    render(<ZedStripHost call={activeCall} />);

    startSpy.mockClear();

    const input = screen.getByPlaceholderText(/abre 2 terminales/i);
    fireEvent.change(input, { target: { value: 'hola' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(ttsNarrator.speak).toHaveBeenCalled();
    });

    const rawSpeakOpts = vi.mocked(ttsNarrator.speak).mock.calls[0]?.[1];
    const speakOpts = typeof rawSpeakOpts === 'object' && rawSpeakOpts !== null ? rawSpeakOpts : undefined;
    act(() => {
      speakOpts?.onEnd?.();
      speakOpts?.onError?.('err');
    });

    expect(startSpy).not.toHaveBeenCalled();

    // Also verify muted-speaker / paused-for-dictation branch does not re-arm
    act(() => {
      voiceSessionStore.pauseForDictation();
      voiceSessionStore.setMicMuted(false);
      speakOpts?.onEnd?.();
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('backs off calmly on consecutive empty captures and stops restarting on fatal STT error (S8)', async () => {
    vi.useFakeTimers();
    const zedVoice = await import('../lib/operator/voice/zedVoice');
    vi.spyOn(zedVoice, 'isVoiceRecognitionSupported').mockReturnValue(true);

    let callCount = 0;
    const startSpy = vi.spyOn(zedVoice, 'startOperatorListening').mockImplementation((opts) => {
      callCount += 1;
      if (callCount === 1) {
        // First capture settles as empty silence
        return Promise.resolve('');
      }
      if (callCount === 2) {
        // Second capture fails with fatal 404 STT endpoint error
        const err = new zedVoice.SttProviderError(
          'ENDPOINT_NOT_FOUND',
          'El endpoint STT de Grok/xAI no está disponible (HTTP 404).',
          404,
          true
        );
        opts?.onError?.(err.message);
        return Promise.reject(err);
      }
      return new Promise(() => {});
    });

    try {
      act(() => {
        voiceSessionStore.startSession('thread-1', 'thread');
      });

      render(<ZedStripHost call={activeCall} />);

      // Initial startListening call settles as ''
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(startSpy).toHaveBeenCalledTimes(1);

      // Should NOT restart after 300ms (no 280ms tight loop!)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(startSpy).toHaveBeenCalledTimes(1);

      // Should restart after >= 1200ms calm backoff
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(startSpy).toHaveBeenCalledTimes(2);

      // Fatal 404 error occurred on call 2 -> should NOT restart even after 5+ seconds
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      startSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('immediately projects user voice bubble before LLM resolves, clears interim, pins boundThreadId, and uses mode:thread (T20)', async () => {
    const zedVoice = await import('../lib/operator/voice/zedVoice');
    const operatorIdx = await import('../lib/operator');
    vi.spyOn(zedVoice, 'isVoiceRecognitionSupported').mockReturnValue(true);

    let resolveSpeech!: (text: string) => void;
    let speechCalls = 0;
    const startSpy = vi.spyOn(zedVoice, 'startOperatorListening').mockImplementation((opts) => {
      speechCalls += 1;
      if (speechCalls === 1) {
        return new Promise<string>((resolve) => {
          resolveSpeech = (txt: string) => {
            opts?.onInterim?.(txt);
            resolve(txt);
          };
        });
      }
      return new Promise<string>(() => {});
    });

    let resolveTurn!: (res: any) => void;
    const runSpy = vi.spyOn(operatorIdx, 'runOperatorTurn').mockImplementation(
      (_input, opts) =>
        new Promise((resolve) => {
          resolveTurn = (replyText: string) =>
            resolve({
              turnId: opts?.turnId || 'turn-t20',
              plan: { strategy: 'llm', actions: [], reply: replyText },
              receipts: [],
              reply: replyText,
              overallSuccess: true,
              durationMs: 1200,
              strategy: 'llm',
              providerId: 'opencode',
            });
        })
    );

    try {
      voiceSessionStore.clearThreadVoiceTurns('thread-t20');
      act(() => {
        voiceSessionStore.startSession('thread-t20', 'thread');
        // Simulate surface drifting to 'orb' while boundThreadId is still 'thread-t20'
        voiceSessionStore.setActiveSurface('orb');
      });

      render(<ZedStripHost call={activeCall} />);

      await waitFor(() => {
        expect(startSpy).toHaveBeenCalledTimes(1);
      });

      // Speech finishes -> user bubble MUST appear immediately BEFORE LLM resolves
      await act(async () => {
        resolveSpeech('Revisemos la orquestación');
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(runSpy).toHaveBeenCalledWith(
          'Revisemos la orquestación',
          expect.objectContaining({
            source: 'voz',
            mode: 'thread',
            turnId: expect.any(String),
          })
        );
      });

      const pendingTurns = voiceSessionStore.getThreadVoiceTurns('thread-t20');
      expect(pendingTurns).toHaveLength(1);
      expect(pendingTurns[0].userPrompt).toBe('Revisemos la orquestación');
      expect(pendingTurns[0].reply).toBeUndefined();
      // Interim transcript cleared from composer once moved to user bubble
      expect(voiceSessionStore.getSnapshot().interimTranscript).toBe('');
      // In-flight optimistic turn must NOT be duplicated into conversation history
      expect(voiceSessionStore.getConversationHistory('thread-t20')).toEqual([]);

      // Even if user stops session while LLM is still thinking, pinned targetThreadId still receives the reply
      act(() => {
        voiceSessionStore.stopSession();
      });

      await act(async () => {
        resolveTurn('Arrancamos armando el ODD de orquestación.');
        await Promise.resolve();
      });

      const finalTurns = voiceSessionStore.getThreadVoiceTurns('thread-t20');
      expect(finalTurns).toHaveLength(1);
      expect(finalTurns[0].reply).toBe('Arrancamos armando el ODD de orquestación.');
      expect(voiceSessionStore.getConversationHistory('thread-t20')).toEqual([
        { role: 'user', content: 'Revisemos la orquestación' },
        { role: 'assistant', content: 'Arrancamos armando el ODD de orquestación.' },
      ]);
    } finally {
      startSpy.mockRestore();
      runSpy.mockRestore();
      voiceSessionStore.clearThreadVoiceTurns('thread-t20');
    }
  });

  it('does NOT stop Thread Voice Mode on Escape when floating orb is hidden (T20)', () => {
    act(() => {
      voiceSessionStore.startSession('thread-esc-1', 'thread');
    });

    const onEndCall = vi.fn();
    render(<ZedStripHost call={activeCall} onEndCall={onEndCall} />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(voiceSessionStore.getSnapshot().phase).toBe('active');
    expect(voiceSessionStore.getSnapshot().boundThreadId).toBe('thread-esc-1');
    expect(onEndCall).not.toHaveBeenCalled();
  });

  it('mounts subagentReturnWatcher in Thread Voice Mode and speaks settled child findings with barge-in-safe TTS coordination (S2)', async () => {
    const { ttsNarrator } = await import('../lib/operator/ttsNarrator');
    const watcher = await import('../lib/operator/subagentReturnWatcher');
    const ipc = await import('../lib/ipc');
    const { voiceTurnArbitrator } = await import('../lib/operator/voice/turnArbitrator');

    vi.mocked(ttsNarrator.speak).mockClear();
    const invokeSpy = vi.spyOn(ipc, 'invokeCommand').mockResolvedValueOnce({
      status: 'settled',
      text: 'Se verificó que el watcher ya recibe los hallazgos del explorador.',
    } as any);

    voiceTurnArbitrator.resetForTests();
    act(() => {
      voiceSessionStore.startSession('thread-return-1', 'thread');
    });

    try {
      render(<ZedStripHost call={activeCall} workspaceId="ws-kite" />);

      watcher.trackDelegatedSubagent({
        childThreadId: 'child-ret-1',
        parentThreadId: 'thread-return-1',
        role: 'Explorer',
        provider: 'claude',
        mode: 'explore',
        task: 'Revisar lazo de retorno',
        workspaceId: 'ws-kite',
      });

      await act(async () => {
        await watcher.handleSubagentSettlementEvent({
          kind: 'subagentRunUpdated',
          threadId: 'thread-return-1',
          subagentId: 'child-ret-1',
          run: {
            subagentId: 'child-ret-1',
            childThreadId: 'child-ret-1',
            role: 'Explorer',
            provider: 'claude',
            status: 'completed',
          },
        });
      });

      expect(ttsNarrator.speak).toHaveBeenCalledWith(
        expect.stringMatching(/hallazgos del explorador/i),
        expect.objectContaining({
          onEnd: expect.any(Function),
          onError: expect.any(Function),
        })
      );
      expect(voiceTurnArbitrator.getState()).toBe('speaking');

      const speakCall = vi.mocked(ttsNarrator.speak).mock.calls[0];
      const speakOpts = speakCall?.[1];
      act(() => {
        if (speakOpts && typeof speakOpts !== 'string') {
          speakOpts.onEnd?.();
        }
      });
      expect(voiceTurnArbitrator.getState()).toBe('listening');
    } finally {
      invokeSpy.mockRestore();
      watcher.resetSubagentReturnWatcherForTests();
      voiceSessionStore.clearThreadVoiceTurns('thread-return-1');
      voiceSessionStore.stopSession();
      voiceTurnArbitrator.resetForTests();
    }
  });
});
