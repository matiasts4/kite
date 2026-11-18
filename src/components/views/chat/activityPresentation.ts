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
  query?: string | null;
  createdAtUnixMs?: number;
  durationSeconds?: number | null;
  subagentMeta?: {
    role?: string | null;
    status?: string | null;
  } | null;
  swarmMeta?: {
    swarmTitle?: string | null;
    action?: string | null;
    memberNames?: string[] | null;
  } | null;
}

export interface ActivitySwarmSummary {
  title?: string | null;
  workingCount?: number | null;
  members?: Array<{ name?: string | null; state?: string | null }> | null;
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
  return workingForLine(startedAtUnixMs, nowMs);
}

/** `Working · 12s`, `Working · 2m 5s`, or `Working…` when the turn has no start. */
export function formatWorkingClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return `${minutes}m ${remain}s`;
}

export function workingForLine(startedAtUnixMs: number | null | undefined, nowMs: number): string {
  if (typeof startedAtUnixMs !== 'number' || startedAtUnixMs <= 0) return 'Working…';
  const seconds = Math.max(0, (nowMs - startedAtUnixMs) / 1000);
  return `Working · ${formatWorkingClock(seconds)}`;
}

export function compactingForLine(startedAtUnixMs: number | null | undefined, nowMs: number): string {
  if (typeof startedAtUnixMs !== 'number' || startedAtUnixMs <= 0) return 'Compacting…';
  const seconds = Math.max(0, (nowMs - startedAtUnixMs) / 1000);
  return `Compacting · ${formatWorkingClock(seconds)}`;
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
  if (
    item.kind === 'command' ||
    item.toolKind === 'commandExecution' ||
    item.toolKind === 'execute'
  ) {
    return 'shell';
  }
  if (
    item.serverName ||
    item.toolKind === 'mcpToolCall' ||
    mcpToolLabel(item.serverName, trimmed(item.title) || trimmed(item.toolName)) !== null
  ) {
    return 'mcp';
  }
  if (item.toolKind === 'planUpdate') return 'plan';
  if (
    item.toolKind === 'subagent' ||
    item.toolKind === 'swarm' ||
    Boolean(item.subagentMeta) ||
    Boolean(item.swarmMeta)
  ) {
    return 'subagent';
  }
  const titleLower = trimmed(item.title).toLowerCase();
  const toolLower = trimmed(item.toolName).toLowerCase();
  const blob = `${titleLower} ${toolLower} ${(item.detail ?? '').toLowerCase()}`;
  if (/(subagent|delegate)/.test(blob)) return 'subagent';
  if (item.toolKind === 'webSearch' || item.toolKind === 'fetch') return 'web';
  if (/(?:web[\s_]?search|web[\s_]?fetch)/.test(`${titleLower} ${toolLower}`)) return 'web';
  if (item.toolKind === 'search') return 'code-search';
  if (
    item.toolKind === 'fileChange' ||
    item.toolKind === 'edit' ||
    item.toolKind === 'delete' ||
    item.toolKind === 'move'
  ) {
    return 'edit';
  }
  if (item.toolKind === 'read') return 'read';
  if (/(browser|screenshot|navigate)/.test(blob)) return 'browser';
  if (/^(?:edit|write|changed|replace|patch)\b/.test(titleLower) || /(edit|write|replace|patch|strreplace|apply_patch)/.test(toolLower)) {
    return 'edit';
  }
  if (/^(?:read|view|analyz\w*|inspect|list)\b/.test(titleLower) || /(?:read|view|inspect|cat|list_dir)/.test(toolLower)) {
    return 'read';
  }
  if (/^(?:search|searched|grep|find|glob)\b/.test(titleLower) || /(?:grep|ripgrep|search|find|glob)/.test(toolLower)) {
    return 'code-search';
  }
  if (
    searchPatternLike(trimmed(item.title)) ||
    /(^|\b)(grep|ripgrep|code search|search_code|codesearch|searched|search|find)(\b|$)/.test(blob)
  ) {
    return 'code-search';
  }
  if (/(web search|web_search|\bweb\b|\bfetch\b|\burl\b)/.test(blob)) return 'web';
  if (/(edit|write|replace|patch|strreplace|apply_patch)/.test(blob)) {
    return 'edit';
  }
  if (/(^|\b)(read|cat|view|inspect|list_dir|analyz\w*)(\b|$)/.test(blob)) {
    return 'read';
  }
  if (/(^|\b)(bash|shell|terminal|execute|executed|run)(\b|$)/.test(blob) || /(?:bash|shell|terminal|exec|run)/.test(toolLower)) {
    return 'shell';
  }
  return 'tool';
}

