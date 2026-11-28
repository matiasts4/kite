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
  waitForThreadSurfaceSettled,
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
    {
      driver: 'claude',
      promptIncludes: 'Workspace inline stream check',
      steps: [
        { delayMs: 250, textDelta: 'WS_STREAM_MID ' },
        { delayMs: 1800, textDelta: 'WS_STREAM_DONE' },
      ],
    },
  ],
};

function buildSeededWorkspaceState(workspaceDir) {
  const baseTs = 1791770000000;
  const threads = [];
  for (let i = 1; i <= 8; i += 1) {
    const ts = baseTs + i * 10_000;
    const tag = String(i).padStart(2, '0');
    const title =
      i === 8
        ? 'Workspace Thread 08 with a very long title to verify hover action clearance'
        : `Workspace Thread ${tag}`;
    threads.push({
      schemaVersion: 1,
      id: `ws-thread-${tag}`,
      revision: 'rev-seed-1',
      title,
      workspaceId: 'ws-alpha',
      provider: 'claude',
      model: 'Automatic',
      effort: 'medium',
      mode: 'agent',
      plan: false,
      status: 'idle',
      isSettled: true,
      hasContent: true,
      createdAtUnixMs: ts,
      updatedAtUnixMs: ts,
      items: [
        { id: `ws-u-${tag}`, kind: 'user', text: `Workspace prompt ${tag}`, createdAtUnixMs: ts },
        { id: `ws-a-${tag}`, kind: 'assistant', text: `Workspace reply ${tag}`, createdAtUnixMs: ts + 50 },
      ],
    });
  }
  return {
    workspaces: [
      {
        id: 'ws-alpha',
        displayName: 'Project Alpha',
        createdAtUnixMs: baseTs,
        lastOpenedAtUnixMs: baseTs,
        pinned: false,
        available: true,
      },
    ],
    paths: {
      'ws-alpha': workspaceDir,
    },
    threads,
    lastProvider: 'claude',
    revision: 1,
  };
}

