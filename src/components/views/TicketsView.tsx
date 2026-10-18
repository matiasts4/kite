import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  getTicketSnapshot,
  getTaskExecutionSnapshot,
  ticketCall,
  ticketConnect,
  ticketConfiguration,
  ticketRevoke,
  ticketRecover,
  listAgents,
} from '../../lib/ipc';
import {
  TicketIssue,
  TicketState,
  TicketPriority,
  TaskExecutionRun,
  TicketSnapshot,
  TicketLabel,
  TicketProject,
  TicketConnection,
  COLUMNS,
  getLabelColor,
} from './tickets/types';
import { TicketCard, StateGlyph, PriorityGlyph, TicketAvatar } from './tickets/TicketCard';
import { TicketDetailView } from './tickets/TicketDetailView';
import { CreateTicketModal } from './tickets/CreateTicketModal';
import { ConnectMcpModal } from './tickets/ConnectMcpModal';
import { LabelsProjectsModal } from './tickets/LabelsProjectsModal';
import { DispatchTaskModal } from './tickets/DispatchTaskModal';
import { SelectMenu } from '../ui/SelectMenu';
import {
  ChevronRightGlyph,
  SearchGlyph,
  MoreHorizontalGlyph,
  PlusGlyph,
  CloseGlyph,
  ListGlyph,
  KanbanGlyph,
} from '../dockIcons';
import type { AgentProfile, Workspace } from '../../types';

export type { TicketIssue, TicketState, TicketPriority, TaskExecutionRun };

const PRIMARY_STORAGE_KEY = 'KITE_STORAGE_TICKETS_ISSUES';
const LEGACY_STORAGE_KEY = 'BM_STORAGE_TICKETS_ISSUES';
const LEGACY_STORAGE_KEY_V1 = 'kite_tickets_issues_v1';
const BACKUP_STORAGE_KEY = 'KITE_STORAGE_TICKETS_BACKUP';
const LABELS_STORAGE_KEY = 'KITE_STORAGE_TICKETS_LABELS';
const PROJECTS_STORAGE_KEY = 'KITE_STORAGE_TICKETS_PROJECTS';
const CONNECTIONS_STORAGE_KEY = 'KITE_STORAGE_TICKETS_CONNECTIONS';
const VIEW_STORAGE_KEY = 'kite-code.tasks-view.v1';

// Authentic Lucide Icons matching TicketsPane-DO5xx3h1.js
const ArchiveGlyph: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
);

const TagGlyph: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
  </svg>
);

const PlugGlyph: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 22v-5" />
    <path d="M15 8V2" />
    <path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z" />
    <path d="M9 8V2" />
  </svg>
);

const RotateCcwClockGlyph: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const ListFilterGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 5h20" />
    <path d="M6 12h12" />
    <path d="M9 19h6" />
  </svg>
);

const BotGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
);

const ExternalOpenGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
    <path d="m21 3-9 9" />
    <path d="M15 3h6v6" />
  </svg>
);

const SendGlyph: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
    <path d="m21.854 2.147-10.94 10.939" />
  </svg>
);

