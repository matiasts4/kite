// Kite Code — Operator Brain (Backward Compatibility Shim & Legacy Router)
// All new components use the modular pipeline in src/lib/operator/index.ts.
// This module provides backward-compatibility for legacy callers and tests.

import { appOperatorController, type OperatorExecutionResult } from './appOperatorController';
import { getActiveAgentTerminals } from '../terminalRegistry';
import { dispatchOperatorWithProvider } from './operatorProviders';
import { loadOperatorConfig, type OperatorProviderId } from './operatorConfig';
import { recordOperatorAudit, type OperatorActionAuditResult } from './operatorLog';
import { planTurnHeuristic, parseOperatorIntent } from './planner/heuristic';

export * from './index';
export { parseOperatorIntent };
export type { LegacyOperatorIntent as ParsedOperatorIntent } from './planner/heuristic';
export type OperatorIntentKind = ReturnType<typeof parseOperatorIntent>['kind'];

export interface OperatorAction {
  type: string;
  count?: number;
  engine?: string;
  cli?: string;
  task?: string;
  prompts?: string[];
  prompt?: string;
  target?: string | number;
  terminalIndex?: number;
  url?: string;
  [key: string]: unknown;
}

export interface OperatorBrainResponse {
  reply: string;
  actions: OperatorAction[];
  provider?: OperatorProviderId;
  model?: string;
  latencyMs?: number;
  usedFallbackLocal?: boolean;
  rawContent?: string;
  error?: string;
  executionResults?: OperatorActionAuditResult[];
}

export function parseOperatorCommandLocal(input: string): { reply: string; actions: OperatorAction[] } {
  const plan = planTurnHeuristic(input);
  return {
    reply: plan.reply || 'Comando procesado localmente.',
    actions: plan.actions as OperatorAction[],
  };
}

export function formatActiveTerminalsContext(): string {
  const terminals = getActiveAgentTerminals();
  if (!terminals || terminals.length === 0) {
    return 'No hay terminales activas en este momento.';
  }

  const lines = terminals.map((t, idx) => {
    const name = t.who || t.title || `Terminal ${idx + 1}`;
    const engine = t.engine || 'unknown';
    const state = t.state || 'active';
    const lastOutput = t.latestLine ? ` | Última salida: "${t.latestLine}"` : '';
    return `- [Terminal ${idx + 1}] ID="${t.sessionId}" | Motor: ${engine} | Agente: ${name} | Estado: ${state}${lastOutput}`;
  });

  return `Terminales activas actualmente (${terminals.length}):\n${lines.join('\n')}`;
}

export async function executeOperatorCommand(
  userInput: string,
  workspaceId?: string
): Promise<OperatorExecutionResult> {
  const intent = parseOperatorIntent(userInput);

  switch (intent.kind) {
    case 'STOP_SPEAKING': {
      appOperatorController.stopSpeaking();
      return { success: true, message: 'Lectura en voz alta detenida.' };
    }

    case 'SPAWN_TERMINALS': {
      const prompts = intent.prompt ? [intent.prompt] : undefined;
      const res = await appOperatorController.spawnTerminals({
        count: intent.count || 1,
        engine: intent.engine || 'powershell',
        prompts,
        workspaceId,
      });
      return res;
    }

    case 'CLOSE_TERMINALS': {
      const target = (intent.target as any) || 'finished';
      return await appOperatorController.closeTerminals(target);
    }

    case 'OPEN_BROWSER': {
      const url = intent.url || 'https://google.com';
      return await appOperatorController.openBrowser(url);
    }

    case 'INJECT_PROMPT': {
      const terminals = getActiveAgentTerminals();
      const idx = (intent.terminalIndex || 1) - 1;
      const target = terminals[idx];

      if (!target) {
        return {
          success: false,
          message: `No se encontró la terminal ${intent.terminalIndex}. Hay ${terminals.length} terminales activas.`,
        };
      }
      return await appOperatorController.injectPrompt(target.sessionId, intent.prompt || '');
    }

    case 'SUMMARIZE_AND_SPEAK': {
      return await appOperatorController.summarizeAndSpeak();
    }

    case 'UNKNOWN':
    default:
      return {
        success: false,
        message:
          'No reconocí el comando. Prueba: «abre 2 terminales con grok», «cierra las terminadas», o «léeme el resumen».',
      };
  }
}

