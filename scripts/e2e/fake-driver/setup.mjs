import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DRIVER_ENTRY = path.join(__dirname, 'driver.mjs');

const FAKE_DRIVERS = ['claude', 'grok', 'agy', 'codex'];

const WIN_SHIM_RS = `use std::env;
use std::path::Path;
use std::process::{exit, Command};

fn main() {
    let exe_path = env::current_exe().unwrap_or_default();
    let stem = Path::new(&exe_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("claude");
    let driver_entry = env::var("KITE_E2E_DRIVER_ENTRY")
        .expect("KITE_E2E_DRIVER_ENTRY must be set");
    let node_bin = env::var("KITE_E2E_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    let args: Vec<String> = env::args().skip(1).collect();

    let status = Command::new(node_bin)
        .arg(driver_entry)
        .arg("--driver")
        .arg(stem)
        .args(&args)
        .status()
        .expect("failed to execute node fake driver");
    exit(status.code().unwrap_or(1));
}
`;

async function ensureWindowsNativeShimExe() {
  const cacheDir = path.join(os.homedir(), '.cache', 'kite-code-e2e');
  const exePath = path.join(cacheDir, 'win-shim-v1.exe');
  try {
    const stat = await fs.stat(exePath);
    if (stat.size > 0) return exePath;
  } catch {
    // Build cached native shim once via rustc so multi-line prompts bypass cmd.exe `%*` truncation.
  }

  await fs.mkdir(cacheDir, { recursive: true });
  const srcPath = path.join(cacheDir, 'win-shim-v1.rs');
  await fs.writeFile(srcPath, WIN_SHIM_RS, 'utf8');
  try {
    await execFileAsync('rustc', ['-O', srcPath, '-o', exePath]);
    return exePath;
  } catch {
    return null;
  }
}

function buildWindowsCmdShim(driverName) {
  return [
    '@echo off',
    'setlocal',
    'if defined KITE_E2E_NODE_BIN (',
    `  "%KITE_E2E_NODE_BIN%" "${DRIVER_ENTRY}" --driver ${driverName} %*`,
    ') else (',
    `  node "${DRIVER_ENTRY}" --driver ${driverName} %*`,
    ')',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

function buildPosixShim(driverName) {
  return [
    '#!/usr/bin/env sh',
    'NODE_BIN="${KITE_E2E_NODE_BIN:-node}"',
    `exec "$NODE_BIN" "${DRIVER_ENTRY}" --driver ${driverName} "$@"`,
    '',
  ].join('\n');
}

async function ensureGitWorkspace(workspaceDir) {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspaceDir });
    return;
  } catch {
    // Initialize a self-contained git repository for isolated worktree & branch checks.
  }

  await fs.writeFile(
    path.join(workspaceDir, 'README.md'),
    '# Kite E2E Sandbox Workspace\n',
    'utf8',
  );
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: workspaceDir });
  await execFileAsync('git', ['config', 'user.name', 'Kite E2E'], { cwd: workspaceDir });
  await execFileAsync('git', ['config', 'user.email', 'e2e@kite.local'], { cwd: workspaceDir });
  await execFileAsync('git', ['add', 'README.md'], { cwd: workspaceDir });
  await execFileAsync('git', ['commit', '-m', 'chore: init e2e workspace'], { cwd: workspaceDir });
}

/**
 * Installs isolated fake provider CLIs, auth markers, and scenario script into `sandbox`.
 *
 * Only platform-native shims are emitted into `sandbox.binDir` so extensionless POSIX
 * scripts never shadow `.cmd` wrappers under Windows `CreateProcessW` resolution.
 *
 * @param {import('../sandbox.mjs').DesktopSandbox} sandbox
 * @param {Record<string, any>} scenarioConfig
 */
export async function prepareFakeDriverSandbox(sandbox, scenarioConfig = {}) {
  const scenarioPath = path.join(sandbox.rootDir, 'e2e-scenario.json');
  await fs.writeFile(scenarioPath, JSON.stringify(scenarioConfig, null, 2), 'utf8');

  sandbox.env.KITE_E2E_SCENARIO_FILE = scenarioPath;
  sandbox.env.KITE_E2E_NODE_BIN = process.execPath;
  sandbox.env.KITE_E2E_DRIVER_ENTRY = DRIVER_ENTRY;

  const isWin = process.platform === 'win32';
  const winNativeShimExe = isWin ? await ensureWindowsNativeShimExe() : null;
  for (const driverName of FAKE_DRIVERS) {
    if (isWin && winNativeShimExe) {
      await fs.copyFile(winNativeShimExe, path.join(sandbox.binDir, `${driverName}.exe`));
      continue;
    }
    const fileName = isWin ? `${driverName}.cmd` : driverName;
    const shimPath = path.join(sandbox.binDir, fileName);
    const content = isWin ? buildWindowsCmdShim(driverName) : buildPosixShim(driverName);
    await fs.writeFile(shimPath, content, 'utf8');
    if (!isWin) {
      await fs.chmod(shimPath, 0o755);
    }
  }

  // Seed filesystem auth markers inspected by `provider_signed_in`.
  await fs.writeFile(path.join(sandbox.homeDir, '.claude.json'), '{"e2e":true}\n', 'utf8');
  await fs.mkdir(path.join(sandbox.homeDir, '.grok'), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.homeDir, '.grok', 'auth.json'),
    '{"apiKey":"e2e-fake-grok-key"}\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(sandbox.homeDir, '.grok', 'models_cache.json'),
    JSON.stringify([{ id: 'grok-4', name: 'Grok 4' }]),
    'utf8',
  );
  await fs.mkdir(path.join(sandbox.homeDir, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(sandbox.homeDir, '.codex', 'auth.json'),
    '{"OPENAI_API_KEY":"e2e-fake-codex-key"}\n',
    'utf8',
  );

  await ensureGitWorkspace(sandbox.workspaceDir);
  return { scenarioPath };
}

/**
 * Reads recorded fake driver invocations and child `kite dispatch` runs from the sandbox.
 *
 * @param {import('../sandbox.mjs').DesktopSandbox} sandbox
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readDriverCallLog(sandbox) {
  const logPath = path.join(sandbox.rootDir, 'driver-calls.jsonl');
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
