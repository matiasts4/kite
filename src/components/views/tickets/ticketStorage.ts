import type {
  TicketIssue,
  TicketLabel,
  TicketProject,
  TicketConnection,
} from './types';

export const PRIMARY_STORAGE_KEY = 'KITE_STORAGE_TICKETS_ISSUES';
export const LEGACY_STORAGE_KEY = 'BM_STORAGE_TICKETS_ISSUES';
export const LEGACY_STORAGE_KEY_V1 = 'kite_tickets_issues_v1';
export const BACKUP_STORAGE_KEY = 'KITE_STORAGE_TICKETS_BACKUP';
export const LABELS_STORAGE_KEY = 'KITE_STORAGE_TICKETS_LABELS';
export const PROJECTS_STORAGE_KEY = 'KITE_STORAGE_TICKETS_PROJECTS';
export const CONNECTIONS_STORAGE_KEY = 'KITE_STORAGE_TICKETS_CONNECTIONS';
export const VIEW_STORAGE_KEY = 'kite-code.tasks-view.v1';

export function readStoredView(): 'board' | 'list' {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return 'board';
    const parsed = JSON.parse(raw);
    return parsed === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

export function persistStoredView(mode: 'board' | 'list'): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(mode));
  } catch {}
}

export function readStoredIssues(): TicketIssue[] {
  try {
    const stored =
      localStorage.getItem(PRIMARY_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_STORAGE_KEY) ||
      localStorage.getItem(LEGACY_STORAGE_KEY_V1);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // fallback
  }
  return [];
}

export function persistIssuesWithBackup(issues: TicketIssue[]): void {
  try {
    const prev = localStorage.getItem(PRIMARY_STORAGE_KEY);
    const serial = JSON.stringify(issues);
    if (prev && prev !== serial) {
      localStorage.setItem(BACKUP_STORAGE_KEY, prev);
    }
    localStorage.setItem(PRIMARY_STORAGE_KEY, serial);
    localStorage.setItem(LEGACY_STORAGE_KEY, serial);
    localStorage.setItem(LEGACY_STORAGE_KEY_V1, serial);
  } catch {}
}

export function readStoredBackup(): TicketIssue[] | null {
  try {
    const backupRaw = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (backupRaw) {
      const parsed = JSON.parse(backupRaw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return null;
}

export function readStoredLabels(): TicketLabel[] {
  try {
    const stored = localStorage.getItem(LABELS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [
    { id: 'lbl-frontend', name: 'Frontend' },
    { id: 'lbl-backend', name: 'Backend' },
    { id: 'lbl-bug', name: 'Bug' },
    { id: 'lbl-feature', name: 'Feature' },
  ];
}

export function persistLabels(labels: TicketLabel[]): void {
  try {
    localStorage.setItem(LABELS_STORAGE_KEY, JSON.stringify(labels));
  } catch {}
}

export function readStoredProjects(): TicketProject[] {
  try {
    const stored = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [
    { id: 'proj-kite', name: 'Kite Code' },
    { id: 'proj-agents', name: 'Agents & MCP' },
  ];
}

export function persistProjects(projects: TicketProject[]): void {
  try {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {}
}

export function readStoredConnections(): TicketConnection[] {
  try {
    const stored = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function persistConnections(connections: TicketConnection[]): void {
  try {
    localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
  } catch {}
}
