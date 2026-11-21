// Kite Code — Clause-Level Polarity & Negation Analyzer
// Distinguishes full negations ("no cierres las terminales") from mixed-polarity instructions
// ("no cierres las terminales, abre un hilo con Claude") while keeping close safety airtight.

import {
  CLOSE_VERB_RE,
  OPEN_VERB_RE,
  hasSubordinateCloseClause,
  isNegatedTerminalImperative,
} from './heuristicPatterns';

export interface AnalyzedClause {
  text: string;
  negated: boolean;
  hasCloseVerb: boolean;
  hasOpenVerb: boolean;
  hasActionableVerb: boolean;
}

export interface PolarityAnalysis {
  clauses: AnalyzedClause[];
  negatedClauses: AnalyzedClause[];
  affirmativeClauses: AnalyzedClause[];
  hasMixedPolarity: boolean;
  isEntireUtteranceNegated: boolean;
  affirmativeText: string;
  allowsClose: boolean;
}

const ACTIONABLE_VERB_RE =
  /(?<![a-záéíóúñ])(?:abre|abrir|abr[ií]|abriera|abriese|abrime|[aá]breme|lanza|lanzar|lanzame|crea|crear|inicia|iniciar|levanta|levantar|delega|delegar|env[ií]a|enviar|manda|mandar|dile|p[ií]dele|p[aá]sale|resume|resumir|narr[aá]|inyecta|escribe|ejecuta|corre|cambia|c[aá]mbiate|mu[eé]vete|autoajusta|iguala|divide|enfoca|cierra|cerrar|mata|termina|elimina|apaga|borra)(?![a-záéíóúñ])/i;

const CLAUSE_NEGATION_RE =
  /(?<![a-záéíóúñ])(?:no|nunca|jam[aá]s)(?:\s+(?:me|te|se|nos|le|les|lo|la|los|las))?\s+(?:cierr\w*|cerr\w*|sierr\w*|abras?|abr[ií]s?|abr[aá]s?|lances?|lanc[eé]s?|crees?|cre[eé]s?|mates?|mat[eé]s?|detengas?|termines?|apagues?|elimines?|borres?|pares?|dejes?|delegues?|env[ií]es?|mandes?)(?![a-záéíóúñ])/i;

const CONTRASTIVE_SPLIT_RE =
  /\s*(?:;\s*|\s+(?:pero|sino(?:\s+que)?|mejor|en\s+vez\s+de\s+eso|en\s+lugar\s+de\s+eso)\s+|,\s*(?=(?:mejor\s+|m[aá]s\s+bien\s+)?(?:abre|abrir|abr[ií]|lanza|crea|inicia|delega|env[ií]a|manda|dile|p[ií]dele|p[aá]sale|resume|cambia|cierra|mata|termina|no\s+|nunca\s+)))/i;

function splitIntoPolarityClauses(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const rawParts = clean
    .split(CONTRASTIVE_SPLIT_RE)
    .map((p) => p.replace(/^(?:mejor|m[aá]s\s+bien|sino\s+que|sino|pero)\s+/i, '').trim())
    .filter(Boolean);
  return rawParts.length > 0 ? rawParts : [clean];
}

function isClauseNegated(clause: string): boolean {
  if (CLAUSE_NEGATION_RE.test(clause)) return true;
  if (/\bning[uú]n[ao]s?\s+(?:terminal|terminales|consola|consolas|agente|agentes|hilo|hilos|thread|threads|pane|panes)\b/i.test(clause)) {
    return true;
  }
  return false;
}

/**
 * Splits compound/contrastive Spanish utterances into clauses and evaluates polarity per clause.
 * - "no cierres las terminales" -> isEntireUtteranceNegated = true, allowsClose = false.
 * - "no cierres las terminales, abre un hilo con Claude" -> hasMixedPolarity = true,
 *   isEntireUtteranceNegated = false, affirmativeText = "abre un hilo con Claude", allowsClose = false.
 * - "no abras terminales, cierra a Orion" -> hasMixedPolarity = true,
 *   affirmativeText = "cierra a Orion", allowsClose = true.
 */
export function analyzeClausePolarity(text: string): PolarityAnalysis {
  const rawClauses = splitIntoPolarityClauses(text);
  const clauses: AnalyzedClause[] = rawClauses.map((c) => {
    const negated = isClauseNegated(c);
    const hasCloseVerb = CLOSE_VERB_RE.test(c) && !hasSubordinateCloseClause(c);
    const hasOpenVerb = OPEN_VERB_RE.test(c);
    const hasActionableVerb = ACTIONABLE_VERB_RE.test(c);
    return {
      text: c,
      negated,
      hasCloseVerb,
      hasOpenVerb,
      hasActionableVerb,
    };
  });

  const negatedClauses = clauses.filter((c) => c.negated);
  const affirmativeClauses = clauses.filter((c) => !c.negated && c.hasActionableVerb);

  const hasMixedPolarity = negatedClauses.length > 0 && affirmativeClauses.length > 0;
  const isEntireUtteranceNegated =
    negatedClauses.length > 0
      ? affirmativeClauses.length === 0
      : isNegatedTerminalImperative(text);

  const affirmativeText = hasMixedPolarity
    ? affirmativeClauses.map((c) => c.text).join(', ')
    : isEntireUtteranceNegated
      ? ''
      : text.trim();

  // Close is allowed ONLY if at least one non-negated, non-subordinate clause explicitly requests closing.
  const allowsClose = clauses.some((c) => !c.negated && c.hasCloseVerb);

  return {
    clauses,
    negatedClauses,
    affirmativeClauses,
    hasMixedPolarity,
    isEntireUtteranceNegated,
    affirmativeText,
    allowsClose,
  };
}
