import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  buildInboxRequest,
  coreDispatchParams,
  corePipePath,
  dispatchArgv,
  runCli,
  sendCorePipeDispatch,
} from './kite-agent.mjs';

test('request JSON carries taskPath but not task file body', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-agent-cli-'));
  const secret = 'TEXTO_SECRETO_DE_LA_TAREA_NO_DEBE_ESTAR_EN_JSON';
  const taskRel = '.kite/tasks/prueba.md';
  fs.mkdirSync(path.join(cwd, '.kite', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(cwd, taskRel), secret, 'utf8');

  const request = buildInboxRequest({
    op: 'spawn',
    cwd,
    flags: { engine: 'antigravity', task: taskRel },
  });

  assert.equal(request.taskPath, '.kite/tasks/prueba.md');
  assert.equal(request.op, 'spawn');
  assert.equal(JSON.stringify(request).includes(secret), false);

  const code = runCli(['spawn', '--engine', 'antigravity', '--task', taskRel, '--no-wait'], {
    cwd,
    noWait: true,
  });
  assert.equal(code, 0);

  const inbox = path.join(cwd, '.kite', 'inbox');
  const files = fs.readdirSync(inbox).filter((f) => f.endsWith('.request.json'));
  assert.equal(files.length, 1);
  const written = fs.readFileSync(path.join(inbox, files[0]), 'utf8');
  assert.equal(written.includes(secret), false);
  assert.equal(written.includes('taskPath'), true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('spawn argv calls dispatch and does not embed a task body', () => {
  const argv = dispatchArgv(
    { op: 'spawn', engine: 'codex', taskPath: '.kite/tasks/prueba.md' },
    'session:parent-1'
  );
  assert.deepEqual(argv.slice(0, 6), [
    'dispatch',
    'run',
    '--via',
    'terminal',
    '--engine',
    'codex',
  ]);
  assert.equal(argv.includes('--file'), true);
  assert.equal(argv.includes('.kite/tasks/prueba.md'), true);
  assert.equal(argv.at(-1), 'session:parent-1');
  assert.equal(argv.join('\n').includes('TEXTO_SECRETO'), false);

  const human = dispatchArgv(
    { op: 'spawn', engine: 'codex', taskPath: '.kite/tasks/prueba.md' },
    'human'
  );
  assert.equal(human.includes('--parent'), false);
});

test('corePipePath resolves the per-user kite-core named pipe', () => {
  assert.equal(
    corePipePath({ USERNAME: 'alice' }, 'win32'),
    '\\\\.\\pipe\\kite-core-v1-alice'
  );
  assert.equal(
    corePipePath({ USER: 'bob' }, 'win32'),
    '\\\\.\\pipe\\kite-core-v1-bob'
  );
  assert.equal(
    corePipePath({ USERNAME: 'alice', KITE_CORE_PIPE: '\\\\.\\pipe\\custom' }, 'win32'),
    '\\\\.\\pipe\\custom'
  );
  assert.equal(
    corePipePath({ XDG_RUNTIME_DIR: '/run/user/7' }, 'linux'),
    '/run/user/7/kite-core-v1.sock'
  );
});

test('coreDispatchParams maps workspace requests onto daemon dispatch actions', () => {
  const spawn = coreDispatchParams(
    { op: 'spawn', engine: 'codex', taskPath: '.kite/tasks/x.md', cwd: 'E:\\ws' },
    'id-1'
  );
  assert.equal(spawn.action, 'run');
  assert.equal(spawn.payload.file, '.kite/tasks/x.md');
  assert.equal(spawn.payload.via, 'terminal');
  assert.equal(spawn.payload.id, 'id-1');
  assert.equal(spawn.payload.workspace, 'E:\\ws');

  const inject = coreDispatchParams(
    { op: 'inject', target: 'Orion', taskPath: '.kite/tasks/x.md', cwd: '/ws' },
    'id-2'
  );
  assert.equal(inject.action, 'send');
  assert.equal(inject.payload.address, 'Orion');

  const agents = coreDispatchParams({ op: 'agents', cwd: '/ws' }, 'id-3');
  assert.equal(agents.action, 'ls');
});

test('sendCorePipeDispatch speaks the JSON handshake and one framed Channel 0 RPC', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-core-pipe-'));
  const tokenFile = path.join(dir, 'core-session.token');
  fs.writeFileSync(tokenFile, 'kt-test-token\n', 'utf8');
  const pipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\kite-core-test-${process.pid}-${Date.now()}`
      : path.join(dir, 'kite-core-v1-test.sock');

  const observed = { handshake: null, request: null };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let framed = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!framed) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        observed.handshake = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        buffer = buffer.subarray(newline + 1);
        framed = true;
        socket.write(
          JSON.stringify({
            protocol: 'kite-core/v1',
            framed: true,
            coreVersion: '0.1.0',
            corePid: process.pid,
            activeSessions: 0,
          }) + '\n'
        );
      }
      while (buffer.length >= 9) {
        const channelId = buffer.readUInt32LE(0);
        const kind = buffer[4];
        const length = buffer.readUInt32LE(5);
        if (buffer.length < 9 + length) return;
        const payload = buffer.subarray(9, 9 + length);
        buffer = buffer.subarray(9 + length);
        const body = JSON.parse(payload.toString('utf8'));
        observed.request = { channelId, kind, body };
        const reply = Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { ok: true, id: 'pipe-dispatch-1', via: 'kite-core' },
          }),
          'utf8'
        );
        const header = Buffer.alloc(9);
        header.writeUInt32LE(0, 0);
        header.writeUInt8(0x00, 4);
        header.writeUInt32LE(reply.length, 5);
        socket.write(Buffer.concat([header, reply]));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, resolve);
  });

  try {
    const result = await sendCorePipeDispatch(
      'run',
      { engine: 'codex', file: '.kite/tasks/prueba.md', caller: 'agent' },
      {
        pipePath,
        coreTokenPath: tokenFile,
        connectTimeoutMs: 3000,
        responseTimeoutMs: 3000,
      }
    );

    assert.deepEqual(result, { ok: true, id: 'pipe-dispatch-1', via: 'kite-core' });
    assert.equal(observed.handshake.protocol, 'kite-core/v1');
    assert.equal(observed.handshake.framed, true);
    assert.equal(observed.handshake.client, 'kite-agent-cli');
    assert.equal(observed.handshake.authToken, 'kt-test-token');
    assert.equal(typeof observed.handshake.pid, 'number');
    assert.equal(observed.request.channelId, 0);
    assert.equal(observed.request.kind, 0x00);
    assert.equal(observed.request.body.jsonrpc, '2.0');
    assert.equal(observed.request.body.method, 'agent.dispatch');
    assert.equal(observed.request.body.params.action, 'run');
    assert.equal(observed.request.body.params.engine, 'codex');
    assert.equal(observed.request.body.params.file, '.kite/tasks/prueba.md');
    assert.equal(observed.request.body.params.caller, 'agent');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sendCorePipeDispatch resolves null when no daemon answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-core-pipe-'));
  const pipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\kite-core-missing-${process.pid}-${Date.now()}`
      : path.join(dir, 'kite-core-missing.sock');
  try {
    const result = await sendCorePipeDispatch(
      'ls',
      {},
      {
        pipePath,
        coreTokenPath: path.join(dir, 'missing.token'),
        connectTimeoutMs: 250,
        responseTimeoutMs: 250,
      }
    );
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli falls back to the kite-core pipe when the GUI loopback is unavailable', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-agent-cli-'));
  const taskRel = '.kite/tasks/prueba.md';
  fs.mkdirSync(path.join(cwd, '.kite', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(cwd, taskRel), 'body', 'utf8');

  const previousAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(cwd, 'appdata');

  const calls = [];
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    const code = await runCli(['spawn', '--engine', 'codex', '--task', taskRel], {
      cwd,
      pipeFn: (action, payload) => {
        calls.push({ action, payload });
        return Promise.resolve({ op: 'spawn', status: 'queued', ok: true });
      },
    });
    assert.equal(code, 0);
  } finally {
    console.log = originalLog;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'run');
  assert.equal(calls[0].payload.engine, 'codex');
  assert.equal(calls[0].payload.file, '.kite/tasks/prueba.md');
  assert.equal(JSON.parse(lines[0]).status, 'queued');
});
