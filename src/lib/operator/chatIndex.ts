import { listChatSummaries, loadChatThread } from '../ipc';

export interface ChatIndexEntry {
  id: string;
  title: string;
  cli: string;
  lastDecision?: string;
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

export async function consultChats(
  prompt: string,
  catalog: { entries: ChatIndexEntry[] },
  reader: ChatReader,
): Promise<ConsultChatsResult> {
  const sanitizedEntries: ChatIndexEntry[] = catalog.entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    cli: entry.cli,
    ...(entry.lastDecision ? { lastDecision: sanitizeDecision(entry.lastDecision) } : {}),
  }));

  const reviewPattern =
    /(?:review|consult|revisa|consulta|read|leer|lee|inside of(?: the)?)\s+(?:the\s+|el\s+|la\s+)?(?!(?:el|la|the)\s+)([a-z0-9_áéíóúñ-]+(?:\s+[a-z0-9_áéíóúñ-]+)?)\s+(?:chat|thread|hilo|conversaci[oó]n)/i;
  const reviewPatternAlt =
    /(?:review|consult|revisa|consulta|read|leer|lee|ver|qu[eé]\s+hay\s+en)\s+(?:el\s+|la\s+|the\s+)?(?:chat|thread|hilo|conversaci[oó]n)\s+(?:de\s+|sobre\s+|llamado\s+)?([a-z0-9_áéíóúñ-]+(?:\s+[a-z0-9_áéíóúñ-]+)?)/i;

  const match = reviewPatternAlt.exec(prompt) || reviewPattern.exec(prompt);

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

export async function fetchLiveChatCatalog(): Promise<{ entries: ChatIndexEntry[] }> {
  try {
    const list = await listChatSummaries();
    return {
      entries: list.map((c) => ({
        id: c.id,
        title: c.title || 'Conversación',
        cli: c.provider || 'antigravity',
        lastDecision: c.sessionState || (c.status === 'running' ? 'En ejecución' : undefined),
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
