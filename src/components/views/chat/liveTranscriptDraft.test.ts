import { describe, expect, it } from 'vitest';
import {
  composerTextWithLiveSpeech,
  mirrorLiveTranscript,
  typedDraftFromComposer,
} from './liveTranscriptDraft';

describe('mirrorLiveTranscript', () => {
  it('writes the live transcription into an empty composer draft', () => {
    const next = mirrorLiveTranscript('', '', 'hola', false);
    expect(next.prompt).toBe('hola');
    expect(next.suffix).toBe('hola');
    expect(next.ownedByUser).toBe(false);
  });

  it('replaces only the trailing spoken segment as the partial grows', () => {
    const first = mirrorLiveTranscript('', '', 'hola', false);
    const next = mirrorLiveTranscript(first.prompt, first.suffix, 'hola mundo', false);
    expect(next.prompt).toBe('hola mundo');
    expect(next.suffix).toBe('hola mundo');
  });

  it('keeps a typed prefix and drops the spoken segment when the utterance ends', () => {
    const spoken = mirrorLiveTranscript('nota', '', 'hola', false);
    expect(spoken.prompt).toBe('nota hola');
    const cleared = mirrorLiveTranscript(spoken.prompt, spoken.suffix, '', false);
    expect(cleared.prompt).toBe('nota');
    expect(cleared.suffix).toBe('');
  });

  it('does not wipe a typed draft when listening starts with an empty partial', () => {
    const next = mirrorLiveTranscript('borrador', '', '', false);
    expect(next.prompt).toBe('borrador');
    expect(next.suffix).toBe('');
  });

  it('stops overwriting the box after the user edits the spoken segment', () => {
    const spoken = mirrorLiveTranscript('', '', 'hola', false);
    const edited = mirrorLiveTranscript('hola, corregido', spoken.suffix, 'hola mundo', false);
    expect(edited.prompt).toBe('hola, corregido');
    expect(edited.ownedByUser).toBe(true);
    const still = mirrorLiveTranscript(edited.prompt, edited.suffix, 'hola mundo cruel', edited.ownedByUser);
    expect(still.prompt).toBe('hola, corregido');
  });

  it('shows live speech in the box without making it the sendable draft', () => {
    const display = composerTextWithLiveSpeech('', 'hola', true);
    expect(display).toBe('hola');
    const split = typedDraftFromComposer(display, '', 'hola', true);
    expect(split.typed).toBe('');
    expect(split.holdLive).toBe(false);
    expect(Boolean(split.typed.trim())).toBe(false);
  });

  it('keeps a typed prefix sendable while live speech is only shown after it', () => {
    const display = composerTextWithLiveSpeech('nota', 'hola', true);
    expect(display).toBe('nota hola');
    const split = typedDraftFromComposer(display, 'nota', 'hola', true);
    expect(split).toEqual({ typed: 'nota', holdLive: false });
  });
});
