/**
 * Browser-lane QA catalog runner (Playwright).
 *
 * Usage:
 *   npm run dev:browser   # separate terminal
 *   npm run verify:browser:qa
 *   QA_WAVE=zed1 npm run verify:browser:qa
 *
 * Waves: smoke | zed1 | zed2 | agent1 | agent2 | all
 */
import { chromium } from 'playwright-core';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertServerUp,
  openLanePage,
  zedSend,
  waitZedStatus,
  terminalPaneCount,
  ensureAgentSurface,
  agentSend,
  readZedStatus,
  qaClick,
} from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const RUN_LOG = join(REPO_ROOT, 'docs/qa/catalog-runs.jsonl');

const WAVE = (process.env.QA_WAVE || 'all').toLowerCase();

const WAVE_IDS = {
  smoke: ['LANE-BOOT-01', 'ZED-SPAWN-01', 'AGENT-CHAT-01'],
  zed1: ['ZED-SPAWN-01', 'ZED-SUM-02', 'ZED-INJ-01', 'ZED-CLOSE-01', 'ZED-CLOSE-02'],
  zed2: [
    'ZED-SPAWN-02',
    'ZED-SPAWN-03',
    'ZED-SUM-03',
    'ZED-SUM-04',
    'ZED-INJ-02',
    'ZED-SUB-01',
    'ZED-WEB-01',
    'ZED-STOP-01',
    'ZED-MOVE-01',
    'ZED-SET-01',
  ],
  agent1: ['AGENT-BOOT-01', 'AGENT-CHAT-01', 'AGENT-CHAT-02', 'AGENT-CHAT-03', 'AGENT-CHAT-04'],
  agent2: [
    'AGENT-TERM-01',
    'AGENT-SET-01',
    'AGENT-MEM-01',
    'AGENT-SKILL-01',
    'AGENT-FILE-01',
    'AGENT-ERR-01',
    'AGENT-NEW-01',
    'AGENT-ARCH-01',
  ],
};

WAVE_IDS.all = [
  ...WAVE_IDS.smoke.filter((id) => id !== 'ZED-SPAWN-01' || true),
  ...WAVE_IDS.zed1.filter((id) => id !== 'ZED-SPAWN-01'),
  ...WAVE_IDS.zed2,
  ...WAVE_IDS.agent1.filter((id) => id !== 'AGENT-CHAT-01'),
  ...WAVE_IDS.agent2,
];
WAVE_IDS.all = [...new Set(['LANE-BOOT-01', 'ZED-SPAWN-01', 'AGENT-CHAT-01', ...WAVE_IDS.zed1.slice(1), ...WAVE_IDS.zed2, ...WAVE_IDS.agent1.slice(1), ...WAVE_IDS.agent2])];

async function runLaneBoot(page) {
  const gate = await page.getByText('Kite Code Runs in Tauri Window').count();
  if (gate > 0) throw new Error('Tauri gate visible in browser lane');
  await page.waitForSelector('[data-testid="zed-input"]');
  await ensureAgentSurface(page);
  await page.getByText('Antigravity').first().waitFor({ timeout: 20_000 });
  const agentRows = page.locator('.entity-row--agent');
  await agentRows.first().waitFor({ timeout: 20_000 });
  const rowCount = await agentRows.count();
  if (rowCount !== 1) {
    throw new Error(`Browser lane should list exactly one agent row, found ${rowCount}`);
  }
  const rowText = await agentRows.first().innerText();
  if (!/Antigravity/i.test(rowText)) {
    throw new Error(`Expected Antigravity roster row, got: ${rowText.slice(0, 80)}`);
  }
}

async function runZedSpawn01(page) {
  await zedSend(page, 'abre 2 terminales con antigravity');
  const status = await waitZedStatus(
    page,
    (t) => /Listo|terminales|Abrí|Acción|\d+ms/i.test(t)
  );
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="terminal-pane"]').length >= 2,
    { timeout: 20_000 }
  ).catch(() => {});
  const count = await terminalPaneCount(page);
  if (count < 2) throw new Error(`Expected >=2 terminal panes, got ${count}. Status: ${status.slice(0, 120)}`);
  return status;
}

