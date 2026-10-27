// Kite Code — Operator Heuristic Planner
// Deterministic Spanish-first parser for voice and text commands.
// Resilient to STT punctuation anomalies, seseo phonetic spelling, and subjunctive verbs.

import type {
  OperatorPlan,
  Engine,
  HandoffToAgentAction,
  ManagePaneLayoutAction,
  PaneLayoutOperation,
  SwitchWorkspaceAction,
  WorkspaceViewMode,
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

// ---------------------------------------------------------------------------
// Shared verb sources & safety guards (S3 / S4)
// ---------------------------------------------------------------------------

const CLOSE_VERB_SOURCE =
  'cierra|cerrar|cierre|cierres|cierren|ci[eé]rral[ao]s?|ci[eé]rrenl[ao]s?|ci[eé]rrel[ao]s?|ci[eé]rrame|cerr[aá]l[ao]s?|sierra|serrar|sierre|sierres|sierren|close|kill|mata|matar|mates|maten|m[aá]tal[ao]s?|m[aá]tenl[ao]s?|termina|terminar|termines|terminen|term[ií]nal[ao]s?|elimina|eliminar|elimines|eliminen|elim[ií]nal[ao]s?|apaga|apagar|apagues|apaguen|ap[aá]gal[ao]s?|borra|borrar|borres|borren';

const OPEN_VERB_SOURCE =
  'abre|abrir|abriera|abrieras|abriese|abriesen|abrir[ií]a|abrime|ábreme|abrí|abran|abras|crea|crear|crees|creas|levanta|levantar|levantes|inicia|iniciar|inicies|pon|poner|pongas|open|spawn|lanza|lanzar|lances|lanzame|lánzame';

const CLOSE_VERB_RE = new RegExp(`(?<![a-záéíóúñ])(?:${CLOSE_VERB_SOURCE})(?![a-záéíóúñ])`, 'i');

const CLOSE_TARGET_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${CLOSE_VERB_SOURCE})(?![a-záéíóúñ])(?:\\s+(?:a|al|el|la|los|las|the))?(?:\\s+(.+))?$`,
  'i'
);

const OPEN_VERB_RE = new RegExp(`(?<![a-záéíóúñ])(?:${OPEN_VERB_SOURCE})(?![a-záéíóúñ])`, 'i');

const AGENT_CODENAME_WORD_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${AGENT_CODENAMES.join('|')})(?![a-záéíóúñ])`,
  'i'
);

// Nouns that address a different UI surface than an agent terminal.
const NON_TERMINAL_UI_NOUN_RE =
  /(?<![a-záéíóúñ])(?:pesta[ñn]as?|tabs?|panel(?:es)?|sidebar|barra\s+lateral|men[uú]s?|archivos?|editores?|navegador|chats?|hilos?|threads?|notas?|documentos?)(?![a-záéíóúñ])/i;

// Nouns that unambiguously address a terminal pane.
const COMPATIBLE_TERMINAL_OBJECT_RE =
  /(?<![a-záéíóúñ])(?:terminal|terminales|agente|agentes|consola|consolas|sesi[oó]n|sesiones|pane|panes)(?![a-záéíóúñ])/i;

/**
 * True when a phrase names an object (tab, panel, sidebar…) that is not an agent
 * terminal, so a trailing number must never be resolved to terminal #N.
 */
export function referencesNonTerminalUiObject(phrase: string): boolean {
  if (!phrase) return false;
  if (COMPATIBLE_TERMINAL_OBJECT_RE.test(phrase)) return false;
  if (detectEngineFromText(phrase)) return false;
  if (AGENT_CODENAME_WORD_RE.test(phrase)) return false;
  return NON_TERMINAL_UI_NOUN_RE.test(phrase);
}

/**
 * True when the utterance forbids the action instead of requesting it
 * ("no cierres las terminales", "nunca abras dos terminales", "ninguna terminal").
 */
export function isNegatedTerminalImperative(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (
    /(?<![a-záéíóúñ])(?:no|nunca|jam[aá]s)(?:\s+(?:me|te|se|nos|le|les|lo|la|los|las))?\s+(?:cierr\w*|cerr\w*|sierr\w*|abras?|abris?|abr[aá]s?|lances?|lanc[eé]s?|crees?|cre[eé]s?|mates?|mat[eé]s?|detengas?|termines?|apagues?|elimines?|borres?|pares?|dejes?)(?![a-záéíóúñ])/i.test(
      lower
    )
  ) {
    return true;
  }
  return /\bning[uú]n[ao]s?\s+(?:terminal|terminales|consola|consolas|agente|agentes|pane|panes)\b/i.test(
    lower
  );
}

