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

const STARTED_THREAD_RE = /started\s+thread:([0-9a-fA-F-]{8,})/i;
const SUBAGENT_THREAD_TAG_RE = /\[subagent_id:\s*thread:([0-9a-fA-F-]{8,})\]/i;
const JSON_ADDRESS_THREAD_RE = /"address"\s*:\s*"thread:([0-9a-fA-F-]{8,})"/i;

export function extractStartedChildThreadId(text?: string | null): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  const match =
    raw.match(STARTED_THREAD_RE) ??
    raw.match(SUBAGENT_THREAD_TAG_RE) ??
    raw.match(JSON_ADDRESS_THREAD_RE);
  return match?.[1]?.trim() || null;
}

/**
 * True when `raw` is a blocking `wait` slice timeout receipt (either raw JSON
 * `{"op":"wait","status":"failed","error":"timeout",...}` or the non-error
 * `"still running after ... wait slice"` guidance text).
 */
export function isWaitTimeoutReceiptText(raw?: string | null): boolean {
  const text = (raw ?? '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.includes('still running after ') && lower.includes('wait slice')) {
    return true;
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const receipt =
        parsed.receipt && typeof parsed.receipt === 'object' && !Array.isArray(parsed.receipt)
          ? (parsed.receipt as Record<string, unknown>)
          : parsed;
      const err = typeof receipt.error === 'string' ? receipt.error.trim().toLowerCase() : '';
      const op = typeof receipt.op === 'string' ? receipt.op.trim().toLowerCase() : '';
      const addr = typeof receipt.address === 'string' ? receipt.address.trim() : '';
      if (err === 'timeout' && (op === 'wait' || addr.startsWith('thread:'))) {
        return true;
      }
    } catch {
      // Ignore non-JSON strings.
    }
  }
  return false;
}

function isHookBlockedText(raw?: string | null): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower.includes('pre-tool hook') ||
    lower.includes('native `invoke_subagent` is blocked') ||
    lower.includes('native invoke_subagent is blocked')
  );
}

function isInvokeSubagentItem(item: ChatItem): boolean {
  const rawTool = (item.toolName ?? '').trim().toLowerCase();
  if (rawTool === 'invoke_subagent' || rawTool.endsWith('__invoke_subagent')) {
    return true;
  }
  const title = (item.title ?? '').trim().toLowerCase();
  return (
    title === 'invoke_subagent' ||
    title === 'run invoke_subagent' ||
    title.startsWith('invoke_subagent ·')
  );
}

/**
 * True for an unspawned `PreToolUse`-blocked native `invoke_subagent` call (0 steps,
 * no backing child thread or transcript, hook-blocked or empty text).
 */
export function isHookBlockedInvokeNoise(item: ChatItem): boolean {
  if (!isInvokeSubagentItem(item)) return false;
  const rawStatus = (item.subagentMeta?.status || item.status || '').toLowerCase();
  if (rawStatus !== 'failed' && rawStatus !== 'error') return false;
  const meta = item.subagentMeta;
  const steps = meta?.stepCount ?? 0;
  const backed = Boolean(meta?.childThreadId || meta?.transcriptUri);
  if (backed || steps > 0) return false;
  return isHookBlockedText(item.text);
}

/**
 * True when a failed subagent item produced zero steps and has no backing child
 * thread or transcript, making it safe to suppress when superseded by a real retry.
 */
export function isZeroStepUnbackedFailedItem(
  item: ChatItem,
  run?: SubagentRun | null,
): boolean {
  if (!isItemFailed(item, run)) return false;
  const steps = Math.max(run?.stepCount ?? 0, item.subagentMeta?.stepCount ?? 0, run?.items?.length ?? 0);
  const backed = Boolean(
    run?.childThreadId ||
      item.subagentMeta?.childThreadId ||
      run?.transcriptUri ||
      item.subagentMeta?.transcriptUri ||
      (run?.items?.length ?? 0) > 0,
  );
  return steps === 0 && !backed;
}

/**
 * Defensive Option 1 noise suppression for subagent timeline items:
 * 1) `PreToolUse` hook-blocked native `invoke_subagent` redirects,
 * 2) 0-step unbacked failed attempts superseded by another non-failed or step-bearing
 *    subagent in the same group/turn.
 */
export function isSuppressedSubagentNoiseItem(
  item: ChatItem,
  siblingItems: readonly ChatItem[],
  run?: SubagentRun | null,
  siblingRuns?: ReadonlyArray<SubagentRun | null>,
): boolean {
  if (isHookBlockedInvokeNoise(item)) return true;
  if (!isZeroStepUnbackedFailedItem(item, run)) return false;
  return siblingItems.some((other, idx) => {
    if (other.id === item.id) return false;
    const otherRun = siblingRuns ? siblingRuns[idx] : null;
    if (!isItemFailed(other, otherRun)) return true;
    const otherSteps = Math.max(
      otherRun?.stepCount ?? 0,
      other.subagentMeta?.stepCount ?? 0,
      otherRun?.items?.length ?? 0,
    );
    return otherSteps > 0;
  });
}

/**
 * Defensive Option 1 noise suppression for `SubagentRun` rows in RightDock overviews.
 */
export function isSuppressedNoiseRun(run: SubagentRun, allRuns: readonly SubagentRun[]): boolean {
  const s = (run.status ?? '').toLowerCase();
  if (s !== 'failed' && s !== 'error') return false;
  const steps = Math.max(run.stepCount ?? 0, run.items?.length ?? 0);
  const backed = Boolean(run.childThreadId || run.transcriptUri || (run.items?.length ?? 0) > 0);
  if (steps === 0 && !backed) {
    const latest = (run.latestActivity ?? '').trim();
    if (latest && isHookBlockedText(latest)) return true;
    if (isWaitTimeoutReceiptText(latest)) {
      return allRuns.some((other) => other.subagentId !== run.subagentId && other.status !== 'failed');
    }
  }
  return false;
}

