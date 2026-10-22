/**
 * Smoke tests for npm run dev:browser (Playwright — no Tauri / no Ego required).
 */
import { chromium } from 'playwright-core';
import {
  assertServerUp,
  openLanePage,
  zedSend,
  waitZedStatus,
  ensureAgentSurface,
  agentSend,
  readZedStatus,
} from './qa/helpers.mjs';

async function main() {
  await assertServerUp();
  const browser = await chromium.launch({ headless: true });
  const { page, pageErrors } = await openLanePage(browser);

  await zedSend(page, 'abre 2 terminales con antigravity');
  const zedStatus = await waitZedStatus(
    page,
    (t) => /Listo|terminales|Abrí|Acción|\d+ms/i.test(t)
  );

  await ensureAgentSurface(page);
  await agentSend(page, 'ping antigravity smoke');
  await page.waitForFunction(
    () => document.body.innerText.includes('[Antigravity]'),
    { timeout: 20_000 }
  );

  const agentRoster = page.locator('section[aria-label="Agents"]').first();
  const claudeInRoster = await page.getByText('Claude Code').count();
  if (claudeInRoster > 0) {
    throw new Error('Browser lane should expose Antigravity only in agent roster');
  }

  await zedSend(page, 'qué está haciendo Orion');
  await waitZedStatus(
    page,
    (t) => /Orion|ipc\.ts|Propuse|está|\[Orion\]/i.test(t)
  );
  const zedSummary = await readZedStatus(page);

  console.log('[browser-lane-smoke] OK');
  console.log('  Zed spawn:', zedStatus.slice(0, 120));
  console.log('  Zed summary:', zedSummary.slice(0, 160));
  if (pageErrors.length) {
    console.warn('[browser-lane-smoke] page errors:', pageErrors.slice(0, 3));
  }

  await browser.close();
}

main().catch((err) => {
  console.error('[browser-lane-smoke] FAILED:', err.message || err);
  process.exit(1);
});
