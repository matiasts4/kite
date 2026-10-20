/**
 * Real-time registry for active agent processes running in terminals (Antigravity CLI, Claude Code, Codex, etc.)
 * Implements hysteresis, quiet window debouncing, and rolling buffer analysis to avoid state flapping.
 */

import { invokeCommand } from './ipc';

export interface ActiveAgentTerminal {
  sessionId: string;
  workspaceId?: string | null;
  workspaceName?: string;
  engine: string;
  title: string;
  who: string | null;
  state: 'waitingForYou' | 'working' | 'done' | 'idle' | 'exited';
  latestLine: string | null;
  branch?: string | null;
  updatedAt: number;
}

const terminalsMap = new Map<string, ActiveAgentTerminal>();
const exitedSessionIds = new Set<string>();
const STORAGE_KEY = 'kite_active_agent_terminals_v1';

// Timing constants (ms) for terminalRuntime & paneActivity
const SETTLE_DELAY_MS = 2000; // Silence required before evaluating if agent is paused at user prompt
const QUIET_IDLE_MS = 6000;   // Silence threshold to transition from completed turn to idle

interface InternalSessionTracker {
  sessionId: string;
  rollingBuffer: string;
  lastOutputAt: number;
  settleTimer: any | null;
  state: 'waitingForYou' | 'working' | 'done' | 'idle' | 'exited';
  latestLine: string | null;
  engine: string;
  who: string | null;
  title: string;
}

const sessionStates = new Map<string, InternalSessionTracker>();

export function resetTerminalExitStatus(sessionId: string) {
  exitedSessionIds.delete(sessionId);
}

// Strip ANSI escape codes
function cleanAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// Check if a line is just persistent CLI chrome/footer (e.g. Antigravity's accept-edits footer, status bar)
function isChromeFooterLine(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return true;

  // Shortcuts & mode indicators
  if (lower.startsWith('?') && (lower.includes('shortcut') || lower.includes('shift') || lower.includes('accept'))) return true;
  if (lower.includes('accept-edits mode') || lower.includes('accept-edits ·') || lower.includes('accept-edits')) return true;
  if (lower.includes('shift+tab to cycle') || lower.includes('shift+tab') || lower.includes('tab to cycle')) return true;
  if (lower.includes('for shortcuts: shift+tab') || lower.includes('shortcuts: shift+tab') || lower.includes('for shortcuts')) return true;
  if (lower.includes('ctrl+c to cancel') || lower.includes('ctrl+c to exit') || lower.includes('esc to interrupt')) return true;

  // Status bars with model / cost / effort info (e.g. "Gemini 3.8 Flash · high", "accept-edits · Gemini 3.8 Flash · high")
  if (/(gemini|claude|gpt|codex|grok).*·\s*(high|low|medium|default)/i.test(lower)) return true;

  // Prompt questions & input lines
  if (lower === 'what should antigravity cli do instead?' || lower.includes('what should antigravity do')) return true;
  if (lower === 'what would you like to do next?' || lower === 'what would you like to do?') return true;

  // Box-drawing or separators
  if (/^[─━═┄┅┈┉┌┐└┘├┤┬┴┼│║|_\-=\s]+$/.test(trimmed)) return true;

  return false;
}

// Normalize engine wire name to canonical form
export function normalizeTerminalEngine(engine?: string | null): string {
  if (!engine) return 'antigravity';
  const raw = engine.toLowerCase().trim();
  if (raw === 'claude' || raw === 'claude-code') return 'claude-code';
  if (raw === 'codex' || raw === 'openai') return 'codex';
  if (raw === 'grok' || raw === 'grok-cli') return 'grok';
  if (raw === 'open-code' || raw === 'opencode') return 'open-code';
  if (raw === 'cursor' || raw === 'cursor-agent') return 'cursor';
  if (raw === 'gemini' || raw === 'gemini-cli') return 'gemini';
  if (raw === 'droid') return 'droid';
  if (raw === 'antigravity' || raw === 'agy') return 'antigravity';
  return raw;
}

