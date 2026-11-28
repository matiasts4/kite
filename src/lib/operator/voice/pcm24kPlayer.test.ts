import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPcm24kPlayer,
  getActiveVoiceAudioTime,
  registerActiveVoiceAudioTimingGetter,
} from './pcm24kPlayer';

function int16SamplesToBuffer(samples: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i], true);
  }
  return buf;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

interface MockGainNode {
  gain: {
    value: number;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockSourceNode {
  buffer: AudioBuffer | null;
  playbackRate: { value: number };
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

describe('Pcm24kPlayer & Active Audio Clock Registry (T5 / S5, S2)', () => {
  let originalAudioContext: unknown;
  let originalWebkitAudioContext: unknown;
  let mockCurrentTime = 0;
  let mockState: AudioContextState = 'running';
  let createdGains: MockGainNode[];
  let createdSources: MockSourceNode[];
  let createdBuffers: Array<{ channels: Float32Array[]; sampleRate: number; duration: number }>;
  let mockAnalyser: {
    fftSize: number;
    frequencyBinCount: number;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getByteTimeDomainData: ReturnType<typeof vi.fn>;
  };
  let mockContextClose: ReturnType<typeof vi.fn>;
  let audioCtxCtorSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    originalAudioContext = (window as any).AudioContext;
    originalWebkitAudioContext = (window as any).webkitAudioContext;

    mockCurrentTime = 1.0;
    mockState = 'running';
    createdGains = [];
    createdSources = [];
    createdBuffers = [];
    mockContextClose = vi.fn().mockImplementation(async () => {
      mockState = 'closed';
    });

    mockAnalyser = {
      fftSize: 2048,
      frequencyBinCount: 1024,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteTimeDomainData: vi.fn((target: Uint8Array) => {
        target.fill(128);
      }),
    };

    const createGainNode = (): MockGainNode => {
      const node: MockGainNode = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn((v: number) => {
            node.gain.value = v;
          }),
          linearRampToValueAtTime: vi.fn((v: number) => {
            node.gain.value = v;
          }),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      createdGains.push(node);
      return node;
    };

    audioCtxCtorSpy = vi.fn().mockImplementation(() => ({
      get currentTime() {
        return mockCurrentTime;
      },
      get state() {
        return mockState;
      },
      sampleRate: 24000,
      destination: { kind: 'destination' },
      resume: vi.fn().mockResolvedValue(undefined),
      close: mockContextClose,
      createGain: vi.fn(createGainNode),
      createAnalyser: vi.fn(() => mockAnalyser),
      createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
        const channelArrays = Array.from({ length: channels }, () => new Float32Array(length));
        const duration = length / sampleRate;
        const entry = { channels: channelArrays, sampleRate, duration };
        createdBuffers.push(entry);
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration,
          getChannelData: (idx: number) => channelArrays[idx],
          copyToChannel: (src: Float32Array, idx: number) => {
            channelArrays[idx].set(src);
          },
        };
      }),
      createBufferSource: vi.fn(() => {
        const src: MockSourceNode = {
          buffer: null,
          playbackRate: { value: 1 },
          onended: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        createdSources.push(src);
        return src;
      }),
    }));

    (window as any).AudioContext = audioCtxCtorSpy;
    registerActiveVoiceAudioTimingGetter(null);
  });

