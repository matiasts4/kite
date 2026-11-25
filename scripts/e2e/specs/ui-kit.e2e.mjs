import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertNoSiblingOverlap,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';

export const meta = {
  id: 'UI-KIT-01',
  title: 'Verify dev-only ?ui-kit=1 primitives gallery, interactive modal/tabs, and zero overflow/overlap',
};

async function auditUiKitViewport(page, artifactsDir, tag, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(180);

  await assertNoHorizontalOverflow(page, `${tag} (${width}x${height})`, [
    '[data-testid="ui-kit-root"]',
  ]);

  const tabCount = await page.locator('[data-testid="ui-kit-root"] [role="tablist"] [role="tab"]').count();
  if (tabCount >= 2) {
    await assertNoSiblingOverlap(
      page.locator('[data-testid="ui-kit-root"] [role="tablist"] [role="tab"]'),
      `UI Kit tabs at ${tag}`,
      { minCount: 2 },
    );
  }

  const buttonRowCount = await page.locator('[data-testid="ui-kit-button-row"] button').count();
  if (buttonRowCount >= 2) {
    await assertNoSiblingOverlap(
      page.locator('[data-testid="ui-kit-button-row"] button'),
      `UI Kit button row at ${tag}`,
      { minCount: 2 },
    );
  }

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

  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/?ui-kit=1`, { waitUntil: 'domcontentloaded' });

  const uiKitRoot = page.locator('[data-testid="ui-kit-root"]');
  await uiKitRoot.waitFor({ state: 'visible', timeout: 15_000 });

  await auditUiKitViewport(page, artifactsDir, '01-ui-kit-standard-1366x840', 1366, 840);

  // Test interactive tabs via genuine clicks.
  const tabs = uiKitRoot.locator('[role="tablist"] [role="tab"]');
  const tabCount = await tabs.count();
  if (tabCount >= 2) {
    const secondTab = tabs.nth(1);
    await assertVisibleAndClickableRect(secondTab, 'UI Kit second tab');
    await secondTab.click();
    const selected = await secondTab.getAttribute('aria-selected');
    if (selected !== 'true') {
      throw new Error(`Expected second UI Kit tab aria-selected="true", got ${JSON.stringify(selected)}`);
    }
  }

  // Test interactive modal open and clean close.
  const openModalBtn = page.locator('[data-testid="ui-kit-open-modal"]');
  await assertVisibleAndClickableRect(openModalBtn, 'UI Kit open modal button');
  await openModalBtn.click();

  const modalDialog = page.locator('[role="dialog"]').first();
  await modalDialog.waitFor({ state: 'visible', timeout: 10_000 });

  const closeModalBtn = modalDialog.locator('button[aria-label="Close"], button:has-text("Close"), button:has-text("Cancel")').first();
  if (await closeModalBtn.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(closeModalBtn, 'UI Kit modal close button');
    await closeModalBtn.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await modalDialog.waitFor({ state: 'hidden', timeout: 10_000 });

  await auditUiKitViewport(page, artifactsDir, '02-ui-kit-compact-960x680', 960, 680);

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during UI-KIT-01:\n${pageErrors.join('\n')}`);
  }
}
