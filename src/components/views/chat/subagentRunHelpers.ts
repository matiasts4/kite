import type { ChatItem, SubagentRun } from '../../../types';

export function extractFailureSummary(text?: string | null): string {
  const raw = (text ?? '').trim();
  if (!raw) return '';
  for (const line of [...raw.split(/\r?\n/)].reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown; reason?: unknown };
        const msg = parsed.error ?? parsed.message ?? parsed.reason;
        if (typeof msg === 'string' && msg.trim()) {
          return msg.trim();
        }
      } catch {
        // Ignore malformed JSON fragments and fall back to plain text.
      }
    }
  }
  return raw;
}

function isRunBacked(run?: SubagentRun | null): boolean {
  if (!run) return false;
  return Boolean(
    run.childThreadId ||
      run.transcriptUri ||
      (Array.isArray(run.items) && run.items.length > 0),
  );
}

function isSubagentItemBacked(item: ChatItem): boolean {
  const meta = item.subagentMeta;
  return Boolean(
    meta?.childThreadId ||
      meta?.transcriptUri ||
      item.id.startsWith('dispatch-subagent-'),
  );
}

/** Merge/deduplicate subagent runs so placeholder and backed records collapse cleanly. */
export function dedupeSubagentRuns(runs?: SubagentRun[] | null): SubagentRun[] {
  if (!runs || runs.length <= 1) return runs ? [...runs] : [];
  const result: SubagentRun[] = [];
  for (const candidate of runs) {
    const candBacked = isRunBacked(candidate);
    const candRole = (candidate.role || '').trim().toLowerCase();
    const candPrompt = (candidate.prompt || '').trim();
    const existingIdx = result.findIndex((r) => {
      if (r.subagentId === candidate.subagentId) return true;
      if (r.childThreadId && candidate.childThreadId && r.childThreadId === candidate.childThreadId) {
        return true;
      }
      if (
        (r.parentToolCallId && r.parentToolCallId === candidate.subagentId) ||
        (candidate.parentToolCallId && candidate.parentToolCallId === r.subagentId)
      ) {
        return true;
      }
      const rBacked = isRunBacked(r);
      if (rBacked !== candBacked) {
        const rRole = (r.role || '').trim().toLowerCase();
        const rPrompt = (r.prompt || '').trim();
        const roleMatch =
          !rRole ||
          !candRole ||
          rRole === candRole ||
          rRole === 'subagent' ||
          candRole === 'subagent';
        const promptMatch = !rPrompt || !candPrompt || rPrompt === candPrompt;
        if (roleMatch && promptMatch && (rRole === candRole || (rPrompt && rPrompt === candPrompt))) {
          return true;
        }
      }
      return false;
    });

    if (existingIdx === -1) {
      result.push(candidate);
    } else if (candBacked && !isRunBacked(result[existingIdx])) {
      result[existingIdx] = {
        ...result[existingIdx],
        ...candidate,
        parentToolCallId: candidate.parentToolCallId ?? result[existingIdx].parentToolCallId,
      };
    }
  }
  return result;
}

/** Deduplicate chat transcript subagent card items by id, child thread, or role+prompt match. */
export function dedupeSubagentItems(items: ChatItem[]): ChatItem[] {
  if (items.length <= 1) return items;
  const result: ChatItem[] = [];
  for (const candidate of items) {
    const candBacked = isSubagentItemBacked(candidate);
    const candMeta = candidate.subagentMeta;
    const candRole = (candMeta?.role || candidate.title || '').trim().toLowerCase();
    const candPrompt = (candMeta?.prompt || '').trim();

    const existingIdx = result.findIndex((existing) => {
      const exMeta = existing.subagentMeta;
      if (existing.id === candidate.id) return true;
      if (exMeta?.subagentId && candMeta?.subagentId && exMeta.subagentId === candMeta.subagentId) {
        return true;
      }
      if (
        exMeta?.childThreadId &&
        candMeta?.childThreadId &&
        exMeta.childThreadId === candMeta.childThreadId
      ) {
        return true;
      }
      const exBacked = isSubagentItemBacked(existing);
      if (exBacked !== candBacked) {
        const exRole = (exMeta?.role || existing.title || '').trim().toLowerCase();
        const exPrompt = (exMeta?.prompt || '').trim();
        const roleMatch =
          !exRole ||
          !candRole ||
          exRole === candRole ||
          exRole === 'subagent' ||
          candRole === 'subagent';
        const promptMatch = !exPrompt || !candPrompt || exPrompt === candPrompt;
        if (roleMatch && promptMatch && (exRole === candRole || (exPrompt && exPrompt === candPrompt))) {
          return true;
        }
      }
      return false;
    });

    if (existingIdx === -1) {
      result.push(candidate);
    } else if (candBacked && !isSubagentItemBacked(result[existingIdx])) {
      const prev = result[existingIdx];
      result[existingIdx] = {
        ...candidate,
        durationSeconds: candidate.durationSeconds ?? prev.durationSeconds,
      };
    } else if (!candBacked && isSubagentItemBacked(result[existingIdx])) {
      const prev = result[existingIdx];
      if (!prev.durationSeconds && candidate.durationSeconds) {
        result[existingIdx] = {
          ...prev,
          durationSeconds: candidate.durationSeconds,
        };
      }
    }
  }
  return result;
}

export function isRawDispatchCommand(text?: string | null): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith('$') ||
    trimmed.includes('kite dispatch ') ||
    trimmed.includes('kite-code dispatch ')
  );
}

/** Strip Markdown syntax into a clean single-line status preview for compact subagent cards. */
export function plainPreviewLine(raw?: string | null): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/```[^`\n]*\n?/g, ' ')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[^\w])[*_]([^*_\r\n]+)[*_](?![\w])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isItemRunning(item: ChatItem, run?: SubagentRun | null): boolean {
  const rawStatus = (run?.status || item.subagentMeta?.status || item.status || 'running').toLowerCase();
  return (
    Boolean(item.streaming) ||
    rawStatus === 'running' ||
    rawStatus === 'inprogress' ||
    rawStatus === 'in_progress' ||
    rawStatus === 'pending'
  );
}

export function isItemBlocked(item: ChatItem, run?: SubagentRun | null): boolean {
  const rawStatus = (run?.status || item.subagentMeta?.status || item.status || '').toLowerCase();
  return rawStatus === 'waiting' || rawStatus === 'needsinput' || rawStatus === 'blocked';
}

export function isItemFailed(item: ChatItem, run?: SubagentRun | null): boolean {
  const rawStatus = (run?.status || item.subagentMeta?.status || item.status || '').toLowerCase();
  return rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'killed' || rawStatus === 'cancelled';
}

export function matchSubagentRun(item: ChatItem, subagentRuns?: SubagentRun[] | null): SubagentRun | null {
  if (!subagentRuns?.length || !item.subagentMeta) return null;
  const sid = item.subagentMeta.subagentId;
  const ctid = item.subagentMeta.childThreadId;
  return (
    subagentRuns.find(
      (r) =>
        (sid && (r.subagentId === sid || r.parentToolCallId === item.id)) ||
        (ctid && r.childThreadId === ctid),
    ) ?? null
  );
}
