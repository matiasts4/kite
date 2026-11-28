import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SelectMenu } from '../../ui/SelectMenu';
import type { AgentAuditLogEntry } from './types';

export interface AgentAuditTabProps {
  agentId: string;
  onOpenThread?: (threadId: string) => void;
}

const VERDICT_OPTIONS = [
  { id: 'all', title: 'All verdicts' },
  { id: 'allowed', title: 'Allowed' },
  { id: 'asked', title: 'Asked' },
  { id: 'denied', title: 'Denied' },
];

const TOOL_FAMILY_OPTIONS = [
  { id: 'all', title: 'All families' },
  { id: 'thread', title: 'thread' },
  { id: 'memory', title: 'memory' },
  { id: 'routine', title: 'routine' },
  { id: 'teammate', title: 'teammate' },
  { id: 'tasks', title: 'tasks' },
  { id: 'ctx', title: 'ctx' },
  { id: 'diff', title: 'diff' },
  { id: 'subagents', title: 'subagents' },
  { id: 'filesystem_write', title: 'filesystem_write' },
  { id: 'shell', title: 'shell' },
];

export const AgentAuditTab: React.FC<AgentAuditTabProps> = ({ agentId, onOpenThread }) => {
  const [entries, setEntries] = useState<AgentAuditLogEntry[]>([]);
  const [verdictFilter, setVerdictFilter] = useState<'all' | 'allowed' | 'asked' | 'denied'>('all');
  const [familyFilter, setFamilyFilter] = useState<string>('all');
  const [searchText, setSearchText] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[AgentAuditTab] Failed to load tool audit log:', err);
      if (typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)) {
        setLoadError(`Unable to load audit log: ${msg}`);
      }
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

        {loadError && (
          <p className="agent-mind-error" role="alert">
            {loadError}
          </p>
        )}

        <div className="agent-memory__toolbar">
          <input
            type="search"
            className="ui-field agent-memory__filter-input"
            aria-label="Filter tool audit log"
            placeholder="Filter by tool, family, or reason..."
            value={searchText}
            onChange={(e) => setSearchText(e.currentTarget.value)}
          />
          <SelectMenu
            variant="toolbar"
            label="Filter by verdict"
            value={verdictFilter}
            triggerLabel={VERDICT_OPTIONS.find((v) => v.id === verdictFilter)?.title || 'All verdicts'}
            rows={VERDICT_OPTIONS}
            onSelect={(id) => setVerdictFilter(id as typeof verdictFilter)}
          />
          <SelectMenu
            variant="toolbar"
            label="Filter by tool family"
            value={familyFilter}
            triggerLabel={TOOL_FAMILY_OPTIONS.find((f) => f.id === familyFilter)?.title || 'All families'}
            rows={TOOL_FAMILY_OPTIONS}
            onSelect={(id) => setFamilyFilter(id)}
          />
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
