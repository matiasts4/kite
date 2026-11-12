// Kite Code — Operator Heuristic Planner
// Deterministic Spanish-first parser for voice and text commands.
// Resilient to STT punctuation anomalies, seseo phonetic spelling, and subjunctive verbs.

import type {
  OperatorPlan,
  Engine,
  SwitchWorkspaceAction,
} from '../contract';
import { AGENT_CODENAMES } from '../../agentNames';

export interface LegacyOperatorIntent {
  kind:
    | 'SPAWN_TERMINALS'
    | 'CLOSE_TERMINALS'
    | 'SUMMARIZE_AND_SPEAK'
    | 'OPEN_BROWSER'
    | 'INJECT_PROMPT'
    | 'SPAWN_SUBAGENT'
    | 'STOP_SPEAKING'
    | 'UNKNOWN';
  count?: number;
  engine?: string;
  prompt?: string;
  prompts?: string[];
  target?: string | number;
  targets?: (string | number)[];
  url?: string;
  terminalIndex?: number;
  cli?: string;
}

import {
  detectEngineFromText,
  OPEN_VERB_SOURCE,
  CLOSE_TARGET_RE,
  OPEN_VERB_RE,
  referencesNonTerminalUiObject,
  isNegatedTerminalImperative,
  hasSubordinateCloseClause,
  detectEngineForOpenClause,
  SHELL_COMMAND_HEAD_RE,
  splitCompoundPrompts,
  parseNumberWord,
  extractTerminalIndices,
  normalizeInputForIntent,
} from './heuristicPatterns';

export {
  detectEngineFromText,
  referencesNonTerminalUiObject,
  isNegatedTerminalImperative,
  hasSubordinateCloseClause,
  detectEngineForOpenClause,
  splitCompoundPrompts,
  parseNumberWord,
  extractTerminalIndices,
  normalizeInputForIntent,
};

