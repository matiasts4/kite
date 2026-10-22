import { invokeCommand, isTauriEnvironment } from './ipc';

export type TerminalWebLinksTarget = 'internal' | 'external';

export const TERMINAL_WEB_LINKS_TARGET_STORAGE_KEY = 'kite.terminalWebLinksTarget';
export const TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT = 'kite:terminal-web-links-target-changed';
export const OPEN_RIGHT_DOCK_BROWSER_EVENT = 'kite:open-right-dock-browser';

export interface OpenBrowserInDockRequest {
  url: string;
  workspaceId?: string | null;
}

export interface ExtractedTerminalLink {
  kind: 'web' | 'file';
  text: string;
  start: number;
  end: number;
}

export const WEB_LINK_REGEX = /\b(?:https?:\/\/[^\s"'`<>]+|www\.[^\s"'`<>]+)/gi;
export const FILE_PATH_REGEX = /(?:file:\/\/[^\s"'`<>]+|[a-zA-Z]:[\\/][^\s"'`<>]+|(?:\.{1,2}[\\/]|[a-zA-Z0-9_@.-]+[\\/])[^\s"'`<>]+|[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|mdx|rs|toml|css|scss|html|py|go|ya?ml|sh|bat|cmd|sql|xml|env|log|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|pdf)(?::\d+(?::\d+)?)?)/gi;

export function isWebUrl(text: string): boolean {
  return /^https?:\/\//i.test(text) || /^www\./i.test(text);
}

/**
 * Parses a terminal logical line into distinct web links and file links without collision.
 * Web links take precedence so URLs containing file paths (e.g. https://github.com/a/b.ts)
 * are not falsely matched or fragmented as files.
 */
export function extractTerminalLinks(fullText: string): ExtractedTerminalLink[] {
  if (!fullText || !fullText.trim()) return [];

  const links: ExtractedTerminalLink[] = [];
  const webSpans: Array<{ start: number; end: number }> = [];

  // 1. Extract Web Links first
  WEB_LINK_REGEX.lastIndex = 0;
  let webMatch: RegExpExecArray | null;

  while ((webMatch = WEB_LINK_REGEX.exec(fullText)) !== null) {
    let text = webMatch[0];
    const matchStart = webMatch.index;
    let matchEnd = matchStart + text.length;

    // Strip trailing punctuation while not a query/fragment part
    while (text.length > 0 && /[,.;)>\]}:]+$/.test(text)) {
      text = text.slice(0, -1);
      matchEnd--;
    }

    if (text.length === 0) continue;

    webSpans.push({ start: matchStart, end: matchEnd });
    links.push({
      kind: 'web',
      text,
      start: matchStart,
      end: matchEnd,
    });
  }

  // 2. Extract File Path Links (skipping matches within web links)
  FILE_PATH_REGEX.lastIndex = 0;
  let fileMatch: RegExpExecArray | null;

  while ((fileMatch = FILE_PATH_REGEX.exec(fullText)) !== null) {
    let text = fileMatch[0];
    const matchStart = fileMatch.index;
    let matchEnd = matchStart + text.length;

    while (text.length > 0 && /[,.;)>\]}]$/.test(text)) {
      text = text.slice(0, -1);
      matchEnd--;
    }

    if (text.length === 0) continue;

    // Reject if it is a web URL
    if (isWebUrl(text)) continue;

    // Reject if it overlaps with any already extracted web link
    const overlapsWeb = webSpans.some(
      (span) => Math.max(matchStart, span.start) < Math.min(matchEnd, span.end)
    );
    if (overlapsWeb) continue;

    links.push({
      kind: 'file',
      text,
      start: matchStart,
      end: matchEnd,
    });
  }

  // Sort links by start position
  links.sort((a, b) => a.start - b.start);
  return links;
}

export function getTerminalWebLinksTarget(): TerminalWebLinksTarget {
  try {
    const val = localStorage.getItem(TERMINAL_WEB_LINKS_TARGET_STORAGE_KEY);
    if (val === 'external' || val === 'internal') {
      return val;
    }
  } catch {}
  return 'internal';
}

export function setTerminalWebLinksTarget(target: TerminalWebLinksTarget): void {
  try {
    localStorage.setItem(TERMINAL_WEB_LINKS_TARGET_STORAGE_KEY, target);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT, { detail: target })
      );
    }
  } catch {}
}

export function openExternalLink(url: string): void {
  const trimmed = (url || '').trim();
  if (!trimmed) return;

  if (isTauriEnvironment()) {
    void invokeCommand('open_external_link', { url: trimmed }).catch(() => {
      if (typeof window !== 'undefined') {
        window.open(trimmed, '_blank', 'noopener,noreferrer');
      }
    });
  } else if (typeof window !== 'undefined') {
    window.open(trimmed, '_blank', 'noopener,noreferrer');
  }
}

export function openBrowserInRightDock(req: OpenBrowserInDockRequest): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenBrowserInDockRequest>(OPEN_RIGHT_DOCK_BROWSER_EVENT, {
      detail: req,
    })
  );
}

export function openTerminalWebLink(url: string, workspaceId?: string | null): void {
  const trimmed = (url || '').trim();
  if (!trimmed) return;
  const fullUrl = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;

  const target = getTerminalWebLinksTarget();
  if (target === 'external') {
    openExternalLink(fullUrl);
  } else {
    openBrowserInRightDock({ url: fullUrl, workspaceId });
  }
}
