import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SubagentRun } from '../../../types';
import { AgentStatusIndicator } from '../../ui/AgentStatusIndicator';
import { SubagentRoleIcon } from '../../ui/SubagentRoleIcon';
import { formatInspectorModelName } from './swarmBoardHelpers';
import {
  cleanRunPreviewText,
  formatSubagentDisplayTitle,
  isRunActive,
  isRunBlocked,
  settledPrefixLabel,
} from './subagentInspectorHelpers';

export interface SubagentRunSwitcherProps {
  runs: SubagentRun[];
  activeRun: SubagentRun;
  onSelectRun: (subagentId: string) => void;
}

const ChevronDownGlyph: React.FC<{ open: boolean }> = ({ open }) => (
  <svg
    width={11}
    height={11}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{
      transform: open ? 'rotate(180deg)' : 'none',
      transition: 'transform 140ms ease',
      flex: 'none',
    }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

/**
 * Option A compact dropdown switcher for multi-subagent threads. Keeps the
 * RightDock header at a fixed height regardless of how many subagents ran.
 */
export const SubagentRunSwitcher: React.FC<SubagentRunSwitcherProps> = ({
  runs,
  activeRun,
  onSelectRun,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 300,
  });

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const activeIndex = useMemo(() => {
    const idx = runs.findIndex((r) => r.subagentId === activeRun.subagentId);
    return idx >= 0 ? idx : 0;
  }, [runs, activeRun.subagentId]);

  const activeTitle = formatSubagentDisplayTitle(activeRun);
  const showSearch = runs.length >= 6;

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((run) => {
      const title = formatSubagentDisplayTitle(run).toLowerCase();
      const preview = cleanRunPreviewText(run).toLowerCase();
      const model = formatInspectorModelName(run.model, run.provider).toLowerCase();
      return title.includes(q) || preview.includes(q) || model.includes(q);
    });
  }, [runs, query]);

  const updatePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxWidth = Math.min(360, Math.max(240, window.innerWidth - 24));
    const width = Math.max(Math.min(Math.max(rect.width + 64, 280), maxWidth), 240);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const top = spaceBelow >= 180 ? rect.bottom + 4 : Math.max(12, rect.top - Math.min(320, spaceBelow + 240));
    setCoords({ top, left, width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    if (showSearch) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, showSearch]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => updatePosition();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const popover = open ? (
    <div
      ref={popoverRef}
      id={listboxId}
      role="listbox"
      aria-label="Subagent runs"
      className="subagent-switcher__popover"
      data-testid="subagent-switcher-popover"
      style={{
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        width: `${coords.width}px`,
      }}
    >
      {showSearch && (
        <div className="subagent-switcher__search-wrap">
          <input
            ref={searchRef}
            type="text"
            className="subagent-switcher__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter subagents…"
            aria-label="Filter subagents"
          />
        </div>
      )}
      <div className="subagent-switcher__list">
        {filteredRuns.length === 0 ? (
          <div className="subagent-switcher__empty">No matching subagents</div>
        ) : (
          filteredRuns.map((run) => {
            const selected = run.subagentId === activeRun.subagentId;
            const title = formatSubagentDisplayTitle(run);
            const preview = cleanRunPreviewText(run);
            const shortModel = formatInspectorModelName(run.model, run.provider);
            const blocked = isRunBlocked(run.status);
            const active = !blocked && isRunActive(run.status);
            const statusText = blocked
              ? 'Waiting'
              : active
                ? 'Working'
                : settledPrefixLabel(run.status);

            return (
              <button
                key={run.subagentId}
                type="button"
                role="option"
                aria-selected={selected}
                className={`subagent-switcher__option${selected ? ' subagent-switcher__option--active' : ''}`}
                onClick={() => {
                  onSelectRun(run.subagentId);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <span className="subagent-switcher__option-icon">
                  <SubagentRoleIcon
                    typeName={run.typeName}
                    role={run.role}
                    status={run.status}
                    size={13}
                  />
                </span>
                <span className="subagent-switcher__option-body">
                  <span className="subagent-switcher__option-top">
                    <span className="subagent-switcher__option-title">{title}</span>
                    <span className="subagent-switcher__option-meta">
                      <AgentStatusIndicator
                        status={run.status}
                        size={11}
                        aria-label={statusText}
                      />
                      <span className="subagent-badge">{shortModel}</span>
                    </span>
                  </span>
                  {preview && preview.toLowerCase() !== title.toLowerCase() && (
                    <span className="subagent-switcher__option-preview">{preview}</span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="subagent-switcher__trigger"
        data-testid="subagent-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`Switch subagent: ${activeTitle} (${activeIndex + 1} of ${runs.length})`}
        onClick={() => {
          setOpen((v) => !v);
          setQuery('');
        }}
      >
        <SubagentRoleIcon
          typeName={activeRun.typeName}
          role={activeRun.role}
          status={activeRun.status}
          size={15}
        />
        <span className="subagent-switcher__title">{activeTitle}</span>
        <span className="subagent-switcher__count">
          {activeIndex + 1}/{runs.length}
        </span>
        <ChevronDownGlyph open={open} />
      </button>
      {typeof document !== 'undefined' && popover ? createPortal(popover, document.body) : popover}
    </>
  );
};
