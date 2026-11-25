import React, { useState } from 'react';
import { getEngineDisplayName, TEAMMATE_ENGINE_IDS } from '../engineMetadata';

export type ToolPolicyDecision = 'allow' | 'ask' | 'deny';

export const CANONICAL_TOOL_FAMILIES: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  defaultPolicy: ToolPolicyDecision;
}> = [
  { id: 'thread', label: 'Threads (kite_thread)', description: 'List, search, and read threads', defaultPolicy: 'allow' },
  { id: 'memory', label: 'Memory (kite_memory)', description: 'Read, add, and search memory.txt / user.txt', defaultPolicy: 'allow' },
  { id: 'routine', label: 'Routines (kite_routine)', description: 'Manage and trigger scheduled routines', defaultPolicy: 'allow' },
  { id: 'teammate', label: 'Teammates (kite_teammate)', description: 'Message and delegate to teammates', defaultPolicy: 'allow' },
  { id: 'tasks', label: 'Kite Tasks (kite_tasks)', description: 'Inspect, create, update, and move Kite Tasks', defaultPolicy: 'allow' },
  { id: 'ctx', label: 'Context Engine (kite_ctx)', description: 'Compact reads, search, shared context, CCR', defaultPolicy: 'allow' },
  { id: 'diff', label: 'Git Diff (kite_diff)', description: 'Read repository status and file diffs', defaultPolicy: 'allow' },
  { id: 'filesystem_write', label: 'Filesystem Write', description: 'Modify files inside bound workspace and Places', defaultPolicy: 'ask' },
  { id: 'shell', label: 'Shell Execution', description: 'Run local CLI commands inside workspace', defaultPolicy: 'ask' },
];

export interface AgentToolPolicySectionProps {
  primaryEngine: string;
  toolPolicies: Record<string, ToolPolicyDecision>;
  maxTurnsPerRun?: number | null;
  maxDurationSecs?: number | null;
  failoverEngines: string[];
  readOnly?: boolean;
  saving?: boolean;
  onChangePolicy: (family: string, decision: ToolPolicyDecision) => void;
  onChangeMaxTurns: (val: number | null) => void;
  onChangeMaxDuration: (val: number | null) => void;
  onChangeFailoverEngines: (engines: string[]) => void;
}

