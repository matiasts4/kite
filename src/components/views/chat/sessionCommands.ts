export const COMPACT_UNSUPPORTED_NOTICE = 'This provider cannot compact.';

export type SessionCommand =
  | { kind: 'compact' }
  | { kind: 'refuse-compact'; notice: typeof COMPACT_UNSUPPORTED_NOTICE }
  | { kind: 'arm-clear'; dropEarlierMessages: false }
  | { kind: 'message' };

function supportsCompact(provider: string): boolean {
  return provider === 'codex' || provider === 'claude';
}

/** Whole trimmed `/compact` or `/clear` only. Anything else stays a normal message. */
export function resolveSessionCommand(text: string, provider: string): SessionCommand {
  const trimmed = text.trim();
  if (trimmed === '/compact') {
    if (supportsCompact(provider)) return { kind: 'compact' };
    return { kind: 'refuse-compact', notice: COMPACT_UNSUPPORTED_NOTICE };
  }
  if (trimmed === '/clear') {
    return { kind: 'arm-clear', dropEarlierMessages: false };
  }
  return { kind: 'message' };
}

/** The next real send consumes the armed flag. It does not remove earlier messages. */
export function consumeFreshContext(armed: boolean): { freshContext: boolean; armed: boolean } {
  if (!armed) return { freshContext: false, armed: false };
  return { freshContext: true, armed: false };
}