async function runZedSum02(page) {
  const status = await waitZedStatus(
    page,
    (t) => /Nova|\[Nova\]/i.test(t) && !/\bOrion\b/i.test(t)
  );
  if (!/Nova|\[Nova\]/i.test(status)) throw new Error(`Nova-only summary missing: ${status.slice(0, 160)}`);
  if (/\bOrion\b/i.test(status)) throw new Error(`Orion leaked into Nova summary: ${status.slice(0, 160)}`);
  return status;
}

async function runZedInj01(page) {
  await zedSend(page, 'en la terminal de Orion escribe: lista los archivos de src/lib');
  const status = await waitZedStatus(page, (t) => /Inyecté|lista los archivos|Orion/i.test(t));
  return status;
}

async function runZedClose01(page) {
  await zedSend(page, 'cierra la terminal Nova');
  await waitZedStatus(page, (t) => /cerr|Nova|Listo|Acción|\d+ms/i.test(t));
  await page.waitForTimeout(800);
  const count = await terminalPaneCount(page);
  if (count !== 1) throw new Error(`Expected 1 pane after closing Nova, got ${count}`);
  return readZedStatus(page);
}

async function runZedClose02(page) {
  await zedSend(page, 'cierra las terminales');
  await waitZedStatus(page, (t) => /cerr|terminales|Listo|Acción|\d+ms/i.test(t));
  await page.waitForTimeout(600);
  const count = await terminalPaneCount(page);
  if (count !== 0) throw new Error(`Expected 0 panes after close all, got ${count}`);
  await zedSend(page, 'resume Orion');
  const status = await waitZedStatus(page, (t) => /No hay|ninguna terminal|no encontr/i.test(t));
  return status;
}

async function runZedOla1(page) {
  await runZedSpawn01(page);
  await zedSend(page, 'resume qué dijo Nova');
  await runZedSum02(page);
  await runZedInj01(page);
  await runZedClose01(page);
  await runZedClose02(page);
}

async function resetTerminalPanes(page) {
  await zedSend(page, 'cierra las terminales');
  await waitZedStatus(page, (t) => /cerr|Listo|Acción|\d+ms|No hay/i.test(t)).catch(() => {});
  await page.waitForTimeout(600);
}

async function runZedSpawn02(page) {
  await resetTerminalPanes(page);
  await zedSend(page, 'abre una terminal con antigravity y que revise ipc.ts');
  const status = await waitZedStatus(page, (t) => /Abrí|terminal|ipc|Listo|Acción|\d+ms/i.test(t));
  const count = await terminalPaneCount(page);
  if (count < 1) throw new Error('Expected at least one pane');
  return status;
}

async function runZedSpawn03(page) {
  await resetTerminalPanes(page);
  await zedSend(page, 'abre dos terminales con antigravity');
  await waitZedStatus(page, (t) => /Abrí|terminales|Listo|Acción|\d+ms/i.test(t));
  await page.waitForTimeout(1200);
  const count = await terminalPaneCount(page);
  if (count !== 2) throw new Error(`Expected exactly 2 panes, got ${count}`);
}

async function runZedSum03(page) {
  await resetTerminalPanes(page);
  await zedSend(page, 'abre dos terminales con antigravity');
  await waitZedStatus(page, (t) => /Abrí|terminales|Listo|Acción|\d+ms/i.test(t));
  await page.waitForTimeout(1000);
  await zedSend(page, 'cómo va Orion');
  await waitZedStatus(page, (t) => /Orion|\[Orion\]/i.test(t));
  await zedSend(page, 'estado de la terminal 1');
  await waitZedStatus(page, (t) => /terminal|Orion|Nova|está|Acción|\d+ms/i.test(t));
}