// Clause introducers that turn a following verb into a purpose/relative clause
// ("abre una terminal para cerrar los issues").
const SUBORDINATE_INTRO_RE =
  /(?:\bpara|\bque|\bde|\bal|\ba\b|\bencargad[oa]\s+de|\by\s+arreglar\s+el\s+[\wáéíóúñ]+\s+de)\s*(?:(?:el|la|los|las|un|una)\s+)?(?:[\wáéíóúñ]+\s+){0,1}$/i;

/**
 * True when a close verb only appears inside a subordinate purpose clause that
 * follows the main open/create verb.
 */
export function hasSubordinateCloseClause(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const openMatch = OPEN_VERB_RE.exec(lower);
  const closeMatch = CLOSE_VERB_RE.exec(lower);
  if (!openMatch || openMatch.index === undefined) return false;
  if (!closeMatch || closeMatch.index === undefined) return false;
  if (closeMatch.index <= openMatch.index) return false;
  return SUBORDINATE_INTRO_RE.test(lower.slice(0, closeMatch.index));
}

// Clause boundaries where the open/target phrase ends and the task body begins.
const OPEN_CLAUSE_BOUNDARY_RE = /(?:\bpara\b|\bque\b|\by\s+ejecuta\b|\by\s+ejecutar\b|\by\s+corre\b|\by\s+correr\b|\by\s+lanza\b|:|,)/;

/**
 * Detects the engine from the open/agent clause only (S3), so words inside a task
 * prompt ("para revisar el bug de claude") can never hijack the engine choice.
 */
export function detectEngineForOpenClause(text: string): Engine | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const openMatch = OPEN_VERB_RE.exec(lower);
  const start = openMatch && openMatch.index !== undefined ? openMatch.index : 0;
  const rest = lower.slice(start);
  const boundary = rest.search(OPEN_CLAUSE_BOUNDARY_RE);
  const openClause = boundary > 0 ? rest.slice(0, boundary) : rest;

  const direct = detectEngineFromText(openClause);
  if (direct) return direct;

  // Agent-application clauses: "en ellas abrirá Grok", "en cada una corre claude".
  const agentClause = lower.match(
    /(?:\ben\s+ellas|\ben\s+ellos|\ben\s+cada\s+una|\ben\s+ambas|\ben\s+todos|\ben\s+las\s+dos)\b(.+?)(?:\by\b|\bque\b|,|$)/i
  );
  if (agentClause) {
    return detectEngineFromText(agentClause[1]);
  }

  return undefined;
}

// Command heads that make a "y ejecuta X" tail a shell command rather than prose.
const SHELL_COMMAND_HEAD_RE =
  /^(?:git|npm|pnpm|yarn|npx|node|bun|deno|python|py|pip|cargo|rustc|go|dotnet|mvn|gradle|make|tsc|ls|dir|cd|cat|type|echo|curl|wget|mkdir|rm|cp|mv|docker|kubectl|pwsh|powershell|bash|sh|gh|code|vi|vim|nvim)\b/i;

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
    nueve: 9,
    diez: 10,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const parsed = parseInt(word, 10);
  if (!Number.isNaN(parsed)) return parsed;
  return map[word.toLowerCase()] || 1;
}

