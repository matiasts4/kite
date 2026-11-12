// Kite Code — Execute Open Terminals Action
// Handles workspace mode navigation, ui-bus request/ack, and postcondition registry verification.

import { sendUiRequest, waitForCodeWorkspaceReady } from '../ui-bus';
import { verifyOpenTerminals } from '../../verify/postconditions';
import { getActiveAgentTerminals } from '../../../terminalRegistry';
import { getNextAgentName, cleanAgentTitle } from '../../../agentNames';
import { interpretAndEnrichPrompt } from '../../planner/promptInterpreter';
import type { ActionReceipt, TurnContext } from '../../contract';

export async function executeOpenTerminalsAction(
  args: { count: number; engine: string; prompts?: string[] },
  context?: TurnContext,
  turnId?: string,
  actionIdx: number = 0
): Promise<ActionReceipt> {
  const count = Math.max(1, Math.min(8, args.count || 1));
  const engine = args.engine || 'powershell';
  const prompts = args.prompts || [];

  // Snapshot active sessions before spawn
  const initialActive = getActiveAgentTerminals();
  const initialIds = new Set(initialActive.map((t) => t.sessionId));
  const existingNames = new Set<string>(
    initialActive
      .map((t) => t.who || t.title)
      .filter(Boolean)
      .map((n) => cleanAgentTitle(n!).toLowerCase())
  );
  const isShell = engine === 'powershell' || engine === 'terminal';
  const assignedNames: string[] = [];

  // 1. Ensure view mode is 'code'
  const navRes = await sendUiRequest(
    'navigate',
    { mode: 'code' },
    { timeoutMs: 3000, turnId }
  );

  if (!navRes.ok) {
    return {
      actionIdx,
      type: 'open_terminals',
      ok: false,
      summaryEs: `No pude abrir las terminales: la vista de código no respondió (${navRes.reason || 'sin-receptor'}).`,
      error: navRes.reason || 'navigate-failed',
    };
  }

  // 2. Wait until CodeWorkspace is mounted and listening
  const workspaceReady = await waitForCodeWorkspaceReady(4500);
  if (!workspaceReady) {
    return {
      actionIdx,
      type: 'open_terminals',
      ok: false,
      summaryEs: 'No pude abrir las terminales: el espacio de trabajo de código tardó demasiado en inicializarse.',
      error: 'code-workspace-not-ready',
    };
  }

  // 3. Request terminal spawns sequentially through UI Bus
  const spawnedSessionIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const rawPromptForThisTerminal = prompts[i] || (prompts.length === 1 ? prompts[0] : undefined);
    const wireEngine = engine;
    const sessionId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    let agentName: string | undefined;
    let title: string;
    if (isShell) {
      title = `Terminal ${i + 1}`;
    } else {
      agentName = getNextAgentName(existingNames);
      assignedNames.push(agentName);
      title = `${agentName} (${wireEngine})`;
    }

    const enriched = rawPromptForThisTerminal
      ? interpretAndEnrichPrompt(rawPromptForThisTerminal, { engine: wireEngine, agentName })
      : undefined;
    const promptForThisTerminal = enriched ? (enriched.enrichedPrompt || enriched.enriched) : undefined;

    const spawnRes = await sendUiRequest(
      'spawn-terminal',
      {
        sessionId,
        engine: wireEngine,
        agentName,
        title,
        splitAxis: 'vertical',
        initialPrompt: promptForThisTerminal,
        autoApprove: true,
        workspaceId: context?.workspaceId,
      },
      { timeoutMs: 5000, turnId }
    );

    if (!spawnRes.ok) {
      return {
        actionIdx,
        type: 'open_terminals',
        ok: false,
        summaryEs: `Error abriendo la terminal ${i + 1} de ${count} con ${engine}: ${spawnRes.reason || 'sin confirmación'}.`,
        error: spawnRes.reason,
      };
    }

    if (spawnRes.sessionId) {
      spawnedSessionIds.push(spawnRes.sessionId);
    }
  }

  // 4. Verify postcondition in registry
  const verification = await verifyOpenTerminals(initialIds, count, engine, 3500, spawnedSessionIds);

  const promptSuffix =
    prompts.length > 0
      ? ` con la tarea: «${prompts[0]}»`
      : '';

  const namesDesc = assignedNames.length > 0 ? ` (agente${assignedNames.length === 1 ? '' : 's'} ${assignedNames.join(' y ')})` : '';

  if (!verification.ok) {
    return {
      actionIdx,
      type: 'open_terminals',
      ok: false,
      summaryEs: `Se solicitaron ${count} terminales con ${engine}${namesDesc}, pero la verificación en el sistema reportó: ${verification.error || 'fallo de registro'}.`,
      data: { sessionIds: spawnedSessionIds, agentNames: assignedNames },
      verification,
      error: verification.error,
    };
  }

  return {
    actionIdx,
    type: 'open_terminals',
    ok: true,
    summaryEs: `Abrí ${count} ${count === 1 ? 'terminal' : 'terminales'} con ${engine}${namesDesc}${promptSuffix}.`,
    data: { sessionIds: spawnedSessionIds, agentNames: assignedNames },
    verification,
  };
}
