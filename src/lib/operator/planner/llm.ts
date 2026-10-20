// Kite Code — LLM Turn Planner
// Validates model output with Zod, handles 1 correction retry, detects echo, and falls back gracefully with explicit reasons.

import { buildOperatorSystemPrompt } from './prompt';
import { planTurnHeuristic } from './heuristic';
import { detectPromptEcho, isPredominantlyEnglish, sanitizeReply } from './sanitize';
import { ActionSchema, type OperatorPlan, type TurnContext, type OperatorContractAction } from '../contract';
import type { PlannerProvider, ProviderMessage } from '../providers/types';
import { emitTrace } from '../trace/trace';

function extractJsonFromModelOutput(raw: string): any {
  if (!raw || !raw.trim()) return null;

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

function parseAndValidateModelPlan(
  rawText: string,
  systemPrompt: string,
  userInput?: string
): {
  plan: OperatorPlan;
  actions: OperatorContractAction[];
  reply: string;
} {
  const lowerRaw = rawText.toLowerCase();
  const promptInstructionLeaks = [
    'reglas críticas',
    'reglas criticas',
    'esquema json permitido',
    'eres el asistente operador',
    'eres el operador de kite code',
    'user request:',
    'contexto actual del sistema',
    'responde siempre con un único objeto json',
    'responde siempre con un unico objeto json',
  ];

  for (const leak of promptInstructionLeaks) {
    if (lowerRaw.includes(leak)) {
      throw new Error('Detección de eco o fuga de prompt del sistema en la salida del modelo.');
    }
  }

  const parsed = extractJsonFromModelOutput(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('La salida del modelo no contiene un objeto JSON parseable.');
  }

  const candidateReply = typeof parsed.reply === 'string' ? parsed.reply : '';
  if (detectPromptEcho(candidateReply, systemPrompt)) {
    throw new Error('Detección de eco o fuga de prompt en el campo reply.');
  }

  if (isPredominantlyEnglish(candidateReply)) {
    throw new Error('La respuesta del modelo vino predominantemente en inglés.');
  }

  // Validate actions array
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const validatedActions: OperatorContractAction[] = [];

  const hasCloseVerb = userInput
    ? /\b(?:cierra|cerrar|cierre|cierren|sierra|serrar|sierre|sierren|close|kill|mata|matar|maten|termina|terminar|terminen|elimina|eliminar|eliminen|apaga|apagar|apaguen)\b/i.test(userInput)
    : true;

  for (const act of rawActions) {
    const validated = ActionSchema.parse(act);
    // Defense-in-depth safety guardrail:
    // If the model emits close_terminals without the user asking to close/kill, discard it
    if (validated.type === 'close_terminals' && !hasCloseVerb) {
      console.warn(
        `[Operator Safety] Acción destructiva 'close_terminals' bloqueada: el prompt ("${userInput}") no contiene verbos explícitos de cierre.`
      );
      continue;
    }
    validatedActions.push(validated);
  }

  const reply = sanitizeReply(
    candidateReply,
    'Acción planificada con éxito.'
  );

  const plan: OperatorPlan = {
    strategy: 'llm',
    actions: validatedActions,
    reply,
    answer: typeof parsed.answer === 'string' ? parsed.answer : undefined,
  };

  return { plan, actions: validatedActions, reply };
}

export async function planTurnLLM(
  input: string,
  provider: PlannerProvider,
  context?: TurnContext,
  turnId?: string
): Promise<OperatorPlan> {
  const currentTurnId = turnId || `turn-${Date.now()}`;
  const systemPrompt = buildOperatorSystemPrompt(context);

  const messages: ProviderMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: input },
  ];

  let rawOutput = '';
  let latencyMs = 0;
  let modelName = 'unknown';

  try {
    // Attempt 1: primary call
    const res = await provider.plan(messages);
    rawOutput = res.rawText;
    latencyMs = res.latencyMs;
    modelName = res.model;

    try {
      const validated = parseAndValidateModelPlan(rawOutput, systemPrompt, input);

      emitTrace({
        turnId: currentTurnId,
        ev: 'plan.created',
        strategy: 'llm',
        provider: provider.id,
        model: modelName,
        latencyMs,
        actions: validated.actions,
        rawModelOutputTruncated: rawOutput.slice(0, 2000),
      });

      return validated.plan;
    } catch (parseErr: any) {
      // Attempt 2: one correction retry
      const correctionMessages: ProviderMessage[] = [
        ...messages,
        { role: 'assistant', content: rawOutput },
        {
          role: 'user',
          content:
            'Tu respuesta anterior no cumplió el esquema JSON requerido. Por favor responde ÚNICAMENTE con el objeto JSON válido con campos "reply" y "actions".',
        },
      ];

      const retryRes = await provider.plan(correctionMessages);
      rawOutput = retryRes.rawText;
      latencyMs += retryRes.latencyMs;

      const retryValidated = parseAndValidateModelPlan(rawOutput, systemPrompt, input);

      emitTrace({
        turnId: currentTurnId,
        ev: 'plan.created',
        strategy: 'llm',
        provider: provider.id,
        model: modelName,
        latencyMs,
        actions: retryValidated.actions,
        rawModelOutputTruncated: rawOutput.slice(0, 2000),
      });

      return retryValidated.plan;
    }
  } catch (err: any) {
    // Graceful fallback to heuristic
    const fallbackReason = err?.message || 'Error invocando proveedor LLM';
    const heuristicPlan = planTurnHeuristic(input);

    heuristicPlan.strategy = 'heuristic-fallback';
    heuristicPlan.fallbackReason = fallbackReason;

    emitTrace({
      turnId: currentTurnId,
      ev: 'plan.created',
      strategy: 'heuristic-fallback',
      fallbackReason,
      provider: provider.id,
      model: modelName,
      latencyMs,
      actions: heuristicPlan.actions,
      rawModelOutputTruncated: rawOutput ? rawOutput.slice(0, 2000) : undefined,
    });

    return heuristicPlan;
  }
}
