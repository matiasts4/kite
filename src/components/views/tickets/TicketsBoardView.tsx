import React, { useState, useRef } from 'react';
import { TicketIssue, TicketState, TaskExecutionRun, COLUMNS } from './types';
import { TicketCard, StateGlyph } from './TicketCard';
import { PlusGlyph } from '../../dockIcons';

export interface TicketsBoardViewProps {
  filteredIssues: TicketIssue[];
  runsMap: Map<string, TaskExecutionRun>;
  searchQuery: string;
  onSelectIssue: (issueId: string) => void;
  onMoveIssue: (id: string, newState: TicketState) => void;
  onNewTaskInColumn: (col: TicketState) => void;
  onContextMenu: (e: React.MouseEvent, issue: TicketIssue) => void;
}

export const TicketsBoardView: React.FC<TicketsBoardViewProps> = ({
  filteredIssues,
  runsMap,
  searchQuery,
  onSelectIssue,
  onMoveIssue,
  onNewTaskInColumn,
  onContextMenu,
}) => {
  const [dragTargetStatus, setDragTargetStatus] = useState<TicketState | null>(null);
  const [draggedIssueId, setDraggedIssueId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const totalCount = filteredIssues.length;

  const scrollToColumn = (status: TicketState) => {
    if (!scrollerRef.current) return;
    const colEl = scrollerRef.current.querySelector(
      `.ticket-board__column[data-board-status="${status}"]`
    ) as HTMLElement | null;
    if (colEl) {
      scrollerRef.current.scrollTo({
        left: colEl.offsetLeft - scrollerRef.current.offsetLeft,
        behavior: 'smooth',
      });
    }
  };

  return (
    <div
      className="ticket-board"
      data-dragging={draggedIssueId ? 'true' : undefined}
    >
      {/* Status Filter Strip */}
      <div className="ticket-board__strip">
        {COLUMNS.map((col) => {
          const count = filteredIssues.filter((i) => i.state === col).length;
          const isArmed = dragTargetStatus === col;

          return (
            <button
              key={col}
              type="button"
              className="ticket-board__chip"
              data-board-status={col}
              data-armed={isArmed ? 'true' : undefined}
              onClick={() => scrollToColumn(col)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragTargetStatus(col);
              }}
              onDragLeave={() => {
                if (dragTargetStatus === col) setDragTargetStatus(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain') || draggedIssueId;
                if (id) {
                  onMoveIssue(id, col);
                }
                setDragTargetStatus(null);
                setDraggedIssueId(null);
              }}
              title={`Show ${col}`}
              aria-label={`${col}, ${count}`}
            >
              <StateGlyph state={col} size={13} />
              <span className="ticket-board__chip-name">{col}</span>
              <span className="ticket-board__chip-count">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Hint message when empty */}
      {totalCount === 0 && (
        <p className="ticket-board__hint">
          {searchQuery.trim().length > 0
            ? 'No matching tasks. Clear search to see every task.'
            : 'Create a task here or ask Kite by voice.'}
        </p>
      )}

      {/* Scroller Columns */}
      <div className="ticket-board__scroller" ref={scrollerRef}>
        {COLUMNS.map((col) => {
          const colIssues = filteredIssues.filter((i) => i.state === col);
          const isArmed = dragTargetStatus === col;

          return (
            <section
              key={col}
              aria-label={col}
              className="ticket-board__column"
              data-board-status={col}
              data-armed={isArmed ? 'true' : undefined}
              onDragOver={(e) => {
                e.preventDefault();
                setDragTargetStatus(col);
              }}
              onDragLeave={() => {
                if (dragTargetStatus === col) setDragTargetStatus(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain') || draggedIssueId;
                if (id) {
                  onMoveIssue(id, col);
                }
                setDragTargetStatus(null);
                setDraggedIssueId(null);
              }}
            >
              <header className="ticket-board__column-header">
                <StateGlyph state={col} size={13} />
                <span className="ticket-board__column-name">{col}</span>
                <span className="ticket-board__column-count">{colIssues.length}</span>
                <button
                  type="button"
                  className="chrome-button ticket-board__add"
                  onClick={() => onNewTaskInColumn(col)}
                  title={`New task in ${col}`}
                  aria-label={`New task in ${col}`}
                >
                  <PlusGlyph size={13} />
                </button>
              </header>

              {colIssues.length > 0 ? (
                <ul className="ticket-board__cards">
                  {colIssues.map((issue) => (
                    <li key={issue.id}>
                      <TicketCard
                        issue={issue}
                        run={
                          runsMap.get(issue.id) || runsMap.get(issue.uuid) || null
                        }
                        onSelect={() => onSelectIssue(issue.id)}
                        onContextMenu={(e) => onContextMenu(e, issue)}
                        onDragStart={() => setDraggedIssueId(issue.id)}
                        carried={draggedIssueId === issue.id}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ticket-board__empty">
                  {isArmed ? 'Drop here' : 'No tasks'}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
};