function isRunBacked(run?: SubagentRun | null): boolean {
  if (!run) return false;
  return Boolean(
    run.childThreadId ||
      run.transcriptUri ||
      (Array.isArray(run.items) && run.items.length > 0),
  );
}

function isRunTerminalStatus(status?: string | null): boolean {
  return TERMINAL_STATUSES.has((status ?? '').trim().toLowerCase());
}

function runProgressScore(run: SubagentRun): number {
  const itemsLen = Array.isArray(run.items) ? run.items.length : 0;
  const stepCount = typeof run.stepCount === 'number' ? run.stepCount : 0;
  const terminalBonus = isRunTerminalStatus(run.status) ? 500 : 0;
  const realCallBonus =
    run.parentToolCallId && !run.parentToolCallId.startsWith('dispatch-subagent-') ? 200 : 0;
  const backedBonus = isRunBacked(run) ? 100 : 0;
  return itemsLen * 1_000_000 + stepCount * 1_000 + terminalBonus + realCallBonus + backedBonus;
}

function mergeDuplicateRunPair(existing: SubagentRun, candidate: SubagentRun): SubagentRun {
  const existingScore = runProgressScore(existing);
  const candidateScore = runProgressScore(candidate);
  const candidateWins =
    candidateScore > existingScore ||
    (candidateScore === existingScore &&
      (candidate.updatedAtUnixMs ?? 0) >= (existing.updatedAtUnixMs ?? 0));
  const winner = candidateWins ? candidate : existing;
  const loser = candidateWins ? existing : candidate;

  const winnerCallId = (winner.parentToolCallId ?? '').trim();
  const loserCallId = (loser.parentToolCallId ?? '').trim();
  const preferredCallId =
    winnerCallId && !winnerCallId.startsWith('dispatch-subagent-')
      ? winnerCallId
      : loserCallId && !loserCallId.startsWith('dispatch-subagent-')
        ? loserCallId
        : winnerCallId || loserCallId || undefined;

  const wStart = typeof winner.startedAtUnixMs === 'number' && winner.startedAtUnixMs > 0 ? winner.startedAtUnixMs : 0;
  const lStart = typeof loser.startedAtUnixMs === 'number' && loser.startedAtUnixMs > 0 ? loser.startedAtUnixMs : 0;
  const earliestStart = wStart > 0 && lStart > 0 ? Math.min(wStart, lStart) : wStart || lStart;

  const settledStatus = isRunTerminalStatus(winner.status)
    ? winner.status
    : isRunTerminalStatus(loser.status)
      ? loser.status
      : winner.status;

  return {
    ...loser,
    ...winner,
    status: settledStatus,
    parentToolCallId: preferredCallId ?? winner.parentToolCallId,
    startedAtUnixMs: earliestStart || winner.startedAtUnixMs,
    completedAtUnixMs: winner.completedAtUnixMs ?? loser.completedAtUnixMs,
    stepCount: Math.max(winner.stepCount ?? 0, loser.stepCount ?? 0),
    items: (winner.items?.length ?? 0) >= (loser.items?.length ?? 0) ? winner.items : loser.items,
  };
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
      const hasConflictingChild = Boolean(
        r.childThreadId && candidate.childThreadId && r.childThreadId !== candidate.childThreadId,
      );
      if (
        !hasConflictingChild &&
        ((r.parentToolCallId && r.parentToolCallId === candidate.subagentId) ||
          (candidate.parentToolCallId && candidate.parentToolCallId === r.subagentId))
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
    } else {
      result[existingIdx] = mergeDuplicateRunPair(result[existingIdx], candidate);
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
  const runStatus = run?.status?.toLowerCase();
  if (runStatus) {
    return (
      runStatus === 'failed' ||
      runStatus === 'error' ||
      runStatus === 'killed' ||
      runStatus === 'cancelled'
    );
  }
  const rawStatus = (item.subagentMeta?.status || item.status || '').toLowerCase();
  if ((rawStatus === 'failed' || rawStatus === 'error') && isWaitTimeoutReceiptText(item.text)) {
    return false;
  }
  return rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'killed' || rawStatus === 'cancelled';
}

export function matchSubagentRun(item: ChatItem, subagentRuns?: SubagentRun[] | null): SubagentRun | null {
  if (!subagentRuns?.length || !item.subagentMeta) return null;
  const receiptCid = extractStartedChildThreadId(item.text);
  if (receiptCid) {
    const byReceipt = subagentRuns.find(
      (r) => r.childThreadId === receiptCid || r.subagentId === receiptCid,
    );
    if (byReceipt) return byReceipt;
  }
  const ctid = item.subagentMeta.childThreadId?.trim();
  const sid = item.subagentMeta.subagentId?.trim();
  if (ctid) {
    const byChild = subagentRuns.find((r) => r.childThreadId === ctid || r.subagentId === ctid);
    if (byChild) return byChild;
  }
  if (sid && sid !== item.id) {
    const bySubId = subagentRuns.find((r) => r.subagentId === sid || r.childThreadId === sid);
    if (bySubId) return bySubId;
  }
  return (
    subagentRuns.find((r) => {
      if (sid && r.subagentId === sid) return true;
      if (r.parentToolCallId === item.id) {
        if (receiptCid && r.childThreadId && r.childThreadId !== receiptCid) return false;
        if (ctid && r.childThreadId && r.childThreadId !== ctid) return false;
        return true;
      }
      return false;
    }) ?? null
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
