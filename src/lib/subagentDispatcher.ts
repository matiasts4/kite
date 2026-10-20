// Kite Code — Subagent Dispatcher & ODD Orchestration
// Provides programmatic dispatching of ODD specifications to subagents (Grok, Codex, Claude Code, Antigravity, OpenCode)
// on the same workspace, maintaining full parity with the ODD principles:
// "Pass spec by reference, never paraphrase. Subagents read .kite/tasks/<slug>.md verbatim."

import { invokeCommand } from './ipc';

export type SubagentEngine =
  | 'grok'
  | 'codex'
  | 'claude-code'
  | 'antigravity'
  | 'open-code'
  | (string & {});

export interface SubagentDispatchOptions {
  title: string;
  engine: SubagentEngine;
  objective: string;
  spec: string;
  constraints?: string[];
  verificationSteps?: string[];
  acceptanceCriteria?: string[];
  slug?: string;
  cwd?: string;
  autoApprove?: boolean;
  workspaceId?: string;
}

export interface SubagentDispatchResult {
  success: boolean;
  slug: string;
  taskFilePath: string;
  relativePath: string;
  subagentPrompt: string;
  sessionId?: string;
  error?: string;
}

export interface OddTaskSummary {
  slug: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'verified' | string;
  engine: string;
  relative_path: string;
  total_checks: number;
  completed_checks: number;
  modified_at_unix_ms: number;
}

/**
 * Creates the ODD specification file at .kite/tasks/<slug>.md using the backend Rust task store.
 */
export async function createOddTask(options: SubagentDispatchOptions): Promise<SubagentDispatchResult> {
  try {
    const res = await invokeCommand<SubagentDispatchResult>('create_odd_task_file', {
      title: options.title,
      subagentEngine: options.engine,
      objective: options.objective,
      spec: options.spec,
      constraints: options.constraints ?? [],
      verificationSteps: options.verificationSteps ?? [],
      acceptanceCriteria: options.acceptanceCriteria ?? [],
      slug: options.slug,
      cwd: options.cwd,
    });
    return res;
  } catch (err: any) {
    return {
      success: false,
      slug: options.slug || 'task',
      taskFilePath: '',
      relativePath: '',
      subagentPrompt: '',
      error: err?.message || String(err),
    };
  }
}

/**
 * Creates an ODD task specification file and spawns a live subagent terminal pane with the verbatim prompt.
 */
export async function dispatchPlanToSubagentTerminal(
  options: SubagentDispatchOptions
): Promise<SubagentDispatchResult> {
  const task = await createOddTask(options);
  if (!task.success) {
    return task;
  }

  const sessionId = globalThis.crypto?.randomUUID?.() ?? `subagent-${Date.now()}`;

  // Notify the workspace layout manager to open a terminal pane running this subagent
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('kite:spawn-agent-terminal', {
        detail: {
          sessionId,
          engine: options.engine,
          initialPrompt: task.subagentPrompt,
          autoApprove: options.autoApprove ?? true,
          title: `[ODD] ${options.title}`,
          workspaceId: options.workspaceId,
          cwd: options.cwd,
          taskSlug: task.slug,
          taskRelativePath: task.relativePath,
        },
      })
    );
  }

  return {
    ...task,
    sessionId,
  };
}

/**
 * Lists all ODD tasks in .kite/tasks/
 */
export async function listOddTasks(cwd?: string): Promise<OddTaskSummary[]> {
  try {
    const res = await invokeCommand<{ tasks: OddTaskSummary[] }>('list_odd_task_files', {
      cwd,
    });
    return res?.tasks || [];
  } catch (err) {
    console.warn('[ODD] Failed to list odd task files:', err);
    return [];
  }
}

/**
 * Updates the status header of a given ODD task.
 */
export async function updateOddTaskStatus(
  slug: string,
  status: 'pending' | 'in_progress' | 'completed' | 'verified',
  cwd?: string
): Promise<{ success: boolean; slug: string; status: string }> {
  try {
    return await invokeCommand('update_odd_task_status', {
      slug,
      status,
      cwd,
    });
  } catch (err: any) {
    return { success: false, slug, status };
  }
}

