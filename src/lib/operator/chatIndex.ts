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

  const reviewPattern = /(?:review|consult|revisa|consulta|read|leer|inside of(?: the)?)\s+(?:the\s+)?([a-z0-9_-]+(?:\s+[a-z0-9_-]+)?)\s+(?:chat|thread|hilo)/i;
  const match = reviewPattern.exec(prompt);

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
