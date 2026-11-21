import { listChatSummaries, loadChatThread } from '../ipc';

export interface ChatIndexEntry {
  id: string;
  title: string;
  cli: string;
  lastDecision?: string;
  updatedAtUnixMs?: number;
  workspaceId?: string | null;
}

export interface ChatReader {
  read(id: string): string | Promise<string>;
}

export type ConsultChatsResult =
  | { kind: 'index'; entries: ChatIndexEntry[]; text: string }
  | { kind: 'read'; entry: ChatIndexEntry; body: string; text: string }
  | { kind: 'miss'; named: string; text: string }
  | { kind: 'read-failed'; entry: ChatIndexEntry; text: string }
  | { kind: 'not-one'; text: string };

function sanitizeDecision(text?: string): string | undefined {
  if (!text) return undefined;
  const firstLine = text.split('\n')[0].trim();
  return firstLine.slice(0, 120);
}

const TEMPORAL_RECALL_RE =
  /\b(?:contin[uú]a\s+lo\s+de\s+ayer|lo\s+de\s+ayer|de\s+ayer|anoche|ayer\s+en|la\s+[uú]ltima\s+sesi[oó]n|lo\s+[uú]ltimo\s+que\s+(?:hicimos|trabajamos|hablamos|delegamos)|retoma(?:r)?\s+lo\s+de\s+ayer|qu[eé]\s+qued[oó]\s+pendiente)\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

function pickMostRecentCandidate(
  entries: ChatIndexEntry[],
  preferYesterday: boolean,
  nowMs: number = Date.now()
): ChatIndexEntry | null {
  if (entries.length === 0) return null;
  const withTime = entries.filter((e) => typeof e.updatedAtUnixMs === 'number' && e.updatedAtUnixMs > 0);
  if (withTime.length === 0) {
    return entries[0];
  }

  if (preferYesterday) {
    const yesterdayMatches = withTime
      .filter((e) => {
        const age = nowMs - (e.updatedAtUnixMs || 0);
        return age >= 12 * 60 * 60 * 1000 && age <= 72 * 60 * 60 * 1000;
      })
      .sort((a, b) => (b.updatedAtUnixMs || 0) - (a.updatedAtUnixMs || 0));
    if (yesterdayMatches.length > 0) {
      return yesterdayMatches[0];
    }
  }

  return [...withTime].sort((a, b) => (b.updatedAtUnixMs || 0) - (a.updatedAtUnixMs || 0))[0];
}

