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
      const bootCover = document.querySelector('.kite-boot-cover, [data-boot-cover]');
      if (bootCover) {
        const style = window.getComputedStyle(bootCover);
        if (style.display !== 'none' && style.pointerEvents !== 'none' && parseFloat(style.opacity || '1') > 0.05) {
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