export const launchOptions = {
  setupSandbox: async (sandbox) => {
    await prepareFakeDriverSandbox(sandbox, SCENARIO);
    const seededState = JSON.stringify(buildSeededWorkspaceState(sandbox.workspaceDir));
    for (const folder of ['Kite Code Dev', 'Kite Code']) {
      const dir = path.join(sandbox.appDataDir, folder);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'state.json'), seededState, 'utf8');
    }
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
  const sidebarNewThreadBtn = page.locator('aside.sidebar button.sidebar__add[aria-label="New thread"]');
  await assertVisibleAndClickableRect(sidebarNewThreadBtn, 'Sidebar New unfoldered thread button (alpha)');
  await sidebarNewThreadBtn.click();
  await waitForThreadSurfaceSettled(page, { expectDraft: true });
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

  await assertVisibleAndClickableRect(sidebarNewThreadBtn, 'Sidebar New unfoldered thread button (beta)');
  await sidebarNewThreadBtn.click();
  await waitForThreadSurfaceSettled(page, { expectDraft: true });
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

  // Verify no separate Working shelf exists and newest thread ("beta") sorts above older ("alpha").
  const settledTitles = await page
    .locator('.chat-rail__band--settled .chat-thread-row .chat-thread-row__title')
    .allInnerTexts();
  const betaIdx = settledTitles.findIndex((t) => t.toLowerCase().includes('beta'));
  const alphaIdx = settledTitles.findIndex((t) => t.toLowerCase().includes('alpha'));
  if (betaIdx === -1 || alphaIdx === -1 || betaIdx >= alphaIdx) {
    throw new Error(
      `Expected newest thread ("beta") above older ("alpha") in Settled list, got: ${JSON.stringify(settledTitles)}`,
    );
  }
  const hasWorkingShelf = await page.locator('[aria-label="Working threads"]').count();
  if (hasWorkingShelf > 0) {
    throw new Error('Expected no separate Working threads shelf in ThreadRoster.');
  }

  await page.waitForTimeout(500);
  await closeRightDockIfOpen(page);
  await runViewportGeometryAudit(page, artifactsDir, '01-standard-closed-dock', 1366, 840);

  await openSubagentsRightDockTab(page);
  await runViewportGeometryAudit(page, artifactsDir, '02-standard-open-dock', 1366, 840);

  await closeRightDockIfOpen(page);
  await runViewportGeometryAudit(page, artifactsDir, '03-compact-closed-dock', 960, 680);

  await openSubagentsRightDockTab(page);
  await runViewportGeometryAudit(page, artifactsDir, '04-compact-open-dock', 960, 680);

  // Part 2 — Workspace folder >=7 threads collapse/expand, hover clearance, auto-reveal, and inline running state.
  await closeRightDockIfOpen(page);
  await page.setViewportSize({ width: 1366, height: 840 });
  await page.waitForTimeout(180);

  const projectList = page.locator('[aria-label="Project Alpha threads"]');
  await projectList.waitFor({ state: 'visible', timeout: 10_000 });
  const collapsedCount = await projectList.locator('.chat-thread-row').count();
  if (collapsedCount !== 6) {
    throw new Error(`Expected 6 collapsed workspace rows, got ${collapsedCount}`);
  }
  const collapsedTitles = await projectList.locator('.chat-thread-row__title').allInnerTexts();
  if (
    !collapsedTitles[0]?.includes('Workspace Thread 08') ||
    !collapsedTitles[5]?.includes('Workspace Thread 03')
  ) {
    throw new Error(`Expected newest-first 08..03 when collapsed, got ${JSON.stringify(collapsedTitles)}`);
  }

  const moreBtn = projectList.locator('.chat-thread-workspace__more');
  await assertVisibleAndClickableRect(moreBtn, 'Project Alpha +2 more toggle');
  const moreText = (await moreBtn.innerText()).trim();
  if (moreText !== '+2 more' || (await moreBtn.getAttribute('aria-expanded')) !== 'false') {
    throw new Error(`Expected "+2 more" collapsed toggle, got ${JSON.stringify(moreText)}`);
  }
  await captureArtifactScreenshot(page, artifactsDir, '05-workspace-collapsed-1366x840');

  // Expand all 8 threads and check hover clearance on long row title.
  await moreBtn.click();
  const expandedCount = await projectList.locator('.chat-thread-row').count();
  if (expandedCount !== 8) {
    throw new Error(`Expected 8 expanded workspace rows, got ${expandedCount}`);
  }
  if (
    (await moreBtn.innerText()).trim() !== 'Show less' ||
    (await moreBtn.getAttribute('aria-expanded')) !== 'true'
  ) {
    throw new Error('Expected toggle to read "Show less" with aria-expanded="true" when expanded.');
  }
  const expandedTitles = await projectList.locator('.chat-thread-row__title').allInnerTexts();
  if (!expandedTitles[0]?.includes('08') || !expandedTitles[7]?.includes('01')) {
    throw new Error(`Expected newest-first 08..01 when expanded, got ${JSON.stringify(expandedTitles)}`);
  }

  const longRow = projectList
    .locator('.chat-thread-row', { hasText: 'Workspace Thread 08' })
    .first();
  await longRow.hover();
  await page.waitForTimeout(120);
  const hoverGeometry = await longRow.evaluate((row) => {
    const title = row.querySelector('.chat-thread-row__title');
    const actions = row.querySelector('.chat-thread-row__actions');
    if (!title || !actions) return null;
    const tRect = title.getBoundingClientRect();
    const aRect = actions.getBoundingClientRect();
    return {
      titleRight: tRect.right,
      actionsLeft: aRect.left,
      actionsOpacity: window.getComputedStyle(actions).opacity,
    };
  });
  if (
    !hoverGeometry ||
    hoverGeometry.actionsOpacity !== '1' ||
    hoverGeometry.titleRight > hoverGeometry.actionsLeft + 1
  ) {
    throw new Error(
      `Expected thread row title to clear hover action pills, got ${JSON.stringify(hoverGeometry)}`,
    );
  }
  await captureArtifactScreenshot(page, artifactsDir, '06-workspace-expanded-hover-1366x840');

  // Collapse back to 6, then auto-reveal hidden 8th thread via search + selection.
  await moreBtn.click();
  if ((await projectList.locator('.chat-thread-row').count()) !== 6) {
    throw new Error('Expected workspace list to collapse back to 6 rows after clicking Show less.');
  }
  const searchInput = page.locator('input[aria-label="Search threads"]');
  await assertVisibleAndClickableRect(searchInput, 'Sidebar thread search input');
  await searchInput.fill('Workspace Thread 01');
  const thread01Row = projectList.locator('.chat-thread-row__select', {
    hasText: 'Workspace Thread 01',
  });
  await assertVisibleAndClickableRect(thread01Row, 'Hidden Workspace Thread 01 filtered via search');
  await thread01Row.click();
  const clearSearchBtn = page.locator('button[aria-label="Clear search"]');
  await assertVisibleAndClickableRect(clearSearchBtn, 'Sidebar clear search button');
  await clearSearchBtn.click();
  if ((await projectList.locator('.chat-thread-row').count()) !== 8) {
    throw new Error('Expected selecting hidden thread to keep Project Alpha auto-expanded after clearing search.');
  }

  // Launch a workspace turn and confirm it stays inline inside Project Alpha without a Working shelf.
  const newWsBtn = page.locator('button[aria-label="New thread in Project Alpha"]');
  await assertVisibleAndClickableRect(newWsBtn, 'Project Alpha New thread button');
  await newWsBtn.click();
  await waitForThreadSurfaceSettled(page, { expectDraft: true });
  await selectThreadProvider(page, 'Claude Code');
  await submitThreadPrompt(page, 'Workspace inline stream check');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('WS_STREAM_MID'),
      ),
    null,
    { timeout: 15_000 },
  );
  if ((await page.locator('[aria-label="Working threads"]').count()) > 0) {
    throw new Error('Expected no separate Working threads shelf while workspace thread runs.');
  }
  const wsRunningCount = await projectList
    .locator('[data-testid="agent-status-indicator"][data-status="running"]')
    .count();
  if (wsRunningCount < 1) {
    throw new Error('Expected inline running indicator inside Project Alpha thread list.');
  }
  await captureArtifactScreenshot(page, artifactsDir, '07-workspace-running-inline-1366x840');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('WS_STREAM_DONE'),
      ) && Boolean(document.querySelector('.chat-thread-header__status--idle')),
    null,
    { timeout: 15_000 },
  );

  if (pageErrors.length > 0) {
    throw new Error(`Unexpected uncaught page errors during UI-LAYOUT-01: ${pageErrors.join(' | ')}`);
  }
}
