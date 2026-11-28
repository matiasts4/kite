import { describe, it, expect } from 'vitest';
import {
  appendAudioSpan,
  computeAudioSpanProgress,
  computeSpokenCharCount,
  selectTeleprompterTurnView,
  splitTeleprompterParagraphs,
  type AudioSpan,
  type LiveTeleprompterLine,
} from './audioSpanSync';

describe('audioSpanSync (S2)', () => {
  describe('appendAudioSpan', () => {
    it('creates an initial span scaled by playbackSpeed without mutating undefined or empty input', () => {
      const spans = appendAudioSpan(undefined, 1.0, 1.5, 1.5);
      expect(spans).toEqual([{ startAt: 1.0, endAt: 1.5, talkerDur: 0.75 }]);
    });

    it('coalesces contiguous spans within <0.02s at matching playbackSpeed immutably', () => {
      const initial: AudioSpan[] = [{ startAt: 2.0, endAt: 2.5, talkerDur: 0.5 }];
      const next = appendAudioSpan(initial, 2.51, 3.01, 1.0);

      expect(initial).toHaveLength(1); // input remains unmutated
      expect(next).toHaveLength(1);
      expect(next[0].startAt).toBe(2.0);
      expect(next[0].endAt).toBeCloseTo(3.01, 6);
      expect(next[0].talkerDur).toBeCloseTo(1.0, 6);
    });

    it('does not coalesce spans separated by >= 0.02s gap or different playback rates', () => {
      const s1 = appendAudioSpan(undefined, 1.0, 2.0, 1.0);
      const s2 = appendAudioSpan(s1, 2.03, 3.03, 1.0);
      expect(s2).toHaveLength(2);

      const s3 = appendAudioSpan(s2, 3.035, 3.535, 1.5);
      expect(s3).toHaveLength(3);
      expect(s3[2]).toEqual({ startAt: 3.035, endAt: 3.535, talkerDur: 0.75 });
    });

    it('ignores invalid or zero/negative-length spans', () => {
      const base: AudioSpan[] = [{ startAt: 1, endAt: 2, talkerDur: 1 }];
      expect(appendAudioSpan(base, 2, 2, 1)).toEqual(base);
      expect(appendAudioSpan(base, 3, 2, 1)).toEqual(base);
      expect(appendAudioSpan(base, Number.NaN, 3, 1)).toEqual(base);
    });
  });

  describe('computeAudioSpanProgress', () => {
    it('interpolates linearly inside active spans and holds across pauses', () => {
      const line: Pick<
        LiveTeleprompterLine,
        'audioSpans' | 'talkerDuration' | 'utteranceStart' | 'utteranceEnd'
      > = {
        audioSpans: [
          { startAt: 10, endAt: 12, talkerDur: 2 },
          { startAt: 13, endAt: 15, talkerDur: 2 },
        ],
        talkerDuration: 4,
      };

      expect(computeAudioSpanProgress(9.5, line)).toBe(0);
      expect(computeAudioSpanProgress(11, line)).toBeCloseTo(0.25, 5);
      expect(computeAudioSpanProgress(12, line)).toBeCloseTo(0.5, 5);
      expect(computeAudioSpanProgress(12.5, line)).toBeCloseTo(0.5, 5);
      expect(computeAudioSpanProgress(14, line)).toBeCloseTo(0.75, 5);
      expect(computeAudioSpanProgress(16, line)).toBe(1);
    });

    it('weights against Math.max(talkerDuration, sumTalkerDur) when stream is partial', () => {
      const line = {
        audioSpans: [{ startAt: 0, endAt: 1, talkerDur: 1 }],
        talkerDuration: 4,
      };
      expect(computeAudioSpanProgress(1, line)).toBeCloseTo(0.25, 5);
    });

    it('weights mixed playback speeds accurately across spans', () => {
      let spans = appendAudioSpan(undefined, 0, 2, 1.0); // 2s of talker audio in 2s wall
      spans = appendAudioSpan(spans, 2, 3, 2.0); // 2s of talker audio in 1s wall
      const line = { audioSpans: spans, talkerDuration: 4 };

      expect(computeAudioSpanProgress(2.0, line)).toBeCloseTo(0.5, 5);
      expect(computeAudioSpanProgress(2.5, line)).toBeCloseTo(0.75, 5);
      expect(computeAudioSpanProgress(3.0, line)).toBeCloseTo(1.0, 5);
    });

    it('falls back to utteranceStart..utteranceEnd when no audioSpans are present', () => {
      const line = {
        utteranceStart: 100,
        utteranceEnd: 104,
      };
      expect(computeAudioSpanProgress(99, line)).toBe(0);
      expect(computeAudioSpanProgress(101, line)).toBeCloseTo(0.25, 5);
      expect(computeAudioSpanProgress(102, line)).toBeCloseTo(0.5, 5);
      expect(computeAudioSpanProgress(106, line)).toBe(1);
    });
  });

  describe('computeSpokenCharCount', () => {
    it('advances monotonically and never regresses below prevSpokenChars', () => {
      const line: LiveTeleprompterLine = {
        seq: 1,
        kind: 'voice',
        text: 'Hola mundo esto es una prueba completa',
        timeMs: 1000,
        audioSpans: [{ startAt: 0, endAt: 2, talkerDur: 2 }],
        talkerDuration: 4,
      };

      const first = computeSpokenCharCount(2, line, 0);
      expect(first).toBe(Math.round(0.5 * line.text.length));

      // Simulate total talkerDuration growing so raw progress dips from 0.5 to 0.25
      const expandedLine: LiveTeleprompterLine = { ...line, talkerDuration: 8 };
      expect(computeSpokenCharCount(2, expandedLine, first)).toBe(first);
    });

    it('respects frozen spokenChars after barge-in', () => {
      const frozenLine: LiveTeleprompterLine = {
        seq: 2,
        kind: 'voice',
        text: 'Esta respuesta fue interrumpida a mitad de camino',
        timeMs: 1000,
        spokenChars: 14,
        audioSpans: [{ startAt: 0, endAt: 5, talkerDur: 5 }],
        talkerDuration: 5,
      };

      expect(computeSpokenCharCount(5, frozenLine, 30)).toBe(14);
    });
  });

  describe('splitTeleprompterParagraphs', () => {
    it('splits 1st sentence as lead and groups subsequent sentences 2 per body paragraph', () => {
      const text = 'Primera oración. Segunda oración! Tercera oración? Cuarta oración. Quinta oración.';
      const paragraphs = splitTeleprompterParagraphs(text, true);

      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[0]).toEqual({
        kind: 'lead',
        start: 0,
        end: 'Primera oración.'.length,
        text: 'Primera oración.',
      });
      expect(paragraphs[1].kind).toBe('body');
      expect(paragraphs[1].text).toBe('Segunda oración! Tercera oración?');
      expect(text.slice(paragraphs[1].start, paragraphs[1].end)).toBe(paragraphs[1].text);

      expect(paragraphs[2].kind).toBe('body');
      expect(paragraphs[2].text).toBe('Cuarta oración. Quinta oración.');
      expect(text.slice(paragraphs[2].start, paragraphs[2].end)).toBe(paragraphs[2].text);
    });

    it('groups all sentences 2 per body paragraph when withLead is false', () => {
      const text = 'Uno. Dos. Tres.';
      const paragraphs = splitTeleprompterParagraphs(text, false);

      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0]).toEqual({ kind: 'body', start: 0, end: 9, text: 'Uno. Dos.' });
      expect(paragraphs[1]).toEqual({ kind: 'body', start: 10, end: 15, text: 'Tres.' });
    });

    it('does not split decimal numbers and preserves partial trailing sentences', () => {
      const text = 'Velocidad 1.25x aplicada. Listo para seguir';
      const paragraphs = splitTeleprompterParagraphs(text, true);

      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0].text).toBe('Velocidad 1.25x aplicada.');
      expect(paragraphs[1].text).toBe('Listo para seguir');
    });

    it('returns empty array for empty or whitespace text', () => {
      expect(splitTeleprompterParagraphs('   \n  ')).toEqual([]);
    });
  });

  describe('selectTeleprompterTurnView', () => {
    it('selects latest user turn and following assistant lines with non-whitespace spoken prefix', () => {
      const lines: LiveTeleprompterLine[] = [
        { seq: 1, kind: 'user', text: 'Primer turno', timeMs: 100 },
        { seq: 2, kind: 'voice', text: 'Respuesta vieja', timeMs: 200 },
        { seq: 3, kind: 'user', text: 'Segundo turno', timeMs: 300, interim: false },
        { seq: 4, kind: 'voice', text: '   ', timeMs: 350 },
        { seq: 5, kind: 'voice', text: 'Hola', timeMs: 400, spokenChars: 0 },
        { seq: 6, kind: 'voice', text: '   Claro, ya lo reviso.', timeMs: 450, spokenChars: 2 },
        { seq: 7, kind: 'voice', text: 'Encontré dos archivos.', timeMs: 500, spokenChars: 9 },
        { seq: 8, kind: 'voice', text: 'Seguimos.', timeMs: 550 },
      ];

      const view = selectTeleprompterTurnView(lines);
      expect(view.speakingUserLine).toBeUndefined();
      expect(view.lastUserLine?.seq).toBe(3);
      expect(view.agentLines.map((l) => l.seq)).toEqual([7, 8]);
    });

    it('exposes interim user line as speakingUserLine and clears prior assistant lines', () => {
      const lines: LiveTeleprompterLine[] = [
        { seq: 1, kind: 'voice', text: 'Hola, ¿en qué ayudo?', timeMs: 100 },
        { seq: 2, kind: 'user', text: 'Abrime el archivo…', timeMs: 200, interim: true },
      ];

      const view = selectTeleprompterTurnView(lines);
      expect(view.speakingUserLine?.seq).toBe(2);
      expect(view.lastUserLine?.seq).toBe(2);
      expect(view.agentLines).toEqual([]);
    });
  });
});
