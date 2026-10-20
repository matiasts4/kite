#!/usr/bin/env node
/**
 * Kite agent handoff CLI — writes inbox requests; Kite desktop delivers full task file body.
 * Does not invoke model CLIs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WAIT_MS = 8000;
const POLL_MS = 100;

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

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait — short polls for inbox result
  }
}

function waitForResultSync(cwd, id) {
  const resultPath = path.join(cwd, '.kite', 'inbox', `${id}.result.json`);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }
    sleepSync(POLL_MS);
  }
  return null;
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

  const id = writeRequest(cwd, request);

  if (flags.noWait || options.noWait) {
    console.log(JSON.stringify({ id, written: true }, null, 2));
    return 0;
  }

  const result = options.waitFn ? options.waitFn(cwd, id) : waitForResultSync(cwd, id);
  if (!result) {
    console.error(
      'La app Kite no recogió la orden a tiempo. Abrí el workspace en Kite Code e intentá de nuevo.'
    );
    return 1;
  }

  console.log(JSON.stringify(result, null, 2));
  return result.ok === false ? 1 : 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
