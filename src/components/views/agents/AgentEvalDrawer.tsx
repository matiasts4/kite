import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DryRunEvalReport } from './types';

export interface AgentEvalDrawerProps {
  isOpen: boolean;
  agentId: string;
  agentName: string;
  onClose: () => void;
}

export const AgentEvalDrawer: React.FC<AgentEvalDrawerProps> = ({
  isOpen,
  agentId,
  agentName,
  onClose,
}) => {
  const [promptsText, setPromptsText] = useState(
    'Read diff status for src-tauri\nList open tasks and check architecture docs'
  );
  const [report, setReport] = useState<DryRunEvalReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleRunEval = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompts = promptsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (prompts.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const res = await invoke<DryRunEvalReport>('dry_run_agent_eval', {
        request: { agentId, prompts },
      });
      setReport(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Eval failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="notif-modal-backdrop agent-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="notif-modal-dialog ui-card agent-modal-dialog"
        role="dialog"
        aria-label={`Dry-Run Eval for ${agentName}`}
      >
        <div className="agent-playbooks__run-header">
          <div>
            <strong>Dry-Run Eval Testbench — {agentName}</strong>
            <p className="agent-knowledge__meta">
              Compiles charter, active skills, and Knowledge Pack manifest in strict read-only mode (mutating tools blocked).
            </p>
          </div>
          <button type="button" className="chrome-button" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <p className="agent-feedback agent-feedback--error" role="alert">
            {error}
          </p>
        ) : null}

        <form onSubmit={(e) => void handleRunEval(e)} className="agent-modal-section">
          <label className="agent-knowledge__field">
            <span className="ui-eyebrow">Test prompts (one per line)</span>
            <textarea
              aria-label="Dry-Run test prompts"
              rows={3}
              className="ui-field agent-modal-textarea"
              value={promptsText}
              onChange={(e) => setPromptsText(e.currentTarget.value)}
            />
          </label>
          <div>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? 'Evaluating...' : 'Run Read-Only Eval'}
            </button>
          </div>
        </form>

        {report ? (
          <div className="agent-modal-section">
            <div className="agent-readiness__header">
              <div className="agent-knowledge__meta">
                Prompt size: {report.estimatedPromptTokens} tokens ({report.compiledPromptChars} chars) ·{' '}
                Passed: {report.passedCases}/{report.totalCases} · Blocked mutations: {report.blockedMutations}
              </div>
              {typeof report.readinessScore === 'number' ? (
                <span
                  className="agent-readiness__score-pill"
                  data-strong={report.readinessScore >= 85 ? 'true' : 'false'}
                >
                  Readiness Score: {report.readinessScore}/100
                </span>
              ) : null}
            </div>

            {Array.isArray(report.readinessPillars) && report.readinessPillars.length > 0 ? (
              <div className="ui-card agent-readiness__card">
                <span className="ui-eyebrow">8-Pillar Readiness Checklist</span>
                <div className="agent-readiness__pillars">
                  {report.readinessPillars.map((pillar) => (
                    <div
                      key={pillar.id}
                      className="agent-readiness__pillar"
                      data-passed={pillar.passed ? 'true' : 'false'}
                    >
                      <div className="agent-readiness__pillar-top">
                        <strong>{pillar.label}</strong>
                        <span className="agent-readiness__pillar-status">
                          {pillar.passed ? '✓ Passed' : 'Needs work'} ({pillar.score}/{pillar.maxScore})
                        </span>
                      </div>
                      <span className="agent-knowledge__meta">{pillar.hint}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {report.results.map((r, i) => (
              <div key={i} className="agent-playbooks__node">
                <div className="agent-playbooks__node-top">
                  <strong>{r.prompt}</strong>
                  <span className="agent-memory__badge">{r.passed ? 'passed' : 'blocked'}</span>
                </div>
                <span className="agent-knowledge__meta">
                  Predicted tools: {r.predictedTools.map((t) => `${t.tool} (${t.policy})`).join(', ') || 'none'}
                </span>
                <span className="agent-knowledge__meta">
                  Matched skills: {r.matchedSkills.join(', ') || 'none'}
                </span>
                {r.policyViolations.length > 0 ? (
                  <span className="agent-feedback agent-feedback--error">
                    {r.policyViolations.join(' ')}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};