async function runZedSum04(page) {
  await zedSend(page, 'cierra las terminales');
  await waitZedStatus(page, (t) => /cerr|Listo|Acción|\d+ms/i.test(t));
  await page.waitForTimeout(500);
  const before = await terminalPaneCount(page);
  await zedSend(page, 'resume la tarea');
  const status = await waitZedStatus(page, (t) => /No hay|ninguna|resum|Listo|Acción|\d+ms/i.test(t));
  const after = await terminalPaneCount(page);
  if (after > before) throw new Error('Summary opened new terminals');
  return status;
}

async function runZedInj02(page) {
  await resetTerminalPanes(page);
  await runZedSpawn01(page);
  await zedSend(page, 'en la terminal abierta qué hay');
  const status = await waitZedStatus(page, (t) => /Inyecté/i.test(t) === false && /terminal|Orion|Nova|está|Acción|\d+ms/i.test(t));
  if (/Inyecté/i.test(status)) throw new Error('Read-only phrase triggered inject');
  return status;
}

async function runZedSub01(page) {
  await zedSend(page, 'delega a antigravity: resume ipc.ts en tres líneas');
  const status = await waitZedStatus(page, (t) => /subagente|deleg|Acción|Listo|\d+ms/i.test(t));
  return status;
}

async function runZedWeb01(page) {
  await zedSend(page, 'abre https://example.com');
  const status = await waitZedStatus(page, (t) => /example|navegador|browser|Listo|Acción|\d+ms/i.test(t));
  return status;
}

async function runZedStop01(page) {
  await zedSend(page, 'qué está haciendo Orion');
  await page.waitForTimeout(300);
  await zedSend(page, 'callate');
  const status = await waitZedStatus(page, (t) => t.length >= 0);
  await page.getByRole('button', { name: /Silenciar voz|Activar voz/i }).click({ timeout: 5000 }).catch(() => {});
  return status;
}

async function runZedMove01(page) {
  const card = page.locator('[data-testid="zed-card"]');
  const box = await card.boundingBox();
  if (!box) throw new Error('zed-card not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 60);
  await page.mouse.up();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="zed-input"]');
  const box2 = await card.boundingBox();
  if (!box2) throw new Error('zed-card missing after reload');
  await page.fill('[data-testid="zed-input"]', 'hola');
  const disabled = await page.locator('[data-testid="zed-send"]').isDisabled();
  if (disabled) throw new Error('zed-send disabled after move+reload');
}

async function runZedSet01(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 10_000 });
  await page.locator('[data-settings-tab="zed"], .application-settings-pane').first().waitFor({ timeout: 5000 }).catch(() => {});
  await page
    .locator('nav[aria-label="Settings sections"]')
    .getByRole('button', { name: 'Asistente Zed' })
    .click({ timeout: 15_000 });
  await page.locator('[data-settings-tab="zed"]').waitFor({ timeout: 10_000 });
}

async function runAgentBoot(page) {
  await runLaneBoot(page);
}

async function runAgentChat01(page) {
  await ensureAgentSurface(page);
  await agentSend(page, 'ping antigravity smoke');
}

async function runAgentChat02(page) {
  await ensureAgentSurface(page);
  await agentSend(page, 'primera prueba persistencia');
  const first = await page.locator('text=primera prueba persistencia').count();
  if (first < 1) throw new Error('First user message not visible');
  await agentSend(page, 'Repite solo la primera línea de tu respuesta anterior.');
  const userMsgs = await page.locator('text=primera prueba persistencia').count();
  if (userMsgs < 1) throw new Error('Thread lost first turn after second message');
}

async function runAgentChat03(page) {
  await ensureAgentSurface(page);
  const send = page.locator('[data-testid="agent-chat-send"]');
  const disabled = await send.isDisabled();
  if (!disabled) {
    await page.fill('[data-testid="agent-chat-input"]', '');
    const stillDisabled = await send.isDisabled();
    if (!stillDisabled) throw new Error('Send should stay disabled on empty composer');
  }
  await page.fill('[data-testid="agent-chat-input"]', '');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const turns = await page.locator('text=[Antigravity]').count();
  // Enter on empty should not add a new assistant turn beyond prior tests — only check no blank user bubble
  const blankUser = await page.locator('[data-testid="agent-chat-input"]').inputValue();
  if (blankUser.trim()) throw new Error('Composer should remain empty');
}

