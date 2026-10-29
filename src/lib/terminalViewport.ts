import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { IUnicodeVersionProvider, Terminal } from '@xterm/xterm';

export const SAFE_FIT_MIN_WIDTH_PX = 48;
export const SAFE_FIT_MIN_HEIGHT_PX = 24;
export const SAFE_FIT_MIN_COLS = 8;
export const SAFE_FIT_MIN_ROWS = 4;
export const TERMINAL_SCROLLBAR_WIDTH_PX = 5;

export const PTY_VIEWPORT_MIN_COLS = 20;
export const PTY_VIEWPORT_MIN_ROWS = 8;
export const PTY_VIEWPORT_DEFAULT_COLS = 80;
export const PTY_VIEWPORT_DEFAULT_ROWS = 24;
export const PTY_VIEWPORT_MAX_COLS = 1000;
export const PTY_VIEWPORT_MAX_ROWS = 500;

export const CONPTY_REFACTORED_BUILD_NUMBER = 21376;
export const DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER = 22631;

const ZERO_WIDTH_JOINER = 0x200d;
const BASE_UNICODE_VERSION = '11';
const ZWJ_UNICODE_VERSION = '11-zwj';

export function buildWindowsConptyOptions(buildNumber?: number): {
  backend: 'conpty';
  buildNumber?: number;
} {
  if (buildNumber === undefined || buildNumber < CONPTY_REFACTORED_BUILD_NUMBER) {
    return { backend: 'conpty' };
  }
  return { backend: 'conpty', buildNumber };
}

export function clampPtyViewportDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function clampPtyViewportDimensions(
  cols: number | undefined,
  rows: number | undefined,
): { cols: number; rows: number } {
  return {
    cols: clampPtyViewportDimension(
      cols,
      PTY_VIEWPORT_DEFAULT_COLS,
      PTY_VIEWPORT_MIN_COLS,
      PTY_VIEWPORT_MAX_COLS,
    ),
    rows: clampPtyViewportDimension(
      rows,
      PTY_VIEWPORT_DEFAULT_ROWS,
      PTY_VIEWPORT_MIN_ROWS,
      PTY_VIEWPORT_MAX_ROWS,
    ),
  };
}

export function hasMinimallyRenderableFitGeometry(geometry: {
  width: number;
  height: number;
  cols: number;
  rows: number;
}): boolean {
  return (
    geometry.width >= SAFE_FIT_MIN_WIDTH_PX &&
    geometry.height >= SAFE_FIT_MIN_HEIGHT_PX &&
    geometry.cols >= SAFE_FIT_MIN_COLS &&
    geometry.rows >= SAFE_FIT_MIN_ROWS
  );
}

export function extractUnicodeWidth(propertyValue: number): number {
  return (propertyValue >> 1) & 3;
}

export function extractUnicodeKind(propertyValue: number): number {
  return propertyValue >>> 3;
}

export function createUnicodePropertyValue(
  kind: number,
  width: number,
  shouldJoin: boolean,
): number {
  return ((kind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0);
}

export class ZwjAwareUnicode11Provider implements IUnicodeVersionProvider {
  readonly version = ZWJ_UNICODE_VERSION;
  private readonly baseProvider: IUnicodeVersionProvider;

  constructor(baseProvider: IUnicodeVersionProvider) {
    this.baseProvider = baseProvider;
  }

  wcwidth(codepoint: number): 0 | 1 | 2 {
    return this.baseProvider.wcwidth(codepoint);
  }

  charProperties(codepoint: number, preceding: number): number {
    const precedingWidth = extractUnicodeWidth(preceding);
    const precedingKind = extractUnicodeKind(preceding);
    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createUnicodePropertyValue(ZERO_WIDTH_JOINER, precedingWidth, true);
    }
    if (
      precedingKind === ZERO_WIDTH_JOINER &&
      precedingWidth > 0 &&
      this.wcwidth(codepoint) > 0
    ) {
      // Full-screen TUIs budget ZWJ emoji sequences as one wide glyph; standard
      // Unicode11 advances for each joined emoji component unless joined here.
      return createUnicodePropertyValue(codepoint, precedingWidth, true);
    }
    return this.baseProvider.charProperties(codepoint, preceding);
  }
}

