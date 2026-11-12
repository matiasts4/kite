import type { Engine } from '../contract';
import { AGENT_CODENAMES } from '../../agentNames';

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

export const CLOSE_VERB_SOURCE =
  'cierra|cerrar|cierre|cierres|cierren|ci[eé]rral[ao]s?|ci[eé]rrenl[ao]s?|ci[eé]rrel[ao]s?|ci[eé]rrame|cerr[aá]l[ao]s?|sierra|serrar|sierre|sierres|sierren|close|kill|mata|matar|mates|maten|m[aá]tal[ao]s?|m[aá]tenl[ao]s?|termina|terminar|termines|terminen|term[ií]nal[ao]s?|elimina|eliminar|elimines|eliminen|elim[ií]nal[ao]s?|apaga|apagar|apagues|apaguen|ap[aá]gal[ao]s?|borra|borrar|borres|borren';

export const OPEN_VERB_SOURCE =
  'abre|abrir|abriera|abrieras|abriese|abriesen|abrir[ií]a|abrime|ábreme|abrí|abran|abras|crea|crear|crees|creas|levanta|levantar|levantes|inicia|iniciar|inicies|pon|poner|pongas|open|spawn|lanza|lanzar|lances|lanzame|lánzame';

export const CLOSE_VERB_RE = new RegExp(`(?<![a-záéíóúñ])(?:${CLOSE_VERB_SOURCE})(?![a-záéíóúñ])`, 'i');

export const CLOSE_TARGET_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${CLOSE_VERB_SOURCE})(?![a-záéíóúñ])(?:\\s+(?:a|al|el|la|los|las|the))?(?:\\s+(.+))?$`,
  'i'
);

export const OPEN_VERB_RE = new RegExp(`(?<![a-záéíóúñ])(?:${OPEN_VERB_SOURCE})(?![a-záéíóúñ])`, 'i');

export const AGENT_CODENAME_WORD_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${AGENT_CODENAMES.join('|')})(?![a-záéíóúñ])`,
  'i'
);

// Nouns that address a different UI surface than an agent terminal.
export const NON_TERMINAL_UI_NOUN_RE =
  /(?<![a-záéíóúñ])(?:pesta[ñn]as?|tabs?|panel(?:es)?|sidebar|barra\s+lateral|men[uú]s?|archivos?|editores?|navegador|chats?|hilos?|threads?|notas?|documentos?)(?![a-záéíóúñ])/i;

// Nouns that unambiguously address a terminal pane.
export const COMPATIBLE_TERMINAL_OBJECT_RE =
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
export const SUBORDINATE_INTRO_RE =
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
export const OPEN_CLAUSE_BOUNDARY_RE = /(?:\bpara\b|\bque\b|\by\s+ejecuta\b|\by\s+ejecutar\b|\by\s+corre\b|\by\s+correr\b|\by\s+lanza\b|:|,)/;

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
export const SHELL_COMMAND_HEAD_RE =
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
