import type {
  PaneNode,
  PaneOccupant,
  PaneOccupantTerminal,
  WorkspaceTab,
  WorkspaceLayout,
  PaneAxis,
} from './types';
import { invokeCommand } from '../../lib/ipc';
import { releaseTerminal } from '../views/TerminalView';
import { getTerminalAppearancePrefs } from '../../lib/terminalAppearancePrefs';
import { cleanAgentTitle, AGENT_CODENAMES } from '../../lib/agentNames';

export interface LaunchedTerminalSlot {
  index: number;
  sessionId: string;
  paneId: string;
  engine: string;
  displayName: string;
  agentName?: string | null;
  roleLabel: string | null;
  workTitle: string | null;
}

export function listTerminals(node: PaneNode): PaneOccupantTerminal[] {
  if (node.type === 'leaf') {
    return node.occupant.kind === 'terminal' ? [node.occupant] : [];
  }
  return node.children.flatMap(listTerminals);
}

export function findPane(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return node;
  if (node.type === 'split') {
    for (const child of node.children) {
      const found = findPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function collectActiveAgentNames(tabs: WorkspaceTab[]): Set<string> {
  const names = new Set<string>();
  for (const tab of tabs) {
    for (const term of listTerminals(tab.root)) {
      if (term.runtime?.agentName) {
        names.add(term.runtime.agentName.trim().toLowerCase());
      }
      if (term.label) {
        const clean = term.label.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        if (clean) names.add(clean);
      }
      if (term.runtime?.displayName) {
        const clean = term.runtime.displayName.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        if (clean) names.add(clean);
      }
    }
  }
  return names;
}

export function sanitizeWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const sanitizeOccupant = (occ: PaneOccupant): PaneOccupant => {
    if (occ.kind === 'terminal') {
      const cleanLabel = occ.label ? cleanAgentTitle(occ.label) : occ.label;
      const cleanDisplay = occ.runtime?.displayName
        ? cleanAgentTitle(occ.runtime.displayName)
        : occ.runtime?.displayName;
      const cleanWorkTitle = occ.runtime?.workTitle
        ? cleanAgentTitle(occ.runtime.workTitle)
        : occ.runtime?.workTitle;
      return {
        ...occ,
        label: cleanLabel,
        runtime: occ.runtime
          ? {
              ...occ.runtime,
              displayName: cleanDisplay || occ.runtime.displayName,
              workTitle: cleanWorkTitle || occ.runtime.workTitle,
            }
          : undefined,
      };
    }
    return occ;
  };
  const sanitizeNode = (node: PaneNode): PaneNode => {
    if (node.type === 'leaf') {
      return { ...node, occupant: sanitizeOccupant(node.occupant) };
    }
    return { ...node, children: node.children.map(sanitizeNode) };
  };
  return {
    ...layout,
    tabs: (layout.tabs || []).map((tab, idx) => {
      const clean = cleanAgentTitle(tab.title);
      const isAgentName = AGENT_CODENAMES.some((name) => name.toLowerCase() === clean?.toLowerCase());
      const isGeneric = !clean || clean === 'Terminal' || clean === 'Multi-seat Session' || clean === 'Untitled';
      const title = isGeneric || isAgentName ? `Ventana ${idx + 1}` : clean;
      return {
        ...tab,
        title,
        root: sanitizeNode(tab.root),
      };
    }),
  };
}

export function estimateTargetPaneGrid(
  container: HTMLElement | null,
  leafCount: number = 1,
  axis: PaneAxis = 'vertical',
): { columns: number; rows: number } {
  const prefs = getTerminalAppearancePrefs();
  const cellWidth = Math.max(6, prefs.fontSize * 0.6);
  const cellHeight = Math.max(12, Math.round(prefs.fontSize * prefs.lineHeight));
  const rect = container?.getBoundingClientRect();
  const rawWidth = rect && rect.width >= 200 ? rect.width : 960;
  const rawHeight = rect && rect.height >= 140 ? rect.height : 640;
  const count = Math.max(1, leafCount);
  const paneWidth = axis === 'vertical' ? (rawWidth - (count - 1) * 8) / count : rawWidth;
  const paneHeight = (axis === 'horizontal' ? (rawHeight - (count - 1) * 8) / count : rawHeight) - 36;
  const columns = Math.max(20, Math.floor((paneWidth - 21) / cellWidth));
  const rows = Math.max(8, Math.floor((paneHeight - 16) / cellHeight));
  return { columns, rows };
}

export function seatEngine(engine: string): string {
  return engine === 'powershell' || engine === 'terminal' ? 'terminal' : engine;
}

export async function requestWorkspaceTerminals(
  workspaceId: string,
  seats: Array<{ engine: string; label?: string; agentName?: string }>,
  task = '',
  dims?: { columns: number; rows: number },
): Promise<LaunchedTerminalSlot[] | null> {
  void invokeCommand('list_terminal_profiles').catch(() => undefined);
  try {
    const launched = await invokeCommand<{ slots?: LaunchedTerminalSlot[] }>('launch_workspace_terminals', {
      workspaceId,
      requestId: globalThis.crypto.randomUUID(),
      seats: seats.map((seat) => ({
        engine: seatEngine(seat.engine),
        ...(seat.label?.trim() ? { label: seat.label.trim().slice(0, 32) } : {}),
        ...(seat.agentName?.trim() ? { agentName: seat.agentName.trim().slice(0, 32) } : {}),
      })),
      task,
      columns: dims?.columns ?? 80,
      rows: dims?.rows ?? 24,
      confirmedByBuilder: true,
    });
    return launched?.slots?.length ? launched.slots : null;
  } catch {
    return null;
  }
}

export function takeSeatName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  const name = `${base} ${n}`;
  taken.add(name);
  return name;
}

export function releasePaneTerminals(node: PaneNode | null | undefined) {
  if (!node) return;
  for (const terminal of listTerminals(node)) {
    releaseTerminal(terminal.sessionId);
  }
}
