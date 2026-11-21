import {
  invokeCommand,
  readWorkspaceDiffFileContents as ipcReadWorkspaceDiffFileContents,
  type WorkspaceDiffFileContents,
} from '../../../lib/ipc';
import type { DiffData } from '../chat/types';

export type { WorkspaceDiffFileContents };

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  oldPath: string | null;
  staged: boolean;
  unstaged: boolean;
}

export interface WorkspaceChanges {
  isRepo: boolean;
  branch: string | null;
  files: GitFileChange[];
  workspacePrefix: string;
  upstream: { ahead: number; behind: number } | null;
}

export const STATUS_LETTERS: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: 'U',
};

export const STATUS_LABELS: Record<GitFileStatus, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
  conflicted: 'Conflicted',
};

export function splitPath(filePath: string): { name: string; directory: string } {
  const normalized = filePath.replace(/\/+$/u, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) {
    return { name: normalized, directory: '' };
  }
  return {
    name: normalized.slice(lastSlash + 1),
    directory: normalized.slice(0, lastSlash),
  };
}

export function formatUpstreamDistance(upstream: { ahead: number; behind: number } | null): string {
  if (!upstream) return '';
  const parts: string[] = [];
  if (upstream.ahead > 0) parts.push(`↑${upstream.ahead}`);
  if (upstream.behind > 0) parts.push(`↓${upstream.behind}`);
  return parts.join(' ');
}

/** Builds a structural signature so callers only bust caches when tracked git state actually changes. */
export function getWorkspaceChangesSignature(changes: WorkspaceChanges | null): string {
  if (!changes) return '';
  return `${changes.isRepo}:${changes.branch ?? ''}:${changes.files
    .map((f) => `${f.path}|${f.status}|${f.oldPath ?? ''}|${f.staged}|${f.unstaged}`)
    .join(',')}`;
}

export interface WorkspaceGitService {
  readWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges>;
  readWorkspaceFileDiff(workspaceId: string, path: string, untracked: boolean): Promise<DiffData>;
  readWorkspaceDiffFileContents?(
    workspaceId: string,
    oldPath?: string | null,
    newPath?: string | null
  ): Promise<WorkspaceDiffFileContents>;
  stageWorkspaceChanges(workspaceId: string, paths: string[]): Promise<WorkspaceChanges>;
  stageAllWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges>;
  unstageWorkspaceChanges(workspaceId: string, paths: string[]): Promise<WorkspaceChanges>;
  discardWorkspaceChanges(workspaceId: string, paths: string[]): Promise<WorkspaceChanges>;
  commitWorkspaceChanges(workspaceId: string, message: string, stageAll: boolean): Promise<WorkspaceChanges>;
  pullWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges>;
  clearCache?(): void;
  pushWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges>;
}

export const MAX_FILE_DIFF_CACHE_ENTRIES = 40;
export const MAX_DIFF_CONTENTS_CACHE_ENTRIES = 24;

function touchLru<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function setLru<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function createWorkspaceGitService(): WorkspaceGitService {
  const fileDiffCache = new Map<string, Promise<DiffData>>();
  const diffFileContentsCache = new Map<string, Promise<WorkspaceDiffFileContents>>();

  const invalidateCache = () => {
    fileDiffCache.clear();
    diffFileContentsCache.clear();
  };

  return {
    clearCache(): void {
      invalidateCache();
    },

    async readWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
      try {
        return await invokeCommand<WorkspaceChanges>('read_workspace_changes', { workspaceId });
      } catch (err: unknown) {
        const msg = String((err as { message?: string })?.message || err || '');
        if (
          msg.includes('not_a_repository') ||
          msg.includes('not a git repository') ||
          msg.includes('Command') ||
          msg.includes('not found') ||
          msg.includes('running in a web browser')
        ) {
          return {
            isRepo: false,
            branch: null,
            files: [],
            workspacePrefix: '',
            upstream: null,
          };
        }
        throw err;
      }
    },

    async readWorkspaceFileDiff(workspaceId: string, path: string, untracked: boolean): Promise<DiffData> {
      const cacheKey = `${workspaceId}:${path}:${untracked}`;
      const existing = touchLru(fileDiffCache, cacheKey);
      if (existing) return existing;

      const promise = invokeCommand<DiffData>('read_workspace_file_diff', {
        workspaceId,
        path,
        untracked,
      }).catch((err) => {
        fileDiffCache.delete(cacheKey);
        throw err;
      });

      setLru(fileDiffCache, cacheKey, promise, MAX_FILE_DIFF_CACHE_ENTRIES);
      return promise;
    },

    async readWorkspaceDiffFileContents(
      workspaceId: string,
      oldPath: string | null = null,
      newPath: string | null = null
    ): Promise<WorkspaceDiffFileContents> {
      const normalizedOld = oldPath || null;
      const normalizedNew = newPath || null;
      const cacheKey = JSON.stringify([workspaceId, normalizedOld, normalizedNew]);
      const existing = touchLru(diffFileContentsCache, cacheKey);
      if (existing) return existing;

      const promise = ipcReadWorkspaceDiffFileContents(
        workspaceId,
        normalizedOld,
        normalizedNew
      ).catch((err) => {
        diffFileContentsCache.delete(cacheKey);
        throw err;
      });

      setLru(diffFileContentsCache, cacheKey, promise, MAX_DIFF_CONTENTS_CACHE_ENTRIES);
      return promise;
    },

    async stageWorkspaceChanges(workspaceId: string, paths: string[]): Promise<WorkspaceChanges> {
      invalidateCache();
      return await invokeCommand<WorkspaceChanges>('stage_workspace_changes', {
        workspaceId,
        paths,
      });
    },

    async stageAllWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
      invalidateCache();
      return await invokeCommand<WorkspaceChanges>('stage_all_workspace_changes', {
        workspaceId,
      });
    },

    async unstageWorkspaceChanges(workspaceId: string, paths: string[]): Promise<WorkspaceChanges> {
      invalidateCache();
      return await invokeCommand<WorkspaceChanges>('unstage_workspace_changes', {
        workspaceId,
        paths,
      });
    },

    async discardWorkspaceChanges(workspaceId: string, paths: string[]): Promise<WorkspaceChanges> {
      invalidateCache();
      return await invokeCommand<WorkspaceChanges>('discard_workspace_changes', {
        workspaceId,
        paths,
      });
    },

    async commitWorkspaceChanges(workspaceId: string, message: string, stageAll: boolean): Promise<WorkspaceChanges> {
      invalidateCache();
      return await invokeCommand<WorkspaceChanges>('commit_workspace_changes', {
        workspaceId,
        message,
        stageAll,
      });
    },

    async pullWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
      invalidateCache();
      return await invokeCommand<WorkspaceChanges>('pull_workspace_changes', {
        workspaceId,
      });
    },

    async pushWorkspaceChanges(workspaceId: string): Promise<WorkspaceChanges> {
      return await invokeCommand<WorkspaceChanges>('push_workspace_changes', {
        workspaceId,
      });
    },
  };
}

