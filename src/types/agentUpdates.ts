export type AgentLifecycleState = 'outdated' | 'up_to_date' | 'not_installed' | 'unknown';

export interface AgentUpdateAdvisory {
  engine: string;
  displayName: string;
  state: AgentLifecycleState;
  currentVersion: string | null;
  latestVersion: string | null;
  updateCommand: string;
  installCommand?: string;
  binaryPath?: string | null;
  checkedAtUnixMs: number;
}

export interface AgentUpdatesSummary {
  totalSupported: number;
  installedCount: number;
  outdatedCount: number;
  advisories: Record<string, AgentUpdateAdvisory>;
  lastCheckedUnixMs: number;
}

export type ToolJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ToolJobProgress {
  jobId: string;
  engine: string;
  action: 'update' | 'install';
  status: ToolJobStatus;
  percent?: number | null;
  lastLine?: string | null;
  error?: string | null;
  startedAtUnixMs: number;
  finishedAtUnixMs?: number | null;
}
