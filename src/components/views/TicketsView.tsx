import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
} from './tickets/types';
import { TicketDetailView } from './tickets/TicketDetailView';
import { CreateTicketModal } from './tickets/CreateTicketModal';
import { ConnectMcpModal } from './tickets/ConnectMcpModal';
import { LabelsProjectsModal } from './tickets/LabelsProjectsModal';
import { DispatchTaskModal } from './tickets/DispatchTaskModal';
import { TicketsHeaderBar } from './tickets/TicketsHeaderBar';
import { TicketsBoardView } from './tickets/TicketsBoardView';
import { TicketsListView } from './tickets/TicketsListView';
import { TicketContextMenu, TicketContextMenuState } from './tickets/TicketContextMenu';
import {
  readStoredView,
  persistStoredView,
  readStoredIssues,
  persistIssuesWithBackup,
  readStoredBackup,
  readStoredLabels,
  persistLabels,
  readStoredProjects,
  persistProjects,
  readStoredConnections,
  persistConnections,
  PRIMARY_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  LEGACY_STORAGE_KEY_V1,
  BACKUP_STORAGE_KEY,
  LABELS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  CONNECTIONS_STORAGE_KEY,
  VIEW_STORAGE_KEY,
} from './tickets/ticketStorage';
import type { AgentProfile, Workspace } from '../../types';

export type { TicketIssue, TicketState, TicketPriority, TaskExecutionRun };
export {
  PRIMARY_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  LEGACY_STORAGE_KEY_V1,
  BACKUP_STORAGE_KEY,
  LABELS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  CONNECTIONS_STORAGE_KEY,
  VIEW_STORAGE_KEY,
  readStoredView,
};

export interface TicketsViewProps {
  workspaces?: Workspace[];
  selectedWorkspaceId?: string | null;
}

export const TicketsView: React.FC<TicketsViewProps> = ({
  workspaces = [],
  selectedWorkspaceId = null,
}) => {
  // State for issues: loaded from local storage cache, synchronized with ticket_snapshot
  const [issues, setIssues] = useState<TicketIssue[]>(() => readStoredIssues());
  const [labels, setLabels] = useState<TicketLabel[]>(() => readStoredLabels());
  const [projects, setProjects] = useState<TicketProject[]>(() => readStoredProjects());
  const [connections, setConnections] = useState<TicketConnection[]>(() => readStoredConnections());

  const [snapshot, setSnapshot] = useState<TicketSnapshot | null>(null);
  const [taskRuns, setTaskRuns] = useState<TaskExecutionRun[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [activeView, setActiveView] = useState<'board' | 'list'>(() => readStoredView());
  const [statusFilter, setStatusFilter] = useState<'all' | TicketState>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<'composer' | 'metadata' | 'mcp' | null>(null);
  const [dispatchIssue, setDispatchIssue] = useState<TicketIssue | null>(null);
  const [confirmRestoreBackup, setConfirmRestoreBackup] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newIssueState, setNewIssueState] = useState<TicketState>('To Do');
  const [contextMenu, setContextMenu] = useState<TicketContextMenuState | null>(null);

  // Clear notice after 6s
  useEffect(() => {
    if (!noticeMessage) return;
    const timer = window.setTimeout(() => setNoticeMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [noticeMessage]);

  // Persist view mode
  const handleViewChange = (mode: 'board' | 'list') => {
    setActiveView(mode);
    persistStoredView(mode);
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
    persistIssuesWithBackup(issues);
  }, [issues]);

  useEffect(() => {
    persistLabels(labels);
  }, [labels]);

  useEffect(() => {
    persistProjects(projects);
  }, [projects]);

  useEffect(() => {
    persistConnections(connections);
  }, [connections]);

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
      const restored = readStoredBackup();
      if (restored) {
        setIssues(restored);
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

  return (
    <section aria-label="Tasks" className="pane tickets-pane">
      {/* Header */}
      <TicketsHeaderBar
        activeView={activeView}
        hasSelectedIssue={Boolean(currentSelectedIssue)}
        statusFilter={statusFilter}
        filteredIssues={filteredIssues}
        onSelectStatusFilter={setStatusFilter}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        showArchived={showArchived}
        onToggleShowArchived={() => setShowArchived((v) => !v)}
        onViewChange={handleViewChange}
        onOpenMetadata={() => setActiveSheet('metadata')}
        onOpenMcp={() => setActiveSheet('mcp')}
        onRestoreBackup={() => setConfirmRestoreBackup(true)}
        onNewTask={() => {
          setNewIssueState(
            activeView === 'list' && statusFilter !== 'all' ? statusFilter : 'To Do'
          );
          setActiveSheet('composer');
        }}
      />

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
          <TicketsBoardView
            filteredIssues={filteredIssues}
            runsMap={runsMap}
            searchQuery={searchQuery}
            onSelectIssue={(id) => setSelectedIssueId(id)}
            onMoveIssue={handleMoveIssue}
            onNewTaskInColumn={(col) => {
              setNewIssueState(col);
              setActiveSheet('composer');
            }}
            onContextMenu={(e, issue) => {
              e.preventDefault();
              setContextMenu({
                issue,
                x: e.clientX,
                y: e.clientY,
              });
            }}
          />
        ) : (
          <TicketsListView
            filteredIssues={filteredIssues}
            projects={projects}
            statusFilter={statusFilter}
            searchQuery={searchQuery}
            onSelectIssue={(id) => setSelectedIssueId(id)}
            onNewTaskInColumn={(col) => {
              setNewIssueState(col);
              setActiveSheet('composer');
            }}
            onContextMenu={(e, issue) => {
              e.preventDefault();
              setContextMenu({
                issue,
                x: e.clientX,
                y: e.clientY,
              });
            }}
          />
        )}
      </div>

      {/* Task Card Context Menu */}
      <TicketContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onSelectIssue={(id) => setSelectedIssueId(id)}
        onDispatch={(iss) => setDispatchIssue(iss)}
        onMoveIssue={handleMoveIssue}
        onArchiveIssue={handleArchiveIssue}
      />

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
