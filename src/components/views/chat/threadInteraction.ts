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
  T extends {
    id?: string;
    sideChat?: boolean;
    parentThreadId?: string | null;
    startedByAgent?: boolean;
    archivedAtUnixMs?: number | null;
  },
>(threads: T[]): T[] {
  const archivedIds = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAtUnixMs != null && thread.id) {
      archivedIds.add(thread.id);
    }
  }
  return threads.filter(
    (thread) =>
      thread.archivedAtUnixMs == null &&
      !(thread.parentThreadId && archivedIds.has(thread.parentThreadId)) &&
      thread.sideChat !== true &&
      !(Boolean(thread.parentThreadId) && Boolean(thread.startedByAgent))
  );
}

/** Live roster rows. Side chats, archived threads, and agent-spawned child threads stay out of the main roster. */
export function visibleRosterThreads<
  T extends {
    id?: string;
    sideChat?: boolean;
    parentThreadId?: string | null;
    startedByAgent?: boolean;
    archivedAtUnixMs?: number | null;
  },
>(threads: T[]): T[] {
  return sidebarThreads(threads);
}

export interface ThreadChronologyCandidate {
  id: string;
  lastTurnAtUnixMs?: number | null;
  updatedAtUnixMs?: number;
  createdAtUnixMs?: number;
}

/**
 * Resolves a thread's chronological sort timestamp so active/working threads
 * remain anchored instead of swapping places on intermediate `touch()` ticks.
 */
export function resolveThreadSortTimestamp(
  thread: ThreadChronologyCandidate,
  getWorkingAnchor?: (id: string) => number | undefined,
): number {
  if (typeof thread.lastTurnAtUnixMs === 'number' && Number.isFinite(thread.lastTurnAtUnixMs)) {
    return thread.lastTurnAtUnixMs;
  }
  const anchored = getWorkingAnchor?.(thread.id);
  if (typeof anchored === 'number' && Number.isFinite(anchored)) {
    return anchored;
  }
  if (typeof thread.updatedAtUnixMs === 'number' && Number.isFinite(thread.updatedAtUnixMs)) {
    return thread.updatedAtUnixMs;
  }
  if (typeof thread.createdAtUnixMs === 'number' && Number.isFinite(thread.createdAtUnixMs)) {
    return thread.createdAtUnixMs;
  }
  return 0;
}

/** Sorts threads newest-first with deterministic created-time and ID tie-breakers. */
export function sortThreadsChronologically<T extends ThreadChronologyCandidate>(
  threads: readonly T[],
  getWorkingAnchor?: (id: string) => number | undefined,
): T[] {
  return [...threads].sort((a, b) => {
    const timeDiff =
      resolveThreadSortTimestamp(b, getWorkingAnchor) -
      resolveThreadSortTimestamp(a, getWorkingAnchor);
    if (timeDiff !== 0) return timeDiff;
    const createdDiff = (b.createdAtUnixMs ?? 0) - (a.createdAtUnixMs ?? 0);
    if (createdDiff !== 0) return createdDiff;
    return a.id.localeCompare(b.id);
  });
}

/** Literal turn text for providers that can compact. Others must not be sent. */
export function compactSendText(provider: string): '/compact' | null {
  if (provider === 'codex' || provider === 'claude') return '/compact';
  return null;
}

export interface ActiveSubagentSummaryLike {
  subagentId?: string | null;
  role?: string | null;
  typeName?: string | null;
  provider?: string | null;
  status?: string | null;
  childThreadId?: string | null;
  swarmId?: string | null;
  swarmMemberName?: string | null;
  prompt?: string | null;
  updatedAtUnixMs?: number | null;
}

export interface RosterChildCandidate {
  id: string;
  title?: string;
  provider?: string;
  status?: string;
  updatedAtUnixMs?: number;
  parentThreadId?: string | null;
  startedByAgent?: boolean;
  sideChat?: boolean;
  subagentId?: string | null;
  childThreadId?: string | null;
  subagentRole?: string | null;
  typeName?: string | null;
  prompt?: string | null;
  swarmId?: string | null;
  swarmMemberName?: string | null;
  pendingApproval?: unknown | null;
  pendingUserInput?: unknown | null;
  activeSubagents?: ActiveSubagentSummaryLike[] | null;
  subagentRuns?: ActiveSubagentSummaryLike[] | null;
}

