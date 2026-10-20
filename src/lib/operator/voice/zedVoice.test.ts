import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isVoiceRecognitionSupported,
  getVoiceEngineStatus,
  startOperatorListening,
  stopOperatorListening,
  getCurrentAudioLevel,
  encodeWavBlob,
  blobToBase64,
  cleanTranscriptionText,
  startTranscriptionTestSession,
} from './zedVoice';

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

  it('filters Whisper silence hallucinations like Velocity audio engine', () => {
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
});
