import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOST_HOME_DIR = os.homedir();

export const PINNED_WEBVIEW2_VERSION = '149.0.4022.98';
export const DEFAULT_FIXED_WEBVIEW2_ROOT = path.join(
  HOST_HOME_DIR,
  '.cache',
  'kite-code-e2e',
  'webview2',
  PINNED_WEBVIEW2_VERSION
);
export const DEFAULT_FIXED_WEBVIEW2_DIR = path.join(
  DEFAULT_FIXED_WEBVIEW2_ROOT,
  'contentFiles',
  'any',
  'any',
  'WebView2'
);

/**
 * Ensures Windows E2E tests use a pre-hardening WebView2 Fixed Version runtime (< 150)
 * because Evergreen WebView2 153-157 blocks `--remote-debugging-port` loopback connections.
 * @returns {string | undefined}
 */
export function ensureWindowsFixedWebView2Dir() {
  if (process.platform !== 'win32') return undefined;
  if (process.env.KITE_E2E_USE_SYSTEM_WEBVIEW2 === '1') return undefined;

  const explicit = process.env.KITE_E2E_WEBVIEW2_DIR || process.env.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;
  if (explicit) {
    return path.win32.resolve(explicit);
  }

  const exePath = path.join(DEFAULT_FIXED_WEBVIEW2_DIR, 'msedgewebview2.exe');
  if (!fsSync.existsSync(exePath)) {
    fsSync.mkdirSync(DEFAULT_FIXED_WEBVIEW2_ROOT, { recursive: true });
    const nupkgUrl = `https://api.nuget.org/v3-flatcontainer/webview2.runtime.x64/${PINNED_WEBVIEW2_VERSION}/webview2.runtime.x64.${PINNED_WEBVIEW2_VERSION}.nupkg`;
    const archivePath = path.join(DEFAULT_FIXED_WEBVIEW2_ROOT, 'webview2-fixed.nupkg');
    try {
      execFileSync('curl.exe', ['-fsSL', '--retry', '2', '-o', archivePath, nupkgUrl], {
        stdio: 'inherit',
        timeout: 240_000,
      });
      execFileSync('tar.exe', ['-xf', archivePath, '-C', DEFAULT_FIXED_WEBVIEW2_ROOT], {
        stdio: 'inherit',
        timeout: 120_000,
      });
    } finally {
      try {
        fsSync.rmSync(archivePath, { force: true });
      } catch {
        // Ignore cleanup failure for temporary package file.
      }
    }
    if (!fsSync.existsSync(exePath)) {
      throw new Error(
        `Failed to provision pinned WebView2 runtime at ${DEFAULT_FIXED_WEBVIEW2_DIR}. Pass KITE_E2E_WEBVIEW2_DIR explicitly.`
      );
    }
  }

  return path.win32.resolve(DEFAULT_FIXED_WEBVIEW2_DIR);
}

/**
 * Finds an available loopback TCP port by briefly binding port 0.
 * @returns {Promise<number>}
 */
export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate ephemeral TCP port')));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Returns the platform-specific isolated core pipe/socket name for an E2E run.
 * Matches Kite's `get_core_pipe_name()` contract (`KITE_CORE_PIPE` is used verbatim).
 * @param {string} runId
 * @returns {string}
 */
export function buildCorePipeName(runId) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\kite-core-e2e-${runId}`;
  }
  return path.join(os.tmpdir(), `kite-core-e2e-${runId}.sock`);
}

/**
 * Creates an isolated filesystem sandbox for Kite Code desktop E2E tests so tests never
 * share SQLite databases, WebView2 user-data folders, or named pipes with live user instances.
 * @param {{ runId?: string, extraPathDirs?: string[], extraEnv?: Record<string, string> }} [options]
 */
export async function createDesktopSandbox(options = {}) {
  const runId = options.runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `kite-e2e-${runId}-`));
  const appDataDir = path.join(rootDir, 'appdata');
  const localAppDataDir = path.join(rootDir, 'localappdata');
  const homeDir = path.join(rootDir, 'home');
  const workspaceDir = path.join(rootDir, 'workspace');
  const binDir = path.join(rootDir, 'bin');
  const webviewUserDataDir = path.join(localAppDataDir, 'dev.kite.code.dev', 'EBWebView');

  await Promise.all([
    fs.mkdir(appDataDir, { recursive: true }),
    fs.mkdir(localAppDataDir, { recursive: true }),
    fs.mkdir(homeDir, { recursive: true }),
    fs.mkdir(workspaceDir, { recursive: true }),
    fs.mkdir(binDir, { recursive: true }),
    fs.mkdir(webviewUserDataDir, { recursive: true }),
  ]);

  const cdpPort = await findFreePort();
  const pipeName = buildCorePipeName(runId);
  const pathDelimiter = process.platform === 'win32' ? ';' : ':';
  const prependedPaths = [binDir, ...(options.extraPathDirs || [])];
  const basePath = process.env.PATH || process.env.Path || '';
  const mergedPath = [...prependedPaths, basePath].filter(Boolean).join(pathDelimiter);

  const fixedWebView2Dir = ensureWindowsFixedWebView2Dir();

  const env = { ...process.env };
  // Strip ambient overrides that could leak a developer's active daemon or WebView profile.
  delete env.KITE_CORE_PIPE;
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  delete env.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;
  delete env.KITE_E2E_SCENARIO;

  Object.assign(env, {
    APPDATA: appDataDir,
    LOCALAPPDATA: localAppDataDir,
    USERPROFILE: homeDir,
    HOME: homeDir,
    KITE_CORE_PIPE: pipeName,
    WEBVIEW2_USER_DATA_FOLDER: webviewUserDataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...(fixedWebView2Dir ? { WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: fixedWebView2Dir } : {}),
    PATH: mergedPath,
    Path: mergedPath,
    KITE_E2E_SANDBOX_ROOT: rootDir,
    KITE_E2E_WORKSPACE_DIR: workspaceDir,
  });

  if (options.extraEnv) {
    Object.assign(env, options.extraEnv);
  }

  return {
    runId,
    rootDir,
    appDataDir,
    localAppDataDir,
    homeDir,
    workspaceDir,
    binDir,
    webviewUserDataDir,
    cdpPort,
    pipeName,
    env,
  };
}

/**
 * Terminates a process and its descendants cleanly across Windows and POSIX platforms.
 * @param {number | undefined} pid
 */
export function killProcessTree(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 8000,
      });
      return;
    } catch {
      // Process may already have exited; fall through to best-effort signal check.
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Ignore ESRCH when process already terminated.
  }
}

/**
 * Kills leftover sandbox WebView2 helper processes whose CLI points directly into `webviewUserDataDir`.
 * Strictly scoped to the unique temp sandbox folder so user apps remain untouched.
 * @param {string} webviewUserDataDir
 */
export function killSandboxWebViewProcesses(webviewUserDataDir) {
  if (process.platform !== 'win32' || !webviewUserDataDir) return;
  const escaped = webviewUserDataDir.replace(/'/g, "''");
  const script = [
    "$target = '" + escaped + "';",
    "Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" -ErrorAction SilentlyContinue |",
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($target) } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join(' ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 8000,
    });
  } catch {
    // Best-effort cleanup of WebView2 renderer helpers.
  }
}

/**
 * Removes the temporary sandbox directory after short retries for Windows handle release.
 * @param {string} rootDir
 */
export async function removeSandboxDir(rootDir) {
  if (!rootDir) return;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rm(rootDir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === maxAttempts) return;
      await new Promise((r) => setTimeout(r, attempt * 250));
    }
  }
}
