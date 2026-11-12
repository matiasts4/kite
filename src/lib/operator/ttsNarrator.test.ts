import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ttsNarrator, cleanTextForSpeech, resolveBestVoice, splitIntoSpeechSentences } from './ttsNarrator';

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

    it('cleans inline code backticks, bold, links and emojis', () => {
      const input = 'Revisa `src/main.ts` y [la documentación](https://example.com) 🚀!';
      const output = cleanTextForSpeech(input);
      expect(output).toBe('Revisa src/main.ts y la documentación !');
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
  });
});
