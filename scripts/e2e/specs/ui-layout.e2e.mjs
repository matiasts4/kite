import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertNoSiblingOverlap,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';
import { prepareFakeDriverSandbox } from '../fake-driver/setup.mjs';
import {
  closeRightDockIfOpen,
  enterActiveThreadComposer,
  openNewThreadFromHeader,
  openSubagentsRightDockTab,
  selectThreadProvider,
  submitThreadPrompt,
} from '../helpers/thread-helpers.mjs';

export const meta = {
  id: 'UI-LAYOUT-01',
  title: 'Verify desktop geometry across standard/compact viewports, no overflow/overlap, and zero forced clicks',
};

const SCENARIO = {
  rules: [
    {
      driver: 'claude',
      promptIncludes: 'UI layout check alpha',
      steps: [{ delayMs: 80, textDelta: 'LAYOUT_ALPHA_OK' }],
    },
    {
      driver: 'claude',
      promptIncludes: 'UI layout check beta',
      steps: [{ delayMs: 80, textDelta: 'LAYOUT_BETA_OK' }],
    },
  ],
};

export const launchOptions = {
  setupSandbox: async (sandbox) => {
    await prepareFakeDriverSandbox(sandbox, SCENARIO);
  },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(__dirname, '..');

async function assertZeroForcedInteractions() {
  const forbiddenPattern = new RegExp(['force', ':', '\\s*true'].join(''));
  const offenders = [];

  for (const relDir of ['specs', 'helpers']) {
    const dirPath = path.join(E2E_ROOT, relDir);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      const filePath = path.join(dirPath, entry.name);
      const source = await fs.readFile(filePath, 'utf8');
      const codeOnly = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      if (forbiddenPattern.test(codeOnly)) {
        offenders.push(`${relDir}/${entry.name}`);
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(`Forced click option prohibited in E2E suite: ${offenders.join(', ')}`);
  }
}

async function runViewportGeometryAudit(page, artifactsDir, tag, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(180);

  await captureArtifactScreenshot(page, artifactsDir, `${tag}-${width}x${height}`);

  await assertNoHorizontalOverflow(page, `${tag} (${width}x${height})`, [
    '.titlebar',
    'section.chat-surface--thread',
    '.kite-composer-shell',
  ]);

  await assertVisibleAndClickableRect(
    page.locator('fieldset[aria-label="Work mode"] button[data-label="Thread"]'),
    `TitleBar Thread toggle at ${tag}`,
  );
  await assertVisibleAndClickableRect(
    page.locator('.chat-surface--thread textarea.kite-composer-textarea').first(),
    `Thread composer textarea at ${tag}`,
  );
  await assertVisibleAndClickableRect(
    page.locator('.chat-surface--thread button[role="combobox"][aria-label="Model"]').first(),
    `Thread composer Model combobox at ${tag}`,
  );

  await assertNoSiblingOverlap(
    page.locator('fieldset[aria-label="Work mode"] button'),
    `TitleBar Work mode buttons at ${tag}`,
    { minCount: 3 },
  );
  await assertNoSiblingOverlap(
    page.locator('.titlebar__leading > *'),
    `TitleBar leading lockup vs switcher at ${tag}`,
    { minCount: 2 },
  );
  await assertNoSiblingOverlap(
    page.locator('.titlebar__trailing button'),
    `TitleBar trailing controls at ${tag}`,
    { minCount: 3 },
  );
  await assertNoSiblingOverlap(
    page.locator('.chat-surface--thread .kite-composer-footer button'),
    `Thread composer footer controls at ${tag}`,
    { minCount: 3 },
  );
  await assertNoSiblingOverlap(
    page.locator('.chat-rail__band--settled .chat-thread-row'),
    `Sidebar settled thread rows at ${tag}`,
    { minCount: 2 },
  );
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

  await assertZeroForcedInteractions();
  await assertNativeTauriShell(page);
  await waitForBootCoverCleared(page);

  await page.setViewportSize({ width: 1366, height: 840 });
  await enterActiveThreadComposer(page);
  await selectThreadProvider(page, 'Claude Code');
  await submitThreadPrompt(page, 'UI layout check alpha');

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('LAYOUT_ALPHA_OK'),
      ),
    null,
    { timeout: 15_000 },
  );

  await openNewThreadFromHeader(page);
  await selectThreadProvider(page, 'Claude Code');
  await submitThreadPrompt(page, 'UI layout check beta');

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('LAYOUT_BETA_OK'),
      ) &&
      document.querySelectorAll('.chat-rail__band--settled .chat-thread-row').length >= 2,
    null,
    { timeout: 15_000 },
  );

  // Immediately inspect Settled band before transition settle, then allow motion settle for full audit.
  await captureArtifactScreenshot(page, artifactsDir, '00-settled-immediate');
  await assertNoSiblingOverlap(
    page.locator('.chat-rail__band--settled .chat-thread-row'),
    'Sidebar settled rows immediately after transition',
    { minCount: 2 },
  );

  await page.waitForTimeout(500);
  await closeRightDockIfOpen(page);
  await runViewportGeometryAudit(page, artifactsDir, '01-standard-closed-dock', 1366, 840);

  await openSubagentsRightDockTab(page);
  await runViewportGeometryAudit(page, artifactsDir, '02-standard-open-dock', 1366, 840);

  await closeRightDockIfOpen(page);
  await runViewportGeometryAudit(page, artifactsDir, '03-compact-closed-dock', 960, 680);

  await openSubagentsRightDockTab(page);
  await runViewportGeometryAudit(page, artifactsDir, '04-compact-open-dock', 960, 680);

  if (pageErrors.length > 0) {
    throw new Error(`Unexpected uncaught page errors during UI-LAYOUT-01: ${pageErrors.join(' | ')}`);
  }
}
