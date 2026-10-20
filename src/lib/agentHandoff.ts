/**
 * Agent terminal handoff — pure protocol (no Tauri, no PTY).
 * Delivers the full task file body to child terminals; never a pointer-only prompt.
 */

import { normalizeTerminalEngine } from './terminalRegistry';

export function buildPointerIsForbidden(taskPath: string): string {
  const path = taskPath.trim() || '.kite/tasks/task.md';
  return (
    `Desarrolla la tarea ODD especificada en ${path}. ` +
    'Sigue estrictamente la especificación, no asumas cambios fuera del alcance, ' +
    'ejecuta las pruebas descritas en la sección 4 y marca los checkboxes en la sección 5 al finalizar.'
  );
}

export type HandoffOp = 'spawn' | 'inject' | 'agents';

export interface HandoffRequest {
  id: string;
  op: HandoffOp;
  engine?: string;
  target?: string;
  taskPath?: string;
  taskBody?: string;
  cwd?: string;
  sourceSessionId?: string;
  sourcePaneId?: string;
}

export interface HandoffTerminalRow {
  sessionId: string;
  title: string;
  who: string | null;
  engine: string;
  state: string;
}

export interface HandoffContext {
  terminals: HandoffTerminalRow[];
  readTask: (path: string) => string;
}

export interface SpawnAgentTerminalDetail {
  sessionId: string;
  engine: string;
  title?: string;
  autoApprove?: boolean;
  initialPrompt?: string;
  sourceSessionId?: string;
  sourcePaneId?: string;
}

export interface PromptProjectileDetail {
  targetSessionId: string;
  targetPaneId?: string;
  agentName?: string;
  engine: string;
  prompt: string;
  sourceSessionId?: string;
  sourcePaneId?: string;
}

export type HandoffPlan =
  | { ok: true; op: 'agents'; agents: HandoffTerminalRow[] }
  | {
      ok: true;
      op: 'spawn';
      spawnDetail: SpawnAgentTerminalDetail;
      /** Child PTY argv must not carry the prompt; staged delivery writes it in the UI. */
      cliInitialPrompt: null;
      ptyPrompt: string;
    }
  | { ok: true; op: 'inject'; projectileDetail: PromptProjectileDetail }
  | { ok: false; error: string };

export function normalizeHandoffEngine(engine?: string): string {
  if (!engine?.trim()) {
    return 'antigravity';
  }
  return normalizeTerminalEngine(engine);
}

function trimTaskBody(body: string): string {
  return body.replace(/\s+$/, '');
}

function resolveTaskBody(request: HandoffRequest, ctx: HandoffContext): string {
  if (request.taskBody !== undefined) {
    return trimTaskBody(request.taskBody);
  }
  if (!request.taskPath?.trim()) {
    throw new Error('Falta taskPath para leer la tarea.');
  }
  return trimTaskBody(ctx.readTask(request.taskPath));
}

/** Reject paths that escape workspace cwd or use parent segments. */
export function validateTaskPathUnderCwd(cwd: string, taskPath: string): string | null {
  const raw = taskPath.trim();
  if (!raw) {
    return 'La ruta de la tarea está vacía.';
  }
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.split('/').some((seg) => seg === '..')) {
    return 'La ruta de la tarea no puede contener ..';
  }

  const isWindowsAbs = /^[a-zA-Z]:/.test(raw);
  const isUnixAbs = raw.startsWith('/');
  if (isWindowsAbs || isUnixAbs) {
    const cwdNorm = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathNorm = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!pathNorm.startsWith(cwdNorm + '/') && pathNorm !== cwdNorm) {
      return 'La ruta absoluta de la tarea está fuera del cwd del workspace.';
    }
  }
  return null;
}

