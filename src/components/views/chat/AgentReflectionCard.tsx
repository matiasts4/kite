import React, { useState } from 'react';
import { loadAgentMind, writeAgentMemory } from '../../../lib/ipc/agents';
import type { ReflectionCandidate } from './types';

export interface AgentReflectionCardProps {
  candidate: ReflectionCandidate;
  onDismiss: () => void;
}

export const AgentReflectionCard: React.FC<AgentReflectionCardProps> = ({
  candidate,
  onDismiss,
}) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const mind = await loadAgentMind(candidate.agentId);
      const existing = mind.memory?.trimEnd() ?? '';
      const nextText = existing
        ? existing.includes(candidate.note.trim())
          ? existing
          : `${existing}\n${candidate.note}\n`
        : `${candidate.note}\n`;
      await writeAgentMemory(
        candidate.agentId,
        'memory',
        nextText,
        'structured',
        mind.memoryRevision ?? null,
        true
      );
      onDismiss();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save to memory.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mt-3 flex flex-col gap-2 rounded-card border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-sm shadow-sm"
      role="region"
      aria-label="Memory reflection suggestion"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text-primary)]">
            Save learning to agent memory?
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {candidate.summary || candidate.note}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="secondary-button action-button--row h-7 rounded-control px-2.5 text-xs"
            disabled={saving}
            onClick={onDismiss}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="primary-button action-button--row h-7 rounded-control px-2.5 text-xs"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save to memory'}
          </button>
        </div>
      </div>
      {error && (
        <p className="text-xs text-[var(--status-error)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
