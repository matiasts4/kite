import { describe, expect, it } from 'vitest';
import { joinSpeechPartial } from './speechPartial';

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
});