// Detect AI engine and model from terminal output text
function detectEngineFromText(text: string, fallbackEngine?: string): { engine: string; who: string | null; title: string } {
  // If a known non-generic fallback engine was explicitly provided, respect it as authoritative
  if (fallbackEngine && fallbackEngine !== 'terminal' && fallbackEngine !== 'powershell') {
    const norm = normalizeTerminalEngine(fallbackEngine);
    const lower = text.toLowerCase();
    let modelHint = '';
    if (norm === 'antigravity') {
      if (lower.includes('gemini 3.8 flash')) modelHint = 'Gemini 3.8 Flash';
      else if (lower.includes('gemini 3.0')) modelHint = 'Gemini 3.0 Flash';
      else if (lower.includes('gemini 2.5 pro')) modelHint = 'Gemini 2.5 Pro';
      else if (lower.includes('gemini 2.0 flash')) modelHint = 'Gemini 2.0 Flash';
      else if (lower.includes('gemini 1.5 pro')) modelHint = 'Gemini 1.5 Pro';
      else if (lower.includes('gemini')) modelHint = 'Google Gemini';
      return {
        engine: 'antigravity',
        who: modelHint ? `Google Antigravity · ${modelHint}` : 'Google Antigravity',
        title: 'Antigravity CLI',
      };
    }
    if (norm === 'claude-code') return { engine: 'claude-code', who: 'Anthropic Claude', title: 'Claude Code' };
    if (norm === 'codex') return { engine: 'codex', who: 'OpenAI Codex', title: 'Codex' };
    if (norm === 'gemini') return { engine: 'gemini', who: 'Google Gemini', title: 'Gemini CLI' };
    if (norm === 'grok') return { engine: 'grok', who: 'xAI Grok', title: 'Grok' };
    if (norm === 'open-code') return { engine: 'open-code', who: 'OpenCode', title: 'OpenCode' };
    if (norm === 'cursor') return { engine: 'cursor', who: 'Cursor', title: 'Cursor Agent' };
    if (norm === 'droid') return { engine: 'droid', who: 'Factory Droid', title: 'Droid' };
    return {
      engine: norm,
      who: norm.charAt(0).toUpperCase() + norm.slice(1),
      title: `${norm.charAt(0).toUpperCase() + norm.slice(1)} Agent`,
    };
  }

  const lower = text.toLowerCase();
  if (lower.includes('antigravity cli') || lower.includes('agy active') || lower.includes('antigravity active')) {
    let who = 'Google Antigravity';
    if (lower.includes('gemini 3.8 flash')) who = 'Google Antigravity · Gemini 3.8 Flash';
    else if (lower.includes('gemini 3.0')) who = 'Google Antigravity · Gemini 3.0 Flash';
    else if (lower.includes('gemini 2.5 pro')) who = 'Google Antigravity · Gemini 2.5 Pro';
    else if (lower.includes('gemini 2.0 flash')) who = 'Google Antigravity · Gemini 2.0 Flash';
    else if (lower.includes('gemini')) who = 'Google Antigravity · Gemini';
    return { engine: 'antigravity', who, title: 'Antigravity CLI' };
  }
  if (lower.includes('claude code') || lower.includes('claude-code')) {
    return { engine: 'claude-code', who: 'Anthropic Claude', title: 'Claude Code' };
  }
  if (lower.includes('codex') || lower.includes('openai codex')) {
    return { engine: 'codex', who: 'OpenAI Codex', title: 'Codex' };
  }
  if (lower.includes('gemini-cli') || lower.includes('google gemini')) {
    return { engine: 'gemini', who: 'Google Gemini', title: 'Gemini CLI' };
  }
  // Only match grok if explicit CLI brand marker, never on loose text or file paths
  if (lower.includes('grok build') || lower.includes('xai grok') || lower.includes('grok-cli')) {
    return { engine: 'grok', who: 'xAI Grok', title: 'Grok' };
  }
  if (lower.includes('opencode') || lower.includes('open-code')) {
    return { engine: 'open-code', who: 'OpenCode', title: 'OpenCode' };
  }
  if (lower.includes('cursor-agent')) {
    return { engine: 'cursor', who: 'Cursor', title: 'Cursor Agent' };
  }

  const eng = normalizeTerminalEngine(fallbackEngine || 'antigravity');
  return {
    engine: eng,
    who: eng === 'antigravity' ? 'Google Antigravity' : eng.charAt(0).toUpperCase() + eng.slice(1),
    title: eng === 'antigravity' ? 'Antigravity CLI' : `${eng.charAt(0).toUpperCase() + eng.slice(1)} Agent`,
  };
}

