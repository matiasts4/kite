import { describe, expect, it } from 'vitest';
import {
  VOICE_PRESETS,
  getVoicePalette,
  isKnownVoicePreset,
  normalizeVoiceRgb,
} from './voicePalettes';

describe('Kite Voice Presets & 3-Stop Accent Palettes (T8 / S1, S8)', () => {
  it('defines all 9 canonical Kite voice presets with unique ids, names, tone labels, RGB stops, and provider hints', () => {
    expect(VOICE_PRESETS).toHaveLength(9);
    expect(VOICE_PRESETS.map((v) => v.name)).toEqual([
      'Ara',
      'Vega',
      'Orion',
      'Lyra',
      'Nova',
      'Cael',
      'Sora',
      'Taro',
      'Luma',
    ]);
    expect(VOICE_PRESETS.map((v) => v.toneEs)).toEqual([
      'Clara y cercana',
      'Serena y precisa',
      'Firme y natural',
      'Cálida y expresiva',
      'Ágil y luminosa',
      'Profunda y calma',
      'Ligera y directa',
      'Equilibrada y sobria',
      'Clara y amable',
    ]);

    const ids = new Set(VOICE_PRESETS.map((v) => v.id));
    expect(ids.size).toBe(9);

    for (const preset of VOICE_PRESETS) {
      expect(preset.providerHints.xai.trim().length).toBeGreaterThan(0);
      expect(preset.providerHints.geminiLive.trim().length).toBeGreaterThan(0);
      expect(preset.providerHints.openai.trim().length).toBeGreaterThan(0);

      for (const stop of [preset.palette.deep, preset.palette.core, preset.palette.glint]) {
        expect(stop).toHaveLength(3);
        for (const ch of stop) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('resolves voice presets case-insensitively via getVoicePalette and falls back to Ara for unknown values', () => {
    expect(getVoicePalette('vega').name).toBe('Vega');
    expect(getVoicePalette('  ORION ').name).toBe('Orion');
    expect(getVoicePalette('lyra').toneEs).toBe('Cálida y expresiva');
    expect(getVoicePalette(null).name).toBe('Ara');
    expect(getVoicePalette(undefined).name).toBe('Ara');
    expect(getVoicePalette('').name).toBe('Ara');
    expect(getVoicePalette('nonexistent-voice').name).toBe('Ara');
  });

  it('validates known voice presets strictly via isKnownVoicePreset', () => {
    expect(isKnownVoicePreset('Ara')).toBe(true);
    expect(isKnownVoicePreset('  cael ')).toBe(true);
    expect(isKnownVoicePreset('LUMA')).toBe(true);
    expect(isKnownVoicePreset('unknown')).toBe(false);
    expect(isKnownVoicePreset('')).toBe(false);
    expect(isKnownVoicePreset(null)).toBe(false);
    expect(isKnownVoicePreset(undefined)).toBe(false);
  });

  it('normalizes 0..255 RGB triplets to clamped 0..1 WebGL float triplets', () => {
    const normalized = normalizeVoiceRgb({
      deep: [0, 127.5, 255],
      core: [-20, 51, 300],
      glint: [102, 204, 255],
    });

    expect(normalized.deep[0]).toBe(0);
    expect(normalized.deep[1]).toBeCloseTo(0.5, 5);
    expect(normalized.deep[2]).toBe(1);

    expect(normalized.core[0]).toBe(0);
    expect(normalized.core[1]).toBeCloseTo(0.2, 5);
    expect(normalized.core[2]).toBe(1);

    expect(normalized.glint[0]).toBeCloseTo(0.4, 5);
    expect(normalized.glint[1]).toBeCloseTo(0.8, 5);
    expect(normalized.glint[2]).toBe(1);

    for (const preset of VOICE_PRESETS) {
      const gl = normalizeVoiceRgb(preset.palette);
      for (const stop of [gl.deep, gl.core, gl.glint]) {
        for (const ch of stop) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
