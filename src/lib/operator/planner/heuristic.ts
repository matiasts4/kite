// Kite Code — Operator Heuristic Planner
// Deterministic Spanish-first parser for voice and text commands.
// Resilient to STT punctuation anomalies, seseo phonetic spelling, and subjunctive verbs.

import type { OperatorPlan, Engine } from '../contract';
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
  url?: string;
  terminalIndex?: number;
  cli?: string;
}

export function detectEngineFromText(text: string): Engine | undefined {
  const lower = text.toLowerCase();

  // Antigravity (Anti-Gravity, Anti Gravity, The Gravity, De Gravity, Antigravedad, agy)
  if (/\b(?:(?:anti|the|de|te)[- ]?gravit(?:y|i|ad)|anti[- ]?gravedad|antigravity|antigravedad|agy)\b/i.test(lower)) {
    return 'antigravity';
  }
  // Claude (Claude Code, Anthropic)
  if (/\b(?:claude(?:[- ]code)?|clod|anthropic|antropic)\b/i.test(lower)) {
    return 'claude';
  }
  // Codex (OpenAI Codex, Code-X)
  if (/\b(?:codex|code[- ]x|openai(?:\s+codex)?)\b/i.test(lower)) {
    return 'codex';
  }
  // OpenCode (Open-Code)
  if (/\b(?:open[- ]code|opencode)\b/i.test(lower)) {
    return 'opencode';
  }
  // Grok (xAI, Groc)
  if (/\b(?:grok|groc|xai|x\.ai)\b/i.test(lower)) {
    return 'grok';
  }
  // PowerShell / Shell / Terminal
  if (/\b(?:powershell|power[- ]shell|bash|cmd)\b/i.test(lower)) {
    return 'powershell';
  }

  return undefined;
}

export function splitCompoundPrompts(text: string): string[] {
  if (!text) return [];

  // Match: "[prefix] uno para [Task 1] ... [y] el otro agente [enfocado en] [Task 2]"
  const pattern1 = /(?:uno|el primero|el primer agente|la primera terminal)\s*(?:para|que|enfocado en)?\s*(.+?)\s*(?:[.,;]+|\by\b)\s*(?:el otro agente|el segundo agente|el otro|la otra terminal|la segunda terminal|el segundo)\s*(?:tiene que estar enfocado en|enfocado en|para|que|se encargue de|haga|sea)?\s*(.+)$/i;
  const match1 = text.match(pattern1);
  if (match1 && match1[1] && match1[2]) {
    const t1 = match1[1].replace(/^[,\s;]+|[.,;]+$/g, '').trim();
    const t2 = match1[2].replace(/^[,\s;]+|[.,;]+$/g, '').trim();
    if (t1 && t2) return [t1, t2];
  }

  // Match: "[Task 1] ... [.,;] [y] el otro agente [enfocado en] [Task 2]"
  const pattern2 = /(.+?)\s*(?:[.,;]+|\by\b)\s*(?:el otro agente|el segundo agente|el otro|la otra terminal|la segunda terminal)\s*(?:tiene que estar enfocado en|enfocado en|para|que|se encargue de|haga|sea)?\s*(.+)$/i;
  const match2 = text.match(pattern2);
  if (match2 && match2[1] && match2[2]) {
    const t1 = match2[1].replace(/^[,\s;]+|[.,;]+$/g, '').trim();
    const t2 = match2[2].replace(/^[,\s;]+|[.,;]+$/g, '').trim();
    if (t1 && t2) return [t1, t2];
  }

  return [text.trim()];
}

export function parseNumberWord(word: string): number {
  const map: Record<string, number> = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };
  const parsed = parseInt(word, 10);
  if (!Number.isNaN(parsed)) return parsed;
  return map[word.toLowerCase()] || 1;
}

export function normalizeInputForIntent(raw: string): string {
  if (!raw) return '';
  let clean = raw.trim();

  // Normalize STT pauses e.g. "dos. Terminales" or "1. Terminal"
  clean = clean.replace(
    /\b(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|\d+)\s*\.\s*(terminal|terminales|agente|agentes|consola|consolas|ventana|ventanas)\b/gi,
    '$1 $2'
  );

  return clean;
}

