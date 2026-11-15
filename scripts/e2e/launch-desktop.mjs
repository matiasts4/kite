import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  createDesktopSandbox,
  killProcessTree,
  killSandboxWebViewProcesses,
  removeSandboxDir,
} from './sandbox.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

const VITE_ORIGIN = 'http://127.0.0.1:1420';

function createLogBuffer(maxLines = 400) {
  const lines = [];
  return {
    push(chunk, source) {
      const text = chunk.toString('utf8');
      for (const rawLine of text.split(/\r?\n/)) {
        if (!rawLine) continue;
        lines.push(`[${source}] ${rawLine}`);
        if (lines.length > maxLines) {
          lines.shift();
        }
      }
    },
    dump() {
      return lines.join('\n');
    },
  };
}

function httpGetJsonOrStatus(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ ok: res.statusCode === 200, status: res.statusCode || 0, body });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: '' });
    });
  });
}

async function waitUntil(fn, timeoutMs, intervalMs, timeoutMessage) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const detail = lastErr instanceof Error ? ` (${lastErr.message})` : '';
  throw new Error(`${timeoutMessage}${detail}`);
}

/**
 * Resolves the Kite Code desktop binary path to execute.
 * Uses the debug build by default because release enables single-instance forwarding.
 * @returns {string}
 */
