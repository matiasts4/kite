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

  // 3. Navigate to Routines via genuine Sidebar "Routines" trigger.
  const sidebarRoutinesBtn = page.locator('[data-testid="sidebar"] button[aria-label="Routines"]');
  await sidebarRoutinesBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await assertVisibleAndClickableRect(sidebarRoutinesBtn, 'Sidebar Routines button');
  await sidebarRoutinesBtn.click();

  const routinePane = page.locator('section.routine-pane');
  await routinePane.waitFor({ state: 'visible', timeout: 10_000 });

  // Verify clean "+ New routine" -> single icon + "New routine" text, no duplicate '+'.
  const newRoutineBtn = routinePane.getByRole('button', { name: /New routine/i });
  await assertVisibleAndClickableRect(newRoutineBtn, 'New routine button');
  const newRoutineText = ((await newRoutineBtn.textContent()) || '').trim();
  if (newRoutineText !== 'New routine') {
    throw new Error(`Expected button label "New routine", got ${JSON.stringify(newRoutineText)}`);
  }

  // Verify filter & triage layout has zero overlap at 1366x840.
  await assertNoHorizontalOverflow(page, 'Routines surface (1366x840)', [
    '.titlebar',
    'section.routine-pane',
  ]);
  await assertNoSiblingOverlap(
    routinePane.locator('.routine-triage-bar > *'),
    'Routines triage bar controls at 1366x840',
    { minCount: 2 },
  );

  // Toggle seeded routine switch off and back on cleanly without error alerts.
  const seededSwitch = routinePane.getByRole('switch', { name: /Daily Project Health Check/i });
  await seededSwitch.waitFor({ state: 'visible', timeout: 10_000 });
  await assertVisibleAndClickableRect(seededSwitch, 'Seeded routine toggle switch');
  const initialChecked = await seededSwitch.getAttribute('aria-checked');
  await seededSwitch.click();
  await page.waitForFunction(
    (expected) => {
      const sw = document.querySelector('section.routine-pane [role="switch"]');
      const err = document.querySelector('section.routine-pane .routine-feedback--error');
      return err || (sw && sw.getAttribute('aria-checked') === expected);
    },
    initialChecked === 'true' ? 'false' : 'true',
    { timeout: 10_000 },
  );
  const toggleError = await routinePane.locator('.routine-feedback--error').textContent().catch(() => null);
  if (toggleError) {
    throw new Error(`Routine toggle threw unexpected error alert: ${toggleError}`);
  }
  // Toggle back to restore initial state.
  await seededSwitch.click();
  await page.waitForFunction(
    (expected) => {
      const sw = document.querySelector('section.routine-pane [role="switch"]');
      return sw && sw.getAttribute('aria-checked') === expected;
    },
    initialChecked,
    { timeout: 10_000 },
  );

  await captureArtifactScreenshot(page, artifactsDir, '02-routines-1366x840');

  // Verify compact viewport layout inside Routines (960x680) without overlap or overflow.
  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForTimeout(180);
  await assertNoHorizontalOverflow(page, 'Routines surface (960x680)', [
    '.titlebar',
    'section.routine-pane',
  ]);
  await assertNoSiblingOverlap(
    routinePane.locator('.routine-triage-bar > *'),
    'Routines triage bar controls at 960x680',
    { minCount: 2 },
  );
  await captureArtifactScreenshot(page, artifactsDir, '03-routines-compact-960x680');

  // Verify TitleBar mode switch exits Routines immediately.
  const codeModeBtn = page.locator('fieldset[aria-label="Work mode"] button[data-label="Code"]');
  await codeModeBtn.click();
  await routinePane.waitFor({ state: 'detached', timeout: 10_000 });

  // Return to Agent -> open Routines -> verify Back button returns to Agents.
  await agentModeBtn.click();
  await sidebarRoutinesBtn.click();
  await routinePane.waitFor({ state: 'visible', timeout: 10_000 });
  const backBtn = routinePane.getByRole('button', { name: /Back to Agents/i });
  await assertVisibleAndClickableRect(backBtn, 'Routines Back button');
  await backBtn.click();
  await routinePane.waitFor({ state: 'detached', timeout: 10_000 });

  // 4. Verify compact viewport layout in Agent mode (960x680).
  await auditAgentViewport(page, artifactsDir, '04-agents-compact-960x680', 960, 680);

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during AGENTS-ROUTINES-01:\n${pageErrors.join('\n')}`);
  }
}
