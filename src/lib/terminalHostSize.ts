/** Smallest host box that can hold a readable terminal grid. */
export const HOST_MIN_PX = 48;

/**
 * After two samples agree, wait this long and sample once more.
 * A split that lands on the next task does not count as settled.
 */
export const HOST_CONFIRM_MS = 48;

/** If the box never repeats, use the latest usable size instead of spawning blind. */
export const HOST_STABLE_CAP_MS = 800;

export interface HostBox {
  width: number;
  height: number;
}

export type HostBoxVerdict =
  | { kind: 'ignore' }
  | { kind: 'changed'; box: HostBox }
  | { kind: 'stable'; box: HostBox };

/** Decide whether a host measurement is usable and whether it matches the previous one. */
export function hostBoxIsUsable(width: number, height: number): boolean {
  return width >= HOST_MIN_PX && height >= HOST_MIN_PX;
}

export function classifyHostBox(
  previous: HostBox | null,
  width: number,
  height: number,
): HostBoxVerdict {
  if (!hostBoxIsUsable(width, height)) return { kind: 'ignore' };
  const box = { width, height };
  if (previous && previous.width === box.width && previous.height === box.height) {
    return { kind: 'stable', box };
  }
  return { kind: 'changed', box };
}

/**
 * Resolve when the element keeps one usable size.
 * Returns null when `isCancelled` fires before that happens.
 * The cap resolves with the latest usable box so a pane that never repeats
 * a sample still opens, instead of falling back to 80×24.
 */
const SPAWN_SETTLE_MIN_COLS = 50;
const SPAWN_SETTLE_MIN_WIDTH_PX = 360;
const SPAWN_SETTLE_MAX_FRAMES = 4;
const SPAWN_SETTLE_CAP_MS = 60;

/**
 * Short settle before an agent pane is born.
 * Waits until the host is wider than 360px or the width repeats for two frames.
 * Caps at four animation frames or about 60ms so a stuck layout still launches.
 */
export function waitForSpawnGeometry(
  el: HTMLElement | null,
  firstCols: number,
  isCancelled?: () => boolean,
): Promise<void> {
  if (!el || isCancelled?.()) return Promise.resolve();
  const needsSettle = firstCols < SPAWN_SETTLE_MIN_COLS || el.clientWidth <= SPAWN_SETTLE_MIN_WIDTH_PX;
  if (!needsSettle) return Promise.resolve();
  const started = performance.now();
  let previous = el.clientWidth;
  let matched = false;
  const step = (frame: number): Promise<void> => {
    if (frame >= SPAWN_SETTLE_MAX_FRAMES || isCancelled?.()) return Promise.resolve();
    if (performance.now() - started >= SPAWN_SETTLE_CAP_MS && frame > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    }).then(() => {
      if (isCancelled?.()) return;
      const width = el.clientWidth;
      if (width > SPAWN_SETTLE_MIN_WIDTH_PX) return;
      if (width > 0 && width === previous) {
        if (matched) return;
        matched = true;
      } else {
        matched = false;
      }
      previous = width;
      if (performance.now() - started >= SPAWN_SETTLE_CAP_MS) return;
      return step(frame + 1);
    });
  };
  return step(0);
}

export function waitForStableHost(
  el: HTMLElement,
  isCancelled: () => boolean,
): Promise<HostBox | null> {
  return new Promise((resolve) => {
    let previous: HostBox | null = null;
    let latest: HostBox | null = null;
    let settled = false;
    let raf = 0;
    let confirmTimer = 0;

    const clearScheduled = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (confirmTimer) window.clearTimeout(confirmTimer);
      confirmTimer = 0;
    };

    const finish = (box: HostBox | null) => {
      if (settled) return;
      settled = true;
      clearScheduled();
      window.clearTimeout(capTimer);
      observer.disconnect();
      resolve(box);
    };

    const consider = () => {
      if (settled) return;
      if (isCancelled()) {
        finish(null);
        return;
      }
      const verdict = classifyHostBox(previous, el.clientWidth, el.clientHeight);
      if (verdict.kind === 'ignore') {
        previous = null;
        clearScheduled();
        return;
      }
      latest = verdict.box;
      if (verdict.kind === 'changed') {
        previous = verdict.box;
        if (confirmTimer) {
          window.clearTimeout(confirmTimer);
          confirmTimer = 0;
        }
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(() => {
            raf = 0;
            consider();
          });
        });
        return;
      }
      if (confirmTimer) return;
      const confirmed = verdict.box;
      confirmTimer = window.setTimeout(() => {
        confirmTimer = 0;
        if (settled) return;
        if (isCancelled()) {
          finish(null);
          return;
        }
        const again = classifyHostBox(confirmed, el.clientWidth, el.clientHeight);
        if (again.kind === 'stable') finish(again.box);
        else consider();
      }, HOST_CONFIRM_MS);
    };

    const observer = new ResizeObserver(() => consider());
    observer.observe(el);
    const capTimer = window.setTimeout(() => {
      if (isCancelled()) finish(null);
      else finish(latest);
    }, HOST_STABLE_CAP_MS);
    consider();
  });
}