export function resolveDesktopBinary() {
  const configured = process.env.KITE_E2E_BIN;
  const exeName = process.platform === 'win32' ? 'kite-code.exe' : 'kite-code';
  const candidate = configured
    ? path.resolve(REPO_ROOT, configured)
    : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug', exeName);

  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Kite desktop binary not found at ${candidate}. Run "cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin kite-code --bin kite" first.`
    );
  }
  return candidate;
}

async function ensureViteDevServer(logs) {
  const probe = await httpGetJsonOrStatus(`${VITE_ORIGIN}/`, 1200);
  if (probe.ok) {
    return { viteChild: null, viteOwned: false };
  }

  const viteEntry = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteEntry)) {
    throw new Error(`Vite CLI not found at ${viteEntry}. Run npm install first.`);
  }

  const viteChild = spawn(
    process.execPath,
    [viteEntry, '--host', '127.0.0.1', '--port', '1420', '--strictPort'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  viteChild.stdout?.on('data', (chunk) => logs.push(chunk, 'vite'));
  viteChild.stderr?.on('data', (chunk) => logs.push(chunk, 'vite:err'));

  await waitUntil(
    async () => {
      if (viteChild.exitCode !== null) {
        throw new Error(`Vite exited early with code ${viteChild.exitCode}`);
      }
      const res = await httpGetJsonOrStatus(`${VITE_ORIGIN}/`, 1000);
      return res.ok;
    },
    30_000,
    250,
    'Timed out waiting for Vite dev server on http://127.0.0.1:1420'
  );

  return { viteChild, viteOwned: true };
}

function waitForPipeNameReady(pipeName, daemonChild, timeoutMs = 10_000) {
  if (process.platform === 'win32') {
    const barePipeName = pipeName.replace(/^\\\\\.\\pipe\\/, '');
    return waitUntil(
      async () => {
        if (daemonChild.exitCode !== null) {
          throw new Error(`kite-code --daemon exited early with code ${daemonChild.exitCode}`);
        }
        try {
          const entries = fs.readdirSync('\\\\.\\pipe\\');
          return entries.includes(barePipeName);
        } catch {
          return false;
        }
      },
      timeoutMs,
      100,
      `Timed out waiting for isolated core daemon pipe ${pipeName}`
    );
  }

  return waitUntil(
    async () => {
      if (daemonChild.exitCode !== null) {
        throw new Error(`kite-code --daemon exited early with code ${daemonChild.exitCode}`);
      }
      return fs.existsSync(pipeName);
    },
    timeoutMs,
    100,
    `Timed out waiting for isolated core daemon socket ${pipeName}`
  );
}

/**
 * Launches an isolated Kite Code desktop instance (dedicated core daemon, WebView2 profile,
 * AppData/LocalAppData, and CDP port) and connects Playwright over CDP.
 *
 * @param {{
 *   runId?: string,
 *   artifactsDir?: string,
 *   extraPathDirs?: string[],
 *   extraEnv?: Record<string, string>,
 *   bootTimeoutMs?: number,
 *   keepSandboxOnExit?: boolean,
 * }} [options]
 */
export async function launchIsolatedDesktop(options = {}) {
  const bootTimeoutMs = options.bootTimeoutMs || 45_000;
  const binaryPath = resolveDesktopBinary();
  const logs = createLogBuffer(500);
  const sandbox = await createDesktopSandbox({
    runId: options.runId,
    extraPathDirs: options.extraPathDirs,
    extraEnv: options.extraEnv,
  });

  if (typeof options.setupSandbox === 'function') {
    await options.setupSandbox(sandbox);
  }

  const artifactsDir =
    options.artifactsDir ||
    path.join(REPO_ROOT, 'test-results', 'e2e', `run-${sandbox.runId}`);
  await fsp.mkdir(artifactsDir, { recursive: true });

  let viteChild = null;
  let viteOwned = false;
  let daemonChild = null;
  let guiChild = null;
  let browser = null;
  let page = null;
  let closed = false;

  const pageErrors = [];
  const consoleErrors = [];

  const cleanup = async ({ failed = false } = {}) => {
    if (closed) return;
    closed = true;

    try {
      if (browser) {
        await browser.close().catch(() => {});
      }
    } finally {
      killProcessTree(guiChild?.pid);
      killProcessTree(daemonChild?.pid);
      killSandboxWebViewProcesses(sandbox.webviewUserDataDir);
      if (viteOwned && viteChild?.pid) {
        killProcessTree(viteChild.pid);
      }

      const dump = logs.dump();
      if (dump) {
        await fsp.writeFile(path.join(artifactsDir, 'process-logs.txt'), dump, 'utf8').catch(() => {});
      }
      for (const debugName of ['driver-calls.jsonl', 'driver-errors.log']) {
        const src = path.join(sandbox.rootDir, debugName);
        if (fs.existsSync(src)) {
          await fsp.copyFile(src, path.join(artifactsDir, debugName)).catch(() => {});
        }
      }

      if (!options.keepSandboxOnExit && !process.env.KITE_E2E_KEEP_SANDBOX) {
        await removeSandboxDir(sandbox.rootDir);
      } else if (failed) {
        logs.push(Buffer.from(`Preserved sandbox at ${sandbox.rootDir}`), 'harness');
      }
    }
  };

  try {
    // 1. Ensure Vite dev server is serving on :1420 for debug builds before booting GUI.
    const viteState = await ensureViteDevServer(logs);
    viteChild = viteState.viteChild;
    viteOwned = viteState.viteOwned;

    // 2. Pre-start an isolated core daemon under our direct process handle so GUI connects
    // to this daemon instead of spawning an untracked DETACHED_PROCESS daemon.
    daemonChild = spawn(binaryPath, ['--daemon'], {
      cwd: sandbox.workspaceDir,
      env: sandbox.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    daemonChild.stdout?.on('data', (chunk) => logs.push(chunk, 'daemon'));
    daemonChild.stderr?.on('data', (chunk) => logs.push(chunk, 'daemon:err'));
    await waitForPipeNameReady(sandbox.pipeName, daemonChild, 12_000);

    // 3. Spawn the desktop WebView2 window with remote debugging enabled on our free port.
    guiChild = spawn(binaryPath, [], {
      cwd: sandbox.workspaceDir,
      env: sandbox.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    guiChild.stdout?.on('data', (chunk) => logs.push(chunk, 'gui'));
    guiChild.stderr?.on('data', (chunk) => logs.push(chunk, 'gui:err'));

    const cdpBaseUrl = `http://127.0.0.1:${sandbox.cdpPort}`;
    await waitUntil(
      async () => {
        if (guiChild.exitCode !== null) {
          throw new Error(`kite-code GUI exited early with code ${guiChild.exitCode}`);
        }
        const versionProbe = await httpGetJsonOrStatus(`${cdpBaseUrl}/json/version`, 1000);
        if (!versionProbe.ok) return false;
        const listProbe = await httpGetJsonOrStatus(`${cdpBaseUrl}/json/list`, 1000);
        if (!listProbe.ok) return false;
        try {
          const targets = JSON.parse(listProbe.body);
          return Array.isArray(targets) && targets.some((t) => t.type === 'page' && t.url && t.url !== 'about:blank');
        } catch {
          return false;
        }
      },
      bootTimeoutMs,
      250,
      `Timed out waiting for WebView2 CDP endpoint at ${cdpBaseUrl}`
    );

    browser = await chromium.connectOverCDP(cdpBaseUrl);
    page = await waitUntil(
      async () => {
        for (const ctx of browser.contexts()) {
          for (const candidate of ctx.pages()) {
            const url = candidate.url();
            if (url && !url.startsWith('devtools://') && url !== 'about:blank') {
              return candidate;
            }
          }
        }
        return null;
      },
      15_000,
      200,
      'Timed out locating main Kite Code page via CDP'
    );

    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? err.stack || err.message : String(err));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // When attaching over CDP after initial navigation starts/completes, waitForLoadState('domcontentloaded')
    // can hang waiting for a future load event; inspect document.readyState and shell UI directly.
    await page.waitForFunction(
      () => document.readyState !== 'loading' && Boolean(document.body),
      null,
      { timeout: bootTimeoutMs }
    );
    // Wait until the intro splash releases and the main shell work mode toggle renders.
    await page.locator('fieldset[aria-label="Work mode"]').waitFor({
      state: 'visible',
      timeout: bootTimeoutMs,
    });

    return {
      browser,
      page,
      sandbox,
      artifactsDir,
      pageErrors,
      consoleErrors,
      logs,
      close: cleanup,
    };
  } catch (err) {
    if (page) {
      await page
        .screenshot({ path: path.join(artifactsDir, 'BOOT-timeout.png'), fullPage: false })
        .catch(() => {});
    }
    await cleanup({ failed: true });
    const logText = logs.dump();
    const enriched = err instanceof Error ? err : new Error(String(err));
    if (logText) {
      enriched.message = `${enriched.message}\n--- Process Logs ---\n${logText}`;
    }
    throw enriched;
  }
}
