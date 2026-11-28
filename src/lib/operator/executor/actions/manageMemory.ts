// Kite Code — Explicit Memory & Knowledge Control (`manage_memory`)
// Non-destructive workspace-scoped & global note persistence over `loadArgosMemoryNotes` /
// `saveArgosMemoryNotes` plus read-only episodic recall via `loadWorkspaceEpisodicMemory`.

import type { ActionReceipt, ManageMemoryAction, TurnContext } from '../../contract';
import { loadWorkspaceEpisodicMemory } from '../../context/episodicMemory';
import {
  loadArgosMemoryNotes,
  saveArgosMemoryNotes,
  type ArgosMemoryNote,
} from '../../operatorConfig';

function normalizeComparisonKey(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesScope(
  note: ArgosMemoryNote,
  scope: 'workspace' | 'global',
  workspaceId?: string
): boolean {
  if (scope === 'global') {
    return !note.workspace;
  }
  // Workspace scope includes notes for the current workspace and global (unscoped) notes
  if (!workspaceId) return !note.workspace;
  return !note.workspace || note.workspace === workspaceId;
}

function isExactScopeTarget(
  note: ArgosMemoryNote,
  scope: 'workspace' | 'global',
  workspaceId?: string
): boolean {
  if (scope === 'global') return !note.workspace;
  return workspaceId ? note.workspace === workspaceId : !note.workspace;
}

export async function executeManageMemoryAction(
  action: ManageMemoryAction,
  actionIdx: number = 0,
  context?: TurnContext
): Promise<ActionReceipt> {
  const scope = action.scope ?? (context?.workspaceId ? 'workspace' : 'global');
  const workspaceId = context?.workspaceId?.trim() || undefined;

  if (action.operation === 'remember') {
    const rawText = (action.text || '').trim();
    if (!rawText) {
      return {
        actionIdx,
        type: 'manage_memory',
        ok: false,
        summaryEs: 'Necesito el texto de la nota que querés recordar.',
        spokenSummaryEs: 'Decime qué querés que recuerde para este proyecto.',
        error: 'missing_memory_text',
      };
    }

    const existing = loadArgosMemoryNotes();
    const targetKey = normalizeComparisonKey(rawText);
    const duplicate = existing.find(
      (n) =>
        isExactScopeTarget(n, scope, workspaceId) &&
        normalizeComparisonKey(n.content) === targetKey
    );

    if (duplicate) {
      const spoken = `Ya tenía esa nota guardada: "${duplicate.content}".`;
      return {
        actionIdx,
        type: 'manage_memory',
        ok: true,
        summaryEs: spoken,
        spokenSummaryEs: spoken,
        data: {
          operation: 'remember',
          deduplicated: true,
          note: duplicate,
          totalNotes: existing.length,
        },
      };
    }

    const created: ArgosMemoryNote = {
      id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      content: rawText,
      createdAt: new Date().toISOString(),
      ...(scope === 'workspace' && workspaceId ? { workspace: workspaceId } : {}),
    };

    const next = [created, ...existing];
    saveArgosMemoryNotes(next);

    const scopeLabel = scope === 'workspace' && workspaceId ? 'este workspace' : 'memoria global';
    const spoken = `Guardé en ${scopeLabel}: "${rawText}".`;
    return {
      actionIdx,
      type: 'manage_memory',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: {
        operation: 'remember',
        deduplicated: false,
        note: created,
        totalNotes: next.length,
      },
    };
  }

  if (action.operation === 'search') {
    const query = (action.query || action.text || '').trim();
    const qNorm = normalizeComparisonKey(query);
    const allNotes = loadArgosMemoryNotes();
    const scopedNotes = allNotes.filter((n) => matchesScope(n, scope, workspaceId));
    const matchedNotes = qNorm
      ? scopedNotes.filter((n) => normalizeComparisonKey(n.content).includes(qNorm))
      : scopedNotes;

    const episodic = await loadWorkspaceEpisodicMemory(workspaceId);
    const episodicMatches = qNorm
      ? [
          ...episodic.delegations
            .filter(
              (d) =>
                normalizeComparisonKey(d.name).includes(qNorm) ||
                normalizeComparisonKey(d.taskSummary).includes(qNorm)
            )
            .map((d) => `${d.name}: ${d.taskSummary}`),
          ...episodic.sessions
            .filter((s) => normalizeComparisonKey(s.summary).includes(qNorm))
            .map((s) => s.summary),
        ]
      : [];

    const total = matchedNotes.length + episodicMatches.length;
    const spoken =
      total === 0
        ? query
          ? `No encontré recuerdos guardados sobre "${query}".`
          : 'No hay notas guardadas en este alcance todavía.'
        : `Encontré ${total} recuerdo${total === 1 ? '' : 's'}${query ? ` sobre "${query}"` : ''}: ${matchedNotes
            .slice(0, 3)
            .map((n) => n.content)
            .concat(episodicMatches.slice(0, 2))
            .join(' | ')}.`;

    return {
      actionIdx,
      type: 'manage_memory',
      ok: true,
      summaryEs: spoken,
      spokenSummaryEs: spoken,
      data: {
        operation: 'search',
        scope,
        count: total,
        notes: matchedNotes,
        episodicMatches,
      },
    };
  }

  // `forget`
  const query = (action.query || action.text || '').trim();
  if (!query) {
    return {
      actionIdx,
      type: 'manage_memory',
      ok: false,
      summaryEs: 'Necesito saber qué nota querés olvidar.',
      spokenSummaryEs: 'Decime qué nota querés que borre de memoria.',
      error: 'missing_forget_query',
    };
  }

  const qNorm = normalizeComparisonKey(query);
  const allNotes = loadArgosMemoryNotes();
  const kept: ArgosMemoryNote[] = [];
  const removed: ArgosMemoryNote[] = [];

  for (const note of allNotes) {
    if (
      isExactScopeTarget(note, scope, workspaceId) &&
      normalizeComparisonKey(note.content).includes(qNorm)
    ) {
      removed.push(note);
    } else {
      kept.push(note);
    }
  }

  if (removed.length > 0) {
    saveArgosMemoryNotes(kept);
  }

  const spoken =
    removed.length === 0
      ? `No encontré notas que coincidan con "${query}" para olvidar.`
      : `Olvidé ${removed.length} nota${removed.length === 1 ? '' : 's'} sobre "${query}".`;

  return {
    actionIdx,
    type: 'manage_memory',
    ok: true,
    summaryEs: spoken,
    spokenSummaryEs: spoken,
    data: {
      operation: 'forget',
      scope,
      removedCount: removed.length,
      removedIds: removed.map((r) => r.id),
      remainingCount: kept.length,
    },
  };
}
