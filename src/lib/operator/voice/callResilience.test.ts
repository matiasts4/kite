import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MicFlatlineDetector,
  ScreenWakeLockManager,
  SubagentGuardedInactivityTimer,
  VoiceInactivityAutoSleepGuard,
  computeAdaptiveInactivityTimeoutMs,
  clampVoicePlaybackSpeed,
  nextVoicePlaybackSpeed,
  formatVoicePlaybackSpeed,
  watchDeviceHotSwap,
} from './callResilience';
import {
  listAudioOutputDevices,
  applyAudioOutputDevice,
  subscribeAudioDeviceChanges,
} from './audioDevices';

describe('T7 — audioDevices speaker output & hot-swap helpers', () => {
  const originalMediaDevices = navigator.mediaDevices;

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    });
    vi.restoreAllMocks();
  });

  it('lists audiooutput devices with Spanish fallback labels', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Mic', groupId: 'g1' },
          { kind: 'audiooutput', deviceId: 'spk-1', label: 'USB Headphones', groupId: 'g2' },
          { kind: 'audiooutput', deviceId: 'spk-2', label: '', groupId: 'g3' },
        ]),
      },
    });

    const outputs = await listAudioOutputDevices();
    expect(outputs).toEqual([
      { deviceId: 'spk-1', label: 'USB Headphones', groupId: 'g2' },
      { deviceId: 'spk-2', label: 'Altavoz 2', groupId: 'g3' },
    ]);
  });

  it('applies setSinkId when supported and returns false gracefully when unsupported or rejected', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const elWithSink = { setSinkId } as unknown as HTMLMediaElement;

    expect(await applyAudioOutputDevice(elWithSink, 'spk-2')).toBe(true);
    expect(setSinkId).toHaveBeenCalledWith('spk-2');

    expect(await applyAudioOutputDevice(elWithSink, 'default')).toBe(true);
    expect(setSinkId).toHaveBeenLastCalledWith('');

    const elWithoutSink = {} as HTMLMediaElement;
    expect(await applyAudioOutputDevice(elWithoutSink, 'spk-2')).toBe(false);

    const failingEl = {
      setSinkId: vi.fn().mockRejectedValue(new Error('NotFoundError')),
    } as unknown as HTMLMediaElement;
    expect(await applyAudioOutputDevice(failingEl, 'missing')).toBe(false);
  });

  it('subscribes and unsubscribes to navigator.mediaDevices devicechange events', () => {
    const listeners = new Set<() => void>();
    const addEventListener = vi.fn((event: string, cb: () => void) => {
      if (event === 'devicechange') listeners.add(cb);
    });
    const removeEventListener = vi.fn((event: string, cb: () => void) => {
      if (event === 'devicechange') listeners.delete(cb);
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { addEventListener, removeEventListener },
    });

    const onDeviceChange = vi.fn();
    const unsubscribe = subscribeAudioDeviceChanges(onDeviceChange);
    expect(addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));

    listeners.forEach((cb) => cb());
    expect(onDeviceChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
    expect(listeners.size).toBe(0);
  });

  it('watchDeviceHotSwap handles both MediaStreamTrack ended and devicechange', () => {
    const trackListeners = new Set<() => void>();
    const fakeTrack = {
      addEventListener: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'ended') trackListeners.add(cb);
      }),
      removeEventListener: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'ended') trackListeners.delete(cb);
      }),
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getAudioTracks: () => [fakeTrack],
    } as unknown as MediaStream;

    const deviceListeners = new Set<() => void>();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        addEventListener: (ev: string, cb: () => void) => {
          if (ev === 'devicechange') deviceListeners.add(cb);
        },
        removeEventListener: (ev: string, cb: () => void) => {
          if (ev === 'devicechange') deviceListeners.delete(cb);
        },
      },
    });

    const onTrackEnded = vi.fn();
    const onDeviceChange = vi.fn();
    const stop = watchDeviceHotSwap({
      stream: fakeStream,
      onTrackEnded,
      onDeviceChange,
    });

    trackListeners.forEach((cb) => cb());
    deviceListeners.forEach((cb) => cb());
    expect(onTrackEnded).toHaveBeenCalledWith(fakeTrack);
    expect(onDeviceChange).toHaveBeenCalledTimes(1);

    stop();
    expect(trackListeners.size).toBe(0);
    expect(deviceListeners.size).toBe(0);
  });
});