/**
 * Reads the raw Markdown content of an ODD task.
 */
export async function getOddTaskContent(
  slug: string,
  cwd?: string
): Promise<{ success: boolean; slug: string; content?: string }> {
  try {
    return await invokeCommand('get_odd_task_content', {
      slug,
      cwd,
    });
  } catch (err: any) {
    return { success: false, slug, error: err?.message || String(err) } as any;
  }
}

/**
 * Constructs the verification prompt for the Orchestrator to verify subagent work
 * following the `kite-odd-verify` skill contract.
 */
export function buildVerificationPrompt(taskRelativePath: string): string {
  return [
    `Revisa el trabajo del subagente para la tarea ${taskRelativePath}.`,
    `Ejecuta las pruebas de verificación descritas en la sección 4, comprueba el diff de git y valida que cumpla con los criterios de aceptación de la sección 5.`,
    `Si las pruebas pasan y los criterios se cumplen, actualiza el estado a "verified".`,
  ].join('\n');
}

/**
 * Helper to parse a freeform markdown plan into ODD structured sections (Objective, Spec, Constraints, Steps, Criteria).
 */
export function parseMarkdownPlanToOdd(markdown: string): {
  title: string;
  objective: string;
  spec: string;
  constraints: string[];
  verificationSteps: string[];
  acceptanceCriteria: string[];
} {
  const lines = markdown.split('\n');
  let title = 'Plan de desarrollo';
  const firstHeader = lines.find((l) => l.trim().startsWith('#'));
  if (firstHeader) {
    title = firstHeader.replace(/^#+\s*/, '').trim();
  }

  // Extract sections
  let currentSection = 'spec';
  let objective = '';
  let spec = '';
  const constraints: string[] = [];
  const verificationSteps: string[] = [];
  const acceptanceCriteria: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    const isHeaderLine =
      trimmed.startsWith('#') ||
      (trimmed.startsWith('**') && (trimmed.endsWith(':**') || trimmed.endsWith('**'))) ||
      /^(?:secci[oó]n|\d+\.\s*(?:objetivo|objective|criterio|acceptance|checklist|verific|test|prueba|restricci|constraint|especificaci|spec|detalle))/i.test(trimmed);

    if (isHeaderLine) {
      if (lower.includes('objetivo') || lower.includes('objective')) {
        currentSection = 'objective';
        continue;
      } else if (lower.includes('criterio') || lower.includes('acceptance') || lower.includes('checklist')) {
        currentSection = 'criteria';
        continue;
      } else if (lower.includes('verific') || lower.includes('test') || lower.includes('prueba')) {
        currentSection = 'verification';
        continue;
      } else if (lower.includes('restricci') || lower.includes('constraint') || lower.includes('regla')) {
        currentSection = 'constraints';
        continue;
      } else if (lower.includes('especificaci') || lower.includes('implementac') || lower.includes('spec') || lower.includes('detalle')) {
        currentSection = 'spec';
        continue;
      }
    }

    if (currentSection === 'objective') {
      objective += (objective ? '\n' : '') + trimmed;
    } else if (currentSection === 'criteria') {
      if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        acceptanceCriteria.push(trimmed.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, ''));
      }
    } else if (currentSection === 'verification') {
      if (/^\d+\./.test(trimmed) || trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        verificationSteps.push(trimmed.replace(/^(\d+\.|[-*])\s*/, ''));
      }
    } else if (currentSection === 'constraints') {
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        constraints.push(trimmed.replace(/^[-*]\s*/, ''));
      }
    } else {
      spec += (spec ? '\n' : '') + line;
    }
  }

  return {
    title,
    objective: objective || title,
    spec: spec.trim() || markdown,
    constraints,
    verificationSteps,
    acceptanceCriteria,
  };
}
