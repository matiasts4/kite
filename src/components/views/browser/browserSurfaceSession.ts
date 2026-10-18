/*
 * Browser surface session: the state machine behind the native WebView2 child.
 * It has no React dependency so the lifecycle can be exercised directly with a fake IPC layer.
 */
import type { BrowserSurfaceView } from '../../../types';
import type {
  BrowserBoundsInput,
  BrowserControlAction,
  BrowserOwnerRef,
  BrowserTargetRef,
} from '../../../lib/ipc';
import { BROWSER_ADDRESS_NOT_ALLOWED, normalizeBrowserAddress } from './browserAddress';
import {
  DEFAULT_BROWSER_VIEWPORT,
  sameBounds,
  type BrowserBounds,
  type BrowserViewport,
} from './browserGeometry';

export type BrowserPhase = 'blank' | 'creating' | 'ready' | 'error';

export interface BrowserSessionState {
  viewport: BrowserViewport;
  phase: BrowserPhase;
  view: BrowserSurfaceView | null;
  busy: boolean;
  error: string | null;
}

export interface BrowserSurfaceApi {
  create(input: {
    owner: BrowserOwnerRef;
    url: string;
    bounds: BrowserBoundsInput;
    visible: boolean;
  }): Promise<BrowserSurfaceView>;
  navigate(input: { target: BrowserTargetRef; url: string }): Promise<BrowserSurfaceView>;
  control(input: { target: BrowserTargetRef; action: BrowserControlAction }): Promise<BrowserSurfaceView>;
  read(input: { target: BrowserTargetRef }): Promise<BrowserSurfaceView>;
  present(input: {
    target: BrowserTargetRef;
    bounds: BrowserBoundsInput;
    visible: boolean;
  }): Promise<BrowserSurfaceView>;
  close(input: { target: BrowserTargetRef }): Promise<{ closed: boolean }>;
}

export type BrowserMeasure = (element: Element, viewport: BrowserViewport) => BrowserBounds | null;

export const BROWSER_POLL_INTERVAL_MS = 1000;
const CLOSE_RETRY_DELAYS_MS = [0, 60, 240];

export const BROWSER_NATIVE_UNAVAILABLE =
  'Native WebView2 child surface is available in the desktop Tauri window (npm run tauri dev).';
export const NOT_READY = 'The browser pane is not ready yet.';
const OPEN_FAILED = 'The page could not be opened safely.';
const INCONSISTENT = 'The isolated browser surface returned inconsistent state.';
const CONTROL_FAILED = 'The browser control could not be completed.';
const POSITION_FAILED = 'The browser pane could not be positioned safely.';
const STOPPED_RESPONDING = 'The browser pane stopped responding safely.';
const CLOSE_FAILED = 'A browser surface could not be closed safely. Restart the app before continuing.';
const HIDE_FAILED = 'A browser surface could not be hidden safely. Restart the app before continuing.';
const DESIGN_MODE_START_FAILED = 'Select element could not start on this page.';
const DESIGN_MODE_STOP_FAILED = 'Select element could not stop on this page.';

interface PresentationRequest {
  target: BrowserTargetRef;
  bounds: BrowserBounds;
  visible: boolean;
  generation: number;
}

function initialState(viewport: BrowserViewport): BrowserSessionState {
  return { viewport, phase: 'blank', view: null, busy: false, error: null };
}

function targetOf(owner: BrowserOwnerRef, surfaceId: string): BrowserTargetRef {
  return { ...owner, surfaceId };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function isBrowserNotFound(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('browser_not_found');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameView(left: BrowserSurfaceView, right: BrowserSurfaceView): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.surfaceId === right.surfaceId &&
    left.descriptorId === right.descriptorId &&
    left.displayUrl === right.displayUrl &&
    left.transportSecurity === right.transportSecurity &&
    left.title === right.title &&
    left.loading === right.loading &&
    left.canGoBack === right.canGoBack &&
    left.canGoForward === right.canGoForward &&
    left.visible === right.visible &&
    left.designMode === right.designMode
  );
}

function samePresentation(left: PresentationRequest | null, right: PresentationRequest): boolean {
  return (
    left !== null &&
    left.generation === right.generation &&
    left.visible === right.visible &&
    left.target.surfaceId === right.target.surfaceId &&
    left.target.descriptorId === right.target.descriptorId &&
    sameBounds(left.bounds, right.bounds)
  );
}

