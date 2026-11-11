// Live voice transcription belongs in the composer draft, not the draft hero.
// The spoken segment is a trailing suffix so a typed prefix survives, and it
// leaves the box when the utterance ends so the submitted turn is not duplicated.

export interface LiveTranscriptMirror {
  prompt: string;
  suffix: string;
  ownedByUser: boolean;
}

export function mirrorLiveTranscript(
  prompt: string,
  previousSuffix: string,
  interim: string,
  ownedByUser: boolean,
): LiveTranscriptMirror {
  const spoken = interim.trim();

  if (!spoken) {
    if (!ownedByUser && previousSuffix && prompt.endsWith(previousSuffix)) {
      return {
        prompt: prompt.slice(0, prompt.length - previousSuffix.length),
        suffix: '',
        ownedByUser: false,
      };
    }
    return { prompt, suffix: '', ownedByUser: false };
  }

  if (ownedByUser) {
    return { prompt, suffix: previousSuffix, ownedByUser: true };
  }

  const prefix =
    previousSuffix && prompt.endsWith(previousSuffix)
      ? prompt.slice(0, prompt.length - previousSuffix.length)
      : previousSuffix
        ? null
        : prompt;

  if (prefix === null) {
    return { prompt, suffix: '', ownedByUser: true };
  }

  const needsSpace = prefix.length > 0 && !/\s$/.test(prefix);
  const suffix = needsSpace ? ` ${spoken}` : spoken;
  return { prompt: prefix + suffix, suffix, ownedByUser: false };
}

/** What the composer textarea shows. Live speech is visual only. */
export function composerTextWithLiveSpeech(
  typedPrompt: string,
  interim: string,
  showLive: boolean,
): string {
  if (!showLive) return typedPrompt;
  return mirrorLiveTranscript(typedPrompt, '', interim, false).prompt;
}

/**
 * Recover the sendable draft from the textarea. Live speech stays out of that
 * draft so Enter and the call controls do not treat it as typed text.
 */
export function typedDraftFromComposer(
  display: string,
  typedPrompt: string,
  interim: string,
  showLive: boolean,
): { typed: string; holdLive: boolean } {
  if (!showLive) return { typed: display, holdLive: false };
  const mirrored = mirrorLiveTranscript(typedPrompt, '', interim, false);
  if (mirrored.suffix && display.endsWith(mirrored.suffix)) {
    return { typed: display.slice(0, display.length - mirrored.suffix.length), holdLive: false };
  }
  return { typed: display, holdLive: true };
}