// Detect active working markers in incoming text
function hasWorkingMarkers(text: string): boolean {
  const lower = text.toLowerCase();

  // 1. Thinking / Thought markers (exclude past-tense "thought for 12s" which is a completion line)
  if (
    (lower.includes('thinking') ||
      lower.includes('thought:') ||
      lower.includes('pensando') ||
      lower.includes('reasoning')) &&
    !lower.includes('thought for')
  ) {
    return true;
  }

  // 2. Action verbs across Antigravity, Claude Code, Codex, Grok, OpenCode
  if (
    lower.includes('analyzing') ||
    lower.includes('searching') ||
    lower.includes('reading') ||
    lower.includes('writing') ||
    lower.includes('editing') ||
    lower.includes('executing') ||
    lower.includes('generating') ||
    lower.includes('installing') ||
    lower.includes('running') ||
    lower.includes('building') ||
    lower.includes('compiling') ||
    lower.includes('inspecting') ||
    lower.includes('evaluating') ||
    lower.includes('calling tool') ||
    lower.includes('tool call') ||
    lower.includes('fetching') ||
    lower.includes('testing') ||
    lower.includes('applying edit')
  ) {
    return true;
  }

  // 3. Spinner glyphs (active dynamic animation frames)
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(text)) {
    return true;
  }

  // 4. Progress bar indicators
  if (text.includes('[===') || text.includes('[---') || text.includes('██') || text.includes('░░')) {
    return true;
  }

  return false;
}

// Evaluate whether settled buffer tail indicates the agent is waiting on user input
function isWaitingForUserInput(buffer: string): boolean {
  const clean = cleanAnsi(buffer).trim();
  const rawLines = clean.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const meaningfulLines = rawLines.filter((line) => !isChromeFooterLine(line));
  if (meaningfulLines.length === 0) return true;

  const lastLine = meaningfulLines[meaningfulLines.length - 1];
  const lastLineLower = lastLine.toLowerCase();

  // 1. Interactive questions asking user confirmation or input
  if (
    lastLine.endsWith('?') ||
    lastLineLower.includes('(y/n)') ||
    lastLineLower.includes('[y/n]') ||
    lastLineLower.includes('[y/n]') ||
    lastLineLower.includes('(yes/no)') ||
    lastLineLower.includes('confirm?') ||
    lastLineLower.includes('proceed?') ||
    lastLineLower.includes('approval required') ||
    lastLineLower.includes('allow once') ||
    lastLineLower.includes('what would you like') ||
    lastLineLower.includes('type your') ||
    lastLineLower.includes('press enter') ||
    lastLineLower.includes('select an option') ||
    lastLineLower.includes('enter choice')
  ) {
    return true;
  }

  // 2. Active ready prompt at the end of the line (e.g. `>` or `? ` or `$ `)
  if (
    lastLine.endsWith('>') ||
    lastLine.endsWith('> ') ||
    lastLine.endsWith('? ') ||
    lastLine.endsWith('$') ||
    lastLine.endsWith('$ ') ||
    lastLine.endsWith('>>>')
  ) {
    return true;
  }

  return false;
}

export function isNoisyActivityLine(line: string): boolean {
  const lower = line.toLowerCase().trim();
  if (
    lower.startsWith('reading') ||
    lower.startsWith('read ') ||
    lower.startsWith('view_file') ||
    lower.startsWith('inspecting') ||
    lower.startsWith('fetching') ||
    lower.startsWith('cat ') ||
    lower.startsWith('head ') ||
    lower.startsWith('tail ')
  ) {
    return true;
  }
  if (/[a-zA-Z]:[\\/]|^\.{1,2}[\\/]|^src[\\/]/.test(lower) && /\.(?:ts|tsx|js|jsx|json|rs|py|md|html|css|toml)\b/i.test(lower)) {
    return true;
  }
  return false;
}

