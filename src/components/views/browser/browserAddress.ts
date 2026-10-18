/* Address rules and normalization for browser surfaces. */

export const BROWSER_ADDRESS_MAX_LENGTH = 2048;
export const BROWSER_ADDRESS_NOT_ALLOWED = 'That address is not allowed.';

export interface BrowserQuickDestination {
  label: string;
  target: string;
}

export const BROWSER_QUICK_DESTINATIONS: readonly BrowserQuickDestination[] = [
  { label: 'localhost:3000', target: 'http://localhost:3000' },
  { label: 'localhost:3001', target: 'http://localhost:3001' },
  { label: 'kite.dev', target: 'https://kite.dev' },
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

function notAllowed(): never {
  throw new Error(BROWSER_ADDRESS_NOT_ALLOWED);
}

function hasControlCharacter(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function parsePortShorthand(input: string): number | null {
  if (!input.startsWith(':')) return null;
  const digits = input.slice(1);
  if (!/^\d{2,5}$/u.test(digits)) return null;
  const port = Number(digits);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function hostOfFirstSegment(input: string): string {
  const firstSegment = input.split('/', 1)[0] ?? input;
  if (firstSegment.startsWith('[')) {
    return firstSegment.slice(0, firstSegment.indexOf(']') + 1);
  }
  return firstSegment.split(':', 1)[0] ?? firstSegment;
}

function parseLoopbackAddress(input: string): URL | null {
  if (!LOCAL_HOSTS.has(hostOfFirstSegment(input).toLowerCase())) return null;
  try {
    return new URL(`http://${input}`);
  } catch {
    return null;
  }
}

function looksLikeDomain(input: string): boolean {
  const firstSegment = input.split('/', 1)[0] ?? input;
  const host = firstSegment.split(':', 1)[0] ?? firstSegment;
  if (
    input.includes(' ') ||
    !host.includes('.') ||
    host.startsWith('.') ||
    host.endsWith('.') ||
    !/^[a-z0-9.:-]+$/iu.test(firstSegment)
  ) {
    return false;
  }
  const tld = host.slice(host.lastIndexOf('.') + 1);
  return tld.length >= 2 && !/^\d+$/u.test(tld);
}

function finalizeUrl(url: URL): string {
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0
  ) {
    notAllowed();
  }
  const text = url.toString();
  if (text.length > BROWSER_ADDRESS_MAX_LENGTH) notAllowed();
  return text;
}

/** Turns free text into an allowed http(s) URL, or throws BROWSER_ADDRESS_NOT_ALLOWED. */
export function normalizeBrowserAddress(raw: string): string {
  if (raw.length > BROWSER_ADDRESS_MAX_LENGTH || hasControlCharacter(raw)) notAllowed();
  const trimmed = raw.trim();
  if (trimmed.length === 0) notAllowed();

  const port = parsePortShorthand(trimmed);
  if (port !== null) return `http://localhost:${port}/`;

  const loopback = parseLoopbackAddress(trimmed);
  if (loopback !== null) return finalizeUrl(loopback);

  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase();
  let target: string;
  if (scheme === 'http' || scheme === 'https') {
    target = trimmed;
  } else if (looksLikeDomain(trimmed)) {
    target = `https://${trimmed}`;
  } else if (scheme !== undefined) {
    notAllowed();
  } else {
    target = `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }

  try {
    return finalizeUrl(new URL(target));
  } catch {
    return notAllowed();
  }
}

/** Host plus port and path, without the query, fragment, or a leading "www.". */
export function browserAddressLabel(displayUrl: string): string {
  try {
    const url = new URL(displayUrl);
    const host = url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname;
    const port = url.port.length > 0 ? `:${url.port}` : '';
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${host}${port}${path}`;
  } catch {
    return displayUrl;
  }
}
