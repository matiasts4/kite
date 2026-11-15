import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const DRIVER_VERSIONS = {
  claude: '2.1.12 (Claude Code)',
  grok: 'grok 1.0.77 (50ca579fa996)',
  agy: '1.4.5',
  antigravity: '1.4.5',
  codex: 'codex-cli 0.163.0',
};

const FAKE_MODELS_OUTPUT = [
  'gemini-2.5-flash\tGemini 2.5 Flash',
  'gemini-2.5-pro\tGemini 2.5 Pro',
  'claude-sonnet-4-6\tClaude Sonnet 4.6',
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseDriverArgs(rawArgv) {
  const args = [];
  let driver = process.env.KITE_E2E_DRIVER_NAME || 'claude';
  for (let i = 0; i < rawArgv.length; i += 1) {
    if (rawArgv[i] === '--driver' && rawArgv[i + 1]) {
      driver = rawArgv[i + 1].toLowerCase();
      i += 1;
      continue;
    }
    args.push(rawArgv[i]);
  }
  return { driver, args };
}

function extractPromptFromArgs(driver, args) {
  const pIndex = args.indexOf('-p');
  if (driver === 'grok' && pIndex >= 0 && args[pIndex + 1]) {
    return args[pIndex + 1];
  }
  const valueFlags = new Set([
    '--output-format',
    '--permission-mode',
    '--mode',
    '--model',
    '--effort',
    '--resume',
    '--conversation',
    '-m',
  ]);
  let lastPositional = '';
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-p' || token === 'exec' || token === 'run' || token === '--json' || token === '--skip-git-repo-check' || token === '--dangerously-skip-permissions' || token === '--dangerously-bypass-approvals-and-sandbox') {
      continue;
    }
    if (valueFlags.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith('-')) {
      lastPositional = token;
    }
  }
  return lastPositional || args[args.length - 1] || '';
}

function appendCallLog(record) {
  const root = process.env.KITE_E2E_SANDBOX_ROOT;
  if (!root) return;
  const logPath = path.join(root, 'driver-calls.jsonl');
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Ignore non-fatal logging errors in driver probes.
  }
}

function loadScenario() {
  const filePath = process.env.KITE_E2E_SCENARIO_FILE;
  if (filePath && fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  if (process.env.KITE_E2E_SCENARIO) {
    return JSON.parse(process.env.KITE_E2E_SCENARIO);
  }
  return { rules: [] };
}

function matchRule(scenario, context) {
  const rules = Array.isArray(scenario.rules) ? scenario.rules : [];
  for (const rule of rules) {
    if (rule.driver && rule.driver.toLowerCase() !== context.driver) continue;
    if (typeof rule.isChild === 'boolean' && rule.isChild !== context.isChild) continue;
    if (rule.promptIncludes && !context.prompt.toLowerCase().includes(rule.promptIncludes.toLowerCase())) {
      continue;
    }
    if (rule.promptRegex && !new RegExp(rule.promptRegex, 'i').test(context.prompt)) {
      continue;
    }
    return rule;
  }
  return scenario.defaultRule || null;
}

function runCommand(cmdSpec) {
  return new Promise((resolve, reject) => {
    const bin = cmdSpec.bin || process.env.KITE_DISPATCH_BIN || (process.platform === 'win32' ? 'kite.exe' : 'kite');
    const args = Array.isArray(cmdSpec.args) ? cmdSpec.args : [];
    const child = spawn(bin, args, {
      cwd: cmdSpec.cwd || process.cwd(),
      env: { ...process.env, ...(cmdSpec.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (cmdSpec.allowError) {
        resolve({ code: 1, stdout, stderr: err.message });
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !cmdSpec.allowNonZero) {
        reject(new Error(`Command ${bin} ${args.join(' ')} exited with ${result.code}: ${stderr || stdout}`));
        return;
      }
      resolve(result);
    });
  });
}

function emitJsonLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitStepUpdate(step) {
  if (step.textDelta !== undefined) {
    emitJsonLine({
      event: 'step_update',
      step_update: {
        step_type: 'agent_response',
        state: step.state || 'RUNNING',
        step_index: step.stepIndex ?? 1,
        text_delta: step.textDelta,
      },
    });
    return;
  }
  if (step.thoughtDelta !== undefined) {
    emitJsonLine({
      event: 'step_update',
      step_update: {
        step_type: 'thought',
        state: step.state || 'RUNNING',
        step_index: step.stepIndex ?? 0,
        text: step.thoughtDelta,
      },
    });
    return;
  }
  if (step.acpTextDelta !== undefined) {
    emitJsonLine({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: step.acpTextDelta },
        },
      },
    });
    return;
  }
  if (step.toolCall) {
    emitJsonLine({
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        step_index: step.stepIndex ?? 1,
        tool_name: step.toolCall.name || 'shell',
        tool_call_id: step.toolCall.id || 'fake-tool-1',
        state: step.toolCall.state || 'RUNNING',
        parameters: step.toolCall.parameters || {},
        ...(step.toolCall.output ? { output: step.toolCall.output } : {}),
      },
    });
  }
}

