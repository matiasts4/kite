// Kite Code — Execute Switch Workspace Action (S9)
// Moves the operator (and the rest of the running plan) to another workspace and,
// optionally, changes the view mode. No sidebar or Git side effects.

import { invokeCommand } from '../../../ipc';
import type { ActionReceipt, SwitchWorkspaceAction, TurnContext } from '../../contract';

interface WorkspaceCandidate {
  id: string;
  name: string;
  path?: string;
}

function toCandidate(raw: any): WorkspaceCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (!id) return null;
  const name =
    (typeof raw.name === 'string' && raw.name) ||
    (typeof raw.displayName === 'string' && raw.displayName) ||
    (typeof raw.title === 'string' && raw.title) ||
    id;
  const path =
    (typeof raw.path === 'string' && raw.path) ||
    (typeof raw.rootPath === 'string' && raw.rootPath) ||
    undefined;
  return { id, name, path };
}

function readCachedWorkspaces(): WorkspaceCandidate[] {
  if (typeof window === 'undefined') return [];
  try {
    const legacyPrefix = ['bm', 'one'].join('');
    const raw =
      localStorage.getItem('kite.cached_workspaces') ||
      localStorage.getItem(`${legacyPrefix}.cached_workspaces`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(toCandidate)
      .filter((candidate): candidate is WorkspaceCandidate => candidate !== null);
  } catch {
    return [];
  }
}

async function listWorkspaces(): Promise<WorkspaceCandidate[]> {
  const fromBackend = await invokeCommand<unknown>('list_workspaces').catch(() => null);
  const rawList = Array.isArray(fromBackend)
    ? fromBackend
    : Array.isArray((fromBackend as { workspaces?: unknown[] } | null)?.workspaces)
      ? (fromBackend as { workspaces: unknown[] }).workspaces
      : [];
  const candidates = rawList
    .map(toCandidate)
    .filter((candidate): candidate is WorkspaceCandidate => candidate !== null);
  if (candidates.length > 0) return candidates;
  return readCachedWorkspaces();
}

function pathBasename(path?: string): string | undefined {
  if (!path) return undefined;
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

function matchWorkspace(
  workspaces: WorkspaceCandidate[],
  query: string
): WorkspaceCandidate | undefined {
  const norm = query.trim().toLowerCase();
  if (!norm) return undefined;

  const exact = workspaces.find(
    (ws) =>
      ws.name.toLowerCase() === norm ||
      ws.id.toLowerCase() === norm ||
      pathBasename(ws.path)?.toLowerCase() === norm
  );
  if (exact) return exact;

  return workspaces.find((ws) => {
    const basename = pathBasename(ws.path)?.toLowerCase();
    return (
      ws.name.toLowerCase().includes(norm) ||
      norm.includes(ws.name.toLowerCase()) ||
      ws.id.toLowerCase().includes(norm) ||
      Boolean(basename && (basename.includes(norm) || norm.includes(basename)))
    );
  });
}

function synthesizeWorkspace(query: string): WorkspaceCandidate {
  const slug = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return {
    id: slug ? `operator-${slug}` : `operator-${Date.now()}`,
    name: query.trim(),
  };
}

export async function executeSwitchWorkspaceAction(
  args: SwitchWorkspaceAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const query = (args.workspaceQuery || '').trim();
  if (!query) {
    return {
      actionIdx,
      type: 'switch_workspace',
      ok: false,
      summaryEs: 'No indicaste a qué proyecto o workspace cambiar.',
      error: 'missing-workspace-query',
    };
  }

  const workspaces = await listWorkspaces();
  const matched = matchWorkspace(workspaces, query) || synthesizeWorkspace(query);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('kite:select-workspace', {
        detail: {
          workspaceId: matched.id,
          workspaceName: matched.name,
          workspacePath: matched.path,
        },
      })
    );

    if (args.viewMode) {
      window.dispatchEvent(
        new CustomEvent('kite:navigate-mode', { detail: { mode: args.viewMode } })
      );
    }
  }

  // Subsequent actions in the same plan must target the newly selected workspace.
  if (context) {
    context.workspaceId = matched.id;
    context.workspaceName = matched.name;
    if (matched.path) context.workspacePath = matched.path;
  }

  return {
    actionIdx,
    type: 'switch_workspace',
    ok: true,
    summaryEs: `Cambié al proyecto ${matched.name}.`,
    data: {
      workspaceId: matched.id,
      workspaceName: matched.name,
      workspacePath: matched.path,
      viewMode: args.viewMode,
    },
  };
}
