import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { TicketIssue, TicketState, COLUMNS } from './types';
import { StateGlyph } from './TicketCard';
import {
  ExternalOpenGlyph,
  SendGlyph,
  BotGlyph,
  ArchiveGlyph,
} from './ticketIcons';

export interface TicketContextMenuState {
  issue: TicketIssue;
  x: number;
  y: number;
}

export interface TicketContextMenuProps {
  contextMenu: TicketContextMenuState | null;
  onClose: () => void;
  onSelectIssue: (issueId: string) => void;
  onDispatch: (issue: TicketIssue) => void;
  onMoveIssue: (id: string, newState: TicketState) => void;
  onArchiveIssue: (issue: TicketIssue) => void;
}

export const TicketContextMenu: React.FC<TicketContextMenuProps> = ({
  contextMenu,
  onClose,
  onSelectIssue,
  onDispatch,
  onMoveIssue,
  onArchiveIssue,
}) => {
  useEffect(() => {
    if (!contextMenu) return;
    const handleDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleDown);
    return () => window.removeEventListener('keydown', handleDown);
  }, [contextMenu, onClose]);

  if (!contextMenu || typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 59 }}
        onClick={onClose}
      />
      <div
        role="menu"
        aria-label="Task actions"
        className="ui-menu scroll-quiet"
        style={{
          left: `${Math.min(contextMenu.x, window.innerWidth - 220)}px`,
          top: `${Math.min(contextMenu.y, window.innerHeight - 280)}px`,
          '--menu-origin': 'top left',
        } as React.CSSProperties}
      >
        <div
          role="menuitem"
          tabIndex={-1}
          className="ui-menu__row"
          onClick={() => {
            const id = contextMenu.issue.id;
            onClose();
            onSelectIssue(id);
          }}
        >
          <span aria-hidden="true" className="ui-menu__icon">
            <ExternalOpenGlyph size={13} />
          </span>
          <span className="ui-menu__label">
            <span className="ui-menu__row-title">Open</span>
          </span>
        </div>

        <div aria-hidden="true" className="ui-menu__rule" />

        <div
          role="menuitem"
          tabIndex={-1}
          className="ui-menu__row"
          onClick={() => {
            const iss = contextMenu.issue;
            onClose();
            window.dispatchEvent(
              new CustomEvent('kite:navigate-mode', { detail: 'chat' })
            );
            window.dispatchEvent(
              new CustomEvent('kite:open-task-in-chat', {
                detail: {
                  taskId: iss.id,
                  title: iss.title,
                  description: iss.description || '',
                },
              })
            );
          }}
        >
          <span aria-hidden="true" className="ui-menu__icon">
            <SendGlyph size={13} />
          </span>
          <span className="ui-menu__label">
            <span className="ui-menu__row-title">Send to Thread composer</span>
          </span>
        </div>

        <div
          role="menuitem"
          tabIndex={-1}
          className="ui-menu__row"
          onClick={() => {
            const iss = contextMenu.issue;
            onClose();
            onDispatch(iss);
          }}
        >
          <span aria-hidden="true" className="ui-menu__icon">
            <BotGlyph size={13} />
          </span>
          <span className="ui-menu__label">
            <span className="ui-menu__row-title">Dispatch to agent…</span>
          </span>
        </div>

        <div aria-hidden="true" className="ui-menu__rule" />

        <div className="ui-menu__heading" role="presentation">
          Move to
        </div>
        {COLUMNS.map((col) => {
          const disabled = contextMenu.issue.state === col;
          return (
            <div
              key={col}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={disabled ? true : undefined}
              className="ui-menu__row"
              onClick={() => {
                if (disabled) return;
                const id = contextMenu.issue.id;
                onClose();
                onMoveIssue(id, col);
              }}
            >
              <span aria-hidden="true" className="ui-menu__icon">
                <StateGlyph state={col} size={13} />
              </span>
              <span className="ui-menu__label">
                <span className="ui-menu__row-title">{col}</span>
              </span>
            </div>
          );
        })}

        {!contextMenu.issue.archivedAt ? (
          <>
            <div aria-hidden="true" className="ui-menu__rule" />
            <div
              role="menuitem"
              tabIndex={-1}
              className="ui-menu__row"
              onClick={() => {
                const iss = contextMenu.issue;
                onClose();
                onArchiveIssue(iss);
              }}
            >
              <span aria-hidden="true" className="ui-menu__icon">
                <ArchiveGlyph size={13} />
              </span>
              <span className="ui-menu__label">
                <span className="ui-menu__row-title">Archive task</span>
              </span>
            </div>
          </>
        ) : null}
      </div>
    </>,
    document.querySelector('.app-frame--scaled') ?? document.body
  );
};