export function parseOperatorIntent(rawText: string): LegacyOperatorIntent {
  const text = normalizeInputForIntent(rawText);
  const lower = text.toLowerCase();

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

  if (
    lower.includes('resumen') ||
    lower.includes('summary') ||
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
  const closeMatch = text.match(
    /\b(?:cierra|cerrar|cierre|cierren|sierra|serrar|sierre|sierren|close|kill|mata|matar|maten|termina|terminar|terminen|elimina|eliminar|eliminen|apaga|apagar|apaguen)\b(?:\s+(?:a|al|el|la|los|las|the))?(?:\s+(.+))?$/i
  );
  if (closeMatch) {
    const rawTarget = (closeMatch[1] || '').trim();
    const targetLower = rawTarget.toLowerCase();

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
        targetLower === 'terminales' ||
        targetLower === 'agente' ||
        targetLower === 'agentes'
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'finished' };
      }
      if (
        targetLower.includes('terminada') ||
        targetLower.includes('finished') ||
        targetLower.includes('completada') ||
        targetLower.includes('done')
      ) {
        return { kind: 'CLOSE_TERMINALS', target: 'finished' };
      }
      if (targetLower.includes('inactiva') || targetLower.includes('idle')) {
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

      // Check numeric terminal (e.g. "terminal 2", "terminal dos", "panel 1")
      const numMatch = rawTarget.match(
        /(?:terminal|pantalla|panel)?\s*(\d+|uno|dos|tres|cuatro|cinco|one|two|three|four|five)$/i
      );
      if (numMatch && numMatch[1]) {
        return { kind: 'CLOSE_TERMINALS', target: String(parseNumberWord(numMatch[1])) };
      }

      // Clean prefix if it says "terminal Orion" or "agente Orion"
      const cleanedTarget = rawTarget
        .replace(/^(?:terminal|terminales|agente|agentes|proceso|sesi[oó]n)\s+/i, '')
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
    /(?:com[eé]ntame|comentame|cu[eé]ntame|dime\s+qu[eé]|qu[eé]\s+hay|qu[eé]\s+hab[ií]a|qu[eé]\s+tiene|qu[eé]\s+contiene|qu[eé]\s+dice|en\s+pocas\s+palabras|expl[ií]came|describe|qu[eé]\s+es\s+lo\s+que\s+hay|qu[eé]\s+es\s+lo\s+que\s+hab[ií]a)/i;
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

  // 7. Spawn terminals
  if (
    /(?:abre|abrir|abriera|abrieras|abriese|abriesen|abrir[ií]a|abrime|ábreme|abrí|abran|abras|crea|crear|crees|creas|levanta|levantar|levantes|inicia|iniciar|inicies|pon|poner|pongas|open|spawn|lanza|lanzar|lances|lanzame|lánzame)/i.test(
      lower
    ) &&
    /(?:terminal|terminales|agente|agentes|consola|consolas)/i.test(lower)
  ) {
    let count = 1;
    const countMatch = lower.match(
      /(?:abre|abrir|abriera|abrieras|abriese|abriesen|abrir[ií]a|abrime|ábreme|abrí|abran|abras|crea|crear|crees|creas|levanta|levantar|levantes|inicia|iniciar|inicies|pon|poner|pongas|open|spawn|lanza|lanzar|lances|lanzame|lánzame)(?:\s+(?:las|los|unas|unos|mis|tus|las\s+siguientes|que\s+abras|que\s+lances))?\s*(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|one|two|three|four|five)?\s*(?:terminal|terminales|agente|agentes|consola|consolas)/i
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

    const detectedEngine = detectEngineFromText(lower);
    const engine = detectedEngine || 'grok';

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

/**
 * Plans a turn deterministically using the heuristic engine.
 */
export function planTurnHeuristic(input: string): OperatorPlan {
  const intent = parseOperatorIntent(input);

  switch (intent.kind) {
    case 'STOP_SPEAKING':
      return {
        strategy: 'heuristic',
        actions: [{ type: 'stop_speaking' }],
        reply: 'Lectura en voz alta detenida.',
      };

    case 'SPAWN_TERMINALS': {
      const count = Math.min(8, Math.max(1, intent.count || 1));
      const engine = (intent.engine?.toLowerCase() || 'grok') as Engine;
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
      let desc = String(target);
      if (target === 'finished') desc = 'las terminales terminadas';
      else if (target === 'idle') desc = 'las terminales inactivas';
      else if (target === 'all') desc = 'todas las terminales';
      else if (target === 'active') desc = 'las terminales activas';
      else if (target === 'last') desc = 'la última terminal';
      else if (typeof target === 'number' || /^\d+$/.test(String(target))) desc = `la terminal ${target}`;
      else desc = `el agente ${target}`;

      return {
        strategy: 'heuristic',
        actions: [{ type: 'close_terminals', target }],
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
