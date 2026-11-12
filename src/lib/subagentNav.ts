export interface OpenRightDockSubagentDetail {
  threadId: string;
  subagentId?: string | null;
  childThreadId?: string | null;
  swarmId?: string | null;
  mode?: 'subagent' | 'swarm';
  workspaceId?: string | null;
}

export const OPEN_RIGHT_DOCK_SUBAGENT_EVENT = 'kite:open-right-dock-subagent';

let pendingSubagentRequest: OpenRightDockSubagentDetail | null = null;

export function openSubagentInRightDock(req: OpenRightDockSubagentDetail) {
  pendingSubagentRequest = { ...req };
  window.dispatchEvent(
    new CustomEvent<OpenRightDockSubagentDetail>(OPEN_RIGHT_DOCK_SUBAGENT_EVENT, {
      detail: pendingSubagentRequest,
    })
  );
}

export function consumePendingSubagentRequest(): OpenRightDockSubagentDetail | null {
  const req = pendingSubagentRequest;
  pendingSubagentRequest = null;
  return req;
}

export function peekPendingSubagentRequest(): OpenRightDockSubagentDetail | null {
  return pendingSubagentRequest;
}

export function formatShortModelLabel(
  model?: string | null,
  provider?: string | null
): string | null {
  const m = (model ?? '').trim();
  const p = (provider ?? '').trim();
  if (m && p && !m.toLowerCase().includes(p.toLowerCase())) {
    return `${p} · ${m}`;
  }
  return m || p || null;
}
