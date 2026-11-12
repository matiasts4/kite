import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SelectMenu } from '../../ui/SelectMenu';
import {
  ChevronRightGlyph,
  SearchGlyph,
  MoreHorizontalGlyph,
  PlusGlyph,
  CloseGlyph,
  ListGlyph,
  KanbanGlyph,
} from '../../dockIcons';
import {
  ArchiveGlyph,
  TagGlyph,
  PlugGlyph,
  RotateCcwClockGlyph,
  ListFilterGlyph,
} from './ticketIcons';
import { StateGlyph } from './TicketCard';
import { TicketIssue, TicketState, COLUMNS } from './types';

export interface TicketsHeaderBarProps {
  activeView: 'board' | 'list';
  hasSelectedIssue: boolean;
  statusFilter: 'all' | TicketState;
  filteredIssues: TicketIssue[];
  onSelectStatusFilter: (status: 'all' | TicketState) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  showArchived: boolean;
  onToggleShowArchived: () => void;
  onViewChange: (mode: 'board' | 'list') => void;
  onOpenMetadata: () => void;
  onOpenMcp: () => void;
  onRestoreBackup: () => void;
  onNewTask: () => void;
}

export const TicketsHeaderBar: React.FC<TicketsHeaderBarProps> = ({
  activeView,
  hasSelectedIssue,
  statusFilter,
  filteredIssues,
  onSelectStatusFilter,
  searchQuery,
  onSearchQueryChange,
  showArchived,
  onToggleShowArchived,
  onViewChange,
  onOpenMetadata,
  onOpenMcp,
  onRestoreBackup,
  onNewTask,
}) => {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close more menu on Escape
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleDown);
    return () => window.removeEventListener('keydown', handleDown);
  }, [isMenuOpen]);

  const statusFilterRows = useMemo(() => {
    const allCount = filteredIssues.length;
    return [
      {
        id: 'all',
        title: 'All statuses',
        badge: String(allCount),
      },
      ...COLUMNS.map((col, idx) => ({
        id: col,
        title: col,
        badge: String(filteredIssues.filter((i) => i.state === col).length),
        icon: <StateGlyph state={col} />,
        ruleBefore: idx === 0,
      })),
    ];
  }, [filteredIssues]);

  return (
    <header className="tickets-header">
      <nav aria-label="Breadcrumb" className="tickets-crumb">
        <span className="tickets-crumb__root">Kite</span>
        <ChevronRightGlyph className="tickets-crumb__chevron" size={12} strokeWidth={2} />
        <span className="tickets-crumb__current">Tasks</span>
      </nav>

      {activeView === 'list' && !hasSelectedIssue ? (
        <div className="tickets-status">
          <SelectMenu
            help="Filter tasks by status"
            label="Status filter"
            panelDetail="Filter tasks by workflow status"
            panelTitle="Status"
            rows={statusFilterRows}
            triggerIcon={
              statusFilter === 'all' ? (
                <ListFilterGlyph size={13} />
              ) : (
                <StateGlyph state={statusFilter} />
              )
            }
            triggerBadge={
              statusFilter === 'all'
                ? String(filteredIssues.length)
                : String(filteredIssues.filter((i) => i.state === statusFilter).length)
            }
            triggerLabel={`Status: ${
              statusFilter === 'all' ? 'All statuses' : statusFilter
            }`}
            value={statusFilter}
            variant="toolbar"
            onSelect={(id) =>
              onSelectStatusFilter(
                COLUMNS.includes(id as TicketState) ? (id as TicketState) : 'all'
              )
            }
          />
        </div>
      ) : null}

      <div className="tickets-header__trailing">
        {/* Search Toggle / Field */}
        {isSearchOpen ? (
          <span className="tickets-search">
            <SearchGlyph size={13} strokeWidth={1.8} />
            <input
              ref={searchInputRef}
              aria-label="Search tasks"
              placeholder="Search tasks"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  onSearchQueryChange('');
                  setIsSearchOpen(false);
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="chrome-button"
              onClick={() => {
                onSearchQueryChange('');
                setIsSearchOpen(false);
              }}
              title="Close search"
              aria-label="Close search"
            >
              <CloseGlyph size={12} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="chrome-button"
            onClick={() => setIsSearchOpen(true)}
            title="Search tasks"
            aria-label="Search"
          >
            <SearchGlyph size={14} />
          </button>
        )}

        {/* More Menu (...) */}
        <button
          ref={menuButtonRef}
          type="button"
          className={`chrome-button${isMenuOpen ? ' chrome-button--selected' : ''}`}
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          onClick={() => setIsMenuOpen((v) => !v)}
          title="More"
          aria-label="More"
        >
          <MoreHorizontalGlyph size={14} />
        </button>

        {isMenuOpen &&
          typeof document !== 'undefined' &&
          createPortal(
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 59 }}
                onClick={() => setIsMenuOpen(false)}
              />
              <div
                role="menu"
                aria-label="More"
                className="ui-menu scroll-quiet"
                style={(() => {
                  const rect = menuButtonRef.current?.getBoundingClientRect();
                  return {
                    left: rect ? `${Math.max(8, rect.right - 200)}px` : '0px',
                    top: rect ? `${rect.bottom + 4}px` : '0px',
                    '--menu-origin': 'top right',
                  } as React.CSSProperties;
                })()}
              >
                {/* Section 1: View & Archive */}
                <div
                  role="menuitem"
                  tabIndex={-1}
                  className="ui-menu__row"
                  onClick={() => {
                    onViewChange(activeView === 'board' ? 'list' : 'board');
                    setIsMenuOpen(false);
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    {activeView === 'board' ? (
                      <ListGlyph size={14} />
                    ) : (
                      <KanbanGlyph size={14} />
                    )}
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">
                      {activeView === 'board' ? 'View as list' : 'View as board'}
                    </span>
                  </span>
                </div>

                <div
                  role="menuitem"
                  tabIndex={-1}
                  className="ui-menu__row"
                  onClick={() => {
                    onToggleShowArchived();
                    setIsMenuOpen(false);
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <ArchiveGlyph size={14} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">
                      {showArchived ? 'Hide archived' : 'Show archived'}
                    </span>
                  </span>
                </div>

                <div aria-hidden="true" className="ui-menu__rule" />

                {/* Section 2: Metadata & Connect MCP */}
                <div
                  role="menuitem"
                  tabIndex={-1}
                  className="ui-menu__row"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onOpenMetadata();
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <TagGlyph size={14} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Labels & projects…</span>
                  </span>
                </div>

                <div
                  role="menuitem"
                  tabIndex={-1}
                  className="ui-menu__row"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onOpenMcp();
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <PlugGlyph size={14} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Connect MCP…</span>
                  </span>
                </div>

                <div aria-hidden="true" className="ui-menu__rule" />

                {/* Section 3: Restore backup */}
                <div
                  role="menuitem"
                  tabIndex={-1}
                  className="ui-menu__row"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onRestoreBackup();
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <RotateCcwClockGlyph size={14} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Restore backup…</span>
                  </span>
                </div>
              </div>
            </>,
            document.querySelector('.app-frame--scaled') ?? document.body
          )}

        {/* New Task Button */}
        <button
          type="button"
          className="primary-button action-button--row tickets-new"
          onClick={onNewTask}
        >
          <span className="action-button__icon">
            <PlusGlyph size={14} />
          </span>
          <span>New task</span>
        </button>
      </div>
    </header>
  );
};
