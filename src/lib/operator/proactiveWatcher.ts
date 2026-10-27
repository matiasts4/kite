// Kite Code — Proactive Agent Watcher
// Bridges `kite:terminal-agent-update` transitions into Spanish voice announcements and
// in-app notifications so the builder learns when an agent finishes, needs confirmation,
// or dies with an error — without spamming speech on noisy output or manual closes.
import { invokeCommand } from '../ipc';
import {
  getActiveAgentTerminals,
  isNoisyActivityLine,
  normalizeTerminalEngine,
} from '../terminalRegistry';
import type { ActiveAgentTerminal } from '../terminalRegistry';
import { ttsNarrator } from './ttsNarrator';

/** Minimum silence window per session so rapid output fluctuations never spam speech. */
export const PROACTIVE_COOLDOWN_MS = 8000;

/** Engines that are agents by default (normalized wire names from terminalRegistry). */
export const DEFAULT_AGENT_ENGINES = ['grok', 'claude-code', 'codex', 'antigravity', 'open-code'];

/** Plain shells never announce agent completions unless explicitly configured. */
export const PLAIN_SHELL_ENGINES = ['powershell', 'terminal', 'cmd', 'bash', 'zsh'];

export type ProactiveTerminalState = 'waitingForYou' | 'working' | 'done' | 'idle' | 'exited';

export interface ProactiveTerminalUpdate {
  sessionId?: string;
  state?: ProactiveTerminalState | string;
  engine?: string | null;
  who?: string | null;
  title?: string | null;
  latestLine?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  updatedAt?: number;
}

export interface ProactiveAttentionPayload {
  kind: 'settled' | 'needs_input' | 'error';
  title: string;
  body: string;
  sessionId: string;
  workspaceId?: string | null;
}

export interface ProactiveWatcherOptions {
  /** Speech sink; defaults to `ttsNarrator.speak`. Injected in tests. */
  speak?: (text: string) => void | Promise<void>;
  /** Attention sink; defaults to the `notifications_report_attention` IPC bridge. Injected in tests. */
  reportAttention?: (payload: ProactiveAttentionPayload) => void;
  /** Per-session silence window in ms. Defaults to `PROACTIVE_COOLDOWN_MS`. */
  cooldownMs?: number;
  /** Clock source, used to make cooldown behavior deterministic in tests. */
  now?: () => number;
  /** Explicit engine allowlist. When provided it replaces the default agent/shell heuristic. */
  engines?: string[];
  /** Also announce plain shell sessions (powershell, terminal, cmd, bash, zsh). */
  includeShellSessions?: boolean;
}

interface WatchedSession {
  state: ProactiveTerminalState;
  updatedAt: number;
  announcedState: ProactiveTerminalState | null;
  lastAnnouncedAt?: number;
  engine?: string;
  who?: string | null;
  title?: string | null;
  latestLine?: string | null;
  workspaceId?: string | null;
}

interface WatcherSettings {
  speak: (text: string) => void | Promise<void>;
  reportAttention: (payload: ProactiveAttentionPayload) => void;
  cooldownMs: number;
  now: () => number;
  engines: Set<string>;
  strictEngines: boolean;
  includeShellSessions: boolean;
}

interface ProactiveAnnouncement {
  speech: string;
  payload: ProactiveAttentionPayload;
}

const TERMINAL_UPDATE_EVENT = 'kite:terminal-agent-update';
const MAX_SUMMARY_LENGTH = 140;

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

const VALID_STATES = new Set<ProactiveTerminalState>([
  'waitingForYou',
  'working',
  'done',
  'idle',
  'exited',
]);

const ERROR_LINE_PATTERN =
  /\b(error|errors|failed|failure|fatal|exception|traceback|panic|crash|crashed|aborted|cannot|denied|refused|no se pudo|falló|fallo)\b/i;

const sessions = new Map<string, WatchedSession>();
const suppressedSessionIds = new Set<string>();

