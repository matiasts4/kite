#!/usr/bin/env node
/**
 * Kite agent handoff CLI.
 * Writes one inbox request as a trace. Delivery goes through `kite dispatch`.
 * Does not invoke model CLIs.
 */

import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CONNECT_MS = 400;
const CORE_PIPE_CONNECT_MS = 500;
const CORE_PIPE_RESPONSE_MS = 8000;
const CORE_FRAME_HEADER_LEN = 9;
const CORE_MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

function usage() {
  console.error(`Uso:
  node scripts/kite-agent.mjs agents [--no-wait]
  node scripts/kite-agent.mjs spawn --engine <motor> --task <ruta-relativa> [--no-wait]
  node scripts/kite-agent.mjs inject --target <nombre|sessionId> --task <ruta-relativa> [--no-wait]
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-wait') {
      flags.noWait = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function ensureInbox(cwd) {
  const dir = path.join(cwd, '.kite', 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function relativeTaskPath(cwd, taskArg) {
  const resolved = path.resolve(cwd, taskArg);
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('La ruta de la tarea debe estar dentro del cwd del workspace.');
  }
  return rel.split(path.sep).join('/');
}

function writeRequest(cwd, payload) {
  const inbox = ensureInbox(cwd);
  const id = payload.id || randomUUID();
  const file = path.join(inbox, `${id}.request.json`);
  fs.writeFileSync(file, JSON.stringify({ ...payload, id }, null, 2), 'utf8');
  return id;
}

function offlineReceipt(id) {
  return {
    schemaVersion: 1,
    id,
    op: 'dispatch',
    status: 'rejected',
    address: '',
    submitted: false,
    error: 'runtime_offline',
  };
}

function endpointFile() {
  const roaming = process.env.APPDATA;
  if (!roaming) return null;
  for (const name of ['Kite Code Dev', 'Kite Code']) {
    const file = path.join(roaming, name, 'dispatch-endpoint.json');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function dispatchArgv(request, parent) {
  if (request.op === 'spawn') {
    const argv = ['dispatch', 'run', '--via', 'terminal', '--engine', request.engine, '--file', request.taskPath];
    if (typeof parent === 'string' && /^(session:|thread:|alias:)/.test(parent)) {
      argv.push('--parent', parent);
    }
    return argv;
  }
  if (request.op === 'inject') {
    return ['dispatch', 'send', request.target, '--file', request.taskPath];
  }
  return ['dispatch', 'ls'];
}

function askLoopback(id, request) {
  const file = endpointFile();
  if (!file) return null;
  const argv = dispatchArgv(request, process.env.KITE_ADDRESS);
  const waitMs = request.op === 'agents' ? CONNECT_MS : 8000;
  const code = `
    const fs = require('fs');
    const net = require('net');
    let endpoint;
    try { endpoint = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); }
    catch { process.exit(1); }
    if (!endpoint || !endpoint.port || !endpoint.token) process.exit(1);
    const socket = net.connect({ host: '127.0.0.1', port: Number(endpoint.port) });
    socket.setTimeout(${waitMs});
    const fail = () => { socket.destroy(); process.exit(1); };
    socket.on('timeout', fail);
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write(JSON.stringify({
        token: endpoint.token,
        id: process.argv[2],
        argv: JSON.parse(process.argv[6]),
        caller: process.argv[3] || 'human',
        from: process.argv[4] || '',
        workspace: process.argv[5] || '',
      }) + '\\n');
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += String(chunk);
      if (!buf.includes('\\n')) return;
      process.stdout.write(buf.split('\\n')[0]);
      socket.end();
      process.exit(0);
    });
  `;
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      code,
      file,
      id,
      process.env.KITE_DISPATCH === '1' ? 'agent' : 'human',
      process.env.KITE_ADDRESS || '',
      request.cwd || '',
      JSON.stringify(argv),
    ],
    { timeout: waitMs + 200, encoding: 'utf8' }
  );
  if (child.status !== 0 || !child.stdout) return null;
  try {
    return JSON.parse(child.stdout);
  } catch {
    return null;
  }
}

/**
 * Resolves the `kite-core` daemon endpoint for this platform.
 * Windows: `\\.\pipe\kite-core-v1-<username>`; Unix: the XDG runtime socket.
 */
export function corePipePath(env = process.env, platform = process.platform) {
  if (env.KITE_CORE_PIPE) return env.KITE_CORE_PIPE;
  if (platform === 'win32') {
    const user = env.USERNAME || env.USER || 'default';
    return `\\\\.\\pipe\\kite-core-v1-${user}`;
  }
  if (env.XDG_RUNTIME_DIR) return `${env.XDG_RUNTIME_DIR}/kite-core-v1.sock`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return `/tmp/kite-core-v1-${uid}.sock`;
}

/** Candidate `core-session.token` locations, dev build first. */
export function coreTokenPaths(env = process.env) {
  const roaming = env.APPDATA;
  if (!roaming) return [];
  return ['Kite Code Dev', 'Kite Code'].map((name) =>
    path.join(roaming, name, 'core-session.token')
  );
}

export function readCoreToken(options = {}) {
  const candidates = options.coreTokenPath
    ? [options.coreTokenPath]
    : coreTokenPaths(options.env || process.env);
  for (const file of candidates) {
    try {
      const token = fs.readFileSync(file, 'utf8').trim();
      if (token) return token;
    } catch {
      // Try the next candidate location.
    }
  }
  return '';
}

function encodeCoreFrame(channelId, kind, payload) {
  const header = Buffer.alloc(CORE_FRAME_HEADER_LEN);
  header.writeUInt32LE(channelId >>> 0, 0);
  header.writeUInt8(kind & 0xff, 4);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/**
 * Dispatches one agent action straight through the `kite-core` daemon pipe:
 * JSON-line handshake, then a 9-byte framed Channel 0 `agent.dispatch` RPC.
 *
 * Resolves the RPC `result` object, or `null` when no daemon answers.
 */
export function sendCorePipeDispatch(action, payload = {}, options = {}) {
  return new Promise((resolve) => {
    const pipePath = options.pipePath || corePipePath();
    const authToken = options.authToken ?? readCoreToken(options);
    const connectMs = options.connectTimeoutMs ?? CORE_PIPE_CONNECT_MS;
    const responseMs = options.responseTimeoutMs ?? CORE_PIPE_RESPONSE_MS;

    let socket = null;
    let buffer = Buffer.alloc(0);
    let framed = false;
    let settled = false;
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        socket?.destroy();
      } catch {
        // The socket may already be gone.
      }
      resolve(value);
    };
    const fail = () => finish(null);
    const armTimer = (ms) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fail, ms);
    };

    armTimer(connectMs);
    try {
      socket = net.createConnection(pipePath);
    } catch {
      fail();
      return;
    }

    socket.on('error', fail);
    socket.on('close', fail);
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({
          protocol: 'kite-core/v1',
          framed: true,
          client: 'kite-agent-cli',
          pid: process.pid,
          authToken,
        }) + '\n'
      );
    });

    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);

      if (!framed) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        let handshake = null;
        try {
          handshake = JSON.parse(line);
        } catch {
          return fail();
        }
        if (!handshake || handshake.protocol !== 'kite-core/v1') return fail();
        framed = true;
        armTimer(responseMs);
        const request = {
          jsonrpc: '2.0',
          id: 1,
          method: 'agent.dispatch',
          params: { action, ...payload },
        };
        socket.write(
          encodeCoreFrame(0, 0x00, Buffer.from(JSON.stringify(request), 'utf8'))
        );
      }

      while (buffer.length >= CORE_FRAME_HEADER_LEN) {
        const channelId = buffer.readUInt32LE(0);
        const kind = buffer.readUInt8(4);
        const payloadLen = buffer.readUInt32LE(5);
        if (payloadLen > CORE_MAX_FRAME_PAYLOAD) return fail();
        if (buffer.length < CORE_FRAME_HEADER_LEN + payloadLen) return;
        const framePayload = buffer.subarray(
          CORE_FRAME_HEADER_LEN,
          CORE_FRAME_HEADER_LEN + payloadLen
        );
        buffer = buffer.subarray(CORE_FRAME_HEADER_LEN + payloadLen);
        // Terminal frames may arrive first; only a Channel 0 RPC reply answers us.
        if (channelId !== 0 || kind !== 0x00) continue;
        let reply = null;
        try {
          reply = JSON.parse(framePayload.toString('utf8'));
        } catch {
          return fail();
        }
        if (reply && reply.error) return fail();
        return finish(reply && reply.result !== undefined ? reply.result : null);
      }
    });
  });
}

/** Maps a workspace inbox request onto the daemon `agent.dispatch` action. */
export function coreDispatchParams(request, id) {
  const caller = process.env.KITE_DISPATCH === '1' ? 'agent' : 'human';
  const from = process.env.KITE_ADDRESS || '';
  const base = { id, caller, from, workspace: request.cwd || '' };

  if (request.op === 'spawn') {
    return {
      action: 'run',
      payload: { ...base, via: 'terminal', engine: request.engine, file: request.taskPath },
    };
  }
  if (request.op === 'inject') {
    return {
      action: 'send',
      payload: { ...base, address: request.target, file: request.taskPath },
    };
  }
  return { action: 'ls', payload: base };
}

export function buildInboxRequest({ op, cwd, flags }) {
  const sourceSessionId =
    process.env.KITE_SOURCE_SESSION || process.env.KITE_SESSION_ID || undefined;
  const sourcePaneId = process.env.KITE_PANE_ID || undefined;

  if (op === 'agents') {
    return {
      op: 'agents',
      cwd,
      sourceSessionId,
      sourcePaneId,
    };
  }

  const taskArg = flags.task;
  if (!taskArg) {
    throw new Error('Falta --task con la ruta al archivo de tarea.');
  }
  const taskPath = relativeTaskPath(cwd, taskArg);

  if (op === 'spawn') {
    const engine = flags.engine;
    if (!engine) {
      throw new Error('Falta --engine para spawn.');
    }
    return {
      op: 'spawn',
      engine,
      taskPath,
      cwd,
      sourceSessionId,
      sourcePaneId,
    };
  }

  if (op === 'inject') {
    const target = flags.target;
    if (!target) {
      throw new Error('Falta --target para inject.');
    }
    return {
      op: 'inject',
      target,
      taskPath,
      cwd,
      sourceSessionId,
      sourcePaneId,
    };
  }

  throw new Error(`Operación desconocida: ${op}`);
}

function emitDispatchResult(id, result) {
  if (!result) {
    console.log(JSON.stringify(offlineReceipt(id)));
    return 1;
  }
  const receipt = result.receipt || result;
  console.log(JSON.stringify(receipt));
  if (typeof result.exit === 'number') return result.exit;
  return receipt.error || receipt.ok === false ? 1 : 0;
}

export function runCli(argv, options = {}) {
  const cwd = options.cwd || process.cwd();
  const { positional, flags } = parseArgs(argv);
  const op = positional[0];
  if (!op) {
    usage();
    return 1;
  }

  let request;
  try {
    request = buildInboxRequest({ op, cwd, flags });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const id = writeRequest(cwd, { ...request, id: request.id || undefined });

  if (flags.noWait || options.noWait) {
    console.log(JSON.stringify({ id, written: true, status: 'queued', submitted: false }));
    return 0;
  }

  // Prefer the GUI loopback endpoint while a desktop window is mounted.
  const result = options.waitFn ? options.waitFn(cwd, id) : askLoopback(id, request);
  if (result || options.waitFn) return emitDispatchResult(id, result);

  // The GUI is closed or its endpoint is stale: dispatch straight through the
  // `kite-core` daemon pipe so agents keep running headless.
  const pipeFn = options.pipeFn || sendCorePipeDispatch;
  const { action, payload } = coreDispatchParams(request, id);
  return pipeFn(action, payload).then(
    (pipeResult) => emitDispatchResult(id, pipeResult),
    () => emitDispatchResult(id, null)
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  void Promise.resolve(runCli(process.argv.slice(2))).then((code) => process.exit(code));
}