export function activateTerminalUnicodeProvider(
  term: Terminal,
  unicodeAddon: Unicode11Addon = new Unicode11Addon(),
): void {
  try {
    term.loadAddon(unicodeAddon);
    const unicode = term.unicode;
    if (unicode.activeVersion === ZWJ_UNICODE_VERSION) {
      return;
    }
    const coreProviders = (
      term as unknown as {
        _core?: {
          unicodeService?: {
            _providers?: Record<string, IUnicodeVersionProvider | undefined>;
          };
        };
      }
    )._core?.unicodeService?._providers;
    const baseProvider = coreProviders?.[BASE_UNICODE_VERSION];
    if (!baseProvider) {
      unicode.activeVersion = BASE_UNICODE_VERSION;
      return;
    }
    if (!unicode.versions.includes(ZWJ_UNICODE_VERSION)) {
      unicode.register(new ZwjAwareUnicode11Provider(baseProvider));
    }
    unicode.activeVersion = ZWJ_UNICODE_VERSION;
  } catch {
    // Keep terminal initialization resilient if proposed unicode APIs are unavailable.
  }
}

const BLOCK_FG_VAR = '--kite-block-fg';
const BLOCK_FILL_ATTR = 'data-kite-block-fill';
const BLOCK_INLINE_FG_ATTR = 'data-kite-block-inline-fg';

function buildBlockGradient(
  direction: 'bottom' | 'right',
  percent: number,
  fromStart: boolean,
): string {
  const dir = direction === 'bottom' ? 'to bottom' : 'to right';
  const color = `var(${BLOCK_FG_VAR})`;
  if (fromStart) {
    return `linear-gradient(${dir}, ${color} ${percent}%, transparent ${percent}%)`;
  }
  const stop = 100 - percent;
  return `linear-gradient(${dir}, transparent ${stop}%, ${color} ${stop}%)`;
}

export function resolveBlockElementGradient(text: string): string | null {
  if (text.length === 0) return null;
  const first = text[0];
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] !== first) return null;
  }
  const cp = first.codePointAt(0) ?? 0;
  if (cp === 0x2580) return buildBlockGradient('bottom', 50, true);
  if (cp >= 0x2581 && cp <= 0x2588) return buildBlockGradient('bottom', (cp - 0x2580) * 12.5, false);
  if (cp >= 0x2589 && cp <= 0x258f) return buildBlockGradient('right', (8 - (cp - 0x2588)) * 12.5, true);
  if (cp === 0x2590) return buildBlockGradient('right', 50, false);
  if (cp === 0x2594) return buildBlockGradient('bottom', 12.5, true);
  if (cp === 0x2595) return buildBlockGradient('right', 12.5, false);
  return null;
}

function clearBlockSpanStyle(span: HTMLElement): void {
  if (!span.hasAttribute(BLOCK_FILL_ATTR)) return;
  const savedColor = span.getAttribute(BLOCK_INLINE_FG_ATTR);
  const isTransparent = span.style.color === 'transparent';
  span.removeAttribute(BLOCK_FILL_ATTR);
  span.removeAttribute(BLOCK_INLINE_FG_ATTR);
  span.style.removeProperty('background-image');
  span.style.removeProperty('background-size');
  span.style.removeProperty('background-repeat');
  span.style.removeProperty(BLOCK_FG_VAR);
  if (isTransparent) {
    if (savedColor) span.style.color = savedColor;
    else span.style.removeProperty('color');
  }
}

function applyBlockSpanStyle(span: HTMLElement): void {
  const text = span.textContent ?? '';
  const gradient = resolveBlockElementGradient(text);
  if (!gradient) {
    clearBlockSpanStyle(span);
    return;
  }
  const inlineColor = span.style.color;
  const alreadyApplied = span.hasAttribute(BLOCK_FILL_ATTR) && inlineColor === 'transparent';
  if (alreadyApplied && span.getAttribute(BLOCK_FILL_ATTR) === text) {
    return;
  }
  const effectiveColor = alreadyApplied
    ? span.style.getPropertyValue(BLOCK_FG_VAR)
    : inlineColor || (typeof getComputedStyle === 'function' ? getComputedStyle(span).color : '');
  if (!effectiveColor) return;
  if (!alreadyApplied) {
    span.setAttribute(BLOCK_INLINE_FG_ATTR, inlineColor);
  }
  span.setAttribute(BLOCK_FILL_ATTR, text);
  span.style.setProperty(BLOCK_FG_VAR, effectiveColor);
  span.style.color = 'transparent';
  span.style.backgroundImage = gradient;
  span.style.backgroundSize = `${100 / text.length}% 100%`;
  span.style.backgroundRepeat = 'repeat-x';
}

