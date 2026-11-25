import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AgentAuditLogEntry } from './types';

export interface AgentAuditTabProps {
  agentId: string;
  onOpenThread?: (threadId: string) => void;
}

export const AgentAuditTab: React.FC<AgentAuditTabProps> = ({ agentId, onOpenThread }) => {
  const [entries, setEntries] = useState<AgentAuditLogEntry[]>([]);
  const [verdictFilter, setVerdictFilter] = useState<'all' | 'allowed' | 'asked' | 'denied'>('all');
  const [familyFilter, setFamilyFilter] = useState<string>('all');
  const [searchText, setSearchText] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invoke<{ entries?: AgentAuditLogEntry[] }>('list_agent_audit_log', {
        request: {
          agentId,
          verdict: verdictFilter === 'all' ? null : verdictFilter,
          toolFamily: familyFilter === 'all' ? null : familyFilter,
          limit: 100,
        },
      });
      setEntries(res?.entries ?? []);
    } catch {
      // Safe fallback outside Tauri runtime
    } finally {
      setLoading(false);
    }
  }, [agentId, verdictFilter, familyFilter]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.toolName.toLowerCase().includes(q) ||
        e.toolFamily.toLowerCase().includes(q) ||
        (e.reason ?? '').toLowerCase().includes(q)
    );
  }, [entries, searchText]);

  return (
    <div className="agent-face agent-audit">
      <div className="agent-mind-column">
        <p className="agent-mind-lede">
          Persistent SQLite audit ledger recording tool policy verdicts (<code>allow</code>, <code>ask</code>, <code>deny</code>), latency, and thread links.
        </p>

        <div className="agent-memory__toolbar">
          <input
            type="search"
            className="ui-field agent-memory__filter-input"
            aria-label="Filter tool audit log"
            placeholder="Filter by tool, family, or reason..."
            value={searchText}
            onChange={(e) => setSearchText(e.currentTarget.value)}
          />
          <select
            aria-label="Filter by verdict"
            className="ui-field"
            value={verdictFilter}
            onChange={(e) => setVerdictFilter(e.currentTarget.value as typeof verdictFilter)}
          >
            <option value="all">All verdicts</option>
            <option value="allowed">Allowed</option>
            <option value="asked">Asked</option>
            <option value="denied">Denied</option>
          </select>
          <select
            aria-label="Filter by tool family"
            className="ui-field"
            value={familyFilter}
            onChange={(e) => setFamilyFilter(e.currentTarget.value)}
          >
            <option value="all">All families</option>
            <option value="tasks">tasks</option>
            <option value="ctx">ctx</option>
            <option value="diff">diff</option>
            <option value="memory">memory</option>
            <option value="routine">routine</option>
            <option value="shell">shell</option>
          </select>
          <button
            type="button"
            className="chrome-button"
            disabled={loading}
            onClick={() => void loadAudit()}
          >
            Refresh
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="ui-card agent-knowledge__empty">
            No audit events recorded for the selected filters.
          </div>
        ) : (
          <div className="agent-knowledge__list">
            {filtered.map((item) => (
              <div key={item.id} className="ui-card agent-knowledge__item">
                <div className="agent-knowledge__item-info">
                  <div>
                    <strong>{item.toolName}</strong>{' '}
                    <span className="agent-memory__badge">{item.verdict}</span>{' '}
                    <span className="agent-knowledge__meta">
                      {item.toolFamily} · {item.durationMs}ms
                    </span>
                  </div>
                  {item.reason ? (
                    <span className="agent-knowledge__meta">{item.reason}</span>
                  ) : null}
                </div>
                {item.threadId && onOpenThread ? (
                  <button
                    type="button"
                    className="chrome-button"
                    onClick={() => onOpenThread(item.threadId!)}
                  >
                    Open thread
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
