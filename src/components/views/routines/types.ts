export type RoutineTriggerType = 'schedule' | 'webhook' | 'event' | 'manual';

export type RoutineCadence =
  | { kind: 'interval'; seconds: number }
  | { kind: 'clock'; hour: number; minute: number; weekdays: number[] | null };

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
  triggerType?: RoutineTriggerType;
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
}
