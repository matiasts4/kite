import React, { useState, useEffect, useRef } from 'react';
import type { PaneDropEdge } from './treeUtils';
import { calculateDropZone, type PaneRect, DRAG_ACTIVATION_THRESHOLD_PX } from './paneDragUtils';
import { GripDotsIcon } from './codeIcons';

export interface PaneDragOverlayProps {
  sourceLeafId: string;
  sourceTitle?: string;
  initialPointerX: number;
  initialPointerY: number;
  onDrop: (sourceLeafId: string, targetLeafId: string, edge: PaneDropEdge | null) => void;
  onCancel: () => void;
}

export const PaneDragOverlay: React.FC<PaneDragOverlayProps> = ({
  sourceLeafId,
  sourceTitle = 'Terminal',
  initialPointerX,
  initialPointerY,
  onDrop,
  onCancel,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [currentPos, setCurrentPos] = useState({ x: initialPointerX, y: initialPointerY });
  const [dropTarget, setDropTarget] = useState<{
    targetLeafId: string;
    edge: PaneDropEdge | null;
    previewRect: PaneRect;
  } | null>(null);

  const dragActiveRef = useRef(false);
  const dropTargetRef = useRef(dropTarget);
  dropTargetRef.current = dropTarget;

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      setCurrentPos({ x, y });

      if (!dragActiveRef.current) {
        const dx = Math.abs(x - initialPointerX);
        const dy = Math.abs(y - initialPointerY);
        if (Math.max(dx, dy) >= DRAG_ACTIVATION_THRESHOLD_PX) {
          dragActiveRef.current = true;
          setIsDragging(true);
        } else {
          return;
        }
      }

      // Find target pane under pointer
      const panels = document.querySelectorAll<HTMLElement>(
        '.workspace-tab-layer--active .code-pane-panel, .code-pane-panel'
      );

      let found: {
        targetLeafId: string;
        edge: PaneDropEdge | null;
        previewRect: PaneRect;
      } | null = null;

      for (const panel of panels) {
        const leafId = panel.dataset.leafId;
        if (!leafId || leafId === sourceLeafId) continue;

        const rect = panel.getBoundingClientRect();
        const calc = calculateDropZone(rect, x, y);
        if (calc) {
          found = {
            targetLeafId: leafId,
            edge: calc.edge,
            previewRect: calc.previewRect,
          };
          break;
        }
      }

      setDropTarget(found);
    };

    const handlePointerUp = () => {
      if (dragActiveRef.current && dropTargetRef.current) {
        onDrop(
          sourceLeafId,
          dropTargetRef.current.targetLeafId,
          dropTargetRef.current.edge
        );
      } else {
        onCancel();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [sourceLeafId, initialPointerX, initialPointerY, onDrop, onCancel]);

  if (!isDragging) {
    return null;
  }

  return (
    <div
      className="pane-drag-overlay"
      data-testid="pane-drag-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        cursor: 'grabbing',
        userSelect: 'none',
        pointerEvents: 'auto',
      }}
    >
      {/* Drop Target Preview Box */}
      {dropTarget && (
        <div
          className="pane-drag-preview"
          data-testid="pane-drag-preview"
          data-edge={dropTarget.edge || 'swap'}
          style={{
            position: 'fixed',
            left: dropTarget.previewRect.left,
            top: dropTarget.previewRect.top,
            width: dropTarget.previewRect.width,
            height: dropTarget.previewRect.height,
            pointerEvents: 'none',
            borderRadius: 'var(--card-radius, 12px)',
            background: 'rgba(var(--accent-rgb, 99, 102, 241), 0.16)',
            border: '2px solid var(--accent, #6366f1)',
            boxShadow: '0 0 24px rgba(var(--accent-rgb, 99, 102, 241), 0.28)',
            transition: 'all 120ms cubic-bezier(0.16, 1, 0.3, 1)',
            zIndex: 10000,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: 12,
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--accent, #6366f1)',
              background: 'var(--pane, #161b22)',
              padding: '2px 8px',
              borderRadius: 'var(--vl-radius-xs, 4px)',
              border: '1px solid var(--accent, #6366f1)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {dropTarget.edge === null
              ? 'Swap Panes'
              : `Split ${dropTarget.edge.toUpperCase()}`}
          </div>
        </div>
      )}

      {/* Floating Cursor Drag Badge */}
      <div
        className="pane-drag-ghost-badge"
        data-testid="pane-drag-ghost-badge"
        style={{
          position: 'fixed',
          left: currentPos.x + 14,
          top: currentPos.y + 14,
          pointerEvents: 'none',
          zIndex: 10001,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          background: 'var(--pane, #161b22)',
          border: '1px solid var(--accent, #6366f1)',
          borderRadius: 'var(--control-radius, 8px)',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
          color: 'var(--text-primary, #ffffff)',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <GripDotsIcon size={12} style={{ color: 'var(--accent, #6366f1)' }} />
        <span>{sourceTitle}</span>
      </div>
    </div>
  );
};
