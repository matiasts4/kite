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

export function childStopIds(parentId: string, threads: ChildThreadRef[]): string[] {
  return threads
    .filter((thread) => {
      if (thread.parentThreadId !== parentId || thread.id === parentId) return false;
      if (!thread.status) return true;
      return !SETTLED_CHILD_STATUSES.has(thread.status) || Boolean(thread.pendingApproval);
    })
    .map((thread) => thread.id);
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
