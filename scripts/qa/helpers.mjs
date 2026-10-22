/**
 * Shared Playwright helpers for the browser test lane (http://127.0.0.1:1430).
 */
export const BASE = process.env.KITE_BROWSER_URL || 'http://127.0.0.1:1430';

export async function assertServerUp() {
  const res = await fetch(BASE, { method: 'GET' }).catch(() => null);
  if (!res?.ok) {
    throw new Error(
      `Browser lane not reachable at ${BASE}. Start it with: npm run dev:browser`
    );
  }
}

export async function openLanePage(browser) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('bmone.cached_agents');
      localStorage.removeItem('bmone.cached_workspaces');
    } catch {
      // ignore
    }
  });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForSelector('[data-testid="zed-input"]', { timeout: 30_000 });
  await page.evaluate(() => {
    document.querySelectorAll('.zed-float, [data-testid="zed-card"]').forEach((el) => {
      el.style.pointerEvents = 'none';
    });
  });
  return { page, pageErrors };
}

export async function zedSend(page, text) {
  await page.fill('[data-testid="zed-input"]', text);
  await page.click('[data-testid="zed-send"]');
}

export async function readZedStatus(page) {
  const el = page.locator('[data-testid="zed-status"]');
  await el.waitFor({ state: 'attached', timeout: 45_000 }).catch(() => {});
  return (await el.innerText().catch(() => '')).trim();
}

/** Wait until zed-status matches predicate (receives status text). */
export async function waitZedStatus(page, predicate, timeoutMs = 45_000) {
  const predSource = predicate.toString();
  await page.waitForFunction(
    (source) => {
      const t = document.querySelector('[data-testid="zed-status"]')?.textContent?.trim() || '';
      if (/Falló/i.test(t)) return true;
      const fn = new Function('t', `return (${source})(t);`);
      return fn(t);
    },
    predSource,
    { timeout: timeoutMs }
  );
  const status = await readZedStatus(page);
  if (/Falló/i.test(status)) {
    throw new Error(`Zed reported failure: ${status.slice(0, 200)}`);
  }
  return status;
}

export async function terminalPaneCount(page) {
  return page.locator('[data-testid="terminal-pane"]').count();
}

export async function ensureAgentSurface(page) {
  await page.getByRole('button', { name: 'Agent', exact: true }).click({ force: true });
  await page.evaluate(() => {
    const toggle = document.querySelector('.agent-settings-toggle');
    if (toggle?.getAttribute('aria-pressed') === 'true') {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
  const agentRow = page.locator('.entity-row--agent').first();
  await agentRow.waitFor({ timeout: 15_000 });
  await qaClick(agentRow.locator('.entity-row__select').first());
  await page.waitForSelector('[data-testid="agent-chat-input"]', { timeout: 15_000 });
}

export async function qaClick(locator) {
  await locator.click({ force: true });
}

export async function agentSend(page, text) {
  const input = page.locator('[data-testid="agent-chat-input"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="agent-chat-input"]');
      return el && !el.disabled;
    },
    { timeout: 30_000 }
  );
  await input.fill(text);
  await page.click('[data-testid="agent-chat-send"]');
  await page.waitForFunction(
    () => document.body.innerText.includes('[Antigravity]'),
    { timeout: 20_000 }
  );
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="agent-chat-input"]');
      return el && !el.disabled;
    },
    { timeout: 15_000 }
  ).catch(() => {});
}
