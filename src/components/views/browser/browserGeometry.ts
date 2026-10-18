/* Viewport and native-bounds math for the browser surface. */

export type BrowserViewportMode = 'desktop' | 'phone' | 'tablet';

export interface BrowserViewport {
  mode: BrowserViewportMode;
  landscape: boolean;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom?: number;
}

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { mode: 'desktop', landscape: false };

const DEVICE_OUTER_PADDING = 24;
const DEVICE_CAPTION_SPACE = 22;
const MIN_DEVICE_ZOOM = 0.25;
/** Height of the chrome band (TitleBar); native bounds never start above it. */
const TITLEBAR_MIN_TOP = 40;

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function getDeviceDimensions(viewport: BrowserViewport): { width: number; height: number } | null {
  if (viewport.mode === 'desktop') return null;
  const base = viewport.mode === 'phone' ? { width: 393, height: 852 } : { width: 820, height: 1180 };
  return viewport.landscape ? { width: base.height, height: base.width } : base;
}

/** Fits a device frame inside a container. Desktop returns the container unchanged. */
export function fitDeviceBounds(container: BrowserBounds, viewport: BrowserViewport): BrowserBounds | null {
  const device = getDeviceDimensions(viewport);
  if (device === null) return container;

  const availableWidth = container.width - DEVICE_OUTER_PADDING;
  const availableHeight = container.height - DEVICE_OUTER_PADDING - DEVICE_CAPTION_SPACE;
  const fittedWidth = Math.floor(
    Math.min(device.width, availableWidth, (availableHeight * device.width) / device.height)
  );
  const zoom = fittedWidth / device.width;
  if (!Number.isFinite(zoom) || zoom < MIN_DEVICE_ZOOM) return null;

  const fittedHeight = device.height * zoom;
  return {
    x: container.x + (container.width - fittedWidth) / 2,
    y: container.y + (container.height - DEVICE_CAPTION_SPACE - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
    zoom,
  };
}

export function sameBounds(left: BrowserBounds, right: BrowserBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    (left.zoom ?? 1) === (right.zoom ?? 1)
  );
}

/**
 * Keeps native bounds inside the window: below the TitleBar, right of the Sidebar,
 * and within the viewport. Returns null when nothing visible is left.
 */
export function clampToSafeWindowBounds(bounds: BrowserBounds): BrowserBounds | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return bounds;

  const titlebar = document.querySelector<HTMLElement>('.titlebar');
  const safeTop = Math.max(
    TITLEBAR_MIN_TOP,
    titlebar ? Math.ceil(titlebar.getBoundingClientRect().bottom) : TITLEBAR_MIN_TOP
  );

  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
  const safeLeft =
    sidebarRect !== null && sidebarRect.width > 0 && sidebarRect.right > 0
      ? Math.ceil(sidebarRect.right)
      : 0;

  let { x, y, width, height } = bounds;
  if (x < safeLeft) {
    width -= safeLeft - x;
    x = safeLeft;
  }
  if (x + width > window.innerWidth) {
    width = window.innerWidth - x;
  }
  if (y < safeTop) {
    height -= safeTop - y;
    y = safeTop;
  }
  if (y + height > window.innerHeight) {
    height = window.innerHeight - y;
  }
  if (width < 1 || height < 1) return null;

  return {
    x: roundToTenth(x),
    y: roundToTenth(y),
    width: roundToTenth(width),
    height: roundToTenth(height),
    zoom: bounds.zoom,
  };
}

/** Native bounds for an element's box, or null when the element cannot host the surface. */
export function measureBrowserAnchor(element: Element, viewport: BrowserViewport): BrowserBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const container: BrowserBounds = {
    x: Math.max(0, roundToTenth(rect.left)),
    y: Math.max(0, roundToTenth(rect.top)),
    width: roundToTenth(rect.width),
    height: roundToTenth(rect.height),
  };
  const fitted = fitDeviceBounds(container, viewport);
  return fitted === null ? null : clampToSafeWindowBounds(fitted);
}
