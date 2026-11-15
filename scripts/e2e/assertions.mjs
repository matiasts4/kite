import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Verifies the connected page is running inside the genuine Tauri WebView2 runtime
 * rather than the HTTP browser mock shim.
 * @param {import('playwright-core').Page} page
 */
export async function assertNativeTauriShell(page) {
  const runtimeInfo = await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    return {
      hasInternals: Boolean(internals),
      isWebIpcShim: Boolean(internals?.__is_web_ipc_shim__),
      hasTransformCallback: typeof internals?.transformCallback === 'function',
      url: window.location.href,
    };
  });

  if (!runtimeInfo.hasInternals || runtimeInfo.isWebIpcShim || !runtimeInfo.hasTransformCallback) {
    throw new Error(
      `Expected real native Tauri runtime, got: ${JSON.stringify(runtimeInfo)}`
    );
  }
  return runtimeInfo;
}

/**
 * Waits until Kite's initial boot cover/intro overlay has fully cleared so genuine pointer
 * actions hit UI controls instead of a transition curtain.
 * @param {import('playwright-core').Page} page
 * @param {number} [timeoutMs=15000]
 */
export async function waitForBootCoverCleared(page, timeoutMs = 15_000) {
  await page.waitForFunction(
    () => {
      const overlays = document.querySelectorAll('.kite-boot-cover, [data-boot-cover], .app-intro');
      for (const overlay of overlays) {
        const style = window.getComputedStyle(overlay);
        if (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.pointerEvents !== 'none' &&
          parseFloat(style.opacity || '1') > 0.05
        ) {
          return false;
        }
      }
      return Boolean(document.querySelector('fieldset[aria-label="Work mode"]'));
    },
    null,
    { timeout: timeoutMs }
  );
}

/**
 * Verifies a control has a positive bounding box inside the viewport and passes a real
 * hit-test (`document.elementFromPoint`) at its center, catching invisible/overlapping blockers.
 * @param {import('playwright-core').Locator} locator
 * @param {string} label
 */
export async function assertVisibleAndClickableRect(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
  const box = await locator.boundingBox();
  if (!box || box.width < 4 || box.height < 4) {
    throw new Error(`Geometric check failed for "${label}": invalid boundingBox ${JSON.stringify(box)}`);
  }

  const page = locator.page();
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  if (
    box.x < -1 ||
    box.y < -1 ||
    box.x + box.width > viewport.width + 1 ||
    box.y + box.height > viewport.height + 1
  ) {
    throw new Error(
      `Viewport overflow for "${label}": rect=${JSON.stringify(box)} viewport=${JSON.stringify(viewport)}`
    );
  }

  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const topEl = document.elementFromPoint(cx, cy);
    const sameOrInside = Boolean(topEl && (topEl === el || el.contains(topEl)));
    return {
      sameOrInside,
      topTag: topEl?.tagName || null,
      topClass: topEl?.className ? String(topEl.className) : null,
    };
  });

  if (!hit.sameOrInside) {
    throw new Error(
      `Hit-test occluded for "${label}": center element is <${hit.topTag} class="${hit.topClass}">`
    );
  }

  return box;
}

/**
 * Captures a PNG screenshot in `artifactsDir` using a safe slug filename.
 * @param {import('playwright-core').Page} page
 * @param {string} artifactsDir
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function captureArtifactScreenshot(page, artifactsDir, name) {
  await fs.mkdir(artifactsDir, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const filePath = path.join(artifactsDir, `${safeName}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  return filePath;
}

/**
 * Asserts no unexpected horizontal overflow on the document root or key layout containers.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} label
 * @param {string[]} [selectors=['.titlebar', 'section.chat-surface--thread', '.kite-composer-shell']]
 */
export async function assertNoHorizontalOverflow(
  page,
  label,
  selectors = ['.titlebar', 'section.chat-surface--thread', '.kite-composer-shell'],
) {
  const violations = await page.evaluate((targetSelectors) => {
    const hits = [];
    const root = document.documentElement;
    if (root && root.scrollWidth > root.clientWidth + 2) {
      hits.push({
        selector: 'document.documentElement',
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
      });
    }
    for (const sel of targetSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (el.scrollWidth > el.clientWidth + 2) {
          hits.push({
            selector: sel,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          });
        }
      }
    }
    return hits;
  }, selectors);

  if (violations.length > 0) {
    const details = violations
      .map((v) => `${v.selector} (scrollWidth=${v.scrollWidth} > clientWidth=${v.clientWidth})`)
      .join('; ');
    throw new Error(`Horizontal overflow detected for "${label}": ${details}`);
  }
}

/**
 * Asserts that no two visible sibling elements matched by `locator` overlap in 2D space.
 *
 * @param {import('playwright-core').Locator} locator
 * @param {string} label
 * @param {{ tolerancePx?: number, minCount?: number }} [options]
 */
export async function assertNoSiblingOverlap(locator, label, options = {}) {
  const { tolerancePx = 2, minCount = 1 } = options;
  const result = await locator.evaluateAll((els, tol) => {
    const entries = [];
    const visibleEls = [];
    for (let index = 0; index < els.length; index += 1) {
      const el = els[index];
      const style = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (
        r.width < 2 ||
        r.height < 2 ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        continue;
      }
      visibleEls.push(el);
      entries.push({
        label:
          el.getAttribute('aria-label') ||
          el.getAttribute('data-thread-id') ||
          el.getAttribute('data-testid') ||
          (el.textContent || '').trim().slice(0, 40) ||
          el.tagName,
        tag: el.tagName,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      });
    }

    const overlaps = [];
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (visibleEls[i].contains(visibleEls[j]) || visibleEls[j].contains(visibleEls[i])) {
          continue;
        }
        const a = entries[i];
        const b = entries[j];
        const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapW > tol && overlapH > tol) {
          overlaps.push({ a, b, overlapW, overlapH });
        }
      }
    }
    return { count: entries.length, overlaps };
  }, tolerancePx);

  if (result.count < minCount) {
    throw new Error(
      `Expected at least ${minCount} visible element(s) for overlap check "${label}", found ${result.count}.`,
    );
  }

  if (result.overlaps.length > 0) {
    const first = result.overlaps[0];
    throw new Error(
      `Sibling overlap detected in "${label}": [${first.a.label}] (<${first.a.tag}> ${first.a.left.toFixed(1)},${first.a.top.toFixed(1)}..${first.a.right.toFixed(1)},${first.a.bottom.toFixed(1)}) overlaps [${first.b.label}] (<${first.b.tag}> ${first.b.left.toFixed(1)},${first.b.top.toFixed(1)}..${first.b.right.toFixed(1)},${first.b.bottom.toFixed(1)}) by ${first.overlapW.toFixed(1)}x${first.overlapH.toFixed(1)}px`,
    );
  }

  return result.count;
}
