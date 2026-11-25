import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertNoSiblingOverlap,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';

export const meta = {
  id: 'AGENTS-ROUTINES-01',
  title: 'Verify Agent mode shell, roster, Routines surface (when reachable), and compact/standard layout',
};

async function auditAgentViewport(page, artifactsDir, tag, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(180);

  await assertNoHorizontalOverflow(page, `${tag} (${width}x${height})`, [
    '.titlebar',
    '[data-testid="sidebar"]',
    'section.agent-pane',
    'section.empty-roster-surface',
    'section.routine-pane',
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

  // 1. Switch to Agent work mode via genuine TitleBar toggle click.
  const agentModeBtn = page.locator('fieldset[aria-label="Work mode"] button[data-label="Agent"]');
  await assertVisibleAndClickableRect(agentModeBtn, 'TitleBar Agent mode toggle');
  if ((await agentModeBtn.getAttribute('aria-pressed')) !== 'true') {
    await agentModeBtn.click();
  }

  const pressed = await agentModeBtn.getAttribute('aria-pressed');
  if (pressed !== 'true') {
    throw new Error(`Expected Agent mode button aria-pressed="true", got ${JSON.stringify(pressed)}`);
  }

  // 2. Wait for Sidebar and settled AgentsView (past lazy/loading spinner) to mount.
  const sidebar = page.locator('[data-testid="sidebar"]');
  await sidebar.waitFor({ state: 'visible', timeout: 15_000 });

  await page.waitForFunction(
    () => {
      const isVisible = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      return (
        isVisible('section.agent-pane header.agent-pane__header') ||
        isVisible('section.agent-pane .agent-chat-shell') ||
        isVisible('.agents-shell section.empty-roster-surface')
      );
    },
    null,
    { timeout: 15_000 },
  );

  await auditAgentViewport(page, artifactsDir, '01-agent-mode-1366x840', 1366, 840);

  // 3. Navigate to Routines if reachable from Agent Settings via genuine clicks.
  const agentSettingsBtn = page.locator('section.agent-pane button.agent-settings-toggle');
  if (await agentSettingsBtn.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(agentSettingsBtn, 'Agent settings toggle');
    await agentSettingsBtn.click();

    const openRoutinesBtn = page.locator('button', { hasText: 'Open Routines' }).first();
    if (await openRoutinesBtn.isVisible().catch(() => false)) {
      await openRoutinesBtn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(120);
      await assertVisibleAndClickableRect(openRoutinesBtn, 'Open Routines button');
      await openRoutinesBtn.click();

      const routinePane = page.locator('section.routine-pane');
      await routinePane.waitFor({ state: 'visible', timeout: 10_000 });
      await assertNoHorizontalOverflow(page, 'Routines surface (1366x840)', [
        '.titlebar',
        'section.routine-pane',
      ]);
      await captureArtifactScreenshot(page, artifactsDir, '02-routines-1366x840');
    } else {
      await captureArtifactScreenshot(page, artifactsDir, '02-routines-1366x840');
    }
  } else {
    // Isolated sandbox has no pre-configured agents; capture the clean empty-roster state.
    await captureArtifactScreenshot(page, artifactsDir, '02-routines-1366x840');
  }

  // 4. Verify compact viewport layout (960x680) without overflow or TitleBar overlap.
  await auditAgentViewport(page, artifactsDir, '03-agents-compact-960x680', 960, 680);

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during AGENTS-ROUTINES-01:\n${pageErrors.join('\n')}`);
  }
}
