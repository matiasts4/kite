export type TicketState = 'To Do' | 'In Progress' | 'Review' | 'Done';
export type TicketPriority = 'Urgent' | 'High' | 'Medium' | 'Normal' | 'Low' | 'No priority' | number;

export interface TicketLabel {
  id: string;
  name: string;
  revision?: number;
}

export interface TicketProject {
  id: string;
  name: string;
  revision?: number;
}

export interface TicketComment {
  id: string;
  issueId: string;
  parentId?: string | null;
  body: string;
  author: string;
  createdAt: string;
  revision?: number;
}

export interface TicketHistoryEvent {
  id: string;
  issueId?: string | null;
  actor: string;
  action: string;
  createdAt: string;
  changes: Record<string, unknown>;
}

export interface TicketConnection {
  id: string;
  name: string;
  readOnly: boolean;
  revokedAt?: string | null;
}

export interface TicketIssue {
  id: string;
  uuid: string;
  revision?: number;
  title: string;
  description: string;
  state: TicketState;
  priority: TicketPriority;
  assignee: string | null;
  delegate: string | null;
  projectId?: string | null;
  parentId?: string | null;
  duplicateOf?: string | null;
  labels: string[];
  blocks?: string[];
  relatedTo?: string[];
  branch?: string;
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface TaskExecutionRun {
  id?: string;
  taskId?: string;
  taskUuid?: string;
  issueUuid?: string;
  issueId?: string;
  state:
    | 'preparing'
    | 'queued'
    | 'running'
    | 'validating'
    | 'waitingForInput'
    | 'cancelRequested'
    | 'succeeded'
    | 'needsReview'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'idle'
    | 'done'
    | string;
  attempt?: number;
  agentId?: string;
  reviewerId?: string | null;
  workspace?: string | null;
  workspaceId?: string;
  branch?: string | null;
  threadId?: string | null;
  summary?: string;
  receipt?: string;
  startedAt?: string;
  finishedAt?: string;
  lastMessage?: string;
}

export interface AutopilotStatus {
  active: boolean;
  action: 'idle' | 'running' | 'stuck' | 'finished';
  reason?: string;
  turnsRemaining?: number;
  objective?: string;
  model?: string;
}

export interface AutopilotDecision {
  action: 'idle' | 'running' | 'stuck' | 'finished';
  prompt?: string;
  reason?: string;
  objective?: string;
  model?: string;
  turnsRemaining?: number;
  objectivesRemaining?: number;
}

export interface TicketSnapshot {
  schemaVersion: number;
  revision: number;
  issues: TicketIssue[];
  projects?: TicketProject[];
  labels?: Array<TicketLabel | string>;
  comments?: TicketComment[];
  history?: TicketHistoryEvent[];
  connections?: TicketConnection[];
}

export interface TaskExecutionSnapshot {
  schemaVersion: number;
  available?: boolean;
  tasks?: unknown[];
  runs: TaskExecutionRun[];
  lastError?: string | null;
}

export const COLUMNS: TicketState[] = ['To Do', 'In Progress', 'Review', 'Done'];

export const PRIORITY_MAP: Record<string, number> = {
  Urgent: 1,
  High: 2,
  Medium: 3,
  Normal: 3,
  Low: 4,
  'No priority': 0,
};

const LABEL_HUES = [212, 262, 330, 4, 28, 48, 150, 180];

export function getLabelColor(name: string): string {
  let hash = 0;
  for (const ch of name.toLocaleLowerCase()) {
    hash = ((hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0);
  }
  const hue = LABEL_HUES[hash % LABEL_HUES.length] ?? LABEL_HUES[0];
  return `hsl(${hue} 70% 62%)`;
}

export function formatMcpToml(jsonConfig: string): string {
  try {
    const parsed = JSON.parse(jsonConfig);
    const servers = parsed?.mcpServers ?? {};
    const key = Object.keys(servers)[0] || 'kite-tasks';
    const srv = servers[key] || { command: 'kite-code', args: ['mcp', 'tasks'] };
    return `[mcp_servers.${key}]\ncommand = ${JSON.stringify(srv.command)}\nargs = ${JSON.stringify(srv.args)}\n`;
  } catch {
    return `[mcp_servers.kite-tasks]\ncommand = "kite-code"\nargs = ["mcp", "tasks"]\n`;
  }
}

export const PRIORITY_COLORS: Record<
  string,
  { bg: string; text: string; border: string }
> = {
  Urgent: { bg: 'var(--danger-fill)', text: 'var(--danger-ink)', border: 'var(--danger-fill-hover)' },
  High: { bg: 'var(--warning-tint)', text: 'var(--warning-text)', border: 'var(--warning)' },
  Medium: { bg: 'var(--warning-tint)', text: 'var(--warning-text)', border: 'var(--warning)' },
  Normal: { bg: 'var(--chip-fill)', text: 'var(--text-secondary)', border: 'var(--block-stroke)' },
  Low: { bg: 'var(--accent-tint)', text: 'var(--accent)', border: 'var(--accent)' },
  'No priority': { bg: 'var(--block-fill)', text: 'var(--text-secondary)', border: 'var(--block-stroke)' },
};

