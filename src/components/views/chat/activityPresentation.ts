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
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remain = whole % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remain > 0 || parts.length === 0) parts.push(`${remain}s`);
  return parts.join(' ');
}

export function workingLine(startedAtUnixMs: number | null | undefined, nowMs: number): string {
  if (typeof startedAtUnixMs !== 'number' || startedAtUnixMs <= 0) return 'Working…';
  const seconds = Math.max(0, (nowMs - startedAtUnixMs) / 1000);
  return `Working · ${formatDurationLabel(seconds)}`;
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

function oneLine(value: string | null | undefined): string {
  return trimmed(value).replace(/\s+/g, ' ');
}

const OUTPUT_STAT = /^(\d+)\s+lines?,\s+(\d+)\s+bytes$/i;

function genericAction(value: string): boolean {
  const text = value.trim().toLowerCase().replace(/_/g, ' ');
  return (
    text === '' ||
    text === 'read' ||
    text === 'read file' ||
    text === 'file' ||
    text === 'edit' ||
    text === 'edit file' ||
    text === 'write' ||
    text === 'write file' ||
    text === 'tool' ||
    text === 'tool execution'
  );
}

/** Last few segments, so a long absolute path still names the file. */
export function displayPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const stripped = normalized.replace(/^\/Users\/[^/]+\//, '').replace(/^~\//, '');
  const parts = stripped.split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/');
  return parts.slice(-3).join('/');
}

function firstObject(detail: string): Record<string, unknown> | null {
  const start = detail.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < detail.length; index += 1) {
    const char = detail[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(detail.slice(start, index + 1)) as unknown;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}

function objectString(record: Record<string, unknown>, keys: string[]): string {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(key.toLowerCase()) || typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return '';
}

function detailRecord(item: ActivityItem): Record<string, unknown> | null {
  return firstObject(trimmed(item.detail));
}

/** File path from the tool input, including a capitalized `Path` field. */
export function traceFilePath(item: ActivityItem): string {
  const file = trimmed(item.filePath);
  if (file) return file;
  const record = detailRecord(item);
  if (!record) return '';
  const nested = record.Arguments ?? record.arguments ?? record.input;
  const fromNested =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? objectString(nested as Record<string, unknown>, ['path', 'file_path', 'filepath', 'file', 'target', 'uri'])
      : '';
  return (
    fromNested ||
    objectString(record, ['path', 'filepath', 'file_path', 'file', 'target', 'uri', 'targetfile', 'absolutepath'])
  );
}

function plainTarget(detail: string | null | undefined): string {
  const text = trimmed(detail);
  if (!text || text.includes('\n') || text.startsWith('{') || text.startsWith('diff ') || text.length > 180) {
    return '';
  }
  if (OUTPUT_STAT.test(text)) return '';
  return text;
}

const HINT_KEYS = ['query', 'q', 'pattern', 'search', 'url', 'prompt', 'name', 'key', 'symbol', 'cwd', 'path'];

function argumentHint(item: ActivityItem): string {
  const record = detailRecord(item);
  if (!record) return '';
  const nested = record.Arguments ?? record.arguments ?? record.input ?? record.parameters;
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;
  const raw = objectString(source, HINT_KEYS);
  if (!raw) return '';
  if (/[/\\]/.test(raw) || /^[A-Za-z]:/.test(raw)) {
    const shown = displayPath(raw);
    return shown.split('/').pop() || shown;
  }
  return raw.length > 72 ? `${raw.slice(0, 69)}…` : raw;
}

/** `1 lines, 569 bytes` becomes quiet row meta, not a second sentence. */
export function outputStatLabel(text: string | null | undefined): string | null {
  const match = trimmed(text).match(OUTPUT_STAT);
  if (!match) return null;
  const lines = Number(match[1]);
  const bytes = Number(match[2]);
  const lineLabel = lines === 1 ? '1 line' : `${lines} lines`;
  let size = `${bytes} B`;
  if (bytes >= 1024 * 1024) size = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  else if (bytes >= 1024) size = `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`;
  return `${lineLabel} · ${size}`;
}

/** Markdown, images, and other files the files sidebar can show rendered. */
const RENDERED_FILE = /\.(md|mdx|markdown|png|jpe?g|gif|webp|svg|pdf|html?|ico|bmp|avif|tiff?)$/i;

/** A created or visual file opens in the files sidebar. Source reads and command output stay in the chat. */
export function opensInFilesSidebar(item: ActivityItem): boolean {
  const path = traceFilePath(item);
  if (!path) return false;
  const kind = activityIconKind(item);
  if (kind === 'shell' || kind === 'mcp' || kind === 'web' || kind === 'code-search' || kind === 'plan' || kind === 'reasoning') {
    return false;
  }
  const file = path.split(/[?#]/)[0] ?? path;
  return RENDERED_FILE.test(file);
}

/** Body worth opening. A stat line alone stays on the row as meta. */
export function expandableToolBody(text: string | null | undefined): string {
  const raw = text ?? '';
  if (!trimmed(raw) || outputStatLabel(raw)) return '';
  return raw;
}

/** One secondary sentence for a work row. The expanded body keeps the raw output. */
export function activityTraceLabel(item: ActivityItem): string {
  if (item.kind === 'reasoning') {
    const line = oneLine(item.text);
    if (line) return line;
    const live =
      Boolean(item.streaming) || item.status === 'running' || item.status === 'inProgress';
    return live ? 'Thinking' : 'Thought';
  }

  const kind = activityIconKind(item);
  if (kind === 'shell' || item.kind === 'command') return commandStatusLabel(item);

  const storedPath = traceFilePath(item);
  const plain = plainTarget(item.detail);
  const hint = argumentHint(item);
  if (kind === 'read') {
    const fromTitle = oneLine(item.title).replace(/^read\s+/i, '');
    const path =
      storedPath ||
      plain ||
      (fromTitle && !genericAction(fromTitle) ? fromTitle : '');
    return path ? `Read ${displayPath(path)}` : 'Read file';
  }
  if (kind === 'edit') {
    const path = storedPath || plain;
    return path ? displayPath(path) : 'Changed files';
  }
  if (kind === 'web') {
    const query = hint || plain || (genericAction(oneLine(item.title)) ? '' : oneLine(item.title));
    return query ? `Searched ${query}` : 'Searched the web';
  }
  if (kind === 'code-search') {
    const query = hint || plain || (genericAction(oneLine(item.title)) ? '' : oneLine(item.title));
    return query ? `Searched ${query}` : 'Searched files';
  }
  if (kind === 'browser') {
    const where = storedPath ? displayPath(storedPath) : plain || hint || oneLine(item.title);
    return where ? `Browser ${where}` : 'Used browser';
  }

  const title = oneLine(item.title) || oneLine(item.toolName);
  if (title && hint && !title.includes(hint)) return `${title} ${hint}`;
  if (title && storedPath && !title.includes(displayPath(storedPath))) {
    return `${title} ${displayPath(storedPath)}`;
  }
  return title || storedPath || plain || 'Tool';
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
