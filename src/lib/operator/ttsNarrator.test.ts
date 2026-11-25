import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ttsNarrator,
  cleanTextForSpeech,
  resolveBestVoice,
  splitIntoSpeechSentences,
  truncateTextToHeardMs,
  SentenceStreamChunker,
} from './ttsNarrator';

describe('TTSNarrator — ElevenLabs Streaming & Browser Speech', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();

    // Mock speechSynthesis
    const mockSpeechSynthesis = {
      speaking: false,
      paused: false,
      pending: false,
      speak: vi.fn((utterance: any) => {
        setTimeout(() => {
          utterance.onstart?.();
          utterance.onend?.();
        }, 10);
      }),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      getVoices: vi.fn(() => [
        { name: 'Microsoft Helena - Spanish (Spain)', lang: 'es-ES', default: true },
        { name: 'Google español', lang: 'es-ES', default: false },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    (globalThis as any).window = {
      speechSynthesis: mockSpeechSynthesis,
    };
    (globalThis as any).SpeechSynthesisUtterance = class {
      text: string;
      lang = 'es-ES';
      voice: any = null;
      rate = 1.0;
      pitch = 1.0;
      volume = 1.0;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((err: any) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    };
  });

  afterEach(() => {
    ttsNarrator.stop();
  });

  describe('cleanTextForSpeech', () => {
    it('strips markdown code blocks and leaves a natural pause', () => {
      const input = 'Aquí tienes el script:\n```bash\nnpm run test\n```\n¿Deseas ejecutarlo?';
      const output = cleanTextForSpeech(input);
      expect(output).not.toContain('npm run test');
      expect(output).toContain('bloque de código omitido');
      expect(output).toContain('¿Deseas ejecutarlo?');
    });

    it('cleans inline code backticks, file paths, UUIDs, links and emojis', () => {
      const input = 'Revisa `src/main.ts` y [la documentación](https://example.com) 🚀!';
      const output = cleanTextForSpeech(input);
      expect(output).toBe('Revisa main.ts y la documentación!');
      expect(output).not.toContain('src/');

      const withUuidAndPath =
        'Hilo 550e8400-e29b-41d4-a716-446655440000 en C:\\Users\\dev\\repo\\app.ts listo.';
      const cleaned = cleanTextForSpeech(withUuidAndPath);
      expect(cleaned).not.toContain('550e8400');
      expect(cleaned).not.toContain('C:\\Users');
      expect(cleaned).toContain('app.ts');
    });
  });

  describe('resolveBestVoice', () => {
    it('matches neural or natural voices when available', () => {
      const voices: any[] = [
        { name: 'Microsoft Helena Desktop', lang: 'es-ES' },
        { name: 'Microsoft Dalia Online (Natural) - Spanish', lang: 'es-ES' },
      ];
      const match = resolveBestVoice(voices, 'Ara', 'es-ES');
      expect(match?.name).toContain('Natural');
    });
  });

  describe('ElevenLabs Neural Streaming', () => {
    it('calls ElevenLabs stream API when configured with elevenlabs engine and apiKey', async () => {
      const mockBlob = new Blob(['fake-audio-bytes'], { type: 'audio/mpeg' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(mockBlob),
      } as any);

      // Mock URL.createObjectURL and Audio
      (globalThis as any).URL = {
        createObjectURL: vi.fn(() => 'blob:http://localhost/fake-audio'),
        revokeObjectURL: vi.fn(),
      };

      class MockAudio {
        src = '';
        volume = 1;
        paused = true;
        ended = false;
        onplay: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: ((err: any) => void) | null = null;
        constructor(src: string) {
          this.src = src;
        }
        play() {
          this.paused = false;
          setTimeout(() => {
            this.onplay?.();
            this.paused = true;
            this.ended = true;
            this.onended?.();
          }, 10);
          return Promise.resolve();
        }
        pause() {
          this.paused = true;
        }
      }
      (globalThis as any).Audio = MockAudio;

      const onStart = vi.fn();
      const onEnd = vi.fn();

      await ttsNarrator.speak('Hola, soy Zed con voz de ElevenLabs.', {
        engine: 'elevenlabs',
        elevenlabsApiKey: 'xi_test_key_123',
        elevenlabsModel: 'eleven_v4_turbo',
        elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
        onStart,
        onEnd,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toContain('api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream');
      expect((init as any).headers['xi-api-key']).toBe('xi_test_key_123');
      expect(JSON.parse((init as any).body).model_id).toBe('eleven_v4_turbo');
      expect(onStart).toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalled();
    });

    it('begins audio playback as chunks arrive before full audio finishes (S5 streamed narration)', async () => {
      const chunk1 = new Uint8Array([1, 2, 3]);

      class MockSourceBuffer {
        onupdateend?: () => void;
        addEventListener = vi.fn((event: string, cb: () => void) => {
          if (event === 'updateend') this.onupdateend = cb;
        });
        appendBuffer = vi.fn(() => {
          setTimeout(() => this.onupdateend?.(), 5);
        });
      }

      class MockMediaSource {
        readyState = 'open';
        addEventListener = vi.fn((event: string, cb: () => void) => {
          if (event === 'sourceopen') setTimeout(cb, 5);
        });
        addSourceBuffer = vi.fn(() => new MockSourceBuffer());
        endOfStream = vi.fn();
        static isTypeSupported = vi.fn(() => true);
      }
      (globalThis as any).MediaSource = MockMediaSource;

      let mockAudioInstance: any = null;
      class MockStreamingAudio {
        src = '';
        volume = 1;
        paused = true;
        onplay: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: ((err: any) => void) | null = null;
        constructor(src: string) {
          this.src = src;
          mockAudioInstance = this;
        }
        play() {
          this.paused = false;
          this.onplay?.();
          return Promise.resolve();
        }
        pause() {
          this.paused = true;
        }
      }
      (globalThis as any).Audio = MockStreamingAudio;

      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: chunk1 })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn(),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader: () => mockReader },
      } as any);

      (globalThis as any).URL = {
        createObjectURL: vi.fn(() => 'blob:http://localhost/stream-audio'),
        revokeObjectURL: vi.fn(),
      };

      const onStart = vi.fn();
      const onEnd = vi.fn();

      const speakPromise = ttsNarrator.speak('Texto para streaming en tiempo real.', {
        engine: 'elevenlabs',
        elevenlabsApiKey: 'xi_test_stream_key',
        onStart,
        onEnd,
      });

      setTimeout(() => {
        mockAudioInstance?.onended?.();
      }, 30);

      await speakPromise;

      expect(mockReader.read).toHaveBeenCalled();
      expect(onStart).toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalled();
    });

    it('falls back seamlessly to browser speechSynthesis if ElevenLabs request fails', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as any);

      const onStart = vi.fn();
      const onEnd = vi.fn();

      await ttsNarrator.speak('Prueba de fallback automático.', {
        engine: 'elevenlabs',
        elevenlabsApiKey: 'invalid_key',
        onStart,
        onEnd,
      });

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect((globalThis as any).window.speechSynthesis.speak).toHaveBeenCalled();
      expect(onStart).toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalled();
    });

    it('stops audio playback and aborts in-flight request when stop() is called', async () => {
      const abortSpy = vi.fn();
      const originalAbortController = globalThis.AbortController;

      (globalThis as any).AbortController = class {
        signal = { aborted: false };
        abort() {
          this.signal.aborted = true;
          abortSpy();
        }
      };

      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init: any) => {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            if (init.signal?.aborted) {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            } else {
              resolve({ ok: true, blob: vi.fn().mockResolvedValue(new Blob()) } as any);
            }
          }, 100);
        });
      });

      const speakPromise = ttsNarrator.speak('Mensaje que será cancelado a mitad de camino.', {
        engine: 'elevenlabs',
        elevenlabsApiKey: 'test_key',
      });

      ttsNarrator.stop();
      expect(abortSpy).toHaveBeenCalled();
      await speakPromise;

      globalThis.AbortController = originalAbortController;
    });

    it('does NOT trigger browser fallback when playback is aborted or interrupted with stop()', async () => {
      const speakSpy = (globalThis as any).window.speechSynthesis.speak;
      speakSpy.mockClear();

      vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          blob: vi.fn().mockResolvedValue(new Blob()),
        } as any);
      });

      // Mock Audio
      const playMock = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => {
            const err = new Error('The play() request was interrupted by a call to pause().');
            err.name = 'AbortError';
            reject(err);
          }, 20);
        });
      });

      (globalThis as any).Audio = class {
        play = playMock;
        pause = vi.fn();
        volume = 1;
        src = '';
        currentTime = 0;
      };

      const speakPromise = ttsNarrator.speak('Mensaje largo que el usuario interrumpe.', {
        engine: 'elevenlabs',
        elevenlabsApiKey: 'valid_key',
      });

      // User interrupts
      ttsNarrator.stop();
      await speakPromise;

      // Crucial: Browser synthesis MUST NOT be called!
      expect(speakSpy).not.toHaveBeenCalled();
    });

    it('splitIntoSpeechSentences breaks multi-sentence text to prevent 15s freeze (S7)', () => {
      const longText =
        'Esta es la primera oración completa del asistente. Aquí viene la segunda parte con más detalles sobre la tarea. Y finalmente cerramos con las conclusiones.';
      const chunks = splitIntoSpeechSentences(longText);

      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe('Esta es la primera oración completa del asistente.');
      expect(chunks[1]).toBe('Aquí viene la segunda parte con más detalles sobre la tarea.');
      expect(chunks[2]).toBe('Y finalmente cerramos con las conclusiones.');
    });

    it('speaks multiple sentence chunks sequentially without cutting off (S7)', async () => {
      const speakSpy = vi.spyOn(window.speechSynthesis, 'speak');
      const text = 'Primera oración clara. Segunda oración con más contexto.';

      await ttsNarrator.speak(text, { engine: 'browser' });

      // Must have spoken each sentence chunk separately
      expect(speakSpy).toHaveBeenCalledTimes(2);
    });

    it('never cuts off a long-duration browser utterance by wall-clock timeout (S9)', async () => {
      vi.useFakeTimers();
      try {
        const utterances: any[] = [];
        const synth = (globalThis as any).window.speechSynthesis;
        synth.speak = vi.fn((utterance: any) => {
          utterances.push(utterance);
          synth.speaking = true;
          // Fires onstart immediately, but takes 30s to finish speaking
          setTimeout(() => {
            utterance.onstart?.();
          }, 10);
          setTimeout(() => {
            synth.speaking = false;
            utterance.onend?.();
          }, 30000);
        });

        const onStart = vi.fn();
        const onEnd = vi.fn();
        const speakPromise = ttsNarrator.speak(
          'Esta es una oración larga que tarda treinta segundos en leerse completa. Y aquí viene la segunda oración.',
          { engine: 'browser', onStart, onEnd }
        );

        // Flush getAvailableVoices() microtasks
        await vi.advanceTimersByTimeAsync(20);
        expect(utterances).toHaveLength(1);
        expect(onStart).toHaveBeenCalledTimes(1);

        // Advance 20 seconds (past the old chunkMaxMs timeout): MUST NOT skip to chunk 2
        await vi.advanceTimersByTimeAsync(20000);
        expect(utterances).toHaveLength(1);
        expect(onEnd).not.toHaveBeenCalled();

        // Finish chunk 1 at 30s, then chunk 2 starts and finishes at 60s
        await vi.advanceTimersByTimeAsync(10050);
        expect(utterances).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(30050);
        await speakPromise;
        expect(onEnd).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers from a dead browser utterance only when it never started and synth is idle (S9)', async () => {
      vi.useFakeTimers();
      try {
        const utterances: any[] = [];
        const synth = (globalThis as any).window.speechSynthesis;
        synth.speaking = false;
        synth.pending = false;
        synth.speak = vi.fn((utterance: any) => {
          utterances.push(utterance);
          if (utterances.length === 2) {
            // Second chunk works normally
            setTimeout(() => {
              utterance.onstart?.();
              utterance.onend?.();
            }, 10);
          }
          // First chunk silently drops without onstart/onend/onerror
        });

        const onEnd = vi.fn();
        const speakPromise = ttsNarrator.speak('Primera oración colgada. Segunda oración normal.', {
          engine: 'browser',
          onEnd,
        });

        await vi.advanceTimersByTimeAsync(6000);
        await speakPromise;

        expect(utterances).toHaveLength(2);
        expect(onEnd).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to browser speechSynthesis when ElevenLabs Audio.onerror fires a DOM error Event (S9)', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockBlob = new Blob(['bad-audio'], { type: 'audio/mpeg' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(mockBlob),
      } as any);

      (globalThis as any).URL = {
        createObjectURL: vi.fn(() => 'blob:http://localhost/bad-audio'),
        revokeObjectURL: vi.fn(),
      };

      (globalThis as any).Audio = class {
        src = '';
        volume = 1;
        paused = true;
        onplay: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: ((err: any) => void) | null = null;
        play() {
          setTimeout(() => {
            this.onerror?.({ type: 'error' });
          }, 5);
          return Promise.resolve();
        }
        pause() {}
      };

      const onEnd = vi.fn();
      const onError = vi.fn(() => {
        // Mirrors ZedStrip calling startListening() -> ttsNarrator.stop() inside onError.
        ttsNarrator.stop();
      });
      await ttsNarrator.speak('Fallback tras error de elemento audio.', {
        engine: 'elevenlabs',
        elevenlabsApiKey: 'valid_key',
        onEnd,
        onError,
      });

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect((globalThis as any).window.speechSynthesis.speak).toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('falls back to browser speechSynthesis when MediaSource.addSourceBuffer throws (S9)', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      class FailingMediaSource {
        readyState = 'open';
        addEventListener = vi.fn((event: string, cb: () => void) => {
          if (event === 'sourceopen') setTimeout(cb, 5);
        });
        addSourceBuffer = vi.fn(() => {
          throw new Error('QuotaExceeded or NotSupportedError');
        });
        static isTypeSupported = vi.fn(() => true);
      }
      (globalThis as any).MediaSource = FailingMediaSource;

      (globalThis as any).Audio = class {
        src = '';
        volume = 1;
        paused = true;
        onplay: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: ((err: any) => void) | null = null;
        pause() {}
      };

      (globalThis as any).URL = {
        createObjectURL: vi.fn(() => 'blob:http://localhost/ms-fail'),
        revokeObjectURL: vi.fn(),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: vi.fn(), cancel: vi.fn() }) },
      } as any);

      const onEnd = vi.fn();
      await ttsNarrator.speak('Fallback cuando MediaSource falla al crear SourceBuffer.', {
        engine: 'elevenlabs',
        elevenlabsApiKey: 'valid_key',
        onEnd,
      });

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect((globalThis as any).window.speechSynthesis.speak).toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it('creates a FIFO streaming sentence queue that speaks streamed sentences sequentially without aborting prior chunks', async () => {
      const spokenTexts: string[] = [];
      const synth = (globalThis as any).window.speechSynthesis;
      synth.speak = vi.fn((utterance: any) => {
        spokenTexts.push(utterance.text);
        setTimeout(() => {
          utterance.onstart?.();
          utterance.onend?.();
        }, 5);
      });

      const onStart = vi.fn();
      const onEnd = vi.fn();
      const queue = ttsNarrator.createStreamingQueue({ engine: 'browser', onStart, onEnd });
      queue.enqueue('Primera oración del stream.');
      queue.enqueue('Segunda oración en cola.');
      await queue.close();

      expect(spokenTexts).toEqual([
        'Primera oración del stream.',
        'Segunda oración en cola.',
      ]);
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(ttsNarrator.getLastInterruptedPlayback()).toBeNull();
    });
  });

  describe('Barge-in Heard-Audio Truncation & 20ms Smooth Ramp (T5)', () => {
    it('truncateTextToHeardMs slices proportionally at word boundaries without cutting words', () => {
      const text = 'Uno dos tres cuatro cinco'; // 25 chars
      expect(truncateTextToHeardMs(text, 0, 2500)).toBe('');
      expect(truncateTextToHeardMs(text, 1100, 2500)).toBe('Uno dos');
      expect(truncateTextToHeardMs(text, 1500, 2500)).toBe('Uno dos tres');
      expect(truncateTextToHeardMs(text, 3000, 2500)).toBe(text);
      expect(truncateTextToHeardMs('', 500, 1000)).toBe('');
      // Uses estimated duration when durationMs is omitted
      const partial = truncateTextToHeardMs('Primera parte de una oración suficientemente larga.', 600);
      expect(partial.length).toBeGreaterThan(0);
      expect(partial.length).toBeLessThan('Primera parte de una oración suficientemente larga.'.length);
    });

    it('stopWithRamp applies 20ms GainNode + volume fade and returns exact audio.currentTime heard prefix', async () => {
      vi.useFakeTimers();
      const originalAudioContext = (globalThis as any).window.AudioContext;
      const originalAudio = (globalThis as any).Audio;
      const originalURL = (globalThis as any).URL;
      const originalMediaSource = (globalThis as any).MediaSource;
      delete (globalThis as any).MediaSource;

      try {
        const linearRampSpy = vi.fn();
        const setValueSpy = vi.fn();
        class MockAudioContext {
          state = 'running';
          currentTime = 1.0;
          destination = {};
          createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
          createGain = vi.fn(() => ({
            gain: {
              value: 1,
              setValueAtTime: setValueSpy,
              linearRampToValueAtTime: linearRampSpy,
            },
            connect: vi.fn(),
            disconnect: vi.fn(),
          }));
          close = vi.fn();
        }
        (globalThis as any).window.AudioContext = MockAudioContext;

        const mockBlob = new Blob(['audio-bytes'], { type: 'audio/mpeg' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
          ok: true,
          status: 200,
          blob: vi.fn().mockResolvedValue(mockBlob),
        } as any);

        const revokeSpy = vi.fn();
        (globalThis as any).URL = {
          createObjectURL: vi.fn(() => 'blob:http://localhost/ramp-audio'),
          revokeObjectURL: revokeSpy,
        };

        let audioInst: any = null;
        const pauseSpy = vi.fn();
        (globalThis as any).Audio = class {
          src = '';
          volume = 1;
          currentTime = 0;
          duration = 4.0;
          paused = true;
          ended = false;
          onplay: (() => void) | null = null;
          onended: (() => void) | null = null;
          onerror: ((err: any) => void) | null = null;
          constructor(src: string) {
            this.src = src;
            audioInst = this;
          }
          play() {
            this.paused = false;
            this.onplay?.();
            return Promise.resolve();
          }
          pause() {
            this.paused = true;
            pauseSpy();
          }
        };

        const speakPromise = ttsNarrator.speak('Uno dos tres cuatro cinco seis siete ocho.', {
          engine: 'elevenlabs',
          elevenlabsApiKey: 'xi_ramp_key',
        });

        await vi.advanceTimersByTimeAsync(10);
        expect(audioInst).not.toBeNull();

        // Simulate 1.6s of 4.0s (40%) actually heard before user barge-in
        audioInst.currentTime = 1.6;
        const result = ttsNarrator.stopWithRamp(20);

        expect(ttsNarrator.isSpeaking()).toBe(false);
        expect(result.audioEndMs).toBe(1600);
        expect(result.playedText).toBe('Uno dos tres');
        expect(ttsNarrator.getLastInterruptedPlayback()).toEqual(result);

        // GainNode ramped linearly over 20ms; pause happens after the 20ms fade completes
        expect(setValueSpy).toHaveBeenCalledWith(1, 1.0);
        expect(linearRampSpy).toHaveBeenCalledWith(0, 1.02);
        expect(pauseSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(20);
        expect(pauseSpy).toHaveBeenCalledTimes(1);
        expect(audioInst.volume).toBe(0);
        expect(revokeSpy).toHaveBeenCalledWith('blob:http://localhost/ramp-audio');
        await speakPromise;
      } finally {
        vi.useRealTimers();
        (globalThis as any).window.AudioContext = originalAudioContext;
        (globalThis as any).Audio = originalAudio;
        (globalThis as any).URL = originalURL;
        (globalThis as any).MediaSource = originalMediaSource;
      }
    });

    it('combines completed streaming sentences with truncated active sentence on interruption', async () => {
      vi.useFakeTimers();
      try {
        const synth = (globalThis as any).window.speechSynthesis;
        const utterances: any[] = [];
        synth.speak = vi.fn((utterance: any) => {
          utterances.push(utterance);
          setTimeout(() => {
            utterance.onstart?.();
          }, 5);
        });

        const queue = ttsNarrator.createStreamingQueue({ engine: 'browser' });
        queue.enqueue('Primera frase completa.');
        queue.enqueue('Segunda frase bastante larga para poder cortarla justo a tiempo.');
        const closePromise = queue.close();

        // Sentence 1 starts at 5ms and finishes at 805ms
        await vi.advanceTimersByTimeAsync(10);
        expect(utterances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(800);
        utterances[0].onend?.();

        // Sentence 2 starts and plays for 1000ms before barge-in
        await vi.advanceTimersByTimeAsync(10);
        expect(utterances).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1000);

        const interrupted = ttsNarrator.stopWithRamp(20);
        await closePromise;

        expect(interrupted.playedText.startsWith('Primera frase completa.')).toBe(true);
        expect(interrupted.playedText.length).toBeGreaterThan('Primera frase completa.'.length);
        expect(interrupted.playedText).not.toContain('tiempo.');
        expect(interrupted.audioEndMs).toBeGreaterThanOrEqual(1700);
        expect(ttsNarrator.getLastInterruptedPlayback()).toEqual(interrupted);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('S4/T4 — SentenceStreamChunker, Persistent ElevenLabs stream-input WS & Atomic Barge-In', () => {
    it('SentenceStreamChunker respects 35-char min threshold and 180-char first-sentence cap', () => {
      const chunker = new SentenceStreamChunker({ minChars: 35, firstSentenceMaxChars: 180 });
      // Short 10-char sentence is buffered until >= 35 chars
      expect(chunker.push('Hola! ')).toEqual([]);
      const out = chunker.push('Todo el entorno de pruebas ya quedó completamente listo. ');
      expect(out).toHaveLength(1);
      expect(out[0].length).toBeGreaterThanOrEqual(35);

      const longChunker = new SentenceStreamChunker({ minChars: 35, firstSentenceMaxChars: 180 });
      const longFirst =
        'Esta primera oración es deliberadamente muy extensa para verificar que el recortador inicial respete el límite máximo de ciento ochenta caracteres sin cortar palabras a la mitad ni esperar demasiado para hablar.';
      const firstBatch = longChunker.push(longFirst);
      expect(firstBatch.length).toBeGreaterThanOrEqual(1);
      expect(firstBatch[0].length).toBeLessThanOrEqual(180);
    });

    it('reuses one persistent ElevenLabs stream-input WebSocket across multiple sentences and closes cleanly', async () => {
      const sockets: any[] = [];
      const sentPayloads: any[] = [];
      const originalAudio = (globalThis as any).Audio;
      const originalURL = (globalThis as any).URL;
      const originalMediaSource = (globalThis as any).MediaSource;

      try {
        (globalThis as any).MediaSource = undefined;
        (globalThis as any).URL = {
          createObjectURL: vi.fn(() => 'blob:http://localhost/ws-audio'),
          revokeObjectURL: vi.fn(),
        };
        (globalThis as any).Audio = class {
          src = '';
          volume = 1;
          paused = true;
          ended = false;
          onplay: (() => void) | null = null;
          onended: (() => void) | null = null;
          onerror: ((err: any) => void) | null = null;
          constructor(src: string) {
            this.src = src;
          }
          play() {
            this.paused = false;
            setTimeout(() => {
              this.onplay?.();
              this.paused = true;
              this.ended = true;
              this.onended?.();
            }, 2);
            return Promise.resolve();
          }
          pause() {
            this.paused = true;
          }
        };

        class MockWebSocket {
          static OPEN = 1;
          static CLOSED = 3;
          readyState = 1;
          url: string;
          onopen: (() => void) | null = null;
          onmessage: ((ev: { data: string }) => void) | null = null;
          onerror: ((ev: any) => void) | null = null;
          onclose: (() => void) | null = null;
          constructor(url: string) {
            this.url = url;
            sockets.push(this);
            setTimeout(() => this.onopen?.(), 0);
          }
          send(data: string) {
            const parsed = JSON.parse(data);
            sentPayloads.push(parsed);
            if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    audio: btoa('fake-mp3-chunk'),
                    isFinal: true,
                  }),
                });
              }, 2);
            }
          }
          close() {
            this.readyState = 3;
            this.onclose?.();
          }
        }

        const queue = ttsNarrator.createStreamingQueue({
          engine: 'elevenlabs',
          elevenlabsApiKey: 'xi_ws_test',
          elevenlabsVoiceId: 'voice-ws-1',
          wsFactory: (url) => new MockWebSocket(url) as any,
        });

        queue.enqueue('Primera oración suficientemente larga para hablar.');
        queue.enqueue('Segunda oración reutilizando el mismo WebSocket.');
        await queue.close();

        expect(sockets).toHaveLength(1);
        expect(sockets[0].url).toContain('wss://api.elevenlabs.io/v1/text-to-speech/voice-ws-1/stream-input');
        expect(sentPayloads[0].xi_api_key).toBe('xi_ws_test');
        ttsNarrator.closePersistentTtsSocket();
      } finally {
        (globalThis as any).Audio = originalAudio;
        (globalThis as any).URL = originalURL;
        (globalThis as any).MediaSource = originalMediaSource;
      }
    });

    it('falls back cleanly to ElevenLabs HTTP /stream when WebSocket transport fails', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob(['http-fallback-mp3'], { type: 'audio/mpeg' })),
      } as any);
      const originalAudio = (globalThis as any).Audio;
      const originalURL = (globalThis as any).URL;
      try {
        (globalThis as any).URL = {
          createObjectURL: vi.fn(() => 'blob:http://localhost/http-fallback'),
          revokeObjectURL: vi.fn(),
        };
        (globalThis as any).Audio = class {
          volume = 1;
          paused = true;
          ended = false;
          onplay: (() => void) | null = null;
          onended: (() => void) | null = null;
          play() {
            this.paused = false;
            setTimeout(() => {
              this.onplay?.();
              this.ended = true;
              this.onended?.();
            }, 2);
            return Promise.resolve();
          }
          pause() {}
        };

        class FailingWs {
          readyState = 0;
          onopen: (() => void) | null = null;
          onerror: ((e: any) => void) | null = null;
          onclose: (() => void) | null = null;
          constructor() {
            setTimeout(() => this.onerror?.(new Error('ws down')), 0);
          }
          send() {}
          close() {}
        }

        await ttsNarrator.speak('Probando fallback a HTTP stream.', {
          engine: 'elevenlabs',
          elevenlabsApiKey: 'xi_ws_fallback',
          wsFactory: () => new FailingWs() as any,
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0][0])).toContain('/stream');
      } finally {
        ttsNarrator.closePersistentTtsSocket();
        (globalThis as any).Audio = originalAudio;
        (globalThis as any).URL = originalURL;
      }
    });

    it('aborts active LLM AbortController and TTS playback in <50ms on stopWithRamp(20)', () => {
      const controller = new AbortController();
      const unregister = ttsNarrator.registerActiveLlmAbort(controller);
      const t0 = performance.now();
      ttsNarrator.stopWithRamp(20);
      const elapsed = performance.now() - t0;

      expect(controller.signal.aborted).toBe(true);
      expect(elapsed).toBeLessThan(50);
      unregister();
    });
  });
});