export function extractTerminalIndices(text: string): number[] {
  if (!text) return [];
  // S4: a trailing number only addresses a terminal pane when the phrase is not
  // about another UI object ("cierra la pestaña 2" is not agent terminal #2).
  if (referencesNonTerminalUiObject(text)) return [];
  // Matches tokens like: "terminal 1", "terminales 1 y 2", "la terminal uno y dos", "la 1 y la 2", "1 y 2"
  const regex = /(?<![a-záéíóúñ])(?:terminal(?:es)?\s*)?(?:(?:la|el)\s*)?(\d+|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|one|two|three|four|five|six|seven|eight|nine|ten)(?![a-záéíóúñ])/gi;
  const matches = Array.from(text.matchAll(regex));
  if (matches.length === 0) return [];

  const indices: number[] = [];
  for (const m of matches) {
    const val = parseNumberWord(m[1]);
    if (val > 0 && !indices.includes(val)) {
      indices.push(val);
    }
  }
  return indices;
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

      // Check numeric terminals (single or compound: e.g. "terminal 2", "terminal uno y dos", "terminales 1 y 2", "la 1 y la 2")
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

// ---------------------------------------------------------------------------
// S7 — Multi-agent ODD handoff & terminal-to-terminal piping
// ---------------------------------------------------------------------------

const HANDOFF_VERB_SOURCE =
  'p[aá]sa(?:le|les|lo|la|r)?|p[aá]sales|entrega(?:le|les|lo|la|r)?|delega(?:le|les|lo|la|r)?|env[ií]a(?:le|les|lo|la)?|manda(?:le|les|lo|la)?|traspasa(?:le|les)?|comparte(?:le|les)?|deriva(?:le|les)?|handoff';

const HANDOFF_ARTIFACT_SOURCE =
  'odd|o\\.d\\.d\\.|tarea|plan|salida|output|respuesta|resumen|contexto|conversaci[oó]n|buffer|trabajo';

const HANDOFF_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${HANDOFF_VERB_SOURCE})\\s+(?:el|la|los|las)?\\s*(?:${HANDOFF_ARTIFACT_SOURCE})\\s+(?:de|del)\\s+(.+?)\\s+(?:hacia|para|al|a)\\s+(.+)$`,
  'i'
);

const NEW_TARGET_RE =
  /(?<![a-záéíóúñ])(?:nuev[oa]s?|otr[oa]s?|que\s+abrir[aá]s|que\s+abras|que\s+crear[aá]s|que\s+crees|que\s+lanzar[aá]s|que\s+lances|abrir[aá]s|crear[aá]s)(?![a-záéíóúñ])/i;

function parseExplicitSessionRef(phrase: string): string | number | undefined {
  const clean = phrase.trim().replace(/[.,;!?]+$/, '').trim();
  if (!clean) return undefined;

  const numbered = clean.match(
    /(?:terminal|terminales|agente|agentes|consola|consolas|pane|panes)\s*(?:n[uú]mero\s*)?(\d+|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)/i
  );
  if (numbered) return parseNumberWord(numbered[1]);

  const named = clean.match(
    /(?:llamad[ao]s?|de\s+nombre|denominad[ao]s?)\s+([a-záéíóúñ][a-záéíóúñ0-9_-]*)/i
  );
  if (named) return named[1].toLowerCase();

  return undefined;
}

function parseHandoffSource(phrase: string): string | number | undefined {
  const explicit = parseExplicitSessionRef(phrase);
  if (explicit !== undefined) return explicit;

  const engine = detectEngineFromText(phrase);
  if (engine) return engine;

  const stripped = phrase
    .trim()
    .replace(/[.,;!?]+$/, '')
    .replace(/^(?:la|el|los|las)\s+/i, '')
    .replace(/^(?:terminal|terminales|agente|agentes|consola|consolas|sesi[oó]n)(?:\s+(?:de|del))?\s*/i, '')
    .trim();
  if (!stripped) return undefined;
  if (/^\d+$/.test(stripped)) return Number(stripped);
  return stripped.toLowerCase();
}

/**
 * Parses a Spanish multi-agent handoff request, e.g.
 * "pásale el ODD de la terminal 1 a un nuevo agente de claude".
 */
export function parseHandoffIntent(text: string): HandoffToAgentAction | null {
  if (!text) return null;
  const normalized = normalizeInputForIntent(text);
  const match = normalized.match(HANDOFF_RE);
  if (!match) return null;

  const sourcePhrase = (match[1] || '').trim();
  const targetPhrase = (match[2] || '').trim();
  if (!sourcePhrase || !targetPhrase) return null;

  const sourceTarget = parseHandoffSource(sourcePhrase) ?? 1;
  const targetEngine = detectEngineFromText(targetPhrase);
  const targetSession = parseExplicitSessionRef(targetPhrase);
  const spawnNew = NEW_TARGET_RE.test(targetPhrase) || targetSession === undefined;
  const artifactKind: HandoffToAgentAction['artifactKind'] =
    /(?<![a-záéíóúñ])odd(?![a-záéíóúñ])/i.test(match[0]) ? 'odd' : 'output';

  return {
    type: 'handoff_to_agent',
    sourceTarget,
    ...(targetEngine ? { targetEngine } : {}),
    ...(targetSession !== undefined ? { targetSession } : {}),
    spawnNew,
    artifactKind,
  };
}

function describeHandoff(action: HandoffToAgentAction): string {
  const artifact = action.artifactKind === 'odd' ? 'el ODD' : 'la salida';
  const source =
    typeof action.sourceTarget === 'number'
      ? `la terminal ${action.sourceTarget}`
      : `la terminal "${action.sourceTarget}"`;
  let target: string;
  if (action.spawnNew) {
    target = `un nuevo agente${action.targetEngine ? ` de ${action.targetEngine}` : ''}`;
  } else if (typeof action.targetSession === 'number') {
    target = `la terminal ${action.targetSession}`;
  } else {
    target = `la terminal "${action.targetSession}"`;
  }
  return `Entregando ${artifact} de ${source} a ${target}.`;
}

// ---------------------------------------------------------------------------
// S8 — Spatial pane control (equalize / split / focus / zoom)
// ---------------------------------------------------------------------------

const EQUALIZE_INTENT_RE =
  /(?<![a-záéíóúñ])(?:auto[- ]?ajust\w*|autoajust\w*|iguala(?:r|n|mos|d)?|igual[aá](?:r|mos|n)?|equilibra(?:r|n)?|nivela(?:r|n)?|empareja(?:r|n)?|redistribu\w*|repart(?:e|ir)\s+el\s+espacio)(?![a-záéíóúñ])/i;

const EQUALIZE_SIZE_RE =
  /(?<![a-záéíóúñ])ajust\w*\s+(?:el\s+|la\s+|los\s+|las\s+)?(?:tama[ñn]os?|dimensiones|ancho|alto|paneles|terminales|rejilla|distribuci[oó]n)(?![a-záéíóúñ])/i;

const EQUALIZE_DIMENSIONS_RE =
  /(?:mismas?\s+dimensiones|dimensiones\s+(?:iguales|similares|parejas)|mismo\s+tama[ñn]o|que\s+queden\s+(?:todas?\s+)?(?:iguales|parejas|de\s+las\s+mismas))/i;

const SPLIT_VERB_RE =
  /(?<![a-záéíóúñ])(?:divide|dividir|divid[ae]s?|separa|separar|separe?s?|parte|partir|split)(?![a-záéíóúñ])/i;

const FOCUS_INTENT_RE =
  /(?:haz(?:le)?\s+foco|hacer\s+foco|pon(?:er|le)?\s+(?:el\s+)?foco)|(?<![a-záéíóúñ])(?:enfoca(?:r)?|enf[oó]cate|focaliza(?:r)?|focus)(?![a-záéíóúñ])/i;

const ZOOM_INTENT_RE =
  /(?<![a-záéíóúñ])(?:maximiza(?:r)?|agranda(?:r)?|expande|expandir|ampl[ií]a(?:r)?|zoom|pantalla\s+completa|fullscreen)(?![a-záéíóúñ])/i;

function parseLayoutTarget(text: string): string | number | undefined {
  const numbered = text.match(
    /(?:terminal|terminales|agente|agentes|consola|consolas|panel|paneles|pane|panes)\s*(?:n[uú]mero\s*)?(\d+|uno|dos|tres|cuatro|cinco|seis|siete|ocho)/i
  );
  if (numbered) return parseNumberWord(numbered[1]);

  const named = text.match(
    /(?:llamad[ao]s?|de\s+nombre)\s+([a-záéíóúñ][a-záéíóúñ0-9_-]*)/i
  );
  if (named) return named[1].toLowerCase();

  return detectEngineFromText(text);
}

/** Parses an auto-adjust / split / focus / zoom request on the pane grid. */
export function parsePaneLayoutIntent(text: string): ManagePaneLayoutAction | null {
  if (!text) return null;
  const normalized = normalizeInputForIntent(text);
  const lower = normalized.toLowerCase();
  const target = parseLayoutTarget(lower);
  const withTarget = target !== undefined ? { target } : {};

  if (
    EQUALIZE_INTENT_RE.test(lower) ||
    EQUALIZE_SIZE_RE.test(lower) ||
    EQUALIZE_DIMENSIONS_RE.test(lower)
  ) {
    return { type: 'manage_pane_layout', operation: 'equalize' };
  }

  if (SPLIT_VERB_RE.test(lower)) {
    if (/\bhorizontal(?:mente)?\b|\blado\s+a\s+lado\b/i.test(lower)) {
      return { type: 'manage_pane_layout', operation: 'split-horizontal', ...withTarget };
    }
    if (/\bvertical(?:mente)?\b|\buno\s+sobre\s+otro\b/i.test(lower)) {
      return { type: 'manage_pane_layout', operation: 'split-vertical', ...withTarget };
    }
  }

  if (FOCUS_INTENT_RE.test(lower)) {
    return { type: 'manage_pane_layout', operation: 'focus', ...withTarget };
  }

  if (ZOOM_INTENT_RE.test(lower)) {
    return { type: 'manage_pane_layout', operation: 'zoom', ...withTarget };
  }

  return null;
}

const PANE_LAYOUT_REPLIES: Record<PaneLayoutOperation, string> = {
  equalize: 'Ajustando todos los paneles a las mismas dimensiones.',
  'split-horizontal': 'Dividiendo el panel horizontalmente.',
  'split-vertical': 'Dividiendo el panel verticalmente.',
  focus: 'Enfocando el panel solicitado.',
  zoom: 'Maximizando el panel solicitado.',
};

function describePaneLayout(action: ManagePaneLayoutAction): string {
  return PANE_LAYOUT_REPLIES[action.operation] || PANE_LAYOUT_REPLIES.equalize;
}

// ---------------------------------------------------------------------------
// S9 — Workspace switching & view-mode navigation
// ---------------------------------------------------------------------------

export interface WorkspaceSwitchIntent {
  workspaceQuery: string;
  viewMode?: WorkspaceViewMode;
  /** Remaining clause of the same sentence, re-planned as follow-up actions. */
  tail?: string;
}

const WS_SWITCH_VERB_SOURCE =
  'cambia(?:te|r|mos|ndo)?|c[aá]mbiate|mu[eé]ve(?:te|r|mos)?|ll[eé]vame|lleva(?:r|me)?|vete|ve(?:te)?|ir(?:me|te)?|pasa(?:te|r)?|salta(?:r)?';

const WS_NOUN_SOURCE =
  '(?:proyecto|proyectos|workspace|workspaces|espacio\\s+de\\s+trabajo|repositorio|repo)';

const WS_SWITCH_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${WS_SWITCH_VERB_SOURCE})\\s+(?:(?:al|a\\s+la|a|hacia\\s+el|hacia|para\\s+el|en\\s+el|el|la)\\s+)?${WS_NOUN_SOURCE}\\b\\s*(?:llamad[oa]\\s+|denominad[oa]\\s+|de\\s+nombre\\s+)?(.+)$`,
  'i'
);

