import type { ApprovalRequest } from './types';

export interface ChildThreadRef {
  id: string;
  title?: string | null;
  status?: string | null;
  parentThreadId?: string | null;
  pendingApproval?: ApprovalRequest | null;
  sideChat?: boolean;
  startedByAgent?: boolean;
}

export interface ChildApprovalRow {
  threadId: string;
  title: string;
  approval: ApprovalRequest;
}

const SETTLED_CHILD_STATUSES = new Set(['idle', 'completed', 'error', 'killed']);

export function childApprovals(parentId: string, threads: ChildThreadRef[]): ChildApprovalRow[] {
  return threads.flatMap((thread) => {
    if (thread.id === parentId) return [];
    if (thread.parentThreadId !== parentId || !thread.pendingApproval) return [];
    return [{
      threadId: thread.id,
      title: thread.title?.trim() || 'Untitled',
      approval: thread.pendingApproval,
    }];
  });
}

export interface ChildRunStopRef {
  childThreadId?: string | null;
  status?: string | null;
}

export function childStopIds(
  parentId: string,
  threads: ChildThreadRef[],
  subagentRuns?: ChildRunStopRef[] | null
): string[] {
  const ids = new Set<string>();
  for (const thread of threads) {
    if (thread.parentThreadId !== parentId || thread.id === parentId) continue;
    if (!thread.status || !SETTLED_CHILD_STATUSES.has(thread.status) || Boolean(thread.pendingApproval)) {
      ids.add(thread.id);
    }
  }
  for (const run of subagentRuns ?? []) {
    const childId = run.childThreadId?.trim();
    if (!childId || childId === parentId) continue;
    if (!run.status || !SETTLED_CHILD_STATUSES.has(run.status)) {
      ids.add(childId);
    }
  }
  return Array.from(ids);
}

export const DIRECT_MESSAGE_NOTICE = 'Message the parent thread.';

export function directMessageNotice(thread: {
  startedByAgent?: boolean;
  parentThreadId?: string | null;
}): string | null {
  if (thread.startedByAgent && thread.parentThreadId) return DIRECT_MESSAGE_NOTICE;
  return null;
}

export function bringBackAllowed(parentRunning: boolean): boolean {
  return parentRunning === false;
}