describe('T7 — MicFlatlineDetector', () => {
  it('triggers flatline after continuous RMS <= 0.0001 for 4500 ms and auto-clears when RMS > 0.001', () => {
    let nowMs = 1000;
    const onFlatline = vi.fn();
    const onRecovered = vi.fn();
    const detector = new MicFlatlineDetector({
      now: () => nowMs,
      onFlatline,
      onRecovered,
    });

    detector.pushRms(0.0);
    expect(detector.isFlatlined).toBe(false);

    nowMs += 4400;
    detector.pushRms(0.0001);
    expect(detector.isFlatlined).toBe(false);
    expect(onFlatline).not.toHaveBeenCalled();

    nowMs += 100;
    detector.pushRms(0.0);
    expect(detector.isFlatlined).toBe(true);
    expect(onFlatline).toHaveBeenCalledTimes(1);

    // Noise floor <= 0.001 does not clear flatline
    nowMs += 500;
    detector.pushRms(0.0008);
    expect(detector.isFlatlined).toBe(true);

    // Speech signal > 0.001 clears flatline automatically
    nowMs += 100;
    detector.pushRms(0.005);
    expect(detector.isFlatlined).toBe(false);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('ignores zero RMS frames while muted or not listening and resets on reset()', () => {
    let nowMs = 0;
    const onFlatline = vi.fn();
    const detector = new MicFlatlineDetector({
      now: () => nowMs,
      onFlatline,
    });

    detector.pushRms(0, { isMuted: true, isListening: true });
    nowMs += 6000;
    detector.pushRms(0, { isMuted: true, isListening: true });
    expect(detector.isFlatlined).toBe(false);

    detector.pushRms(0, { isMuted: false, isListening: false });
    nowMs += 6000;
    detector.pushRms(0, { isMuted: false, isListening: false });
    expect(detector.isFlatlined).toBe(false);

    // Now unmuted & listening: needs full 4500 ms from this moment
    detector.pushRms(0, { isMuted: false, isListening: true });
    nowMs += 4500;
    detector.pushRms(0, { isMuted: false, isListening: true });
    expect(detector.isFlatlined).toBe(true);
    expect(onFlatline).toHaveBeenCalledTimes(1);

    detector.reset();
    expect(detector.isFlatlined).toBe(false);
  });
});

describe('T7 — ScreenWakeLockManager', () => {
  const originalWakeLock = (navigator as Navigator & { wakeLock?: unknown }).wakeLock;
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  afterEach(() => {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: originalWakeLock,
    });
    if (originalVisibility) {
      Object.defineProperty(document, 'visibilityState', originalVisibility);
    }
    vi.restoreAllMocks();
  });

  it('acquires wakeLock, re-acquires on visibilitychange to visible, and releases cleanly', async () => {
    const releaseMock = vi.fn().mockResolvedValue(undefined);
    const sentinelListeners = new Map<string, () => void>();
    const requestMock = vi.fn().mockImplementation(async () => ({
      released: false,
      release: releaseMock,
      addEventListener: (ev: string, cb: () => void) => sentinelListeners.set(ev, cb),
      removeEventListener: (ev: string) => sentinelListeners.delete(ev),
    }));

    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: requestMock },
    });

    const manager = new ScreenWakeLockManager();
    expect(await manager.acquire()).toBe(true);
    expect(requestMock).toHaveBeenCalledWith('screen');
    expect(manager.isActive()).toBe(true);

    // Simulate OS/browser releasing sentinel when tab goes hidden, then returning to visible
    sentinelListeners.get('release')?.();
    expect(manager.isActive()).toBe(false);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(manager.isActive()).toBe(true);

    await manager.release();
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(manager.isActive()).toBe(false);
  });

  it('acts as a safe no-op when navigator.wakeLock is unavailable', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: undefined,
    });

    const manager = new ScreenWakeLockManager();
    expect(await manager.acquire()).toBe(false);
    expect(manager.isActive()).toBe(false);
    await expect(manager.release()).resolves.toBeUndefined();
  });
});

describe('T7 — SubagentGuardedInactivityTimer & adaptive timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scales timeout linearly from 15,000 ms to 60,000 ms over 300,000 ms', () => {
    expect(computeAdaptiveInactivityTimeoutMs(-100)).toBe(15_000);
    expect(computeAdaptiveInactivityTimeoutMs(0)).toBe(15_000);
    expect(computeAdaptiveInactivityTimeoutMs(150_000)).toBe(37_500);
    expect(computeAdaptiveInactivityTimeoutMs(300_000)).toBe(60_000);
    expect(computeAdaptiveInactivityTimeoutMs(600_000)).toBe(60_000);
  });

  it('resets on user/assistant activity and blocks auto-pause while hasActiveWork() is true', () => {
    let activeWork = true;
    const onAutoPause = vi.fn();
    const timer = new SubagentGuardedInactivityTimer({
      hasActiveWork: () => activeWork,
      onAutoPause,
    });

    timer.start();

    // Advance past 15s while a subagent/turn/proposal is active -> blocked
    vi.advanceTimersByTime(16_000);
    expect(onAutoPause).not.toHaveBeenCalled();

    // Still active at 45s -> still blocked
    vi.advanceTimersByTime(30_000);
    expect(onAutoPause).not.toHaveBeenCalled();

    // User speaks and work finishes
    activeWork = false;
    timer.recordActivity('user_speech');

    // Immediately after activity, should not pause
    vi.advanceTimersByTime(10_000);
    expect(onAutoPause).not.toHaveBeenCalled();

    // Assistant speaks, resetting the inactivity clock again
    timer.recordActivity('assistant_speech');
    vi.advanceTimersByTime(10_000);
    expect(onAutoPause).not.toHaveBeenCalled();

    // Advance past the adaptive timeout (~24.9s at ~66s call age) -> auto-pauses once
    vi.advanceTimersByTime(30_000);
    expect(onAutoPause).toHaveBeenCalledTimes(1);

    timer.stop();
  });
});

