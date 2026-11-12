export interface DiffPreviewRequest {
  workspaceId?: string | null;
  workspaceName?: string | null;
  focusPaths?: string[];
  selectedPath?: string | null;
  viewMode?: 'focused' | 'stream';
}

export const OPEN_RIGHT_DOCK_DIFFS_EVENT = 'kite:open-right-dock-diffs';
export const OPEN_DIFFS_EVENT = 'kite:open-diffs';

let pendingDiffRequest: DiffPreviewRequest | null = null;

export function openDiffsInRightDock(req: DiffPreviewRequest = {}) {
  pendingDiffRequest = { ...req };

  window.dispatchEvent(
    new CustomEvent<DiffPreviewRequest>(OPEN_RIGHT_DOCK_DIFFS_EVENT, {
      detail: pendingDiffRequest,
    })
  );
  window.dispatchEvent(
    new CustomEvent<DiffPreviewRequest>(OPEN_DIFFS_EVENT, {
      detail: pendingDiffRequest,
    })
  );
}

export function consumePendingDiffPreview(): DiffPreviewRequest | null {
  const req = pendingDiffRequest;
  pendingDiffRequest = null;
  return req;
}

export function peekPendingDiffPreview(): DiffPreviewRequest | null {
  return pendingDiffRequest;
}

function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^file:\/\//i, '')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^\.\//, '');
}

/**
 * Strips the host filesystem prefix before `workspaceName` (or falls back to
 * repo anchor segments) so workspace-relative paths stay concise.
 */
export function stripWorkspacePathPrefix(filePath: string, workspaceName?: string | null): string {
  const normalized = normalizePath(filePath);
  if (!normalized) return '';
  if (!/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith('/')) {
    return normalized;
  }

  const parts = normalized.split('/').filter(Boolean);
  const cleanWs = workspaceName?.trim().toLowerCase();
  if (cleanWs) {
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      if (parts[i].toLowerCase() === cleanWs) {
        return parts.slice(i + 1).join('/');
      }
    }
  }

  const anchors = new Set(['src', 'src-tauri', 'crates', 'packages', 'apps', 'odd', 'docs', 'tests']);
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    if (anchors.has(parts[i])) {
      return parts.slice(i).join('/');
    }
  }

  return parts[parts.length - 1] || normalized;
}

/**
 * Maps absolute or relative turn file paths onto exact `GitFileChange.path` entries
 * in the open workspace repository.
 */
export function resolveRepoDiffPaths(
  candidates: string[],
  repoPaths: string[],
  workspaceName?: string | null,
  workspacePrefix?: string | null
): string[] {
  if (candidates.length === 0 || repoPaths.length === 0) return [];
  const normRepo = repoPaths.map((p) => ({
    raw: p,
    norm: normalizePath(p),
    lower: normalizePath(p).toLowerCase(),
  }));
  const cleanPrefix = workspacePrefix ? normalizePath(workspacePrefix).replace(/^\//, '') : '';
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const rawCandidate of candidates) {
    const relFromWs = stripWorkspacePathPrefix(rawCandidate, workspaceName);
    const fullNorm = normalizePath(rawCandidate);
    const tryList = [relFromWs, fullNorm].filter(Boolean);

    let bestMatch: { raw: string; score: number } | null = null;
    for (const entry of normRepo) {
      for (const candidate of tryList) {
        const candLower = candidate.toLowerCase();
        const repoVariants = cleanPrefix
          ? [entry.lower, `${cleanPrefix.toLowerCase()}/${entry.lower}`]
          : [entry.lower];

        for (const repoVariant of repoVariants) {
          if (candLower === repoVariant) {
            const score = 10_000 + repoVariant.length;
            if (!bestMatch || score > bestMatch.score) {
              bestMatch = { raw: entry.raw, score };
            }
          } else if (candLower.endsWith(`/${repoVariant}`)) {
            const score = repoVariant.length;
            if (!bestMatch || score > bestMatch.score) {
              bestMatch = { raw: entry.raw, score };
            }
          }
        }
      }
    }

    if (bestMatch && !seen.has(bestMatch.raw)) {
      seen.add(bestMatch.raw);
      resolved.push(bestMatch.raw);
    }
  }

  return resolved;
}
