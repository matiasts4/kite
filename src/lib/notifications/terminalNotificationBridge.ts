import { invokeCommand } from '../ipc';
import { suppressProactiveAnnouncement } from '../operator/proactiveWatcher';
import {
  getActiveAgentTerminals,
  isNoisyActivityLine,
  normalizeTerminalEngine,
  type ActiveAgentTerminal,
} from '../terminalRegistry';

/** Minimum silence window per session so rapid output fluctuations never flood notifications. */
export const TERMINAL_NOTIFICATION_COOLDOWN_MS = 8000;

export const TERMINAL_BRIDGE_PLAIN_SHELLS = ['powershell', 'terminal', 'cmd', 'bash', 'zsh'];

export type TerminalBridgeState = 'waitingForYou' | 'working' | 'done' | 'idle' | 'exited';

export interface TerminalUpdateEventDetail {
  sessionId?: string;
  state?: TerminalBridgeState | string;
  engine?: string | null;
  who?: string | null;
  title?: string | null;
  latestLine?: string | null;
  workspaceId?: string | null;
  updatedAt?: number;
}

export interface TerminalAttentionReportPayload {
  kind: 'settled' | 'needs_input' | 'error';
  source: 'terminal';
  module: 'code';
  actorName: string;
  title: string;
  body: string;
  sessionId: string;
  workspaceId?: string | null;
}

export interface TerminalNotificationBridgeOptions {
  cooldownMs?: number;
  now?: () => number;
  engines?: string[];
  includeShellSessions?: boolean;
  reportAttention?: (payload: TerminalAttentionReportPayload) => Promise<unknown> | void;
}

interface TrackedTerminalSession {
  state: TerminalBridgeState;
  updatedAt: number;
  announcedState: TerminalBridgeState | null;
  lastAnnouncedAt?: number;
  engine?: string;
  who?: string | null;
  title?: string | null;
  latestLine?: string | null;
  workspaceId?: string | null;
}

interface BridgeSettings {
  cooldownMs: number;
  now: () => number;
  engines: Set<string>;
  strictEngines: boolean;
  includeShellSessions: boolean;
  reportAttention: (payload: TerminalAttentionReportPayload) => Promise<unknown> | void;
}

const TERMINAL_UPDATE_EVENT = 'kite:terminal-agent-update';
const TERMINAL_SUPPRESS_EVENT = 'kite:suppress-terminal-notification';
const TERMINAL_FOCUS_EVENT = 'kite:focus-terminal-session';
const PENDING_FOCUS_TTL_MS = 8000;
const MAX_SUMMARY_LENGTH = 140;

export interface PendingTerminalFocus {
  sessionId: string;
  workspaceId?: string | null;
  requestedAt: number;
}

let pendingTerminalFocus: PendingTerminalFocus | null = null;

const ENGINE_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
  'open-code': 'OpenCode',
  cursor: 'Cursor',
  gemini: 'Gemini',
  droid: 'Droid',
  powershell: 'PowerShell',
  terminal: 'Terminal',
};

const VALID_STATES = new Set<TerminalBridgeState>([
  'waitingForYou',
  'working',
  'done',
  'idle',
  'exited',
]);

const ERROR_LINE_PATTERN =
  /\b(error|errors|failed|failure|fatal|exception|traceback|panic|crash|crashed|aborted|cannot|denied|refused|no se pudo|falló|fallo)\b/i;

const sessions = new Map<string, TrackedTerminalSession>();
const suppressedSessionIds = new Set<string>();

let detachListener: (() => void) | null = null;
let bridgeGeneration = 0;

function defaultReportAttention(payload: TerminalAttentionReportPayload): void {
  void Promise.resolve(invokeCommand('notifications_report_attention', { payload }))
    .then(() => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kite:notifications-refresh'));
      }
    })
    .catch((err) => {
      console.warn('[terminalNotificationBridge] Failed to report terminal attention:', err);
    });
}

function firstText(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function coerceState(value: unknown): TerminalBridgeState | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const alias: Record<string, TerminalBridgeState> = {
    waiting: 'waitingForYou',
    needsinput: 'waitingForYou',
    needs_input: 'waitingForYou',
  };
  const normalized = alias[raw.toLowerCase()] ?? (raw as TerminalBridgeState);
  return VALID_STATES.has(normalized) ? normalized : null;
}