describe('T7 — Playback speed helpers', () => {
  it('clamps playback speed between 0.5x and 2.0x in 0.05 / 0.25 steps', () => {
    expect(clampVoicePlaybackSpeed(0.1)).toBe(0.5);
    expect(clampVoicePlaybackSpeed(0.5)).toBe(0.5);
    expect(clampVoicePlaybackSpeed(1.23)).toBe(1.25);
    expect(clampVoicePlaybackSpeed(1.12, 0.25)).toBe(1);
    expect(clampVoicePlaybackSpeed(2.8)).toBe(2);
    expect(clampVoicePlaybackSpeed(Number.NaN)).toBe(1);
  });

  it('cycles presets [0.75, 1, 1.25, 1.5, 1.75, 2] and formats cleanly', () => {
    expect(nextVoicePlaybackSpeed(0.75)).toBe(1);
    expect(nextVoicePlaybackSpeed(1)).toBe(1.25);
    expect(nextVoicePlaybackSpeed(1.25)).toBe(1.5);
    expect(nextVoicePlaybackSpeed(1.5)).toBe(1.75);
    expect(nextVoicePlaybackSpeed(1.75)).toBe(2);
    expect(nextVoicePlaybackSpeed(2)).toBe(0.75);
    expect(nextVoicePlaybackSpeed(1.1)).toBe(1.25);
    expect(formatVoicePlaybackSpeed(1)).toBe('1x');
    expect(formatVoicePlaybackSpeed(1.25)).toBe('1.25x');
  });
});

describe('T6 — VoiceInactivityAutoSleepGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks stream seconds and fires onWarn and onTimeout once-only after pure idle', () => {
    const onWarn = vi.fn();
    const onTimeout = vi.fn();
    const guard = new VoiceInactivityAutoSleepGuard({
      timeoutSec: 60,
      warningLeadSec: 15,
      onWarn,
      onTimeout,
    });

    expect(guard.isRunning()).toBe(false);
    expect(guard.getElapsedStreamSeconds()).toBe(0);

    guard.start();
    expect(guard.isRunning()).toBe(true);

    vi.advanceTimersByTime(44_000);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(guard.getElapsedStreamSeconds()).toBe(44);

    vi.advanceTimersByTime(1_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(15);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(14_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(guard.isRunning()).toBe(false);
    expect(guard.getElapsedStreamSeconds()).toBe(60);

    // Must never fire a second time and keeps frozen elapsed seconds
    vi.advanceTimersByTime(60_000);
    guard.touch('late_event');
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(guard.getElapsedStreamSeconds()).toBe(60);
  });

  it('resets warning and timeout cleanly when touch() is called', () => {
    const onWarn = vi.fn();
    const onTimeout = vi.fn();
    const guard = new VoiceInactivityAutoSleepGuard({
      timeoutSec: 60,
      warningLeadSec: 15,
      onWarn,
      onTimeout,
    });

    guard.start();
    vi.advanceTimersByTime(46_000);
    expect(onWarn).toHaveBeenCalledTimes(1);

    guard.touch('user_speech');
    vi.advanceTimersByTime(40_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(onWarn).toHaveBeenCalledTimes(2);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('never fires onTimeout or onWarn while isBusy() returns true, and grants a full idle window after busy clears', () => {
    let busy = true;
    const onWarn = vi.fn();
    const onTimeout = vi.fn();
    const guard = new VoiceInactivityAutoSleepGuard({
      timeoutSec: 60,
      warningLeadSec: 10,
      isBusy: () => busy,
      onWarn,
      onTimeout,
    });

    guard.start();
    vi.advanceTimersByTime(120_000);

    expect(onWarn).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(guard.isRunning()).toBe(true);
    expect(guard.getElapsedStreamSeconds()).toBe(120);

    busy = false;
    vi.advanceTimersByTime(40_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(12_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(guard.isRunning()).toBe(false);
  });

  it('disables auto-sleep when timeoutSec <= 0 while continuing to track stream seconds, and supports setTimeoutSec + stop', () => {
    const onWarn = vi.fn();
    const onTimeout = vi.fn();
    const guard = new VoiceInactivityAutoSleepGuard({
      timeoutSec: 0,
      warningLeadSec: 15,
      onWarn,
      onTimeout,
    });

    guard.start();
    vi.advanceTimersByTime(600_000);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(guard.isRunning()).toBe(true);
    expect(guard.getElapsedStreamSeconds()).toBe(600);

    guard.setTimeoutSec(60);
    vi.advanceTimersByTime(59_000);
    expect(onTimeout).not.toHaveBeenCalled();

    guard.setTimeoutSec(0);
    vi.advanceTimersByTime(120_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(guard.getElapsedStreamSeconds()).toBe(779);

    guard.stop();
    expect(guard.isRunning()).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(guard.getElapsedStreamSeconds()).toBe(779);
  });
});
