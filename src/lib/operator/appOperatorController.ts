// Kite Code — App Operator Controller
// Fast deterministic execution controller for the Kite Operator Assistant.
// Handles multi-terminal spawning, prompt injection, terminal closing, browser launch, and context summarization
// with zero LLM round trip for deterministic actions, and full run ledger correlation.

import { invokeCommand } from '../ipc';
import { getActiveAgentTerminals, markTerminalExited } from '../terminalRegistry';
import { getNextAgentName, cleanAgentTitle } from '../agentNames';
import {
  getAllTerminalsSummary,
  getTerminalSummary,
  type TerminalContextSummary,
} from './sessionContextHub';
import { getTerminalRollingBuffer } from '../terminalRegistry';
import { loadOperatorConfig } from './operatorConfig';
import { resolvePlannerProvider } from './providers/resolvePlanner';
import { summarizeTerminalsWithProvider } from './planner/terminalSummary';
import { ttsNarrator } from './ttsNarrator';
import { interpretAndEnrichPrompt } from './planner/promptInterpreter';
import { runLedger } from './runLedger';
import { planTurnHeuristic, detectEngineFromText } from './planner/heuristic';
import { suppressProactiveAnnouncement } from './proactiveWatcher';
import { pulseZedOrb } from '../../motion/contract';

export interface InjectPromptOptions {
  runId?: string;
  /** Terminal that threw the prompt; the projectile flies from it (S5/S7). */
  sourceSessionId?: string;
  sourcePaneId?: string;
  /** Badge shown on the in-flight projectile capsule. */
  label?: string;
}

export interface SpawnTerminalsOptions {
  count: number;
  engine?: string;
  prompts?: string[];
  autoApprove?: boolean;
  workspaceId?: string;
  titlePrefix?: string;
  runId?: string;
  /** Session that originated the request; the prompt projectile flies out of it (S5/S7). */
  sourceSessionId?: string;
  /** Badge shown on the in-flight projectile capsule. */
  projectileLabel?: string;
}

export interface OperatorExecutionResult {
  success: boolean;
  message: string;
  data?: any;
}

class AppOperatorController {
  /**
   * Determines whether an input can be executed deterministically without an LLM round trip.
   */
  public isDeterministic(input: string): boolean {
    if (!input || !input.trim()) return false;
    const norm = input.trim().toLowerCase();

    // Stop speaking
    if (
      norm === 'para' ||
      norm === 'cállate' ||
      norm === 'callate' ||
      norm === 'silencio' ||
      /^(?:para|det[eé]n|stop)\s+(?:de\s+)?(?:hablar|voz|tts|audio)/i.test(norm)
    ) {
      return true;
    }

    // Inspect status / summary
    if (
      /^(?:estado|status|qu[eé]\s+hay|qu[eé]\s+est[aá]n\s+haciendo|c[oó]mo\s+van|resumen(?:\s+de\s+terminales)?)$/i.test(norm)
    ) {
      return true;
    }

    // Close terminals
    if (
      /^(?:cierra|cerrar|cierre|cierren|sierra|sierre|kill|mata|matar|termina|terminar|elimina|apaga)\b/i.test(norm)
    ) {
      return true;
    }

    // Open terminals
    if (
      /^(?:abre|abrir|abr[ií]|lanza|lanzar|crea|crear|inicia|iniciar|spawn)\s+(?:\d+|un|una|uno|dos|tres|cuatro|cinco|\w+\s+)?(?:terminal|terminales|agente|agentes)\b/i.test(norm)
    ) {
      return true;
    }

    // Inject prompt
    if (
      /^(?:inyecta|inyectar|escribe|escribir|manda|mandar|corre|correr|ejecuta|ejecutar)\s+.+\s+en\s+(?:la\s+)?(?:terminal|agente)\b/i.test(norm)
    ) {
      return true;
    }

    // Browser
    if (/^(?:abre|abrir|navega|navegar)\s+(?:a\s+)?(?:https?:\/\/|\w+\.\w+)/i.test(norm)) {
      return true;
    }

    return false;
  }