function scanRowElementForBlockSpans(row: Element | null | undefined): void {
  if (!row || typeof row.querySelectorAll !== 'function') return;
  const spans = row.querySelectorAll('span');
  for (const span of spans) {
    if (span instanceof HTMLElement) {
      applyBlockSpanStyle(span);
    }
  }
}

export function attachDomBlockFillCleanup(term: Terminal): () => void {
  const element = term.element;
  if (!element || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  const rowsRoot = element.querySelector('.xterm-rows');
  if (rowsRoot) {
    for (const child of Array.from(rowsRoot.children)) {
      scanRowElementForBlockSpans(child);
    }
  }
  const observer = new MutationObserver((records) => {
    const dirtyRows = new Set<HTMLElement>();
    for (const record of records) {
      const targetElement =
        record.target instanceof HTMLElement
          ? record.target
          : record.target.parentElement;
      const rowTarget = targetElement ? targetElement.closest('.xterm-rows > div') : null;
      if (rowTarget instanceof HTMLElement) {
        dirtyRows.add(rowTarget);
        continue;
      }
      for (const added of Array.from(record.addedNodes)) {
        if (!(added instanceof HTMLElement)) continue;
        if (added.parentElement?.classList.contains('xterm-rows')) {
          dirtyRows.add(added);
        } else {
          const rows = added.matches('.xterm-rows')
            ? [added]
            : Array.from(added.querySelectorAll('.xterm-rows'));
          for (const container of rows) {
            for (const row of Array.from(container.children)) {
              if (row instanceof HTMLElement) dirtyRows.add(row);
            }
          }
        }
      }
    }
    for (const row of dirtyRows) {
      if (element.contains(row)) {
        scanRowElementForBlockSpans(row);
      }
    }
  });
  observer.observe(element, { childList: true, characterData: true, subtree: true });
  return () => observer.disconnect();
}

export function repairWebglCanvasForDevicePixelRatio(
  term: Terminal,
  dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1,
): boolean {
  if (!Number.isFinite(dpr) || dpr <= 0) return false;
  const root = term.element;
  if (!root || typeof root.querySelector !== 'function') return false;
  const screen = root.querySelector('.xterm-screen');
  const canvas = screen?.querySelector('canvas') ?? root.querySelector('canvas');
  if (!screen || !canvas) return false;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const expectedWidth = Math.round(rect.width * dpr);
  const expectedHeight = Math.round(rect.height * dpr);
  if (
    Math.abs(canvas.width - expectedWidth) <= 1 &&
    Math.abs(canvas.height - expectedHeight) <= 1
  ) {
    return false;
  }
  try {
    const core = (
      term as unknown as {
        _core?: {
          _renderService?: {
            handleDevicePixelRatioChange?: () => void;
          };
          refresh?: (start: number, end: number, sync?: boolean) => void;
        };
      }
    )._core;
    core?._renderService?.handleDevicePixelRatioChange?.();
    if (term.rows > 0) {
      term.refresh(0, term.rows - 1);
    }
  } catch {
    return false;
  }
  return true;
}

function measureHostDimensions(host: HTMLElement): { width: number; height: number } {
  const rect = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
  const width = rect && rect.width > 0 ? rect.width : host.clientWidth;
  const height = rect && rect.height > 0 ? rect.height : host.clientHeight;
  return { width, height };
}

interface TerminalRenderDimensions {
  device?: { cell?: { width?: number; height?: number } };
  css?: { cell?: { width?: number; height?: number } };
}

export function getStableCellDimensions(
  term: Terminal,
): { width: number; height: number } | null {
  const internal = term as unknown as {
    dimensions?: TerminalRenderDimensions;
    _core?: {
      _renderService?: {
        dimensions?: TerminalRenderDimensions;
      };
    };
  };
  const dims = internal.dimensions ?? internal._core?._renderService?.dimensions;
  if (!dims) return null;
  const dpr =
    term.element?.ownerDocument?.defaultView?.devicePixelRatio ||
    (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ||
    1;
  const devWidth = (dims.device?.cell?.width ?? 0) / dpr;
  const devHeight = (dims.device?.cell?.height ?? 0) / dpr;
  if (Number.isFinite(devWidth) && devWidth > 0 && Number.isFinite(devHeight) && devHeight > 0) {
    return { width: devWidth, height: devHeight };
  }
  const cssWidth = dims.css?.cell?.width ?? 0;
  const cssHeight = dims.css?.cell?.height ?? 0;
  if (Number.isFinite(cssWidth) && cssWidth > 0 && Number.isFinite(cssHeight) && cssHeight > 0) {
    return { width: cssWidth, height: cssHeight };
  }
  return null;
}

export class StableCellFitAddon extends FitAddon {
  private stableTerminal: Terminal | null = null;

  override activate(terminal: Terminal): void {
    this.stableTerminal = terminal;
    super.activate(terminal);
  }

  override fit(): void {
    const term = this.stableTerminal;
    const dims = this.proposeDimensions();
    if (!dims || !term || Number.isNaN(dims.cols) || Number.isNaN(dims.rows)) {
      return;
    }
    if (term.cols !== dims.cols || term.rows !== dims.rows) {
      term.resize(dims.cols, dims.rows);
    }
  }

  override proposeDimensions(): { cols: number; rows: number } | undefined {
    const term = this.stableTerminal;
    const element = term?.element;
    const parent = element?.parentElement;
    if (!term || !element || !parent) {
      return undefined;
    }
    const cell = getStableCellDimensions(term);
    if (!cell) {
      return undefined;
    }
    const view =
      element.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    const parentStyle =
      view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(parent) : null;
    const elementStyle =
      view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(element) : null;

    const styleWidth = parentStyle ? Number.parseInt(parentStyle.getPropertyValue('width'), 10) : 0;
    const styleHeight = parentStyle
      ? Number.parseInt(parentStyle.getPropertyValue('height'), 10)
      : 0;
    const fallbackHost = measureHostDimensions(parent);
    const hostWidth = styleWidth > 0 ? styleWidth : Math.trunc(fallbackHost.width);
    const hostHeight = styleHeight > 0 ? styleHeight : Math.trunc(fallbackHost.height);
    if (hostWidth <= 0 || hostHeight <= 0) {
      return undefined;
    }

    const padTop = elementStyle ? Number.parseInt(elementStyle.getPropertyValue('padding-top'), 10) || 0 : 0;
    const padRight = elementStyle ? Number.parseInt(elementStyle.getPropertyValue('padding-right'), 10) || 0 : 0;
    const padBottom = elementStyle ? Number.parseInt(elementStyle.getPropertyValue('padding-bottom'), 10) || 0 : 0;
    const padLeft = elementStyle ? Number.parseInt(elementStyle.getPropertyValue('padding-left'), 10) || 0 : 0;

    const scrollbarOptions = (
      term.options as { scrollbar?: { showScrollbar?: boolean; width?: number } }
    ).scrollbar;
    const showScrollbar = scrollbarOptions?.showScrollbar ?? true;
    const scrollbarWidth =
      term.options.scrollback === 0 || !showScrollbar
        ? 0
        : (scrollbarOptions?.width ?? TERMINAL_SCROLLBAR_WIDTH_PX);

    const availableWidth = Math.max(0, hostWidth - padLeft - padRight - scrollbarWidth);
    const availableHeight = Math.max(0, hostHeight - padTop - padBottom);
    return {
      cols: Math.max(2, Math.floor(availableWidth / cell.width)),
      rows: Math.max(1, Math.floor(availableHeight / cell.height)),
    };
  }
}

export function scheduleStabilizedFit(options: {
  propose: () => { cols: number; rows: number } | undefined | null;
  isBlocked?: () => boolean;
  onSettled: () => void;
  maxFrames?: number;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}): () => void {
  const maxFrames = Math.max(2, options.maxFrames ?? 8);
  const requestFrame =
    options.requestFrame ??
    (typeof requestAnimationFrame === 'function'
      ? (cb: FrameRequestCallback) => requestAnimationFrame(cb)
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 16));
  const cancelFrame =
    options.cancelFrame ??
    (typeof cancelAnimationFrame === 'function'
      ? (id: number) => cancelAnimationFrame(id)
      : (id: number) => window.clearTimeout(id));

  let frameId: number | null = null;
  let lastCols: number | null = null;
  let lastRows: number | null = null;
  let count = 0;

  const step = () => {
    frameId = null;
    if (options.isBlocked?.()) {
      return;
    }
    count += 1;
    const proposed = options.propose();
    if (
      proposed &&
      Number.isFinite(proposed.cols) &&
      Number.isFinite(proposed.rows) &&
      proposed.cols >= SAFE_FIT_MIN_COLS &&
      proposed.rows >= SAFE_FIT_MIN_ROWS
    ) {
      if (proposed.cols === lastCols && proposed.rows === lastRows) {
        options.onSettled();
        return;
      }
      lastCols = proposed.cols;
      lastRows = proposed.rows;
    } else {
      lastCols = null;
      lastRows = null;
    }
    if (count < maxFrames) {
      frameId = requestFrame(step);
    } else if (lastCols !== null && lastRows !== null) {
      options.onSettled();
    }
  };

  frameId = requestFrame(step);
  return () => {
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
  };
}

export function terminalGridDriftedFromFit(
  term: Terminal,
  fit: FitAddon,
  host?: HTMLElement | null,
): boolean {
  const container = host ?? term.element?.parentElement;
  if (!container) return false;
  const { width, height } = measureHostDimensions(container);
  let proposed: { cols: number; rows: number } | undefined;
  try {
    proposed = fit.proposeDimensions();
  } catch {
    return false;
  }
  if (
    !proposed ||
    !Number.isFinite(proposed.cols) ||
    !Number.isFinite(proposed.rows) ||
    !hasMinimallyRenderableFitGeometry({
      width,
      height,
      cols: proposed.cols,
      rows: proposed.rows,
    })
  ) {
    return false;
  }
  return proposed.cols !== term.cols || proposed.rows !== term.rows;
}

export function safeFitTerminal(
  term: Terminal,
  fit: FitAddon,
  host?: HTMLElement | null,
): { cols: number; rows: number } | null {
  const container = host ?? term.element?.parentElement;
  if (!container) return null;
  const { width, height } = measureHostDimensions(container);
  let proposed: { cols: number; rows: number } | undefined;
  try {
    proposed = fit.proposeDimensions();
  } catch {
    return null;
  }
  if (
    !proposed ||
    !Number.isFinite(proposed.cols) ||
    !Number.isFinite(proposed.rows) ||
    !hasMinimallyRenderableFitGeometry({
      width,
      height,
      cols: proposed.cols,
      rows: proposed.rows,
    })
  ) {
    return null;
  }
  try {
    fit.fit();
    repairWebglCanvasForDevicePixelRatio(term);
  } catch {
    return null;
  }
  if (term.cols < SAFE_FIT_MIN_COLS || term.rows < SAFE_FIT_MIN_ROWS) {
    return null;
  }
  return clampPtyViewportDimensions(term.cols, term.rows);
}

/** Backwards-compatible entry point used by callers that fit an active terminal. */
export function fitVisibleGrid(term: Terminal, fit: FitAddon): void {
  safeFitTerminal(term, fit);
}

const POST_SPAWN_STABLE_FRAMES_REQUIRED = 8;
const POST_SPAWN_MAX_FRAMES = 180;

export function reconcilePtySizeAfterSpawn(options: {
  isCancelled: () => boolean;
  fitAndMeasure: () => { cols: number; rows: number } | null;
  getAppliedSize: () => { cols: number | null; rows: number | null };
  applySize: (size: { cols: number; rows: number }) => void;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}): () => void {
  const requestFrame =
    options.requestFrame ??
    (typeof requestAnimationFrame === 'function'
      ? (cb: FrameRequestCallback) => requestAnimationFrame(cb)
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 16));
  const cancelFrame =
    options.cancelFrame ??
    (typeof cancelAnimationFrame === 'function'
      ? (id: number) => cancelAnimationFrame(id)
      : (id: number) => window.clearTimeout(id));

  let frameId: number | null = null;
  let stableFrames = 0;
  let totalFrames = 0;

  const step = () => {
    frameId = null;
    if (options.isCancelled()) return;
    totalFrames += 1;
    const measured = options.fitAndMeasure();
    if (measured) {
      const applied = options.getAppliedSize();
      if (applied.cols !== measured.cols || applied.rows !== measured.rows) {
        stableFrames = 0;
        options.applySize(measured);
      } else {
        stableFrames += 1;
      }
      if (stableFrames >= POST_SPAWN_STABLE_FRAMES_REQUIRED) {
        return;
      }
    } else {
      stableFrames = 0;
    }
    if (totalFrames < POST_SPAWN_MAX_FRAMES) {
      frameId = requestFrame(step);
    }
  };

  frameId = requestFrame(step);
  return () => {
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
  };
}
