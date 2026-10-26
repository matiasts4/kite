import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { PaperclipIcon, FileCodeIcon, FolderIcon } from '../ChatIcons';
import { ComposerControl } from './ComposerControl';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';

export interface AttachMenuPopoverProps {
  disabled?: boolean;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
}

const PANEL_WIDTH = 230;
const PANEL_HEIGHT = 110;

export const AttachMenuPopover: React.FC<AttachMenuPopoverProps> = ({
  disabled = false,
  onPickAttachments,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

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
    const handleClickOutside = (e: MouseEvent) => {
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
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  const handleSelect = (kind: 'files' | 'folder') => {
    setIsOpen(false);
    onPickAttachments(kind);
  };

  return (
    <>
      <ComposerControl
        ref={triggerRef}
        role="button"
        aria-label="Attach files or a folder"
        aria-expanded={isOpen}
        title="Attach files or a folder"
        disabled={disabled}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => {
          if (!disabled) setIsOpen((prev) => !prev);
        }}
        className="kite-attach-trigger"
      >
        <PaperclipIcon size={14} className="shrink-0" />
      </ComposerControl>

      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Attach to message"
            className="kite-floating-card kite-attach-menu"
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
            }}
          >
            <button
              type="button"
              className="kite-attach-item"
              onClick={() => handleSelect('files')}
            >
              <FileCodeIcon size={15} className="shrink-0 text-muted-foreground" />
              <div className="kite-attach-item-text">
                <span className="kite-attach-item-title">Add files…</span>
                <span className="kite-attach-item-detail">Choose one or more files</span>
              </div>
            </button>

            <button
              type="button"
              className="kite-attach-item"
              onClick={() => handleSelect('folder')}
            >
              <FolderIcon size={15} className="shrink-0 text-muted-foreground" />
              <div className="kite-attach-item-text">
                <span className="kite-attach-item-title">Add folder…</span>
                <span className="kite-attach-item-detail">The agent can read everything inside</span>
              </div>
            </button>
          </div>,
          document.body
        )}
    </>
  );
};
