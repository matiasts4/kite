import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AdaptiveVadController,
  BargeInGate,
  PcmPreRollBuffer,
  computeAdaptiveEndpointMs,
  trimTrailingPcmSamples,
} from './adaptiveVad';
import { VoiceTurnArbitrator } from './turnArbitrator';
import {
  normalizeForVoiceSpeech,
  StreamingJsonReplyExtractor,
  SpeechSentenceQueue,
} from './speechProsody';
import {
  transcribeWithGrokCloud,
  resetSttEndpointCacheForTests,
  buildGrokSttWsUrl,
  float32ToInt16Pcm,
  openGrokStreamingSttSession,
  type WebSocketLike,
} from './transcriptionProviders';
import { isSpanishOpenClause, SpeculativePartialPreCapture } from './speechPartial';
import { voiceSessionStore } from './voiceSessionStore';

describe('SETH Voice Mode — Phase 1 (Barge-in, Adaptive VAD, Turn Arbitrator, Streaming Prosody, STT Cache)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetSttEndpointCacheForTests();
    localStorage.clear();
  });

  it('S1: PcmPreRollBuffer preserves the last 400ms of audio without clipping opening syllables', () => {
    const preRoll = new PcmPreRollBuffer(16000, 400); // max 6400 samples
    for (let i = 0; i < 6; i++) {
      const chunk = new Float32Array(2000).fill(i + 1);
      preRoll.push(chunk);
    }
    expect(preRoll.getSampleCount()).toBeLessThanOrEqual(6400);
    expect(preRoll.getSampleCount()).toBeGreaterThanOrEqual(4000);

    const drained = preRoll.drain();
    const lastChunk = drained[drained.length - 1];
    expect(lastChunk[lastChunk.length - 1]).toBe(6);
    expect(preRoll.getSampleCount()).toBe(0);
  });

  it('S1: BargeInGate ignores TTS attack window, requires sustained speech, and tightens after echo triggers', () => {
    const gate = new BargeInGate({
      attackGuardMs: 250,
      minBargeInRms: 0.032,
      noiseMultiplier: 4.0,
      minSustainedMs: 220,
    });
    gate.arm(1000);

    // During initial 250ms attack guard, even loud frames must not trigger barge-in
    expect(gate.evaluateFrame(0.09, 128, 0.005, 1100)).toBe(false);
    expect(gate.evaluateFrame(0.09, 128, 0.005, 1200)).toBe(false);

    // After guard, one short frame (128ms < 220ms) does not trigger yet
    expect(gate.evaluateFrame(0.05, 128, 0.005, 1400)).toBe(false);
    // Second consecutive sustained frame (>= 220ms) confirms real human barge-in
    expect(gate.evaluateFrame(0.05, 128, 0.005, 1528)).toBe(true);
    expect(gate.isArmed()).toBe(false);

    // Repeated empty barge-in triggers auto-tighten sensitivity margin
    gate.recordEmptyBargeIn();
    gate.recordEmptyBargeIn();
    expect(gate.getEffectiveMarginMultiplier()).toBeGreaterThan(1.5);
    gate.recordValidBargeIn();
    expect(gate.getEffectiveMarginMultiplier()).toBe(1);
  });

  it('S1: voiceSessionStore marks interrupted assistant replies in conversation history', () => {
    voiceSessionStore.clearThreadVoiceTurns('thr-barge');
    voiceSessionStore.addThreadVoiceTurn('thr-barge', {
      turnId: 'turn-1',
      userPrompt: 'Explícame el plan',
      source: 'voz',
      reply: 'Primero revisaremos la latencia del proxy y luego el VAD.',
      createdAt: 1000,
    });
    voiceSessionStore.markTurnInterrupted('thr-barge', 'turn-1');

    const history = voiceSessionStore.getConversationHistory('thr-barge');
    expect(history).toHaveLength(2);
    expect(history[1].content).toContain('[respuesta interrumpida por el usuario]');
  });

  it('S2: AdaptiveVadController calibrates ambient noise floor and applies Schmitt hysteresis', () => {
    const vad = new AdaptiveVadController({ minSpeechOnsetMs: 120 });

    // Ambient fan noise at 0.015 RMS calibrates the noise floor upward instead of false-triggering
    for (let i = 0; i < 8; i++) {
      const d = vad.processFrame(0.014, 64);
      expect(d.isVoiced).toBe(false);
    }
    expect(vad.getNoiseFloorRms()).toBeGreaterThan(0.01);

    // Real voice well above calibrated floor (e.g. 0.06 RMS) triggers after >= 120ms
    const onset1 = vad.processFrame(0.06, 64);
    expect(onset1.isVoiced).toBe(false);
    const onset2 = vad.processFrame(0.06, 64);
    expect(onset2.isVoiced).toBe(true);
    expect(onset2.speechStartedNow).toBe(true);

    // Release threshold is lower than onset threshold (hysteresis)
    expect(onset2.releaseThreshold).toBeLessThan(onset2.onsetThreshold);
  });

  it('S2: trimTrailingPcmSamples strips excess trailing silence across chunk boundaries cleanly', () => {
    const chunks = [
      new Float32Array([1, 2, 3, 4]),
      new Float32Array([5, 6, 7, 8]),
      new Float32Array([9, 10, 11, 12]),
    ];

    const trimmed = trimTrailingPcmSamples(chunks, 6);
    expect(trimmed.map((c) => Array.from(c))).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);

    // Zero or negative trim returns chunks intact
    expect(trimTrailingPcmSamples(chunks, 0).reduce((s, c) => s + c.length, 0)).toBe(12);
    // Clamps cleanly when trim >= total length
    expect(trimTrailingPcmSamples(chunks, 99)).toEqual([]);
  });

  it('S2: computeAdaptiveEndpointMs shortens silence on closed commands and extends on open hesitations', () => {
    expect(computeAdaptiveEndpointMs('cierra Orion', 800)).toBeLessThanOrEqual(850);
    expect(computeAdaptiveEndpointMs('Abre un hilo con Claude.', 1200)).toBeLessThanOrEqual(750);
    expect(computeAdaptiveEndpointMs('abre un hilo con', 1200)).toBeGreaterThanOrEqual(1800);
    expect(computeAdaptiveEndpointMs('quiero revisar eso y', 1400)).toBeGreaterThanOrEqual(1800);
    expect(computeAdaptiveEndpointMs('dile a Nova eh', 1000)).toBeGreaterThanOrEqual(1800);
  });

  it('S2/T2: isSpanishOpenClause detects open Spanish connectors, hesitations, and trailing punctuation', () => {
    const openCases = [
      'bueno eh',
      'necesito em',
      'revisa este',
      'abre un hilo para',
      'lanza un agente con',
      'me gustaría que',
      'el archivo de',
      'busca en',
      'hazlo por',
      'algo como',
      'claude o',
      'terminales y',
      'revisa e',
      'ni',
      'dime si',
      'quiero hacerlo porque',
      'avísame cuando',
      'mira donde',
      'intenta aunque',
      'primero revisa,',
      'espera un segundo...',
      'déjame pensar…',
    ];
    for (const phrase of openCases) {
      expect(isSpanishOpenClause(phrase), `expected open clause for "${phrase}"`).toBe(true);
      const endpointMs = computeAdaptiveEndpointMs(phrase, 2400);
      expect(endpointMs).toBeGreaterThanOrEqual(1850);
      expect(endpointMs).toBeLessThanOrEqual(2100);
    }

    expect(isSpanishOpenClause('Abre un hilo con Claude.')).toBe(false);
    expect(isSpanishOpenClause('cierra Orion')).toBe(false);
    expect(computeAdaptiveEndpointMs('quiero revisar la configuración del servidor', 1800)).toBeGreaterThanOrEqual(950);
  });

  it('T2: openGrokStreamingSttSession streams PCM16 frames, emits partials, sends audio.done, and times out handshake at 1200ms', async () => {
    expect(buildGrokSttWsUrl('https://api.x.ai/v1', 'es-ES', 400)).toBe(
      'wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=es&endpointing=400'
    );

    const pcm16 = float32ToInt16Pcm(new Float32Array([-1, 0, 0.5, 1]), 16000, 16000);
    expect(Array.from(pcm16)).toEqual([-32768, 0, 16384, 32767]);

    const sentFrames: Array<string | ArrayBuffer | ArrayBufferView> = [];
    let activeMockSocket: WebSocketLike | null = null;
    class MockWebSocket implements WebSocketLike {
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: ((ev: any) => void) | null = null;
      onmessage: ((ev: any) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      onclose: ((ev: any) => void) | null = null;
      constructor(public url: string, public protocols?: string | string[]) {
        activeMockSocket = this;
      }
      send(data: string | ArrayBuffer | ArrayBufferView) {
        sentFrames.push(data);
      }
      close() {
        this.readyState = 3;
      }
    }

    const partials: string[] = [];
    const session = openGrokStreamingSttSession({
      apiKey: 'xai-test-key',
      baseUrl: 'https://api.x.ai/v1',
      language: 'es-ES',
      WebSocketImpl: MockWebSocket,
      onPartial: (p) => partials.push(p),
    });
    expect(session).not.toBeNull();
    expect(session!.url).toContain('wss://api.x.ai/v1/stt?');

    // Queue pre-roll before socket opens, then open socket
    session!.sendPcm16(new Int16Array([100, 200]));
    activeMockSocket!.readyState = 1;
    activeMockSocket!.onopen?.({});
    expect(await session!.waitUntilReady()).toBe(true);
    expect(sentFrames).toHaveLength(1);

    // Send live frame + emit transcript.created, transcript.partial, is_final, Done
    session!.sendPcm16(new Int16Array([300, 400]));
    expect(sentFrames).toHaveLength(2);

    activeMockSocket!.onmessage?.({ data: JSON.stringify({ type: 'transcript.created', transcript: 'oye' }) });
    activeMockSocket!.onmessage?.({ data: JSON.stringify({ type: 'transcript.partial', transcript: 'oye argos' }) });
    activeMockSocket!.onmessage?.({ data: JSON.stringify({ type: 'transcript.partial', transcript: 'oye argos abre', is_final: true }) });
    expect(partials).toEqual(['oye', 'oye argos', 'oye argos abre']);

    const finishPromise = session!.finish();
    expect(sentFrames[sentFrames.length - 1]).toBe(JSON.stringify({ type: 'audio.done' }));
    activeMockSocket!.onmessage?.({ data: JSON.stringify({ type: 'Done', transcript: 'un hilo' }) });
    await expect(finishPromise).resolves.toBe('oye argos abre un hilo');

    // Handshake timeout (1200ms) fails cleanly without blocking
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const slowSession = openGrokStreamingSttSession({
        apiKey: 'xai-test-key',
        WebSocketImpl: MockWebSocket,
        onError: (err) => errors.push(err),
      });
      await vi.advanceTimersByTimeAsync(1250);
      expect(await slowSession!.waitUntilReady()).toBe(false);
      expect(slowSession!.hasFailed()).toBe(true);
      expect(errors[0]).toMatch(/1200ms/);
      await expect(slowSession!.finish()).resolves.toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('S2: VoiceTurnArbitrator queues proactive notices while user or SETH has the floor and flushes cleanly', () => {
    const arbitrator = new VoiceTurnArbitrator();
    const spoken: string[] = [];

    arbitrator.transition('speaking');
    const res = arbitrator.requestProactiveSpeech('Nova terminó su tarea.', (text) => {
      spoken.push(text);
    });
    expect(res).toBe('queued');
    expect(spoken).toEqual([]);
    expect(arbitrator.getQueuedNoticeCount()).toBe(1);

    // Still busy while user speaks
    arbitrator.transition('user_speaking');
    expect(spoken).toEqual([]);

    // Floor freed -> queued proactive notice dispatches cleanly without overlap
    arbitrator.transition('listening');
    expect(spoken).toEqual(['Nova terminó su tarea.']);
    expect(arbitrator.getQueuedNoticeCount()).toBe(0);
  });

  it('S3: StreamingJsonReplyExtractor emits complete sentences incrementally from SSE deltas', () => {
    const extractor = new StreamingJsonReplyExtractor(['answer']);
    const deltas = [
      '{"an',
      'swer":"Hola, estoy revisando el proyecto. ',
      'Nova ya terminó los tests y ',
      'todo pasó en verde.","actions":[]}',
    ];

    const emitted: string[] = [];
    for (const d of deltas) {
      emitted.push(...extractor.pushDelta(d));
    }
    emitted.push(...extractor.finish());

    expect(emitted).toEqual([
      'Hola, estoy revisando el proyecto.',
      'Nova ya terminó los tests y todo pasó en verde.',
    ]);
  });

  it('S3: SpeechSentenceQueue serializes sentences and halts cleanly on barge-in abort', async () => {
    const spoken: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocking = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const queue = new SpeechSentenceQueue({
      speakSentence: async (sentence, idx) => {
        spoken.push(sentence);
        if (idx === 0) await firstBlocking;
      },
    });

    queue.enqueue('Primera oración.');
    queue.enqueue('Segunda oración que no debe sonar tras barge-in.');

    await Promise.resolve();
    expect(spoken).toEqual(['Primera oración.']);

    queue.abort();
    releaseFirst();
    await queue.close();

    expect(spoken).toEqual(['Primera oración.']);
  });

  it('S3: transcribeWithGrokCloud caches dead 404 endpoint so second turn skips wasted round-trip', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'primera orden' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'segunda orden' }), { status: 200 }));

    const blob = new Blob([new Uint8Array(512)], { type: 'audio/wav' });
    const first = await transcribeWithGrokCloud(blob, 'xai-key', 'https://api.x.ai/v1');
    expect(first).toBe('primera orden');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // probed /stt (404) then /audio/transcriptions (200)

    const second = await transcribeWithGrokCloud(blob, 'xai-key', 'https://api.x.ai/v1');
    expect(second).toBe('segunda orden');
    expect(fetchSpy).toHaveBeenCalledTimes(3); // skipped /stt directly!
    expect(String(fetchSpy.mock.calls[2][0])).toContain('/audio/transcriptions');
  });

  it('S4: normalizeForVoiceSpeech scrubs UUIDs, OS/repo paths, URLs, flags, SHAs, and template clichés', () => {
    const raw =
      'Abrí el hilo (ID: 550e8400-e29b-41d4-a716-446655440000) para revisar C:\\Users\\PC\\Desktop\\kite\\src\\lib\\operator\\zedVoice.ts con --via thread en https://docs.kite.dev/voice/spec y commit a1b2c3d. Seguimos conversando por acá.';
    const spoken = normalizeForVoiceSpeech(raw);

    expect(spoken).not.toContain('550e8400');
    expect(spoken).not.toContain('C:\\Users');
    expect(spoken).not.toContain('--via');
    expect(spoken).not.toContain('https://');
    expect(spoken).not.toContain('a1b2c3d');
    expect(spoken).not.toMatch(/Seguimos conversando por ac[aá]/i);
    expect(spoken).toContain('zedVoice.ts');
    expect(spoken).toContain('docs.kite.dev');
  });

  it('S3/T3: SpeculativePartialPreCapture fires after >250ms stable partial and cancels when speech changes', async () => {
    vi.useFakeTimers();
    try {
      const onStable = vi.fn(async (partial: string) => ({
        workspaceId: 'ws-spec',
        workspaceName: `spec:${partial}`,
      }));
      const spec = new SpeculativePartialPreCapture({
        stabilityMs: 250,
        onStable,
      });

      spec.update('revisa el');
      await vi.advanceTimersByTimeAsync(150);
      expect(onStable).not.toHaveBeenCalled();

      // Speech changed before 250ms -> old timer cancelled
      spec.update('revisa el archivo auth');
      await vi.advanceTimersByTimeAsync(200);
      expect(onStable).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(70);
      expect(onStable).toHaveBeenCalledTimes(1);
      expect(onStable).toHaveBeenCalledWith('revisa el archivo auth');

      const consumed = spec.consume('revisa el archivo auth por favor');
      expect(consumed?.workspaceId).toBe('ws-spec');
      // Second consume returns null (consumed once)
      expect(spec.consume('revisa el archivo auth por favor')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