function cleanAgentTitle(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function resolveInjectTarget(target: string, terminals: HandoffTerminalRow[]): HandoffTerminalRow | null {
  const trimmed = String(target).trim();
  if (!trimmed) return null;

  const norm = trimmed.toLowerCase();

  if (/^\d+$/.test(norm)) {
    const idx = parseInt(norm, 10) - 1;
    return terminals[idx] ?? null;
  }

  const exactId = terminals.find(
    (t) => t.sessionId === trimmed || t.sessionId.toLowerCase() === norm
  );
  if (exactId) return exactId;

  const exactName = terminals.find(
    (t) =>
      (t.who && t.who.toLowerCase() === norm) ||
      (t.title && cleanAgentTitle(t.title).toLowerCase() === norm) ||
      (t.title && t.title.toLowerCase() === norm)
  );
  if (exactName) return exactName;

  const partial = terminals.find(
    (t) =>
      (t.who && t.who.toLowerCase().includes(norm)) ||
      (t.title && t.title.toLowerCase().includes(norm)) ||
      (t.engine && normalizeHandoffEngine(t.engine).toLowerCase().includes(norm)) ||
      (t.engine && t.engine.toLowerCase().includes(norm))
  );
  if (partial) return partial;

  if (trimmed.startsWith('term-') || trimmed.includes('-')) {
    return terminals.find((t) => t.sessionId === trimmed) ?? null;
  }

  return null;
}

function newSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `agent-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function planHandoff(request: HandoffRequest, ctx: HandoffContext): HandoffPlan {
  const op = request.op;

  if (op === 'agents') {
    return { ok: true, op: 'agents', agents: [...ctx.terminals] };
  }

  const cwd = request.cwd?.trim() || '';
  const taskPath = request.taskPath?.trim();

  if (op === 'spawn') {
    if (!request.engine?.trim()) {
      return { ok: false, error: 'spawn requiere engine.' };
    }
    if (!taskPath) {
      return { ok: false, error: 'spawn requiere taskPath.' };
    }
    if (!cwd) {
      return { ok: false, error: 'spawn requiere cwd del workspace.' };
    }
    const pathErr = validateTaskPathUnderCwd(cwd, taskPath);
    if (pathErr) {
      return { ok: false, error: pathErr };
    }

    let body: string;
    try {
      body = resolveTaskBody(request, ctx);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (body === buildPointerIsForbidden(taskPath)) {
      return {
        ok: false,
        error: 'El cuerpo entregado no puede ser un prompt por referencia; use el archivo completo.',
      };
    }

    const engine = normalizeHandoffEngine(request.engine);
    const sessionId = newSessionId();
    const title = `Agent (${engine})`;

    return {
      ok: true,
      op: 'spawn',
      spawnDetail: {
        sessionId,
        engine,
        title,
        autoApprove: true,
        initialPrompt: body,
        sourceSessionId: request.sourceSessionId,
        sourcePaneId: request.sourcePaneId,
      },
      cliInitialPrompt: null,
      ptyPrompt: body,
    };
  }

  if (op === 'inject') {
    if (!request.target?.trim()) {
      return { ok: false, error: 'inject requiere target.' };
    }
    if (!taskPath && request.taskBody === undefined) {
      return { ok: false, error: 'inject requiere taskPath o taskBody.' };
    }
    if (taskPath && cwd) {
      const pathErr = validateTaskPathUnderCwd(cwd, taskPath);
      if (pathErr) {
        return { ok: false, error: pathErr };
      }
    }

    const match = resolveInjectTarget(request.target, ctx.terminals);
    if (!match) {
      return {
        ok: false,
        error: `No encontré ninguna terminal que coincida con «${request.target}».`,
      };
    }

    let body: string;
    try {
      body = resolveTaskBody(request, ctx);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const agentName = match.who || cleanAgentTitle(match.title) || match.title;

    return {
      ok: true,
      op: 'inject',
      projectileDetail: {
        targetSessionId: match.sessionId,
        agentName,
        engine: normalizeHandoffEngine(match.engine),
        prompt: body,
        sourceSessionId: request.sourceSessionId,
        sourcePaneId: request.sourcePaneId,
      },
    };
  }

  return { ok: false, error: `Operación desconocida: ${String(op)}` };
}

export function applyHandoffPlan(plan: HandoffPlan): boolean {
  if (!plan.ok) return false;
  if (typeof window === 'undefined') return false;

  if (plan.op === 'spawn') {
    window.dispatchEvent(
      new CustomEvent('kite:spawn-agent-terminal', { detail: plan.spawnDetail })
    );
    return true;
  }

  if (plan.op === 'inject') {
    window.dispatchEvent(
      new CustomEvent('kite:dispatch-prompt-projectile', { detail: plan.projectileDetail })
    );
    return true;
  }

  return false;
}
