import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChatMode } from '../types';
import { DriverChoice } from '../../../../lib/session/types';
import { LockIcon, CheckIcon } from '../ChatIcons';
import { ComposerControl, ComposerControlChevron } from './ComposerControl';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';

export interface PermissionPickerPopoverProps {
  threadMode: ChatMode;
  permissions: DriverChoice[];
  permissionDeclared: boolean;
  permissionReason?: string | null;
  disabled?: boolean;
  onSelectPermission: (mode: ChatMode) => void;
}

const PANEL_WIDTH = 240;
const PANEL_HEIGHT = 160;

export const PermissionPickerPopover: React.FC<PermissionPickerPopoverProps> = ({
  threadMode,
  permissions,
  permissionDeclared,
  permissionReason,
  disabled = false,
  onSelectPermission,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const activePermission = permissions.find((p) => p.id === threadMode);
  const permissionLabel = activePermission?.label || threadMode;

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
        aria-label="Permission"
        aria-expanded={isOpen}
        title={permissionReason || `Permission mode: ${permissionLabel}`}
        disabled={disabled || !permissionDeclared}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => {
          if (!disabled && permissionDeclared) setIsOpen((prev) => !prev);
        }}
      >
        <LockIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="truncate max-w-[140px] font-medium">{permissionLabel}</span>
        <ComposerControlChevron />
      </ComposerControl>

      {permissionReason && <span className="sr-only">{permissionReason}</span>}

      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Permission mode"
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
              Permission Mode
            </div>
            <div className="kite-context-menu-list">
              {permissions.map((p) => {
                const isSelected = p.id === threadMode;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`kite-context-menu-item ${
                      isSelected ? 'kite-context-menu-item--selected' : ''
                    }`}
                    style={{ height: 'auto', padding: '0.4rem 0.5rem' }}
                    onClick={() => {
                      onSelectPermission(p.id as ChatMode);
                      setIsOpen(false);
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1, textAlign: 'left' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                        {p.label}
                      </span>
                      {p.detail && (
                        <span style={{ fontSize: '0.6875rem', color: 'var(--muted-foreground)' }}>
                          {p.detail}
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