function isFailed(item: ActivityItem): boolean {
  if (item.status === 'failed') return true;
  return item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0;
}

/**
 * What the running turn is doing right now, for the live caption. Null until the
 * provider has actually sent something this turn, so nothing is claimed early.
 */
export function liveStageLabel(
  items: ActivityItem[],
  swarmState?: ActivitySwarmSummary | null
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.kind === 'user') return null;
    if (item.kind === 'assistant') {
      if (item.streaming && trimmed(item.text).length > 0) return 'Writing';
      continue;
    }
    if (item.kind === 'reasoning') {
      if (trimmed(item.text).length > 0) return 'Thinking';
      continue;
    }
    if (item.kind === 'tool' || item.kind === 'command') {
      if (item.toolKind === 'subagent' || item.subagentMeta) {
        const role = trimmed(item.subagentMeta?.role) || trimmed(item.title) || 'Worker';
        return `Subagent: ${role}`;
      }
      if (item.toolKind === 'swarm' || item.swarmMeta) {
        const workingCount = (swarmState?.members ?? []).filter((m) => m.state === 'working').length;
        if (workingCount > 0) return `Swarm: ${workingCount} working`;
        const hinted = item.swarmMeta?.memberNames?.length ?? 0;
        if (hinted > 0) return `Swarm: ${hinted} working`;
        return `Swarm: ${trimmed(swarmState?.title) || trimmed(item.swarmMeta?.swarmTitle) || 'active'}`;
      }
      return activityTraceLabel(item);
    }
  }
  return null;
}