let detachListener: (() => void) | null = null;
let watcherGeneration = 0;

function defaultSpeak(text: string): void {
  try {
    void ttsNarrator.speak(text).catch(() => {});
  } catch {
    // Speech must never break terminal monitoring.
  }
}

function defaultReportAttention(payload: ProactiveAttentionPayload): void {
  void invokeCommand('notifications_report_attention', { payload }).catch(() => {});
}

function firstText(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function coerceState(value: unknown): ProactiveTerminalState | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const alias: Record<string, ProactiveTerminalState> = {
    waiting: 'waitingForYou',
    needsinput: 'waitingForYou',
    needs_input: 'waitingForYou',
  };
  const normalized = alias[raw.toLowerCase()] ?? (raw as ProactiveTerminalState);
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

function isAgentEngine(engine: string, settings: WatcherSettings): boolean {
  if (settings.strictEngines) {
    return Boolean(engine) && settings.engines.has(engine);
  }
  // Unknown engines stay announced: agents are the default, plain shells are the exception.
  if (!engine) return true;
  if (PLAIN_SHELL_ENGINES.includes(engine)) return settings.includeShellSessions;
  return true;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Reduces a raw terminal line to a short, speakable fragment (ANSI, spinners and
 * prompt chrome removed). Returns an empty string when the line carries no signal.
 */
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

function resolveWho(session: WatchedSession): string {
  const direct = firstText(session.who, session.title);
  if (direct) return direct;
  const engine = (session.engine || '').trim();
  if (!engine) return '';
  return ENGINE_LABELS[engine] || engine.charAt(0).toUpperCase() + engine.slice(1);
}

function buildAnnouncement(
  state: ProactiveTerminalState,
  sessionId: string,
  session: WatchedSession
): ProactiveAnnouncement | null {
  const who = resolveWho(session);
  const summary = summarizeLine(session.latestLine);
  const agentSubject = who ? `El agente ${who}` : 'Un agente';
  const titleSubject = who || 'Un agente';
  const base: Pick<ProactiveAttentionPayload, 'sessionId' | 'workspaceId'> = { sessionId };
  if (session.workspaceId) base.workspaceId = session.workspaceId;

  if (state === 'done') {
    const spokenSummary = summary.replace(/[.!?]+$/, '');
    return {
      speech: `${agentSubject} terminó en la terminal${spokenSummary ? `: ${spokenSummary}` : ''}.`,
      payload: {
        ...base,
        kind: 'settled',
        title: `${titleSubject} terminó`,
        body: summary || 'Terminó el turno en la terminal.',
      },
    };
  }

  if (state === 'waitingForYou') {
    return {
      speech: `${agentSubject} necesita tu confirmación.`,
      payload: {
        ...base,
        kind: 'needs_input',
        title: `${titleSubject} necesita tu confirmación`,
        body: summary || 'El agente espera tu confirmación para continuar.',
      },
    };
  }

  if (state === 'exited') {
    if (!summary || !ERROR_LINE_PATTERN.test(summary)) return null;
    const terminalSubject = who ? `La terminal de ${who}` : 'Una terminal';
    return {
      speech: `${terminalSubject} se detuvo con un error.`,
      payload: {
        ...base,
        kind: 'error',
        title: `${titleSubject} se detuvo con un error`,
        body: summary,
      },
    };
  }

  return null;
}

function speakSafely(settings: WatcherSettings, text: string): void {
  try {
    const result: unknown = settings.speak(text);
    if (result instanceof Promise) {
      void result.catch(() => {});
    }
  } catch {
    // A failing speaker must never stop the watcher.
  }
}

function handleTerminalUpdate(rawDetail: unknown, settings: WatcherSettings): void {
  const detail = (rawDetail ?? {}) as ProactiveTerminalUpdate;
  const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId.trim() : '';
  if (!sessionId) return;

  const state = coerceState(detail.state);
  if (!state) return;

  const now = settings.now();
  const previous = sessions.get(sessionId);
  const registered = findRegisteredTerminal(sessionId);

  const next: WatchedSession = {
    state,
    updatedAt: typeof detail.updatedAt === 'number' ? detail.updatedAt : now,
    announcedState: previous?.announcedState ?? null,
    lastAnnouncedAt: previous?.lastAnnouncedAt,
    engine: firstText(detail.engine, registered?.engine, previous?.engine),
    who: firstText(detail.who, registered?.who, previous?.who),
    title: firstText(detail.title, registered?.title, previous?.title),
    latestLine: firstText(detail.latestLine, registered?.latestLine, previous?.latestLine),
    workspaceId: firstText(detail.workspaceId, registered?.workspaceId, previous?.workspaceId),
  };

  if (state === 'working' && previous && previous.state !== 'working') {
    // New work began: the previous announcement no longer describes this session.
    next.announcedState = null;
  }

  if (suppressedSessionIds.has(sessionId)) {
    // Intentional close: never announce, and forget the session once it is gone.
    if (state === 'working') suppressedSessionIds.delete(sessionId);
    if (state === 'exited') sessions.delete(sessionId);
    else sessions.set(sessionId, next);
    return;
  }

  if (state === 'exited') sessions.delete(sessionId);
  else sessions.set(sessionId, next);

  // Only genuine transitions out of active work are announced.
  if (previous?.state !== 'working') return;
  if (state !== 'done' && state !== 'waitingForYou' && state !== 'exited') return;
  if (!isAgentEngine(next.engine || '', settings)) return;
  if (next.announcedState === state) return;
  if (next.lastAnnouncedAt !== undefined && now - next.lastAnnouncedAt < settings.cooldownMs) {
    return;
  }

  const announcement = buildAnnouncement(state, sessionId, next);
  if (!announcement) return;

  speakSafely(settings, announcement.speech);
  settings.reportAttention(announcement.payload);

  next.announcedState = state;
  next.lastAnnouncedAt = now;
}

/**
 * Starts listening for agent terminal transitions. Any previously running watcher is
 * replaced. Returns a cleanup function that only stops this watcher instance.
 */
export function startProactiveAgentWatcher(options: ProactiveWatcherOptions = {}): () => void {
  if (typeof window === 'undefined') return () => {};

  stopProactiveAgentWatcher();

  const settings: WatcherSettings = {
    speak: options.speak ?? defaultSpeak,
    reportAttention: options.reportAttention ?? defaultReportAttention,
    cooldownMs: options.cooldownMs ?? PROACTIVE_COOLDOWN_MS,
    now: options.now ?? (() => Date.now()),
    engines: new Set(
      (options.engines ?? DEFAULT_AGENT_ENGINES).map((engine) => normalizeEngine(engine))
    ),
    strictEngines: Array.isArray(options.engines),
    includeShellSessions: options.includeShellSessions === true,
  };

  const listener = (event: Event) => {
    handleTerminalUpdate((event as CustomEvent).detail, settings);
  };

  window.addEventListener(TERMINAL_UPDATE_EVENT, listener);
  detachListener = () => window.removeEventListener(TERMINAL_UPDATE_EVENT, listener);

  const generation = ++watcherGeneration;
  return () => {
    if (generation === watcherGeneration) stopProactiveAgentWatcher();
  };
}

/** Stops the active watcher, if any. */
export function stopProactiveAgentWatcher(): void {
  watcherGeneration += 1;
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
 * Marks a session as intentionally closed so a manual operator/user close never triggers
 * a false "finished" or "exited with error" announcement.
 */
export function suppressProactiveAnnouncement(sessionId: string): void {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return;
  suppressedSessionIds.add(id);
}

/** Clears all watcher state. Test-only. */
export function resetProactiveWatcherForTests(): void {
  stopProactiveAgentWatcher();
  sessions.clear();
  suppressedSessionIds.clear();
}
