import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playZenCue, startAudioDucking, stopAudioDucking, _resetAudioContextForTesting } from './audioDucking';

describe('Audio Ducking & Zen Earcon Sound Cues', () => {
  let mockCreateBuffer: any;
  let mockCreateBufferSource: any;
  let mockDestination: any;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetAudioContextForTesting();

    mockDestination = {};
    mockCreateBuffer = vi.fn().mockReturnValue({
      getChannelData: vi.fn().mockReturnValue(new Float32Array(9702)),
    });
    mockCreateBufferSource = vi.fn().mockReturnValue({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
    });

    (window as any).AudioContext = vi.fn().mockImplementation(() => ({
      sampleRate: 44100,
      state: 'running',
      destination: mockDestination,
      createBuffer: mockCreateBuffer,
      createBufferSource: mockCreateBufferSource,
      resume: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    _resetAudioContextForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('synthesizes Zen start chime (F4 + C5) without throwing', () => {
    expect(() => playZenCue(true)).not.toThrow();
    expect(mockCreateBuffer).toHaveBeenCalledWith(1, expect.any(Number), 44100);
    expect(mockCreateBufferSource).toHaveBeenCalled();
  });

  it('synthesizes Zen stop chime (G4 + D5) without throwing', () => {
    expect(() => playZenCue(false)).not.toThrow();
    expect(mockCreateBuffer).toHaveBeenCalledWith(1, expect.any(Number), 44100);
    expect(mockCreateBufferSource).toHaveBeenCalled();
  });

  it('triggers startAudioDucking and plays start chime', async () => {
    await startAudioDucking();
    expect(mockCreateBufferSource).toHaveBeenCalled();
  });

  it('triggers stopAudioDucking and schedules stop chime after 60ms delay', async () => {
    await startAudioDucking();
    mockCreateBufferSource.mockClear();

    await stopAudioDucking();
    // Before 60ms, stop cue should not have fired yet
    expect(mockCreateBufferSource).not.toHaveBeenCalled();

    // Advance 60ms
    vi.advanceTimersByTime(60);
    expect(mockCreateBufferSource).toHaveBeenCalled();
  });
});
