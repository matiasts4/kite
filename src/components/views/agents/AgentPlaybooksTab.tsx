import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentProfile } from '../../../types';
import { SelectMenu } from '../../ui/SelectMenu';
import type { PlaybookDefinition, PlaybookRunRecord, PlaybookStage } from './types';

export interface AgentPlaybooksTabProps {
  agentId: string;
  agents: AgentProfile[];
  workspaceId?: string | null;
  onOpenThread?: (threadId: string) => void;
}

function formatElapsed(start?: number | null, end?: number | null): string {
  if (!start) return '—';
  const finish = end || Date.now();
  const secs = Math.max(0, Math.round((finish - start) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function makeDefaultStages(agentId: string, agents: AgentProfile[]): PlaybookStage[] {
  return [
    {
      stageId: 'explore',
      title: 'Explore & Map',
      agentProfileId: agentId,
      promptTemplate: 'Map affected files and architectural constraints.',
      dependsOn: [],
      workspaceMode: 'inherit',
      handoffKeys: ['explore-map'],
    },
    {
      stageId: 'implement',
      title: 'Implement & Test',
      agentProfileId: agents[1]?.id || agentId,
      promptTemplate: 'Implement the fix using upstream SharedContext findings.',
      dependsOn: ['explore'],
      workspaceMode: 'share',
      handoffKeys: ['patch-summary'],
    },
  ];
}

export const AgentPlaybooksTab: React.FC<AgentPlaybooksTabProps> = ({
  agentId,
  agents,
  workspaceId = null,
  onOpenThread,
}) => {
  const [playbooks, setPlaybooks] = useState<PlaybookDefinition[]>([]);
  const [runs, setRuns] = useState<PlaybookRunRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runInputPrompt, setRunInputPrompt] = useState('');

  // Draft / Edit Playbook editor state
  const [editingPlaybookId, setEditingPlaybookId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [stages, setStages] = useState<PlaybookStage[]>(() => makeDefaultStages(agentId, agents));

  const loadData = useCallback(async () => {
    try {
      const [pbRes, runsRes] = await Promise.all([
        invoke<{ playbooks?: PlaybookDefinition[] }>('list_agent_playbooks'),
        invoke<{ runs?: PlaybookRunRecord[] }>('list_playbook_runs', { request: {} }),
      ]);
      if (pbRes?.playbooks) {
        setPlaybooks(pbRes.playbooks);
      }
      if (runsRes?.runs) {
        setRuns(runsRes.runs);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg) setError(msg);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const hasRunningRun = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!hasRunningRun) return;
    const timer = setInterval(() => {
      void loadData();
    }, 2500);
    return () => clearInterval(timer);
  }, [hasRunningRun, loadData]);

  useEffect(() => {
    let disposed = false;
    let unlistenFn: (() => void) | null = null;
    try {
      void listen<PlaybookRunRecord>('kite:playbook-run-updated', (event) => {
        if (disposed || !event?.payload) return;
        const updated = event.payload;
        setRuns((prev) => {
          const idx = prev.findIndex((r) => r.runId === updated.runId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = updated;
            return copy;
          }
          return [updated, ...prev];
        });
      })
        .then((fn) => {
          if (disposed) {
            fn();
          } else {
            unlistenFn = fn;
          }
        })
        .catch((err) => {
          console.warn('[AgentPlaybooksTab] Failed to subscribe to playbook updates:', err);
        });
    } catch {
      // Non-Tauri test environment
    }
    return () => {
      disposed = true;
      unlistenFn?.();
    };
  }, []);

  const resetDraft = useCallback(() => {
    setEditingPlaybookId(null);
    setDraftName('');
    setDraftDescription('');
    setStages(makeDefaultStages(agentId, agents));
  }, [agentId, agents]);

  const handleAddStage = () => {
    const idx = stages.length + 1;
    const prevId = stages[stages.length - 1]?.stageId;
    setStages((prev) => [
      ...prev,
      {
        stageId: `stage-${idx}`,
        title: `Stage ${idx}`,
        agentProfileId: agentId,
        promptTemplate: 'Verify and review stage outputs.',
        dependsOn: prevId ? [prevId] : [],
        workspaceMode: 'inherit',
        handoffKeys: [],
      },
    ]);
  };

  const handleRemoveStage = (idx: number) => {
    if (stages.length <= 1) return;
    const removedId = stages[idx]?.stageId;
    setStages((prev) =>
      prev
        .filter((_, i) => i !== idx)
        .map((st) => ({
          ...st,
          dependsOn: st.dependsOn.filter((dep) => dep !== removedId),
        }))
    );
  };

  const handleMoveStage = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= stages.length) return;
    setStages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const handleEditPlaybook = (pb: PlaybookDefinition) => {
    setEditingPlaybookId(pb.id);
    setDraftName(pb.name);
    setDraftDescription(pb.description || '');
    setStages(
      pb.stages.length > 0
        ? pb.stages.map((st) => ({
            ...st,
            dependsOn: [...(st.dependsOn ?? [])],
            handoffKeys: [...(st.handoffKeys ?? [])],
          }))
        : makeDefaultStages(agentId, agents)
    );
    setError(null);
  };

  const handleDeletePlaybook = async (playbookId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ deleted?: boolean; playbooks?: PlaybookDefinition[] }>(
        'delete_agent_playbook',
        { request: { playbookId } }
      );
      if (res?.playbooks) {
        setPlaybooks(res.playbooks);
      } else {
        setPlaybooks((prev) => prev.filter((p) => p.id !== playbookId));
      }
      if (editingPlaybookId === playbookId) {
        resetDraft();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to delete playbook');
    } finally {
      setBusy(false);
    }
  };

  const handleSavePlaybook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftName.trim() || stages.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const existing = editingPlaybookId
        ? playbooks.find((p) => p.id === editingPlaybookId)
        : undefined;
      const res = await invoke<{ playbooks?: PlaybookDefinition[] }>('save_agent_playbook', {
        request: {
          playbook: {
            id: editingPlaybookId ?? '',
            name: draftName.trim(),
            description: draftDescription.trim(),
            stages,
            createdAtUnixMs: existing?.createdAtUnixMs ?? 0,
            updatedAtUnixMs: 0,
          },
        },
      });
      if (res?.playbooks) setPlaybooks(res.playbooks);
      resetDraft();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to save playbook');
    } finally {
      setBusy(false);
    }
  };

  const handleRunPlaybook = async (playbookId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ run?: PlaybookRunRecord }>('run_agent_playbook', {
        request: {
          playbookId,
          workspaceId,
          prompt: runInputPrompt.trim(),
        },
      });
      if (res?.run) {
        const created = res.run;
        setRuns((prev) => [created, ...prev.filter((r) => r.runId !== created.runId)]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to run playbook');
    } finally {
      setBusy(false);
    }
  };

  const handleRetryStage = async (runId: string, stageId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ run?: PlaybookRunRecord }>('retry_playbook_stage', {
        request: { runId, stageId, prompt: runInputPrompt.trim() },
      });
      if (res?.run) {
        const updated = res.run;
        setRuns((prev) => prev.map((r) => (r.runId === updated.runId ? updated : r)));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to retry playbook stage');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-face agent-playbooks">
      <div className="agent-mind-column">
        <p className="agent-mind-lede">
          Coordinate multi-provider specialists across ordered DAG stages and transfer structured artifacts via <code>SharedContextStore</code>.
        </p>

        {error ? (
          <p className="agent-feedback agent-feedback--error" role="alert">
            {error}
          </p>
        ) : null}

        <form className="ui-card agent-playbooks__form" onSubmit={(e) => void handleSavePlaybook(e)}>
          <div className="agent-knowledge__form-grid">
            <label className="agent-knowledge__field">
              <span className="ui-eyebrow">Playbook name</span>
              <input
                type="text"
                className="ui-field"
                placeholder="ODD Multi-Provider Pipeline"
                value={draftName}
                onChange={(e) => setDraftName(e.currentTarget.value)}
              />
            </label>
            <label className="agent-knowledge__field">
              <span className="ui-eyebrow">Description</span>
              <input
                type="text"
                className="ui-field"
                placeholder="Explore -> Architect -> Implement -> Review"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.currentTarget.value)}
              />
            </label>
          </div>

          <div className="agent-playbooks__stages-draft">
            {stages.map((st, idx) => {
              const selectedAgent = agents.find((ag) => ag.id === st.agentProfileId);
              return (
                <div key={`stage-editor-${idx}`} className="agent-playbooks__stage-card">
                  <div className="agent-playbooks__stage-row">
                    <input
                      type="text"
                      className="ui-field"
                      aria-label={`Stage ${idx + 1} title`}
                      value={st.title}
                      onChange={(e) => {
                        const val = e.currentTarget.value;
                        setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, title: val } : s)));
                      }}
                    />
                    <SelectMenu
                      variant="field"
                      label={`Stage ${idx + 1} agent`}
                      value={st.agentProfileId}
                      triggerLabel={
                        selectedAgent ? `${selectedAgent.name} (${selectedAgent.engine})` : st.agentProfileId
                      }
                      rows={agents.map((ag) => ({
                        id: ag.id,
                        title: `${ag.name} (${ag.engine})`,
                      }))}
                      onSelect={(val) => {
                        setStages((prev) =>
                          prev.map((s, i) => (i === idx ? { ...s, agentProfileId: val } : s))
                        );
                      }}
                    />
                    <SelectMenu
                      variant="field"
                      label={`Stage ${idx + 1} workspace mode`}
                      value={st.workspaceMode}
                      triggerLabel={st.workspaceMode}
                      rows={[
                        { id: 'inherit', title: 'inherit', detail: 'Share active workspace directly' },
                        { id: 'share', title: 'share', detail: 'Provision isolated git worktree' },
                        { id: 'branch', title: 'branch', detail: 'Isolated branch worktree' },
                      ]}
                      onSelect={(val) => {
                        const mode = val as 'inherit' | 'share' | 'branch';
                        setStages((prev) =>
                          prev.map((s, i) => (i === idx ? { ...s, workspaceMode: mode } : s))
                        );
                      }}
                    />
                  </div>

                  <div className="agent-playbooks__stage-meta-grid">
                    <input
                      type="text"
                      className="ui-field"
                      aria-label={`Stage ${idx + 1} ID`}
                      placeholder="Stage ID (e.g. explore)"
                      value={st.stageId}
                      onChange={(e) => {
                        const val = e.currentTarget.value;
                        setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, stageId: val } : s)));
                      }}
                    />
                    <input
                      type="text"
                      className="ui-field"
                      aria-label={`Stage ${idx + 1} depends on`}
                      placeholder="Depends on (comma-separated stage IDs)"
                      value={st.dependsOn.join(', ')}
                      onChange={(e) => {
                        const deps = e.currentTarget.value
                          .split(',')
                          .map((d) => d.trim())
                          .filter(Boolean);
                        setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, dependsOn: deps } : s)));
                      }}
                    />
                    <input
                      type="text"
                      className="ui-field"
                      aria-label={`Stage ${idx + 1} handoff keys`}
                      placeholder="Handoff keys (comma-separated)"
                      value={st.handoffKeys.join(', ')}
                      onChange={(e) => {
                        const keys = e.currentTarget.value
                          .split(',')
                          .map((k) => k.trim())
                          .filter(Boolean);
                        setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, handoffKeys: keys } : s)));
                      }}
                    />
                  </div>

                  <textarea
                    rows={2}
                    className="ui-field ui-field--area"
                    aria-label={`Stage ${idx + 1} prompt template`}
                    placeholder="Stage prompt template..."
                    value={st.promptTemplate}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      setStages((prev) =>
                        prev.map((s, i) => (i === idx ? { ...s, promptTemplate: val } : s))
                      );
                    }}
                  />

                  <div className="agent-playbooks__stage-controls">
                    <button
                      type="button"
                      className="chrome-button"
                      aria-label={`Move stage ${idx + 1} up`}
                      disabled={idx === 0}
                      onClick={() => handleMoveStage(idx, -1)}
                    >
                      Move up
                    </button>
                    <button
                      type="button"
                      className="chrome-button"
                      aria-label={`Move stage ${idx + 1} down`}
                      disabled={idx === stages.length - 1}
                      onClick={() => handleMoveStage(idx, 1)}
                    >
                      Move down
                    </button>
                    <button
                      type="button"
                      className="chrome-button"
                      aria-label={`Remove stage ${idx + 1}`}
                      disabled={stages.length <= 1}
                      onClick={() => handleRemoveStage(idx)}
                    >
                      Remove stage
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="agent-knowledge__actions">
            <button type="button" className="chrome-button" onClick={handleAddStage}>
              + Add Stage
            </button>
            <button type="submit" className="primary-button" disabled={busy || !draftName.trim()}>
              {editingPlaybookId ? 'Update Playbook' : 'Save Playbook'}
            </button>
            {editingPlaybookId ? (
              <button type="button" className="secondary-button" disabled={busy} onClick={resetDraft}>
                Cancel edit
              </button>
            ) : null}
          </div>
        </form>

        <div className="agent-playbooks__list">
          <div className="agent-knowledge__search-row">
            <input
              type="text"
              className="ui-field"
              aria-label="Playbook run prompt"
              placeholder="Optional shared task prompt passed to Playbook stages..."
              value={runInputPrompt}
              onChange={(e) => setRunInputPrompt(e.currentTarget.value)}
            />
          </div>

          {playbooks.length === 0 ? (
            <div className="ui-card agent-knowledge__empty">
              No Playbooks created yet. Save a pipeline above to orchestrate specialist waves.
            </div>
          ) : (
            playbooks.map((pb) => (
              <div key={pb.id} className="ui-card agent-playbooks__card">
                <div className="agent-playbooks__card-header">
                  <div>
                    <strong>{pb.name}</strong>
                    <p className="agent-knowledge__meta">
                      {pb.description || 'Multi-stage pipeline'} · {pb.stages.length} stage(s)
                    </p>
                  </div>
                  <div className="agent-playbooks__card-actions">
                    <button
                      type="button"
                      className="chrome-button"
                      disabled={busy}
                      aria-label={`Edit playbook ${pb.name}`}
                      onClick={() => handleEditPlaybook(pb)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="chrome-button"
                      disabled={busy}
                      aria-label={`Delete playbook ${pb.name}`}
                      onClick={() => void handleDeletePlaybook(pb.id)}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void handleRunPlaybook(pb.id)}
                    >
                      Run Playbook
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {runs.length > 0 ? (
          <div className="agent-playbooks__runs">
            <h3 className="ui-eyebrow">Live Stage Progress & SharedContext Handoffs</h3>
            {runs.slice(0, 5).map((run) => (
              <div key={run.runId} className="ui-card agent-playbooks__run-card">
                <div className="agent-playbooks__run-header">
                  <strong>{run.playbookName}</strong>
                  <span className="agent-memory__badge">{run.status}</span>
                </div>
                <div className="agent-playbooks__graph">
                  {run.stages.map((st) => (
                    <div key={st.stageId} className="agent-playbooks__node">
                      <div className="agent-playbooks__node-top">
                        <strong>{st.title}</strong>
                        <span className="agent-memory__badge">{st.status}</span>
                      </div>
                      <span className="agent-knowledge__meta">
                        {st.provider}{st.model ? ` · ${st.model}` : ''} · {formatElapsed(st.startedAtUnixMs, st.finishedAtUnixMs)}
                      </span>
                      <span className="agent-knowledge__meta">
                        Handoffs: {st.handoffKeys.join(', ') || 'none'}
                      </span>
                      {st.error ? (
                        <span className="agent-feedback agent-feedback--error">{st.error}</span>
                      ) : null}
                      <div className="agent-playbooks__node-actions">
                        {st.threadId && onOpenThread ? (
                          <button
                            type="button"
                            className="chrome-button"
                            onClick={() => onOpenThread(st.threadId!)}
                          >
                            Open thread
                          </button>
                        ) : null}
                        {st.status === 'failed' ? (
                          <button
                            type="button"
                            className="chrome-button"
                            disabled={busy}
                            onClick={() => void handleRetryStage(run.runId, st.stageId)}
                          >
                            Retry stage
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};
