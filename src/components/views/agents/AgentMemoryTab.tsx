import React, { useState, useEffect, useMemo } from 'react';
import {
  AgentMindSnapshot,
  MemoryTarget,
  MEMORY_DELIMITER,
  parseMemoryEntries,
  clusterMemory,
} from './types';
import { loadAgentMind, writeAgentMemory } from '../../../lib/ipc';

// Memory list thresholds
const USER_MEMORY_BUDGET = 1375;
const DEFAULT_AGENT_MEMORY_BUDGET = 2200;
const MAX_RAW_BYTE_SIZE = 262144; // 256 KB hard renderer boundary

function formatBudget(bytes: number): string {
  if (bytes < 1000) return String(bytes);
  const k = bytes / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

function getUtf8ByteLength(str: string): number {
  return new TextEncoder().encode(str).byteLength;
}

function countGraphemes(str: string): number {
  const intlAny = Intl as unknown as { Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => { segment: (input: string) => Iterable<unknown> } };
  if (typeof intlAny !== 'undefined' && typeof intlAny.Segmenter === 'function') {
    const segmenter = new intlAny.Segmenter(undefined, { granularity: 'grapheme' });
    let count = 0;
    for (const _ of segmenter.segment(str)) {
      count += 1;
    }
    return count;
  }
  return [...str].length;
}

function serializeMemoryEntries(entries: string[]): string {
  return entries
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .join(MEMORY_DELIMITER);
}

function measureMemoryLength(rawText: string): number {
  return countGraphemes(serializeMemoryEntries(parseMemoryEntries(rawText)));
}

// Clean inline SVGs (no external icon dependencies, no emojis)
const BrainIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
    <path d="M6.002 5.125A3 3 0 0 0 6.401 6.5" />
    <path d="M3.477 10.878a4 4 0 0 0 .025.244" />
    <path d="M20.498 11.122a4 4 0 0 0 .025-.244" />
    <path d="M5.997 18.875a4 4 0 0 0 .866 1.13" />
    <path d="M17.137 20.005a4 4 0 0 0 .866-1.13" />
  </svg>
);

const UserRoundIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="8" r="5" />
    <path d="M20 21a8 8 0 0 0-16 0" />
  </svg>
);

const ArrowUpIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

