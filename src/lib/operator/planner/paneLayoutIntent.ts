import type { ManagePaneLayoutAction, PaneLayoutOperation } from '../contract';
import {
  detectEngineFromText,
  normalizeInputForIntent,
  parseNumberWord,
} from './heuristicPatterns';

export const EQUALIZE_INTENT_RE =
  /(?<![a-záéíóúñ])(?:auto[- ]?ajust\w*|autoajust\w*|iguala(?:r|n|mos|d)?|igual[aá](?:r|mos|n)?|equilibra(?:r|n)?|nivela(?:r|n)?|empareja(?:r|n)?|redistribu\w*|repart(?:e|ir)\s+el\s+espacio)(?![a-záéíóúñ])/i;

export const EQUALIZE_SIZE_RE =
  /(?<![a-záéíóúñ])ajust\w*\s+(?:el\s+|la\s+|los\s+|las\s+)?(?:tama[ñn]os?|dimensiones|ancho|alto|paneles|terminales|rejilla|distribuci[oó]n)(?![a-záéíóúñ])/i;

export const EQUALIZE_DIMENSIONS_RE =
  /(?:mismas?\s+dimensiones|dimensiones\s+(?:iguales|similares|parejas)|mismo\s+tama[ñn]o|que\s+queden\s+(?:todas?\s+)?(?:iguales|parejas|de\s+las\s+mismas))/i;

export const SPLIT_VERB_RE =
  /(?<![a-záéíóúñ])(?:divide|dividir|divid[ae]s?|separa|separar|separe?s?|parte|partir|split)(?![a-záéíóúñ])/i;

export const FOCUS_INTENT_RE =
  /(?:haz(?:le)?\s+foco|hacer\s+foco|pon(?:er|le)?\s+(?:el\s+)?foco)|(?<![a-záéíóúñ])(?:enfoca(?:r)?|enf[oó]cate|focaliza(?:r)?|focus)(?![a-záéíóúñ])/i;

export const ZOOM_INTENT_RE =
  /(?<![a-záéíóúñ])(?:maximiza(?:r)?|agranda(?:r)?|expande|expandir|ampl[ií]a(?:r)?|zoom|pantalla\s+completa|fullscreen)(?![a-záéíóúñ])/i;

export function parseLayoutTarget(text: string): string | number | undefined {
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

export const PANE_LAYOUT_REPLIES: Record<PaneLayoutOperation, string> = {
  equalize: 'Ajustando todos los paneles a las mismas dimensiones.',
  'split-horizontal': 'Dividiendo el panel horizontalmente.',
  'split-vertical': 'Dividiendo el panel verticalmente.',
  focus: 'Enfocando el panel solicitado.',
  zoom: 'Maximizando el panel solicitado.',
};

export function describePaneLayout(action: ManagePaneLayoutAction): string {
  return PANE_LAYOUT_REPLIES[action.operation] || PANE_LAYOUT_REPLIES.equalize;
}
