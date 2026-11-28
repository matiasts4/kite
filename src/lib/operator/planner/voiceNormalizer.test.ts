import { describe, expect, it } from 'vitest';
import { normalizeSpanishVoiceStt } from './voiceNormalizer';

describe('voiceNormalizer — Argos wake words & Spanish orchestration phonetics', () => {
  it('strips Argos wake-word prefixes and phonetic variants at utterance start', () => {
    expect(normalizeSpanishVoiceStt('Oye Argos, abre un hilo con Claude').normalized).toBe(
      'abre un hilo con Claude'
    );
    expect(normalizeSpanishVoiceStt('che argos cierra todas las terminales').normalized).toBe(
      'cierra todas las terminales'
    );
    expect(normalizeSpanishVoiceStt('Hola argus, cambia al proyecto kite').normalized).toBe(
      'cambia al proyecto kite'
    );
    expect(normalizeSpanishVoiceStt('Ok hargos: lanza un subagente').normalized).toBe(
      'lanza un subagente'
    );
    expect(normalizeSpanishVoiceStt('Hey argo, revisa los tests').normalized).toBe(
      'revisa los tests'
    );
  });

  it('normalizes Argos phonetic variants in assistant-addressing positions', () => {
    const res1 = normalizeSpanishVoiceStt('dile a argus que revise el repo');
    expect(res1.normalized).toBe('dile a Argos que revise el repo');
    expect(res1.corrections).toContain('phonetic_argos');

    const res2 = normalizeSpanishVoiceStt('pregúntale a argo si terminó');
    expect(res2.normalized).toBe('pregúntale a Argos si terminó');

    const res3 = normalizeSpanishVoiceStt('hola hargos');
    expect(res3.normalized).toBe('hola Argos');
  });

  it('repairs Spanish STT phonetic terms for swarm, worktree, claude code, and kite', () => {
    const res = normalizeSpanishVoiceStt(
      'Oye Argos, lanza un eswarm en un guorktri de kait con clod code'
    );
    expect(res.normalized).toBe('lanza un swarm en un worktree de kite con claude code');
    expect(res.corrections).toEqual(
      expect.arrayContaining([
        'wake_word',
        'phonetic_swarm',
        'phonetic_worktree',
        'phonetic_kite',
        'phonetic_claude_code',
      ])
    );

    expect(normalizeSpanishVoiceStt('abre suarm en work tree de cait con cloud code').normalized).toBe(
      'abre swarm en worktree de kite con claude code'
    );
  });

  it('preserves existing Zed and Seth wake-word and phonetic rules', () => {
    expect(normalizeSpanishVoiceStt('Oye Seth, abre un threat con Clot para armar el o de de').normalized).toBe(
      'abre un thread con claude para armar el ODD'
    );
    expect(normalizeSpanishVoiceStt('Hey Zed, Sierra a Orion').normalized).toBe('Cierra a Orion');
  });
});
