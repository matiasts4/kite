import path from 'node:path';
import fs from 'node:fs';
import {
  assertNativeTauriShell,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';
import { prepareFakeDriverSandbox, readDriverCallLog } from '../fake-driver/setup.mjs';
import { resolveDesktopBinary } from '../launch-desktop.mjs';
import {
  closeRightDockIfOpen,
  enterActiveThreadComposer,
  openNewThreadFromHeader,
  openSubagentsRightDockTab,
  selectThreadProvider,
  submitThreadPrompt,
} from '../helpers/thread-helpers.mjs';

export const meta = {
  id: 'ORCH-E2E-01',
  title: 'Verify real parallel subagents, Swarm coordination, and non-zero child failure propagation',
};

const SCENARIO = {
  rules: [
    // ORCH-SUB-01 parent: spawns two parallel child threads via real `kite dispatch run --via thread`
    {
      driver: 'claude',
      promptIncludes: 'E2E parallel subagents',
      steps: [
        { delayMs: 120, textDelta: 'Delegating parallel tasks to two subagents... ' },
        {
          execParallel: [
            {
              args: [
                'dispatch',
                'run',
                '--via',
                'thread',
                '--provider',
                'claude',
                '--role',
                'Worker Alpha',
                '--workspace',
                'inherit',
                '--wait',
                'Subtask Alpha E2E',
              ],
            },
            {
              args: [
                'dispatch',
                'run',
                '--via',
                'thread',
                '--provider',
                'claude',
                '--role',
                'Worker Beta',
                '--workspace',
                'inherit',
                '--wait',
                'Subtask Beta E2E',
              ],
            },
          ],
        },
        { delayMs: 80, textDelta: 'Both parallel subagents completed cleanly.' },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'Subtask Alpha E2E',
      steps: [
        { delayMs: 200, textDelta: 'Alpha working... ' },
        { delayMs: 2200, textDelta: 'Alpha deliverable complete.' },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'Subtask Beta E2E',
      steps: [
        { delayMs: 250, textDelta: 'Beta working... ' },
        { delayMs: 2400, textDelta: 'Beta deliverable complete.' },
      ],
    },

    // ORCH-SWARM-01 parent: creates swarm board + workers via real `kite dispatch swarm`
    {
      driver: 'claude',
      promptIncludes: '[Swarm Coordinator Wakeup',
      steps: [
        { delayMs: 50, textDelta: 'Coordinator reviewed worker posts.' },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'E2E swarm board test',
      steps: [
        { delayMs: 100, textDelta: 'Coordinating swarm board... ' },
        { exec: { args: ['dispatch', 'swarm', 'title', 'E2E Release Swarm'], emitTool: true } },
        {
          execParallel: [
            {
              emitTool: true,
              args: [
                'dispatch',
                'swarm',
                'add',
                '--name',
                'scout',
                '--provider',
                'claude',
                '--role',
                'Scout',
                '--workspace',
                'inherit',
                '--brief',
                'Swarm Scout task',
              ],
            },
            {
              emitTool: true,
              args: [
                'dispatch',
                'swarm',
                'add',
                '--name',
                'verifier',
                '--provider',
                'claude',
                '--role',
                'Verifier',
                '--workspace',
                'inherit',
                '--brief',
                'Swarm Verifier task',
              ],
            },
          ],
        },
        { delayMs: 1200 },
        { exec: { args: ['dispatch', 'swarm', 'status'], emitTool: true } },
        { textDelta: 'Swarm board synchronized.' },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'Swarm Scout task',
      steps: [
        { delayMs: 250, textDelta: 'Scout audit ready.' },
        { exec: { args: ['dispatch', 'swarm', 'post', '@coordinator Scout audit complete'], allowNonZero: true } },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'Swarm Verifier task',
      steps: [
        { delayMs: 350, textDelta: 'Verifier check ready.' },
        { exec: { args: ['dispatch', 'swarm', 'post', '@coordinator Verifier checks complete'], allowNonZero: true } },
      ],
    },

    // ORCH-FAIL-01 parent: spawns a crashing child subagent to assert non-hanging failure visibility
    {
      driver: 'claude',
      promptIncludes: 'E2E failing child check',
      steps: [
        { delayMs: 100, textDelta: 'Spawning failing child task... ' },
        {
          exec: {
            emitTool: true,
            args: [
              'dispatch',
              'run',
              '--via',
              'thread',
              '--provider',
              'claude',
              '--role',
              'Crasher Worker',
              '--workspace',
              'inherit',
              '--wait',
              'Crash child task',
            ],
            allowNonZero: true,
          },
        },
        { delayMs: 100, textDelta: 'Observed child crash exit cleanly.' },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'Crash child task',
      steps: [
        { delayMs: 350, stderr: 'E2E simulated fatal child crash\n', exitCode: 1 },
      ],
    },
  ],
};

export const launchOptions = {
  setupSandbox: async (sandbox) => {
    await prepareFakeDriverSandbox(sandbox, SCENARIO);
    const desktopBin = resolveDesktopBinary();
    const kiteCli = path.join(path.dirname(desktopBin), process.platform === 'win32' ? 'kite.exe' : 'kite');
    if (fs.existsSync(kiteCli)) {
      sandbox.env.KITE_DISPATCH_BIN = kiteCli;
    }
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

  // 1. ORCH-SUB-01: Parallel subagents visible in transcript & RightDock -> running -> completed.
  await enterActiveThreadComposer(page);
  await selectThreadProvider(page, 'Claude Code');
  await submitThreadPrompt(page, 'E2E parallel subagents');

  // Open RightDock Subagents tab first so we reliably catch running -> settled state even if children finish fast.
  await page.waitForFunction(
    () => {
      const text = document.body.innerText || '';
      return (
        Boolean(document.querySelector('[data-testid="subagent-disclosure-group"]')) ||
        (text.includes('Worker Alpha') && text.includes('Worker Beta'))
      );
    },
    null,
    { timeout: 20_000 },
  );

  const disclosureToggle = page.locator('[data-testid="subagent-disclosure-group"] button.chat-subagent-group__toggle').first();
  if (await disclosureToggle.isVisible().catch(() => false)) {
    if ((await disclosureToggle.getAttribute('aria-expanded')) === 'false') {
      await disclosureToggle.click();
    }
  }

  await openSubagentsRightDockTab(page);
  await captureArtifactScreenshot(page, artifactsDir, '01-subagents-running-or-settling');

  // Ensure both parallel cards settle to completed state with zero hung running state.
  await page.waitForFunction(
    () => {
      const parentDone = Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('Both parallel subagents completed cleanly.'),
      );
      const runCards = Array.from(document.querySelectorAll('[data-testid="subagent-run-card"]'));
      const bothVisible =
        runCards.some((el) => (el.textContent || '').includes('Worker Alpha')) &&
        runCards.some((el) => (el.textContent || '').includes('Worker Beta'));
      const anyStillRunning = runCards.some((el) => Boolean(el.querySelector('.subagent-dot--running')));
      return parentDone && bothVisible && !anyStillRunning;
    },
    null,
    { timeout: 25_000 },
  );

  await captureArtifactScreenshot(page, artifactsDir, '02-subagents-completed');
  await closeRightDockIfOpen(page);

  // 2. ORCH-SWARM-01: Swarm Board renders team title and real members (`scout`, `verifier`).
  await openNewThreadFromHeader(page);
  await submitThreadPrompt(page, 'E2E swarm board test');

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('Swarm board synchronized.'),
      ) && Boolean(document.querySelector('button.chat-swarm-card')),
    null,
    { timeout: 25_000 },
  );

  const swarmInspectBtn = page.locator('button.chat-swarm-card').last();
  await swarmInspectBtn.scrollIntoViewIfNeeded();
  await assertVisibleAndClickableRect(swarmInspectBtn, 'Swarm card Inspect Board button');
  await swarmInspectBtn.click();

  await page.waitForFunction(
    () => {
      const dock = document.querySelector('.app-browser-sidebar__page');
      if (!dock) return false;
      const dockText = dock.textContent || '';
      const idleHeader = Boolean(document.querySelector('.chat-thread-header__status--idle'));
      return (
        idleHeader &&
        dockText.includes('E2E Release Swarm') &&
        dockText.includes('scout') &&
        dockText.includes('verifier')
      );
    },
    null,
    { timeout: 20_000 },
  );

  await captureArtifactScreenshot(page, artifactsDir, '03-swarm-board-live');
  await closeRightDockIfOpen(page);

  // 3. ORCH-FAIL-01: Failing child exits non-zero and collapses into a discreet non-red disclosure (never hung running).
  await openNewThreadFromHeader(page);
  await submitThreadPrompt(page, 'E2E failing child check');

  await page.waitForFunction(
    () => {
      const text = document.body.innerText || '';
      const hasRole = text.includes('Crasher Worker');
      const hasDisclosure = Boolean(document.querySelector('[data-testid="subagent-failed-disclosure"]'));
      const parentDone = Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('Observed child crash exit cleanly.'),
      );
      const idleHeader = Boolean(document.querySelector('.chat-thread-header__status--idle'));
      return hasRole && hasDisclosure && parentDone && idleHeader;
    },
    null,
    { timeout: 25_000 },
  );

  await captureArtifactScreenshot(page, artifactsDir, '04-orchestration-child-failed');

  const failedDisclosureToggle = page.locator('[data-testid="subagent-failed-disclosure"] .chat-subagent-failed-disclosure__toggle').last();
  await assertVisibleAndClickableRect(failedDisclosureToggle, 'Failed subagent discreet disclosure toggle');
  await failedDisclosureToggle.click();

  await page.waitForFunction(
    () => Boolean(document.querySelector('.chat-subagent-card.chat-subagent-card--failed')),
    null,
    { timeout: 10_000 },
  );

  // Verify zero red (--danger-ink) tinting on both the discreet disclosure and the expanded failed card.
  const redCheck = await page.evaluate(() => {
    const isReddish = (rgb) => {
      const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/i.exec(rgb || '');
      if (!m) return false;
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      return r >= 180 && r - Math.max(g, b) >= 60;
    };
    const toggle = document.querySelector('[data-testid="subagent-failed-disclosure"] .chat-subagent-failed-disclosure__toggle');
    const card = document.querySelector('.chat-subagent-card.chat-subagent-card--failed');
    const state = document.querySelector('.chat-subagent-card__state--failed');
    const samples = [
      toggle && ['toggle.color', getComputedStyle(toggle).color],
      toggle && ['toggle.border', getComputedStyle(toggle).borderColor],
      card && ['card.border', getComputedStyle(card).borderColor],
      card && ['card.bg', getComputedStyle(card).backgroundColor],
      state && ['state.color', getComputedStyle(state).color],
    ].filter(Boolean);
    return samples.filter(([, val]) => isReddish(val));
  });
  if (redCheck.length > 0) {
    throw new Error(`Expected non-red neutral styling on failed subagent disclosure/card, found reddish values: ${JSON.stringify(redCheck)}`);
  }

  // Cross-check real backend call logs from the sandboxed driver.
  const driverCalls = await readDriverCallLog(sandbox);
  const distinctThreadAddresses = new Set(
    driverCalls.map((c) => c.kiteThreadId || c.kiteAddress).filter(Boolean),
  );
  if (distinctThreadAddresses.size < 8) {
    throw new Error(
      `Expected >= 8 distinct parent+child thread dispatches (3 parents + 5 children), observed ${distinctThreadAddresses.size}`,
    );
  }
  const childPrompts = [
    'Subtask Alpha E2E',
    'Subtask Beta E2E',
    'Swarm Scout task',
    'Swarm Verifier task',
    'Crash child task',
  ];
  for (const needle of childPrompts) {
    const matched = driverCalls.some(
      (c) =>
        (typeof c.prompt === 'string' && c.prompt.includes(needle)) ||
        (Array.isArray(c.args) && c.args.some((arg) => String(arg).includes(needle))),
    );
    if (!matched) {
      throw new Error(`Expected driver invocation log for child prompt "${needle}"`);
    }
  }

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors in ORCH-E2E-01:\n${pageErrors.join('\n')}`);
  }
}
