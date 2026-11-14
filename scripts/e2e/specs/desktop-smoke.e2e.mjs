import {
  assertNativeTauriShell,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';

export const meta = {
  id: 'DESKTOP-SMOKE-01',
  title: 'Boot isolated desktop shell, verify real Tauri IPC, switch to Thread mode, and open a Thread',
};

/**
 * @param {{
 *   page: import('playwright-core').Page,
 *   artifactsDir: string,
 *   pageErrors: string[],
 * }} ctx
 */
export async function run(ctx) {
  const { page, artifactsDir, pageErrors } = ctx;

  // 1. Confirm real Tauri WebView2 runtime (not the Express browser mock shim).
  await assertNativeTauriShell(page);
  await waitForBootCoverCleared(page);

  // 2. Click the Thread toggle button in TitleBar using genuine pointer interaction (never force:true).
  const threadModeBtn = page.locator('fieldset[aria-label="Work mode"] button[data-label="Thread"]');
  await assertVisibleAndClickableRect(threadModeBtn, 'TitleBar Thread mode toggle');
  await threadModeBtn.click();

  const pressed = await threadModeBtn.getAttribute('aria-pressed');
  if (pressed !== 'true') {
    throw new Error(`Expected Thread mode button aria-pressed="true", got ${JSON.stringify(pressed)}`);
  }

  await captureArtifactScreenshot(page, artifactsDir, '01-thread-mode-entered');

  // 3. Either ChatView empty state ("New thread") or ChatHome (#chat-composer) renders immediately.
  const newThreadBtn = page.locator('section.chat-surface--empty button.secondary-button', {
    hasText: 'New thread',
  });
  const homeComposer = page.locator('section.chat-home #chat-composer');
  const activeTextarea = page.locator('.chat-surface--thread textarea.kite-composer-textarea');

  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('section.chat-surface--empty button.secondary-button') ||
          document.querySelector('section.chat-home #chat-composer') ||
          document.querySelector('.chat-surface--thread textarea.kite-composer-textarea')
      ),
    null,
    { timeout: 15_000 }
  );

  if (await newThreadBtn.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(newThreadBtn, 'Thread empty state New thread button');
    await newThreadBtn.click();
  } else if (await homeComposer.isVisible().catch(() => false)) {
    await assertVisibleAndClickableRect(homeComposer, 'ChatHome composer textarea');
  }

  // 4. Verify live SingleThreadPane composer is mounted and hit-testable (or ChatHome ready if thread not created from empty).
  await activeTextarea.first().waitFor({ state: 'visible', timeout: 15_000 });
  await assertVisibleAndClickableRect(activeTextarea.first(), 'Active Thread composer textarea');

  // Verify the composer accepts real typing without overlap or broken focus.
  await activeTextarea.first().click();
  await activeTextarea.first().fill('Smoke check draft');
  const typedValue = await activeTextarea.first().inputValue();
  if (typedValue !== 'Smoke check draft') {
    throw new Error(`Expected composer value "Smoke check draft", got ${JSON.stringify(typedValue)}`);
  }

  await captureArtifactScreenshot(page, artifactsDir, '02-active-thread-composer');

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors during smoke run:\n${pageErrors.join('\n')}`);
  }
}
