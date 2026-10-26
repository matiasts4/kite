export interface PopoverCoords {
  left: number;
  top: number;
  origin: 'top' | 'bottom';
}

export function getAnchoredPopoverCoords(
  triggerEl: HTMLElement,
  panelWidth: number,
  panelHeight: number,
  gap: number = 8,
  prefer: 'top' | 'bottom' = 'top'
): PopoverCoords {
  const scaledHost = triggerEl.closest('.app-frame--scaled') as HTMLElement | null;
  const hostRect = scaledHost?.getBoundingClientRect();
  const rawScale = Number(
    scaledHost ? window.getComputedStyle(scaledHost).getPropertyValue('--ui-scale') : 1
  );
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const originX = hostRect?.left ?? 0;
  const originY = hostRect?.top ?? 0;
  const rect = triggerEl.getBoundingClientRect();

  const bounds = {
    left: (rect.left - originX) / scale,
    top: (rect.top - originY) / scale,
    right: (rect.right - originX) / scale,
    bottom: (rect.bottom - originY) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };

  const viewport = {
    left: -originX / scale,
    top: -originY / scale,
    right: (window.innerWidth - originX) / scale,
    bottom: (window.innerHeight - originY) / scale,
  };

  const left = Math.max(
    viewport.left + 12,
    Math.min(bounds.left, viewport.right - panelWidth - 12)
  );

  const spaceAbove = bounds.top - viewport.top - gap;
  const spaceBelow = viewport.bottom - bounds.bottom - gap;

  const placeAbove =
    prefer === 'top'
      ? spaceAbove >= panelHeight || spaceAbove >= spaceBelow
      : spaceBelow < panelHeight && spaceAbove > spaceBelow;

  const top = placeAbove
    ? Math.max(viewport.top + 8, bounds.top - panelHeight - gap)
    : Math.min(viewport.bottom - panelHeight - 8, bounds.bottom + gap);

  return {
    left,
    top,
    origin: placeAbove ? 'bottom' : 'top',
  };
}
