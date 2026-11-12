export const DRAFT_CHAR_LIMIT = 120_000;
export const PASTE_FILE_BYTES = 32 * 1024;
export const MAX_ATTACHMENTS = 100;

export function pasteBecomesFile(bytes: number, draftLength: number, pastedLength: number, forceInline: boolean): boolean {
  if (forceInline) return false;
  return bytes >= PASTE_FILE_BYTES || draftLength + pastedLength > DRAFT_CHAR_LIMIT;
}

export function canSendDraft(length: number): boolean {
  return length > 0 && length <= DRAFT_CHAR_LIMIT;
}

export interface StashEntry {
  id: string;
  text: string;
  savedAt: number;
  /** Environment that uploaded stash files. Absent when the stash is text only. */
  filesUploadedHere?: string;
}

export function stashDraft(entries: StashEntry[], text: string, now: number): { entries: StashEntry[]; cleared: boolean } {
  if (!text.trim()) {
    return { entries, cleared: false };
  }
  return {
    entries: [...entries, { id: `stash-${now}`, text, savedAt: now }],
    cleared: true,
  };
}

export function restoreStash(entries: StashEntry[]): { text: string; entries: StashEntry[]; openMenu: boolean } {
  if (entries.length === 0) return { text: '', entries, openMenu: false };
  if (entries.length === 1) {
    return { text: entries[0].text, entries: [], openMenu: false };
  }
  return { text: '', entries, openMenu: true };
}

export function recallPrompt(history: string[], index: number | null, direction: 'up' | 'down'): number | null {
  if (history.length === 0) return null;
  if (direction === 'up') {
    if (index === null) return history.length - 1;
    return index > 0 ? index - 1 : index;
  }
  if (index === null) return null;
  return index + 1 < history.length ? index + 1 : null;
}

export type Shelf = 'pinned' | 'active' | 'working' | 'snoozed' | 'settled';

export interface ShelfThread {
  id: string;
  pinned?: boolean;
  status?: string;
  snoozedUntil?: number | null;
  settled?: boolean;
}

export function shelfFor(thread: ShelfThread, now: number): Shelf {
  if (thread.pinned) return 'pinned';
  if (thread.settled) return 'settled';
  if (thread.snoozedUntil && thread.snoozedUntil > now) return 'snoozed';
  if (thread.status === 'running' || thread.status === 'waiting') return 'working';
  return 'active';
}

export function dragBadge(from: Shelf, to: Shelf): string | null {
  if (from === to) return null;
  if (to === 'pinned') return 'Pin';
  if (from === 'pinned') return 'Unpin';
  if (to === 'settled') return 'Settle';
  if (from === 'settled') return 'Un-settle';
  if (from === 'snoozed') return 'Wake';
  return null;
}

export function goalSupported(provider: string): boolean {
  return provider === 'codex' || provider === 'claude';
}

export type SlashIntent = 'clear' | 'compact' | 'goal' | 'side' | 'model' | 'skill' | 'message';

const LEADING_COMMAND = /^\/(clear|compact|goal|side|btw)(?=\s|$)/;
const MODEL_COMMAND = /(?:^|\s)\/model(?=\s|$)/m;
const SKILL_MENTION = /(?:^|\s)\$[A-Za-z0-9][\w-]*/;

export function slashIntent(text: string, provider: string): SlashIntent {
  const trimmed = text.trim();
  const leading = trimmed.match(LEADING_COMMAND);
  if (leading && !(leading[1] === 'goal' && !goalSupported(provider))) {
    if (leading[1] === 'clear') return 'clear';
    if (leading[1] === 'compact') return 'compact';
    if (leading[1] === 'goal') return 'goal';
    return 'side';
  }
  const modelAt = MODEL_COMMAND.exec(text)?.index ?? -1;
  const skillAt = SKILL_MENTION.exec(text)?.index ?? -1;
  if (modelAt === -1 && skillAt === -1) return 'message';
  if (modelAt === -1) return 'skill';
  if (skillAt === -1) return 'model';
  return modelAt <= skillAt ? 'model' : 'skill';
}

export function fileRestoreAllowed(providerRewind: boolean, isolatedCheckout: boolean): boolean {
  return providerRewind && isolatedCheckout;
}

export interface HandoffItem {
  kind: string;
  text: string;
  attachments?: unknown[];
}

export interface HandoffResult<T> {
  selection: T[];
  request: string;
  askedToCompact: false;
}

function withoutAttachments<T extends HandoffItem>(item: T): T {
  if (!item.attachments || item.attachments.length === 0) return item;
  const next = { ...item };
  delete next.attachments;
  return next;
}

function transferable<T extends HandoffItem>(items: T[]): T[] {
  return items
    .filter((item) => item.kind !== 'tool' && item.kind !== 'reasoning')
    .filter((item) => item.kind === 'user' || item.kind === 'assistant' || item.kind === 'command')
    .filter((item) => item.text.trim().length > 0)
    .map(withoutAttachments);
}

function fitSelection<T extends { text: string }>(items: T[], budget: number): T[] {
  const selected: T[] = [];
  let used = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const size = items[index].text.length;
    if (used + size > budget) break;
    selected.unshift(items[index]);
    used += size;
  }
  return selected;
}