export async function consultChats(
  prompt: string,
  catalog: { entries: ChatIndexEntry[] },
  reader: ChatReader,
  options?: { nowMs?: number }
): Promise<ConsultChatsResult> {
  const sanitizedEntries: ChatIndexEntry[] = catalog.entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    cli: entry.cli,
    ...(entry.lastDecision ? { lastDecision: sanitizeDecision(entry.lastDecision) } : {}),
    ...(typeof entry.updatedAtUnixMs === 'number' ? { updatedAtUnixMs: entry.updatedAtUnixMs } : {}),
    ...(entry.workspaceId !== undefined ? { workspaceId: entry.workspaceId } : {}),
  }));

  const reviewPattern =
    /(?:review|consult|revisa|consulta|read|leer|lee|inside of(?: the)?)\s+(?:the\s+|el\s+|la\s+)?(?!(?:el|la|the)\s+)([a-z0-9_áéíóúñ-]+(?:\s+[a-z0-9_áéíóúñ-]+)?)\s+(?:chat|thread|hilo|conversaci[oó]n)/i;
  const reviewPatternAlt =
    /(?:review|consult|revisa|consulta|read|leer|lee|ver|qu[eé]\s+hay\s+en)\s+(?:el\s+|la\s+|the\s+)?(?:chat|thread|hilo|conversaci[oó]n)\s+(?:de\s+|sobre\s+|llamado\s+)?([a-z0-9_áéíóúñ-]+(?:\s+[a-z0-9_áéíóúñ-]+)?)/i;

  const match = reviewPatternAlt.exec(prompt) || reviewPattern.exec(prompt);

  // S6: Temporal cross-session recall ("continúa lo de ayer", "la última sesión", "lo último que delegamos")
  if (!match && TEMPORAL_RECALL_RE.test(prompt) && sanitizedEntries.length > 0) {
    const preferYesterday = /\b(?:ayer|anoche)\b/i.test(prompt);
    const chosen = pickMostRecentCandidate(
      sanitizedEntries,
      preferYesterday,
      options?.nowMs ?? Date.now()
    );
    if (chosen) {
      try {
        const body = await Promise.resolve(reader.read(chosen.id));
        return {
          kind: 'read',
          entry: chosen,
          body,
          text: `${chosen.title}\n${body}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          kind: 'read-failed',
          entry: chosen,
          text: `Could not read "${chosen.title}" (${chosen.id}): ${message}`,
        };
      }
    }
  }

  if (!match) {
    const lines = sanitizedEntries.map(
      (e) => `- ${e.title} (${e.cli})${e.lastDecision ? `: ${e.lastDecision}` : ''}`,
    );
    return {
      kind: 'index',
      entries: sanitizedEntries,
      text: lines.join('; '),
    };
  }

  const query = match[1].trim().toLowerCase();
  const candidates = sanitizedEntries.filter(
    (e) =>
      e.title.toLowerCase().includes(query) ||
      e.id.toLowerCase().includes(query) ||
      e.cli.toLowerCase() === query,
  );

  if (candidates.length === 0) {
    return {
      kind: 'miss',
      named: query,
      text: `No matching chat for "${query}".`,
    };
  }

  if (candidates.length > 1) {
    // If candidates carry recency timestamps and one is strictly newer, pick the most recent
    // unless caller has untimestamped tied entries (preserving deterministic `not-one` safety).
    const timestamped = candidates.filter(
      (c) => typeof c.updatedAtUnixMs === 'number' && c.updatedAtUnixMs > 0
    );
    if (timestamped.length === candidates.length) {
      const sorted = [...timestamped].sort(
        (a, b) => (b.updatedAtUnixMs || 0) - (a.updatedAtUnixMs || 0)
      );
      if ((sorted[0].updatedAtUnixMs || 0) - (sorted[1].updatedAtUnixMs || 0) >= DAY_MS / 24) {
        const chosen = sorted[0];
        try {
          const body = await Promise.resolve(reader.read(chosen.id));
          return {
            kind: 'read',
            entry: chosen,
            body,
            text: `${chosen.title}\n${body}`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            kind: 'read-failed',
            entry: chosen,
            text: `Could not read "${chosen.title}" (${chosen.id}): ${message}`,
          };
        }
      }
    }
    return {
      kind: 'not-one',
      text: 'More than one chat matches. Not reading them.',
    };
  }

  const chosen = candidates[0];
  try {
    const body = await Promise.resolve(reader.read(chosen.id));
    return {
      kind: 'read',
      entry: chosen,
      body,
      text: `${chosen.title}\n${body}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'read-failed',
      entry: chosen,
      text: `Could not read "${chosen.title}" (${chosen.id}): ${message}`,
    };
  }
}

export async function fetchLiveChatCatalog(workspaceId?: string): Promise<{ entries: ChatIndexEntry[] }> {
  try {
    const list = await listChatSummaries();
    const scoped = workspaceId
      ? list.filter((c) => Boolean(c.workspaceId) && c.workspaceId === workspaceId)
      : list;
    return {
      entries: scoped
        .sort((a, b) => (b.updatedAtUnixMs || 0) - (a.updatedAtUnixMs || 0))
        .slice(0, 12)
        .map((c) => ({
          id: c.id,
          title: c.title || 'Conversación',
          cli: c.provider || 'antigravity',
          lastDecision: c.sessionState || (c.status === 'running' ? 'En ejecución' : undefined),
          updatedAtUnixMs: c.updatedAtUnixMs,
          workspaceId: c.workspaceId,
        })),
    };
  } catch {
    return { entries: [] };
  }
}

export const liveChatReader: ChatReader = {
  async read(id: string): Promise<string> {
    try {
      const thread = await loadChatThread(id);
      const items = (thread as any)?.items || (thread as any)?.messages || [];
      if (!thread || items.length === 0) {
        return 'No hay mensajes en esta conversación.';
      }
      return items
        .slice(-8)
        .map((m: any) => `${m.role || m.kind || 'usuario'}: ${typeof m.text === 'string' ? m.text : (m.content || '')}`)
        .join('\n');
    } catch (e: any) {
      throw new Error(`No se pudo leer la conversación ${id}: ${e?.message || e}`);
    }
  },
};
