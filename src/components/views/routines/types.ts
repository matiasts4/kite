export type RoutineTriggerType = 'schedule' | 'cron' | 'webhook' | 'event' | 'manual';
export type RoutinePermissionMode = 'readOnly' | 'auto' | 'fullAccess';
export type RoutineEventKind =
  | 'on_git_commit'
  | 'on_branch_change'
  | 'on_task_state_change'
  | 'on_teammate_message'
  | 'on_routine_complete';

export type RoutineOutputAction =
  | 'notify_desktop'
  | 'announce_via_argos'
  | 'create_kite_task_on_findings'
  | 'notify_teammate';

export type RoutineCadence =
  | { kind: 'interval'; seconds: number }
  | { kind: 'clock'; hour: number; minute: number; weekdays: number[] | null }
  | { kind: 'cron'; expr: string }
  | { kind: 'event'; eventKind: RoutineEventKind; debounceSecs?: number; sourceRoutineId?: string | null };

export interface RoutineRunRecord {
  runId: string;
  routineId: string;
  agentId: string;
  triggerKind: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | string;
  startedAtUnixMs: number;
  finishedAtUnixMs: number | null;
  threadId: string | null;
  summary: string | null;
  changedFilesCount: number;
  retryAttempt: number;
  error: string | null;
}

export interface RoutineItem {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cadence: RoutineCadence;
  enabled: boolean;
  author: 'builder' | 'agent' | { kind: string } | string;
  workspaceId: string | null;
  createdAtUnixMs: number;
  nextRunAtUnixMs: number;
  lastRunAtUnixMs: number | null;
  lastRunThreadId: string | null;
  lastError: string | null;
  permissionMode?: RoutinePermissionMode;
  triggerType?: RoutineTriggerType;
  maxRetries?: number;
  outputActions?: RoutineOutputAction[];
  notifyTeammateId?: string | null;
}

export interface RoutineAgentRevision {
  agentId: string;
  revision: string;
}

export interface RoutineRunNowAvailability {
  available: boolean;
  reason: string;
}

export interface RoutineCollection {
  schemaVersion: number;
  routines: RoutineItem[];
  agentRevisions: RoutineAgentRevision[];
  runNowAvailability: RoutineRunNowAvailability;
}

export interface CadencePreset {
  id: string;
  label: string;
  title: string;
  cadence: RoutineCadence;
}

export interface RoutineDraft {
  name: string;
  prompt: string;
  agentId: string;
  triggerType: RoutineTriggerType;
  cadence: RoutineCadence;
  workspaceId: string | null;
  permissionMode?: RoutinePermissionMode;
  maxRetries?: number;
  outputActions?: RoutineOutputAction[];
  notifyTeammateId?: string | null;
}
