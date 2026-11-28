import http from 'node:http';
import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';
import { prepareFakeDriverSandbox } from '../fake-driver/setup.mjs';

export const meta = {
  id: 'BROWSER-AGENT-01',
  title:
    'Verify native WebView2 CDP snapshots, kite-ctx reuse, multi-tab agent takeover/resume, local server discovery, and compact layout',
};

export const launchOptions = {
  setupSandbox: async (sandbox) => {
    await prepareFakeDriverSandbox(sandbox, { rules: [] });
  },
};

const TEST_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Kite E2E Browser Target</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; background: #101218; color: #f4f6fb; }
      header, nav, main { padding: 12px; margin-bottom: 12px; border: 1px solid #2a3140; border-radius: 8px; }
      button { padding: 8px 14px; border-radius: 8px; border: 1px solid #5c8fff; background: #1f2b44; color: #fff; cursor: pointer; }
    </style>
  </head>
  <body>
    <header role="banner"><strong>Kite Target Header</strong></header>
    <nav role="navigation"><a href="#overview">Overview</a> | <a href="#settings">Settings</a></nav>
    <main role="main">
      <h1>Kite E2E Browser Target</h1>
      <p>Counter value: <span id="count">0</span></p>
      <label for="note-input">Note</label>
      <input id="note-input" aria-label="Note" placeholder="Type a note" />
      <button id="inc-btn" type="button">Increment Counter</button>
    </main>
    <script>
      let count = 0;
      document.getElementById('inc-btn').addEventListener('click', () => {
        count += 1;
        document.getElementById('count').textContent = String(count);
      });
    </script>
  </body>
</html>`;

const CANDIDATE_DEV_PORTS = [4173, 4321, 5174, 5175, 5500, 8081, 8888, 3001];

async function startLocalTargetServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE_HTML);
  });

  for (const port of CANDIDATE_DEV_PORTS) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return { server, port, url: `http://127.0.0.1:${port}/` };
    } catch {
      // Try next common dev port.
    }
  }

  throw new Error('Could not bind any candidate localhost dev port for browser-agent E2E target.');
}

async function openBrowserRightDockTab(page) {
  const browserTabSelect = page.locator('.side-panel-tab[data-kind="browser"] button.side-panel-tab__select');
  if (await browserTabSelect.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(browserTabSelect, 'RightDock Browser tab');
    await browserTabSelect.click();
    return;
  }

  const toggleBtn = page.locator('[data-testid="side-panel-toggle"]');
  await assertVisibleAndClickableRect(toggleBtn, 'TitleBar side panel toggle');
  const dockAside = page.locator('[data-testid="app-browser-sidebar"]');
  const toggleSelected = await toggleBtn.evaluate((el) =>
    el.classList.contains('chrome-button--selected') || el.getAttribute('aria-pressed') === 'true'
  );
  if (!toggleSelected && !(await dockAside.isVisible().catch(() => false))) {
    await toggleBtn.click();
  }
  await dockAside.waitFor({ state: 'visible', timeout: 25_000 });

  if (await browserTabSelect.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(browserTabSelect, 'RightDock Browser tab');
    await browserTabSelect.click();
    return;
  }

  const newTabBtn = dockAside.locator('button[aria-label="New tab"]').first();
  await assertVisibleAndClickableRect(newTabBtn, 'RightDock New tab button');
  await newTabBtn.click();

  const newTabMenu = page.locator('[role="menu"][aria-label="New tab"]');
  await newTabMenu.waitFor({ state: 'visible', timeout: 5_000 });
  const browserItem = newTabMenu
    .locator('[role="menuitem"]')
    .filter({ has: page.locator('.ui-menu__row-title', { hasText: /^Browser$/ }) })
    .first();
  await assertVisibleAndClickableRect(browserItem, 'RightDock New tab -> Browser menu item');
  await browserItem.click();

  await browserTabSelect.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await browserTabSelect.getAttribute('aria-selected')) !== 'true') {
    await assertVisibleAndClickableRect(browserTabSelect, 'RightDock Browser tab');
    await browserTabSelect.click();
  }
}

async function invokeBrowserAgent(page, payload) {
  return page.evaluate(async (req) => {
    const internals = window.__TAURI_INTERNALS__;
    return internals.invoke('browser_agent_action', {
      request: { supportedSchemaVersion: 1, ...req },
    });
  }, payload);
}

/**
 * @param {{
 *   page: import('playwright-core').Page,
 *   artifactsDir: string,
 *   pageErrors: string[],
 * }} ctx
 */