export async function dispatchOperatorCommand(
  userInput: string,
  workspaceId?: string
): Promise<OperatorBrainResponse> {
  const startTime = Date.now();
  const config = loadOperatorConfig();
  const trimmed = userInput.trim().toLowerCase();

  // Fast path 1: Immediate silence command
  if (trimmed === 'silencio' || trimmed === 'calla' || trimmed === 'para' || trimmed === 'stop') {
    appOperatorController.stopSpeaking();
    const latencyMs = Date.now() - startTime;
    const actionResults: OperatorActionAuditResult[] = [
      {
        actionType: 'stop_speaking',
        description: 'Silenciar lectura en voz alta inmediatamente',
        status: 'success',
      },
    ];

    recordOperatorAudit({
      input: userInput,
      reply: 'Lectura en voz alta detenida.',
      provider: 'local',
      model: 'local-immediate-v1',
      latencyMs,
      usedFallbackLocal: true,
      actionsPlanned: [{ type: 'stop_speaking' }],
      executionResults: actionResults,
      overallSuccess: true,
      rawResponse: '{"reply": "Lectura en voz alta detenida.", "actions": [{"type": "stop_speaking"}]}',
    });

    return {
      reply: 'Lectura en voz alta detenida.',
      actions: [{ type: 'stop_speaking' }],
      provider: 'local',
      model: 'local-immediate-v1',
      latencyMs,
      usedFallbackLocal: true,
      executionResults: actionResults,
      rawContent: '{"reply": "Lectura en voz alta detenida.", "actions": [{"type": "stop_speaking"}]}',
    };
  }

  // Fast path 2: User explicitly selected local heuristic mode
  if (config.activeProvider === 'local') {
    const localPreview = parseOperatorCommandLocal(userInput);
    const execRes = await executeOperatorCommand(userInput, workspaceId);
    const latencyMs = Date.now() - startTime;
    const actions = localPreview.actions;
    const actionResults: OperatorActionAuditResult[] = actions.map((act) => ({
      actionType: act.type,
      description: `Ejecución local: ${act.type}`,
      status: execRes.success ? 'success' : 'failed',
      error: execRes.success ? undefined : execRes.message,
      data: execRes.data,
    }));

    recordOperatorAudit({
      input: userInput,
      reply: execRes.message || localPreview.reply,
      provider: 'local',
      model: 'local-heuristic-v1',
      latencyMs,
      usedFallbackLocal: true,
      actionsPlanned: actions,
      executionResults: actionResults,
      overallSuccess: execRes.success,
      rawResponse: JSON.stringify(localPreview, null, 2),
      error: execRes.success ? undefined : execRes.message,
    });

    return {
      reply: execRes.message || localPreview.reply,
      actions: localPreview.actions,
      provider: 'local',
      model: 'local-heuristic-v1',
      latencyMs,
      usedFallbackLocal: true,
      executionResults: actionResults,
      rawContent: JSON.stringify(localPreview, null, 2),
      error: execRes.success ? undefined : execRes.message,
    };
  }

  // Otherwise route through the configured provider
  const activeTerminalsContext = formatActiveTerminalsContext();
  const providerRes = await dispatchOperatorWithProvider(
    userInput,
    parseOperatorCommandLocal,
    activeTerminalsContext,
    config
  );

  const executionResults: OperatorActionAuditResult[] = [];
  for (const act of providerRes.actions) {
    if (act.type === 'open_terminals') {
      const res = await appOperatorController.spawnTerminals({
        count: act.count || 1,
        engine: act.engine || 'powershell',
        prompts: act.prompts,
        workspaceId,
      });
      executionResults.push({
        actionType: 'open_terminals',
        description: `Abrir ${act.count || 1} terminales con ${act.engine || 'powershell'}`,
        status: res.success ? 'success' : 'failed',
        error: res.success ? undefined : res.message,
        data: res.data,
      });
    } else if (act.type === 'close_terminals' || act.type === 'close_agent') {
      const res = await appOperatorController.closeTerminals((act.target as any) || 'finished');
      executionResults.push({
        actionType: act.type,
        description: `Cerrar terminales: ${act.target || 'finished'}`,
        status: res.success ? 'success' : 'failed',
        error: res.success ? undefined : res.message,
      });
    }
  }

  recordOperatorAudit({
    input: userInput,
    reply: providerRes.reply,
    provider: providerRes.provider,
    model: providerRes.model,
    latencyMs: providerRes.latencyMs,
    usedFallbackLocal: providerRes.usedFallbackLocal,
    actionsPlanned: providerRes.actions,
    executionResults,
    overallSuccess: !providerRes.error && executionResults.every((r) => r.status === 'success'),
    rawResponse: providerRes.rawContent || '',
    error: providerRes.error,
  });

  return {
    reply: providerRes.reply,
    actions: providerRes.actions,
    provider: providerRes.provider,
    model: providerRes.model,
    latencyMs: providerRes.latencyMs,
    usedFallbackLocal: providerRes.usedFallbackLocal,
    rawContent: providerRes.rawContent,
    error: providerRes.error,
    executionResults,
  };
}