const ACTIVE_SUBAGENT_STATUS_SET = new Set([
  'running',
  'queued',
  'pending',
  'inprogress',
  'in_progress',
  'started',
  'waiting',
  'needsinput',
  'pendingapproval',
  'pending_approval',
  'blocked',
]);

export function childDisplayLabel(child: RosterChildCandidate): string {
  const candidates = [child.subagentRole, child.swarmMemberName, child.title];
  for (const raw of candidates) {
    const trimmed = (raw ?? '').trim();
    if (trimmed && trimmed.toLowerCase() !== 'subagent') {
      return trimmed;
    }
  }
  const typeName = (child.typeName ?? '').trim();
  if (
    typeName &&
    typeName.toLowerCase() !== (child.provider ?? '').trim().toLowerCase() &&
    typeName.toLowerCase() !== 'subagent'
  ) {
    return typeName.charAt(0).toUpperCase() + typeName.slice(1);
  }
  const prompt = (child.prompt ?? '').replace(/\s+/g, ' ').trim();
  if (prompt) {
    return prompt.length > 32 ? `${prompt.slice(0, 31).trimEnd()}…` : prompt;
  }
  return 'Subagent';
}

export type ChildAttentionKind = 'approval' | 'input' | 'running' | 'blocked';

export function isActiveOrAttentionChild(thread: RosterChildCandidate): boolean {
  if (!thread.parentThreadId || thread.parentThreadId === thread.id) return false;
  if (!thread.startedByAgent && !thread.sideChat) return false;
  if (Boolean(thread.pendingApproval) || Boolean(thread.pendingUserInput)) return true;
  return thread.status === 'running' || thread.status === 'waiting' || thread.status === 'pendingApproval';
}

export function classifyChildAttention(thread: RosterChildCandidate): ChildAttentionKind {
  if (thread.pendingApproval) return 'approval';
  if (thread.pendingUserInput) return 'input';
  const s = (thread.status ?? '').trim().toLowerCase();
  if (s === 'pendingapproval' || s === 'pending_approval') return 'approval';
  if (s === 'needsinput' || s === 'needs_input') return 'input';
  if (s === 'waiting' || s === 'blocked') return 'blocked';
  if (s === 'running' || s === 'queued' || s === 'pending' || s === 'inprogress' || s === 'in_progress' || s === 'started') {
    return 'running';
  }
  return 'blocked';
}

export function childAttentionLabel(kind: ChildAttentionKind): string {
  switch (kind) {
    case 'approval':
      return 'Needs approval';
    case 'input':
      return 'Needs input';
    case 'running':
      return 'Running';
    case 'blocked':
      return 'Blocked';
  }
}

function childAttentionPriority(kind: ChildAttentionKind): number {
  switch (kind) {
    case 'approval':
      return 0;
    case 'input':
      return 1;
    case 'blocked':
      return 2;
    case 'running':
      return 3;
  }
}

