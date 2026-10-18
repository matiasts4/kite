import React, { useState, useMemo } from 'react';
import { Sheet } from '../../ui/Sheet';
import { SelectMenu } from '../../ui/SelectMenu';
import { TicketIssue } from './types';
import { AgentProfile, Workspace } from '../../../types';
import { invokeCommand } from '../../../lib/ipc';

export interface DispatchTaskModalProps {
  issue: TicketIssue;
  agents: AgentProfile[];
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  onClose: () => void;
  onDispatched: (taskId: string, agentName: string) => void;
}

const SAME_AGENT_ID = 'same';

function supportsTaskExecution(engine?: string): boolean {
  return engine === 'claude-code' || engine === 'codex';
}

export const DispatchTaskModal: React.FC<DispatchTaskModalProps> = ({
  issue,
  agents,
  workspaces,
  selectedWorkspaceId,
  onClose,
  onDispatched,
}) => {
  const eligibleAgents = useMemo(
    () => agents.filter((a) => supportsTaskExecution(a.engine)),
    [agents]
  );

  const eligibleWorkspaces = useMemo(
    () => workspaces.filter((w) => !(w as any).ssh && w.available !== false),
    [workspaces]
  );

  const [agentId, setAgentId] = useState<string>(() => eligibleAgents[0]?.id ?? '');
  const [reviewerId, setReviewerId] = useState<string>(SAME_AGENT_ID);
  const [workspaceId, setWorkspaceId] = useState<string>(() => {
    const match = eligibleWorkspaces.find((w) => w.id === selectedWorkspaceId);
    return match?.id ?? eligibleWorkspaces[0]?.id ?? '';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAgent = eligibleAgents.find((a) => a.id === agentId) ?? null;
  const selectedReviewer =
    reviewerId === SAME_AGENT_ID
      ? null
      : eligibleAgents.find((a) => a.id === reviewerId) ?? null;
  const selectedWorkspace =
    eligibleWorkspaces.find((w) => w.id === workspaceId) ?? null;

  const agentRows = eligibleAgents.map((a) => ({
    id: a.id,
    title: a.name,
    engine: a.engine,
  }));

  const reviewerRows = [
    {
      id: SAME_AGENT_ID,
      title: selectedAgent ? `${selectedAgent.name} (same agent)` : 'Same agent',
    },
    ...eligibleAgents
      .filter((a) => a.id !== agentId)
      .map((a) => ({
        id: a.id,
        title: a.name,
        engine: a.engine,
      })),
  ];

  const workspaceRows = eligibleWorkspaces.map((w) => ({
    id: w.id,
    title: w.displayName,
  }));

  const blockerNote =
    eligibleAgents.length === 0
      ? 'Add a saved Agent that runs Claude Code or Codex in Agent mode first.'
      : eligibleWorkspaces.length === 0
        ? "Add a local folder first. SSH folders can't run dispatched tasks."
        : null;

  const handleDispatch = async () => {
    if (busy || blockerNote !== null || !selectedAgent || !selectedWorkspace) return;
    setBusy(true);
    setError(null);

    const selection = {
      workspaceId: selectedWorkspace.id,
      agentId: selectedAgent.id,
      ...(selectedReviewer ? { reviewerId: selectedReviewer.id } : {}),
    };

    try {
      await invokeCommand('task_validate_selection', selection);
      await invokeCommand('task_execute', {
        ...selection,
        taskId: issue.id,
        receipt: `gui-${crypto.randomUUID()}`,
        newProject: false,
      });
      onDispatched(issue.id, selectedAgent.name);
    } catch (err: any) {
      const msg =
        err?.message && typeof err.message === 'string' && err.message.length <= 500
          ? err.message
          : `${issue.id} couldn't be dispatched. Try again.`;
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={true}
      onCancel={() => {
        if (!busy) onClose();
      }}
      title={`Dispatch ${issue.id}`}
      description="The agent works in its own branch, then a second session reviews the work. Progress shows on the task."
      width={480}
      className="ticket-sheet"
      primary={{
        label: 'Dispatch',
        onClick: () => void handleDispatch(),
        disabled: blockerNote !== null || !selectedAgent || !selectedWorkspace,
        loading: busy,
      }}
      secondary={{
        label: 'Cancel',
        onClick: onClose,
        disabled: busy,
      }}
    >
      <div className="task-dispatch">
        <p className="task-dispatch__task" title={issue.title}>
          {issue.title || 'Untitled task'}
        </p>

        {blockerNote === null ? (
          <>
            <div className="task-dispatch__field">
              <span className="task-dispatch__label">Agent</span>
              <SelectMenu
                disabled={busy}
                label="Agent"
                panelTitle="Agent"
                rows={agentRows}
                searchable={agentRows.length > 8}
                triggerEngine={selectedAgent?.engine}
                triggerLabel={selectedAgent?.name}
                value={agentId}
                onSelect={(id) => {
                  setAgentId(id);
                  if (id === reviewerId) setReviewerId(SAME_AGENT_ID);
                }}
              />
            </div>

            <div className="task-dispatch__field">
              <span className="task-dispatch__label">Reviewer</span>
              <SelectMenu
                disabled={busy}
                label="Reviewer"
                panelTitle="Reviewer"
                rows={reviewerRows}
                triggerEngine={(selectedReviewer ?? selectedAgent)?.engine}
                triggerLabel={selectedReviewer?.name ?? reviewerRows[0]?.title}
                value={reviewerId}
                onSelect={setReviewerId}
              />
            </div>

            <div className="task-dispatch__field">
              <span className="task-dispatch__label">Folder</span>
              <SelectMenu
                disabled={busy}
                label="Folder"
                panelTitle="Folder"
                rows={workspaceRows}
                searchable={workspaceRows.length > 8}
                triggerLabel={selectedWorkspace?.displayName}
                value={workspaceId}
                onSelect={setWorkspaceId}
              />
            </div>

            <p className="task-dispatch__note">
              A Git folder gets a new branch and worktree, so your checkout isn't touched.
            </p>
          </>
        ) : (
          <p className="task-dispatch__note" role="status">
            {blockerNote}
          </p>
        )}

        {error !== null ? (
          <p className="task-dispatch__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
};
