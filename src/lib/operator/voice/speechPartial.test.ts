import { describe, expect, it } from 'vitest';
import { joinSpeechPartial, LiveTranscriptStabilizer } from './speechPartial';

describe('joinSpeechPartial', () => {
  it('keeps already transcribed text when the next chunk starts', () => {
    expect(joinSpeechPartial('hola cómo estás', 'quiero')).toBe('hola cómo estás quiero');
  });

  it('keeps the transcribed prefix when the next chunk is still empty', () => {
    expect(joinSpeechPartial('hola cómo estás', '')).toBe('hola cómo estás');
  });

  it('does not duplicate a chunk that already contains the prefix', () => {
    expect(joinSpeechPartial('hola', 'hola cómo estás')).toBe('hola cómo estás');
  });

  it('does not duplicate a chunk that is already at the end', () => {
    expect(joinSpeechPartial('hola cómo estás', 'estás')).toBe('hola cómo estás');
  });

  it('joins a chunk that overlaps the last words instead of repeating them', () => {
    expect(joinSpeechPartial('hola cómo', 'cómo estás')).toBe('hola cómo estás');
  });

  it('does not glue a new chunk onto the last letter', () => {
    expect(joinSpeechPartial('hola', 'algo')).toBe('hola algo');
  });

  it('preserves existing words when STT shifts punctuation or capitalization', () => {
    expect(joinSpeechPartial('Bueno, correcciones', 'Bueno correcciones qué quiero')).toBe(
      'Bueno, correcciones qué quiero'
    );
    expect(joinSpeechPartial('Quiero continuar.', 'quiero continuar con el modo voz')).toBe(
      'Quiero continuar. con el modo voz'
    );
    expect(joinSpeechPartial('hola, cómo', 'como estás?')).toBe('hola, cómo como estás?');
    expect(joinSpeechPartial('hola, cómo', 'cómo estás?')).toBe('hola, cómo estás?');
  });
});

describe('LiveTranscriptStabilizer', () => {
  it('locks stable leading words so retroactive STT edits never rewrite far backwards', () => {
    const stabilizer = new LiveTranscriptStabilizer({ mutableTailWords: 3 });

    expect(stabilizer.pushPartial('Quiero que continuemos con toda la parte')).toBe(
      'Quiero que continuemos con toda la parte'
    );
    // Second consistent partial locks "Quiero que continuemos con toda" (leaving 3 trailing words mutable)
    expect(stabilizer.pushPartial('Quiero que continuemos con toda la parte de')).toBe(
      'Quiero que continuemos con toda la parte de'
    );
    // Retroactive STT rewrite changing words 1 and 4 backwards must NOT overwrite locked prefix
    const afterRewrite = stabilizer.pushPartial(
      'Quise que continuemos por toda la parte del asistente'
    );
    expect(afterRewrite).toBe('Quiero que continuemos con toda la parte del asistente');
  });

  it('avoids seam duplication when STT inserts a filler word inside the locked prefix', () => {
    const stabilizer = new LiveTranscriptStabilizer({ mutableTailWords: 3 });

    stabilizer.pushPartial('En cuanto a la parte superior aparece un texto');
    stabilizer.pushPartial('En cuanto a la parte superior aparece un texto nuevo');
    // "eh" inserted earlier in the prefix shifts word indices by +1
    const aligned = stabilizer.pushPartial(
      'En cuanto eh a la parte superior aparece un texto nuevo hoy'
    );
    expect(aligned).toBe('En cuanto a la parte superior aparece un texto nuevo hoy');
  });

  it('never shrinks displayed text on transient shorter hypotheses and locks on pushFinal', () => {
    const stabilizer = new LiveTranscriptStabilizer({ mutableTailWords: 2 });

    stabilizer.pushPartial('uno dos tres cuatro cinco');
    stabilizer.pushPartial('uno dos tres cuatro cinco seis');
    // Transient shorter partial must keep existing display
    expect(stabilizer.pushPartial('uno dos')).toBe('uno dos tres cuatro cinco seis');
    expect(stabilizer.pushFinal('uno dos tres cuatro cinco seis.')).toBe(
      'uno dos tres cuatro cinco seis.'
    );

    stabilizer.reset();
    expect(stabilizer.getDisplayed()).toBe('');
  });
});