const VIEW_MODE_ONLY_TAIL_RE =
  /^(?:abre(?:me)?|abrir|muestra(?:me)?|mostrar|pon(?:me)?|poner|cambia(?:r)?|ve|ir|pasa(?:r)?|lleva(?:me)?)\s+(?:(?:el|la|al)\s+)?(?:(?:modo|vista|visualizaci[oó]n|pantalla)\s+(?:de\s+)?)?(?:c[oó]digo|code|agentes|agents|hilos|threads)$/i;

function detectViewMode(lower: string): WorkspaceViewMode | undefined {
  if (
    /(?:modo|vista|visualizaci[oó]n|pantalla)\s+(?:de\s+)?(?:c[oó]digo|code)\b|\babre\s+(?:el\s+)?(?:modo\s+)?c[oó]digo\b/i.test(
      lower
    )
  ) {
    return 'code';
  }
  if (
    /(?:modo|vista|visualizaci[oó]n|pantalla)\s+(?:de\s+)?(?:agentes|agents)\b|\babre\s+(?:el\s+)?(?:modo\s+)?(?:de\s+)?agentes\b/i.test(
      lower
    )
  ) {
    return 'agents';
  }
  if (
    /(?:modo|vista|visualizaci[oó]n|pantalla)\s+(?:de\s+)?(?:hilos|threads)\b|\babre\s+(?:el\s+)?(?:modo\s+)?(?:hilos|threads)\b/i.test(
      lower
    )
  ) {
    return 'threads';
  }
  return undefined;
}