/**
 * Hides, then closes, a surface. Close is retried briefly because WebView2 may
 * still be tearing down. Returns true only when the native side confirms it.
 */
async function closeSurfaceSafely(
  api: BrowserSurfaceApi,
  target: BrowserTargetRef,
  bounds: BrowserBounds | null
): Promise<boolean> {
  if (bounds !== null) {
    await api.present({ target, bounds, visible: false }).catch(() => undefined);
  }
  for (const delay of CLOSE_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      const result = await api.close({ target });
      if (result.closed) return true;
    } catch (error) {
      if (isBrowserNotFound(error)) return true;
    }
  }
  return false;
}

export class BrowserSurfaceSession {
  private state: BrowserSessionState;
  private readonly listeners = new Set<() => void>();
  private anchor: { element: Element; visible: boolean } | null = null;
  private lastBounds: BrowserBounds | null = null;
  private generation = 0;
  private presentationPending: PresentationRequest | null = null;
  private presentationInFlight: PresentationRequest | null = null;
  private lastAppliedPresentation: PresentationRequest | null = null;
  private presentationDrain: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private occluded = false;
  private disposed = false;
  private pendingCloseTarget: BrowserTargetRef | null = null;
  private retirement: Promise<boolean> | null = null;
  private closing: Promise<boolean> | null = null;

  constructor(
    private readonly owner: BrowserOwnerRef,
    private readonly api: BrowserSurfaceApi,
    private readonly measure: BrowserMeasure,
    private readonly isNative: () => boolean
  ) {
    this.state = initialState({ ...DEFAULT_BROWSER_VIEWPORT });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BrowserSessionState => this.state;

  /** Registers the element that hosts the surface, and whether it is currently visible. */
  setAnchor = (element: Element | null, visible: boolean): void => {
    if (this.disposed) return;
    this.anchor = element === null ? null : { element, visible };
    this.refreshPresentation();
    this.updatePolling();
  };

  /** Recomputes bounds and visibility from the anchor and queues a presentation update if needed. */
  refreshPresentation = (): void => {
    const view = this.state.view;
    if (this.disposed || this.closing !== null || view === null) return;
    const anchor = this.anchor;
    const measured = anchor === null ? null : this.measure(anchor.element, this.state.viewport);
    if (measured !== null) this.lastBounds = measured;
    if (this.lastBounds === null) return;

    const request: PresentationRequest = {
      target: targetOf(this.owner, view.surfaceId),
      bounds: this.lastBounds,
      visible: measured !== null && anchor !== null && anchor.visible && !this.occluded,
      generation: this.generation,
    };
    if (this.presentationInFlight !== null && samePresentation(this.presentationInFlight, request)) {
      this.presentationPending = null;
      return;
    }
    if (
      (this.presentationInFlight === null && samePresentation(this.lastAppliedPresentation, request)) ||
      samePresentation(this.presentationPending, request)
    ) {
      return;
    }
    this.presentationPending = request;
    void this.flushPresentation();
  };

  openAddress = async (raw: string): Promise<boolean> => {
    let url: string;
    try {
      url = normalizeBrowserAddress(raw);
    } catch {
      this.update({ error: BROWSER_ADDRESS_NOT_ALLOWED });
      return false;
    }
    if (this.disposed || this.closing !== null || this.state.busy) return false;
    if (!this.isNative()) {
      this.update({ phase: 'error', busy: false, error: BROWSER_NATIVE_UNAVAILABLE });
      return false;
    }

    const generation = this.generation;
    const current = this.state.view;
    this.update(
      current === null ? { busy: true, error: null, phase: 'creating' } : { busy: true, error: null }
    );
    try {
      if (current === null) {
        const bounds =
          this.visibleAnchorBounds() ??
          this.lastBounds ?? {
            x: 0,
            y: 40,
            width: typeof window !== 'undefined' ? Math.max(800, window.innerWidth) : 800,
            height: typeof window !== 'undefined' ? Math.max(600, window.innerHeight - 40) : 600,
          };
        this.lastBounds = bounds;
        // Created hidden; the first presentation reveals it at the measured bounds.
        const created = await this.api.create({ owner: this.owner, url, bounds, visible: false });
        const target = targetOf(this.owner, created.surfaceId);
        if (this.disposed || generation !== this.generation) {
          void closeSurfaceSafely(this.api, target, bounds);
          return false;
        }
        this.lastAppliedPresentation = { target, bounds, visible: false, generation };
        if (!this.commitView(created)) {
          await closeSurfaceSafely(this.api, target, bounds);
          throw new Error(INCONSISTENT);
        }
      } else {
        const navigated = await this.api.navigate({
          target: targetOf(this.owner, current.surfaceId),
          url,
        });
        if (this.disposed || generation !== this.generation) return false;
        this.commitView(navigated);
      }
      this.update({ busy: false, error: null });
      return true;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return false;
      const message = messageOf(error, OPEN_FAILED);
      if (current === null) {
        this.update({ phase: 'error', busy: false, error: message });
      } else {
        await this.retire(message);
      }
      return false;
    }
  };

  control = async (action: BrowserControlAction): Promise<void> => {
    const view = this.state.view;
    if (this.disposed || this.closing !== null || view === null || this.state.busy) return;
    const generation = this.generation;
    this.update({ busy: true, error: null });
    try {
      const next = await this.api.control({ target: targetOf(this.owner, view.surfaceId), action });
      if (!this.disposed && generation === this.generation) this.commitView(next);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        await this.retire(messageOf(error, CONTROL_FAILED));
      }
    } finally {
      if (!this.disposed && generation === this.generation) this.update({ busy: false });
    }
  };

