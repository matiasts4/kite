import type { SidecarStatusSnapshot } from './ipc/pluginRuntime';

export interface OpenRightDockSidecarDetail {
  sidecarId: string;
  viewPath?: string;
  title?: string;
  workspaceId?: string | null;
}

export interface ParsedSidecarUri {
  sidecarId: string;
  viewPath: string;
}

export type KnownSidecarRef = Pick<SidecarStatusSnapshot, 'namespacedId' | 'sidecarId'>;

export const OPEN_RIGHT_DOCK_SIDECAR_EVENT = 'kite:open-right-dock-sidecar';

let pendingSidecarRequest: OpenRightDockSidecarDetail | null = null;
let knownSidecarsCache: KnownSidecarRef[] = [];

export function registerKnownSidecars(sidecars: KnownSidecarRef[]): void {
  knownSidecarsCache = sidecars.map((s) => ({
    namespacedId: s.namespacedId,
    sidecarId: s.sidecarId,
  }));
}

export function clearKnownSidecars(): void {
  knownSidecarsCache = [];
}

function normalizeViewPath(subSegments: string[], queryPart: string, hashPart: string): string {
  const base = subSegments.length > 0 ? `/${subSegments.join('/')}` : '/';
  return `${base}${queryPart}${hashPart}`;
}

/**
 * Parses `sidecar://<plugin>/<sidecar>/<view-path>` or `sidecar://<sidecar-id>/<view-path>`
 * into `{ sidecarId, viewPath }` with a normalized leading `/` and preserved query/hash params.
 */
export function parseSidecarUri(
  href: string,
  knownSidecars?: KnownSidecarRef[],
): ParsedSidecarUri | null {
  const trimmed = href.trim();
  if (!/^sidecar:\/\//i.test(trimmed)) return null;

  const rawRest = trimmed.replace(/^sidecar:\/+/i, '');
  if (!rawRest) return null;

  const hashIdx = rawRest.indexOf('#');
  const hashPart = hashIdx >= 0 ? rawRest.slice(hashIdx) : '';
  const beforeHash = hashIdx >= 0 ? rawRest.slice(0, hashIdx) : rawRest;

  const queryIdx = beforeHash.indexOf('?');
  const queryPart = queryIdx >= 0 ? beforeHash.slice(queryIdx) : '';
  const pathPart = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;

  const hasTrailingSlash = pathPart.endsWith('/');
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  if (segments.length === 1) {
    return {
      sidecarId: segments[0],
      viewPath: normalizeViewPath([], queryPart, hashPart),
    };
  }

  const catalog = knownSidecars ?? knownSidecarsCache;
  const pair = `${segments[0]}/${segments[1]}`;
  const pairLower = pair.toLowerCase();
  const firstLower = segments[0].toLowerCase();

  if (catalog.some((s) => s.namespacedId.toLowerCase() === pairLower)) {
    return {
      sidecarId: pair,
      viewPath: normalizeViewPath(segments.slice(2), queryPart, hashPart),
    };
  }

  if (catalog.some((s) => s.sidecarId.toLowerCase() === firstLower)) {
    return {
      sidecarId: segments[0],
      viewPath: normalizeViewPath(segments.slice(1), queryPart, hashPart),
    };
  }

  if (segments.length >= 3) {
    return {
      sidecarId: pair,
      viewPath: normalizeViewPath(segments.slice(2), queryPart, hashPart),
    };
  }

  // Two segments without a known catalog match:
  // A trailing slash (`sidecar://plugin/sidecar/?view=auxpane`) denotes `<plugin>/<sidecar>`,
  // whereas a file extension in segment 2 (`sidecar://sidecar-id/index.html`) denotes `<sidecar-id>/<view-path>`.
  if (!hasTrailingSlash && /\.[a-z0-9]{1,8}$/i.test(segments[1])) {
    return {
      sidecarId: segments[0],
      viewPath: normalizeViewPath([segments[1]], queryPart, hashPart),
    };
  }

  return {
    sidecarId: pair,
    viewPath: normalizeViewPath([], queryPart, hashPart),
  };
}

export function openSidecarInRightDock(detail: OpenRightDockSidecarDetail): void {
  pendingSidecarRequest = { ...detail };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<OpenRightDockSidecarDetail>(OPEN_RIGHT_DOCK_SIDECAR_EVENT, {
        detail: pendingSidecarRequest,
      }),
    );
  }
}

export function consumePendingSidecarRequest(): OpenRightDockSidecarDetail | null {
  const req = pendingSidecarRequest;
  pendingSidecarRequest = null;
  return req;
}

export function peekPendingSidecarRequest(): OpenRightDockSidecarDetail | null {
  return pendingSidecarRequest;
}
