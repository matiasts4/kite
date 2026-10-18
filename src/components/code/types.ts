export type PaneAxis = 'vertical' | 'horizontal';

export interface PaneRuntimeInfo {
  engine: string;
  displayName: string;
  workTitle?: string | null;
  agentName?: string;
  paneId?: string;
}

export interface PaneOccupantTerminal {
  kind: 'terminal';
  sessionId: string;
  label?: string;
  engine?: string;
  runtime?: PaneRuntimeInfo;
}

export interface PaneOccupantThread {
  kind: 'thread';
  threadId: string;
  title?: string;
}

export type PaneOccupant = PaneOccupantTerminal | PaneOccupantThread;

export interface PaneLeaf {
  type: 'leaf';
  id: string;
  occupant: PaneOccupant;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  axis: PaneAxis;
  children: PaneNode[];
  ratios: number[];
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface WorkspaceTab {
  id: string;
  title: string;
  root: PaneNode;
  focusedLeafId: string;
}

export interface WorkspaceLayout {
  schemaVersion: number;
  workspaceId: string;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  fullscreenLeafId: string | null;
}

export interface AgentEngineDescriptor {
  wireId: string;
  displayName: string;
  shortDisplayName: string;
  vendor: string;
  installHint?: string;
  installed?: boolean;
}

export interface LaunchPreset {
  id: string;
  title: string;
  seats: number;
  description: string;
  engines: string[];
}