  setDesignMode = async (enable: boolean): Promise<void> => {
    const view = this.state.view;
    if (
      this.disposed ||
      this.closing !== null ||
      view === null ||
      this.state.busy ||
      view.designMode === enable
    ) {
      return;
    }
    const generation = this.generation;
    this.update({ busy: true, error: null });
    try {
      const next = await this.api.control({
        target: targetOf(this.owner, view.surfaceId),
        action: enable ? 'startDesignMode' : 'stopDesignMode',
      });
      if (!this.disposed && generation === this.generation) this.commitView(next);
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.update({ error: enable ? DESIGN_MODE_START_FAILED : DESIGN_MODE_STOP_FAILED });
      }
    } finally {
      if (!this.disposed && generation === this.generation) this.update({ busy: false });
    }
  };

  retry = async (): Promise<void> => {
    if (this.state.view !== null) await this.control('reload');
  };

  /** Returns to the start screen. Only meaningful when no surface is live. */
  reset = (): void => {
    if (this.disposed || this.state.view !== null) return;
    this.update({ phase: 'blank', view: null, busy: false, error: null });
  };

  setViewport = (viewport: BrowserViewport): void => {
    if (this.disposed || this.closing !== null) return;
    const current = this.state.viewport;
    if (current.mode === viewport.mode && current.landscape === viewport.landscape) return;
    this.update({ viewport: { mode: viewport.mode, landscape: viewport.landscape } });
    this.refreshPresentation();
  };

  /** Hides the surface while a modal is open, and resumes polling when it closes. */
  setOccluded = async (occluded: boolean): Promise<void> => {
    if (this.disposed) return;
    this.occluded = occluded;
    if (occluded) this.clearPoll();
    const retirement = this.retirement;
    if (retirement !== null) {
      if (!(await retirement)) throw new Error(HIDE_FAILED);
      return;
    }
    const closing = this.closing;
    if (closing !== null) {
      if (!(await closing)) throw new Error(HIDE_FAILED);
      return;
    }
    if (this.disposed) return;
    this.refreshPresentation();
    await this.flushPresentation();
    this.updatePolling();
  };

  close = async (): Promise<void> => {
    if (this.disposed) return;
    const retirement = this.retirement;
    if (retirement !== null) await retirement;
    if (this.disposed) return;
    const closing = this.closing;
    if (closing !== null) {
      if (!(await closing)) throw new Error(CLOSE_FAILED);
      return;
    }
    this.generation += 1;
    this.presentationPending = null;
    this.presentationInFlight = null;
    this.lastAppliedPresentation = null;
    this.clearPoll();
    const view = this.state.view;
    const target = view === null ? this.pendingCloseTarget : targetOf(this.owner, view.surfaceId);
    const closePromise =
      target === null ? Promise.resolve(true) : closeSurfaceSafely(this.api, target, this.lastBounds);
    this.closing = closePromise;
    const closed = await closePromise;
    if (this.closing === closePromise) this.closing = null;
    if (!closed) {
      this.pendingCloseTarget = target;
      this.update({ busy: true, error: CLOSE_FAILED });
      throw new Error(CLOSE_FAILED);
    }
    this.disposed = true;
    this.pendingCloseTarget = null;
    this.update(initialState(this.state.viewport));
    this.listeners.clear();
  };

  private visibleAnchorBounds(): BrowserBounds | null {
    const anchor = this.anchor;
    if (anchor === null || !anchor.visible) return null;
    return this.measure(anchor.element, this.state.viewport);
  }

  private commitView(view: BrowserSurfaceView, refresh = true): boolean {
    if (this.disposed || view.descriptorId !== this.owner.descriptorId) return false;
    const current = this.state.view;
    if (current !== null) {
      if (view.surfaceId !== current.surfaceId || view.revision < current.revision) return false;
      if (view.revision === current.revision) {
        if (!sameView(view, current)) return false;
        this.updatePolling();
        return true;
      }
    }
    this.update({ phase: 'ready', view, busy: false, error: null });
    if (refresh) this.refreshPresentation();
    this.updatePolling();
    return true;
  }

  private flushPresentation(): Promise<void> {
    if (this.presentationDrain !== null) return this.presentationDrain;
    const drain = this.drainPresentationQueue();
    this.presentationDrain = drain;
    void drain.then(() => {
      if (this.presentationDrain === drain) {
        this.presentationDrain = null;
        if (this.presentationPending !== null) void this.flushPresentation();
      }
    });
    return drain;
  }

  /** Sends presentation updates one at a time; the newest pending request wins. */
  private async drainPresentationQueue(): Promise<void> {
    while (this.presentationPending !== null) {
      const request = this.presentationPending;
      this.presentationPending = null;
      if (this.disposed || request.generation !== this.generation) continue;
      this.presentationInFlight = request;
      try {
        const next = await this.api.present({
          target: request.target,
          bounds: request.bounds,
          visible: request.visible,
        });
        if (
          !this.disposed &&
          request.generation === this.generation &&
          this.state.view?.surfaceId === next.surfaceId
        ) {
          this.lastAppliedPresentation = request;
          this.commitView(next, false);
        }
      } catch (error) {
        if (!this.disposed && request.generation === this.generation) {
          await this.retire(messageOf(error, POSITION_FAILED));
        }
        return;
      } finally {
        if (this.presentationInFlight === request) this.presentationInFlight = null;
      }
    }
  }

  /** Tears the surface down after a failure and moves to the error phase. */
  private async retire(message: string): Promise<boolean> {
    const existing = this.retirement;
    if (existing !== null) return existing;
    const closing = this.closing;
    if (closing !== null) return closing;

    const view = this.state.view;
    this.generation += 1;
    this.presentationPending = null;
    this.presentationInFlight = null;
    this.lastAppliedPresentation = null;
    this.clearPoll();
    if (view === null) {
      this.update({ phase: 'error', view: null, busy: false, error: message });
      return true;
    }

    this.update({ busy: true, error: message });
    const target = targetOf(this.owner, view.surfaceId);
    this.pendingCloseTarget = target;
    const retirement = closeSurfaceSafely(this.api, target, this.lastBounds).then((closed) => {
      if (
        closed &&
        this.pendingCloseTarget !== null &&
        this.pendingCloseTarget.surfaceId === target.surfaceId
      ) {
        this.pendingCloseTarget = null;
        this.update({ phase: 'error', view: null, busy: false, error: message });
      } else if (!closed && !this.disposed) {
        this.update({ busy: true, error: CLOSE_FAILED });
      }
      return closed;
    });
    this.retirement = retirement;
    const result = await retirement;
    if (this.retirement === retirement) this.retirement = null;
    return result;
  }

  private updatePolling(): void {
    this.clearPoll();
    const view = this.state.view;
    const anchor = this.anchor;
    if (
      this.disposed ||
      this.occluded ||
      this.state.phase !== 'ready' ||
      view === null ||
      this.pollInFlight ||
      anchor === null ||
      !anchor.visible
    ) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, BROWSER_POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    const view = this.state.view;
    const anchor = this.anchor;
    if (this.disposed || view === null || anchor === null || !anchor.visible) return;
    this.pollInFlight = true;
    const generation = this.generation;
    try {
      const next = await this.api.read({ target: targetOf(this.owner, view.surfaceId) });
      if (!this.disposed && generation === this.generation) this.commitView(next, false);
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        await this.retire(messageOf(error, STOPPED_RESPONDING));
      }
    } finally {
      this.pollInFlight = false;
      if (!this.disposed && generation === this.generation) this.updatePolling();
    }
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private update(partial: Partial<BrowserSessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}
