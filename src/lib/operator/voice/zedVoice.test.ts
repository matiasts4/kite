import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isVoiceRecognitionSupported,
  getVoiceEngineStatus,
  startOperatorListening,
  stopOperatorListening,
  releaseOperatorCapture,
  armBargeInMonitor,
  getCurrentAudioLevel,
  encodeWavBlob,
  blobToBase64,
  cleanTranscriptionText,
  describeMicrophoneError,
  startTranscriptionTestSession,
  transcribeWithGrokCloud,
  SttProviderError,
  isFatalSttError,
} from './zedVoice';
import { resetSttEndpointCacheForTests } from './transcriptionProviders';
import { saveOperatorConfig } from '../operatorConfig';

describe('ZedVoice — Speech Recognition Engine', () => {
  const originalSpeechRecognition = (window as any).SpeechRecognition;
  const originalWebkitSpeechRecognition = (window as any).webkitSpeechRecognition;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    (window as any).SpeechRecognition = originalSpeechRecognition;
    (window as any).webkitSpeechRecognition = originalWebkitSpeechRecognition;
  });

  it('reports engine status correctly based on browser support', () => {
    expect(typeof isVoiceRecognitionSupported()).toBe('boolean');
    const status = getVoiceEngineStatus();
    expect(status).toHaveProperty('available');
    expect(status).toHaveProperty('engine');
    expect(status).toHaveProperty('label');
    expect(status).toHaveProperty('hasGrokApiKey');
  });

  it('returns numerical audio level between 0 and 1', () => {
    const level = getCurrentAudioLevel();
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(1);
  });

  it('rejects gracefully when SpeechRecognition and MediaDevices are completely unavailable', async () => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
    (window as any).navigator = {} as any;

    await expect(startOperatorListening()).rejects.toThrow(/no está soportado/i);
  });

  it('explains a busy microphone in Spanish', () => {
    const err = Object.assign(new Error('Device in use'), { name: 'NotReadableError' });
    expect(describeMicrophoneError(err)).toMatch(/ocupado/i);
  });

  it('stops listening cleanly when stopOperatorListening is invoked', () => {
    expect(() => stopOperatorListening()).not.toThrow();
  });

  it('encodes PCM samples into standard 16-bit PCM WAV and downsamples to 16kHz', () => {
    const samples = [new Float32Array(48000)]; // 1 sec at 48kHz
    const wav = encodeWavBlob(samples, 48000, 16000);
    expect(wav.type).toBe('audio/wav');
    expect(wav.size).toBe(44 + 16000 * 2);
  });

  it('converts blob to base64 properly', async () => {
    const blob = new Blob([new Uint8Array([72, 101, 108, 108, 111])]);
    const b64 = await blobToBase64(blob);
    expect(b64).toBe(btoa('Hello'));
  });

  it('filters Whisper silence hallucinations', () => {
    // Gratitude / apology hallucination on short audio (<= 4.5s) should be dropped
    expect(cleanTranscriptionText('Gracias.', 2.1)).toBe('');
    expect(cleanTranscriptionText('Muchas gracias', 3.0)).toBe('');
    expect(cleanTranscriptionText("I'm sorry.", 1.5)).toBe('');
    expect(cleanTranscriptionText('Thank you', 2.0)).toBe('');
    expect(cleanTranscriptionText('ご視聴ありがとうございました', 2.0)).toBe('');
    expect(cleanTranscriptionText('ありがとうございました', 1.8)).toBe('');

    // Real commands should be preserved cleanly
    expect(cleanTranscriptionText('abre 2 terminales', 2.5)).toBe('abre 2 terminales');
    expect(cleanTranscriptionText('cierra las terminales activas', 3.2)).toBe('cierra las terminales activas');

    // Repetitive loop hallucinations should be dropped
    expect(cleanTranscriptionText("I'm sorry, I'm sorry, I'm sorry, I'm sorry", 5.0)).toBe('');
  });

  it('handles startTranscriptionTestSession gracefully when no audio device is available', async () => {
    (window as any).navigator = {} as any;
    await expect(startTranscriptionTestSession(null)).rejects.toThrow();
  });

  it('classifies Grok/xAI HTTP 404 as a fatal structured SttProviderError without spamming', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' })
    );

    try {
      const blob = new Blob([new Uint8Array(400)], { type: 'audio/wav' });
      let caught: unknown;
      try {
        await transcribeWithGrokCloud(blob, 'xai-test-key', 'https://api.x.ai/v1');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SttProviderError);
      expect((caught as SttProviderError).status).toBe(404);
      expect((caught as SttProviderError).code).toBe('ENDPOINT_NOT_FOUND');
      expect((caught as SttProviderError).fatal).toBe(true);
      expect(isFatalSttError(caught)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('connects ScriptProcessorNode through a zero-gain sink instead of AudioContext.destination', async () => {
    const originalAudioContext = (window as any).AudioContext;
    const originalNavigator = window.navigator;
    const processorConnectSpy = vi.fn();
    const gainConnectSpy = vi.fn();
    const destination = { __isDestination: true };
    const gainNode = { gain: { value: 1 }, connect: gainConnectSpy, disconnect: vi.fn() };
    const processorNode = {
      onaudioprocess: null as any,
      connect: processorConnectSpy,
      disconnect: vi.fn(),
    };
    const analyserNode = {
      fftSize: 64,
      frequencyBinCount: 32,
      getByteFrequencyData: vi.fn(),
      getFloatTimeDomainData: vi.fn(),
    };
    const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };

    (window as any).AudioContext = vi.fn(() => ({
      state: 'running',
      sampleRate: 16000,
      destination,
      createMediaStreamSource: () => sourceNode,
      createAnalyser: () => analyserNode,
      createScriptProcessor: () => processorNode,
      createGain: () => gainNode,
      close: vi.fn(),
    }));
    (window as any).navigator = {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    };
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;

    try {
      const listenPromise = startOperatorListening();
      await Promise.resolve();
      await Promise.resolve();
      await stopOperatorListening({ discard: true });
      await listenPromise;

      expect(processorConnectSpy).not.toHaveBeenCalledWith(destination);
      expect(processorConnectSpy).toHaveBeenCalledWith(gainNode);
      expect(gainNode.gain.value).toBe(0);
      expect(gainConnectSpy).toHaveBeenCalledWith(destination);
    } finally {
      await releaseOperatorCapture();
      (window as any).AudioContext = originalAudioContext;
      (window as any).navigator = originalNavigator;
    }
  });

  it('auto-stops via RMS energy VAD after ~2.4s trailing silence and caps idle no-speech at ~8s', async () => {
    vi.useFakeTimers();
    const originalAudioContext = (window as any).AudioContext;
    const originalNavigator = window.navigator;
    let capturedProcessor: any = null;

    (window as any).AudioContext = vi.fn(() => ({
      state: 'running',
      sampleRate: 16000,
      destination: {},
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({
        fftSize: 64,
        frequencyBinCount: 32,
        getByteFrequencyData: vi.fn(),
      }),
      createScriptProcessor: () => {
        capturedProcessor = {
          onaudioprocess: null as any,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        return capturedProcessor;
      },
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn(),
    }));
    (window as any).navigator = {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    };
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;

    try {
      // 1. Idle no-speech cap (~8s) settles cleanly as empty string
      const idleError = vi.fn();
      const idlePromise = startOperatorListening({ onError: idleError });
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(8050);
      await expect(idlePromise).resolves.toBe('');
      expect(idleError).not.toHaveBeenCalled();

      // 2. Speech onset via RMS energy -> trailing silence auto-stop (~2.4s)
      const speechPromise = startOperatorListening();
      await vi.advanceTimersByTimeAsync(50);
      const loudFrame = new Float32Array(4096).fill(0.2);
      capturedProcessor.onaudioprocess({
        inputBuffer: { getChannelData: () => loudFrame },
      });
      // Advance 2.4s of silence after speech
      let settled = false;
      speechPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2300);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await expect(speechPromise).resolves.toBe('');
    } finally {
      await releaseOperatorCapture();
      vi.useRealTimers();
      (window as any).AudioContext = originalAudioContext;
      (window as any).navigator = originalNavigator;
    }
  });

  it('prefers Web Speech transcript fallback when cloud STT returns 404 and does not block 300ms on stop', async () => {
    const originalAudioContext = (window as any).AudioContext;
    const originalNavigator = window.navigator;
    saveOperatorConfig({ grokApiKey: 'xai-test-key', grokBaseUrl: 'https://api.x.ai/v1' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' })
    );

    let recognitionInstance: any = null;
    (window as any).SpeechRecognition = vi.fn(function (this: any) {
      recognitionInstance = this;
      this.start = vi.fn();
      this.stop = vi.fn();
    });
    (window as any).AudioContext = vi.fn(() => ({
      state: 'running',
      sampleRate: 16000,
      destination: {},
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({ fftSize: 64, frequencyBinCount: 32, getByteFrequencyData: vi.fn() }),
      createScriptProcessor: () => ({
        onaudioprocess: null as any,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn(),
    }));
    (window as any).navigator = {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    };

    try {
      const onError = vi.fn();
      const listenPromise = startOperatorListening({ onError });
      await vi.waitFor(() => {
        expect(recognitionInstance).not.toBeNull();
      });

      // Simulate SpeechRecognition partial + final chunk
      recognitionInstance.onresult({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: 'abre dos terminales' } }],
      });

      const t0 = Date.now();
      const result = await stopOperatorListening();
      const elapsed = Date.now() - t0;

      expect(result).toBe('abre dos terminales');
      expect(await listenPromise).toBe('abre dos terminales');
      expect(onError).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(200);
    } finally {
      fetchSpy.mockRestore();
      localStorage.clear();
      await releaseOperatorCapture();
      (window as any).AudioContext = originalAudioContext;
      (window as any).navigator = originalNavigator;
    }
  });

  it('excludes idle pre-speech silence and trims trailing silence from WAV sent to Grok STT', async () => {
    const originalAudioContext = (window as any).AudioContext;
    const originalNavigator = window.navigator;
    const originalMediaRecorder = (window as any).MediaRecorder;
    resetSttEndpointCacheForTests();
    saveOperatorConfig({ grokApiKey: 'xai-test-key', grokBaseUrl: 'https://api.x.ai/v1' });

    let capturedProcessor: any = null;
    const mediaRecorderSpy = vi.fn();
    (window as any).MediaRecorder = Object.assign(mediaRecorderSpy, {
      isTypeSupported: () => true,
    });
    (window as any).AudioContext = vi.fn(() => ({
      state: 'running',
      sampleRate: 16000,
      destination: {},
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({ fftSize: 64, frequencyBinCount: 32, getByteFrequencyData: vi.fn() }),
      createScriptProcessor: () => {
        capturedProcessor = {
          onaudioprocess: null as any,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        return capturedProcessor;
      },
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn(),
    }));
    (window as any).navigator = {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
          getAudioTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
        }),
      },
    };
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;

    let uploadedWavBytes = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const form = init?.body as FormData;
      const file = form?.get('file') as Blob | null;
      uploadedWavBytes = file ? file.size : 0;
      return new Response(JSON.stringify({ text: 'abrí dos terminales' }), { status: 200 });
    });

    try {
      const listenPromise = startOperatorListening({ continuous: true });
      await vi.waitFor(() => {
        expect(capturedProcessor?.onaudioprocess).toBeTypeOf('function');
      });

      // MediaRecorder should not spin in parallel when PCM capture graph is attached
      expect(mediaRecorderSpy).not.toHaveBeenCalled();

      const feedFrame = (amplitude: number, len = 2048) => {
        const frame = new Float32Array(len).fill(amplitude);
        capturedProcessor.onaudioprocess({
          inputBuffer: { getChannelData: () => frame },
        });
      };

      // 10.24s of idle waiting silence (80 frames x 128ms @ 16kHz)
      for (let i = 0; i < 80; i++) {
        feedFrame(0.001);
      }
      expect(fetchSpy).not.toHaveBeenCalled();

      // 1.024s of real speech (8 frames x 128ms)
      for (let i = 0; i < 8; i++) {
        feedFrame(0.2);
      }

      // 1.28s of trailing silence before endpoint stops (10 frames x 128ms)
      for (let i = 0; i < 10; i++) {
        feedFrame(0.001);
      }

      const transcript = await stopOperatorListening();
      expect(transcript).toBe('abrí dos terminales');
      expect(await listenPromise).toBe('abrí dos terminales');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 16kHz mono 16-bit PCM = 32,000 bytes/sec + 44-byte WAV header.
      // Expected: ~0.27s pre-roll + 1.02s speech + 0.25s trailing pad ≈ 1.55s (well under 2.0s, NEVER 12.5s!)
      const uploadedSecs = (uploadedWavBytes - 44) / 32000;
      expect(uploadedSecs).toBeGreaterThanOrEqual(1.1);
      expect(uploadedSecs).toBeLessThanOrEqual(2.0);
    } finally {
      fetchSpy.mockRestore();
      localStorage.clear();
      await releaseOperatorCapture();
      (window as any).AudioContext = originalAudioContext;
      (window as any).navigator = originalNavigator;
      (window as any).MediaRecorder = originalMediaRecorder;
    }
  });

  it('sends zero STT requests when stopped after pure idle silence in continuous mode', async () => {
    const originalAudioContext = (window as any).AudioContext;
    const originalNavigator = window.navigator;
    resetSttEndpointCacheForTests();
    saveOperatorConfig({ grokApiKey: 'xai-test-key', grokBaseUrl: 'https://api.x.ai/v1' });

    let capturedProcessor: any = null;
    (window as any).AudioContext = vi.fn(() => ({
      state: 'running',
      sampleRate: 16000,
      destination: {},
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({ fftSize: 64, frequencyBinCount: 32, getByteFrequencyData: vi.fn() }),
      createScriptProcessor: () => {
        capturedProcessor = {
          onaudioprocess: null as any,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        return capturedProcessor;
      },
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn(),
    }));
    (window as any).navigator = {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
          getAudioTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
        }),
      },
    };
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'should not happen' }), { status: 200 })
    );

    try {
      const listenPromise = startOperatorListening({ continuous: true });
      await vi.waitFor(() => {
        expect(capturedProcessor?.onaudioprocess).toBeTypeOf('function');
      });

      const silentFrame = new Float32Array(2048).fill(0.001);
      for (let i = 0; i < 60; i++) {
        capturedProcessor.onaudioprocess({
          inputBuffer: { getChannelData: () => silentFrame },
        });
      }

      const result = await stopOperatorListening();
      expect(result).toBe('');
      expect(await listenPromise).toBe('');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      localStorage.clear();
      await releaseOperatorCapture();
      (window as any).AudioContext = originalAudioContext;
      (window as any).navigator = originalNavigator;
    }
  });

  it('captures pre-roll and quiet speech without idle silence when SpeechRecognition triggers before VAD', async () => {
    const originalAudioContext = (window as any).AudioContext;
    const originalNavigator = window.navigator;
    resetSttEndpointCacheForTests();
    saveOperatorConfig({ grokApiKey: 'xai-test-key', grokBaseUrl: 'https://api.x.ai/v1' });

    let capturedProcessor: any = null;
    let recognitionInstance: any = null;
    (window as any).SpeechRecognition = vi.fn(function (this: any) {
      recognitionInstance = this;
      this.start = vi.fn();
      this.stop = vi.fn();
    });
    (window as any).AudioContext = vi.fn(() => ({
      state: 'running',
      sampleRate: 16000,
      destination: {},
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({ fftSize: 64, frequencyBinCount: 32, getByteFrequencyData: vi.fn() }),
      createScriptProcessor: () => {
        capturedProcessor = {
          onaudioprocess: null as any,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        return capturedProcessor;
      },
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn(),
    }));
    (window as any).navigator = {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
          getAudioTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
        }),
      },
    };

    let uploadedWavBytes = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const form = init?.body as FormData;
      const file = form?.get('file') as Blob | null;
      uploadedWavBytes = file ? file.size : 0;
      return new Response(JSON.stringify({ text: 'susurro suave' }), { status: 200 });
    });

    try {
      const listenPromise = startOperatorListening({ continuous: true });
      await vi.waitFor(() => {
        expect(capturedProcessor?.onaudioprocess).toBeTypeOf('function');
        expect(recognitionInstance).not.toBeNull();
      });

      const feedFrame = (amplitude: number, len = 2048) => {
        const frame = new Float32Array(len).fill(amplitude);
        capturedProcessor.onaudioprocess({
          inputBuffer: { getChannelData: () => frame },
        });
      };

      // 6.4s of idle silence before quiet speech (50 frames)
      for (let i = 0; i < 50; i++) {
        feedFrame(0.001);
      }

      // SpeechRecognition detects quiet utterance even though RMS stays below VAD onset
      recognitionInstance.onresult({
        resultIndex: 0,
        results: [{ isFinal: false, 0: { transcript: 'susurro suave' } }],
      });

      // 1.024s of quiet speech (8 frames @ 0.004 RMS)
      for (let i = 0; i < 8; i++) {
        feedFrame(0.004);
      }

      const result = await stopOperatorListening();
      expect(result).toBe('susurro suave');
      expect(await listenPromise).toBe('susurro suave');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Should include 0.4s pre-roll + 1.024s quiet speech ≈ 1.42s, NOT 7.4s and NOT trimmed to 0
      const uploadedSecs = (uploadedWavBytes - 44) / 32000;
      expect(uploadedSecs).toBeGreaterThanOrEqual(1.1);
      expect(uploadedSecs).toBeLessThanOrEqual(1.8);
    } finally {
      fetchSpy.mockRestore();
      localStorage.clear();
      await releaseOperatorCapture();
      (window as any).AudioContext = originalAudioContext;
      (window as any).navigator = originalNavigator;
    }
  });

  it('preserves barge-in pre-roll without duplicating frames and trims trailing silence on warm reuse', async () => {
    const originalAudioContext = (window as any).AudioContext;
    const originalNavigator = window.navigator;
    resetSttEndpointCacheForTests();
    saveOperatorConfig({ grokApiKey: 'xai-test-key', grokBaseUrl: 'https://api.x.ai/v1' });

    let capturedProcessor: any = null;
    (window as any).AudioContext = vi.fn(() => ({
      state: 'running',
      sampleRate: 16000,
      destination: {},
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({ fftSize: 64, frequencyBinCount: 32, getByteFrequencyData: vi.fn() }),
      createScriptProcessor: () => {
        capturedProcessor = {
          onaudioprocess: null as any,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        return capturedProcessor;
      },
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn(),
    }));
    (window as any).navigator = {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
          getAudioTracks: () => [{ stop: vi.fn(), readyState: 'live' }],
        }),
      },
    };
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;

    let uploadedWavBytes = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const form = init?.body as FormData;
      const file = form?.get('file') as Blob | null;
      uploadedWavBytes = file ? file.size : 0;
      return new Response(JSON.stringify({ text: 'para ahí' }), { status: 200 });
    });

    try {
      // Turn 1: open warm audio graph then stop keeping graph alive
      const firstListen = startOperatorListening({ continuous: true });
      await vi.waitFor(() => {
        expect(capturedProcessor?.onaudioprocess).toBeTypeOf('function');
      });
      await stopOperatorListening();
      await firstListen;

      // Simulate TTS playing with barge-in armed; push 400ms of opening speech into pre-roll
      expect(armBargeInMonitor(() => {})).toBe(true);
      const feedFrame = (amplitude: number, len = 2048) => {
        const frame = new Float32Array(len).fill(amplitude);
        capturedProcessor.onaudioprocess({
          inputBuffer: { getChannelData: () => frame },
        });
      };
      for (let i = 0; i < 4; i++) {
        feedFrame(0.18);
      }

      // Start Turn 2 from barge-in, add 512ms more speech + 1.28s trailing silence
      const bargePromise = startOperatorListening({ continuous: true, fromBargeIn: true });
      await Promise.resolve();
      await Promise.resolve();
      for (let i = 0; i < 4; i++) {
        feedFrame(0.18);
      }
      for (let i = 0; i < 10; i++) {
        feedFrame(0.001);
      }

      const result = await stopOperatorListening();
      expect(result).toBe('para ahí');
      expect(await bargePromise).toBe('para ahí');

      // 0.4s pre-roll + 0.512s continuation + 0.25s trailing pad ≈ 1.16s (trims ~1.03s of trailing silence)
      const uploadedSecs = (uploadedWavBytes - 44) / 32000;
      expect(uploadedSecs).toBeGreaterThanOrEqual(0.95);
      expect(uploadedSecs).toBeLessThanOrEqual(1.45);
    } finally {
      fetchSpy.mockRestore();
      localStorage.clear();
      await releaseOperatorCapture();
      (window as any).AudioContext = originalAudioContext;
      (window as any).navigator = originalNavigator;
    }
  });
});