function normalizeEngine(engine?: string | null): string {
  const raw = typeof engine === 'string' ? engine.trim() : '';
  if (!raw) return '';
  return normalizeTerminalEngine(raw);
}

function findRegisteredTerminal(sessionId: string): ActiveAgentTerminal | undefined {
  try {
    return getActiveAgentTerminals().find((terminal) => terminal.sessionId === sessionId);
  } catch {
    return undefined;
  }
}

function isAgentEngine(engine: string, settings: BridgeSettings): boolean {
  if (settings.strictEngines) {
    return Boolean(engine) && settings.engines.has(engine);
  }
  if (!engine) return true;
  if (TERMINAL_BRIDGE_PLAIN_SHELLS.includes(engine)) return settings.includeShellSessions;
  return true;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function summarizeLine(line?: string | null): string {
  if (typeof line !== 'string') return '';
  let cleaned = stripAnsi(line);
  cleaned = cleaned.replace(/[\u2800-\u28FF]/g, ' ');
  cleaned = cleaned.replace(/[✔✓•●○◆◇■□▶►]/g, ' ');
  cleaned = cleaned.replace(/^[>#$*\-\u2013\u2014\s]+/, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (isNoisyActivityLine(cleaned)) return '';
  if (cleaned.length > MAX_SUMMARY_LENGTH) {
    cleaned = `${cleaned.slice(0, MAX_SUMMARY_LENGTH - 3)}…`;
  }
  return cleaned;
}

function resolveTerminalActorName(session: TrackedTerminalSession): string {
  const explicitWho = firstText(session.who, session.title);
  if (explicitWho) return explicitWho;
  const engine = (session.engine || '').trim();
  if (engine) {
    return ENGINE_LABELS[engine] || engine.charAt(0).toUpperCase() + engine.slice(1);
  }
  return 'Terminal runner';
}

function buildTerminalAttentionPayload(
  state: TerminalBridgeState,
  sessionId: string,
  session: TrackedTerminalSession
): TerminalAttentionReportPayload | null {
  const actorName = resolveTerminalActorName(session);
  const summary = summarizeLine(session.latestLine);
  const base: Pick<TerminalAttentionReportPayload, 'source' | 'module' | 'actorName' | 'title' | 'sessionId' | 'workspaceId'> = {
    source: 'terminal',
    module: 'code',
    actorName,
    title: actorName,
    sessionId,
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
  };

  if (state === 'done') {
    return {
      ...base,
      kind: 'settled',
      body: summary || 'Finished turn in terminal.',
    };
  }

  if (state === 'waitingForYou') {
    return {
      ...base,
      kind: 'needs_input',
      body: summary || 'Waiting for your confirmation in terminal.',
    };
  }

  if (state === 'exited') {
    if (!summary || !ERROR_LINE_PATTERN.test(summary)) return null;
    return {
      ...base,
      kind: 'error',
      body: summary,
    };
  }

  return null;
}

function handleTerminalUpdate(rawDetail: unknown, settings: BridgeSettings): void {
  const detail = (rawDetail ?? {}) as TerminalUpdateEventDetail;
  const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId.trim() : '';
  if (!sessionId) return;

  const state = coerceState(detail.state);
  if (!state) return;

  const now = settings.now();
  const previous = sessions.get(sessionId);
  const registered = findRegisteredTerminal(sessionId);

  const next: TrackedTerminalSession = {
    state,
    updatedAt: typeof detail.updatedAt === 'number' ? detail.updatedAt : now,
    announcedState: previous?.announcedState ?? null,
    lastAnnouncedAt: previous?.lastAnnouncedAt,
    engine: firstText(detail.engine, registered?.engine, previous?.engine),
    who: firstText(detail.who, registered?.who, previous?.who),
    title: firstText(detail.title, registered?.title, previous?.title),
    latestLine:
      state === 'exited'
        ? firstText(detail.latestLine, registered?.latestLine)
        : firstText(detail.latestLine, registered?.latestLine, previous?.latestLine),
    workspaceId: firstText(detail.workspaceId, registered?.workspaceId, previous?.workspaceId),
  };

  if (state === 'working' && previous && previous.state !== 'working') {
    next.announcedState = null;
  }

  if (suppressedSessionIds.has(sessionId)) {
    if (state === 'working') suppressedSessionIds.delete(sessionId);
    if (state === 'exited') sessions.delete(sessionId);
    else sessions.set(sessionId, next);
    return;
  }

  if (state === 'exited') sessions.delete(sessionId);
  else sessions.set(sessionId, next);

  if (previous?.state !== 'working') return;
  if (state !== 'done' && state !== 'waitingForYou' && state !== 'exited') return;
  if (!isAgentEngine(next.engine || '', settings)) return;
  if (next.announcedState === state) return;
  if (next.lastAnnouncedAt !== undefined && now - next.lastAnnouncedAt < settings.cooldownMs) {
    return;
  }

  const payload = buildTerminalAttentionPayload(state, sessionId, next);
  if (!payload) return;

  next.announcedState = state;
  next.lastAnnouncedAt = now;
  void settings.reportAttention(payload);
}

/**
 * Starts the always-on global bridge translating terminal agent state transitions
 * into persistent notifications without emitting TTS speech.
 */
export function startTerminalNotificationBridge(
  options: TerminalNotificationBridgeOptions = {}
): () => void {
  if (typeof window === 'undefined') return () => {};

  stopTerminalNotificationBridge();

  const settings: BridgeSettings = {
    cooldownMs: options.cooldownMs ?? TERMINAL_NOTIFICATION_COOLDOWN_MS,
    now: options.now ?? (() => Date.now()),
    engines: new Set((options.engines ?? []).map((engine) => normalizeEngine(engine))),
    strictEngines: Array.isArray(options.engines),
    includeShellSessions: options.includeShellSessions === true,
    reportAttention: options.reportAttention ?? defaultReportAttention,
  };

  const listener = (event: Event) => {
    handleTerminalUpdate((event as CustomEvent).detail, settings);
  };
  const suppressListener = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
    if (detail?.sessionId) {
      suppressTerminalNotification(detail.sessionId);
    }
  };
  const focusListener = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string; workspaceId?: string | null }>).detail;
    const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
    if (!sessionId) return;
    pendingTerminalFocus = {
      sessionId,
      workspaceId: detail?.workspaceId ?? null,
      requestedAt: Date.now(),
    };
  };

  window.addEventListener(TERMINAL_UPDATE_EVENT, listener);
  window.addEventListener(TERMINAL_SUPPRESS_EVENT, suppressListener);
  window.addEventListener(TERMINAL_FOCUS_EVENT, focusListener);
  detachListener = () => {
    window.removeEventListener(TERMINAL_UPDATE_EVENT, listener);
    window.removeEventListener(TERMINAL_SUPPRESS_EVENT, suppressListener);
    window.removeEventListener(TERMINAL_FOCUS_EVENT, focusListener);
  };

  const generation = ++bridgeGeneration;
  return () => {
    if (generation === bridgeGeneration) stopTerminalNotificationBridge();
  };
}