export const AgentToolPolicySection: React.FC<AgentToolPolicySectionProps> = ({
  primaryEngine,
  toolPolicies,
  maxTurnsPerRun,
  maxDurationSecs,
  failoverEngines,
  readOnly = false,
  saving = false,
  onChangePolicy,
  onChangeMaxTurns,
  onChangeMaxDuration,
  onChangeFailoverEngines,
}) => {
  const [nextFailover, setNextFailover] = useState<string>('');
  const disabled = readOnly || saving;

  const availableFailovers = TEAMMATE_ENGINE_IDS.filter(
    (eng) => eng !== primaryEngine && !failoverEngines.includes(eng)
  );

  const handleAddFailover = (engineId: string) => {
    if (!engineId || failoverEngines.includes(engineId)) return;
    onChangeFailoverEngines([...failoverEngines, engineId]);
    setNextFailover('');
  };

  const handleMoveFailover = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= failoverEngines.length) return;
    const copy = [...failoverEngines];
    const [item] = copy.splice(idx, 1);
    copy.splice(target, 0, item);
    onChangeFailoverEngines(copy);
  };

  return (
    <section className="agent-setting-group" aria-label="Tool Policies and Execution Guardrails">
      <h2 className="agent-setting-label">Tool Policies &amp; Sandbox Guardrails</h2>

      <div className="ui-card agent-settings__rows" role="group" aria-label="Per-tool policy matrix">
        {CANONICAL_TOOL_FAMILIES.map((fam) => {
          const current: ToolPolicyDecision = toolPolicies[fam.id] ?? fam.defaultPolicy;
          return (
            <div key={fam.id} className="agent-settings__row">
              <span className="agent-settings__row-copy">
                <strong>{fam.label}</strong>
                <small>{fam.description}</small>
              </span>
              <span className="agent-settings__control">
                <div
                  role="group"
                  aria-label={`Policy for ${fam.id}`}
                  className="agent-policy-segmented"
                >
                  {(['allow', 'ask', 'deny'] as const).map((decision) => {
                    const active = current === decision;
                    return (
                      <button
                        key={decision}
                        type="button"
                        aria-pressed={active}
                        disabled={disabled}
                        className={`agent-policy-segmented__btn${active ? ` agent-policy-segmented__btn--${decision}` : ''}`}
                        onClick={() => onChangePolicy(fam.id, decision)}
                      >
                        {decision === 'allow' ? 'Allow' : decision === 'ask' ? 'Ask' : 'Deny'}
                      </button>
                    );
                  })}
                </div>
              </span>
            </div>
          );
        })}
      </div>

      <div className="ui-card agent-settings__rows" style={{ marginTop: '8px' }}>
        <div className="agent-settings__row">
          <span className="agent-settings__row-copy">
            <strong>Max turns per run</strong>
            <small>Hard turn cap for autonomous runs and routines (1–100).</small>
          </span>
          <span className="agent-settings__control">
            <input
              type="number"
              min={1}
              max={100}
              aria-label="Max turns per run"
              className="ui-field rounded-control"
              style={{ width: '92px', height: 'var(--vl-control-md, 32px)' }}
              disabled={disabled}
              value={maxTurnsPerRun ?? ''}
              placeholder="20"
              onChange={(e) => {
                const raw = e.currentTarget.value.trim();
                onChangeMaxTurns(raw ? Math.max(1, Math.min(100, Number(raw) || 20)) : null);
              }}
            />
          </span>
        </div>

        <div className="agent-settings__row">
          <span className="agent-settings__row-copy">
            <strong>Max duration (seconds)</strong>
            <small>Wall-clock cap per autonomous run (30–7200s).</small>
          </span>
          <span className="agent-settings__control">
            <input
              type="number"
              min={30}
              max={7200}
              aria-label="Max duration seconds"
              className="ui-field rounded-control"
              style={{ width: '92px', height: 'var(--vl-control-md, 32px)' }}
              disabled={disabled}
              value={maxDurationSecs ?? ''}
              placeholder="900"
              onChange={(e) => {
                const raw = e.currentTarget.value.trim();
                onChangeMaxDuration(raw ? Math.max(30, Math.min(7200, Number(raw) || 900)) : null);
              }}
            />
          </span>
        </div>

        <div className="agent-settings__row" style={{ alignItems: 'flex-start' }}>
          <span className="agent-settings__row-copy">
            <strong>Failover engine order</strong>
            <small>Ordered fallback providers if the primary engine is unavailable or quota-limited.</small>
            {failoverEngines.length > 0 && (
              <ul className="agent-failover-list" aria-label="Configured failover engines">
                {failoverEngines.map((eng, idx) => (
                  <li key={eng} className="agent-failover-chip">
                    <span>{idx + 1}. {getEngineDisplayName(eng)}</span>
                    <button
                      type="button"
                      disabled={disabled || idx === 0}
                      aria-label={`Move ${eng} up`}
                      onClick={() => handleMoveFailover(idx, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={disabled || idx === failoverEngines.length - 1}
                      aria-label={`Move ${eng} down`}
                      onClick={() => handleMoveFailover(idx, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={`Remove failover ${eng}`}
                      onClick={() => onChangeFailoverEngines(failoverEngines.filter((x) => x !== eng))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
          <span className="agent-settings__control">
            <select
              aria-label="Add failover engine"
              className="ui-field rounded-control text-caption"
              style={{ height: 'var(--vl-control-md, 32px)', maxWidth: '150px' }}
              disabled={disabled || availableFailovers.length === 0}
              value={nextFailover}
              onChange={(e) => handleAddFailover(e.currentTarget.value)}
            >
              <option value="">Add failover…</option>
              {availableFailovers.map((eng) => (
                <option key={eng} value={eng}>
                  {getEngineDisplayName(eng)}
                </option>
              ))}
            </select>
          </span>
        </div>
      </div>
    </section>
  );
};