  /**
   * Spawns N terminals with the selected engine and optional prompt injections.
   */
  public async spawnTerminals(options: SpawnTerminalsOptions): Promise<OperatorExecutionResult> {
    const startTime = Date.now();
    const count = Math.max(1, Math.min(options.count || 1, 10));
    // S3: a plain terminal request is a shell pane, never an unrequested AI agent.
    const engine = options.engine || 'powershell';
    const autoApprove = options.autoApprove ?? true;
    const isShell = engine === 'powershell' || engine === 'terminal';
    const spawnedIds: string[] = [];
    const assignedNames: string[] = [];
    const runId = options.runId;

    if (runId) {
      runLedger.recordToolStart(runId, { name: 'open_terminals', actionIdx: 0 });
    }

    // Ensure CodeWorkspace is mounted and listening before dispatching spawn events
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kite:navigate-mode', { detail: 'code' }));
      await new Promise((r) => setTimeout(r, 180));
    }

    const activeTerms = getActiveAgentTerminals();
    const existingNames = new Set(
      activeTerms
        .map((t) => t.who || t.title)
        .filter(Boolean)
        .map((n) => cleanAgentTitle(n!).toLowerCase())
    );

    for (let i = 0; i < count; i++) {
      const sessionId = globalThis.crypto?.randomUUID?.() ?? `term-${Date.now()}-${i}`;
      const rawPrompt = options.prompts?.[i] || options.prompts?.[0];

      let agentName: string | undefined;
      let title: string;
      if (isShell) {
        title = `${options.titlePrefix || 'Terminal'} ${i + 1}`;
      } else {
        agentName = getNextAgentName(existingNames);
        assignedNames.push(agentName);
        title = `${agentName} (${engine})`;
      }

      const enriched = rawPrompt
        ? interpretAndEnrichPrompt(rawPrompt, { engine, agentName })
        : undefined;
      const prompt = enriched ? (enriched.enrichedPrompt || enriched.enriched) : undefined;

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('kite:spawn-agent-terminal', {
            detail: {
              sessionId,
              engine,
              agentName,
              splitAxis: 'vertical',
              initialPrompt: prompt,
              autoApprove,
              title,
              workspaceId: options.workspaceId,
              sourceSessionId: options.sourceSessionId,
              label: options.projectileLabel,
            },
          })
        );
      } else {
        await invokeCommand('start_terminal', {
          sessionId,
          engine,
          initialPrompt: prompt,
          autoApprove,
          columns: 80,
          rows: 24,
          confirmedByBuilder: true,
        }).catch((err) => console.warn('[Operator] start_terminal fallback error:', err));
      }

      spawnedIds.push(sessionId);

      if (runId) {
        runLedger.recordTerminalExec(runId, {
          terminalId: sessionId,
          command: engine,
          exitCode: 0,
        });
      }

      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    const durationMs = Date.now() - startTime;
    if (runId) {
      runLedger.recordToolEnd(runId, {
        name: 'open_terminals',
        ok: true,
        durationMs,
        exitCode: 0,
      });
    }

    const namesDesc = assignedNames.length > 0 ? ` (agente${assignedNames.length === 1 ? '' : 's'} ${assignedNames.join(' y ')})` : '';
    return {
      success: true,
      message: `Se ${count === 1 ? 'abrió 1 terminal' : `abrieron ${count} terminales`} con ${engine}${namesDesc}${options.prompts?.[0] ? ` y prompt "${options.prompts[0]}"` : ''}.`,
      data: { sessionIds: spawnedIds, agentNames: assignedNames },
    };
  }

  /**
   * Injects a prompt into a running terminal via PTY write.
   * When the target pane is mounted, the Prompt-Throw projectile delivers the text
   * through `kite:terminal-staged-prompt` so the flight is always visible (S5).
   */
  public async injectPrompt(
    sessionId: string,
    prompt: string,
    options?: InjectPromptOptions
  ): Promise<OperatorExecutionResult> {
    const runId = options?.runId;

    if (!sessionId || !prompt) {
      if (runId) {
        runLedger.recordToolEnd(runId, {
          name: 'inject_prompt',
          ok: false,
          error: 'Falta sessionId o texto de prompt',
          errorCategory: 'missing_argument',
        });
      }
      return { success: false, message: 'Falta sessionId o texto de prompt para inyectar.' };
    }

    if (runId) {
      runLedger.recordToolStart(runId, { name: 'inject_prompt' });
    }

    const hasLiveReceiver =
      typeof document !== 'undefined' &&
      document.querySelector(`.terminal-view-container[data-session-id="${sessionId}"]`) !== null;

    if (typeof window !== 'undefined') {
      if (!options?.sourceSessionId && !options?.sourcePaneId) {
        pulseZedOrb();
      }
      window.dispatchEvent(
        new CustomEvent('kite:dispatch-prompt-projectile', {
          detail: {
            sessionId,
            targetSessionId: sessionId,
            sourceSessionId: options?.sourceSessionId,
            sourcePaneId: options?.sourcePaneId,
            prompt,
            label: options?.label,
          },
        })
      );
    }

    const input = prompt.endsWith('\r') || prompt.endsWith('\n') ? prompt : `${prompt}\r\n`;

    try {
      // A mounted terminal receiver types the prompt when the projectile lands; writing
      // here as well would execute the same instruction twice.
      if (!hasLiveReceiver) {
        await invokeCommand('write_terminal', {
          sessionId,
          input,
        });
      }

      if (runId) {
        runLedger.recordTerminalExec(runId, {
          terminalId: sessionId,
          command: prompt,
          exitCode: 0,
        });
        runLedger.recordToolEnd(runId, {
          name: 'inject_prompt',
          ok: true,
          exitCode: 0,
        });
      }

      return {
        success: true,
        message: `Prompt inyectado en terminal ${sessionId}.`,
      };
    } catch (err: any) {
      if (runId) {
        runLedger.recordToolEnd(runId, {
          name: 'inject_prompt',
          ok: false,
          error: err?.message || String(err),
          errorCategory: 'pty_write_error',
        });
      }
      return {
        success: false,
        message: `Error inyectando prompt: ${err?.message || String(err)}`,
      };
    }
  }

  /**
   * Closes terminals matching a target ('finished', 'idle', 'all', 'active', 'last', an agent name, engine name, session ID, 1-based index, or an array of targets).
   */
  public async closeTerminals(
    target: 'finished' | 'idle' | 'all' | 'active' | 'last' | string | number | (string | number)[],
    runId?: string,
    countLimit?: number,
    workspaceId?: string
  ): Promise<OperatorExecutionResult> {
    if (runId) {
      runLedger.recordToolStart(runId, { name: 'close_terminals' });
    }

    const allTerminals = getActiveAgentTerminals();
    const terminals = workspaceId
      ? allTerminals.filter((t) => !t.workspaceId || t.workspaceId === workspaceId)
      : allTerminals;
    let toClose: string[] = [];

    const resolveSingleTarget = (raw: string | number): string[] => {
      if (typeof raw === 'number') {
        const idx = Math.floor(raw) - 1;
        return terminals[idx] ? [terminals[idx].sessionId] : [];
      }

      const trimmed = String(raw).trim();
      if (!trimmed) return [];

      const norm = trimmed.toLowerCase();

      // Check numeric index
      if (/^\d+$/.test(norm)) {
        const idx = parseInt(norm, 10) - 1;
        if (terminals[idx]) return [terminals[idx].sessionId];
        return [];
      }

      // Exact sessionId match
      const exactId = terminals.find((t) => t.sessionId === trimmed || t.sessionId.toLowerCase() === norm);
      if (exactId) return [exactId.sessionId];

      // S4: provider/engine filters win over generic wildcards, so
      // "cierra las terminales abiertas de antigravity" never closes every open pane.
      const matchedEngine = detectEngineFromText(norm);
      if (matchedEngine) {
        const matching = terminals.filter(
          (t) =>
            (t.engine && t.engine.toLowerCase() === matchedEngine) ||
            (t.who && t.who.toLowerCase().includes(matchedEngine)) ||
            (t.title && cleanAgentTitle(t.title).toLowerCase().includes(matchedEngine)) ||
            (t.title && detectEngineFromText(t.title) === matchedEngine)
        );
        if (matching.length > 0) return matching.map((t) => t.sessionId);
      }

      // Keyword matching
      if (
        norm === 'all' ||
        norm === 'todas' ||
        norm === 'todos' ||
        norm === 'todo' ||
        norm === 'abiertas' ||
        norm === 'abiertos' ||
        norm === 'abierta' ||
        norm === 'abierto' ||
        norm.includes('abiertas') ||
        norm.includes('abiertos')
      ) {
        return terminals.map((t) => t.sessionId);
      }
      if (norm === 'finished' || norm === 'terminadas' || norm === 'terminados' || norm === 'done') {
        return terminals.filter((t) => t.state === 'done' || t.state === 'exited').map((t) => t.sessionId);
      }
      if (
        norm === 'idle' ||
        norm === 'inactivas' ||
        norm === 'inactivos' ||
        norm === 'inactiva' ||
        norm === 'inactivo' ||
        norm === 'vacías' ||
        norm === 'vacias' ||
        norm === 'vacía' ||
        norm === 'vacia'
      ) {
        return terminals.filter((t) => t.state === 'idle' || t.state === 'exited').map((t) => t.sessionId);
      }
      if (
        norm === 'active' ||
        norm === 'activas' ||
        norm === 'activos' ||
        norm === 'activa' ||
        norm === 'activo'
      ) {
        return terminals.filter((t) => t.state === 'working' || t.state === 'waitingForYou' || t.state === 'idle').map((t) => t.sessionId);
      }
      if (norm === 'last' || norm === 'ultima' || norm === 'última' || norm === 'ultimo' || norm === 'último') {
        const last = terminals[terminals.length - 1];
        return last ? [last.sessionId] : [];
      }

      // Agent/terminal name matching (engine words already resolved above).
      // Exact match on who, cleaned title, or raw title (case-insensitive)
      const exactName = terminals.find((t) => 
        (t.who && t.who.toLowerCase() === norm) || 
        (t.title && cleanAgentTitle(t.title).toLowerCase() === norm) ||
        (t.title && t.title.toLowerCase() === norm)
      );
      if (exactName) return [exactName.sessionId];

      // Partial substring match on who, title, or engine
      const partialMatches = terminals.filter((t) =>
        (t.who && t.who.toLowerCase().includes(norm)) ||
        (t.title && t.title.toLowerCase().includes(norm)) ||
        (t.engine && t.engine.toLowerCase().includes(norm))
      );
      if (partialMatches.length > 0) return partialMatches.map((t) => t.sessionId);

      // Fallback: if it looks like a valid raw session ID (term-..., agent-term-..., session-... or UUID)
      if (
        /^(?:term-|agent-term-|session-)[a-zA-Z0-9_-]+$/i.test(trimmed) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
      ) {
        return [trimmed];
      }

      return [];
    };

    if (Array.isArray(target)) {
      const ids = new Set<string>();
      for (const item of target) {
        for (const id of resolveSingleTarget(item)) {
          ids.add(id);
        }
      }
      toClose = Array.from(ids);
    } else if (typeof target === 'string' && (target.includes(',') || /\s+(?:y|and)\s+/i.test(target))) {
      const parts = target.split(/(?:\s*,\s*|\s+y\s+|\s+and\s+)/i).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        const ids = new Set<string>();
        for (const item of parts) {
          for (const id of resolveSingleTarget(item)) {
            ids.add(id);
          }
        }
        toClose = Array.from(ids);
      } else {
        toClose = resolveSingleTarget(target);
      }
    } else {
      toClose = resolveSingleTarget(target);
    }

    // Apply countLimit if provided (e.g. "cierra 1 de las de antigravity"): keep the
    // first N matches in terminal order, not the last ones.
    if (countLimit && countLimit > 0 && toClose.length > countLimit) {
      toClose = toClose.slice(0, countLimit);
    }

    if (toClose.length === 0) {
      const targetLabel = Array.isArray(target) ? target.join(', ') : String(target);
      if (runId) {
        runLedger.recordToolEnd(runId, {
          name: 'close_terminals',
          ok: false,
          error: `No se encontraron terminales activas que coincidan con "${targetLabel}".`,
        });
      }
      return {
        success: false,
        message: `No se encontraron terminales activas que coincidan con "${targetLabel}".`,
        data: { target, closedSessionIds: [] },
      };
    }

    const closedIds: string[] = [];
    const failedIds: string[] = [];

    for (const id of toClose) {
      // A deliberate close must never look like an agent that just finished (S6).
      suppressProactiveAnnouncement(id);

      try {
        // S1/S4: only a resolved terminate IPC proves the session is gone.
        await invokeCommand('terminate_terminal', {
          sessionId: id,
          owner: 'operator',
        });
      } catch (err) {
        failedIds.push(id);
        console.warn('[Operator] terminate_terminal failed:', id, err);
        continue;
      }

      markTerminalExited(id);
      closedIds.push(id);

      if (runId) {
        runLedger.recordTerminalExec(runId, {
          terminalId: id,
          command: 'terminate_terminal',
          exitCode: 0,
        });
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('kite:terminate-agent', {
            detail: { sessionId: id, leafId: id },
          })
        );
      }
    }

    if (closedIds.length === 0) {
      if (runId) {
        runLedger.recordToolEnd(runId, {
          name: 'close_terminals',
          ok: false,
          error: `No se pudo terminar ninguna de las terminales seleccionadas (${failedIds.join(', ')}).`,
        });
      }
      return {
        success: false,
        message: `No se pudo cerrar ninguna terminal: ${failedIds.join(', ')}.`,
        data: { closedIds, closedSessionIds: closedIds, failedIds },
      };
    }

    if (runId) {
      runLedger.recordToolEnd(runId, {
        name: 'close_terminals',
        ok: true,
        exitCode: 0,
      });
    }

    return {
      success: true,
      message: `Se ${closedIds.length === 1 ? 'cerró 1 terminal' : `cerraron ${closedIds.length} terminales`}.`,
      data: { closedIds, closedSessionIds: closedIds, failedIds },
    };
  }

  /**
   * Opens a URL in the browser surface.
   */
  public async openBrowser(url: string, runId?: string): Promise<OperatorExecutionResult> {
    const formattedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;

    if (runId) {
      runLedger.recordToolStart(runId, { name: 'open_browser' });
    }

    try {
      // `open_external_link` is the real Tauri command; the rest are layered fallbacks
      // for builds/surfaces where that command is unavailable.
      try {
        await invokeCommand('open_external_link', { url: formattedUrl });
      } catch {
        try {
          await invokeCommand('open_browser', { url: formattedUrl });
        } catch {
          if (typeof window !== 'undefined') {
            window.open(formattedUrl, '_blank');
          }
        }
      }

      if (runId) {
        runLedger.recordToolEnd(runId, { name: 'open_browser', ok: true });
      }

      return {
        success: true,
        message: `Navegador abierto en ${formattedUrl}.`,
      };
    } catch (err: any) {
      if (runId) {
        runLedger.recordToolEnd(runId, {
          name: 'open_browser',
          ok: false,
          error: err?.message || String(err),
          errorCategory: 'browser_launch_error',
        });
      }
      return {
        success: false,
        message: `Error abriendo navegador: ${err?.message || String(err)}`,
      };
    }
  }

  /**
   * Obtains a structured context summary of active terminal(s), optionally scoped to a workspace.
   */
  public getTerminalContext(sessionId?: string, workspaceId?: string): TerminalContextSummary[] {
    if (sessionId) {
      const summary = getTerminalSummary(sessionId);
      return summary ? [summary] : [];
    }
    return getAllTerminalsSummary(workspaceId);
  }

  /**
   * Narrates the active terminal context aloud using TTS.
   */
  public async narrateSummary(
    sessionId?: string,
    _lang: 'es' | 'en' = 'es',
    workspaceId?: string
  ): Promise<OperatorExecutionResult> {
    const summaries = this.getTerminalContext(sessionId, workspaceId);
    if (summaries.length === 0) {
      return {
        success: true,
        message: 'No hay ninguna terminal abierta.',
        data: { summaries },
      };
    }

    const terminals = summaries.map((summary) => ({
      label:
        summary.agentName ||
        cleanAgentTitle(summary.title) ||
        summary.title ||
        summary.engine,
      engine: summary.engine,
      state: summary.state,
      buffer: getTerminalRollingBuffer(summary.sessionId) || summary.latestLine || '',
    }));

    const hasContent = terminals.some((term) => term.buffer.trim().length > 0);
    if (!hasContent) {
      return {
        success: true,
        message: 'No hay nada en esa terminal.',
        data: { summaries },
      };
    }

    try {
      const provider = resolvePlannerProvider(loadOperatorConfig());
      const spokenText = await summarizeTerminalsWithProvider(provider, terminals);
      return {
        success: true,
        message: spokenText,
        data: { summaries, providerId: provider.id },
      };
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `No pude resumir la terminal con el modelo configurado: ${detail}`,
        data: { summaries },
      };
    }
  }

  /**
   * Summarizes all active terminal sessions and reads aloud.
   */
  public async summarizeAndSpeak(sessionId?: string): Promise<OperatorExecutionResult> {
    return this.narrateSummary(sessionId, 'es');
  }

  /**
   * Spawns a dedicated subagent session.
   */
  public async spawnSubagent(cli: string, task: string, runId?: string): Promise<OperatorExecutionResult> {
    return this.spawnTerminals({
      count: 1,
      engine: cli,
      prompts: [task],
      titlePrefix: `Subagent (${cli})`,
      runId,
    });
  }

  /**
   * Halts any ongoing speech synthesis.
   */
  public stopSpeaking(runId?: string): void {
    if (runId) {
      runLedger.recordToolStart(runId, { name: 'stop_speaking' });
    }
    ttsNarrator.stop();
    if (runId) {
      runLedger.recordToolEnd(runId, { name: 'stop_speaking', ok: true });
    }
  }

  /**
   * Directly executes a deterministic request without an LLM round trip.
   */
  public async executeDeterministic(
    input: string,
    options?: { runId?: string; workspaceId?: string }
  ): Promise<OperatorExecutionResult> {
    const runId = options?.runId || runLedger.startRun(input, { taskType: 'deterministic' });
    const norm = input.trim().toLowerCase();

    // Stop speaking
    if (
      norm === 'para' ||
      norm === 'cállate' ||
      norm === 'callate' ||
      norm === 'silencio' ||
      /^(?:para|det[eé]n|stop)\s+(?:de\s+)?(?:hablar|voz|tts|audio)/i.test(norm)
    ) {
      this.stopSpeaking(runId);
      runLedger.completeRun(runId, {
        reply: 'Voz detenida.',
        outcome: 'success',
      });
      return { success: true, message: 'Voz detenida.' };
    }

    // Inspect status
    if (
      /^(?:estado|status|qu[eé]\s+hay|qu[eé]\s+est[aá]n\s+haciendo|c[oó]mo\s+van|resumen(?:\s+de\s+terminales)?)$/i.test(norm)
    ) {
      const summaries = this.getTerminalContext();
      const count = summaries.length;
      const message = count === 0 ? 'No hay terminales activas.' : `Hay ${count} terminales activas en el sistema.`;
      runLedger.completeRun(runId, { reply: message, outcome: 'success' });
      return { success: true, message, data: summaries };
    }

    // Fast-path heuristic plan
    const fastPlan = planTurnHeuristic(input);
    if (fastPlan.actions.length === 0) {
      runLedger.completeRun(runId, {
        reply: fastPlan.reply || 'No se reconoció una acción determinista.',
        outcome: 'failure',
      });
      return { success: false, message: fastPlan.reply || 'No se reconoció una acción determinista.' };
    }

    let overallSuccess = true;
    const messages: string[] = [];

    for (const action of fastPlan.actions) {
      runLedger.recordToolEmission(runId, {
        name: action.type,
        arguments: action as unknown as Record<string, unknown>,
      });

      if (action.type === 'open_terminals') {
        const res = await this.spawnTerminals({
          count: action.count,
          engine: action.engine,
          prompts: action.prompts,
          workspaceId: options?.workspaceId,
          runId,
        });
        overallSuccess = overallSuccess && res.success;
        messages.push(res.message);
      } else if (action.type === 'close_terminals') {
        const res = await this.closeTerminals(action.target, runId, undefined, options?.workspaceId);
        overallSuccess = overallSuccess && res.success;
        messages.push(res.message);
      } else if (action.type === 'inject_prompt') {
        const res = await this.injectPrompt(String(action.target), action.prompt, { runId });
        overallSuccess = overallSuccess && res.success;
        messages.push(res.message);
      } else if (action.type === 'open_browser') {
        const res = await this.openBrowser(action.url, runId);
        overallSuccess = overallSuccess && res.success;
        messages.push(res.message);
      } else if (action.type === 'stop_speaking') {
        this.stopSpeaking(runId);
        messages.push('Audio detenido.');
      }
    }

    const finalMessage = messages.join(' ') || fastPlan.reply || 'Acciones ejecutadas.';
    runLedger.completeRun(runId, {
      reply: finalMessage,
      outcome: overallSuccess ? 'success' : 'failure',
    });

    return {
      success: overallSuccess,
      message: finalMessage,
      data: fastPlan.actions,
    };
  }
}

export const appOperatorController = new AppOperatorController();
