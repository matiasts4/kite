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

const TERMINAL_STATUSES = new Set([
  'completed',
  'done',
  'ok',
  'failed',
  'error',
  'killed',
  'cancelled',
  'canceled',
  'stopped',
]);

export function isItemRunning(item: ChatItem, run?: SubagentRun | null): boolean {
  const runStatus = run?.status?.toLowerCase();
  if (runStatus && TERMINAL_STATUSES.has(runStatus)) {
    return false;
  }
  const rawStatus = (runStatus || item.subagentMeta?.status || item.status || 'running').toLowerCase();
  if (TERMINAL_STATUSES.has(rawStatus)) {
    return false;
  }
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

type StructuredPayload = Record<string, unknown> | unknown[];

function parseStructuredPayload(raw?: string | null): StructuredPayload | null {
  const text = (raw ?? '').trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as StructuredPayload) : null;
  } catch {
    return null;
  }
}

function findingsOf(payload: StructuredPayload): Array<Record<string, unknown>> | null {
  if (Array.isArray(payload)) return null;
  const findings = payload.findings;
  if (!Array.isArray(findings)) return null;
  return findings.filter(
    (f): f is Record<string, unknown> => f !== null && typeof f === 'object' && !Array.isArray(f),
  );
}

/**
 * One readable line for activity text that is really a structured payload (for example a
 * verifier's JSON report), so cards and failure banners never show raw JSON.
 */
export function humanizeActivityText(raw?: string | null): string {
  const text = (raw ?? '').trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return text;
  const payload = parseStructuredPayload(text);
  if (!payload) return 'Returned a structured report';
  const findings = findingsOf(payload);
  if (findings) {
    return findings.length === 1 ? 'Reported 1 finding' : `Reported ${findings.length} findings`;
  }
  if (!Array.isArray(payload)) {
    for (const key of ['error', 'message', 'reason']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return 'Returned a structured report';
}

function scalarLine(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
}

/**
 * Markdown for an assistant message whose entire body is a JSON payload: findings reports
 * become a numbered list, any other payload a pretty-printed JSON block. Returns null for
 * ordinary text.
 */
export function structuredReportToMarkdown(raw?: string | null): string | null {
  const payload = parseStructuredPayload(raw);
  if (!payload) return null;
  const findings = findingsOf(payload);
  if (!findings || Array.isArray(payload)) {
    return `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'findings' || value === null || value === undefined) continue;
    lines.push(`**${key}:** ${scalarLine(value)}`, '');
  }
  lines.push(`**Findings (${findings.length})**`, '');
  findings.forEach((finding, index) => {
    const severity = typeof finding.severity === 'string' ? finding.severity.toUpperCase() : '';
    const location = typeof finding.location === 'string' ? finding.location : '';
    const claim = typeof finding.claim === 'string' ? finding.claim.trim() : '';
    const head = [severity && `**${severity}**`, location && `\`${location}\``]
      .filter(Boolean)
      .join(' · ');
    lines.push(`${index + 1}. ${head || 'Finding'}`);
    if (claim) lines.push(`   ${claim}`);
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    for (const entry of evidence) lines.push(`   - ${scalarLine(entry)}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}
