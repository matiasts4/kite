// Kite Code — App Operator Controller
// Fast deterministic execution controller for the Kite Operator Assistant.
// Handles multi-terminal spawning, prompt injection, terminal closing, browser launch, and context summarization.

import { invokeCommand } from '../ipc';
import { getActiveAgentTerminals, markTerminalExited } from '../terminalRegistry';
import { getNextAgentName, cleanAgentTitle } from '../agentNames';
import {
  getAllTerminalsSummary,
  getTerminalSummary,
  formatSummaryForSpeech,
  type TerminalContextSummary,
} from './sessionContextHub';
import { ttsNarrator } from './ttsNarrator';
import { interpretAndEnrichPrompt } from './planner/promptInterpreter';

export interface SpawnTerminalsOptions {
  count: number;
  engine?: string;
  prompts?: string[];
  autoApprove?: boolean;
  workspaceId?: string;
  titlePrefix?: string;
}

export interface OperatorExecutionResult {
  success: boolean;
  message: string;
  data?: any;
}

class AppOperatorController {
  /**
   * Spawns N terminals with the selected engine and optional prompt injections.
   */
  public async spawnTerminals(options: SpawnTerminalsOptions): Promise<OperatorExecutionResult> {
    const count = Math.max(1, Math.min(options.count || 1, 10));
    const engine = options.engine || 'grok';
    const autoApprove = options.autoApprove ?? true;
    const isShell = engine === 'powershell' || engine === 'terminal';
    const spawnedIds: string[] = [];
    const assignedNames: string[] = [];

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

      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 120));
      }
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
   */
  public async injectPrompt(sessionId: string, prompt: string): Promise<OperatorExecutionResult> {
    if (!sessionId || !prompt) {
      return { success: false, message: 'Falta sessionId o texto de prompt para inyectar.' };
    }

    const input = prompt.endsWith('\r') || prompt.endsWith('\n') ? prompt : `${prompt}\r\n`;

    try {
      await invokeCommand('write_terminal', {
        sessionId,
        input,
      });

      return {
        success: true,
        message: `Prompt inyectado en terminal ${sessionId}.`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Error inyectando prompt: ${err?.message || String(err)}`,
      };
    }
  }

  /**
   * Closes terminals matching a target ('finished', 'idle', 'all', 'active', 'last', an agent name, session ID, 1-based index, or an array of targets).
   */
  public async closeTerminals(
    target: 'finished' | 'idle' | 'all' | 'active' | 'last' | string | string[] | number
  ): Promise<OperatorExecutionResult> {
    const terminals = getActiveAgentTerminals();
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
      }

      // Keyword matching
      if (norm === 'all' || norm === 'todas' || norm === 'todos' || norm === 'todo') {
        return terminals.map((t) => t.sessionId);
      }
      if (norm === 'finished' || norm === 'terminadas' || norm === 'terminados' || norm === 'done') {
        return terminals.filter((t) => t.state === 'done' || t.state === 'exited').map((t) => t.sessionId);
      }
      if (norm === 'idle' || norm === 'inactivas' || norm === 'inactivos' || norm === 'inactiva' || norm === 'inactivo') {
        return terminals.filter((t) => t.state === 'idle' || t.state === 'exited').map((t) => t.sessionId);
      }
      if (norm === 'active' || norm === 'activas' || norm === 'activos' || norm === 'activa' || norm === 'activo') {
        return terminals.filter((t) => t.state === 'working' || t.state === 'waitingForYou' || t.state === 'idle').map((t) => t.sessionId);
      }
      if (norm === 'last' || norm === 'ultima' || norm === 'última' || norm === 'ultimo' || norm === 'último') {
        const last = terminals[terminals.length - 1];
        return last ? [last.sessionId] : [];
      }

      // Exact sessionId match
      const exactId = terminals.find((t) => t.sessionId === trimmed || t.sessionId.toLowerCase() === norm);
      if (exactId) return [exactId.sessionId];

      // Exact match on who, cleaned title, or raw title (case-insensitive)
      const exactName = terminals.find((t) => 
        (t.who && t.who.toLowerCase() === norm) || 
        (t.title && cleanAgentTitle(t.title).toLowerCase() === norm) ||
        (t.title && t.title.toLowerCase() === norm)
      );
      if (exactName) return [exactName.sessionId];

      // Partial substring match on who, title, or engine
      const partialMatch = terminals.find((t) =>
        (t.who && t.who.toLowerCase().includes(norm)) ||
        (t.title && t.title.toLowerCase().includes(norm)) ||
        (t.engine && t.engine.toLowerCase().includes(norm))
      );
      if (partialMatch) return [partialMatch.sessionId];

      // Fallback: if it looks like a raw session ID (e.g. term-* or UUID), return it anyway
      if (trimmed.startsWith('term-') || trimmed.includes('-')) {
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
    } else {
      toClose = resolveSingleTarget(target);
    }

    if (toClose.length === 0) {
      const fallbackTargets = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
      let dispatchedAny = false;
      if (typeof window !== 'undefined') {
        for (const t of fallbackTargets) {
          const trimmed = String(t || '').trim();
          if (trimmed) {
            window.dispatchEvent(
              new CustomEvent('kite:terminate-agent', {
                detail: { name: trimmed, leafId: trimmed },
              })
            );
            dispatchedAny = true;
          }
        }
      }
      if (dispatchedAny) {
        return {
          success: true,
          message: `No se encontraron terminales registradas para "${fallbackTargets.join(', ')}", pero se envió la solicitud de cierre a la interfaz.`,
          data: { target },
        };
      }
      return {
        success: true,
        message: 'No se encontraron terminales que cumplan el criterio para cerrar.',
      };
    }

    for (const id of toClose) {
      markTerminalExited(id);
      await invokeCommand('terminate_terminal', {
        sessionId: id,
        owner: 'operator',
      }).catch(() => {});
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('kite:terminate-agent', {
            detail: { sessionId: id, leafId: id },
          })
        );
      }
    }

    return {
      success: true,
      message: `Se ${toClose.length === 1 ? 'cerró 1 terminal' : `cerraron ${toClose.length} terminales`}.`,
      data: { closedIds: toClose, closedSessionIds: toClose },
    };
  }

  /**
   * Opens a URL in the browser surface.
   */
  public async openBrowser(url: string): Promise<OperatorExecutionResult> {
    const formattedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;

    try {
      await invokeCommand('open_browser', { url: formattedUrl }).catch(() => {
        if (typeof window !== 'undefined') {
          window.open(formattedUrl, '_blank');
        }
      });

      return {
        success: true,
        message: `Navegador abierto en ${formattedUrl}.`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Error abriendo navegador: ${err?.message || String(err)}`,
      };
    }
  }

  /**
   * Obtains a structured context summary of active terminal(s).
   */
  public getTerminalContext(sessionId?: string): TerminalContextSummary[] {
    if (sessionId) {
      const summary = getTerminalSummary(sessionId);
      return summary ? [summary] : [];
    }
    return getAllTerminalsSummary();
  }

  /**
   * Narrates the active terminal context aloud using TTS.
   */
  public async narrateSummary(sessionId?: string, lang: 'es' | 'en' = 'es'): Promise<OperatorExecutionResult> {
    const summaries = this.getTerminalContext(sessionId);
    const spokenText = formatSummaryForSpeech(summaries, lang);

    await ttsNarrator.speak(spokenText, {
      lang: lang === 'es' ? 'es-ES' : 'en-US',
    });

    return {
      success: true,
      message: spokenText,
      data: { summaries },
    };
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
  public async spawnSubagent(cli: string, task: string): Promise<OperatorExecutionResult> {
    return this.spawnTerminals({
      count: 1,
      engine: cli,
      prompts: [task],
      titlePrefix: `Subagent (${cli})`,
    });
  }

  /**
   * Halts any ongoing speech synthesis.
   */
  public stopSpeaking(): void {
    ttsNarrator.stop();
  }
}

export const appOperatorController = new AppOperatorController();
