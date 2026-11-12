import type { HandoffToAgentAction } from '../contract';
import {
  detectEngineFromText,
  normalizeInputForIntent,
  parseNumberWord,
} from './heuristicPatterns';

export const HANDOFF_VERB_SOURCE =
  'p[aá]sa(?:le|les|lo|la|r|s|n)?|pases?|pasen?|entrega(?:le|les|lo|la|r|s|n)?|entregu?es?|entregu?en?|delega(?:le|les|lo|la|r|s|n)?|delegu?es?|delegu?en?|env[ií]a(?:le|les|lo|la|r|s|n)?|manda(?:le|les|lo|la|r|s|n)?|traspasa(?:le|les|r|s|n)?|comparte(?:le|les|r|s|n)?|deriva(?:le|les|r|s|n)?|handoff';

export const HANDOFF_ARTIFACT_SOURCE =
  'odd|o\\.d\\.d\\.|tarea|plan|planeaci[oó]n|salida|output|respuesta|resumen|contexto|conversaci[oó]n|buffer|trabajo';

export const HANDOFF_SOURCE_CONNECTOR =
  '(?:de|del|del?\\s+agente|que\\s+(?:hizo|cre[oó]|gener[oó]|arm[oó]|dej[oó]))';

export const HANDOFF_WITH_SOURCE_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${HANDOFF_VERB_SOURCE})\\s+(?:el|la|los|las)?\\s*(?:${HANDOFF_ARTIFACT_SOURCE})\\s+(?:${HANDOFF_SOURCE_CONNECTOR})\\s+(.+?)\\s+(?:hacia|para|al|a)\\s+(.+)$`,
  'i'
);

export const HANDOFF_DIRECT_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${HANDOFF_VERB_SOURCE})\\s+(?:el|la|los|las)?\\s*(?:${HANDOFF_ARTIFACT_SOURCE})\\s+(?:hacia|para|al|a)\\s+(.+)$`,
  'i'
);

export const HANDOFF_INVERTED_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${HANDOFF_VERB_SOURCE})\\s+(?:hacia|para|al|a)\\s+(.+?)\\s+(?:el|la|los|las)?\\s*(?:${HANDOFF_ARTIFACT_SOURCE})(?:\\s+(?:${HANDOFF_SOURCE_CONNECTOR})\\s+(.+))?$`,
  'i'
);

export const NEW_TARGET_RE =
  /(?<![a-záéíóúñ])(?:nuev[oa]s?|otr[oa]s?|que\s+abrir[aá]s|que\s+abras|que\s+crear[aá]s|que\s+crees|que\s+lanzar[aá]s|que\s+lances|abrir[aá]s|crear[aá]s|sesi[oó]n)(?![a-záéíóúñ])/i;

export function parseExplicitSessionRef(phrase: string): string | number | undefined {
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

export function parseHandoffSource(phrase: string): string | number | undefined {
  if (!phrase) return 'active';
  const clean = phrase.trim().replace(/[.,;!?]+$/, '').trim();
  if (!clean) return 'active';

  const lower = clean.toLowerCase();
  if (
    /^(?:este|esta|actual|activo|activa)(?:\s+(?:agente|terminal|consola|pane|sesi[oó]n))?$/i.test(lower) ||
    /^(?:el\s+agente\s+actual|la\s+terminal\s+actual)$/i.test(lower)
  ) {
    return 'active';
  }

  const explicit = parseExplicitSessionRef(clean);
  if (explicit !== undefined) return explicit;

  const engine = detectEngineFromText(clean);
  if (engine) return engine;

  const stripped = clean
    .replace(/^(?:la|el|los|las)\s+/i, '')
    .replace(/^(?:que\s+(?:hizo|cre[oó]|gener[oó]|arm[oó]|dej[oó]))\s+/i, '')
    .replace(/^(?:terminal|terminales|agente|agentes|consola|consolas|sesi[oó]n)(?:\s+(?:de|del))?\s*/i, '')
    .trim();
  if (!stripped) return 'active';
  if (/^\d+$/.test(stripped)) return Number(stripped);
  return stripped.toLowerCase();
}

/**
 * Parses a Spanish multi-agent handoff request, e.g.
 * "pásale el ODD de la terminal 1 a un nuevo agente de claude",
 * "entrega el ODD que hizo el agente Orion a una nueva sesión de Grok", or
 * "pásale el ODD a un nuevo agente de grok".
 */
export function parseHandoffIntent(text: string): HandoffToAgentAction | null {
  if (!text) return null;
  const normalized = normalizeInputForIntent(text);

  let sourcePhrase = '';
  let targetPhrase = '';
  let fullMatchText = '';

  const withSourceMatch = normalized.match(HANDOFF_WITH_SOURCE_RE);
  if (withSourceMatch) {
    sourcePhrase = (withSourceMatch[1] || '').trim();
    targetPhrase = (withSourceMatch[2] || '').trim();
    fullMatchText = withSourceMatch[0];
  } else {
    const directMatch = normalized.match(HANDOFF_DIRECT_RE);
    if (directMatch) {
      sourcePhrase = 'active';
      targetPhrase = (directMatch[1] || '').trim();
      fullMatchText = directMatch[0];
    } else {
      const invertedMatch = normalized.match(HANDOFF_INVERTED_RE);
      if (invertedMatch) {
        targetPhrase = (invertedMatch[1] || '').trim();
        sourcePhrase = (invertedMatch[2] || 'active').trim();
        fullMatchText = invertedMatch[0];
      }
    }
  }

  if (!targetPhrase) return null;

  const sourceTarget = parseHandoffSource(sourcePhrase) ?? 'active';
  const targetEngine = detectEngineFromText(targetPhrase);
  const targetSession = parseExplicitSessionRef(targetPhrase);
  const spawnNew = NEW_TARGET_RE.test(targetPhrase) || targetSession === undefined;
  const artifactKind: HandoffToAgentAction['artifactKind'] =
    /(?<![a-záéíóúñ])(?:odd|plan|planeaci[oó]n|tarea)(?![a-záéíóúñ])/i.test(fullMatchText)
      ? 'odd'
      : 'output';

  return {
    type: 'handoff_to_agent',
    sourceTarget,
    ...(targetEngine ? { targetEngine } : {}),
    ...(targetSession !== undefined ? { targetSession } : {}),
    spawnNew,
    artifactKind,
  };
}

export function describeHandoff(action: HandoffToAgentAction): string {
  const artifact = action.artifactKind === 'odd' ? 'el ODD' : 'la salida';
  const source =
    action.sourceTarget === 'active'
      ? 'la terminal activa'
      : typeof action.sourceTarget === 'number'
        ? `la terminal ${action.sourceTarget}`
        : `el agente "${action.sourceTarget}"`;
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