const PencilIcon: React.FC<{ size?: number; className?: string }> = ({ size = 11, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

const Trash2Icon: React.FC<{ size?: number; className?: string }> = ({ size = 11, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

const RotateCcwIcon: React.FC<{ size?: number; className?: string }> = ({ size = 11, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

const AlertTriangleIcon: React.FC<{ size?: number; className?: string }> = ({ size = 17, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export interface WriteAgentMemoryArgs {
  agentId: string;
  target: MemoryTarget;
  text: string;
  editKind: 'structured' | 'rawBuilderEdit';
  expectedRevision: string;
  confirmedByBuilder: true;
}

export interface AgentMemoryTabProps {
  agentName?: string;
  mind: AgentMindSnapshot | null;
  memoryTarget?: MemoryTarget;
  setMemoryTarget?: (target: MemoryTarget) => void;
  memoryBudget?: number | null;
  memorySaving?: boolean;
  lastDeletedEntry?: { target: MemoryTarget; index: number; text: string } | null;
  onSaveRawMemory?: (draft: string) => Promise<void>;
  onAddMemoryNote?: (text: string) => Promise<void>;
  onSaveInlineEntry?: (index: number, draft: string) => Promise<void>;
  onDeleteEntry?: (index: number, text: string) => Promise<void>;
  onUndoDeleteEntry?: () => Promise<void>;
  // Optional memory controls
  profile?: { id: string; name: string; memoryBudget?: number | null };
  readOnly?: boolean;
  saving?: boolean;
  error?: string | null;
  successMessage?: string | null;
  onWrite?: (args: WriteAgentMemoryArgs) => Promise<boolean | void>;
  onMindUpdated?: (mind: AgentMindSnapshot) => void;
}

export const AgentMemoryTab: React.FC<AgentMemoryTabProps> = ({
  agentName: agentNameProp,
  mind: mindProp,
  memoryTarget: memoryTargetProp,
  setMemoryTarget: setMemoryTargetProp,
  memoryBudget: memoryBudgetProp,
  memorySaving: memorySavingProp,
  lastDeletedEntry: lastDeletedEntryProp,
  onSaveRawMemory: onSaveRawMemoryProp,
  onAddMemoryNote: onAddMemoryNoteProp,
  onSaveInlineEntry: onSaveInlineEntryProp,
  onDeleteEntry: onDeleteEntryProp,
  onUndoDeleteEntry: onUndoDeleteEntryProp,
  profile,
  readOnly: readOnlyProp = false,
  saving: savingProp = false,
  error: errorProp = null,
  successMessage: successMessageProp = null,
  onWrite: onWriteProp,
  onMindUpdated: onMindUpdatedProp,
}) => {
  const [internalTarget, setInternalTarget] = useState<MemoryTarget>('memory');
  const [newNoteText, setNewNoteText] = useState<string>('');
  const [editingEntry, setEditingEntry] = useState<{ index: number; draft: string; original: string } | null>(null);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [internalLastDeleted, setInternalLastDeleted] = useState<{ target: MemoryTarget; index: number; text: string } | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [localSaving, setLocalSaving] = useState<boolean>(false);
  const [localMind, setLocalMind] = useState<AgentMindSnapshot | null>(mindProp);

  const activeMind = mindProp ?? localMind;
  const effectiveAgentName = profile?.name ?? agentNameProp ?? 'This agent';
  const effectiveAgentId = profile?.id ?? activeMind?.agentId ?? '';
  const activeTarget = memoryTargetProp ?? internalTarget;

  // Sync internal state when agent changes
  useEffect(() => {
    if (effectiveAgentId.length > 0) {
      if (setMemoryTargetProp) {
        setMemoryTargetProp('memory');
      } else {
        setInternalTarget('memory');
      }
      setNewNoteText('');
      setEditingEntry(null);
      setRawDraft(null);
      setInternalLastDeleted(null);
      setInlineError(null);
    }
  }, [effectiveAgentId, setMemoryTargetProp]);

  // Keep localMind synchronized if parent passes mind or load it via IPC
  useEffect(() => {
    if (mindProp) {
      setLocalMind(mindProp);
    } else if (effectiveAgentId) {
      let active = true;
      loadAgentMind(effectiveAgentId)
        .then((snapshot) => {
          if (active) {
            setLocalMind(snapshot);
            onMindUpdatedProp?.(snapshot);
          }
        })
        .catch((err) => {
          console.error('[AgentMemoryTab] Failed to load agent mind:', err);
        });
      return () => {
        active = false;
      };
    }
  }, [mindProp, effectiveAgentId, onMindUpdatedProp]);

  // Active bounded file content and revision
  const activeRawText = useMemo(() => {
    if (!activeMind) return '';
    return activeTarget === 'memory' ? activeMind.memory : activeMind.user;
  }, [activeMind, activeTarget]);

  const activeRevision = useMemo(() => {
    if (!activeMind) return null;
    return activeTarget === 'memory' ? activeMind.memoryRevision : activeMind.userRevision;
  }, [activeMind, activeTarget]);

  // Parse structured entries and clusters
  const memoryEntries = useMemo(() => {
    return parseMemoryEntries(activeRawText);
  }, [activeRawText]);

  const memoryClusters = useMemo(() => {
    return clusterMemory(memoryEntries);
  }, [memoryEntries]);

  const notesCount = useMemo(() => {
    return activeMind ? parseMemoryEntries(activeMind.memory).length : 0;
  }, [activeMind]);

  const aboutYouCount = useMemo(() => {
    return activeMind ? parseMemoryEntries(activeMind.user).length : 0;
  }, [activeMind]);

  // Read issues detection
  const isMemoryUnreadable = useMemo(() => {
    if (!activeMind || !activeMind.readIssues) return false;
    const issueCode = activeTarget === 'memory' ? 'memoryUnreadable' : 'userUnreadable';
    return activeMind.readIssues.some((issue) => issue.code === issueCode);
  }, [activeMind, activeTarget]);

  // Budget calculations
  const memoryUsedLength = useMemo(() => {
    return measureMemoryLength(activeRawText);
  }, [activeRawText]);

  const activeBudget = useMemo(() => {
    if (activeTarget === 'user') return USER_MEMORY_BUDGET;
    return memoryBudgetProp ?? profile?.memoryBudget ?? DEFAULT_AGENT_MEMORY_BUDGET;
  }, [activeTarget, memoryBudgetProp, profile?.memoryBudget]);

  const usedFraction = activeBudget > 0 ? Math.min(memoryUsedLength / activeBudget, 1) : 1;
  const isOverCap = memoryUsedLength > activeBudget;
  const isSaving = Boolean(memorySavingProp || savingProp || localSaving);
  const isLocked = Boolean(readOnlyProp || isSaving || activeRevision === null || isMemoryUnreadable);

  const activeUndoEntry = lastDeletedEntryProp ?? internalLastDeleted;

  const hairlineStyle = {
    '--memory-used': `${Math.max(2, usedFraction * 100)}%`,
  } as React.CSSProperties;

  const handleSelectTarget = (target: MemoryTarget) => {
    if (setMemoryTargetProp) {
      setMemoryTargetProp(target);
    } else {
      setInternalTarget(target);
    }
    setNewNoteText('');
    setEditingEntry(null);
    setRawDraft(null);
    setInlineError(null);
  };

  const validateEdit = (text: string, kind: 'structured' | 'rawBuilderEdit'): boolean => {
    if (getUtf8ByteLength(text) > MAX_RAW_BYTE_SIZE) {
      setInlineError('This edit is too large for the bounded memory file.');
      return false;
    }
    if (kind === 'structured' && measureMemoryLength(text) > activeBudget) {
      const label = activeTarget === 'memory' ? 'note' : 'detail';
      setInlineError(
        `At the ${formatBudget(activeBudget)} cap — shorten or remove a ${label} before adding another.`
      );
      return false;
    }
    return true;
  };

  const executeWrite = async (
    text: string,
    editKind: 'structured' | 'rawBuilderEdit'
  ): Promise<boolean> => {
    if (isLocked || !activeRevision) return false;
    if (!validateEdit(text, editKind)) return false;

    setInlineError(null);
    setLocalSaving(true);
    try {
      if (onWriteProp) {
        const res = await onWriteProp({
          agentId: effectiveAgentId,
          target: activeTarget,
          text,
          editKind,
          expectedRevision: activeRevision,
          confirmedByBuilder: true,
        });
        return res !== false;
      }

      if (editKind === 'rawBuilderEdit' && onSaveRawMemoryProp) {
        await onSaveRawMemoryProp(text);
        return true;
      }

      if (effectiveAgentId) {
        const updatedMind = await writeAgentMemory(
          effectiveAgentId,
          activeTarget,
          text,
          editKind,
          activeRevision,
          true
        );
        setLocalMind(updatedMind);
        if (onMindUpdatedProp) {
          onMindUpdatedProp(updatedMind);
        }
        return true;
      }

      return true;
    } catch (err: unknown) {
      console.error('[AgentMemoryTab] Error writing agent memory:', err);
      setInlineError(err instanceof Error ? err.message : 'Failed to write agent memory');
      return false;
    } finally {
      setLocalSaving(false);
    }
  };

  const handleAddNote = async () => {
    const trimmed = newNoteText.trim();
    if (trimmed.length === 0) return;

    if (memoryEntries.includes(trimmed)) {
      setNewNoteText('');
      return;
    }

    if (onAddMemoryNoteProp) {
      setInlineError(null);
      try {
        const nextEntries = [...memoryEntries, trimmed];
        if (!validateEdit(serializeMemoryEntries(nextEntries), 'structured')) {
          return;
        }
        await onAddMemoryNoteProp(trimmed);
        setNewNoteText('');
      } catch (err: unknown) {
        console.error('[AgentMemoryTab] Add note error:', err);
        setInlineError(err instanceof Error ? err.message : 'Failed to add note');
      }
    } else {
      const nextText = serializeMemoryEntries([...memoryEntries, trimmed]);
      const ok = await executeWrite(nextText, 'structured');
      if (ok) {
        setNewNoteText('');
      }
    }
  };

  const handleSaveInline = async () => {
    if (!editingEntry) return;
    const trimmed = editingEntry.draft.trim();
    const next = [...memoryEntries];

    if (next[editingEntry.index] !== editingEntry.original) {
      setInlineError('This note changed while it was open. Re-open it before saving.');
      return;
    }

    if (onSaveInlineEntryProp) {
      setInlineError(null);
      try {
        if (trimmed.length > 0) {
          const testList = [...next];
          testList[editingEntry.index] = trimmed;
          if (!validateEdit(serializeMemoryEntries(testList), 'structured')) {
            return;
          }
        }
        await onSaveInlineEntryProp(editingEntry.index, trimmed);
        setEditingEntry(null);
      } catch (err: unknown) {
        console.error('[AgentMemoryTab] Inline edit error:', err);
        setInlineError(err instanceof Error ? err.message : 'Failed to update entry');
      }
    } else {
      if (trimmed.length === 0) {
        next.splice(editingEntry.index, 1);
      } else {
        next[editingEntry.index] = trimmed;
      }
      const nextText = serializeMemoryEntries(next);
      const ok = await executeWrite(nextText, 'structured');
      if (ok) {
        setEditingEntry(null);
      }
    }
  };

  const handleDeleteEntry = async (index: number, text: string) => {
    if (memoryEntries[index] !== text) {
      setInlineError('This note changed before it could be removed. Re-read and try again.');
      return;
    }

    if (onDeleteEntryProp) {
      setInlineError(null);
      try {
        await onDeleteEntryProp(index, text);
        setEditingEntry(null);
        setInternalLastDeleted({ target: activeTarget, index, text });
      } catch (err: unknown) {
        console.error('[AgentMemoryTab] Delete error:', err);
        setInlineError(err instanceof Error ? err.message : 'Failed to delete entry');
      }
    } else {
      const next = [...memoryEntries];
      next.splice(index, 1);
      const nextText = serializeMemoryEntries(next);
      const ok = await executeWrite(nextText, 'structured');
      if (ok) {
        setEditingEntry(null);
        setInternalLastDeleted({ target: activeTarget, index, text });
      }
    }
  };

  const handleUndo = async () => {
    if (!activeUndoEntry || activeUndoEntry.target !== activeTarget) return;

    if (onUndoDeleteEntryProp) {
      setInlineError(null);
      try {
        await onUndoDeleteEntryProp();
        setInternalLastDeleted(null);
      } catch (err: unknown) {
        console.error('[AgentMemoryTab] Undo error:', err);
        setInlineError(err instanceof Error ? err.message : 'Failed to restore entry');
      }
    } else {
      const next = [...memoryEntries];
      const targetIdx = Math.min(activeUndoEntry.index, next.length);
      next.splice(targetIdx, 0, activeUndoEntry.text);
      const nextText = serializeMemoryEntries(next);
      const ok = await executeWrite(nextText, 'structured');
      if (ok) {
        setInternalLastDeleted(null);
      }
    }
  };

  const handleSaveRaw = async () => {
    if (rawDraft === null) return;

    if (onSaveRawMemoryProp) {
      setInlineError(null);
      try {
        if (!validateEdit(rawDraft, 'rawBuilderEdit')) {
          return;
        }
        await onSaveRawMemoryProp(rawDraft);
        setRawDraft(null);
      } catch (err: unknown) {
        console.error('[AgentMemoryTab] Raw save error:', err);
        setInlineError(err instanceof Error ? err.message : 'Failed to save raw memory');
      }
    } else {
      const ok = await executeWrite(rawDraft, 'rawBuilderEdit');
      if (ok) {
        setRawDraft(null);
      }
    }
  };

  // Raw Builder Mode
  if (rawDraft !== null) {
    return (
      <div className="agent-face agent-memory agent-memory--raw">
        <header className="agent-memory__raw-toolbar">
          <strong>{activeTarget === 'memory' ? 'Editing notes' : 'Editing who you are'}</strong>
          <span>Raw builder edit bypasses the character cap, but remains revision-checked.</span>
          <button
            type="button"
            className="secondary-button action-button--row"
            disabled={isSaving}
            onClick={() => setRawDraft(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-button action-button--row"
            disabled={
              isSaving ||
              rawDraft === activeRawText ||
              getUtf8ByteLength(rawDraft) > MAX_RAW_BYTE_SIZE
            }
            onClick={() => void handleSaveRaw()}
          >
            {isSaving ? 'Saving…' : 'Save raw file'}
          </button>
        </header>

        {(inlineError || errorProp) && (
          <p className="agent-feedback agent-feedback--error agent-memory__feedback" role="alert">
            {inlineError || errorProp}
          </p>
        )}

        <label className="sr-only" htmlFor="agent-memory-raw-editor">
          Raw {activeTarget === 'memory' ? 'notes' : 'about you'} file
        </label>
        <textarea
          id="agent-memory-raw-editor"
          spellCheck={false}
          value={rawDraft}
          onChange={(e) => setRawDraft(e.currentTarget.value)}
        />
      </div>
    );
  }

  // Calculated lede or empty state copy
  const isUnreadable = isMemoryUnreadable || activeRevision === null;
  const isAtCap = memoryUsedLength > activeBudget;
  const isWarningLede = isAtCap || isUnreadable || Boolean(inlineError);
  const isEmpty = memoryEntries.length === 0;

  const defaultLedeOrTitle = isUnreadable
    ? 'This file could not be read safely. Editing stays locked; the original was not replaced.'
    : inlineError || (
      isAtCap
        ? `At the cap — shorten or remove a ${activeTarget === 'memory' ? 'note' : 'detail'} before adding another.`
        : isEmpty
          ? activeTarget === 'memory'
            ? `${effectiveAgentName} hasn't remembered anything yet. Add a convention, a decision and why.`
            : `${effectiveAgentName} doesn't know anything about you yet. Preferences, names, how you like work.`
          : activeTarget === 'memory'
            ? `What ${effectiveAgentName} carries between chats.`
            : `What ${effectiveAgentName} should already know about you.`
    );

  const emptyExampleDescription =
    activeTarget === 'memory'
      ? 'For example: "Ship notes go in the #releases channel, never in a DM — the team reads that channel on Fridays."'
      : 'For example: "I go by Matt. Short replies, no preamble — I read on a phone between meetings."';

  return (
    <div className="agent-face agent-memory agent-memory--ledger">
      {/* Subbar with target toggle, meter & raw button */}
      <div className="agent-mind-bar">
        <div className="ui-tabs">
          <div aria-label="Memory room" className="ui-tabs__list" role="tablist">
            <button
              type="button"
              role="tab"
              tabIndex={activeTarget === 'memory' ? 0 : -1}
              aria-selected={activeTarget === 'memory'}
              className={activeTarget === 'memory' ? 'ui-tab ui-tab--selected' : 'ui-tab'}
              onClick={() => handleSelectTarget('memory')}
            >
              <span className="ui-tab__label" data-label="Notes">
                Notes
              </span>
              {notesCount > 0 ? (
                <span className="ui-tab__count" data-count="">
                  {notesCount}
                </span>
              ) : null}
            </button>

            <button
              type="button"
              role="tab"
              tabIndex={activeTarget === 'user' ? 0 : -1}
              aria-selected={activeTarget === 'user'}
              className={activeTarget === 'user' ? 'ui-tab ui-tab--selected' : 'ui-tab'}
              onClick={() => handleSelectTarget('user')}
            >
              <span className="ui-tab__label" data-label="About you">
                About you
              </span>
              {aboutYouCount > 0 ? (
                <span className="ui-tab__count" data-count="">
                  {aboutYouCount}
                </span>
              ) : null}
            </button>
          </div>

          <div className="ui-tabs__trailing">
            <div className="agent-memory__budget">
              {activeUndoEntry && activeUndoEntry.target === activeTarget && (
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => void handleUndo()}
                  title="Restore the last deleted entry"
                >
                  <RotateCcwIcon size={11} />
                  Undo
                </button>
              )}

              <span
                className={`agent-memory__meter${isOverCap ? ' agent-memory__meter--over' : ''}`}
                title={
                  isOverCap
                    ? `This file is over its ${formatBudget(activeBudget)} cap — new writes are refused until something is shortened or removed.`
                    : `Hard size cap for this file. Notes is set in Settings; About you is fixed at ${formatBudget(USER_MEMORY_BUDGET)}.`
                }
              >
                <span
                  aria-label="Memory budget used"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(usedFraction * 100)}
                  className={`agent-memory__hairline${isOverCap ? ' agent-memory__hairline--over' : ''}`}
                  role="progressbar"
                  style={hairlineStyle}
                />
                <span data-count="">
                  {formatBudget(memoryUsedLength)} of {formatBudget(activeBudget)}
                </span>
              </span>

              <button
                type="button"
                disabled={isLocked}
                onClick={() => setRawDraft(activeRawText)}
                title="Edit the whole file as text"
              >
                Raw
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Read Issue Alert Banner */}
      {(isMemoryUnreadable || activeRevision === null) && (
        <div className="agent-memory__read-issue" role="alert">
          <AlertTriangleIcon size={17} />
          <span>
            <strong>Memory opened read-only</strong>
            {' '}Recovery requires a separate native confirmation flow; this view will not overwrite an unreadable file.
          </span>
        </div>
      )}

      {/* Success Notification */}
      {successMessageProp && (
        <p className="sr-only" role="status">
          {successMessageProp}
        </p>
      )}

      {/* Error Notification */}
      {(inlineError || errorProp) && (
        <p className="agent-feedback agent-feedback--error agent-memory__feedback" role="alert">
          {inlineError || errorProp}
        </p>
      )}

      {/* Ledger Body */}
      <div className="agent-memory__room" id="agent-memory-room" role="tabpanel">
        {memoryClusters.length > 0 ? (
          <div className="agent-mind-column">
            <p className={`agent-mind-lede${isWarningLede ? ' agent-mind-lede--warning' : ''}`}>
              {defaultLedeOrTitle}
            </p>

            <div className="agent-memory__clusters">
              {memoryClusters.map((cluster) => (
                <section
                  key={`${cluster.heading ?? 'unheaded'}-${cluster.entries[0]?.index ?? 'empty'}`}
                  className="ui-card agent-memory__cluster"
                >
                  {cluster.heading && <h2 className="ui-eyebrow">{cluster.heading}</h2>}
                  <div>
                    {cluster.entries.map((entry) => (
                      <div key={`${entry.index}-${entry.text}`} className="agent-memory__entry">
                        {editingEntry?.index === entry.index && editingEntry.original === entry.text ? (
                          <div className="agent-memory__inline-editor">
                            <label className="sr-only" htmlFor={`memory-entry-${entry.index}`}>
                              Edit memory entry
                            </label>
                            <textarea
                              id={`memory-entry-${entry.index}`}
                              rows={2}
                              value={editingEntry.draft}
                              onChange={(e) => {
                                const val = e.currentTarget.value;
                                setEditingEntry((prev) => (prev ? { ...prev, draft: val } : null));
                              }}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={isSaving}
                              onClick={() => setEditingEntry(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="primary-button"
                              disabled={isSaving || editingEntry.draft.trim() === entry.text}
                              onClick={() => void handleSaveInline()}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="agent-memory__entry-text"
                              disabled={isLocked}
                              onClick={() =>
                                setEditingEntry({
                                  index: entry.index,
                                  original: entry.text,
                                  draft: entry.text,
                                })
                              }
                              title="Edit memory entry"
                            >
                              {entry.body}
                            </button>
                            <div className="agent-memory__entry-actions">
                              <button
                                type="button"
                                aria-label="Edit memory entry"
                                disabled={isLocked}
                                onClick={() =>
                                  setEditingEntry({
                                    index: entry.index,
                                    original: entry.text,
                                    draft: entry.text,
                                  })
                                }
                              >
                                <PencilIcon size={11} />
                              </button>
                              <button
                                type="button"
                                aria-label="Delete memory entry"
                                disabled={isLocked}
                                onClick={() => void handleDeleteEntry(entry.index, entry.text)}
                              >
                                <Trash2Icon size={11} />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : (
          <section className="empty-surface empty-surface--inline agent-memory__empty" role="status">
            <span aria-hidden="true" className="empty-surface__icon">
              {activeTarget === 'memory' ? <BrainIcon size={22} /> : <UserRoundIcon size={22} />}
            </span>
            <div className="empty-surface__copy">
              <h1>{defaultLedeOrTitle}</h1>
              {isEmpty && !isWarningLede && <p>{emptyExampleDescription}</p>}
            </div>
            <span className="sr-only">No memory entries</span>
          </section>
        )}
      </div>

      {/* Composer at Bottom */}
      <div className="agent-memory__composer-shell">
        <div className="agent-memory__composer">
          <label className="sr-only" htmlFor="agent-memory-note">
            {activeTarget === 'memory' ? 'Add a memory note' : 'Add something about you'}
          </label>
          <textarea
            id="agent-memory-note"
            rows={1}
            value={newNoteText}
            disabled={isLocked}
            onChange={(e) => setNewNoteText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any)?.isComposing) {
                e.preventDefault();
                void handleAddNote();
              }
            }}
            placeholder={
              activeTarget === 'memory'
                ? 'A convention, a decision and why…'
                : 'How you like work, a name, a constraint…'
            }
          />
          {newNoteText.trim().length > 0 && (
            <button
              type="button"
              className="agent-memory__send"
              aria-label="Add"
              disabled={isLocked}
              onClick={() => void handleAddNote()}
            >
              <ArrowUpIcon size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export { AgentMemoryTab as AgentMemoryPane };
export default AgentMemoryTab;