export async function run(ctx) {
  const { page, artifactsDir, pageErrors } = ctx;
  const target = await startLocalTargetServer();
  let openedSurfaceId = null;

  try {
    await assertNativeTauriShell(page);
    await waitForBootCoverCleared(page);
    await page.setViewportSize({ width: 1366, height: 840 });

    // 1. Open RightDock -> Browser tab and verify clean start surface + zero overflow.
    await openBrowserRightDockTab(page);
    const browserPane = page.locator('[data-testid="app-browser-pane"]');
    await browserPane.waitFor({ state: 'visible', timeout: 15_000 });
    await assertNoHorizontalOverflow(page, 'BrowserView start screen 1366x840');
    await captureArtifactScreenshot(page, artifactsDir, '01-browser-start-1366x840');

    // 2. Verify Local Dev Servers discovery popover detects our live loopback server.
    const serversBtn = page.locator('[data-testid="browser-local-servers-btn"]');
    await assertVisibleAndClickableRect(serversBtn, 'Browser Local Servers toolbar button');
    await serversBtn.click();

    const serversPopover = page.locator('[data-testid="browser-servers-popover"]');
    await serversPopover.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForFunction(
      (port) => {
        const pop = document.querySelector('[data-testid="browser-servers-popover"]');
        return Boolean(pop && pop.textContent && pop.textContent.includes(`:${port}`));
      },
      target.port,
      { timeout: 12_000 },
    );
    await captureArtifactScreenshot(page, artifactsDir, '02-browser-local-servers-1366x840');
    await serversBtn.click();
    await serversPopover.waitFor({ state: 'hidden', timeout: 5_000 });

    // 3. Drive real in-process WebView2 COM CDP via browser_agent_action: open -> snapshot -> cached stub -> batch -> delta.
    const openRes = await invokeBrowserAgent(page, {
      action: 'open',
      url: target.url,
      background: false,
      threadId: 'e2e-browser-thread',
      sessionId: 'e2e-browser-sess',
    });
    if (!openRes?.ok || !openRes?.surfaceId) {
      throw new Error(`Expected browser_agent_action open ok=true, got: ${JSON.stringify(openRes)}`);
    }
    openedSurfaceId = openRes.surfaceId;

    // Wait briefly for the child WebView2 document to finish rendering our target HTML.
    let snap1 = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = await invokeBrowserAgent(page, {
        action: 'snapshot',
        surfaceId: openedSurfaceId,
        sessionId: 'e2e-browser-sess',
        mode: 'auto',
        fresh: attempt === 0,
      });
      if (candidate?.ok && typeof candidate?.snapshot === 'string' && candidate.snapshot.includes('Increment Counter')) {
        snap1 = candidate;
        break;
      }
      await page.waitForTimeout(300);
    }
    if (!snap1) {
      throw new Error('Timed out waiting for WebView2 COM CDP AX snapshot to contain "Increment Counter".');
    }

    // Second identical snapshot must return an unchanged_stub via kite-ctx v3 BrowserReadCache!
    const snap2 = await invokeBrowserAgent(page, {
      action: 'snapshot',
      surfaceId: openedSurfaceId,
      sessionId: 'e2e-browser-sess',
      mode: 'auto',
    });
    if (!snap2?.ok || snap2?.outcome !== 'unchanged_stub') {
      throw new Error(`Expected unchanged_stub on identical re-snapshot, got: ${JSON.stringify(snap2)}`);
    }

    // 4. Select the agent-owned tab in the multi-tab bar and verify live Agent Control Banner.
    const agentTabBtn = page.locator(`[data-testid="browser-tab-${openedSurfaceId}"]`);
    await assertVisibleAndClickableRect(agentTabBtn, 'Multi-tab bar agent tab');
    await agentTabBtn.click();

    const agentBanner = page.locator('[data-testid="browser-agent-banner"]');
    await agentBanner.waitFor({ state: 'visible', timeout: 10_000 });
    await assertNoHorizontalOverflow(page, 'BrowserView agent active 1366x840');
    await captureArtifactScreenshot(page, artifactsDir, '03-browser-agent-active-1366x840');

    // 5. Execute a real batched click + assertion through WebView2 COM CDP and confirm semantic delta or count update.
    const batchRes = await invokeBrowserAgent(page, {
      action: 'batch',
      surfaceId: openedSurfaceId,
      sessionId: 'e2e-browser-sess',
      steps: [
        { op: 'click', selector: '#inc-btn' },
        { op: 'assert_text', text: 'Counter value: 1' },
      ],
      includeSnapshot: true,
    });
    if (!batchRes?.ok) {
      throw new Error(`Expected batched CDP click + assert_text to pass, got: ${JSON.stringify(batchRes)}`);
    }

    // 6. Test one-click Stop / Take Over and Resume Agent on the active agent tab.
    // Re-mark agent active briefly if batch cleared active status, or verify Resume -> Takeover -> Resume cycle.
    const takeoverBtn = page.locator('[data-testid="browser-takeover-btn"]');
    const resumeBtn = page.locator('[data-testid="browser-resume-btn"]');
    if (await resumeBtn.isVisible().catch(() => false)) {
      await assertVisibleAndClickableRect(resumeBtn, 'Resume Agent button');
      await resumeBtn.click();
      await takeoverBtn.waitFor({ state: 'visible', timeout: 10_000 });
    }
    await assertVisibleAndClickableRect(takeoverBtn, 'Stop / Take Over button');
    await takeoverBtn.click();
    await resumeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await captureArtifactScreenshot(page, artifactsDir, '04-browser-takeover-1366x840');

    // 7. Capture screenshot via toolbar button (invokes native capture_browser_surface_screenshot).
    const captureBtn = page.locator('[data-testid="browser-capture-screenshot-btn"]');
    await assertVisibleAndClickableRect(captureBtn, 'Capture screenshot to thread button');
    await captureBtn.click();
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="browser-action-notice"]');
        return Boolean(el && el.textContent && el.textContent.includes('Screenshot attached'));
      },
      null,
      { timeout: 10_000 },
    );
    await captureArtifactScreenshot(page, artifactsDir, '05-browser-screenshot-captured-1366x840');

    // 8. Verify compact 960x680 geometry with zero overflow or clipped controls.
    await page.setViewportSize({ width: 960, height: 680 });
    await page.waitForTimeout(250);
    await assertNoHorizontalOverflow(page, 'BrowserView compact 960x680');
    await captureArtifactScreenshot(page, artifactsDir, '06-browser-compact-960x680');

    if (pageErrors.length > 0) {
      throw new Error(`Uncaught page errors during browser-agent E2E:\n${pageErrors.join('\n')}`);
    }
  } finally {
    if (openedSurfaceId) {
      await invokeBrowserAgent(page, {
        action: 'close',
        surfaceId: openedSurfaceId,
        sessionId: 'e2e-browser-sess',
      }).catch(() => undefined);
    }
    await new Promise((resolve) => target.server.close(() => resolve()));
  }
}
