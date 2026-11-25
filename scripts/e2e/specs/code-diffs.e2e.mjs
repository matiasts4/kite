import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertNoSiblingOverlap,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';

export const meta = {
  id: 'CODE-DIFFS-01',
  title: 'Verify Code mode shell and Diffs/Files surface without overflow or TitleBar overlap',
};

async function openDiffsRightDockTab(page) {
  const tabSelect = page.locator('.side-panel-tab[data-kind="diffs"] button.side-panel-tab__select');
  if (await tabSelect.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Diffs tab');
    await tabSelect.click();
    return true;
  }

  const newTabBtn = page.locator('button[aria-label="New tab"]').first();
  if (!(await newTabBtn.isVisible().catch(() => false))) {
    const toggleBtn = page.locator('[data-testid="side-panel-toggle"]');
    if (!(await toggleBtn.isVisible().catch(() => false))) {
      return false;
    }
    await assertVisibleAndClickableRect(toggleBtn, 'TitleBar side panel toggle');
    await toggleBtn.click();
    await newTabBtn.waitFor({ state: 'visible', timeout: 10_000 });
  }

  if (await tabSelect.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Diffs tab');
    await tabSelect.click();
    return true;
  }

  await assertVisibleAndClickableRect(newTabBtn, 'RightDock New tab button');
  await newTabBtn.click();

  const newTabMenu = page.locator('[role="menu"][aria-label="New tab"]');
  await newTabMenu.waitFor({ state: 'visible', timeout: 5_000 });
  const diffsItem = newTabMenu
    .locator('[role="menuitem"]')
    .filter({ has: page.locator('.ui-menu__row-title', { hasText: /^Diffs$/ }) })
    .first();
  if (!(await diffsItem.isVisible().catch(() => false))) {
    await page.keyboard.press('Escape');
    return false;
  }
  await assertVisibleAndClickableRect(diffsItem, 'RightDock New tab -> Diffs menu item');
  await diffsItem.click();

  await tabSelect.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await tabSelect.getAttribute('aria-selected')) !== 'true') {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Diffs tab');
    await tabSelect.click();
  }
  return true;
}

async function auditCodeViewport(page, artifactsDir, tag, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(180);

  await assertNoHorizontalOverflow(page, `${tag} (${width}x${height})`, [
    '.titlebar',
    'section.workspace-pane-canvas',
    'section.code-empty',
    'section.empty-roster-surface',
    '[data-testid="app-browser-sidebar"]',
  ]);

  await assertNoSiblingOverlap(
    page.locator('fieldset[aria-label="Work mode"] button'),
    `TitleBar Work mode buttons at ${tag}`,
    { minCount: 3 },
  );
  await assertNoSiblingOverlap(
    page.locator('.titlebar__trailing button'),
    `TitleBar trailing controls at ${tag}`,
    { minCount: 3 },
  );

  await captureArtifactScreenshot(page, artifactsDir, tag);
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

  await assertNativeTauriShell(page);
  await waitForBootCoverCleared(page);
  await page.setViewportSize({ width: 1366, height: 840 });

  // 1. Switch to Code work mode via genuine TitleBar toggle click.
  const codeModeBtn = page.locator('fieldset[aria-label="Work mode"] button[data-label="Code"]');
  await assertVisibleAndClickableRect(codeModeBtn, 'TitleBar Code mode toggle');
  if ((await codeModeBtn.getAttribute('aria-pressed')) !== 'true') {
    await codeModeBtn.click();
  }

  const pressed = await codeModeBtn.getAttribute('aria-pressed');
  if (pressed !== 'true') {
    throw new Error(`Expected Code mode button aria-pressed="true", got ${JSON.stringify(pressed)}`);
  }

  // 2. Wait for CodeWorkspace (pane canvas, empty workspace launcher, or CodeHome) to mount.
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('section.workspace-pane-canvas') ||
          document.querySelector('section.code-empty') ||
          document.querySelector('section.empty-roster-surface'),
      ),
    null,
    { timeout: 15_000 },
  );

  // 3. Open Diffs surface in RightDock if reachable in the isolated workspace.
  await openDiffsRightDockTab(page);

  await auditCodeViewport(page, artifactsDir, '01-code-mode-1366x840', 1366, 840);
  await auditCodeViewport(page, artifactsDir, '02-code-mode-compact-960x680', 960, 680);

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during CODE-DIFFS-01:\n${pageErrors.join('\n')}`);
  }
}
