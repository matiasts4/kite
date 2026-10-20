import { describe, it, expect } from 'vitest';
import utterances from './utterances.es.json';
import {
  assertFailuresRegistryValid,
  collectFailureProblems,
  loadCommittedFailures,
  type ZedFailureRow,
} from './failures';

const utteranceInputs = utterances.map((row) => row.input);

describe('Zed failure registry — fixtures/failures.json', () => {
  it('committed failures.json passes validation', () => {
    expect(() => assertFailuresRegistryValid(loadCommittedFailures(), utteranceInputs)).not.toThrow();
  });

  it('open row fails and message includes id', () => {
    const row: ZedFailureRow = {
      id: 'ejemplo-abierto',
      recordedAt: '2026-10-20',
      layer: 'entender',
      phrase: 'abre tres terminales',
      expected: 'Debería abrir tres terminales con Grok',
      status: 'open',
    };
    const problems = collectFailureProblems([row], utteranceInputs);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('ejemplo-abierto');
    expect(problems.join('\n')).toContain('still open');
  });

  it('encoded entender fails when phrase is missing from utterances.es.json', () => {
    const row: ZedFailureRow = {
      id: 'entender-sin-corpus',
      recordedAt: '2026-10-20',
      layer: 'entender',
      phrase: 'frase que no está en el corpus de utterances',
      expected: 'Debería planificar open_terminals',
      status: 'encoded',
    };
    const problems = collectFailureProblems([row], utteranceInputs);
    expect(problems.some((p) => p.includes('not in utterances.es.json'))).toBe(true);
  });

  it('encoded entender passes when phrase matches an utterances input', () => {
    const phraseFromCorpus = utterances[0].input;
    const row: ZedFailureRow = {
      id: 'entender-en-corpus',
      recordedAt: '2026-10-20',
      layer: 'entender',
      phrase: phraseFromCorpus,
      expected: 'Caso ya cubierto por heuristic.test sobre utterances',
      status: 'encoded',
    };
    expect(collectFailureProblems([row], utteranceInputs)).toEqual([]);
  });

  describe('oir encoded rows', () => {
    it('fails when heard equals said', () => {
      const row: ZedFailureRow = {
        id: 'oir-igual',
        recordedAt: '2026-10-20',
        layer: 'oir',
        phrase: 'abre dos terminales',
        expected: 'Transcripción correcta',
        status: 'encoded',
        heard: 'abre dos terminales',
        said: 'abre dos terminales',
        trace: 'turn-abc',
      };
      const problems = collectFailureProblems([row], utteranceInputs);
      expect(problems.some((p) => p.includes('heard and said must differ'))).toBe(true);
    });

    it('passes when heard differs from said, phrase equals heard, trace present', () => {
      const row: ZedFailureRow = {
        id: 'oir-ok',
        recordedAt: '2026-10-20',
        layer: 'oir',
        phrase: 'abriera dos terminales',
        expected: 'Debió oír "abrí dos terminales"',
        status: 'encoded',
        heard: 'abriera dos terminales',
        said: 'abrí dos terminales',
        trace: 'turn-xyz.jsonl',
      };
      expect(collectFailureProblems([row], utteranceInputs)).toEqual([]);
    });
  });

  describe('hacer encoded rows', () => {
    it('fails without trace', () => {
      const row: ZedFailureRow = {
        id: 'hacer-sin-traza',
        recordedAt: '2026-10-20',
        layer: 'hacer',
        phrase: 'cierra todas las terminales',
        expected: 'Debían cerrarse los panes',
        status: 'encoded',
        observed: 'Quedó una terminal abierta',
      };
      const problems = collectFailureProblems([row], utteranceInputs);
      expect(problems.some((p) => p.includes('"trace"'))).toBe(true);
    });

    it('passes with trace and observed', () => {
      const row: ZedFailureRow = {
        id: 'hacer-ok',
        recordedAt: '2026-10-20',
        layer: 'hacer',
        phrase: 'abre el navegador en localhost',
        expected: 'Debía abrirse la pestaña del navegador',
        status: 'encoded',
        trace: 'turn-hacer-1',
        observed: 'El dock derecho no cambió a navegador',
      };
      expect(collectFailureProblems([row], utteranceInputs)).toEqual([]);
    });
  });
});