function extractLastMeaningfulLine(text: string): string | null {
  const clean = cleanAnsi(text);
  const rawLines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length === 0) return false;
      if (isChromeFooterLine(l) || isNoisyActivityLine(l)) return false;
      if (l === '>' || l === '?' || l === '$' || l === '>>>' || l === '> ' || l === '$ ') return false;
      if (l.startsWith('==') || l.startsWith('--') || l.startsWith('──')) return false;
      if (/^[─━═┄┅┈┉┌┐└┘├┤┬┴┼│║|_\-=\s]+$/.test(l)) return false;
      return true;
    });

  if (rawLines.length === 0) return null;

  // Scan backwards to find the most informative action line
  for (let i = rawLines.length - 1; i >= 0; i--) {
    let line = rawLines[i];
    // Strip leading prompt characters or list bullets
    line = line.replace(/^[>#$•*✓✔-]\s*/, '').trim();
    if (line.length < 3) continue;
    if (isChromeFooterLine(line) || isNoisyActivityLine(line)) continue;

    // Prioritize action / tool / thought lines
    const lower = line.toLowerCase();
    if (
      lower.startsWith('ran ') ||
      lower.startsWith('running ') ||
      lower.startsWith('executing ') ||
      lower.startsWith('edited ') ||
      lower.startsWith('writing ') ||
      lower.startsWith('thought for ') ||
      lower.startsWith('thinking ') ||
      lower.startsWith('step ') ||
      lower.startsWith('analyzing ')
    ) {
      return line.slice(0, 140);
    }
  }

  // Fallback to the last clean non-chrome, non-noisy line
  for (let i = rawLines.length - 1; i >= 0; i--) {
    let last = rawLines[i].replace(/^[>#$•*✓✔-]\s*/, '').trim();
    if (last.length >= 3 && !isChromeFooterLine(last) && !isNoisyActivityLine(last)) {
      if (last.length > 140) last = last.slice(0, 137) + '…';
      return last;
    }
  }
  return null;
}

function extractPathFolder(text: string): string | null {
  // Try to find cwd paths like /home/user/project or C:/Projects/app
  const match = text.match(/([A-Za-z]:[\\/][^ \r\n\t]+)/);
  if (match) {
    const full = match[1].replace(/\\/g, '/');
    const parts = full.split('/').filter(Boolean);
    return parts[parts.length - 1] || parts[0];
  }
  return null;
}

function notifyTerminalUpdate(terminal: ActiveAgentTerminal) {
  try {
    const list = Array.from(terminalsMap.values()).filter((t) => !exitedSessionIds.has(t.sessionId));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {}

  window.dispatchEvent(
    new CustomEvent('kite:terminal-agent-update', {
      detail: terminal,
    })
  );
}

export function recordTerminalOutput(
  sessionId: string,
  rawText: string,
  meta?: {
    workspaceId?: string | null;
    workspaceName?: string;
    engine?: string;
    cwd?: string;
    title?: string;
    agentName?: string;
  }
) {
  if (!sessionId || exitedSessionIds.has(sessionId)) return;
  const clean = cleanAnsi(rawText);
  if (!clean.trim()) return;

  const now = Date.now();
  let tracker = sessionStates.get(sessionId);

  // If engine was provided in meta and is known, keep it authoritative
  const authoritativeEngine = meta?.engine && meta.engine !== 'terminal' && meta.engine !== 'powershell'
    ? normalizeTerminalEngine(meta.engine)
    : undefined;

  if (!tracker) {
    const { engine, who, title: detectedTitle } = detectEngineFromText(clean, authoritativeEngine || meta?.engine);
    const resolvedTitle = meta?.title || meta?.agentName || detectedTitle;
    const resolvedWho = meta?.agentName && !who?.toLowerCase().includes(meta.agentName.toLowerCase())
      ? `${meta.agentName} · ${who}`
      : who;

    tracker = {
      sessionId,
      rollingBuffer: '',
      lastOutputAt: now,
      settleTimer: null,
      state: 'waitingForYou',
      latestLine: null,
      engine: authoritativeEngine || engine,
      who: resolvedWho,
      title: resolvedTitle,
    };
    sessionStates.set(sessionId, tracker);
  }

  // Refine engine / model metadata ONLY if engine is generic or was initialized without model info
  if (!tracker.engine || tracker.engine === 'terminal' || tracker.engine === 'powershell') {
    const detected = detectEngineFromText(clean, meta?.engine);
    if (detected.engine !== 'terminal' && detected.engine !== 'powershell') {
      tracker.engine = detected.engine;
      tracker.who = meta?.agentName ? `${meta.agentName} · ${detected.who}` : detected.who;
      tracker.title = meta?.title || meta?.agentName || detected.title;
      void invokeCommand('report_terminal_agent_detected', {
        sessionId,
        engine: detected.engine,
      }).catch(() => {});
    }
  } else if (tracker.engine === 'antigravity') {
    // Detect model update without touching engine
    const lower = clean.toLowerCase();
    let modelHint = '';
    if (lower.includes('gemini 3.8 flash')) modelHint = 'Gemini 3.8 Flash';
    else if (lower.includes('gemini 3.0')) modelHint = 'Gemini 3.0 Flash';
    else if (lower.includes('gemini 2.5 pro')) modelHint = 'Gemini 2.5 Pro';
    else if (lower.includes('gemini 2.0 flash')) modelHint = 'Gemini 2.0 Flash';
    else if (lower.includes('gemini 1.5 pro')) modelHint = 'Gemini 1.5 Pro';
    if (modelHint) {
      const baseWho = `Google Antigravity · ${modelHint}`;
      tracker.who = meta?.agentName && !baseWho.toLowerCase().includes(meta.agentName.toLowerCase())
        ? `${meta.agentName} · ${baseWho}`
        : baseWho;
    }
  }

  // Detect redraw / repaint (e.g. terminal window resize or viewport redraw)
  // When ConPTY redraws existing screen text on resize, characters in clean are already in rollingBuffer
  const isResting = tracker.state === 'done' || tracker.state === 'waitingForYou' || tracker.state === 'idle';
  const cleanCompact = clean.replace(/[\s\r\n\t]+/g, '');
  const bufferCompact = tracker.rollingBuffer.replace(/[\s\r\n\t]+/g, '');
  const isRepaint = cleanCompact.length > 0 && bufferCompact.includes(cleanCompact);

  // Append clean text to rolling buffer (capped at 4000 characters)
  tracker.rollingBuffer = (tracker.rollingBuffer + '\n' + clean).slice(-4000);
  tracker.lastOutputAt = now;

  const meaningful = extractLastMeaningfulLine(clean);
  if (meaningful && !isChromeFooterLine(meaningful)) {
    tracker.latestLine = meaningful;
  }

  const folder = extractPathFolder(clean) || meta?.workspaceName || meta?.workspaceId || 'Workspace';
  const previousState = tracker.state;

  // Clear any existing settle timer
  if (tracker.settleTimer) {
    clearTimeout(tracker.settleTimer);
    tracker.settleTimer = null;
  }

  // State Transition Rule 1: Active Work
  // If the agent was already done/waiting/idle and this chunk is a screen repaint from resize:
  // MUST NOT transition to 'working'!
  if (isResting && isRepaint) {
    // Keep resting state intact, do not start bounce settle timer
  } else {
    const hasWork = hasWorkingMarkers(clean);
    if (tracker.state === 'working') {
      // While already working, continue in working state
      tracker.state = 'working';
    } else if (hasWork && !isChromeFooterLine(clean) && !clean.trim().endsWith('>')) {
      // Transition to working only on bona-fide active work indicators
      tracker.state = 'working';
    }

    // State Transition Rule 2: Debounced Settle
    // Once output stops for SETTLE_DELAY_MS (2000ms), evaluate whether agent is waiting on user input or done
    tracker.settleTimer = setTimeout(() => {
      const currentTracker = sessionStates.get(sessionId);
      if (!currentTracker || exitedSessionIds.has(sessionId)) return;

      const timeSinceOutput = Date.now() - currentTracker.lastOutputAt;
      if (timeSinceOutput < SETTLE_DELAY_MS - 100) return;

      const waiting = isWaitingForUserInput(currentTracker.rollingBuffer);
      const nextState = waiting ? 'waitingForYou' : timeSinceOutput >= QUIET_IDLE_MS ? 'idle' : 'done';

      if (currentTracker.state !== nextState) {
        currentTracker.state = nextState;
        const updatedTerm: ActiveAgentTerminal = {
          sessionId,
          workspaceId: meta?.workspaceId ?? null,
          workspaceName: folder,
          engine: currentTracker.engine,
          title: currentTracker.title,
          who: currentTracker.who,
          state: nextState,
          latestLine: currentTracker.latestLine,
          updatedAt: Date.now(),
        };
        terminalsMap.set(sessionId, updatedTerm);
        notifyTerminalUpdate(updatedTerm);
      }
    }, SETTLE_DELAY_MS);
  }

  const currentTerminal: ActiveAgentTerminal = {
    sessionId,
    workspaceId: meta?.workspaceId ?? null,
    workspaceName: folder,
    engine: tracker.engine,
    title: tracker.title,
    who: tracker.who,
    state: tracker.state,
    latestLine: tracker.latestLine,
    updatedAt: now,
  };
  terminalsMap.set(sessionId, currentTerminal);

  // Notify listeners only when state has genuinely changed
  if (tracker.state !== previousState) {
    notifyTerminalUpdate(currentTerminal);
  }
}

export function registerSpawnedTerminal(
  sessionId: string,
  meta?: {
    workspaceId?: string | null;
    workspaceName?: string;
    engine?: string;
    title?: string;
    who?: string | null;
  }
): ActiveAgentTerminal {
  if (!sessionId) {
    throw new Error('registerSpawnedTerminal requires a valid sessionId');
  }
  resetTerminalExitStatus(sessionId);

  const now = Date.now();
  const authoritativeEngine = meta?.engine ? normalizeTerminalEngine(meta.engine) : 'grok';
  const folder = meta?.workspaceName || meta?.workspaceId || 'Workspace';
  const title = meta?.title || `[ODD] ${authoritativeEngine}`;
  const who = meta?.who || authoritativeEngine;

  const spawnedTerminal: ActiveAgentTerminal = {
    sessionId,
    workspaceId: meta?.workspaceId ?? null,
    workspaceName: folder,
    engine: authoritativeEngine,
    title,
    who,
    state: 'working',
    latestLine: `Iniciando ${authoritativeEngine}…`,
    updatedAt: now,
  };

  terminalsMap.set(sessionId, spawnedTerminal);
  notifyTerminalUpdate(spawnedTerminal);
  return spawnedTerminal;
}

export function markTerminalExited(sessionId: string) {
  if (!sessionId) return;
  exitedSessionIds.add(sessionId);
  const tracker = sessionStates.get(sessionId);
  if (tracker?.settleTimer) {
    clearTimeout(tracker.settleTimer);
    tracker.settleTimer = null;
  }
  sessionStates.delete(sessionId);
  const term = terminalsMap.get(sessionId);
  if (term) {
    term.state = 'exited';
    term.updatedAt = Date.now();
  }
  terminalsMap.delete(sessionId);
  try {
    const list = Array.from(terminalsMap.values()).filter((t) => !exitedSessionIds.has(t.sessionId));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {}
  window.dispatchEvent(new CustomEvent('kite:terminal-agent-update', { detail: { sessionId, state: 'exited' } }));
}

export function getActiveAgentTerminals(): ActiveAgentTerminal[] {
  // 1. In-memory map
  if (terminalsMap.size > 0) {
    return Array.from(terminalsMap.values()).filter((t) => t.state !== 'exited' && !exitedSessionIds.has(t.sessionId));
  }

  // 2. Fallback to sessionStorage
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: ActiveAgentTerminal[] = JSON.parse(raw);
      for (const t of parsed) {
        if (!exitedSessionIds.has(t.sessionId)) {
          terminalsMap.set(t.sessionId, t);
        }
      }
      return parsed.filter((t) => t.state !== 'exited' && !exitedSessionIds.has(t.sessionId));
    }
  } catch {}

  return [];
}

export function getTerminalRollingBuffer(sessionId: string): string | undefined {
  return sessionStates.get(sessionId)?.rollingBuffer;
}

