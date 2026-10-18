import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { listPrompts, saveShellState, PromptItem as IpcPromptItem } from '../../lib/ipc';
import { Sheet } from '../ui/Sheet';

export interface PromptItem {
  id: string;
  title: string;
  content: string;
  category?: string;
  createdAtUnixMs?: number;
}

const MAX_PROMPT_TITLE_LENGTH = 120;
const MAX_PROMPT_CONTENT_LENGTH = 4000;
const STORAGE_PROMPTS_KEY = 'kite_user_prompts';

export const PRESET_CATEGORIES = ['All', 'Code', 'Review', 'Agent', 'Refactor', 'Docs'] as const;

// Curated starter prompts when user library is initialized
const DEFAULT_STARTER_PROMPTS: PromptItem[] = [
  {
    id: 'starter-review-diff',
    title: 'Review diff on current branch',
    category: 'Review',
    content:
      'Review the diff on this branch with a focus on correctness, API contracts, potential regressions, edge cases, and test coverage. Highlight any breaking changes.',
    createdAtUnixMs: Date.now() - 3600000,
  },
  {
    id: 'starter-unit-tests',
    title: 'Write comprehensive unit tests',
    category: 'Code',
    content:
      'Write exhaustive unit and integration tests for this component/module covering happy paths, boundary conditions, error handling, and asynchronous states.',
    createdAtUnixMs: Date.now() - 7200000,
  },
  {
    id: 'starter-explain-arch',
    title: 'Explain architecture & call paths',
    category: 'Docs',
    content:
      'Trace and explain the architecture of this feature: list key modules, state stores, call paths, data flow, and external system boundaries.',
    createdAtUnixMs: Date.now() - 10800000,
  },
  {
    id: 'starter-refactor-clean',
    title: 'Refactor for performance & clarity',
    category: 'Refactor',
    content:
      'Refactor this code to improve maintainability, reduce cognitive complexity, and eliminate duplicate logic while preserving 100% backward compatibility and passing all tests.',
    createdAtUnixMs: Date.now() - 14400000,
  },
  {
    id: 'starter-autonomous-agent',
    title: 'Autonomous agent task brief',
    category: 'Agent',
    content:
      'You are assigned as an autonomous agent to execute this task end-to-end: investigate requirements, check existing patterns, implement minimal clean changes, and verify with tests.',
    createdAtUnixMs: Date.now() - 18000000,
  },
];

// Scoped class dictionary matching bundle SidePromptsPanel-B-qtzvzj.js & src/chunks.css
const k = {
  panel: '_panel_v2cfp_11',
  toolbar: '_toolbar_v2cfp_33',
  search: '_search_v2cfp_51',
  feedback: '_feedback_v2cfp_69',
  notice: '_notice_v2cfp_71',
  error: '_error_v2cfp_95',
  list: '_list_v2cfp_133',
  row: '_row_v2cfp_157',
  open: '_open_v2cfp_199',
  title: '_title_v2cfp_241',
  preview: '_preview_v2cfp_261',
  actions: '_actions_v2cfp_289',
  iconButton: '_iconButton_v2cfp_317',
  hint: '_hint_v2cfp_365',
  dragChip: '_dragChip_v2cfp_389',
  dragChipLabel: '_dragChipLabel_v2cfp_451',
  editor: '_editor_v2cfp_475',
  editorHeader: '_editorHeader_v2cfp_493',
  heading: '_heading_v2cfp_509',
  field: '_field_v2cfp_523',
  fieldGrow: '_fieldGrow_v2cfp_537',
  label: '_label_v2cfp_545',
  contentField: '_contentField_v2cfp_559',
  count: '_count_v2cfp_571',
  editorFooter: '_editorFooter_v2cfp_597',
  spacer: '_spacer_v2cfp_611',
};

// Zero-Lucide SVG Icons matching official Kite Code styling
const MessageSquareQuoteIcon: React.FC<{ size?: number; className?: string }> = ({ size = 20, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M14 14a2 2 0 0 0 2-2V8h-2" /><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /><path d="M8 14a2 2 0 0 0 2-2V8H8" />
  </svg>
);

const SearchIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.34-4.34" />
  </svg>
);

const PlusIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M5 12h14" /><path d="M12 5v14" />
  </svg>
);

const ChevronLeftIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const CopyIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

const CornerDownLeftIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M20 4v7a4 4 0 0 1-4 4H4" /><path d="m9 10-5 5 5 5" />
  </svg>
);

const TrashIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const CheckIcon: React.FC<{ size?: number; className?: string }> = ({ size = 13, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const CloseIcon: React.FC<{ size?: number; className?: string }> = ({ size = 12, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
  </svg>
);

export const PromptsView: React.FC = () => {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<PromptItem | null>(null);
  const [dragPointer, setDragPointer] = useState<{ prompt: PromptItem; x: number; y: number } | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);

  // Load prompts from IPC or LocalStorage with starter fallbacks
  const loadPrompts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res: IpcPromptItem[] = await listPrompts().catch(() => []);
      let loaded: PromptItem[] = [];

      if (Array.isArray(res) && res.length > 0) {
        loaded = res.map((item, idx) => ({
          id: item.id || `prompt-${idx}`,
          title: item.title || 'Untitled prompt',
          content: item.content || item.prompt || '',
          category: item.category || 'Code',
          createdAtUnixMs: item.createdAtUnixMs,
        }));
      } else {
        try {
          const saved = localStorage.getItem(STORAGE_PROMPTS_KEY);
          if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0) {
              loaded = parsed;
            }
          }
        } catch (_) {}

        if (loaded.length === 0) {
          loaded = DEFAULT_STARTER_PROMPTS;
          try {
            localStorage.setItem(STORAGE_PROMPTS_KEY, JSON.stringify(loaded));
          } catch (_) {}
        }
      }

      setPrompts(loaded);
    } catch (err) {
      console.warn('Failed to load prompts:', err);
      setPrompts(DEFAULT_STARTER_PROMPTS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  useEffect(() => {
    if (editingPrompt || isCreating) {
      titleInputRef.current?.focus();
    }
  }, [editingPrompt, isCreating]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 3500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const persistPrompts = (items: PromptItem[]) => {
    try {
      localStorage.setItem(STORAGE_PROMPTS_KEY, JSON.stringify(items));
    } catch (_) {}
    saveShellState({ userPrompts: items }).catch(() => {});
  };

  const handleCopyPrompt = async (item: PromptItem) => {
    try {
      await navigator.clipboard.writeText(item.content);
      setFeedback('Copied.');
    } catch {
      setFeedback('The clipboard is unavailable. Open the prompt and copy its text.');
    }
  };

  const handleInsertPrompt = async (item: PromptItem) => {
    let inserted = false;
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl instanceof HTMLTextAreaElement ||
        (activeEl instanceof HTMLInputElement && activeEl.type === 'text'))
    ) {
      const start = activeEl.selectionStart ?? activeEl.value.length;
      const end = activeEl.selectionEnd ?? activeEl.value.length;
      const before = activeEl.value.substring(0, start);
      const after = activeEl.value.substring(end);
      const prefix = before.length > 0 && !before.endsWith('\n') && !before.endsWith(' ') ? '\n' : '';
      const textToInsert = `${prefix}${item.content}`;
      activeEl.value = `${before}${textToInsert}${after}`;
      activeEl.selectionStart = activeEl.selectionEnd = start + textToInsert.length;
      activeEl.dispatchEvent(new Event('input', { bubbles: true }));
      activeEl.focus();
      inserted = true;
    }

    window.dispatchEvent(
      new CustomEvent('kite:insert-prompt', {
        detail: { text: item.content, prompt: item },
      })
    );

    try {
      await navigator.clipboard.writeText(item.content);
    } catch (_) {}

    setFeedback(inserted ? 'Inserted into active input.' : 'Copied. Paste into any agent input.');
  };

  const handleSavePrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPrompt) return;

    const title = editingPrompt.title.trim();
    const content = editingPrompt.content.trim();
    const category = editingPrompt.category?.trim() || 'Code';

    if (
      !title ||
      !content ||
      title.length > MAX_PROMPT_TITLE_LENGTH ||
      content.length > MAX_PROMPT_CONTENT_LENGTH
    ) {
      return;
    }

    try {
      let updated: PromptItem[];
      if (isCreating) {
        const newPrompt: PromptItem = {
          id: `p-${Date.now()}`,
          title,
          content,
          category,
          createdAtUnixMs: Date.now(),
        };
        updated = [newPrompt, ...prompts];
        setFeedback('Prompt saved.');
      } else {
        updated = prompts.map((p) =>
          p.id === editingPrompt.id ? { ...p, title, content, category } : p
        );
        setFeedback('Prompt updated.');
      }
      setPrompts(updated);
      persistPrompts(updated);
      setEditingPrompt(null);
      setIsCreating(false);
    } catch (err) {
      console.error(err);
      setError('Could not save prompt.');
    }
  };

  const handleDeletePrompt = (id: string) => {
    const updated = prompts.filter((p) => p.id !== id);
    setPrompts(updated);
    persistPrompts(updated);
    if (editingPrompt?.id === id) {
      setEditingPrompt(null);
      setIsCreating(false);
    }
    setFeedback('Prompt deleted.');
  };

  const availableCategories = useMemo(() => {
    const set = new Set<string>(PRESET_CATEGORIES);
    for (const p of prompts) {
      if (p.category) set.add(p.category);
    }
    return Array.from(set);
  }, [prompts]);

  const filteredPrompts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return prompts.filter((p) => {
      if (selectedCategory !== 'All' && p.category !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      const corpus = `${p.title}\n${p.content}\n${p.category || ''}`.toLowerCase();
      return corpus.includes(q);
    });
  }, [prompts, searchQuery, selectedCategory]);

  const handlePointerDownRow = (e: React.PointerEvent, item: PromptItem) => {
    if ((e.target as HTMLElement).closest('[data-no-drag="true"]')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;

    const onPointerMove = (moveEv: PointerEvent) => {
      const dist = Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY);
      if (dist > 6) {
        isDragging = true;
        setDragPointer({ prompt: item, x: moveEv.clientX, y: moveEv.clientY });
      }
    };

    const onPointerUp = (upEv: PointerEvent) => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (isDragging) {
        setDragPointer(null);
        const target = document.elementFromPoint(upEv.clientX, upEv.clientY);
        if (target) {
          const input = target.closest('textarea, input[type="text"]') as
            | HTMLTextAreaElement
            | HTMLInputElement
            | null;
          if (input) {
            input.value = `${input.value}${input.value ? '\n' : ''}${item.content}`;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            setFeedback('Prompt dropped into input.');
          }
        }
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // Form View: Create / Edit Prompt Drawer
  if (editingPrompt !== null || isCreating) {
    const titleVal = editingPrompt?.title || '';
    const contentVal = editingPrompt?.content || '';
    const categoryVal = editingPrompt?.category || 'Code';
    const titleOver = titleVal.trim().length > MAX_PROMPT_TITLE_LENGTH;
    const contentOver = contentVal.length > MAX_PROMPT_CONTENT_LENGTH;
    const isValid =
      titleVal.trim().length > 0 &&
      contentVal.trim().length > 0 &&
      !titleOver &&
      !contentOver;

    return (
      <section aria-label="Prompts" className={k.panel}>
        <form onSubmit={handleSavePrompt} className={k.editor}>
          <header className={k.editorHeader}>
            <button
              type="button"
              onClick={() => {
                setEditingPrompt(null);
                setIsCreating(false);
              }}
              className={k.iconButton}
              title="Back to prompts"
              aria-label="Back to prompts"
            >
              <ChevronLeftIcon size={14} />
            </button>
            <h2 className={k.heading}>{isCreating ? 'New prompt' : 'Edit prompt'}</h2>
          </header>

          {error && (
            <div className={k.error} role="alert">
              <p>{error}</p>
            </div>
          )}

          <label className={k.field} htmlFor="prompt-name">
            <span className={k.label}>Name</span>
            <input
              id="prompt-name"
              ref={titleInputRef}
              type="text"
              maxLength={MAX_PROMPT_TITLE_LENGTH + 20}
              value={titleVal}
              onChange={(e) =>
                setEditingPrompt((prev) => ({
                  id: prev?.id || `p-${Date.now()}`,
                  title: e.target.value,
                  content: prev?.content || '',
                  category: prev?.category || categoryVal,
                }))
              }
              placeholder="e.g. Review the diff on this branch"
              className="ui-field"
              style={{ borderColor: titleOver ? 'var(--status-failed)' : undefined }}
            />
          </label>

          <div className={k.field}>
            <span className={k.label}>Category</span>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }}>
              {PRESET_CATEGORIES.filter((c) => c !== 'All').map((cat) => {
                const isSelected = categoryVal === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() =>
                      setEditingPrompt((prev) => ({
                        id: prev?.id || `p-${Date.now()}`,
                        title: prev?.title || '',
                        content: prev?.content || '',
                        category: cat,
                      }))
                    }
                    className="agent-dashboard__chip"
                    aria-pressed={isSelected}
                    style={{
                      height: '24px',
                      padding: '0 8px',
                      fontSize: '11px',
                      borderRadius: 'var(--radius-pill, 9999px)',
                      background: isSelected
                        ? 'var(--selected-fill, rgba(255,255,255,0.12))'
                        : 'var(--chip-fill, rgba(255,255,255,0.06))',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                      border: isSelected
                        ? '1px solid var(--panel-stroke, rgba(255,255,255,0.2))'
                        : '1px solid var(--block-stroke, rgba(255,255,255,0.08))',
                      cursor: 'pointer',
                    }}
                  >
                    <span>{cat}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className={`${k.field} ${k.fieldGrow}`} htmlFor="prompt-content">
            <span className={k.label}>Prompt instructions</span>
            <textarea
              id="prompt-content"
              rows={10}
              value={contentVal}
              onChange={(e) =>
                setEditingPrompt((prev) => ({
                  id: prev?.id || `p-${Date.now()}`,
                  title: prev?.title || '',
                  content: e.target.value,
                  category: prev?.category || categoryVal,
                }))
              }
              placeholder="Enter the instructions you give agents most frequently..."
              className={`ui-field ui-field--area ${k.contentField}`}
              style={{ borderColor: contentOver ? 'var(--status-failed)' : undefined }}
            />
          </label>

          <p className={k.count} data-over={contentOver || undefined}>
            {contentVal.length.toLocaleString()} / {MAX_PROMPT_CONTENT_LENGTH.toLocaleString()}
          </p>

          <footer className={k.editorFooter}>
            {!isCreating && editingPrompt?.id ? (
              <button
                type="button"
                onClick={() => setConfirmingDelete(editingPrompt)}
                className="ghost-button"
              >
                Delete
              </button>
            ) : null}

            <span className={k.spacer} />

            <button
              type="button"
              onClick={() => {
                setEditingPrompt(null);
                setIsCreating(false);
              }}
              className="secondary-button"
            >
              Cancel
            </button>
            <button type="submit" disabled={!isValid} className="primary-button">
              Save prompt
            </button>
          </footer>
        </form>

        <Sheet
          open={Boolean(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
          title="Delete this prompt?"
          description={
            <span>
              <strong>{confirmingDelete?.title.trim() || 'This prompt'}</strong> leaves your prompts. This can’t be undone.
            </span>
          }
          primary={{
            label: 'Delete prompt',
            variant: 'danger',
            onClick: () => {
              if (confirmingDelete) handleDeletePrompt(confirmingDelete.id);
              setConfirmingDelete(null);
            },
          }}
          secondary={{
            label: 'Cancel',
            onClick: () => setConfirmingDelete(null),
          }}
        />
      </section>
    );
  }

  // Main Prompts View (List / Search / Filters / Cards)
  return (
    <section aria-label="Prompts" className={k.panel}>
      <div className={k.toolbar}>
        <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
          <span style={{ position: 'absolute', left: '10px', color: 'var(--text-secondary)', pointerEvents: 'none', display: 'inline-flex' }}>
            <SearchIcon size={13} />
          </span>
          <input
            type="search"
            aria-label="Search prompts"
            disabled={prompts.length === 0}
            maxLength={200}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search prompts"
            className={`${k.search} ui-field`}
            style={{ paddingLeft: '32px', paddingRight: '28px', width: '100%' }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: '8px',
                color: 'var(--text-secondary)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              aria-label="Clear search"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setEditingPrompt({ id: '', title: '', content: '', category: 'Code' });
            setIsCreating(true);
          }}
          className="primary-button"
        >
          <PlusIcon size={12} />
          <span>New prompt</span>
        </button>
      </div>

      {/* Category / Tag Filter Chips */}
      {prompts.length > 0 && (
        <div
          role="toolbar"
          aria-label="Filter prompts by category"
          style={{
            display: 'flex',
            gap: '6px',
            padding: '4px 12px 8px',
            overflowX: 'auto',
            scrollbarWidth: 'none',
            flexShrink: 0,
          }}
        >
          {availableCategories.map((cat) => {
            const count =
              cat === 'All'
                ? prompts.length
                : prompts.filter((p) => p.category === cat).length;
            const isSelected = selectedCategory === cat;

            return (
              <button
                key={cat}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedCategory(cat)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  height: '24px',
                  padding: '0 9px',
                  fontSize: '11px',
                  fontWeight: 500,
                  borderRadius: 'var(--radius-pill, 9999px)',
                  background: isSelected
                    ? 'var(--selected-fill, rgba(255,255,255,0.12))'
                    : 'var(--chip-fill, rgba(255,255,255,0.05))',
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: isSelected
                    ? '1px solid var(--panel-stroke, rgba(255,255,255,0.22))'
                    : '1px solid var(--block-stroke, rgba(255,255,255,0.06))',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  transition: 'background-color 0.15s ease, color 0.15s ease',
                }}
              >
                <span>{cat}</span>
                <span
                  style={{
                    fontSize: '10px',
                    opacity: isSelected ? 1 : 0.65,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {feedback && (
        <p className={k.feedback} role="status">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
              <CheckIcon size={12} />
            </span>
            <span>{feedback}</span>
          </span>
        </p>
      )}

      {/* Content Area: Prompts List or Empty States */}
      <div style={{ flex: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {loading ? (
          <p className={k.notice} role="status">
            Loading prompts…
          </p>
        ) : prompts.length === 0 ? (
          <section className="empty-surface empty-surface--embedded">
            <span aria-hidden="true" className="empty-surface__icon">
              <MessageSquareQuoteIcon size={34} />
            </span>
            <div className="empty-surface__copy">
              <h1>No prompts yet</h1>
              <p>
                Save the instructions you give agents most. Drag one onto a coding agent, a thread or an agent chat.
              </p>
            </div>
            <div className="empty-surface__action">
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setEditingPrompt({ id: '', title: '', content: '', category: 'Code' });
                  setIsCreating(true);
                }}
              >
                New prompt
              </button>
            </div>
          </section>
        ) : filteredPrompts.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <p className={k.notice} role="status" style={{ marginBottom: '12px' }}>
              No prompts match &ldquo;{searchQuery.trim() || selectedCategory}&rdquo;.
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setSearchQuery('');
                setSelectedCategory('All');
              }}
            >
              Reset filters
            </button>
          </div>
        ) : (
          <ul aria-label="Saved prompts" className={k.list}>
            {filteredPrompts.map((p) => (
              <li
                key={p.id}
                className={k.row}
                draggable
                onPointerDown={(e) => handlePointerDownRow(e, p)}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', p.content);
                  e.dataTransfer.setData('application/json', JSON.stringify(p));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <button
                  type="button"
                  className={k.open}
                  onClick={() => {
                    setEditingPrompt(p);
                    setIsCreating(false);
                  }}
                  title="Open, or drag onto an agent to insert"
                  aria-label={p.title}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                    <span className={k.title}>{p.title}</span>
                    {p.category && p.category !== 'All' && (
                      <span
                        style={{
                          fontSize: '10px',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          background: 'var(--chip-fill, rgba(255,255,255,0.06))',
                          color: 'var(--text-secondary)',
                          flexShrink: 0,
                        }}
                      >
                        {p.category}
                      </span>
                    )}
                  </div>
                  <span className={k.preview}>{p.content}</span>
                </button>

                <div className={k.actions} data-no-drag="true">
                  <button
                    type="button"
                    onClick={() => void handleInsertPrompt(p)}
                    className={k.iconButton}
                    title="Insert where you last typed"
                    aria-label={`Insert ${p.title} where you last typed`}
                  >
                    <CornerDownLeftIcon size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyPrompt(p)}
                    className={k.iconButton}
                    title="Copy"
                    aria-label={`Copy ${p.title}`}
                  >
                    <CopyIcon size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(p)}
                    className={k.iconButton}
                    title="Delete"
                    aria-label={`Delete ${p.title}`}
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {prompts.length > 0 && (
        <p className={k.hint}>
          Drag a prompt onto an agent to insert it. Nothing sends until you press Enter.
        </p>
      )}

      {/* Floating Drag Portal Chip */}
      {dragPointer &&
        createPortal(
          <div
            aria-hidden="true"
            className={k.dragChip}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              pointerEvents: 'none',
              zIndex: 10000,
              transform: `translate3d(${dragPointer.x + 14}px, ${dragPointer.y + 12}px, 0)`,
            }}
          >
            <MessageSquareQuoteIcon size={14} />
            <span className={k.dragChipLabel}>{dragPointer.prompt.title}</span>
          </div>,
          document.body
        )}

      <Sheet
        open={Boolean(confirmingDelete)}
        onCancel={() => setConfirmingDelete(null)}
        title="Delete this prompt?"
        description={
          <span>
            <strong>{confirmingDelete?.title.trim() || 'This prompt'}</strong> leaves your prompts. This can’t be undone.
          </span>
        }
        primary={{
          label: 'Delete prompt',
          variant: 'danger',
          onClick: () => {
            if (confirmingDelete) handleDeletePrompt(confirmingDelete.id);
            setConfirmingDelete(null);
          },
        }}
        secondary={{
          label: 'Cancel',
          onClick: () => setConfirmingDelete(null),
        }}
      />
    </section>
  );
};