export function handoffMessages<T extends HandoffItem>(items: T[], limit: number): T[];
export function handoffMessages<T extends HandoffItem>(items: T[], budget: number, request: string): HandoffResult<T>;
export function handoffMessages<T extends HandoffItem>(
  items: T[],
  budget: number,
  request?: string,
): T[] | HandoffResult<T> {
  const eligible = transferable(items);
  if (request === undefined) return eligible.slice(-budget);
  return {
    selection: fitSelection(eligible, budget),
    request,
    askedToCompact: false,
  };
}

export const SHELF_UNDO_MS = 5_000;
export const STASH_FILE_TTL_MS = 86_400_000;

export type ShelfAction = 'Pin' | 'Unpin' | 'Settle' | 'Snooze' | 'Archive' | 'draft-discard';

export interface ShelfUndo {
  action: ShelfAction;
  threadId: string;
  previous: { shelf: Shelf; index: number };
  at: number;
}

export function recordShelfUndo(
  action: ShelfAction,
  threadId: string,
  previous: { shelf: Shelf; index: number },
  at: number,
): ShelfUndo {
  return { action, threadId, previous, at };
}

export function undoShelf(record: ShelfUndo | null, now: number): { shelf: Shelf; index: number } | null {
  if (!record) return null;
  if (now - record.at > SHELF_UNDO_MS) return null;
  return record.previous;
}

export function applyShelfUndo<T extends { id: string; shelf: Shelf }>(
  threads: T[],
  record: ShelfUndo | null,
  now: number,
  removed?: T,
): T[] {
  const previous = undoShelf(record, now);
  if (!record || !previous) return threads;
  const source = threads.find((thread) => thread.id === record.threadId) ?? removed;
  if (!source || source.id !== record.threadId) return threads;
  const restored = { ...source, shelf: previous.shelf };
  const without = threads.filter((thread) => thread.id !== record.threadId);
  const peers = without.filter((thread) => thread.shelf === previous.shelf);
  const index = Math.max(0, Math.min(previous.index, peers.length));
  const placed = [...peers.slice(0, index), restored, ...peers.slice(index)];
  const result: T[] = [];
  let inserted = false;
  for (const thread of without) {
    if (thread.shelf === previous.shelf) {
      if (!inserted) {
        result.push(...placed);
        inserted = true;
      }
      continue;
    }
    result.push(thread);
  }
  if (!inserted) {
    const at = Math.max(0, Math.min(index, result.length));
    result.splice(at, 0, restored);
  }
  return result;
}

export function shelfPlacement(
  threads: ShelfThread[],
  threadId: string,
  now: number,
): { shelf: Shelf; index: number } | null {
  const thread = threads.find((item) => item.id === threadId);
  if (!thread) return null;
  const shelf = shelfFor(thread, now);
  const index = threads
    .filter((item) => shelfFor(item, now) === shelf)
    .findIndex((item) => item.id === threadId);
  return { shelf, index };
}

export function isFailedThread(thread: { status?: string }, _catalogState?: string | null): boolean {
  return thread.status === 'error';
}

export function stashUploadRestore(
  uploadedAt: number,
  now: number,
  uploadedEnvironment: string,
  currentEnvironment: string,
): 'restore' | 'attach-again' | 'wrong-environment' {
  if (uploadedEnvironment !== currentEnvironment) return 'wrong-environment';
  if (now - uploadedAt > STASH_FILE_TTL_MS) return 'attach-again';
  return 'restore';
}

/** Expiry for a stash restore. Text-only entries have no file result. */
export function stashFileRestorable(
  entry: { filesUploadedHere?: string; savedAt?: number },
  now: number,
  currentEnvironment: string,
): 'restore' | 'attach-again' | 'wrong-environment' | null {
  if (typeof entry.filesUploadedHere !== 'string' || entry.filesUploadedHere.length === 0) return null;
  if (typeof entry.savedAt !== 'number') return null;
  return stashUploadRestore(entry.savedAt, now, entry.filesUploadedHere, currentEnvironment);
}

export function goalAfterStop(provider: string, goal: string | null): {
  goal: string | null;
  paused: boolean;
  turnEnded: boolean;
} {
  if (provider === 'codex') return { goal, paused: Boolean(goal), turnEnded: false };
  if (provider === 'claude') return { goal, paused: false, turnEnded: Boolean(goal) };
  return { goal, paused: false, turnEnded: false };
}

/** Stop-handler entry. Does not start a goal loop. */
export function composerGoalStop(provider: string, goal: string | null): {
  goal: string | null;
  paused: boolean;
  turnEnded: boolean;
} {
  return goalAfterStop(provider, goal);
}

export function handoffChannel(provider: string, versionSupportsDirect: boolean): 'direct' | 'attributed' {
  return provider === 'codex' && versionSupportsDirect ? 'direct' : 'attributed';
}

export function sidebarThreads<
  T extends { sideChat?: boolean; parentThreadId?: string | null; startedByAgent?: boolean },
>(threads: T[]): T[] {
  return threads.filter(
    (thread) =>
      thread.sideChat !== true &&
      !(Boolean(thread.parentThreadId) && Boolean(thread.startedByAgent))
  );
}

/** Live roster rows. Side chats and agent-spawned child threads stay in their drawers. */
export function visibleRosterThreads<
  T extends { sideChat?: boolean; parentThreadId?: string | null; startedByAgent?: boolean },
>(threads: T[]): T[] {
  return sidebarThreads(threads);
}

/** Literal turn text for providers that can compact. Others must not be sent. */
export function compactSendText(provider: string): '/compact' | null {
  if (provider === 'codex' || provider === 'claude') return '/compact';
  return null;
}
