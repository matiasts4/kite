// Kite Code — Delegation Brief Framing (Explore Read-Only vs ODD-First vs Execute)
// & Concise Spoken Summary Helpers

import type { SubagentDelegationMode } from '../../contract';

const ODD_MENTION_RE = /\bodd\b|odd\/tasks\//i;
const READ_ONLY_MENTION_RE = /\bsolo\s+lectura\b|\bread[- ]only\b|\bsin\s+editar\s+archivos\b/i;

export interface OddBriefOptions {
  oddMode?: boolean;
  mode?: SubagentDelegationMode;
  targetKind?: 'thread' | 'subagent' | 'agent';
}

/**
 * Resolves the effective delegation mode while preserving backward compatibility
 * with legacy `oddMode?: boolean` callers.
 */
export function resolveDelegationMode(opts?: OddBriefOptions): SubagentDelegationMode {
  if (opts?.mode) return opts.mode;
  if (opts?.oddMode === true) return 'odd';
  if (opts?.targetKind === 'subagent') return 'explore';
  return 'execute';
}

/**
 * Formats a delegated task body according to its delegation mode:
 * - `explore` (and `oddMode !== true`): appends concise read-only exploration framing
 *   so the subagent inspects facts and reports back without editing files or creating ODDs.
 * - `odd` (or `oddMode === true` when not explicitly `explore`): appends ODD-first guidance
 *   so the delegated Thread/Subagent/Agent drafts or updates `odd/tasks/<slug>.md` before mutating code.
 * - `execute`: leaves the task clean without forcing read-only or ODD ceremony.
 */
export function formatDelegatedTask(rawTask: string, opts?: OddBriefOptions): string {
  const clean = rawTask.trim();
  if (!clean) return clean;

  const mode = opts?.mode;
  const shouldUseOdd = mode === 'odd' || (opts?.oddMode === true && mode !== 'explore');
  const shouldUseExplore = mode === 'explore' && !shouldUseOdd;

  if (shouldUseExplore) {
    if (READ_ONLY_MENTION_RE.test(clean)) {
      return clean;
    }
    return (
      `${clean}\n\n` +
      'Modo exploración (solo lectura): inspecciona el código y los hechos relevantes sin editar archivos ni crear documentos ODD. Devuelve un resumen claro, concreto y accionable de los hallazgos para conversar con el usuario.'
    );
  }

  if (!shouldUseOdd) {
    return clean;
  }

  if (ODD_MENTION_RE.test(clean)) {
    return clean;
  }

  return (
    `${clean}\n\n` +
    'Trabaja con enfoque ODD: explora primero el código relevante, crea o actualiza la especificación en `odd/tasks/<slug>.md` con specs verificables y tareas antes de editar código, y valida los cambios con pruebas.'
  );
}

/**
 * Compacts long descriptions or prompts for concise spoken narration while
 * preserving full details in structured timeline receipts.
 */
export function compactSpokenPreview(text: string, maxChars: number = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const candidate = clean.slice(0, maxChars);
  const lastSpace = candidate.lastIndexOf(' ');
  return lastSpace > maxChars * 0.45 ? `${candidate.slice(0, lastSpace).trim()}…` : `${candidate.trim()}…`;
}