/** Parses a "cambia al proyecto X" / "muévete al workspace X" request. */
export function parseWorkspaceSwitchIntent(rawText: string): WorkspaceSwitchIntent | null {
  if (!rawText) return null;
  const text = normalizeInputForIntent(rawText);
  const match = text.match(WS_SWITCH_RE);
  if (!match) return null;

  const rest = (match[1] || '').trim();
  if (!rest) return null;

  const connector = rest.search(/\s+(?:y|e)\s+|[,;.]/i);
  const queryRaw = connector >= 0 ? rest.slice(0, connector) : rest;
  const tailRaw = connector >= 0 ? rest.slice(connector) : '';

  const workspaceQuery = queryRaw
    .replace(/^[\s,;.]+/, '')
    .replace(/[\s,;.]+$/, '')
    .replace(/^(?:el|la|los|las)\s+/i, '')
    .trim();
  if (!workspaceQuery) return null;

  let tail = tailRaw
    .replace(/^[\s,;.]+/, '')
    .replace(/^(?:y|e)\s+/i, '')
    .trim();

  // "…y abre código" only changes the view mode, it must not open a terminal.
  if (tail && (VIEW_MODE_ONLY_TAIL_RE.test(tail) || detectViewMode(tail.toLowerCase()))) {
    tail = '';
  }

  const viewMode = detectViewMode(text.toLowerCase());

  return {
    workspaceQuery,
    ...(viewMode ? { viewMode } : {}),
    ...(tail ? { tail } : {}),
  };
}

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
