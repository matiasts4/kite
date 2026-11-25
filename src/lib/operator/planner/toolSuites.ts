// Kite Code — Dynamic Intent Tool Suite Partitioning
// Filters OPERATOR_NATIVE_TOOLS dynamically by tool name without modifying contract.ts.

import { OPERATOR_NATIVE_TOOLS, type TurnContext } from '../contract';

export type ToolSuiteId =
  | 'conversational'
  | 'inspect'
  | 'orchestration'
  | 'terminals'
  | 'tasks_routines'
  | 'workspace_ops';

export interface NativeToolDefinition {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_SUITE_DEFINITIONS: Record<ToolSuiteId, readonly string[]> = {
  conversational: ['stay_silent', 'stop_speaking'],
  inspect: [
    'peek_changes',
    'peek_runs',
    'peek_agents',
    'peek_files',
    'recall_conversations',
    'read_diff',
  ],
  orchestration: [
    'spawn_subagent',
    'propose_task',
    'refine_proposal',
    'confirm_proposal',
    'cancel_proposal',
    'control_subagent',
    'coordinate_swarm',
    'launch_thread',
    'launch_agent',
    'handoff_to_agent',
  ],
  terminals: [
    'open_terminals',
    'close_terminals',
    'inject_prompt',
    'narrate_summary',
    'manage_pane_layout',
  ],
  tasks_routines: ['manage_tasks', 'manage_routines', 'manage_memory'],
  workspace_ops: ['switch_workspace', 'navigate_view', 'run_check', 'open_browser'],
};

const INSPECT_RE =
  /\b(?:revisa|inspecciona|mira|ver|checa|check|diff|cambios|git|archivos?|archivo|c[oó]digo|runs?|ejecuci[oó]n|qu[eé]\s+pas[oó]|ayer|anoche|recuerda|acuerdas|memoria|conversaci[oó]n|hilos?\s+pasados?|estado)\b/i;

const ORCHESTRATION_RE =
  /\b(?:subagente|subagentes|swarm|enjambre|hilo|hilos|thread|threads|agente|agentes|delega|delegar|lanza|lanzar|prop[oó]n|propuesta|confirma|confirmar|cancela|cancelar|refina|odd|handoff|p[aá]sale|audita|auditar|refactor|implementa|construye|arregla)\b/i;

const TERMINALS_RE =
  /\b(?:terminal|terminales|consola|consolas|powershell|pane|panes|paneles|panel|iguala|autoajusta|split|divide|zoom|cierra|cerrar|sierra|inyecta|ejecuta\s+en|escribe\s+en|narra|resume\s+la\s+terminal)\b/i;

const TASKS_ROUTINES_RE =
  /\b(?:tarea|tareas|task|tasks|tablero|rutina|rutinas|routine|routines|cron|recuerda\s+que|guarda\s+en\s+memoria|nota\s+de\s+memoria)\b/i;

const WORKSPACE_OPS_RE =
  /\b(?:switch_workspace|cambia(?:r)?\s+(?:de\s+)?(?:proyecto|workspace)|abre\s+(?:el\s+)?proyecto|navega(?:r)?\s+(?:a|hacia)|vista\s+de|settings|ajustes|navegador|browser|abre\s+url|https?:\/\/|corre(?:r)?\s+tests|run\s+check|vitest|tsc)\b/i;

export function filterToolsBySuites<T extends { function: { name: string } }>(
  suites: readonly ToolSuiteId[],
  catalog: readonly T[] = OPERATOR_NATIVE_TOOLS as unknown as readonly T[]
): T[] {
  const allowedNames = new Set<string>();
  for (const suite of suites) {
    const names = TOOL_SUITE_DEFINITIONS[suite];
    if (!names) continue;
    for (const n of names) {
      allowedNames.add(n);
    }
  }
  const seen = new Set<string>();
  const result: T[] = [];
  for (const tool of catalog) {
    const name = tool?.function?.name;
    if (!name || !allowedNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(tool);
  }
  return result;
}

export interface IntentSuiteClassification {
  suites: ToolSuiteId[];
  tools: NativeToolDefinition[];
  confidence: 'high' | 'low';
  isConversational: boolean;
}

export function classifyIntentSuites<T extends { function: { name: string } }>(
  input: string,
  context?: TurnContext,
  catalog: readonly T[] = OPERATOR_NATIVE_TOOLS as unknown as readonly T[]
): IntentSuiteClassification {
  const clean = (input || '').trim();
  const suites: ToolSuiteId[] = [];

  if (context?.draftProposal) {
    suites.push('orchestration');
  }
  if (INSPECT_RE.test(clean)) {
    suites.push('inspect');
  }
  if (ORCHESTRATION_RE.test(clean) && !suites.includes('orchestration')) {
    suites.push('orchestration');
  }
  if (TERMINALS_RE.test(clean)) {
    suites.push('terminals');
  }
  if (TASKS_ROUTINES_RE.test(clean)) {
    suites.push('tasks_routines');
  }
  if (WORKSPACE_OPS_RE.test(clean)) {
    suites.push('workspace_ops');
  }

  if (suites.length === 0) {
    const convTools = filterToolsBySuites(['conversational'], catalog);
    return {
      suites: ['conversational'],
      tools: convTools as unknown as NativeToolDefinition[],
      confidence: clean.length <= 80 ? 'high' : 'low',
      isConversational: true,
    };
  }

  // Always allow stop_speaking / stay_silent alongside active domains only if needed,
  // or keep domain suites tight (`0–2` on conversational, domain-only otherwise).
  const matchedTools = filterToolsBySuites(suites, catalog);
  if (matchedTools.length === 0) {
    // Fallback to orchestration + inspect if the matched suite only had optional unimplemented tools
    const fallbackSuites: ToolSuiteId[] = ['orchestration', 'inspect'];
    return {
      suites: fallbackSuites,
      tools: filterToolsBySuites(fallbackSuites, catalog) as unknown as NativeToolDefinition[],
      confidence: 'low',
      isConversational: false,
    };
  }

  return {
    suites,
    tools: matchedTools as unknown as NativeToolDefinition[],
    confidence: suites.length <= 2 ? 'high' : 'low',
    isConversational: false,
  };
}