export function commandProgram(item: ActivityItem): string {
  const raw = (trimmed(item.command) || trimmed(item.title) || trimmed(item.text))
    .replace(/^(?:execute|executed|ran|running)\s+/i, '')
    .replace(/^`+|`+$/g, '')
    .trim();
  const first = raw.split(/\s+/)[0] ?? '';
  const base = first.split(/[/\\]/).pop() ?? first;
  return base.replace(/^`+|`+$/g, '') || 'command';
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

/** Extracts a clean, markdown-free single-line headline from reasoning text. */
export function liveThoughtLine(markdown?: string | null): string {
  if (!markdown) return '';
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/`+|\*\*|~~/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

const OUTPUT_STAT = /^(\d+)\s+lines?,\s+(\d+)\s+bytes$/i;

/** Regex alternation or anchors where a tool name should be: a search pattern, not a name. */
function searchPatternLike(value: string): boolean {
  return value.includes('|') || value.startsWith('^');
}

/** `codegraph__codegraph_explore` reads `codegraph · explore`; null when it is not an MCP name. */
function mcpToolLabel(serverName: string | null | undefined, title: string): string | null {
  const match = /^(?:mcp__)?([a-z0-9-]+)__([a-z0-9_.-]+)$/i.exec(title);
  if (!match && title.includes(' · ')) return title;
  const server = trimmed(serverName) || match?.[1] || '';
  if (!server) return null;
  const rawTool = match ? match[2] : title;
  if (!rawTool) return null;
  const tool = rawTool
    .replace(new RegExp(`^${server.replace(/[^a-z0-9]/gi, '_')}_`, 'i'), '')
    .replace(/_/g, ' ')
    .trim();
  return tool ? `${server} · ${tool}` : null;
}

const LABEL_VERBS = /^(Read|Ran|Running|Failed|Declined|Stopped|Searched|Execute|Browser)\s+(.+)$/;

/**
 * Splits a trace label into a leading verb and its target so rows can show the
 * target in a quieter monospace style. Labels without a known verb stay whole.
 */
export function splitTraceLabel(label: string): { verb: string | null; target: string } {
  const server = /^([a-z0-9-]+) · (.+)$/i.exec(label);
  if (server) return { verb: server[1], target: server[2] };
  const match = LABEL_VERBS.exec(label);
  if (!match) return { verb: null, target: label };
  const target = match[2].replace(/^`(.*)`$/, '$1');
  return { verb: match[1], target };
}

function genericAction(value: string): boolean {
  const text = value.trim().toLowerCase().replace(/_/g, ' ');
  return (
    text === '' ||
    text === 'read' ||
    text === 'read file' ||
    text === 'view file' ||
    text === 'view' ||
    text === 'analyze' ||
    text === 'analyzed' ||
    text === 'file' ||
    text === 'edit' ||
    text === 'edit file' ||
    text === 'write' ||
    text === 'write file' ||
    text === 'tool' ||
    text === 'tool execution'
  );
}

/** Last path segment for compact single-line live headlines. */
export function basenamePath(filePath: string): string {
  const withoutQuery = filePath.split(/[?#]/)[0] ?? filePath;
  const normalized = withoutQuery.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || displayPath(filePath);
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

function objectPositiveInt(record: Record<string, unknown>, keys: string[]): number | null {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(key.toLowerCase())) continue;
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : NaN;
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function detailRecord(item: ActivityItem): Record<string, unknown> | null {
  return firstObject(trimmed(item.detail));
}

/** Line range badge (`#L1-250` or `#L1`) from tool arguments when available. */
export function traceLineRangeLabel(item: ActivityItem): string | null {
  const record = detailRecord(item);
  if (!record) return null;
  const nested = record.Arguments ?? record.arguments ?? record.input ?? record.parameters;
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;
  const start = objectPositiveInt(source, ['startline', 'start_line']) ?? objectPositiveInt(record, ['startline', 'start_line']);
  if (!start) return null;
  const end = objectPositiveInt(source, ['endline', 'end_line']) ?? objectPositiveInt(record, ['endline', 'end_line']);
  if (end && end > start) return `#L${start}-${end}`;
  return `#L${start}`;
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

/** Full expandable details for a tool or command work entry (command line, parameters, and output). */
export function toolExpandedBody(item: ActivityItem): string {
  if (item.kind === 'reasoning') {
    return trimmed(item.text);
  }
  const rawOutput = expandableToolBody(item.text);
  const kind = activityIconKind(item);

  if (kind === 'shell' || item.kind === 'command') {
    const rawCmd = trimmed(item.command) || (trimmed(item.detail).startsWith('$') ? trimmed(item.detail) : '');
    const cmdLine = rawCmd ? (rawCmd.startsWith('$') ? rawCmd : `$ ${rawCmd}`) : '';
    if (cmdLine && rawOutput) {
      return trimmed(rawOutput).startsWith(cmdLine) ? rawOutput : `${cmdLine}\n\n${rawOutput}`;
    }
    return rawOutput || cmdLine;
  }

  if (kind === 'read') {
    return rawOutput;
  }

  const cleanDetail = trimmed(item.detail)
    .replace(/\n+\d+\s+lines?,\s+\d+\s+bytes$/i, '')
    .trim();
  const label = activityTraceLabel(item);
  const path = traceFilePath(item);
  const hasUsefulDetail =
    cleanDetail.length > 0 &&
    cleanDetail !== label &&
    cleanDetail !== path &&
    !(kind === 'edit' && !rawOutput && cleanDetail.startsWith('{'));

  if (hasUsefulDetail && rawOutput) {
    return cleanDetail.includes(trimmed(rawOutput)) ? cleanDetail : `${cleanDetail}\n\n${rawOutput}`;
  }
  if (rawOutput) return rawOutput;
  if (hasUsefulDetail) return cleanDetail;
  return '';
}

/** One secondary sentence for a work row. The expanded body keeps the raw output. */
export function activityTraceLabel(item: ActivityItem): string {
  if (item.kind === 'reasoning') {
    const line = liveThoughtLine(item.text);
    if (line) return line;
    const live =
      Boolean(item.streaming) || item.status === 'running' || item.status === 'inProgress';
    return live ? 'Thinking' : 'Thought';
  }

  const kind = activityIconKind(item);
  if (kind === 'shell' || item.kind === 'command') {
    const program = commandProgram(item);
    // A "program" made of regex syntax is a search pattern, not something that was run.
    if (searchPatternLike(program)) {
      return `Searched ${oneLine(item.command) || oneLine(item.title) || oneLine(item.text)}`;
    }
    return commandStatusLabel(item);
  }

  const storedPath = traceFilePath(item);
  const plain = plainTarget(item.detail);
  const hint = argumentHint(item);
  if (kind === 'read') {
    const path = extractActionPath(item, /^(?:read|view|analyz(?:e|ed|ing)|inspect(?:ed)?|list(?:ed)?)\s+/i);
    return path ? `Read ${displayPath(path)}` : 'Read file';
  }
  if (kind === 'edit') {
    const path = extractActionPath(item, /^(?:changed|edit|edited|write|wrote)\s+/i);
    return path ? displayPath(path) : 'Changed files';
  }
  if (kind === 'web') {
    const query = (
      trimmed(item.query) ||
      hint ||
      plain ||
      (genericAction(oneLine(item.title)) ? '' : oneLine(item.title))
    ).replace(/^searched\s+/i, '');
    return query ? `Searched ${query}` : 'Searched the web';
  }
  if (kind === 'code-search') {
    const query = (
      trimmed(item.query) ||
      hint ||
      plain ||
      (genericAction(oneLine(item.title)) ? '' : oneLine(item.title))
    ).replace(/^searched\s+/i, '');
    return query ? `Searched ${query}` : 'Searched files';
  }
  if (kind === 'browser') {
    const where = storedPath ? displayPath(storedPath) : plain || hint || oneLine(item.title);
    return where ? `Browser ${where}` : 'Used browser';
  }

  const title = oneLine(item.title) || oneLine(item.toolName);
  const mcp = mcpToolLabel(item.serverName, title);
  if (mcp) return hint && !mcp.includes(hint) ? `${mcp} ${hint}` : mcp;
  if (searchPatternLike(title)) return `Searched ${title}`;
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

function extractActionPath(item: ActivityItem, prefixPattern: RegExp): string {
  const fromTitle = oneLine(item.title).replace(prefixPattern, '');
  const candidate =
    traceFilePath(item) ||
    plainTarget(item.detail) ||
    (fromTitle && !genericAction(fromTitle) ? fromTitle : '');
  return candidate && !genericAction(candidate) ? candidate : '';
}

function extractSearchQuery(item: ActivityItem): string {
  const title = oneLine(item.title);
  return (
    trimmed(item.query) ||
    argumentHint(item) ||
    plainTarget(item.detail) ||
    (genericAction(title) ? '' : title)
  ).replace(/^searched\s+/i, '');
}

/** Concise single-line progressive headline for an active tool or step. */
export function liveActivityHeadline(item: ActivityItem): string {
  const kind = activityIconKind(item);
  const title = oneLine(item.title) || oneLine(item.toolName);
  const isExplore = /explore/i.test(title) || /explore/i.test(item.toolName ?? '');

  if (kind === 'read') {
    const path = extractActionPath(item, /^(?:read|view|analyz(?:e|ed|ing)|inspect(?:ed)?|list(?:ed)?)\s+/i);
    return path ? `Reading ${basenamePath(path)}` : 'Reading file';
  }
  if (kind === 'edit') {
    const path = extractActionPath(item, /^(?:changed|edit|edited|write|wrote)\s+/i);
    return path ? `Editing ${basenamePath(path)}` : 'Editing files';
  }
  if (kind === 'code-search') {
    if (isExplore) return 'Exploring';
    const query = extractSearchQuery(item);
    return query ? `Searching ${query}` : 'Exploring';
  }
  if (kind === 'web') {
    const query = extractSearchQuery(item);
    return query ? `Searching ${query}` : 'Searching the web';
  }
  if (kind === 'shell' || item.kind === 'command') {
    const program = commandProgram(item);
    return searchPatternLike(program) ? 'Exploring' : `Running ${program}`;
  }
  if (kind === 'browser') {
    const storedPath = traceFilePath(item);
    const where = storedPath ? basenamePath(storedPath) : plainTarget(item.detail) || argumentHint(item);
    return where ? `Browsing ${where}` : 'Using browser';
  }
  if (kind === 'plan') return 'Planning';
  if (kind === 'reasoning') return liveThoughtLine(item.text) || 'Thinking';
  if (kind === 'mcp') {
    if (isExplore) return 'Exploring';
    return mcpToolLabel(item.serverName, title) || title || 'Working';
  }
  if (isExplore) return 'Exploring';
  const fallback = activityTraceLabel(item);
  return fallback && fallback !== 'Tool' ? fallback : 'Working';
}

/** Single-line header headline for a collapsed live work group, reflecting the latest active task. */
export function liveWorkGroupHeadline(items: ActivityItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item &&
      (item.streaming || item.status === 'running' || item.status === 'inProgress' || item.status === 'pending')
    ) {
      return liveActivityHeadline(item);
    }
  }
  const last = items[items.length - 1];
  return last ? liveActivityHeadline(last) : 'Working';
}
