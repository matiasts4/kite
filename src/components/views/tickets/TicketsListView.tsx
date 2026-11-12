import React, { useState } from 'react';
import {
  TicketIssue,
  TicketProject,
  TicketState,
  COLUMNS,
  getLabelColor,
} from './types';
import { PriorityGlyph, StateGlyph, TicketAvatar } from './TicketCard';
import { ChevronRightGlyph, PlusGlyph } from '../../dockIcons';
import { ChevronDownMini } from './ticketIcons';

export interface TicketsListViewProps {
  filteredIssues: TicketIssue[];
  projects: TicketProject[];
  statusFilter: 'all' | TicketState;
  searchQuery: string;
  onSelectIssue: (issueId: string) => void;
  onNewTaskInColumn: (col: TicketState) => void;
  onContextMenu: (e: React.MouseEvent, issue: TicketIssue) => void;
}

export const TicketsListView: React.FC<TicketsListViewProps> = ({
  filteredIssues,
  projects,
  statusFilter,
  searchQuery,
  onSelectIssue,
  onNewTaskInColumn,
  onContextMenu,
}) => {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TicketState>>(() => new Set());

  const toggleGroupCollapse = (col: TicketState) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const matchingIssuesCount = filteredIssues.filter((i) =>
    statusFilter === 'all' ? true : i.state === statusFilter
  ).length;

  return (
    <div className="ticket-list">
      {matchingIssuesCount === 0 ? (
        <p
          className="ticket-board__hint"
          style={{ padding: '24px 16px', textAlign: 'center' }}
        >
          {searchQuery.trim().length > 0
            ? 'No matching tasks. Clear search or choose another status.'
            : statusFilter === 'all'
              ? 'Create a task here or ask Kite by voice.'
              : `No ${statusFilter} tasks. Choose another status or create a task.`}
        </p>
      ) : (
        COLUMNS.filter((col) =>
          statusFilter === 'all' ? true : col === statusFilter
        ).map((col) => {
          const colIssues = filteredIssues.filter((i) => i.state === col);
          if (colIssues.length === 0) return null;
          const isExpanded = !collapsedGroups.has(col);

          return (
            <section key={col} aria-label={col} className="ticket-group">
              <header className="ticket-group__header">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  className="ticket-group__toggle"
                  onClick={() => toggleGroupCollapse(col)}
                >
                  <span aria-hidden="true" className="ticket-group__chevron">
                    {isExpanded ? (
                      <ChevronDownMini size={10} />
                    ) : (
                      <ChevronRightGlyph size={10} strokeWidth={2.5} />
                    )}
                  </span>
                  <StateGlyph state={col} size={13} />
                  <span className="ticket-group__name">{col}</span>
                  <span className="ticket-group__count">{colIssues.length}</span>
                </button>
                <button
                  type="button"
                  className="chrome-button ticket-group__add"
                  onClick={() => onNewTaskInColumn(col)}
                  title={`New task in ${col}`}
                  aria-label={`New task in ${col}`}
                >
                  <PlusGlyph size={13} />
                </button>
              </header>

              {isExpanded ? (
                <ul className="ticket-group__rows">
                  {colIssues.map((issue) => {
                    const proj = projects.find((p) => p.id === issue.projectId);
                    return (
                      <li key={issue.id}>
                        <button
                          type="button"
                          className={`ticket-row${
                            issue.archivedAt || issue.state === 'Done'
                              ? ' ticket-row--archived'
                              : ''
                          }`}
                          onClick={() => onSelectIssue(issue.id)}
                          onContextMenu={(e) => onContextMenu(e, issue)}
                        >
                          <PriorityGlyph priority={issue.priority} />
                          <span className="ticket-row__id">{issue.id}</span>
                          <StateGlyph state={issue.state} />
                          <span className="ticket-row__title">{issue.title}</span>
                          <span className="ticket-row__spacer" />
                          <span className="ticket-row__tags">
                            {(issue.labels ?? []).slice(0, 3).map((lbl) => (
                              <span key={lbl} className="ticket-pill" title={lbl}>
                                <span
                                  aria-hidden="true"
                                  className="ticket-pill__dot"
                                  style={{ background: getLabelColor(lbl) }}
                                />
                                <span className="ticket-pill__name">{lbl}</span>
                              </span>
                            ))}
                            {(issue.labels ?? []).length > 3 ? (
                              <span className="ticket-pill ticket-pill--more">
                                +{(issue.labels ?? []).length - 3}
                              </span>
                            ) : null}
                            {proj ? (
                              <span
                                className="ticket-pill ticket-pill--project"
                                title={`Project · ${proj.name}`}
                              >
                                <span className="ticket-pill__name">{proj.name}</span>
                              </span>
                            ) : null}
                          </span>
                          <span className="ticket-row__people">
                            {issue.delegate ? (
                              <TicketAvatar
                                name={issue.delegate}
                                kind="Delegate"
                                size={18}
                              />
                            ) : null}
                            <TicketAvatar
                              name={issue.assignee}
                              kind="Assignee"
                              size={24}
                            />
                          </span>
                          {issue.dueDate && (
                            <time className="ticket-row__date">{issue.dueDate}</time>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          );
        })
      )}
    </div>
  );
};
