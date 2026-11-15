import { assertVisibleAndClickableRect } from '../assertions.mjs';

export async function waitForThreadSurfaceSettled(
  page,
  { expectDraft = null, timeoutMs = 12_000 } = {},
) {
  await page.waitForFunction(
    (expectedDraft) => {
      const panes = Array.from(document.querySelectorAll('section.chat-surface--thread'));
      if (panes.length !== 1) return false;
      const pane = panes[0];
      if (expectedDraft === true && !pane.querySelector('.chat-draft-hero')) return false;
      if (expectedDraft === false && pane.querySelector('.chat-draft-hero')) return false;

      for (const selector of [
        'textarea.kite-composer-textarea',
        'button[role="combobox"][aria-label="Model"]',
      ]) {
        const el = pane.querySelector(selector);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || (hit !== el && !el.contains(hit))) return false;
      }
      return true;
    },
    expectDraft,
    { timeout: timeoutMs },
  );
}

/**
 * Switches into Thread mode and ensures an active SingleThreadPane composer is ready.
 * Never uses `{ force: true }`.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<import('playwright-core').Locator>}
 */
export async function enterActiveThreadComposer(page) {
  const threadModeBtn = page.locator(
    'fieldset[aria-label="Work mode"] button[data-label="Thread"]',
  );
  await assertVisibleAndClickableRect(threadModeBtn, 'TitleBar Thread mode toggle');
  if ((await threadModeBtn.getAttribute('aria-pressed')) !== 'true') {
    await threadModeBtn.click();
  }

  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('section.chat-surface--empty button.secondary-button') ||
          document.querySelector('section.chat-home #chat-composer') ||
          document.querySelector('.chat-surface--thread textarea.kite-composer-textarea'),
      ),
    null,
    { timeout: 15_000 },
  );

  const newThreadEmptyBtn = page.locator('section.chat-surface--empty button.secondary-button', {
    hasText: 'New thread',
  });
  if (await newThreadEmptyBtn.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(newThreadEmptyBtn, 'Empty state New thread button');
    await newThreadEmptyBtn.click();
  }

  await waitForThreadSurfaceSettled(page);
  const textarea = page.locator('.chat-surface--thread textarea.kite-composer-textarea').first();
  await assertVisibleAndClickableRect(textarea, 'Active Thread composer textarea');
  return textarea;
}

/**
 * Selects the isolated sandbox `Claude Code` provider in the active Thread composer so
 * turns resolve cleanly through `$HOME/.claude.json` and the fake driver CLI without
 * relying on developer IDE credentials.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} [providerLabel='Claude Code']
 */
export async function selectThreadProvider(page, providerLabel = 'Claude Code') {
  const modelCombo = page.locator('.chat-surface--thread button[role="combobox"][aria-label="Model"]').first();
  await assertVisibleAndClickableRect(modelCombo, 'Composer model/provider picker');
  await modelCombo.click();

  const dialog = page.locator('div[role="dialog"][aria-label="Select model and provider"]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });

  const providerBtn = dialog.locator(`button[aria-label="${providerLabel}"]`);
  await assertVisibleAndClickableRect(providerBtn, `Provider rail button "${providerLabel}"`);
  await providerBtn.click();

  // Close the popover cleanly if clicking the provider tab kept it open for model filtering.
  if (await dialog.isVisible().catch(() => false)) {
    const autoOption = dialog.locator('[role="listbox"] [role="option"]').first();
    if (await autoOption.isVisible().catch(() => false)) {
      await autoOption.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(async () => {
      await page.keyboard.press('Escape');
    });
  }
}

/**
 * Types a prompt into the active Thread composer and submits it via the real Send button.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} promptText
 */
export async function submitThreadPrompt(page, promptText) {
  const textarea = page.locator('.chat-surface--thread textarea.kite-composer-textarea').first();
  await assertVisibleAndClickableRect(textarea, 'Thread composer textarea before submit');
  await textarea.click();
  await textarea.fill(promptText);

  const sendBtn = page.locator('.chat-surface--thread button.kite-composer-action-btn--send').first();
  await assertVisibleAndClickableRect(sendBtn, 'Thread composer Send button');
  await sendBtn.click();
}

/**
 * Opens a fresh Thread via the header `+` button (`New thread`) and selects `Claude Code`.
 *
 * @param {import('playwright-core').Page} page
 */
export async function openNewThreadFromHeader(page) {
  const newBtn = page.locator('.chat-thread-header button[aria-label="New thread"]').first();
  await assertVisibleAndClickableRect(newBtn, 'Thread header New thread button');
  await newBtn.click();
  await waitForThreadSurfaceSettled(page, { expectDraft: true });
  const textarea = page.locator('.chat-surface--thread textarea.kite-composer-textarea').first();
  await assertVisibleAndClickableRect(textarea, 'New thread composer textarea');
  await selectThreadProvider(page, 'Claude Code');
  return textarea;
}

/**
 * Switches to a thread row in Sidebar by title and waits for transition & controls to settle.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} threadTitle
 */
export async function switchToSidebarThread(page, threadTitle) {
  const rowBtn = page
    .locator('.chat-thread-row__select')
    .filter({ has: page.locator('.chat-thread-row__title', { hasText: threadTitle }) })
    .first();
  await assertVisibleAndClickableRect(rowBtn, `Sidebar thread row "${threadTitle}"`);
  await rowBtn.click();
  await waitForThreadSurfaceSettled(page, { expectDraft: false });
}

/**
 * Ensures the RightDock side panel is visible and switched to the `subagents` tab.
 *
 * @param {import('playwright-core').Page} page
 */
export async function openSubagentsRightDockTab(page) {
  const tabSelect = page.locator('.side-panel-tab[data-kind="subagents"] button.side-panel-tab__select');
  if (await tabSelect.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Subagents tab');
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
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Subagents tab');
    await tabSelect.click();
    return;
  }

  await assertVisibleAndClickableRect(newTabBtn, 'RightDock New tab button');
  await newTabBtn.click();

  const newTabMenu = page.locator('[role="menu"][aria-label="New tab"]');
  await newTabMenu.waitFor({ state: 'visible', timeout: 5_000 });
  const subagentsItem = newTabMenu
    .locator('[role="menuitem"]')
    .filter({ has: page.locator('.ui-menu__row-title', { hasText: /^Subagents$/ }) })
    .first();
  await assertVisibleAndClickableRect(subagentsItem, 'RightDock New tab -> Subagents menu item');
  await subagentsItem.click();

  await tabSelect.waitFor({ state: 'visible', timeout: 10_000 });
  if ((await tabSelect.getAttribute('aria-selected')) !== 'true') {
    await assertVisibleAndClickableRect(tabSelect, 'RightDock Subagents tab');
    await tabSelect.click();
  }
}

/**
 * Closes RightDock when it is open so subsequent narrow-window thread controls stay uncrowded.
 *
 * @param {import('playwright-core').Page} page
 */
export async function closeRightDockIfOpen(page) {
  const newTabBtn = page.locator('button[aria-label="New tab"]').first();
  if (!(await newTabBtn.isVisible().catch(() => false))) {
    return;
  }
  const toggleBtn = page.locator('[data-testid="side-panel-toggle"]');
  await assertVisibleAndClickableRect(toggleBtn, 'TitleBar side panel toggle');
  await toggleBtn.click();
  await newTabBtn.waitFor({ state: 'hidden', timeout: 10_000 });
}
