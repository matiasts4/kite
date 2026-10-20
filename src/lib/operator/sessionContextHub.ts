// Kite Code — session context hub (terminals + chats)
// Connects the Kite Operator and TTS Narrator to the real-time terminal runtime and buffer states.

import {
  getActiveAgentTerminals,
  getTerminalRollingBuffer,
} from '../terminalRegistry';
import { cleanAgentTitle } from '../agentNames';

export interface TerminalContextSummary {
  sessionId: string;
  engine: string;
  title: string;
  who?: string | null;
  agentName?: string | null;
  state: 'waitingForYou' | 'working' | 'done' | 'idle' | 'exited';
  latestLine: string | null;
  extractedOutcome: string;
  updatedAt: number;
}

/**
 * Strips ANSI codes, control characters, and spinner frames from raw terminal chunks.
 */
export function cleanRawOutput(text: string): string {
  // Strip ANSI escape codes
  // eslint-disable-next-line no-control-regex
  let cleaned = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  // Strip common spinner characters and carriage return noise
  cleaned = cleaned.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒✓✔✕✖]/g, '');
  cleaned = cleaned.replace(/\r/g, '\n');
  return cleaned;
}

/**
 * Extracts the most relevant recent output block or completed turn outcome from a buffer.
 */
export function extractOutcomeFromBuffer(buffer?: string, latestLine?: string | null): string {
  if (!buffer || buffer.trim().length === 0) {
    return latestLine?.trim() || 'Sin actividad registrada';
  }

  const cleaned = cleanRawOutput(buffer);
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[─━═┄┅┈┉┌┐└┘├┤┬┴┼│║|_\-=\s]+$/.test(l));

  if (lines.length === 0) {
    return latestLine?.trim() || 'Sin actividad registrada';
  }

  // Grab the last 4 informative lines
  const recentLines = lines.slice(-4);
  return recentLines.join(' · ');
}

/**
 * Human-friendly state descriptions in Spanish and English for speech and UI.
 */
export const STATE_NARRATION: Record<string, { es: string; en: string }> = {
  working: { es: 'está trabajando activamente', en: 'is actively working' },
  waitingForYou: { es: 'está esperando tu confirmación o respuesta', en: 'is waiting for your response' },
  done: { es: 'ha terminado su tarea', en: 'has completed its task' },
  idle: { es: 'está en espera, sin actividad', en: 'is idle' },
  exited: { es: 'ha finalizado y la sesión está cerrada', en: 'has exited' },
};

/**
 * Retrieves the context summary of a specific terminal session.
 */
export function getTerminalSummary(sessionId: string): TerminalContextSummary | null {
  const terminals = getActiveAgentTerminals();
  const term = terminals.find((t) => t.sessionId === sessionId);
  if (!term) return null;

  const buffer = getTerminalRollingBuffer(sessionId);
  const outcome = extractOutcomeFromBuffer(buffer, term.latestLine);
  const agentName = term.who || cleanAgentTitle(term.title);

  return {
    sessionId: term.sessionId,
    engine: term.engine,
    title: term.title || term.engine,
    who: term.who,
    agentName,
    state: term.state,
    latestLine: term.latestLine,
    extractedOutcome: outcome,
    updatedAt: term.updatedAt,
  };
}

/**
 * Retrieves context summaries for all active terminal sessions.
 */
export function getAllTerminalsSummary(): TerminalContextSummary[] {
  const terminals = getActiveAgentTerminals();
  return terminals.map((term) => {
    const buffer = getTerminalRollingBuffer(term.sessionId);
    const outcome = extractOutcomeFromBuffer(buffer, term.latestLine);
    const agentName = term.who || cleanAgentTitle(term.title);
    return {
      sessionId: term.sessionId,
      engine: term.engine,
      title: term.title || term.engine,
      who: term.who,
      agentName,
      state: term.state,
      latestLine: term.latestLine,
      extractedOutcome: outcome,
      updatedAt: term.updatedAt,
    };
  });
}

/**
 * Formats a list of summaries into a conversational narration text suitable for TTS.
 */
export function formatSummaryForSpeech(
  summaries: TerminalContextSummary[],
  lang: 'es' | 'en' = 'es'
): string {
  if (summaries.length === 0) {
    return lang === 'es'
      ? 'No hay agentes ni terminales activas en este momento.'
      : 'There are no active agents or terminals at this moment.';
  }

  if (summaries.length === 1) {
    const sole = summaries[0];
    const emptyOutcome =
      !sole.extractedOutcome?.trim() ||
      sole.extractedOutcome === 'Sin actividad registrada';
    if (emptyOutcome) {
      return lang === 'es'
        ? 'No hay nada en esa terminal.'
        : 'There is nothing in that terminal.';
    }
  }

  const parts = summaries.map((s, idx) => {
    const stateDesc = STATE_NARRATION[s.state]?.[lang] || s.state;
    const num = idx + 1;
    const agentLabel = s.agentName || s.who || s.title;
    if (lang === 'es') {
      return `Terminal ${num}, con ${agentLabel}: ${stateDesc}. Resumen de actividad: ${s.extractedOutcome}.`;
    }
    return `Terminal ${num}, running ${agentLabel}: ${stateDesc}. Activity summary: ${s.extractedOutcome}.`;
  });

  const intro =
    lang === 'es'
      ? `Tienes ${summaries.length} ${summaries.length === 1 ? 'terminal activa' : 'terminales activas'}:`
      : `You have ${summaries.length} active ${summaries.length === 1 ? 'terminal' : 'terminals'}:`;

  return `${intro} ${parts.join(' ')}`;
}
