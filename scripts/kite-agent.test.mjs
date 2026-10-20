import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInboxRequest, runCli } from './kite-agent.mjs';

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
