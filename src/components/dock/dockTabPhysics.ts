import React, { useRef, useCallback, useEffect } from 'react';

export interface TabBox {
  left: number;
  width: number;
}

export const TAB_GAP = 2;
export const RUBBER_COEFF = 0.6;

export function rubberBand(offset: number, max: number, factor = 0.55): number {
  return max <= 0 ? 0 : (offset * max * factor) / (max + factor * Math.abs(offset));
}

/** Midpoint slot tracking */
export function calculateSlot(boxes: TabBox[], from: number, midX: number): number {
  let slot = 0;
  boxes.forEach((box, i) => {
    if (i !== from && midX > box.left + box.width / 2) slot += 1;
  });
  return slot;
}

/** Offset shifts for non-carried tabs */
export function calculateTabShifts(boxes: TabBox[], from: number, slot: number, gap: number): number[] {
  const carried = boxes[from];
  if (!carried) return boxes.map(() => 0);
  const stride = carried.width + gap;
  return boxes.map((_, i) => {
    if (i === from) return 0;
    if (slot > from && i > from && i <= slot) return -stride;
    if (slot < from && i >= slot && i < from) return stride;
    return 0;
  });
}

/** Clamped / rubberbanded drag offset */
export function clampDragOffset(boxes: TabBox[], from: number, dx: number): number {
  const current = boxes[from];
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (!Number.isFinite(dx)) return 0;
  if (!current || !first || !last) return dx;

  const minOffset = first.left - current.left;
  const maxOffset = last.left + last.width - (current.left + current.width);
  const slack = current.width * RUBBER_COEFF;

  if (dx < minOffset) return minOffset + rubberBand(dx - minOffset, slack);
  if (dx > maxOffset) return maxOffset + rubberBand(dx - maxOffset, slack);
  return dx;
}

/** Target slot left position */
export function calculateSlotLeft(boxes: TabBox[], from: number, slot: number): number {
  const r = boxes[from];
  const target = boxes[slot];
  if (!r || !target) return r?.left ?? 0;
  return slot > from ? target.left + target.width - r.width : target.left;
}

/** Keyboard index navigation */
export function getKeyboardNextIndex(key: string, index: number, total: number): number | null {
  if (total === 0) return null;
  switch (key) {
    case 'ArrowLeft': return (index - 1 + total) % total;
    case 'ArrowRight': return (index + 1) % total;
    case 'Home': return 0;
    case 'End': return total - 1;
    default: return null;
  }
}

export function setPointerDraggingState(dragging: boolean) {
  const doc = globalThis.document?.documentElement;
  if (!doc) return;
  if (dragging) {
    doc.dataset.pointerDragging = 'true';
    globalThis.getSelection?.()?.removeAllRanges();
  } else {
    delete doc.dataset.pointerDragging;
  }
}

export interface PointerDragOptions {
  enabled?: boolean;
  threshold?: number;
  ignoreSelector?: string;
  onStart: (pos: { clientX: number; clientY: number }) => void;
  onMove?: (pos: { clientX: number; clientY: number }) => void;
  onEnd: (pos: { clientX: number; clientY: number }) => void;
  onCancel?: () => void;
}

export function usePointerDrag(options: PointerDragOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activePointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);

  const cleanup = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (activePointerRef.current?.started) setPointerDraggingState(false);
    activePointerRef.current = null;
  }, []);

  useEffect(() => {
    if (options.enabled) return;
    const current = activePointerRef.current;
    cleanup();
    if (current?.started) optionsRef.current.onCancel?.();
  }, [cleanup, options.enabled]);

  useEffect(() => () => {
    const current = activePointerRef.current;
    cleanup();
    if (current?.started) optionsRef.current.onCancel?.();
  }, [cleanup]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const opts = optionsRef.current;
    if (!opts.enabled || e.button !== 0 || !e.isPrimary || activePointerRef.current !== null) return;
    const target = e.target;
    if (opts.ignoreSelector && target instanceof Element && target.closest(opts.ignoreSelector) !== null) return;

    const state = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false };
    activePointerRef.current = state;
    const threshold = opts.threshold ?? 6;
    const getPos = (ev: PointerEvent) => ({ clientX: ev.clientX, clientY: ev.clientY });

    const handlePointerMove = (ev: PointerEvent) => {
      if (ev.pointerId !== state.pointerId) return;
      if (!state.started) {
        if (Math.hypot(ev.clientX - state.startX, ev.clientY - state.startY) < threshold) return;
        state.started = true;
        setPointerDraggingState(true);
        optionsRef.current.onStart(getPos(ev));
      }
      optionsRef.current.onMove?.(getPos(ev));
    };

    const handlePointerUp = (ev: PointerEvent) => {
      if (ev.pointerId !== state.pointerId) return;
      const started = state.started;
      cleanup();
      if (started) optionsRef.current.onEnd(getPos(ev));
    };

    const handleCancel = () => {
      const started = state.started;
      cleanup();
      if (started) optionsRef.current.onCancel?.();
    };

    const handlePointerCancel = (ev: PointerEvent) => {
      if (ev.pointerId === state.pointerId) handleCancel();
    };

    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') handleCancel();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleCancel);
    window.addEventListener('keydown', handleKeyDown);

    cleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleCancel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cleanup]);

  return { onPointerDown };
}
