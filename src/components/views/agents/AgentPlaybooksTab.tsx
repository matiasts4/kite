import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentProfile } from '../../../types';
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

  // Draft Playbook editor state
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [stages, setStages] = useState<PlaybookStage[]>([
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
  ]);

  const loadData = useCallback(async () => {
    try {
      const [pbRes, runsRes] = await Promise.all([
        invoke<{ playbooks?: PlaybookDefinition[] }>('list_agent_playbooks'),
        invoke<{ runs?: PlaybookRunRecord[] }>('list_playbook_runs', { request: {} }),
      ]);
      if (pbRes?.playbooks) {
        setPlaybooks((prev) => (prev.length > 0 ? prev : pbRes.playbooks!));
      }
      if (runsRes?.runs) {
        setRuns((prev) => (prev.length > 0 ? prev : runsRes.runs!));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg) setError(msg);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

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
        .catch(() => {});
    } catch {
      // Non-Tauri test environment
    }
    return () => {
      disposed = true;
      unlistenFn?.();
    };
  }, []);

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

  const handleSavePlaybook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftName.trim() || stages.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ playbooks?: PlaybookDefinition[] }>('save_agent_playbook', {
        request: {
          playbook: {
            id: '',
            name: draftName.trim(),
            description: draftDescription.trim(),
            stages,
            createdAtUnixMs: 0,
            updatedAtUnixMs: 0,
          },
        },
      });
      if (res?.playbooks) setPlaybooks(res.playbooks);
      setDraftName('');
      setDraftDescription('');
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
            {stages.map((st, idx) => (
              <div key={st.stageId} className="agent-playbooks__stage-row">
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
                <select
                  aria-label={`Stage ${idx + 1} agent`}
                  className="ui-field"
                  value={st.agentProfileId}
                  onChange={(e) => {
                    const val = e.currentTarget.value;
                    setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, agentProfileId: val } : s)));
                  }}
                >
                  {agents.map((ag) => (
                    <option key={ag.id} value={ag.id}>
                      {ag.name} ({ag.engine})
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Stage ${idx + 1} workspace mode`}
                  className="ui-field"
                  value={st.workspaceMode}
                  onChange={(e) => {
                    const val = e.currentTarget.value as 'inherit' | 'share' | 'branch';
                    setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, workspaceMode: val } : s)));
                  }}
                >
                  <option value="inherit">inherit</option>
                  <option value="share">share</option>
                  <option value="branch">branch</option>
                </select>
              </div>
            ))}
          </div>

          <div className="agent-knowledge__actions">
            <button type="button" className="chrome-button" onClick={handleAddStage}>
              + Add Stage
            </button>
            <button type="submit" className="primary-button" disabled={busy || !draftName.trim()}>
              Save Playbook
            </button>
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