  afterEach(() => {
    registerActiveVoiceAudioTimingGetter(null);
    (window as any).AudioContext = originalAudioContext;
    (window as any).webkitAudioContext = originalWebkitAudioContext;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('degrades gracefully to no-op when AudioContext is absent (jsdom / SSR)', () => {
    delete (window as any).AudioContext;
    delete (window as any).webkitAudioContext;

    const player = createPcm24kPlayer(0.8);
    expect(player.enqueuePcm24k(int16SamplesToBuffer([1000, -1000]))).toBeNull();
    expect(player.getSpeakerLevel()).toBe(0);
    expect(player.getTiming()).toEqual({ currentTime: 0, scheduledEnd: 0 });
    expect(() => player.setVolume(50)).not.toThrow();
    expect(() => player.setPlaybackRate(1.25)).not.toThrow();
    expect(() => player.clearWithRamp(20)).not.toThrow();
    expect(() => player.close()).not.toThrow();
  });

  it('decodes ArrayBuffer, sliced Uint8Array, and base64 PCM16 little-endian into normalized Float32 samples', () => {
    const player = createPcm24kPlayer();
    expect(audioCtxCtorSpy).toHaveBeenCalledWith({ latencyHint: 'playback' });

    const pcmBytes = int16SamplesToBuffer([-32768, 0, 16384, 32767]);
    const res1 = player.enqueuePcm24k(pcmBytes, 24000);
    expect(res1).not.toBeNull();

    const ch0 = createdBuffers[0].channels[0];
    expect(ch0[0]).toBeCloseTo(-1, 4);
    expect(ch0[1]).toBeCloseTo(0, 5);
    expect(ch0[2]).toBeCloseTo(16384 / 32767, 4);
    expect(ch0[3]).toBeCloseTo(1, 4);

    // Sliced Uint8Array with non-zero byteOffset
    const padded = new Uint8Array(12);
    padded.set(new Uint8Array(pcmBytes), 4);
    const slice = padded.subarray(4, 12);
    const res2 = player.enqueuePcm24k(slice, 24000);
    expect(res2).not.toBeNull();
    expect(createdBuffers[1].channels[0][0]).toBeCloseTo(-1, 4);
    expect(createdBuffers[1].channels[0][3]).toBeCloseTo(1, 4);

    // Base64 PCM16 string
    const res3 = player.enqueuePcm24k(bufferToBase64(pcmBytes), 24000);
    expect(res3).not.toBeNull();
    expect(createdBuffers[2].channels[0][0]).toBeCloseTo(-1, 4);

    // Empty or sub-sample chunks return null
    expect(player.enqueuePcm24k('')).toBeNull();
    expect(player.enqueuePcm24k(new Uint8Array([1]))).toBeNull();
  });

  it('schedules gapless sequential AudioBufferSourceNodes using scheduledEnd = Math.max(ctx.currentTime, scheduledEnd)', () => {
    const player = createPcm24kPlayer();
    const samples2400 = new Array(2400).fill(1024); // 0.1s at 24 kHz
    const samples4800 = new Array(4800).fill(1024); // 0.2s at 24 kHz

    const span1 = player.enqueuePcm24k(int16SamplesToBuffer(samples2400), 24000);
    expect(span1).toEqual({ startAt: 1.0, endAt: 1.1 });
    expect(createdSources[0].start).toHaveBeenCalledWith(1.0);

    const span2 = player.enqueuePcm24k(int16SamplesToBuffer(samples4800), 24000);
    expect(span2!.startAt).toBeCloseTo(1.1, 6);
    expect(span2!.endAt).toBeCloseTo(1.3, 6);
    expect(createdSources[1].start).toHaveBeenCalledWith(span2!.startAt);

    // Clock catches up past previous scheduledEnd
    mockCurrentTime = 2.0;
    const span3 = player.enqueuePcm24k(int16SamplesToBuffer(samples2400), 24000);
    expect(span3!.startAt).toBeCloseTo(2.0, 6);
    expect(span3!.endAt).toBeCloseTo(2.1, 6);

    const timing = player.getTiming();
    expect(timing.currentTime).toBeCloseTo(2.0, 6);
    expect(timing.scheduledEnd).toBeCloseTo(2.1, 6);
  });

  it('normalizes volume (0..1 and 0..100) and clamps playbackRate to [0.5, 2.0]', () => {
    const player = createPcm24kPlayer(80);
    const masterGain = createdGains[1];
    expect(masterGain.gain.value).toBeCloseTo(0.8, 4);

    player.setVolume(0.35);
    expect(masterGain.gain.value).toBeCloseTo(0.35, 4);

    player.setVolume(50);
    expect(masterGain.gain.value).toBeCloseTo(0.5, 4);

    player.setVolume(180);
    expect(masterGain.gain.value).toBeCloseTo(1, 4);

    player.setVolume(-10);
    expect(masterGain.gain.value).toBe(0);

    // Playback rate clamping & duration scaling
    const chunk2400 = int16SamplesToBuffer(new Array(2400).fill(512)); // 0.1s nominal
    player.setPlaybackRate(0.2);
    const slow = player.enqueuePcm24k(chunk2400, 24000);
    expect(createdSources[0].playbackRate.value).toBe(0.5);
    expect(slow!.endAt - slow!.startAt).toBeCloseTo(0.2, 6);

    player.setPlaybackRate(3.4);
    const fast = player.enqueuePcm24k(chunk2400, 24000);
    expect(createdSources[1].playbackRate.value).toBe(2.0);
    expect(fast!.endAt - fast!.startAt).toBeCloseTo(0.05, 6);
  });

  it('performs 20ms barge-in clearWithRamp, stops sources after rampMs + 5ms, resets scheduledEnd, and restores ramp gain', () => {
    const player = createPcm24kPlayer(1);
    const rampGain = createdGains[0];
    const chunk = int16SamplesToBuffer(new Array(2400).fill(1000));

    player.enqueuePcm24k(chunk, 24000);
    player.enqueuePcm24k(chunk, 24000);
    expect(player.getTiming().scheduledEnd).toBeGreaterThan(1.0);

    mockCurrentTime = 1.05;
    player.clearWithRamp(20);

    expect(rampGain.gain.cancelScheduledValues).toHaveBeenCalledWith(1.05);
    expect(rampGain.gain.setValueAtTime).toHaveBeenCalledWith(1, 1.05);
    expect(rampGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 1.07);
    expect(player.getTiming().scheduledEnd).toBe(0);

    // Sources must not be abruptly stopped before rampMs + 5ms
    vi.advanceTimersByTime(20);
    expect(createdSources[0].stop).not.toHaveBeenCalled();
    expect(createdSources[1].stop).not.toHaveBeenCalled();

    // New chunk arriving mid-fade must survive the prior fade's cleanup timer
    mockCurrentTime = 1.07;
    const nextSpan = player.enqueuePcm24k(chunk, 24000);
    expect(nextSpan).not.toBeNull();
    expect(nextSpan!.startAt).toBeCloseTo(1.07, 6);
    expect(nextSpan!.endAt).toBeCloseTo(1.17, 6);

    vi.advanceTimersByTime(5);
    expect(createdSources[0].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[1].stop).toHaveBeenCalledTimes(1);
    expect(createdSources[2].stop).not.toHaveBeenCalled();
    expect(rampGain.gain.value).toBe(1);
  });

  it('computes normalized 0..1 speaker RMS * 5 from AnalyserNode(fftSize = 256) and returns 0 when idle', () => {
    const player = createPcm24kPlayer();
    expect(mockAnalyser.fftSize).toBe(256);
    expect(player.getSpeakerLevel()).toBe(0);

    // Offset +16 around 128 => amplitude = 16/128 = 0.125 => RMS * 5 = 0.625
    mockAnalyser.getByteTimeDomainData.mockImplementation((buf: Uint8Array) => {
      buf.fill(144);
    });
    expect(player.getSpeakerLevel()).toBeCloseTo(0.625, 3);

    // Loud signal clamps cleanly at 1
    mockAnalyser.getByteTimeDomainData.mockImplementation((buf: Uint8Array) => {
      buf.fill(255);
    });
    expect(player.getSpeakerLevel()).toBe(1);

    // Supports Float32 time-domain analyser API when available
    (mockAnalyser as any).getFloatTimeDomainData = vi.fn((buf: Float32Array) => {
      buf.fill(0.1);
    });
    expect(player.getSpeakerLevel()).toBeCloseTo(0.5, 4);

    // Invalid base64 degrades cleanly to null
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(player.enqueuePcm24k('!!!invalid-base64!!!')).toBeNull();
    warnSpy.mockRestore();
  });

  it('tears down AudioContext on close() and exposes module-level active-clock registry', () => {
    const player = createPcm24kPlayer();
    expect(getActiveVoiceAudioTime()).toBe(0);

    registerActiveVoiceAudioTimingGetter(() => player.getTiming().currentTime);
    mockCurrentTime = 4.25;
    expect(getActiveVoiceAudioTime()).toBeCloseTo(4.25, 5);

    registerActiveVoiceAudioTimingGetter(() => {
      throw new Error('stale');
    });
    expect(getActiveVoiceAudioTime()).toBe(0);

    registerActiveVoiceAudioTimingGetter(null);
    expect(getActiveVoiceAudioTime()).toBe(0);

    player.enqueuePcm24k(int16SamplesToBuffer([100, 200]), 24000);
    player.close();
    expect(createdSources[0].stop).toHaveBeenCalled();
    expect(mockContextClose).toHaveBeenCalledTimes(1);
    expect(player.getSpeakerLevel()).toBe(0);
    expect(player.enqueuePcm24k(int16SamplesToBuffer([100, 200]), 24000)).toBeNull();
  });
});
