type NewThreadHandler = (workspaceId: string | null) => void;

let handler: NewThreadHandler | null = null;
let pendingWorkspaceId: string | null | undefined;
let heldThreadId: string | null = null;

/** Ask the open thread session to create and focus a thread. Queues until that session is mounted. */
export function requestNewThread(workspaceId?: string | null): void {
  const next = workspaceId ?? null;
  if (handler) {
    handler(next);
    return;
  }
  pendingWorkspaceId = next;
}

export function registerNewThreadHandler(next: NewThreadHandler): () => void {
  handler = next;
  if (pendingWorkspaceId !== undefined) {
    const queued = pendingWorkspaceId;
    pendingWorkspaceId = undefined;
    next(queued);
  }
  return () => {
    if (handler === next) handler = null;
  };
}

/** Keep this id selected once the thread list includes it, even if an earlier refresh has not seen it yet. */
export function holdThreadSelection(threadId: string): void {
  heldThreadId = threadId;
}

/**
 * Selection after a thread-list refresh.
 * With no hold, an id still in the list stays, and a missing id falls back to the first row.
 * A hold wins once that id is in the list, and does not fall back while the list is still catching up.
 */
export function resolveHeldThreadSelection(current: string | null, ids: readonly string[]): string | null {
  if (heldThreadId) {
    if (ids.includes(heldThreadId)) {
      const id = heldThreadId;
      heldThreadId = null;
      return id;
    }
    return current;
  }
  if (current && ids.includes(current)) return current;
  return ids[0] ?? null;
}