/**
 * Returns a pending terminal focus request buffered while CodeWorkspace was mounting
 * or switching workspaces, or null when none is active within the TTL window.
 */
export function peekPendingTerminalFocus(now = Date.now()): PendingTerminalFocus | null {
  if (!pendingTerminalFocus) return null;
  if (now - pendingTerminalFocus.requestedAt > PENDING_FOCUS_TTL_MS) {
    pendingTerminalFocus = null;
    return null;
  }
  return pendingTerminalFocus;
}

/** Clears the buffered terminal focus request (optionally only if matching `sessionId`). */
export function clearPendingTerminalFocus(sessionId?: string): void {
  if (!pendingTerminalFocus) return;
  if (!sessionId || pendingTerminalFocus.sessionId === sessionId.trim()) {
    pendingTerminalFocus = null;
  }
}

/** Stops the active terminal notification bridge, if any. */
export function stopTerminalNotificationBridge(): void {
  bridgeGeneration += 1;
  if (detachListener) {
    try {
      detachListener();
    } catch {
      // Ignore teardown races.
    }
    detachListener = null;
  }
}

/**
 * Marks a terminal session as intentionally closed so manual termination never
 * creates a spurious finish or error notification.
 */
export function suppressTerminalNotification(sessionId: string): void {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return;
  suppressedSessionIds.add(id);
  try {
    suppressProactiveAnnouncement(id);
  } catch {
    // Ignore if proactiveWatcher is mocked without suppressProactiveAnnouncement.
  }
}

/** Clears all bridge state. Test-only. */
export function resetTerminalNotificationBridgeForTests(): void {
  stopTerminalNotificationBridge();
  sessions.clear();
  suppressedSessionIds.clear();
  pendingTerminalFocus = null;
}
