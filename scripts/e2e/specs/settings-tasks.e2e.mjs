import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertNoSiblingOverlap,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';

export const meta = {
  id: 'SETTINGS-TASKS-01',
  title: 'Verify Settings modal tabs, clean close, and Kite Tasks (TicketsView) at standard/compact viewports',
};

async function openTasksRightDockTab(page) {
  const tabSelect = page.locator('.side-panel-tab[data-kind="tasks"] button.side-panel-tab__select');
  if (await tabSelect.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Tasks tab');
    await tabSelect.click();
    return;
  }

  const newTabBtn = page.locator('button[aria-label="New tab"]').first();
  if (!(await newTabBtn.isVisible().catch(() => false))) {
    const toggleBtn = page.locator('[data-testid="side-panel-toggle"]');
    await assertVisibleAndClickableRect(toggleBtn, 'TitleBar side panel toggle');
    await toggleBtn.click();
    await newTabBtn.waitFor({ state: 'visible', timeout: 10_000 });
  }

  if (await tabSelect.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Tasks tab');
    await tabSelect.click();
    return;
  }

  await assertVisibleAndClickableRect(newTabBtn, 'RightDock New tab button');
  await newTabBtn.click();

  const newTabMenu = page.locator('[role="menu"][aria-label="New tab"]');
  await newTabMenu.waitFor({ state: 'visible', timeout: 5_000 });
  const tasksItem = newTabMenu
    .locator('[role="menuitem"]')
    .filter({ has: page.locator('.ui-menu__row-title', { hasText: /^Tasks$/ }) })
    .first();
  await assertVisibleAndClickableRect(tasksItem, 'RightDock New tab -> Tasks menu item');
  await tasksItem.click();

  await tabSelect.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await tabSelect.getAttribute('aria-selected')) !== 'true') {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Tasks tab');
    await tabSelect.click();
  }
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

  // 1. Open Settings via genuine click on the Sidebar Footer Settings button.
  const settingsBtn = page.locator('.sidebar__footer button[aria-label="Settings"]');
  await assertVisibleAndClickableRect(settingsBtn, 'Sidebar Footer Settings button');
  await settingsBtn.click();

  const backdrop = page.locator('[data-testid="settings-modal-backdrop"]');
  const dialog = page.locator('div[role="dialog"][aria-labelledby="settings-heading"]');
  await backdrop.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });

  // 2. Verify Settings tabs switch cleanly via genuine clicks with zero overlap/overflow.
  const tabsToVerify = [
    { id: 'general', screenshot: '01-settings-general-1366x840' },
    { id: 'quotas', screenshot: '01b-settings-quotas-1366x840' },
    { id: 'customizations', screenshot: '02-settings-customizations-1366x840' },
    { id: 'notifications', screenshot: '03-settings-notifications-1366x840' },
    { id: 'zed', screenshot: null },
    { id: 'subagents', screenshot: null },
  ];

  for (const tab of tabsToVerify) {
    const navBtn = dialog.locator(`button[data-settings-nav="${tab.id}"]`);
    await assertVisibleAndClickableRect(navBtn, `Settings nav tab "${tab.id}"`);
    await navBtn.click();

    const pane = dialog.locator(`section.application-settings-pane[data-settings-tab="${tab.id}"]`);
    await pane.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(180);

    await assertNoHorizontalOverflow(page, `Settings tab ${tab.id} (1366x840)`, [
      '.application-settings-pane',
      '.application-settings__column',
    ]);
    await assertNoSiblingOverlap(
      dialog.locator('.settings-rail .settings-rail__row'),
      `Settings rail rows (${tab.id})`,
      { minCount: 4 },
    );

    if (tab.id === 'quotas') {
      const connPanel = pane.locator('.qt-conn-panel').first();
      if (!(await connPanel.isVisible().catch(() => false))) {
        const addBtn = pane.getByRole('button', { name: /\+ Agregar proveedor/i }).first();
        if (await addBtn.isVisible().catch(() => false)) {
          await addBtn.click();
          const addModal = page.locator('div[role="dialog"]', { hasText: 'Agregar proveedores de IA' });
          await addModal.waitFor({ state: 'visible', timeout: 5_000 });
          const agyCard = addModal.locator('.qt-provider-pick-card', { hasText: 'Antigravity' }).first();
          await agyCard.click();
          const confirmBtn = addModal.getByRole('button', { name: /Agregar 1 proveedor/i });
          await confirmBtn.click();
          await addModal.waitFor({ state: 'hidden', timeout: 5_000 });
        }
      }
      if (await connPanel.isVisible().catch(() => false)) {
        await connPanel.scrollIntoViewIfNeeded();
        await page.waitForTimeout(160);
        await assertNoHorizontalOverflow(page, 'Settings Quotas ProviderConnectionPanel (1366x840)', [
          '.qt-conn-panel',
        ]);
        const nestedCount = await connPanel.locator('.qt-cli-row .qt-lifecycle').count();
        if (nestedCount > 0) {
          throw new Error('ProviderConnectionPanel .qt-lifecycle must not be nested inside .qt-cli-row');
        }
      }
    }

    if (tab.id === 'customizations') {
      // Exercise agent activity indicator color swatches + custom in-app ColorPickerPopover
      const cyanBtn = pane.locator('button.customizations-indicator-swatch[aria-label="Cian"]');
      await assertVisibleAndClickableRect(cyanBtn, 'Indicator Cian swatch');
      await cyanBtn.click();
      await page.waitForTimeout(100);
      const previewIndicator = pane.locator('[data-testid="agent-indicator-live-preview"] [data-testid="agent-status-indicator"]').first();
      const colorMode = await previewIndicator.getAttribute('data-color-mode');
      if (colorMode !== 'cyan') {
        throw new Error(`Expected indicator color mode "cyan" after clicking Cian swatch, got "${colorMode}"`);
      }

      const customTrigger = pane.locator('button[aria-label="Color personalizado del indicador"]');
      await assertVisibleAndClickableRect(customTrigger, 'Indicator custom color popover trigger');
      await customTrigger.click();
      const popover = page.locator('[data-testid="color-picker-popover"]');
      await popover.waitFor({ state: 'visible', timeout: 5_000 });
      await captureArtifactScreenshot(page, artifactsDir, '02b-settings-color-picker-1366x840');
      const hexInput = popover.locator('input[aria-label="Código hexadecimal"]');
      await hexInput.fill('#22d3ee');
      await hexInput.press('Enter');
      await popover.waitFor({ state: 'hidden', timeout: 5_000 });
      const customMode = await previewIndicator.getAttribute('data-color-mode');
      if (customMode !== '#22d3ee') {
        throw new Error(`Expected indicator color mode "#22d3ee" after hex input, got "${customMode}"`);
      }

      // Scroll down to verify new backdrops and animated hero figures render cleanly
      const backdropHeading = pane.locator('h2', { hasText: 'Fondo de Escenario y Atmósfera' });
      await backdropHeading.scrollIntoViewIfNeeded();
      await page.waitForTimeout(220);
      await captureArtifactScreenshot(page, artifactsDir, '02c-settings-backdrops-figures-1366x840');

      const figureHeading = pane.locator('h2', { hasText: 'Figuras de portada y marca de agua' });
      await figureHeading.scrollIntoViewIfNeeded();
      await page.waitForTimeout(220);
      await captureArtifactScreenshot(page, artifactsDir, '02d-settings-hero-figures-1366x840');
    }

    if (tab.screenshot) {
      await captureArtifactScreenshot(page, artifactsDir, tab.screenshot);
    }
  }

  // 3. Close Settings cleanly via the modal close button.
  const closeBtn = dialog.locator('button.settings-modal-close');
  await assertVisibleAndClickableRect(closeBtn, 'Settings modal close button');
  await closeBtn.click();
  await backdrop.waitFor({ state: 'hidden', timeout: 10_000 });

  // 4. Open Kite Tasks (TicketsView) via RightDock tab navigation.
  await openTasksRightDockTab(page);
  const ticketsPane = page.locator('section.tickets-pane[aria-label="Tasks"]');
  await ticketsPane.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(180);

  await assertNoHorizontalOverflow(page, 'Tasks view (1366x840)', [
    '.titlebar',
    '[data-testid="app-browser-sidebar"]',
    'section.tickets-pane',
  ]);
  await captureArtifactScreenshot(page, artifactsDir, '03-tasks-view-1366x840');

  // 5. Verify compact viewport (960x680) on Tasks view.
  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForTimeout(180);

  await assertNoHorizontalOverflow(page, 'Tasks view compact (960x680)', [
    '.titlebar',
    '[data-testid="app-browser-sidebar"]',
    'section.tickets-pane',
  ]);
  await captureArtifactScreenshot(page, artifactsDir, '04-tasks-compact-960x680');

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during SETTINGS-TASKS-01:\n${pageErrors.join('\n')}`);
  }
}
