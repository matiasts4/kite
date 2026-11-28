import {
  assertNativeTauriShell,
  assertNoSiblingOverlap,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';
import { prepareFakeDriverSandbox, readDriverCallLog } from '../fake-driver/setup.mjs';
import {
  enterActiveThreadComposer,
  openNewThreadFromHeader,
  selectThreadProvider,
  submitThreadPrompt,
  switchToSidebarThread,
} from '../helpers/thread-helpers.mjs';

export const meta = {
  id: 'THREAD-STREAM-01',
  title: 'Verify live mid-turn token streaming, completion transition, and multi-thread switching without state loss',
};

const SCENARIO = {
  rules: [
    {
      driver: 'claude',
      promptIncludes: 'E2E stream delta check',
      steps: [
        { delayMs: 250, textDelta: 'STREAM_ALPHA_PART ' },
        { delayMs: 2200, textDelta: 'STREAM_OMEGA_DONE' },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'E2E slow switch stream',
      steps: [
        { delayMs: 250, textDelta: 'SWITCH_A_MID ' },
        { delayMs: 2600, textDelta: 'SWITCH_A_COMPLETE' },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'E2E fast switch B',
      steps: [
        { delayMs: 100, textDelta: 'SWITCH_B_OK' },
      ],
    },
  ],
};

export const launchOptions = {
  setupSandbox: async (sandbox) => {
    await prepareFakeDriverSandbox(sandbox, SCENARIO);
  },
};

/**
 * @param {{
 *   page: import('playwright-core').Page,
 *   sandbox: import('../sandbox.mjs').DesktopSandbox,
 *   artifactsDir: string,
 *   pageErrors: string[],
 * }} ctx
 */
export async function run(ctx) {
  const { page, sandbox, artifactsDir, pageErrors } = ctx;

  await assertNativeTauriShell(page);
  await waitForBootCoverCleared(page);

  // Part 1 — THREAD-STREAM-01: Observe mid-turn streaming delta -> automatic completion without reload.
  await enterActiveThreadComposer(page);
  await selectThreadProvider(page, 'Claude Code');
  await submitThreadPrompt(page, 'E2E stream delta check');

  const assistantMsg = page.locator('.chat-turn--assistant');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('STREAM_ALPHA_PART'),
      ),
    null,
    { timeout: 15_000 },
  );

  // Mid-turn check: Turn must still show live streaming state before final chunk arrives.
  const interruptVisible = await page
    .locator('.chat-surface--thread button[aria-label="Interrupt"]')
    .isVisible()
    .catch(() => false);
  const runningHeaderVisible = await page
    .locator('.chat-thread-header__status--running')
    .isVisible()
    .catch(() => false);
  if (!interruptVisible && !runningHeaderVisible) {
    throw new Error('Expected active streaming indicator while mid-turn delta was emitted.');
  }
  const hasWorkingShelf = await page.locator('[aria-label="Working threads"]').count();
  if (hasWorkingShelf > 0) {
    throw new Error('Expected no separate Working threads shelf while streaming.');
  }
  const railRunningIndicators = await page
    .locator('.chat-rail [data-testid="agent-status-indicator"][data-status="running"]')
    .count();
  if (railRunningIndicators < 1) {
    throw new Error('Expected inline AgentStatusIndicator on running thread row in .chat-rail.');
  }
  await assertVisibleAndClickableRect(
    page.locator('[data-rail-toggle]'),
    'TitleBar sidebar toggle during live stream',
  );
  await assertNoSiblingOverlap(
    page.locator('.titlebar__leading > *'),
    'TitleBar leading controls during live stream',
    { minCount: 2 },
  );

  await captureArtifactScreenshot(page, artifactsDir, '01-thread-streaming-midturn');

  await page.waitForFunction(
    () => {
      const doneText = Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('STREAM_OMEGA_DONE'),
      );
      const idleHeader = Boolean(document.querySelector('.chat-thread-header__status--idle'));
      const sendRestored = Boolean(
        document.querySelector('.chat-surface--thread button.kite-composer-action-btn--send'),
      );
      return doneText && idleHeader && sendRestored;
    },
    null,
    { timeout: 15_000 },
  );

  const settledText = await assistantMsg.last().innerText();
  if (!settledText.includes('STREAM_ALPHA_PART') || !settledText.includes('STREAM_OMEGA_DONE')) {
    throw new Error(`Expected complete streamed text, got: ${JSON.stringify(settledText)}`);
  }

  await captureArtifactScreenshot(page, artifactsDir, '02-thread-streaming-settled');

  // Part 2 — THREAD-SWITCH-01: Switch away during active stream and return to settled Thread A.
  await openNewThreadFromHeader(page);
  await submitThreadPrompt(page, 'E2E slow switch stream');

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('SWITCH_A_MID'),
      ),
    null,
    { timeout: 15_000 },
  );

  const threadATitle = (
    await page.locator('.chat-thread-row--selected .chat-thread-row__title').first().innerText()
  ).trim();
  if (!threadATitle) {
    throw new Error('Could not resolve active Thread A sidebar title before switching threads.');
  }

  await captureArtifactScreenshot(page, artifactsDir, '03-thread-a-midstream-before-switch');

  // Switch away to a brand-new Thread B while Thread A continues streaming in the background.
  await openNewThreadFromHeader(page);
  await submitThreadPrompt(page, 'E2E fast switch B');

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('SWITCH_B_OK'),
      ) && Boolean(document.querySelector('.chat-thread-header__status--idle')),
    null,
    { timeout: 15_000 },
  );
  await captureArtifactScreenshot(page, artifactsDir, '04-thread-b-settled');

  const threadBTitle = (
    await page.locator('.chat-thread-row--selected .chat-thread-row__title').first().innerText()
  ).trim();

  // Switch back to Thread A in Sidebar and confirm delayed chunk + completion arrived cleanly.
  await switchToSidebarThread(page, threadATitle);

  await page.waitForFunction(
    () => {
      const text = Array.from(document.querySelectorAll('.chat-turn--assistant')).some(
        (el) =>
          (el.textContent || '').includes('SWITCH_A_MID') &&
          (el.textContent || '').includes('SWITCH_A_COMPLETE'),
      );
      const idleHeader = Boolean(document.querySelector('.chat-thread-header__status--idle'));
      return text && idleHeader;
    },
    null,
    { timeout: 15_000 },
  );

  await captureArtifactScreenshot(page, artifactsDir, '05-thread-a-settled-after-switch');

  // Once both have settled, Thread B (started after Thread A) must remain above Thread A in Settled.
  const settledTitles = await page
    .locator('.chat-rail__band--settled .chat-thread-row .chat-thread-row__title')
    .allInnerTexts();
  const idxB = settledTitles.indexOf(threadBTitle);
  const idxA = settledTitles.indexOf(threadATitle);
  if (idxB === -1 || idxA === -1 || idxB >= idxA) {
    throw new Error(
      `Expected newer Thread B (${JSON.stringify(threadBTitle)}) above older Thread A (${JSON.stringify(threadATitle)}) after both settled, got: ${JSON.stringify(settledTitles)}`,
    );
  }

  const driverCalls = await readDriverCallLog(sandbox);
  const claudeTurns = driverCalls.filter((c) => c.driver === 'claude' && !c.args.includes('--version'));
  if (claudeTurns.length < 3) {
    throw new Error(
      `Expected at least 3 fake claude CLI invocations (stream, switch-A, switch-B), got ${claudeTurns.length}`,
    );
  }

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors in THREAD-STREAM-01:\n${pageErrors.join('\n')}`);
  }
}
