import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon } from '../ChatIcons';
import { ComposerControl, ComposerControlChevron } from './ComposerControl';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';

export interface ConnectionCandidate {
  connectionId: string;
  displayName: string;
  supportedEndpoint?: string;
}

export interface ConnectionPickerPopoverProps {
  threadConnectionId: string | null;
  candidates: ConnectionCandidate[];
  disabled?: boolean;
  onSelectConnection: (connectionId: string) => void;
}

const PANEL_WIDTH = 240;
const PANEL_HEIGHT = 160;

export const ConnectionPickerPopover: React.FC<ConnectionPickerPopoverProps> = ({
  threadConnectionId,
  candidates,
  disabled = false,
  onSelectConnection,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const selectedConnection = candidates.find(
    (c) => c.connectionId === threadConnectionId
  );
  const label = selectedConnection?.displayName ?? 'Choose connection';

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    setCoords(getAnchoredPopoverCoords(triggerRef.current, PANEL_WIDTH, PANEL_HEIGHT, 8, 'top'));
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  return (
    <>
      <ComposerControl
        ref={triggerRef}
        role="combobox"
        aria-label="Connection"
        aria-expanded={isOpen}
        title="Account connection used for this send"
        disabled={disabled}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => {
          if (!disabled) setIsOpen((prev) => !prev);
        }}
      >
        <span className="truncate max-w-[140px] font-medium">{label}</span>
        <ComposerControlChevron />
      </ComposerControl>

      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Account connection"
            className="kite-floating-card kite-context-menu"
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
              width: `${PANEL_WIDTH}px`,
            }}
          >
            <div
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '0.6875rem',
                fontWeight: 600,
                color: 'var(--muted-foreground)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Account Connection
            </div>
            <div className="kite-context-menu-list">
              {candidates.map((c) => {
                const isSelected = c.connectionId === threadConnectionId;
                return (
                  <button
                    key={c.connectionId}
                    type="button"
                    className={`kite-context-menu-item ${
                      isSelected ? 'kite-context-menu-item--selected' : ''
                    }`}
                    style={{ height: 'auto', padding: '0.4rem 0.5rem' }}
                    onClick={() => {
                      onSelectConnection(c.connectionId);
                      setIsOpen(false);
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1, textAlign: 'left' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                        {c.displayName}
                      </span>
                      {c.supportedEndpoint && (
                        <span style={{ fontSize: '0.6875rem', color: 'var(--muted-foreground)' }}>
                          {c.supportedEndpoint}
                        </span>
                      )}
                    </div>
                    {isSelected && (
                      <CheckIcon size={14} className="shrink-0 text-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