const ChevronDownMini: React.FC<{ size?: number }> = ({ size = 10 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

function readStoredView(): 'board' | 'list' {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return 'board';
    const parsed = JSON.parse(raw);
    return parsed === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

export interface TicketsViewProps {
  workspaces?: Workspace[];
  selectedWorkspaceId?: string | null;
}

export const TicketsView: React.FC<TicketsViewProps> = ({
  workspaces = [],
  selectedWorkspaceId = null,
}) => {
  // State for issues: loaded from local storage cache, synchronized with ticket_snapshot
  const [issues, setIssues] = useState<TicketIssue[]>(() => {
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
  });

  const [labels, setLabels] = useState<TicketLabel[]>(() => {
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
  });

  const [projects, setProjects] = useState<TicketProject[]>(() => {
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
  });

  const [connections, setConnections] = useState<TicketConnection[]>(() => {
    try {
      const stored = localStorage.getItem(CONNECTIONS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  });

  const [snapshot, setSnapshot] = useState<TicketSnapshot | null>(null);
  const [taskRuns, setTaskRuns] = useState<TaskExecutionRun[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [activeView, setActiveView] = useState<'board' | 'list'>(() => readStoredView());
  const [statusFilter, setStatusFilter] = useState<'all' | TicketState>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TicketState>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<'composer' | 'metadata' | 'mcp' | null>(null);
  const [dispatchIssue, setDispatchIssue] = useState<TicketIssue | null>(null);
  const [confirmRestoreBackup, setConfirmRestoreBackup] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newIssueState, setNewIssueState] = useState<TicketState>('To Do');
  const [dragTargetStatus, setDragTargetStatus] = useState<TicketState | null>(null);
  const [draggedIssueId, setDraggedIssueId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    issue: TicketIssue;
    x: number;
    y: number;
  } | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Clear notice after 6s
  useEffect(() => {
    if (!noticeMessage) return;
    const timer = window.setTimeout(() => setNoticeMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [noticeMessage]);

  // Persist view mode
  const handleViewChange = (mode: 'board' | 'list') => {
    setActiveView(mode);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(mode));
    } catch {}
  };

  // Map of active runs
  const runsMap = useMemo(() => {
    const map = new Map<string, TaskExecutionRun>();
    for (const run of taskRuns) {
      if (run.taskId) map.set(run.taskId, run);
      if (run.taskUuid) map.set(run.taskUuid, run);
      if (run.issueUuid) map.set(run.issueUuid, run);
      if (run.issueId) map.set(run.issueId, run);
    }
    return map;
  }, [taskRuns]);

  // Combined snapshot with local metadata fallback
  const mergedSnapshot = useMemo((): TicketSnapshot => {
    return {
      schemaVersion: snapshot?.schemaVersion ?? 1,
      revision: snapshot?.revision ?? 1,
      issues,
      labels:
        snapshot?.labels && snapshot.labels.length > 0 ? snapshot.labels : labels,
      projects:
        snapshot?.projects && snapshot.projects.length > 0
          ? snapshot.projects
          : projects,
      comments: snapshot?.comments ?? [],
      history: snapshot?.history ?? [],
      connections:
        snapshot?.connections && snapshot.connections.length > 0
          ? snapshot.connections
          : connections,
    };
  }, [snapshot, issues, labels, projects, connections]);

  // Fetch snapshots from Tauri IPC
  const fetchSnapshots = useCallback(async () => {
    try {
      const snap = await getTicketSnapshot();
      if (snap) {
        setSnapshot(snap);
        if (Array.isArray(snap.issues) && snap.issues.length > 0) {
          const mapped: TicketIssue[] = snap.issues.map((it: any) => ({
            id: it.id || `KITE-${Math.floor(Math.random() * 900) + 100}`,
            uuid:
              it.uuid ||
              (typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : 'temp-id'),
            revision: it.revision ?? 1,
            title: it.title || 'Untitled Task',
            description: it.description || '',
            state: (it.state as TicketState) || 'To Do',
            priority: (it.priority as TicketPriority) || 'Medium',
            assignee: it.assignee || null,
            delegate: it.delegate || null,
            projectId: it.projectId || null,
            parentId: it.parentId || null,
            duplicateOf: it.duplicateOf || null,
            labels: Array.isArray(it.labels) ? it.labels : [],
            blocks: Array.isArray(it.blocks) ? it.blocks : [],
            relatedTo: Array.isArray(it.relatedTo) ? it.relatedTo : [],
            branch: it.branch,
            dueDate: it.dueDate || null,
            createdAt: it.createdAt || new Date().toISOString(),
            updatedAt: it.updatedAt || new Date().toISOString(),
            archivedAt: it.archivedAt || null,
          }));
          setIssues(mapped);
        }
        if (Array.isArray(snap.labels) && snap.labels.length > 0) {
          setLabels(
            snap.labels.map((l: any) =>
              typeof l === 'string' ? { id: l, name: l } : { id: l.id, name: l.name }
            )
          );
        }
        if (Array.isArray(snap.projects) && snap.projects.length > 0) {
          setProjects(snap.projects);
        }
        if (Array.isArray(snap.connections) && snap.connections.length > 0) {
          setConnections(snap.connections);
        }
      }
    } catch {
      // IPC not ready or offline fallback
    }

    try {
      const taskSnap = await getTaskExecutionSnapshot();
      if (taskSnap && Array.isArray(taskSnap.runs)) {
        setTaskRuns(taskSnap.runs as TaskExecutionRun[]);
      }
    } catch {}

    try {
      const loadedAgents = await listAgents();
      if (Array.isArray(loadedAgents)) {
        setAgents(loadedAgents);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchSnapshots();
    const interval = setInterval(fetchSnapshots, 5000);
    return () => clearInterval(interval);
  }, [fetchSnapshots]);

  // Persist to local storage & maintain rolling backup
  useEffect(() => {
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
  }, [issues]);

  useEffect(() => {
    try {
      localStorage.setItem(LABELS_STORAGE_KEY, JSON.stringify(labels));
    } catch {}
  }, [labels]);

  useEffect(() => {
    try {
      localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
    } catch {}
  }, [projects]);

  useEffect(() => {
    try {
      localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(connections));
    } catch {}
  }, [connections]);

  // Close menus on Escape
  useEffect(() => {
    if (!isMenuOpen && !contextMenu) return;
    const handleDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
        setContextMenu(null);
      }
    };
    window.addEventListener('keydown', handleDown);
    return () => window.removeEventListener('keydown', handleDown);
  }, [isMenuOpen, contextMenu]);

  const handleMoveIssue = (id: string, newState: TicketState) => {
    setIssues((prev) =>
      prev.map((i) =>
        i.id === id ? { ...i, state: newState, updatedAt: new Date().toISOString() } : i
      )
    );
    ticketCall('save_issue', { id, state: newState }).catch(() => {});
  };

  const handleArchiveIssue = (issue: TicketIssue) => {
    setIssues((prev) =>
      prev.map((i) =>
        i.id === issue.id ? { ...i, archivedAt: new Date().toISOString() } : i
      )
    );
    ticketCall('archive_issue', { id: issue.id }).catch(() => {});
    if (selectedIssueId === issue.id) {
      setSelectedIssueId(null);
    }
  };

  const handleRestoreIssue = (issue: TicketIssue) => {
    setIssues((prev) =>
      prev.map((i) => (i.id === issue.id ? { ...i, archivedAt: null } : i))
    );
    ticketCall('restore_issue', { id: issue.id }).catch(() => {});
  };

  const handleSaveDetail = async (tool: string, args: any) => {
    if (tool === 'save_issue' && args?.id) {
      setIssues((prev) =>
        prev.map((i) =>
          i.id === args.id
            ? {
                ...i,
                ...args,
                updatedAt: new Date().toISOString(),
              }
            : i
        )
      );
    }
    try {
      await ticketCall(tool, args);
      await fetchSnapshots();
      return true;
    } catch {
      return true;
    }
  };

  const handleCreateIssue = async (data: {
    title: string;
    description: string;
    priority: TicketPriority;
    state: TicketState;
    assignee: string | null;
    labels: string[];
    dueDate?: string | null;
    project?: string;
  }) => {
    const nextNum = issues.length + 1;
    const nextId = `KITE-${nextNum}`;
    const newIssue: TicketIssue = {
      id: nextId,
      uuid:
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : nextId,
      revision: 1,
      title: data.title,
      description: data.description,
      priority: data.priority,
      state: data.state,
      assignee: data.assignee,
      delegate: null,
      projectId: data.project || null,
      labels: data.labels,
      blocks: [],
      relatedTo: [],
      dueDate: data.dueDate || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    setIssues((prev) => [newIssue, ...prev]);
    setActiveSheet(null);

    try {
      await ticketCall('save_issue', { issue: newIssue, ...data });
      await fetchSnapshots();
    } catch {}
  };

  const handleAddLabel = async (name: string): Promise<boolean> => {
    const exists = labels.some((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!exists) {
      const next: TicketLabel = {
        id: `lbl-${Date.now()}`,
        name,
      };
      setLabels((prev) => [...prev, next]);
    }
    try {
      await ticketCall('save_issue_label', { name });
    } catch {}
    return true;
  };

  const handleAddProject = async (name: string): Promise<boolean> => {
    const exists = projects.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!exists) {
      const next: TicketProject = {
        id: `proj-${Date.now()}`,
        name,
      };
      setProjects((prev) => [...prev, next]);
    }
    try {
      await ticketCall('save_project', { name });
    } catch {}
    return true;
  };

  const handleMcpConnect = async (name: string, readOnly: boolean): Promise<string> => {
    setBusy(true);
    try {
      const res = await ticketConnect(name, readOnly);
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `conn-${Date.now()}`;
      setConnections((prev) => [
        ...prev,
        { id, name, readOnly, revokedAt: null },
      ]);
      return JSON.stringify(res, null, 2);
    } finally {
      setBusy(false);
    }
  };

  const handleMcpConfiguration = async (id: string): Promise<string> => {
    setBusy(true);
    try {
      const conn = connections.find((c) => c.id === id);
      const res = await ticketConfiguration(id);
      if (conn && res?.mcpServers) {
        return JSON.stringify(
          {
            mcpServers: {
              'kite-tasks': {
                command: 'kite-code',
                args: [
                  'mcp',
                  'tasks',
                  ...(conn.readOnly ? ['--read-only'] : []),
                  '--connection-id',
                  conn.id,
                ],
              },
            },
          },
          null,
          2
        );
      }
      return JSON.stringify(res, null, 2);
    } finally {
      setBusy(false);
    }
  };

  const handleMcpRevoke = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await ticketRevoke(id);
      setConnections((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, revokedAt: new Date().toISOString() } : c
        )
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRecoverBackup = async () => {
    setBusy(true);
    try {
      await ticketRecover();
      const backupRaw = localStorage.getItem(BACKUP_STORAGE_KEY);
      if (backupRaw) {
        const parsed = JSON.parse(backupRaw);
        if (Array.isArray(parsed)) {
          setIssues(parsed);
        }
      }
      setConnections((prev) =>
        prev.map((c) => ({ ...c, revokedAt: new Date().toISOString() }))
      );
      setConfirmRestoreBackup(false);
      setNoticeMessage('Restored the previous saved version of local tasks.');
    } catch {
      setConfirmRestoreBackup(false);
    } finally {
      setBusy(false);
    }
  };

  const scrollToColumn = (status: TicketState) => {
    if (!scrollerRef.current) return;
    const colEl = scrollerRef.current.querySelector(
      `.ticket-board__column[data-board-status="${status}"]`
    ) as HTMLElement | null;
    if (colEl) {
      scrollerRef.current.scrollTo({
        left: colEl.offsetLeft - scrollerRef.current.offsetLeft,
        behavior: 'smooth',
      });
    }
  };

  const filteredIssues = useMemo(() => {
    return issues.filter((i) => {
      if (!showArchived && i.archivedAt) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        i.id.toLowerCase().includes(q) ||
        i.title.toLowerCase().includes(q) ||
        (i.description && i.description.toLowerCase().includes(q)) ||
        (i.labels && i.labels.some((l) => l.toLowerCase().includes(q)))
      );
    });
  }, [issues, showArchived, searchQuery]);

  const currentSelectedIssue = useMemo(
    () => issues.find((i) => i.id === selectedIssueId) || null,
    [issues, selectedIssueId]
  );

  const totalCount = filteredIssues.length;

  const statusFilterRows = useMemo(() => {
    const allCount = filteredIssues.length;
    return [
      {
        id: 'all',
        title: 'All statuses',
        badge: String(allCount),
      },
      ...COLUMNS.map((col, idx) => ({
        id: col,
        title: col,
        badge: String(filteredIssues.filter((i) => i.state === col).length),
        icon: <StateGlyph state={col} />,
        ruleBefore: idx === 0,
      })),
    ];
  }, [filteredIssues]);

  const toggleGroupCollapse = (col: TicketState) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  return (
    <section aria-label="Tasks" className="pane tickets-pane">
      {/* Header */}
      <header className="tickets-header">
        <nav aria-label="Breadcrumb" className="tickets-crumb">
          <span className="tickets-crumb__root">Kite</span>
          <ChevronRightGlyph className="tickets-crumb__chevron" size={12} strokeWidth={2} />
          <span className="tickets-crumb__current">Tasks</span>
        </nav>

        {activeView === 'list' && !currentSelectedIssue ? (
          <div className="tickets-status">
            <SelectMenu
              help="Filter tasks by status"
              label="Status filter"
              panelDetail="Filter tasks by workflow status"
              panelTitle="Status"
              rows={statusFilterRows}
              triggerIcon={
                statusFilter === 'all' ? (
                  <ListFilterGlyph size={13} />
                ) : (
                  <StateGlyph state={statusFilter} />
                )
              }
              triggerBadge={
                statusFilter === 'all'
                  ? String(filteredIssues.length)
                  : String(filteredIssues.filter((i) => i.state === statusFilter).length)
              }
              triggerLabel={`Status: ${
                statusFilter === 'all' ? 'All statuses' : statusFilter
              }`}
              value={statusFilter}
              variant="toolbar"
              onSelect={(id) =>
                setStatusFilter(
                  COLUMNS.includes(id as TicketState) ? (id as TicketState) : 'all'
                )
              }
            />
          </div>
        ) : null}

        <div className="tickets-header__trailing">
          {/* Search Toggle / Field */}
          {isSearchOpen ? (
            <span className="tickets-search">
              <SearchGlyph size={13} strokeWidth={1.8} />
              <input
                ref={searchInputRef}
                aria-label="Search tasks"
                placeholder="Search tasks"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchQuery('');
                    setIsSearchOpen(false);
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                className="chrome-button"
                onClick={() => {
                  setSearchQuery('');
                  setIsSearchOpen(false);
                }}
                title="Close search"
                aria-label="Close search"
              >
                <CloseGlyph size={12} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="chrome-button"
              onClick={() => setIsSearchOpen(true)}
              title="Search tasks"
              aria-label="Search"
            >
              <SearchGlyph size={14} />
            </button>
          )}

          {/* More Menu (...) */}
          <button
            ref={menuButtonRef}
            type="button"
            className={`chrome-button${isMenuOpen ? ' chrome-button--selected' : ''}`}
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            onClick={() => setIsMenuOpen((v) => !v)}
            title="More"
            aria-label="More"
          >
            <MoreHorizontalGlyph size={14} />
          </button>

          {isMenuOpen &&
            typeof document !== 'undefined' &&
            createPortal(
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 59 }}
                  onClick={() => setIsMenuOpen(false)}
                />
                <div
                  role="menu"
                  aria-label="More"
                  className="ui-menu scroll-quiet"
                  style={(() => {
                    const rect = menuButtonRef.current?.getBoundingClientRect();
                    return {
                      left: rect ? `${Math.max(8, rect.right - 200)}px` : '0px',
                      top: rect ? `${rect.bottom + 4}px` : '0px',
                      '--menu-origin': 'top right',
                    } as React.CSSProperties;
                  })()}
                >
                  {/* Section 1: View & Archive */}
                  <div
                    role="menuitem"
                    tabIndex={-1}
                    className="ui-menu__row"
                    onClick={() => {
                      handleViewChange(activeView === 'board' ? 'list' : 'board');
                      setIsMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      {activeView === 'board' ? (
                        <ListGlyph size={14} />
                      ) : (
                        <KanbanGlyph size={14} />
                      )}
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">
                        {activeView === 'board' ? 'View as list' : 'View as board'}
                      </span>
                    </span>
                  </div>

                  <div
                    role="menuitem"
                    tabIndex={-1}
                    className="ui-menu__row"
                    onClick={() => {
                      setShowArchived((v) => !v);
                      setIsMenuOpen(false);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <ArchiveGlyph size={14} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">
                        {showArchived ? 'Hide archived' : 'Show archived'}
                      </span>
                    </span>
                  </div>

                  <div aria-hidden="true" className="ui-menu__rule" />

                  {/* Section 2: Metadata & Connect MCP */}
                  <div
                    role="menuitem"
                    tabIndex={-1}
                    className="ui-menu__row"
                    onClick={() => {
                      setIsMenuOpen(false);
                      setActiveSheet('metadata');
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <TagGlyph size={14} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Labels & projects…</span>
                    </span>
                  </div>

                  <div
                    role="menuitem"
                    tabIndex={-1}
                    className="ui-menu__row"
                    onClick={() => {
                      setIsMenuOpen(false);
                      setActiveSheet('mcp');
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <PlugGlyph size={14} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Connect MCP…</span>
                    </span>
                  </div>

                  <div aria-hidden="true" className="ui-menu__rule" />

                  {/* Section 3: Restore backup */}
                  <div
                    role="menuitem"
                    tabIndex={-1}
                    className="ui-menu__row"
                    onClick={() => {
                      setIsMenuOpen(false);
                      setConfirmRestoreBackup(true);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <RotateCcwClockGlyph size={14} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Restore backup…</span>
                    </span>
                  </div>
                </div>
              </>,
              document.querySelector('.app-frame--scaled') ?? document.body
            )}

          {/* New Task Button */}
          <button
            type="button"
            className="primary-button action-button--row tickets-new"
            onClick={() => {
              setNewIssueState(
                activeView === 'list' && statusFilter !== 'all' ? statusFilter : 'To Do'
              );
              setActiveSheet('composer');
            }}
          >
            <span className="action-button__icon">
              <PlusGlyph size={14} />
            </span>
            <span>New task</span>
          </button>
        </div>
      </header>

      {/* Notices */}
      {noticeMessage ? (
        <p className="tickets-notice" role="status">
          {noticeMessage}
        </p>
      ) : null}

      {confirmRestoreBackup ? (
        <div className="tickets-notice tickets-notice--confirm">
          <span>
            Restore the previous saved version? The current file is preserved. Newer edits will leave the active workspace and MCP connections will be revoked.
          </span>
          <button
            type="button"
            className="secondary-button action-button--row"
            onClick={() => setConfirmRestoreBackup(false)}
          >
            Cancel restore
          </button>
          <button
            type="button"
            className="primary-button action-button--row"
            disabled={busy}
            onClick={() => void handleRecoverBackup()}
          >
            Restore previous version
          </button>
        </div>
      ) : null}

      {/* Main Body */}
      <div
        className={`tickets-body${
          activeView === 'board' && !currentSelectedIssue ? ' tickets-body--board' : ''
        }`}
      >
        {currentSelectedIssue ? (
          <TicketDetailView
            issue={currentSelectedIssue}
            snapshot={mergedSnapshot}
            run={
              runsMap.get(currentSelectedIssue.id) ||
              runsMap.get(currentSelectedIssue.uuid) ||
              null
            }
            busy={busy}
            onBack={() => setSelectedIssueId(null)}
            onSave={handleSaveDetail}
            onArchive={handleArchiveIssue}
            onRestore={handleRestoreIssue}
            onDispatch={(iss) => setDispatchIssue(iss)}
          />
        ) : activeView === 'board' ? (
          <div
            className="ticket-board"
            data-dragging={draggedIssueId ? 'true' : undefined}
          >
            {/* Status Filter Strip */}
            <div className="ticket-board__strip">
              {COLUMNS.map((col) => {
                const count = filteredIssues.filter((i) => i.state === col).length;
                const isArmed = dragTargetStatus === col;

                return (
                  <button
                    key={col}
                    type="button"
                    className="ticket-board__chip"
                    data-board-status={col}
                    data-armed={isArmed ? 'true' : undefined}
                    onClick={() => scrollToColumn(col)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragTargetStatus(col);
                    }}
                    onDragLeave={() => {
                      if (dragTargetStatus === col) setDragTargetStatus(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/plain') || draggedIssueId;
                      if (id) {
                        handleMoveIssue(id, col);
                      }
                      setDragTargetStatus(null);
                      setDraggedIssueId(null);
                    }}
                    title={`Show ${col}`}
                    aria-label={`${col}, ${count}`}
                  >
                    <StateGlyph state={col} size={13} />
                    <span className="ticket-board__chip-name">{col}</span>
                    <span className="ticket-board__chip-count">{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Hint message when empty */}
            {totalCount === 0 && (
              <p className="ticket-board__hint">
                {searchQuery.trim().length > 0
                  ? 'No matching tasks. Clear search to see every task.'
                  : 'Create a task here or ask Kite by voice.'}
              </p>
            )}

            {/* Scroller Columns */}
            <div className="ticket-board__scroller" ref={scrollerRef}>
              {COLUMNS.map((col) => {
                const colIssues = filteredIssues.filter((i) => i.state === col);
                const isArmed = dragTargetStatus === col;

                return (
                  <section
                    key={col}
                    aria-label={col}
                    className="ticket-board__column"
                    data-board-status={col}
                    data-armed={isArmed ? 'true' : undefined}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragTargetStatus(col);
                    }}
                    onDragLeave={() => {
                      if (dragTargetStatus === col) setDragTargetStatus(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/plain') || draggedIssueId;
                      if (id) {
                        handleMoveIssue(id, col);
                      }
                      setDragTargetStatus(null);
                      setDraggedIssueId(null);
                    }}
                  >
                    <header className="ticket-board__column-header">
                      <StateGlyph state={col} size={13} />
                      <span className="ticket-board__column-name">{col}</span>
                      <span className="ticket-board__column-count">{colIssues.length}</span>
                      <button
                        type="button"
                        className="chrome-button ticket-board__add"
                        onClick={() => {
                          setNewIssueState(col);
                          setActiveSheet('composer');
                        }}
                        title={`New task in ${col}`}
                        aria-label={`New task in ${col}`}
                      >
                        <PlusGlyph size={13} />
                      </button>
                    </header>

                    {colIssues.length > 0 ? (
                      <ul className="ticket-board__cards">
                        {colIssues.map((issue) => (
                          <li key={issue.id}>
                            <TicketCard
                              issue={issue}
                              run={
                                runsMap.get(issue.id) || runsMap.get(issue.uuid) || null
                              }
                              onSelect={() => setSelectedIssueId(issue.id)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setContextMenu({
                                  issue,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                              onDragStart={() => setDraggedIssueId(issue.id)}
                              carried={draggedIssueId === issue.id}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="ticket-board__empty">
                        {isArmed ? 'Drop here' : 'No tasks'}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        ) : (
          /* List View */
          <div className="ticket-list">
            {filteredIssues.filter((i) =>
              statusFilter === 'all' ? true : i.state === statusFilter
            ).length === 0 ? (
              <p
                className="ticket-board__hint"
                style={{ padding: '24px 16px', textAlign: 'center' }}
              >
                {searchQuery.trim().length > 0
                  ? 'No matching tasks. Clear search or choose another status.'
                  : statusFilter === 'all'
                    ? 'Create a task here or ask Kite by voice.'
                    : `No ${statusFilter} tasks. Choose another status or create a task.`}
              </p>
            ) : (
              COLUMNS.filter((col) =>
                statusFilter === 'all' ? true : col === statusFilter
              ).map((col) => {
                const colIssues = filteredIssues.filter((i) => i.state === col);
                if (colIssues.length === 0) return null;
                const isExpanded = !collapsedGroups.has(col);

                return (
                  <section key={col} aria-label={col} className="ticket-group">
                    <header className="ticket-group__header">
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        className="ticket-group__toggle"
                        onClick={() => toggleGroupCollapse(col)}
                      >
                        <span aria-hidden="true" className="ticket-group__chevron">
                          {isExpanded ? (
                            <ChevronDownMini size={10} />
                          ) : (
                            <ChevronRightGlyph size={10} strokeWidth={2.5} />
                          )}
                        </span>
                        <StateGlyph state={col} size={13} />
                        <span className="ticket-group__name">{col}</span>
                        <span className="ticket-group__count">{colIssues.length}</span>
                      </button>
                      <button
                        type="button"
                        className="chrome-button ticket-group__add"
                        onClick={() => {
                          setNewIssueState(col);
                          setActiveSheet('composer');
                        }}
                        title={`New task in ${col}`}
                        aria-label={`New task in ${col}`}
                      >
                        <PlusGlyph size={13} />
                      </button>
                    </header>

                    {isExpanded ? (
                      <ul className="ticket-group__rows">
                        {colIssues.map((issue) => {
                          const proj = projects.find((p) => p.id === issue.projectId);
                          return (
                            <li key={issue.id}>
                              <button
                                type="button"
                                className={`ticket-row${
                                  issue.archivedAt || issue.state === 'Done'
                                    ? ' ticket-row--archived'
                                    : ''
                                }`}
                                onClick={() => setSelectedIssueId(issue.id)}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setContextMenu({
                                    issue,
                                    x: e.clientX,
                                    y: e.clientY,
                                  });
                                }}
                              >
                                <PriorityGlyph priority={issue.priority} />
                                <span className="ticket-row__id">{issue.id}</span>
                                <StateGlyph state={issue.state} />
                                <span className="ticket-row__title">{issue.title}</span>
                                <span className="ticket-row__spacer" />
                                <span className="ticket-row__tags">
                                  {(issue.labels ?? []).slice(0, 3).map((lbl) => (
                                    <span key={lbl} className="ticket-pill" title={lbl}>
                                      <span
                                        aria-hidden="true"
                                        className="ticket-pill__dot"
                                        style={{ background: getLabelColor(lbl) }}
                                      />
                                      <span className="ticket-pill__name">{lbl}</span>
                                    </span>
                                  ))}
                                  {(issue.labels ?? []).length > 3 ? (
                                    <span className="ticket-pill ticket-pill--more">
                                      +{(issue.labels ?? []).length - 3}
                                    </span>
                                  ) : null}
                                  {proj ? (
                                    <span
                                      className="ticket-pill ticket-pill--project"
                                      title={`Project · ${proj.name}`}
                                    >
                                      <span className="ticket-pill__name">{proj.name}</span>
                                    </span>
                                  ) : null}
                                </span>
                                <span className="ticket-row__people">
                                  {issue.delegate ? (
                                    <TicketAvatar
                                      name={issue.delegate}
                                      kind="Delegate"
                                      size={18}
                                    />
                                  ) : null}
                                  <TicketAvatar
                                    name={issue.assignee}
                                    kind="Assignee"
                                    size={24}
                                  />
                                </span>
                                {issue.dueDate && (
                                  <time className="ticket-row__date">{issue.dueDate}</time>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </section>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Task Card Context Menu */}
      {contextMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 59 }}
              onClick={() => setContextMenu(null)}
            />
            <div
              role="menu"
              aria-label="Task actions"
              className="ui-menu scroll-quiet"
              style={{
                left: `${Math.min(contextMenu.x, window.innerWidth - 220)}px`,
                top: `${Math.min(contextMenu.y, window.innerHeight - 280)}px`,
                '--menu-origin': 'top left',
              } as React.CSSProperties}
            >
              <div
                role="menuitem"
                tabIndex={-1}
                className="ui-menu__row"
                onClick={() => {
                  const id = contextMenu.issue.id;
                  setContextMenu(null);
                  setSelectedIssueId(id);
                }}
              >
                <span aria-hidden="true" className="ui-menu__icon">
                  <ExternalOpenGlyph size={13} />
                </span>
                <span className="ui-menu__label">
                  <span className="ui-menu__row-title">Open</span>
                </span>
              </div>

              <div aria-hidden="true" className="ui-menu__rule" />

              <div
                role="menuitem"
                tabIndex={-1}
                className="ui-menu__row"
                onClick={() => {
                  const iss = contextMenu.issue;
                  setContextMenu(null);
                  window.dispatchEvent(
                    new CustomEvent('kite:navigate-mode', { detail: 'chat' })
                  );
                  window.dispatchEvent(
                    new CustomEvent('kite:open-task-in-chat', {
                      detail: {
                        taskId: iss.id,
                        title: iss.title,
                        description: iss.description || '',
                      },
                    })
                  );
                }}
              >
                <span aria-hidden="true" className="ui-menu__icon">
                  <SendGlyph size={13} />
                </span>
                <span className="ui-menu__label">
                  <span className="ui-menu__row-title">Send to Thread composer</span>
                </span>
              </div>

              <div
                role="menuitem"
                tabIndex={-1}
                className="ui-menu__row"
                onClick={() => {
                  const iss = contextMenu.issue;
                  setContextMenu(null);
                  setDispatchIssue(iss);
                }}
              >
                <span aria-hidden="true" className="ui-menu__icon">
                  <BotGlyph size={13} />
                </span>
                <span className="ui-menu__label">
                  <span className="ui-menu__row-title">Dispatch to agent…</span>
                </span>
              </div>

              <div aria-hidden="true" className="ui-menu__rule" />

              <div className="ui-menu__heading" role="presentation">
                Move to
              </div>
              {COLUMNS.map((col) => {
                const disabled = contextMenu.issue.state === col;
                return (
                  <div
                    key={col}
                    role="menuitem"
                    tabIndex={-1}
                    aria-disabled={disabled ? true : undefined}
                    className="ui-menu__row"
                    onClick={() => {
                      if (disabled) return;
                      const id = contextMenu.issue.id;
                      setContextMenu(null);
                      handleMoveIssue(id, col);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <StateGlyph state={col} size={13} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">{col}</span>
                    </span>
                  </div>
                );
              })}

              {!contextMenu.issue.archivedAt ? (
                <>
                  <div aria-hidden="true" className="ui-menu__rule" />
                  <div
                    role="menuitem"
                    tabIndex={-1}
                    className="ui-menu__row"
                    onClick={() => {
                      const iss = contextMenu.issue;
                      setContextMenu(null);
                      handleArchiveIssue(iss);
                    }}
                  >
                    <span aria-hidden="true" className="ui-menu__icon">
                      <ArchiveGlyph size={13} />
                    </span>
                    <span className="ui-menu__label">
                      <span className="ui-menu__row-title">Archive task</span>
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          </>,
          document.querySelector('.app-frame--scaled') ?? document.body
        )}

      {/* Sheets & Modals */}
      {activeSheet === 'composer' && (
        <CreateTicketModal
          initialState={newIssueState}
          snapshot={mergedSnapshot}
          onClose={() => setActiveSheet(null)}
          onCreate={handleCreateIssue}
        />
      )}

      {activeSheet === 'metadata' && (
        <LabelsProjectsModal
          labels={labels}
          projects={projects}
          busy={busy}
          onAddLabel={handleAddLabel}
          onAddProject={handleAddProject}
          onClose={() => setActiveSheet(null)}
        />
      )}

      {activeSheet === 'mcp' && (
        <ConnectMcpModal
          snapshot={mergedSnapshot}
          connections={connections}
          busy={busy}
          onConnect={handleMcpConnect}
          onGetConfiguration={handleMcpConfiguration}
          onRevoke={handleMcpRevoke}
          onClose={() => setActiveSheet(null)}
        />
      )}

      {dispatchIssue && (
        <DispatchTaskModal
          issue={dispatchIssue}
          agents={agents}
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onClose={() => setDispatchIssue(null)}
          onDispatched={(taskId, agentName) => {
            setDispatchIssue(null);
            setNoticeMessage(`Dispatched ${taskId} to ${agentName}.`);
            setSelectedIssueId(taskId);
            void fetchSnapshots();
          }}
        />
      )}
    </section>
  );
};