function quoteShellArg(arg) {
  const s = String(arg);
  if (/^[^\s"']+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildToolCommandLine(cmdSpec) {
  const binName = cmdSpec.toolBinLabel || 'kite';
  const args = Array.isArray(cmdSpec.args) ? cmdSpec.args : [];
  return [binName, ...args.map(quoteShellArg)].join(' ');
}

let execToolCounter = 0;

async function executeAndTrackCommand(cmdSpec, kind, context, stepIndex) {
  const emitTool = Boolean(cmdSpec.emitTool);
  const toolCallId = emitTool ? `fake-exec-${++execToolCounter}` : null;
  const cmdLine = emitTool ? buildToolCommandLine(cmdSpec) : null;

  if (emitTool && toolCallId && cmdLine) {
    emitStepUpdate({
      stepIndex,
      toolCall: {
        id: toolCallId,
        name: cmdSpec.toolName || 'Bash',
        state: 'RUNNING',
        parameters: { command: cmdLine },
      },
    });
  }

  const res = await runCommand(cmdSpec).catch((err) => {
    appendCallLog({
      ts: Date.now(),
      driver: context.driver,
      kind,
      args: cmdSpec.args,
      code: 1,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  });

  if (emitTool && toolCallId && cmdLine) {
    emitStepUpdate({
      stepIndex,
      toolCall: {
        id: toolCallId,
        name: cmdSpec.toolName || 'Bash',
        state: res.code === 0 ? 'COMPLETED' : 'FAILED',
        parameters: { command: cmdLine },
        output: (res.stdout || res.stderr || '').trim(),
      },
    });
  }

  appendCallLog({
    ts: Date.now(),
    driver: context.driver,
    kind,
    args: cmdSpec.args,
    code: res.code,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  });
  return res;
}

async function runSteps(steps, context) {
  let exitCode = 0;
  let stepCursor = 1;
  for (const step of steps) {
    const currentStepIdx = step.stepIndex ?? stepCursor++;
    if (step.delayMs) {
      await sleep(step.delayMs);
    }
    if (step.stderr) {
      process.stderr.write(step.stderr);
    }
    if (step.rawLine !== undefined) {
      process.stdout.write(`${step.rawLine}\n`);
    }
    emitStepUpdate(step);

    if (step.exec) {
      await executeAndTrackCommand(step.exec, 'exec', context, currentStepIdx);
    }
    if (Array.isArray(step.execParallel)) {
      await Promise.all(
        step.execParallel.map((cmd, idx) =>
          executeAndTrackCommand(cmd, 'execParallel', context, currentStepIdx + idx),
        ),
      );
      stepCursor += step.execParallel.length;
    }
    if (step.result) {
      emitJsonLine({
        event: 'result',
        result: {
          status: step.result.status || 'SUCCESS',
          usage: {
            input_tokens: step.result.inputTokens ?? 12,
            output_tokens: step.result.outputTokens ?? 24,
          },
          duration_seconds: step.result.durationSeconds ?? 0.25,
        },
      });
    }
    if (typeof step.exitCode === 'number') {
      exitCode = step.exitCode;
      break;
    }
  }
  return exitCode;
}

async function runAcpStdio(driver, scenario) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      emitJsonLine({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
    } else if (msg.method === 'session/new') {
      emitJsonLine({
        jsonrpc: '2.0',
        id: msg.id,
        result: { sessionId: `fake-acp-${Date.now()}` },
      });
    } else if (msg.method === 'session/prompt') {
      const blocks = msg.params?.prompt || [];
      const prompt = Array.isArray(blocks)
        ? blocks.map((b) => b.text || '').join('\n')
        : String(blocks || '');
      const context = {
        driver,
        prompt,
        isChild: Boolean(process.env.KITE_ADDRESS && process.env.KITE_ADDRESS.startsWith('thread:')),
      };
      const rule = matchRule(scenario, context);
      const steps = rule?.steps || [
        { delayMs: 80, acpTextDelta: 'ACP chunk 1. ' },
        { delayMs: 120, acpTextDelta: 'ACP complete.' },
      ];
      await runSteps(steps, context);
      emitJsonLine({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' },
      });
    } else if (msg.id !== undefined) {
      emitJsonLine({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
  return 0;
}

async function main() {
  const { driver, args } = parseDriverArgs(process.argv.slice(2));

  appendCallLog({
    ts: Date.now(),
    driver,
    args,
    cwd: process.cwd(),
    kiteAddress: process.env.KITE_ADDRESS || null,
    kiteThreadId: process.env.KITE_THREAD_ID || null,
    kiteDispatch: process.env.KITE_DISPATCH || null,
  });

  if (args.includes('--version') || args.includes('-V') || args[0] === 'version') {
    process.stdout.write(`${DRIVER_VERSIONS[driver] || DRIVER_VERSIONS.claude}\n`);
    return 0;
  }

  if (args[0] === 'models') {
    process.stdout.write(`${FAKE_MODELS_OUTPUT}\n`);
    return 0;
  }

  const scenario = loadScenario();
  if ((args[0] === 'agent' && args[1] === 'stdio') || args.includes('--acp')) {
    return runAcpStdio(driver, scenario);
  }

  const prompt = extractPromptFromArgs(driver, args);
  const context = {
    driver,
    prompt,
    isChild: Boolean(process.env.KITE_ADDRESS && process.env.KITE_ADDRESS.startsWith('thread:')),
  };
  const rule = matchRule(scenario, context);
  const steps = rule?.steps || [
    { delayMs: 120, textDelta: `First chunk (${driver}): ` },
    { delayMs: 250, textDelta: `completed for "${prompt.slice(0, 60)}".` },
  ];

  return runSteps(steps, context);
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`${message}\n`);
    await fsp.appendFile(
      path.join(process.env.KITE_E2E_SANDBOX_ROOT || process.cwd(), 'driver-errors.log'),
      `${message}\n`,
    ).catch(() => {});
    process.exit(1);
  });
