export interface OpenRightDockSubagentDetail {
  threadId: string;
  subagentId?: string | null;
  childThreadId?: string | null;
  swarmId?: string | null;
  mode?: 'subagent' | 'swarm';
  workspaceId?: string | null;
}

export const OPEN_RIGHT_DOCK_SUBAGENT_EVENT = 'kite:open-right-dock-subagent';
export const SUBAGENT_INSPECTION_CHANGE_EVENT = 'kite:subagent-inspection-changed';

let pendingSubagentRequest: OpenRightDockSubagentDetail | null = null;
let activeInspectionTarget: OpenRightDockSubagentDetail | null = null;

export function setActiveSubagentInspection(next: OpenRightDockSubagentDetail | null) {
  activeInspectionTarget = next ? { ...next } : null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<OpenRightDockSubagentDetail | null>(SUBAGENT_INSPECTION_CHANGE_EVENT, {
        detail: activeInspectionTarget,
      })
    );
  }
}

export function getActiveSubagentInspection(): OpenRightDockSubagentDetail | null {
  return activeInspectionTarget;
}

export function openSubagentInRightDock(req: OpenRightDockSubagentDetail) {
  pendingSubagentRequest = { ...req };
  setActiveSubagentInspection(pendingSubagentRequest);
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