export function parseOperatorIntent(rawText: string): LegacyOperatorIntent {
  const text = normalizeInputForIntent(rawText);
  const lower = text.toLowerCase();

  // S4: a negated imperative ("no cierres las terminales", "no abras dos terminales")
  // must never be executed as its affirmative counterpart.
  if (isNegatedTerminalImperative(text)) {
    return { kind: 'UNKNOWN' };
  }

  // 1. Immediate silence / stop speaking
  if (
    lower === 'silencio' ||
    lower === 'cállate' ||
    lower === 'callate' ||
    lower.includes('para de hablar') ||
    lower.includes('deja de hablar') ||
    lower.includes('detener voz') ||
    lower.includes('mute') ||
    lower.includes('shh') ||
    lower.includes('quiet') ||
    lower.includes('stop speaking')
  ) {
    return { kind: 'STOP_SPEAKING' };
  }

  // 2. Spawn subagent
  const subagentMatch = lower.match(
    /(?:lanza|lanzar|crea|crear|inicia|iniciar|spawn)\s+(?:un\s+)?subagente?\s+(grok|claude|codex|antigravity|opencode|agy)?(?:\s+(?:para|de)\s+(.+))?/i
  );
  if (subagentMatch) {
    return {
      kind: 'SPAWN_SUBAGENT',
      cli: subagentMatch[1] || 'grok',
      prompt: subagentMatch[2]?.trim() || '',
    };
  }

  // 3. Summarize and speak (handles named agents e.g. "¿Qué está haciendo Nova?", "¿Cómo va Orion?", specific terminals, or general summary)
  const agentQueryMatch = text.match(
    /(?:qu[eé]\s+(?:est[aá]\s+haciendo|hace)|c[oó]mo\s+va|estado\s+de)\s+(?:el\s+agente\s+|la\s+terminal\s+)?([a-záéíóúñ0-9_-]+)/i
  );
  if (agentQueryMatch) {
    const rawTarget = agentQueryMatch[1].trim();
    if (/^\d+$/.test(rawTarget) || ['uno', 'dos', 'tres', 'cuatro', 'cinco'].includes(rawTarget.toLowerCase())) {
      const termNum = parseNumberWord(rawTarget);
      return { kind: 'SUMMARIZE_AND_SPEAK', terminalIndex: termNum, target: termNum };
    }
    const matchedCodename = AGENT_CODENAMES.find((c) => c.toLowerCase() === rawTarget.toLowerCase());
    return { kind: 'SUMMARIZE_AND_SPEAK', target: matchedCodename || rawTarget };
  }

  const agentSaidMatch = text.match(
    /(?:qu[eé]\s+di(?:jo|ce)|resume\s+(?:qu[eé]|lo que)\s+dijo|resum(?:e|ir|o|a|en)\s+(?:qu[eé]|lo que)\s+dijo)\s+(?:el\s+agente\s+|la\s+terminal\s+(?:de\s+)?)?([a-záéíóúñ0-9_-]+)/i
  );
  if (agentSaidMatch) {
    const rawTarget = agentSaidMatch[1].trim();
    const matchedCodename = AGENT_CODENAMES.find((c) => c.toLowerCase() === rawTarget.toLowerCase());
    return { kind: 'SUMMARIZE_AND_SPEAK', target: matchedCodename || rawTarget };
  }

  const agentResumeMatch = text.match(
    /resum(?:e|ir|o|a|en)\s+(?:el\s+agente\s+|la\s+terminal\s+(?:de\s+)?)?([a-záéíóúñ0-9_-]+)\b/i
  );
  if (agentResumeMatch) {
    const rawTarget = agentResumeMatch[1].trim();
    const matchedCodename = AGENT_CODENAMES.find((c) => c.toLowerCase() === rawTarget.toLowerCase());
    if (matchedCodename) {
      return { kind: 'SUMMARIZE_AND_SPEAK', target: matchedCodename };
    }
  }

  if (
    /resum(?:e|ir|en|o|a|i)\b/i.test(lower) ||
    lower.includes('resumen') ||
    lower.includes('summary') ||
    /\bnarr(?:a|ame|ar)\b/i.test(lower) ||
    /l[eé]eme/i.test(lower) ||
    lower.includes('read aloud') ||
    /cu[eé]ntame/i.test(lower) ||
    /qu[eé] est[aá]n haciendo/i.test(lower)
  ) {
    const termMatch = lower.match(/terminal\s*(\d+|uno|dos|tres|one|two|three)/i);
    const terminalIndex = termMatch ? parseNumberWord(termMatch[1]) : undefined;
    return { kind: 'SUMMARIZE_AND_SPEAK', terminalIndex, target: terminalIndex };
  }

  // 4. Close terminals / agents (handles seseo: sierra, serrar, and named agents e.g. "Orion")
  // S4: a subordinate purpose clause ("abre una terminal para cerrar los issues")
  // belongs to the main open verb, not to close_terminals.
  const closeMatch = hasSubordinateCloseClause(lower) ? null : text.match(CLOSE_TARGET_RE);
  if (closeMatch) {
    const rawTarget = (closeMatch[1] || '').replace(/[.,;!?]+$/, '').trim();
    const targetLower = rawTarget.toLowerCase();

    // S4: never resolve a non-terminal UI object with a number onto a terminal.
    if (referencesNonTerminalUiObject(rawTarget)) {
      return { kind: 'UNKNOWN' };
    }

    // Check if user meant close browser or session logout
    if (
      !targetLower.includes('navegador') &&
      !targetLower.includes('browser') &&
      !targetLower.includes('sesi[oó]n de') &&
      !targetLower.includes('sesion de') &&
      !targetLower.includes('cuenta')
    ) {
      if (
        !rawTarget ||
        targetLower === 'terminal' ||
        targetLower === 'agente' ||
        targetLower === 'agentes'
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'finished' };
      }
      if (
        targetLower === 'terminales' ||
        targetLower === 'las terminales' ||
        targetLower === 'los terminales' ||
        targetLower === 'las abiertas' ||
        targetLower === 'todas las terminales' ||
        /^(?:(?:las?|los?|todas?\s+las?)\s+)?terminales(?:\s+(?:abiertas?|que\s+est[aá]n\s+abiertas?|en\s+ejecuci[oó]n))?$/i.test(targetLower) ||
        /^(?:(?:las?|los?)\s+)?(?:que\s+(?:est[aá]n\s+)?abiertas?|abiertas?)$/i.test(targetLower)
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'all' };
      }

      // Check for quantifier patterns: e.g. "una de las terminales de anti-gravity", "2 terminales de grok", "una de las terminales", "las dos terminales que están abiertas"
      const quantifierMatch = rawTarget.match(
        /^(?:(?:las?|los?|unas?|unos?)\s+)?(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|\d+)\s+(?:de\s+(?:las?|los?)\s+)?(?:terminales?|agentes?|consolas?|paneles?|procesos?)?(?:\s*(?:de|con|en)\s+(.+)|(?:\s+(.+)))?$/i
      );
      if (quantifierMatch) {
        const count = parseNumberWord(quantifierMatch[1]);
        const remainder = (quantifierMatch[2] || quantifierMatch[3] || '').trim();
        const remainderLower = remainder.toLowerCase();

        if (
          !remainder ||
          /^(?:que\s+(?:est[aá]n\s+)?(?:abiertas?|activas?|corriendo|en\s+ejecuci[oó]n|en\s+espera)?(?:\s+actualmente)?|actuales|actualmente|abiertas?|activas?|que\s+tengo(?:\s+abiertas?)?|que\s+hay(?:\s+abiertas?)?|que\s+le\s+ped[ií]|que\s+ped[ií]|que\s+abriste)$/i.test(remainderLower)
        ) {
          return { kind: 'CLOSE_TERMINALS', count, target: 'all' };
        }
        // If remainder contains explicit indices: e.g. "que están vacías, que es la terminal uno y dos"
        const subIndices = extractTerminalIndices(remainder);
        if (subIndices.length > 1) {
          return {
            kind: 'CLOSE_TERMINALS',
            count: subIndices.length,
            target: subIndices.join(', '),
            targets: subIndices.map(String),
          };
        }
        if (
          remainderLower.includes('terminada') ||
          remainderLower.includes('finished') ||
          remainderLower.includes('completada') ||
          remainderLower.includes('done')
        ) {
          return { kind: 'CLOSE_TERMINALS', count, target: 'finished' };
        }
        if (
          remainderLower.includes('inactiva') ||
          remainderLower.includes('idle') ||
          remainderLower.includes('vacía') ||
          remainderLower.includes('vacia')
        ) {
          return { kind: 'CLOSE_TERMINALS', count, target: 'idle' };
        }
        if (remainderLower.includes('activa') || remainderLower.includes('active')) {
          return { kind: 'CLOSE_TERMINALS', count, target: 'active' };
        }
        const engine = detectEngineFromText(remainder);
        if (engine) {
          return { kind: 'CLOSE_TERMINALS', count, target: engine };
        }
        const cleanedRemainder = remainder
          .replace(/^(?:terminal|terminales|agente|agentes|proceso|sesi[oó]n|de)\s+/i, '')
          .replace(/[.,;!?]+$/, '')
          .trim();
        return { kind: 'CLOSE_TERMINALS', count, target: cleanedRemainder || 'all' };
      }

      // Check numeric terminals first (single or compound: e.g. "terminal 2", "terminal uno que está vacía")
      const rawIndices = extractTerminalIndices(rawTarget);
      if (rawIndices.length > 1) {
        return {
          kind: 'CLOSE_TERMINALS',
          count: rawIndices.length,
          target: rawIndices.join(', '),
          targets: rawIndices.map(String),
        };
      }
      if (rawIndices.length === 1 && !detectEngineFromText(rawTarget)) {
        return { kind: 'CLOSE_TERMINALS', target: String(rawIndices[0]) };
      }

      if (
        targetLower.includes('terminada') ||
        targetLower.includes('finished') ||
        targetLower.includes('completada') ||
        targetLower.includes('done')
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'finished' };
      }
      if (
        targetLower.includes('inactiva') ||
        targetLower.includes('idle') ||
        targetLower.includes('vacía') ||
        targetLower.includes('vacia')
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'idle' };
      }
      if (
        targetLower.includes('todas') ||
        targetLower.includes('todos') ||
        targetLower.includes('all')
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'all' };
      }
      if (targetLower.includes('activa') || targetLower.includes('active')) {
        return { kind: 'CLOSE_TERMINALS', target: 'active' };
      }
      if (
        targetLower.includes('última') ||
        targetLower.includes('ultima') ||
        targetLower.includes('last')
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'last' };
      }

      // Check engine directly from rawTarget (e.g. "terminal de antigravity", "antigravity", "grok")
      const engineTarget = detectEngineFromText(rawTarget);
      if (engineTarget) {
        return { kind: 'CLOSE_TERMINALS', target: engineTarget };
      }

      // Clean prefix if it says "terminal Orion" or "agente Orion" or "terminal de Orion"
      const cleanedTarget = rawTarget
        .replace(/^(?:terminal|terminales|agente|agentes|proceso|sesi[oó]n)\s+(?:de\s+)?/i, '')
        .replace(/[.,;!?]+$/, '')
        .trim();

      if (cleanedTarget) {
        return { kind: 'CLOSE_TERMINALS', target: cleanedTarget };
      }
      return { kind: 'CLOSE_TERMINALS', target: 'finished' };
    }
  }

  // 5. Open browser
  if (
    /(?:abre|abrir|abran|open|ir\s+a|navega|navegar|lanza|levantar)\b/i.test(lower) &&
    (lower.includes('navegador') ||
      lower.includes('browser') ||
      lower.includes('web') ||
      /https?:\/\//i.test(lower))
  ) {
    const urlMatch = text.match(/(https?:\/\/[^\s]+|[a-zA-Z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i);
    return {
      kind: 'OPEN_BROWSER',
      url: urlMatch ? urlMatch[1] : 'https://google.com',
    };
  }

  // 6. Inject prompt
  if (lower.includes('inyecta') || lower.includes('escribe') || lower.includes('inject')) {
    const agentInjectMatch = text.match(
      /(?:en\s+(?:la\s+)?terminal\s+de\s+|en\s+(?:el\s+)?agente\s+)([a-záéíóúñ]+)\s*(?:escribe|inyecta|ejecuta|corre)?\s*[:,-]?\s*(.+)$/i
    );
    if (agentInjectMatch) {
      const rawTarget = agentInjectMatch[1].trim();
      const matchedCodename = AGENT_CODENAMES.find((c) => c.toLowerCase() === rawTarget.toLowerCase());
      const prompt = agentInjectMatch[2].trim().replace(/^:/, '');
      if (prompt) {
        return {
          kind: 'INJECT_PROMPT',
          target: matchedCodename || rawTarget,
          prompt,
        };
      }
    }

    const injectMatch = text.match(/terminal\s*(\d+|uno|dos|tres)[\s:]+(.+)$/i);
    if (injectMatch) {
      return {
        kind: 'INJECT_PROMPT',
        terminalIndex: parseNumberWord(injectMatch[1]),
        prompt: injectMatch[2].trim(),
      };
    }
  }

  const TERMINAL_DEIXIS_RE =
    /(?:en la terminal (?:que (?:tengo|est[aá]|ten[ií]a|tenia) abierta|abierta|actual)|en esa terminal|en esta terminal|en la misma terminal)/i;
  const TERMINAL_EXEC_VERBS_RE =
    /(?:abre|abriera|abriese|abrir|ejecuta|ejecute|corre|inicia|inicie|pon|arranca|inyecta|escribe|inject)/i;
  const TERMINAL_READ_QUESTION_RE =
    /(?:com[eé]ntame|comentame|cu[eé]ntame|dime\s+qu[eé]|qu[eé]\s+hay|qu[eé]\s+hab[ií]a|qu[eé]\s+tiene|qu[eé]\s+contiene|qu[eé]\s+dice|en\s+pocas\s+palabras|expl[ií]came|describe|qu[eé]\s+es\s+lo\s+que\s+hay|qu[eé]\s+es\s+lo\s+que\s+hab[ií]a|resum(?:e|ir|en|o|a|i)|narr(?:a|ame|ar))/i;
  const TERMINAL_REFERENCE_RE =
    /(?:en la terminal|en esa terminal|en esta terminal|en la misma terminal|\bterminal\s*(?:\d+|uno|dos|tres|one|two|three))/i;

  // 6a. Read-only questions about terminal content (must run before inject-into-existing)
  if (TERMINAL_READ_QUESTION_RE.test(lower) && TERMINAL_REFERENCE_RE.test(lower)) {
    if (!TERMINAL_EXEC_VERBS_RE.test(lower)) {
      let target: string | number | undefined;
      if (TERMINAL_DEIXIS_RE.test(lower)) {
        target = 'active';
      }
      const termMatch = lower.match(/terminal\s*(\d+|uno|dos|tres|one|two|three)/i);
      const terminalIndex = termMatch ? parseNumberWord(termMatch[1]) : undefined;
      if (terminalIndex !== undefined) {
        target = terminalIndex;
      }
      return { kind: 'SUMMARIZE_AND_SPEAK', target, terminalIndex };
    }
  }

  // 6b. Inject into existing open terminal (e.g. "en la terminal que tenía abierta abre antigravity", "en esa terminal abre...")
  const existingTermPattern =
    /(?:en la terminal (?:que (?:tengo|est[aá]|ten[ií]a|tenia) abierta|abierta|actual)|en esa terminal|en esta terminal|en la misma terminal)\s*(?:que\s+)?(?:abre|abriera|abriese|abrir|ejecuta|ejecute|corre|inicia|inicie|pon|arranca|inyecta|escribe|inject)?\s*(.+)?/gi;
  for (const existingTermMatch of lower.matchAll(existingTermPattern)) {
    const matchedClause = existingTermMatch[0];
    const rest = (existingTermMatch[1] || '').replace(/[.,;!?]+$/, '').trim();
    const hasExecVerb = TERMINAL_EXEC_VERBS_RE.test(matchedClause);
    const detectedEngine = rest ? detectEngineFromText(rest) : undefined;
    if (!hasExecVerb && !detectedEngine) {
      continue;
    }
    let cmd: string | undefined;
    if (detectedEngine === 'antigravity') {
      cmd = 'agy';
    } else if (detectedEngine) {
      cmd = detectedEngine;
    } else if (rest) {
      cmd = rest.replace(/^(?:que|de|a)\s+/i, '').trim();
    }
    if (cmd) {
      return {
        kind: 'INJECT_PROMPT',
        target: 'active',
        prompt: cmd,
      };
    }
  }

  // 6c. Resumir / narrar sin abrir terminales (evita confundir "resumir la tarea" con spawn Grok)
  if (/resum(?:e|ir|en|o|a|i)\b/i.test(lower) || /\bnarr(?:a|ame|ar)\b/i.test(lower)) {
    const hasExplicitOpen =
      /(?:abre|abrir|abriera|abrieras|abriese|abriesen|abrir[ií]a|abrime|ábreme|abrí|abran|abras|crea|crear|crees|creas|levanta|levantar|levantes|inicia|iniciar|inicies|pon|poner|pongas|open|spawn|lanza|lanzar|lances|lanzame|lánzame)\s+(?:\d+|un|una|uno|dos|tres|cuatro|cinco|\w+\s+)?(?:terminal|terminales|agente|agentes|consola|consolas)\b/i.test(
        lower
      );
    if (!hasExplicitOpen) {
      let target: string | number | undefined;
      if (TERMINAL_DEIXIS_RE.test(lower)) {
        target = 'active';
      }
      const termMatch = lower.match(/terminal\s*(\d+|uno|dos|tres|one|two|three)/i);
      const terminalIndex = termMatch ? parseNumberWord(termMatch[1]) : undefined;
      if (terminalIndex !== undefined) {
        target = terminalIndex;
      }
      return { kind: 'SUMMARIZE_AND_SPEAK', terminalIndex, target };
    }
  }

  // 7. Spawn terminals
  const hasQuestionForCount = /(?<![a-záéíóúñ])(?:cu[aá]ntos?|cu[aá]ntas?|cu[aá]l\s+es\s+la\s+cantidad|qu[eé]\s+cantidad)(?![a-záéíóúñ])/i.test(lower);
  if (
    !hasQuestionForCount &&
    OPEN_VERB_RE.test(lower) &&
    /(?<![a-záéíóúñ])(?:terminal|terminales|agente|agentes|consola|consolas)(?![a-záéíóúñ])/i.test(lower)
  ) {
    let count = 1;
    const countMatch = lower.match(
      new RegExp(
        `(?:${OPEN_VERB_SOURCE})(?:\\s+(?:las|los|unas|unos|mis|tus|las\\s+siguientes|que\\s+abras|que\\s+lances))?\\s*(\\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|one|two|three|four|five)?\\s*(?:terminal|terminales|agente|agentes|consola|consolas)`,
        'i'
      )
    );
    if (countMatch && countMatch[1]) {
      count = parseNumberWord(countMatch[1]);
    } else {
      const standaloneNumMatch = lower.match(
        /(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|one|two|three|four|five)\s*(?:terminal|terminales|agente|agentes|consola|consolas)/i
      );
      if (standaloneNumMatch && standaloneNumMatch[1]) {
        count = parseNumberWord(standaloneNumMatch[1]);
      }
    }

    const hasSecondAgentRef = /(?:el otro|el segundo|la otra|la segunda)\s*(?:agente|terminal|consola)?/i.test(lower);
    if (hasSecondAgentRef) {
      count = Math.max(count, 2);
    }

    // Extract prompt/task with subordinate clause support
    let prompt: string | undefined;

    const subClauseMatch = text.match(
      /(?:en ellas|en ellos|en cada una|en ambas|donde)\s*(?:abrir[aá]|abre|abrir|abrirás|ejecuta|ejecute|ejecutar|corre|corra|correr|corré|usa)?\s*(?:grok|claude|codex|antigravity|anti[- ]?gravity|opencode|powershell)?\s*(?:y\s+)?(.+)$/i
    );
    if (subClauseMatch && subClauseMatch[1]) {
      prompt = subClauseMatch[1].replace(/^[,\s;]+|[.,;]+$/g, '').trim();
    }

    if (!prompt) {
      const taskMatch = text.match(
        /(?:con la tarea|tarea|prompt|para|con instrucci[oó]n|diciendo|orden)\s+(.+)$/i
      );
      if (taskMatch) {
        prompt = taskMatch[1].replace(/^[,\s;]+|[.,;]+$/g, '').trim();
      }
    }

    if (!prompt) {
      const connectiveMatch = text.match(
        /\b(?:terminal|terminales|agente|agentes|consola|consolas)(?:\s+(?:con|en|usando|de)\s+[a-z0-9_ -]+)?\s+y\s+(.+)$/i
      );
      if (connectiveMatch) {
        prompt = connectiveMatch[1].replace(/^[,\s;]+|[.,;]+$/g, '').trim();
      }
    }

    if (prompt) {
      // "abre una terminal y ejecuta git status" -> the prompt is the shell command
      // itself, but "corré los tests" keeps its verb (the object is not a command).
      const stripped = prompt.replace(
        /^(?:que\s+)?(?:ejecuta(?:r)?|ejecut[aá]|corre(?:r)?|corr[eé]|lanza(?:r)?|lanz[aá])\s+(?:el\s+comando\s+|la\s+orden\s+|lo\s+siguiente\s*:?\s*)?/i,
        ''
      );
      if (stripped !== prompt && SHELL_COMMAND_HEAD_RE.test(stripped.trim())) {
        prompt = stripped;
      }
      prompt = prompt.trim();
    }

    // S3: the engine only comes from the open/agent clause — never from words inside
    // the task prompt ("abre dos terminales para revisar el bug de claude" is powershell).
    const detectedEngine = detectEngineForOpenClause(lower);
    const isExplicitAgent = /\b(?:agente|agentes|subagente|subagentes)\b/i.test(lower);
    const engine = detectedEngine || (isExplicitAgent ? 'grok' : 'powershell');

    let prompts: string[] | undefined;
    if (prompt) {
      const split = splitCompoundPrompts(prompt);
      if (split.length > 1) {
        prompts = split;
        count = Math.max(count, split.length);
      } else {
        prompts = [prompt];
      }
    }

    return {
      kind: 'SPAWN_TERMINALS',
      count,
      engine,
      prompt: prompts?.[0] || prompt,
      prompts,
    };
  }

  return { kind: 'UNKNOWN' };
}

import {
  parseHandoffIntent,
  describeHandoff,
} from './handoffIntent';
import {
  parsePaneLayoutIntent,
  describePaneLayout,
} from './paneLayoutIntent';
import {
  type WorkspaceSwitchIntent,
  parseWorkspaceSwitchIntent,
  parseLaunchThreadIntent,
} from './workspaceThreadIntent';

export {
  parseHandoffIntent,
  describeHandoff,
  parsePaneLayoutIntent,
  describePaneLayout,
  type WorkspaceSwitchIntent,
  parseWorkspaceSwitchIntent,
  parseLaunchThreadIntent,
};

/**
 * Plans a turn deterministically using the heuristic engine.
 */
export function planTurnHeuristic(input: string): OperatorPlan {
  const text = normalizeInputForIntent(input);

  // S4: a negated imperative must never open or close anything.
  if (isNegatedTerminalImperative(text)) {
    return {
      strategy: 'heuristic',
      actions: [],
      reply: 'Entendido. No abriré ni cerraré ninguna terminal.',
    };
  }

  // S4/Compound: support compound multi-intent commands like "Abre terminal de antigravity y cierra la vacía"
  const compoundMatch = text.match(
    /^(.+?)\s+(?:y|luego|despu[eé]s|adem[aá]s)\s+((?:cierra|abre|inicia|crea|lanza|inyecta|resume|narr[aá]|divide|iguala|enfoca)\b.+)$/i
  );
  if (compoundMatch) {
    const part1 = compoundMatch[1].trim();
    const part2 = compoundMatch[2].trim();
    // Do not split commands where 'y' introduces a shell command prompt (e.g. "abre terminal y ejecuta npm test")
    const isShellCommandCarrier = /^(?:ejecuta|corre|pon|haz)\s+/i.test(part2);
    if (!isShellCommandCarrier) {
      const plan1 = planTurnHeuristic(part1);
      const plan2 = planTurnHeuristic(part2);
      if (plan1.actions.length > 0 && plan2.actions.length > 0) {
        return {
          strategy: 'heuristic',
          actions: [...plan1.actions, ...plan2.actions],
          reply: `${plan1.reply} ${plan2.reply}`.trim(),
        };
      }
    }
  }

  // S9: workspace switching, optionally followed by actions requested in the same sentence.
  const workspaceSwitch = parseWorkspaceSwitchIntent(text);
  if (workspaceSwitch) {
    const switchAction: SwitchWorkspaceAction = {
      type: 'switch_workspace',
      workspaceQuery: workspaceSwitch.workspaceQuery,
      ...(workspaceSwitch.viewMode ? { viewMode: workspaceSwitch.viewMode } : {}),
    };
    const actions: OperatorPlan['actions'] = [switchAction];
    let reply = `Cambiando al proyecto o workspace "${workspaceSwitch.workspaceQuery}".`;

    if (workspaceSwitch.tail && workspaceSwitch.tail !== text) {
      const tailPlan = planTurnHeuristic(workspaceSwitch.tail);
      actions.push(...tailPlan.actions);
      if (tailPlan.reply) {
        reply = `${reply} ${tailPlan.reply}`;
      }
    }

    return { strategy: 'heuristic', actions, reply };
  }

  // S7: multi-agent ODD handoff / terminal-to-terminal piping.
  const handoff = parseHandoffIntent(text);
  if (handoff) {
    return {
      strategy: 'heuristic',
      actions: [handoff],
      reply: describeHandoff(handoff),
    };
  }

  // S8: spatial pane control (equalize, split, focus, zoom). An explicit
  // open/spawn request wins so the layout verbs cannot hijack it.
  const lowerText = text.toLowerCase();
  const hasOpenRequest =
    OPEN_VERB_RE.test(lowerText) &&
    /(?<![a-záéíóúñ])(?:terminal|terminales|agente|agentes|consola|consolas)(?![a-záéíóúñ])/i.test(
      lowerText
    );
  if (!hasOpenRequest) {
    const paneLayout = parsePaneLayoutIntent(text);
    if (paneLayout) {
      return {
        strategy: 'heuristic',
        actions: [paneLayout],
        reply: describePaneLayout(paneLayout),
      };
    }
  }

  // S3: launch or message a thread through the dispatch family.
  const launchThread = parseLaunchThreadIntent(text);
  if (launchThread) {
    const threadDesc = launchThread.threadId
      ? launchThread.threadId === 'active'
        ? 'el hilo actual'
        : `el hilo "${launchThread.threadId}"`
      : 'un nuevo hilo';
    const providerDesc = launchThread.provider ? ` con ${launchThread.provider}` : '';
    const bodyDesc = launchThread.body ? ` para "${launchThread.body}"` : '.';
    return {
      strategy: 'heuristic',
      actions: [launchThread],
      reply: `Abriendo ${threadDesc}${providerDesc}${bodyDesc}`,
    };
  }

  const intent = parseOperatorIntent(text);

  switch (intent.kind) {
    case 'STOP_SPEAKING':
      return {
        strategy: 'heuristic',
        actions: [{ type: 'stop_speaking' }],
        reply: 'Lectura en voz alta detenida.',
      };

    case 'SPAWN_TERMINALS': {
      const count = Math.min(8, Math.max(1, intent.count || 1));
      const engine = (intent.engine?.toLowerCase() || 'powershell') as Engine;
      const prompts = intent.prompts || (intent.prompt ? [intent.prompt] : undefined);
      const promptText = intent.prompt ? ` para "${intent.prompt}"` : '';

      return {
        strategy: 'heuristic',
        actions: [
          {
            type: 'open_terminals',
            count,
            engine,
            prompts,
          },
        ],
        reply: `Abriendo ${count} ${count === 1 ? 'terminal' : 'terminales'} con ${engine}${promptText}.`,
      };
    }

    case 'CLOSE_TERMINALS': {
      const target = intent.target || 'finished';
      const count = intent.count;
      let desc = String(target);
      if (intent.targets && intent.targets.length > 1) {
        desc = `las terminales ${intent.targets.join(' y ')}`;
      } else if (target === 'finished') desc = count === 1 ? 'una terminal terminada' : count ? `${count} terminales terminadas` : 'las terminales terminadas';
      else if (target === 'idle') desc = count === 1 ? 'una terminal inactiva' : count ? `${count} terminales inactivas` : 'las terminales inactivas';
      else if (target === 'all') desc = count === 1 ? 'una terminal' : count ? `${count} terminales` : 'todas las terminales';
      else if (target === 'active') desc = count === 1 ? 'una terminal activa' : count ? `${count} terminales activas` : 'las terminales activas';
      else if (target === 'last') desc = 'la última terminal';
      else if (typeof target === 'number' || /^\d+$/.test(String(target))) desc = `la terminal ${target}`;
      else desc = count === 1 ? `una terminal de ${target}` : count ? `${count} terminales de ${target}` : `el agente ${target}`;

      return {
        strategy: 'heuristic',
        actions: [
          {
            type: 'close_terminals',
            target: intent.targets && intent.targets.length > 1 ? intent.targets.join(', ') : target,
            ...(count ? { count } : {}),
          },
        ],
        reply: `Cerrando ${desc}.`,
      };
    }

    case 'OPEN_BROWSER':
      return {
        strategy: 'heuristic',
        actions: [{ type: 'open_browser', url: intent.url || 'https://google.com' }],
        reply: `Abriendo navegador en ${intent.url || 'https://google.com'}.`,
      };

    case 'INJECT_PROMPT':
      return {
        strategy: 'heuristic',
        actions: [
          {
            type: 'inject_prompt',
            target: intent.target || intent.terminalIndex || 1,
            prompt: intent.prompt || '',
          },
        ],
        reply: intent.target === 'active'
          ? `Iniciando comando en la terminal abierta.`
          : `Inyectando instrucción en ${typeof (intent.target || intent.terminalIndex) === 'number' ? `terminal ${intent.target || intent.terminalIndex}` : `el agente ${intent.target}`}.`,
      };

    case 'SUMMARIZE_AND_SPEAK': {
      const target = intent.target ?? intent.terminalIndex;
      let replyDesc = 'las terminales activas';
      if (typeof target === 'number') {
        replyDesc = `la terminal ${target}`;
      } else if (typeof target === 'string' && target.trim()) {
        replyDesc = `el agente ${target}`;
      }
      return {
        strategy: 'heuristic',
        actions: [
          {
            type: 'narrate_summary',
            target,
          },
        ],
        reply: `Leyendo resumen de ${replyDesc}.`,
      };
    }

    case 'SPAWN_SUBAGENT':
      return {
        strategy: 'heuristic',
        actions: [
          {
            type: 'spawn_subagent',
            cli: (intent.cli?.toLowerCase() || 'grok') as Engine,
            task: intent.prompt || 'tarea delegada',
          },
        ],
        reply: `Iniciando subagente ${intent.cli || 'grok'}.`,
      };

    case 'UNKNOWN':
    default:
      return {
        strategy: 'heuristic',
        actions: [],
        answer: undefined,
        reply: undefined,
      };
  }
}
