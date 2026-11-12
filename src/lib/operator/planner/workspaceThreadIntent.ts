import type {
  Engine,
  LaunchThreadAction,
  WorkspaceViewMode,
} from '../contract';
import {
  detectEngineFromText,
  normalizeInputForIntent,
  OPEN_VERB_RE,
  OPEN_VERB_SOURCE,
  COMPATIBLE_TERMINAL_OBJECT_RE,
} from './heuristicPatterns';

export interface WorkspaceSwitchIntent {
  workspaceQuery: string;
  viewMode?: WorkspaceViewMode;
  /** Remaining clause of the same sentence, re-planned as follow-up actions. */
  tail?: string;
}

export const WS_SWITCH_VERB_SOURCE =
  'cambia(?:te|r|mos|ndo)?|c[aá]mbiate|mu[eé]ve(?:te|r|mos)?|ll[eé]vame|lleva(?:r|me)?|vete|ve(?:te)?|ir(?:me|te)?|pasa(?:te|r)?|salta(?:r)?';

export const WS_NOUN_SOURCE =
  '(?:proyecto|proyectos|workspace|workspaces|espacio\\s+de\\s+trabajo|repositorio|repo)';

export const WS_SWITCH_RE = new RegExp(
  `(?<![a-záéíóúñ])(?:${WS_SWITCH_VERB_SOURCE})\\s+(?:(?:al|a\\s+la|a|hacia\\s+el|hacia|para\\s+el|en\\s+el|el|la)\\s+)?${WS_NOUN_SOURCE}\\b\\s*(?:llamad[oa]\\s+|denominad[oa]\\s+|de\\s+nombre\\s+)?(.+)$`,
  'i'
);

export const VIEW_MODE_ONLY_TAIL_RE =
  /^(?:abre(?:me)?|abrir|muestra(?:me)?|mostrar|pon(?:me)?|poner|cambia(?:r)?|ve|ir|pasa(?:r)?|lleva(?:me)?)\s+(?:(?:el|la|al)\s+)?(?:(?:modo|vista|visualizaci[oó]n|pantalla)\s+(?:de\s+)?)?(?:c[oó]digo|code|agentes|agents|hilos|threads)$/i;

export function detectViewMode(lower: string): WorkspaceViewMode | undefined {
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

export function parseLaunchThreadIntent(text: string): LaunchThreadAction | null {
  const lower = text.toLowerCase().trim();

  // If the command explicitly requests opening a terminal or console, terminal wins!
  if (OPEN_VERB_RE.test(lower) && COMPATIBLE_TERMINAL_OBJECT_RE.test(lower)) {
    return null;
  }

  // 1. "abre/crea/lanza/inicia un [nuevo] thread/hilo [de/con <provider>] [para/con/: <body...>]"
  const openMatch = text.match(
    new RegExp(
      `^(?:${OPEN_VERB_SOURCE})\\s+(?:un\\s+)?(?:nuevo\\s+)?(?:thread|hilo)(?:\\s+(?:de|con)\\s+([a-zA-Z0-9_\\-]+))?(?:\\s+(?:para|:)\\s+(.+)|\\s+(.+))?$`,
      'i'
    )
  );

  if (openMatch) {
    const rawEngine = openMatch[1];
    let provider: Engine | undefined = undefined;
    if (rawEngine) {
      provider = detectEngineFromText(rawEngine);
    }
    const body = (openMatch[2] || openMatch[3] || '').trim() || undefined;

    return {
      type: 'launch_thread',
      ...(provider ? { provider } : {}),
      ...(body ? { body } : {}),
    };
  }

  // 2. "en el thread/hilo [<threadId>] [<body...>]"
  const enThreadMatch = text.match(
    /^en\s+el\s+(?:thread|hilo)(?:\s+([a-zA-Z0-9_\\-]+))?(?:\s+(.+))?$/i
  );

  if (enThreadMatch) {
    const rawId = enThreadMatch[1]?.trim();
    const rawBody = enThreadMatch[2]?.trim();

    let threadId = 'active';
    let body = rawBody;

    if (rawId) {
      if (/^(?:revisa|escribe|manda|ejecuta|pregunta|dile|consulta|para)/i.test(rawId)) {
        threadId = 'active';
        body = [rawId, rawBody].filter(Boolean).join(' ');
      } else {
        threadId = rawId;
      }
    }

    return {
      type: 'launch_thread',
      threadId,
      ...(body ? { body } : {}),
    };
  }

  return null;
}