export function groupActiveChildrenByParent<T extends RosterChildCandidate>(
  threads: T[],
): Map<string, RosterChildCandidate[]> {
  const byParent = new Map<string, RosterChildCandidate[]>();
  const seenChildThreadIds = new Set<string>();
  const seenSubagentKeys = new Set<string>();

  for (const thread of threads) {
    if (!isActiveOrAttentionChild(thread)) continue;
    const parentId = thread.parentThreadId!;
    if (seenChildThreadIds.has(thread.id)) continue;
    seenChildThreadIds.add(thread.id);
    if (thread.subagentId) {
      seenSubagentKeys.add(`${parentId}:${thread.subagentId}`);
    }
    const list = byParent.get(parentId) ?? [];
    list.push({ ...thread, childThreadId: thread.childThreadId ?? thread.id });
    byParent.set(parentId, list);
  }

  for (const parent of threads) {
    if (parent.parentThreadId && (parent.startedByAgent || parent.sideChat)) continue;
    const embedded = [
      ...(parent.activeSubagents ?? []),
      ...(parent.subagentRuns ?? []),
    ];
    if (embedded.length === 0) continue;
    for (const run of embedded) {
      const status = (run.status ?? '').trim().toLowerCase();
      if (!ACTIVE_SUBAGENT_STATUS_SET.has(status)) continue;
      const ctid = (run.childThreadId ?? '').trim();
      const sid = (run.subagentId ?? '').trim();
      if (ctid && seenChildThreadIds.has(ctid)) {
        const list = byParent.get(parent.id);
        const existing = list?.find((item) => item.id === ctid || item.childThreadId === ctid);
        if (existing && !existing.subagentId && sid) {
          existing.subagentId = sid;
        }
        continue;
      }
      if (sid && seenSubagentKeys.has(`${parent.id}:${sid}`)) continue;
      const syntheticId = ctid || sid;
      if (!syntheticId) continue;
      if (ctid) seenChildThreadIds.add(ctid);
      if (sid) seenSubagentKeys.add(`${parent.id}:${sid}`);
      const list = byParent.get(parent.id) ?? [];
      list.push({
        id: syntheticId,
        subagentId: sid || null,
        childThreadId: ctid || null,
        parentThreadId: parent.id,
        startedByAgent: true,
        subagentRole: run.role ?? null,
        typeName: run.typeName ?? null,
        provider: run.provider ?? parent.provider,
        status: run.status ?? 'running',
        swarmId: run.swarmId ?? null,
        swarmMemberName: run.swarmMemberName ?? null,
        prompt: run.prompt ?? null,
        updatedAtUnixMs: run.updatedAtUnixMs ?? undefined,
      });
      byParent.set(parent.id, list);
    }
  }

  for (const list of byParent.values()) {
    list.sort((a, b) => {
      const pDiff =
        childAttentionPriority(classifyChildAttention(a)) -
        childAttentionPriority(classifyChildAttention(b));
      if (pDiff !== 0) return pDiff;
      return (b.updatedAtUnixMs ?? 0) - (a.updatedAtUnixMs ?? 0);
    });
  }
  return byParent;
}

export interface ParentThreadRollup {
  effectiveStatus: string | undefined;
  runningCount: number;
  attentionCount: number;
  hasApproval: boolean;
  hasInput: boolean;
  hasBlocked: boolean;
  rollupBadge: string | null;
}

export function parentThreadRollupStatus(
  parent: { status?: string },
  activeChildren: RosterChildCandidate[],
): ParentThreadRollup {
  if (activeChildren.length === 0) {
    return {
      effectiveStatus: parent.status,
      runningCount: 0,
      attentionCount: 0,
      hasApproval: false,
      hasInput: false,
      hasBlocked: false,
      rollupBadge: null,
    };
  }
  let runningCount = 0;
  let hasApproval = false;
  let hasInput = false;
  let hasBlocked = false;
  let attentionCount = 0;
  for (const child of activeChildren) {
    const kind = classifyChildAttention(child);
    if (kind === 'running') {
      runningCount += 1;
    } else {
      attentionCount += 1;
      if (kind === 'approval') hasApproval = true;
      else if (kind === 'input') hasInput = true;
      else hasBlocked = true;
    }
  }
  const effectiveStatus =
    parent.status === 'error'
      ? 'error'
      : hasApproval || hasInput || hasBlocked
        ? 'waiting'
        : runningCount > 0 || parent.status === 'running'
          ? 'running'
          : parent.status;
  const rollupBadge = hasApproval
    ? attentionCount > 1
      ? `${attentionCount} need approval`
      : 'Needs approval'
    : hasInput
      ? 'Needs input'
      : hasBlocked
        ? `${attentionCount} blocked`
        : runningCount === 1
          ? '1 subagent'
          : `${runningCount} subagents`;
  return {
    effectiveStatus,
    runningCount,
    attentionCount,
    hasApproval,
    hasInput,
    hasBlocked,
    rollupBadge,
  };
}
