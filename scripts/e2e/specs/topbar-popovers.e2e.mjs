import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';

export const meta = {
  id: 'TOPBAR-POPOVERS-01',
  title: 'Verify expanded top-bar popovers (Resources, Quotas, Notifications, Updates) across 1366x840 and 960x680',
};

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

async function assertDialogClean(page, dialogLocator, label) {
  await dialogLocator.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(220);

  const metrics = await dialogLocator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      borderRadius: cs.borderRadius,
      text: el.innerText || '',
    };
  });

  if (
    metrics.left < -1 ||
    metrics.top < -1 ||
    metrics.right > metrics.vw + 2 ||
    metrics.bottom > metrics.vh + 2
  ) {
    throw new Error(
      `Popover "${label}" clips outside viewport: rect=(${metrics.left.toFixed(1)},${metrics.top.toFixed(1)}..${metrics.right.toFixed(1)},${metrics.bottom.toFixed(1)}) viewport=${metrics.vw}x${metrics.vh}`
    );
  }

  if (metrics.scrollW > metrics.clientW + 2) {
    throw new Error(
      `Popover "${label}" overflows horizontally: scrollWidth=${metrics.scrollW} > clientWidth=${metrics.clientW}`
    );
  }

  if (EMOJI_RE.test(metrics.text)) {
    throw new Error(`Unexpected emoji glyph detected inside "${label}"`);
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
  await page.waitForTimeout(350);

  // Wait for SystemResourceBadge initial telemetry poll (2.5s deferred on startup)
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="system-resource-ram-value"]');
      return Boolean(el && el.textContent && !el.textContent.includes('--'));
    },
    null,
    { timeout: 15_000 }
  );

  // 1. System Resource Monitor — Overview, RAM, CPU tabs at 1366x840
  const resourceBadge = page.locator('[data-testid="system-resource-badge"]');
  await assertVisibleAndClickableRect(resourceBadge, 'System Resource Badge');
  await resourceBadge.click();

  const resourceDialog = page.locator('.system-resource-popover[role="dialog"]');
  await assertDialogClean(page, resourceDialog, 'SystemResourcePopover Overview (1366x840)');
  await captureArtifactScreenshot(page, artifactsDir, '01-resource-overview-1366x840');

  const ramTab = resourceDialog.getByRole('tab', { name: 'RAM' });
  await assertVisibleAndClickableRect(ramTab, 'Resource Monitor RAM tab');
  await ramTab.click();
  await assertDialogClean(page, resourceDialog, 'SystemResourcePopover RAM (1366x840)');
  await captureArtifactScreenshot(page, artifactsDir, '02-resource-ram-1366x840');

  const cpuTab = resourceDialog.getByRole('tab', { name: 'CPU' });
  await assertVisibleAndClickableRect(cpuTab, 'Resource Monitor CPU tab');
  await cpuTab.click();
  await assertDialogClean(page, resourceDialog, 'SystemResourcePopover CPU (1366x840)');
  await captureArtifactScreenshot(page, artifactsDir, '03-resource-cpu-1366x840');

  await page.keyboard.press('Escape');
  await resourceDialog.waitFor({ state: 'hidden', timeout: 5_000 });

  // 2. Subscription Quota Monitor at 1366x840
  const quotaBadge = page.locator('.subscription-quota-badge');
  await assertVisibleAndClickableRect(quotaBadge, 'Subscription Quota Badge');
  await quotaBadge.click();

  const quotaDialog = page.locator('.subscription-quota-popover[role="dialog"]');
  await assertDialogClean(page, quotaDialog, 'SubscriptionQuotaPopover (1366x840)');
  await captureArtifactScreenshot(page, artifactsDir, '04-quota-popover-1366x840');

  await page.keyboard.press('Escape');
  await quotaDialog.waitFor({ state: 'hidden', timeout: 5_000 });

  // 3. Notifications Popover at 1366x840
  const notifBell = page.locator('button.notification-bell');
  await assertVisibleAndClickableRect(notifBell, 'Notification Bell');
  await notifBell.click();

  const notifDialog = page.locator('.notification-center--popover[role="dialog"]');
  await assertDialogClean(page, notifDialog, 'AppNotificationsPopover (1366x840)');
  await captureArtifactScreenshot(page, artifactsDir, '05-notifications-popover-1366x840');

  await page.keyboard.press('Escape');
  await notifDialog.waitFor({ state: 'hidden', timeout: 5_000 });

  // 4. Agent Updates Popover (when outdated engines exist on host)
  const updatesBadge = page.locator('[data-agent-updates-badge]');
  if (await updatesBadge.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(updatesBadge, 'Agent Updates Badge');
    await updatesBadge.click();
    const updatesDialog = page.locator('.agent-updates-popover[role="dialog"]');
    await assertDialogClean(page, updatesDialog, 'AgentUpdatesPopover (1366x840)');
    await captureArtifactScreenshot(page, artifactsDir, '06-updates-popover-1366x840');
    await page.keyboard.press('Escape');
    await updatesDialog.waitFor({ state: 'hidden', timeout: 5_000 });
  }

  // 5. Compact 960x680 geometry checks
  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForTimeout(220);
  await assertNoHorizontalOverflow(page, 'Compact 960x680 TitleBar', ['.titlebar']);

  await assertVisibleAndClickableRect(resourceBadge, 'System Resource Badge (960x680)');
  await resourceBadge.click();
  await assertDialogClean(page, resourceDialog, 'SystemResourcePopover (960x680)');
  await captureArtifactScreenshot(page, artifactsDir, '07-resource-compact-960x680');
  await page.keyboard.press('Escape');
  await resourceDialog.waitFor({ state: 'hidden', timeout: 5_000 });

  await assertVisibleAndClickableRect(quotaBadge, 'Subscription Quota Badge (960x680)');
  await quotaBadge.click();
  await assertDialogClean(page, quotaDialog, 'SubscriptionQuotaPopover (960x680)');
  await captureArtifactScreenshot(page, artifactsDir, '08-quota-compact-960x680');
  await page.keyboard.press('Escape');
  await quotaDialog.waitFor({ state: 'hidden', timeout: 5_000 });

  await assertVisibleAndClickableRect(notifBell, 'Notification Bell (960x680)');
  await notifBell.click();
  await assertDialogClean(page, notifDialog, 'AppNotificationsPopover (960x680)');
  await captureArtifactScreenshot(page, artifactsDir, '09-notifications-compact-960x680');
  await page.keyboard.press('Escape');
  await notifDialog.waitFor({ state: 'hidden', timeout: 5_000 });

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during TOPBAR-POPOVERS-01:\n${pageErrors.join('\n')}`);
  }
}