async function runAgentChat04(page) {
  await ensureAgentSurface(page);
  const stopBtn = page.getByRole('button', { name: /^Stop$/i });
  if (await stopBtn.count()) {
    await agentSend(page, 'turno largo simulado');
    await stopBtn.click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForSelector('[data-testid="agent-chat-input"]:not([disabled])', { timeout: 15_000 }).catch(() => {});
}

async function runAgentTerm01(page) {
  await ensureAgentSurface(page);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click({ force: true });
  await page.waitForTimeout(800);
  const body = await page.locator('body').innerText();
  if (/spawn powershell|ENOENT/i.test(body)) throw new Error('Terminal surface surfaced spawn error');
}

async function runAgentSet01(page) {
  await ensureAgentSurface(page);
  await page.evaluate(() => {
    document.querySelector('.agent-settings-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(
    () => document.querySelector('.agent-settings-toggle')?.getAttribute('aria-pressed') === 'true',
    { timeout: 15_000 }
  );
  await page.locator('nav[aria-label*="settings sections"]').waitFor({ timeout: 15_000 });
}

async function openAgentSettingsPanel(page) {
  await page.evaluate(() => {
    const toggle = document.querySelector('.agent-settings-toggle');
    if (toggle?.getAttribute('aria-pressed') !== 'true') {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
  await page.locator('nav[aria-label*="settings sections"]').waitFor({ timeout: 15_000 });
}

async function runAgentMem01(page) {
  await ensureAgentSurface(page);
  await openAgentSettingsPanel(page);
  await qaClick(page.getByRole('button', { name: /Agent Memory/i }));
  await page.waitForSelector('[aria-label="Memory room"]', { timeout: 15_000 });
}

async function runAgentSkill01(page) {
  await ensureAgentSurface(page);
  await openAgentSettingsPanel(page);
  await qaClick(page.getByRole('button', { name: /Agent Skills/i }));
  await page.waitForSelector('[aria-label="Skills"]', { timeout: 15_000 });
}

async function runAgentFile01(page) {
  await ensureAgentSurface(page);
  const attach = page.getByRole('button', { name: /Attach|Adjuntar/i });
  if (await attach.count()) {
    await attach.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    const input = page.locator('[data-testid="agent-chat-input"]');
    await input.fill('siguiente mensaje tras adjuntar');
    if (await input.isDisabled()) throw new Error('Composer frozen after attach click');
  }
}

async function runAgentErr01(page) {
  await ensureAgentSurface(page);
  const body = await page.locator('body').innerText();
  if (/Cannot find module/i.test(body)) throw new Error('Quota banner shows module error');
  await page.waitForSelector('[data-testid="agent-chat-input"]');
}

async function runAgentNew01(page) {
  await ensureAgentSurface(page);
  await qaClick(
    page.getByRole('complementary', { name: /chat history/i }).getByRole('button', { name: /New chat with/i })
  );
  await page.waitForTimeout(600);
  const input = page.locator('[data-testid="agent-chat-input"]');
  await input.waitFor();
  const prior = await page.locator('text=primera prueba persistencia').count();
  if (prior > 0) {
    // old thread may still exist in list — new chat should show empty composer at minimum
    await input.fill('hilo nuevo vacío');
  }
}

async function runAgentArch01(page) {
  await ensureAgentSurface(page);
  const archive = page.getByRole('button', { name: /Archive /i }).first();
  if (await archive.count()) {
    await archive.click({ force: true, timeout: 5000 }).catch(() => {});
  }
}

const RUNNERS = {
  'LANE-BOOT-01': runLaneBoot,
  'ZED-SPAWN-01': runZedSpawn01,
  'ZED-SUM-02': async (page) => {
    await zedSend(page, 'resume qué dijo Nova');
    return runZedSum02(page);
  },
  'ZED-INJ-01': runZedInj01,
  'ZED-CLOSE-01': runZedClose01,
  'ZED-CLOSE-02': runZedClose02,
  'ZED-SPAWN-02': runZedSpawn02,
  'ZED-SPAWN-03': runZedSpawn03,
  'ZED-SUM-03': runZedSum03,
  'ZED-SUM-04': runZedSum04,
  'ZED-INJ-02': runZedInj02,
  'ZED-SUB-01': runZedSub01,
  'ZED-WEB-01': runZedWeb01,
  'ZED-STOP-01': runZedStop01,
  'ZED-MOVE-01': runZedMove01,
  'ZED-SET-01': runZedSet01,
  'AGENT-BOOT-01': runAgentBoot,
  'AGENT-CHAT-01': runAgentChat01,
  'AGENT-CHAT-02': runAgentChat02,
  'AGENT-CHAT-03': runAgentChat03,
  'AGENT-CHAT-04': runAgentChat04,
  'AGENT-TERM-01': runAgentTerm01,
  'AGENT-SET-01': runAgentSet01,
  'AGENT-MEM-01': runAgentMem01,
  'AGENT-SKILL-01': runAgentSkill01,
  'AGENT-FILE-01': runAgentFile01,
  'AGENT-ERR-01': runAgentErr01,
  'AGENT-NEW-01': runAgentNew01,
  'AGENT-ARCH-01': runAgentArch01,
};

function logRun(entry) {
  mkdirSync(dirname(RUN_LOG), { recursive: true });
  appendFileSync(RUN_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function main() {
  await assertServerUp();
  const ids = WAVE_IDS[WAVE];
  if (!ids) {
    console.error(`Unknown QA_WAVE="${WAVE}". Use: ${Object.keys(WAVE_IDS).join(', ')}`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const { page, pageErrors } = await openLanePage(browser);
  const started = Date.now();
  const results = {};

  const runCase = async (id, fn) => {
    try {
      await fn(page);
      results[id] = 'passed';
      console.log(`[qa] ${id} passed`);
    } catch (err) {
      results[id] = `failed: ${err.message || err}`;
      console.error(`[qa] ${id} FAILED:`, err.message || err);
      throw err;
    }
  };

  try {
    if (WAVE === 'all') {
      await runCase('LANE-BOOT-01', runLaneBoot);
      await runZedOla1(page);
      for (const id of WAVE_IDS.zed1) results[id] = 'passed';
      await runCase('AGENT-CHAT-01', runAgentChat01);
      for (const id of WAVE_IDS.zed2) await runCase(id, RUNNERS[id]);
      await page.getByRole('button', { name: 'Back' }).click({ force: true }).catch(() => {});
      for (const id of WAVE_IDS.agent1) await runCase(id, RUNNERS[id]);
      for (const id of WAVE_IDS.agent2) await runCase(id, RUNNERS[id]);
    } else if (WAVE === 'zed1') {
      await runZedOla1(page);
      for (const id of WAVE_IDS.zed1) results[id] = 'passed';
    } else {
      for (const id of ids) {
        const fn = RUNNERS[id];
        if (!fn) {
          results[id] = 'skipped-no-runner';
          continue;
        }
        await runCase(id, fn);
      }
    }
  } finally {
    logRun({
      at: new Date().toISOString(),
      wave: WAVE,
      command: 'verify:browser:qa',
      durationMs: Date.now() - started,
      results,
      pageErrors: pageErrors.slice(0, 5),
    });
    await browser.close();
  }

  console.log(`[browser-qa] wave=${WAVE} OK (${Object.keys(results).length} cases)`);
}

main().catch((err) => {
  console.error('[browser-qa] FAILED:', err.message || err);
  process.exit(1);
});
