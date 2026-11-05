/** Pure labels for a running turn. The panes render these strings; tests assert them. */

export interface ActivityItem {
  kind: string;
  text?: string;
  title?: string | null;
  detail?: string | null;
  status?: string | null;
  streaming?: boolean;
  exitCode?: number | null;
  toolName?: string | null;
  toolKind?: string | null;
  serverName?: string | null;
  command?: string | null;
  filePath?: string | null;
  createdAtUnixMs?: number;
  durationSeconds?: number | null;
}

export type ActivityIconKind =
  | 'read'
  | 'edit'
  | 'shell'
  | 'web'
  | 'code-search'
  | 'browser'
  | 'mcp'
  | 'subagent'
  | 'plan'
  | 'reasoning'
  | 'tool';

export type CommandStatusWord = 'Running' | 'Ran' | 'Failed' | 'Declined' | 'Stopped';

export function formatDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.0s';
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

export function workingLine(startedAtUnixMs: number | null | undefined, nowMs: number): string {
  if (typeof startedAtUnixMs !== 'number' || startedAtUnixMs <= 0) return 'Working…';
  const seconds = Math.max(0, (nowMs - startedAtUnixMs) / 1000);
  return `Working for ${formatDurationLabel(seconds)}`;
}

export function turnStartUnixMs(items: ActivityItem[]): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'user' && typeof item.createdAtUnixMs === 'number' && item.createdAtUnixMs > 0) {
      return item.createdAtUnixMs;
    }
  }
  return null;
}

export function workedForLine(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return `Worked for ${formatDurationLabel(seconds)}`;
}

export function interruptedTurnLine(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 'You stopped this response';
  }
  return `You stopped after ${formatDurationLabel(seconds)}`;
}

export function approvalWaitLabel(title?: string | null, toolName?: string | null): string {
  const name = (title || toolName || '').trim();
  return name ? `Waiting for approval · ${name}` : 'Waiting for approval';
}

function trimmed(value: string | null | undefined): string {
  return (value ?? '').trim();
}

export function activityIconKind(item: ActivityItem): ActivityIconKind {
  if (item.kind === 'reasoning') return 'reasoning';
  if (item.kind === 'command' || item.toolKind === 'commandExecution') return 'shell';
  if (item.serverName || item.toolKind === 'mcpToolCall') return 'mcp';
  if (item.toolKind === 'planUpdate') return 'plan';
  const blob = `${item.title ?? ''} ${item.toolName ?? ''} ${item.detail ?? ''}`.toLowerCase();
  if (/(subagent|delegate)/.test(blob)) return 'subagent';
  if (item.toolKind === 'webSearch') return 'web';
  if (/(browser|screenshot|navigate)/.test(blob)) return 'browser';
  if (/(grep|ripgrep|code search|search_code|codesearch)/.test(blob)) return 'code-search';
  if (/(web search|web_search|\bweb\b|\bfetch\b|\burl\b)/.test(blob)) return 'web';
  if (item.toolKind === 'fileChange' || /(edit|write|replace|patch|strreplace|apply_patch)/.test(blob)) {
    return 'edit';
  }
  if (/(^|\b)(read|cat|view|inspect)(\b|$)/.test(blob)) return 'read';
  if (/(bash|shell|terminal|\brun\b)/.test(blob)) return 'shell';
  return 'tool';
}

function isActivity(item: ActivityItem): boolean {
  if (item.kind === 'tool' || item.kind === 'command') return true;
  return item.kind === 'reasoning' && trimmed(item.text).length > 0;
}

function isFailed(item: ActivityItem): boolean {
  if (item.status === 'failed') return true;
  return item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0;
}

/** Brain row only while the turn has no action yet, or beside a failed latest tool. */
export function showThinkingPlaceholder(items: ActivityItem[], pendingApproval: boolean): boolean {
  if (pendingApproval) return false;
  const assistantVisible = items.some(
    (item) => item.kind === 'assistant' && trimmed(item.text).length > 0,
  );
  if (assistantVisible) return false;
  let latest: ActivityItem | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && isActivity(item)) {
      latest = item;
      break;
    }
  }
  if (!latest) return true;
  if (latest.kind === 'reasoning') return false;
  return isFailed(latest);
}

export function commandProgram(item: ActivityItem): string {
  const raw = trimmed(item.command) || trimmed(item.title) || trimmed(item.text);
  const first = raw.split(/\s+/)[0] ?? '';
  const base = first.split(/[/\\]/).pop() ?? first;
  return base || 'command';
}

export function commandStatusWord(item: ActivityItem): CommandStatusWord {
  const outcome = `${item.status ?? ''} ${item.detail ?? ''}`.toLowerCase();
  const live =
    Boolean(item.streaming) ||
    item.status === 'running' ||
    item.status === 'inProgress' ||
    item.status === 'pending';
  if (live) return 'Running';
  if (/\b(declined|denied|rejected)\b/.test(outcome)) return 'Declined';
  if (item.exitCode === 130 || /\b(stopped|cancelled|canceled)\b/.test(outcome)) return 'Stopped';
  if (isFailed(item)) return 'Failed';
  return 'Ran';
}

export function commandStatusLabel(item: ActivityItem): string {
  return `${commandStatusWord(item)} ${commandProgram(item)}`;
}

function fileKey(item: ActivityItem, index: number): string {
  return trimmed(item.filePath) || trimmed(item.detail) || trimmed(item.title) || `item-${index}`;
}

export function summarizeWorkBurst(items: ActivityItem[]): string {
  const reads = new Set<string>();
  const edits = new Set<string>();
  let commands = 0;
  let searches = 0;
  items.forEach((item, index) => {
    const kind = activityIconKind(item);
    if (kind === 'read') reads.add(fileKey(item, index));
    else if (kind === 'edit') edits.add(fileKey(item, index));
    else if (kind === 'shell') commands += 1;
    else if (kind === 'web' || kind === 'code-search' || kind === 'browser') searches += 1;
  });
  const parts: string[] = [];
  if (reads.size === 1) parts.push('Read 1 file');
  else if (reads.size > 1) parts.push(`Read ${reads.size} files`);
  if (edits.size === 1) parts.push('Changed 1 file');
  else if (edits.size > 1) parts.push(`Changed ${edits.size} files`);
  if (commands === 1) parts.push('Ran 1 command');
  else if (commands > 1) parts.push(`Ran ${commands} commands`);
  if (searches === 1) parts.push('Searched 1 time');
  else if (searches > 1) parts.push(`Searched ${searches} times`);
  return parts.join(', ');
}

export function burstDurationSeconds(items: ActivityItem[]): number | null {
  const values = items
    .map((item) => item.durationSeconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}
