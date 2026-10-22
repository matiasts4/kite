/**
 * Browser test lane: Express IPC mock + Vite on :1430 (does not replace tauri dev / installer).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const apiPort = process.env.KITE_BROWSER_API_PORT || '1421';
const apiUrl = `http://127.0.0.1:${apiPort}`;

const serverEnv = {
  ...process.env,
  PORT: apiPort,
  KITE_BROWSER_TEST: '1',
};

const server = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
  cwd: root,
  env: serverEnv,
  stdio: 'inherit',
  shell: false,
});

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(
  process.execPath,
  [viteBin, '--mode', 'browser', '--host', '127.0.0.1', '--port', '1430', '--strictPort'],
  {
    cwd: root,
    env: {
      ...process.env,
      KITE_BROWSER_API_URL: apiUrl,
      KITE_BROWSER_TEST: '1',
    },
    stdio: 'inherit',
    shell: false,
  }
);

function shutdown(code = 0) {
  vite.kill(isWin ? undefined : 'SIGTERM');
  server.kill(isWin ? undefined : 'SIGTERM');
  process.exit(code);
}

server.on('exit', (code) => {
  if (code && code !== 0) shutdown(code);
});
vite.on('exit', (code) => {
  shutdown(code ?? 0);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`
[Kite browser test lane]
  UI:  http://127.0.0.1:1430
  API: ${apiUrl}
  Agent fixture: Antigravity only
`);
