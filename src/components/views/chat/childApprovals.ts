import type { ApprovalRequest } from './types';

export interface ChildThreadRef {
  id: string;
  title?: string | null;
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

export function childApprovals(parentId: string, threads: ChildThreadRef[]): ChildApprovalRow[] {
  return threads.flatMap((thread) => {
    if (thread.sideChat || thread.id === parentId) return [];
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
    .filter((thread) => thread.parentThreadId === parentId && thread.id !== parentId && thread.sideChat !== true)
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
