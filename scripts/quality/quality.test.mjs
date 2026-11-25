import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesAnyGlob, normalizeRelPath } from './git-diff-files.mjs';
import {
  extractRegisteredHandlers,
  extractRustCommandsFromSource,
  extractFrontendInvocationsFromSource,
  verifyIpcWorkspace,
} from './verify-ipc.mjs';
import { lintFileContent, verifyDesignWorkspace } from './verify-design.mjs';
import { planGateExecution, buildVerifierHandoffMarkdown, computeGateVerdict } from './verify-gate.mjs';

const CONFIG_PATH = path.resolve(import.meta.dirname, 'gate.config.json');
const GATE_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function createTempRepo(fileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-quality-test-'));
  for (const [rel, content] of Object.entries(fileMap)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

test('matchesAnyGlob handles **, *, and {ext} brace alternations', () => {
  assert.equal(matchesAnyGlob('src/components/views/agents/Tab.tsx', ['src/components/views/**/*.tsx']), true);
  assert.equal(matchesAnyGlob('src/components/views/agents/Tab.css', ['src/**/*.{ts,tsx,css}']), true);
  assert.equal(matchesAnyGlob('src/motion/animate/demo.css', ['src/motion/animate/**']), true);
  assert.equal(matchesAnyGlob('src/components/views/chat/Chat.tsx', ['src/motion/animate/**']), false);
  assert.equal(normalizeRelPath('src\\components\\ui\\Button.tsx', process.cwd()), 'src/components/ui/Button.tsx');
});

test('verify-ipc extracts generate_handler![] entries including module paths and ignores comments', () => {
  const mainRs = `
    fn main() {
      builder
        .invoke_handler(tauri::generate_handler![
          bootstrap,
          // commented_out_cmd,
          agent_playbooks::run_agent_playbook,
          voice_audio::call_receipts::voice_call_receipt_save,
        ]);
    }
  `;
  const handlers = extractRegisteredHandlers(mainRs);
  assert.deepEqual([...handlers].sort(), [
    'bootstrap',
    'run_agent_playbook',
    'voice_call_receipt_save',
  ]);
});

test('verify-ipc extracts #[tauri::command] metadata including request wrapper and flat args', () => {
  const rustSrc = `
    #[tauri::command]
    pub async fn list_items(request: Option<serde_json::Value>) -> Value { Value::Null }

    #[tauri::command(rename_all = "snake_case")]
    pub fn rename_item(app: tauri::AppHandle, item_id: String) -> Result<(), String> { Ok(()) }

    #[tauri::command]
    pub fn zero_arg_ping() -> bool { true }
  `;
  const cmds = extractRustCommandsFromSource(rustSrc, 'src-tauri/src/sample.rs');
  assert.equal(cmds.length, 3);
  assert.equal(cmds[0].name, 'list_items');
  assert.equal(cmds[0].expectsRequestWrapper, true);
  assert.equal(cmds[0].hasNonInjectedParams, true);

  assert.equal(cmds[1].name, 'rename_item');
  assert.equal(cmds[1].expectsRequestWrapper, false);
  assert.equal(cmds[1].hasNonInjectedParams, true);

  assert.equal(cmds[2].name, 'zero_arg_ping');
  assert.equal(cmds[2].hasNonInjectedParams, false);
});

test('verify-ipc catches missing/unregistered commands and wrapper mismatches in fixture workspace', () => {
  const root = createTempRepo({
    'src-tauri/src/main.rs': `
      fn main() {
        builder.invoke_handler(tauri::generate_handler![
          list_items,
          flat_ping,
        ]);
      }
    `,
    'src-tauri/src/cmds.rs': `
      #[tauri::command]
      pub fn list_items(request: Value) -> Value { request }

      #[tauri::command]
      pub fn flat_ping(item_id: String) -> String { item_id }

      #[tauri::command]
      pub fn unregistered_secret() -> bool { true }
    `,
    'src/app.ts': `
      import { invoke } from '@tauri-apps/api/core';
      import { invokeCommand } from './lib/ipc';
      export async function run() {
        await invokeCommand('list_items', { id: 1 });
        await invoke('list_items', { id: 1 });
        await invokeCommand('flat_ping', { item_id: 'a' });
        await invoke('unregistered_secret');
        await invoke('does_not_exist');
        await invoke('plugin:event|listen', {});
      }
    `,
  });

  try {
    // With default gate.config.json (payloadCheckSeverity: 'error'), wrapper mismatches are hard errors.
    const strictResult = verifyIpcWorkspace(root, { ...GATE_CONFIG.ipc, legacyBaseline: [] });
    const strictCodes = strictResult.errors.map((e) => `${e.command}:${e.code}`).sort();
    assert.deepEqual(strictCodes, [
      'does_not_exist:command-not-found',
      'flat_ping:unexpected-request-wrapper',
      'list_items:missing-request-wrapper',
      'unregistered_secret:command-not-registered',
    ]);

    // With payloadCheckSeverity: 'warn', wrapper mismatches route to warnings while missing commands stay errors.
    const warnResult = verifyIpcWorkspace(root, {
      ...GATE_CONFIG.ipc,
      payloadCheckSeverity: 'warn',
      legacyBaseline: [],
    });
    assert.deepEqual(warnResult.errors.map((e) => e.command).sort(), ['does_not_exist', 'unregistered_secret']);
    const warningTypes = warnResult.warnings.map((w) => `${w.command}:${w.code}`).sort();
    assert.ok(warningTypes.includes('list_items:missing-request-wrapper'));
    assert.ok(warningTypes.includes('flat_ping:unexpected-request-wrapper'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-ipc ignores string literals inside comments and extracts multiline generic invoke calls', () => {
  const tsSrc = `
    // invoke('commented_command')
    /* invokeCommand('block_comment_command') */
    export async function go() {
      return await invoke<{
        entries: string[];
      }>(
        'list_agent_audit_log',
        { request: { agentId: 'a1' } }
      );
    }
  `;
  const calls = extractFrontendInvocationsFromSource(tsSrc, 'src/demo.ts', ['invoke', 'invokeCommand']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'list_agent_audit_log');
  assert.equal(calls[0].caller, 'invoke');
  assert.equal(calls[0].hasRequestKey, true);
});

test('verify-ipc handles Rust lifetimes before #[tauri::command] and hybrid Option<Value> request commands', () => {
  const rustSrc = `
    fn helper<'a>(input: &'a str) -> &'static str {
      let _ch = '\\n';
      let _raw = r#"not // a comment"#;
      let _ = input;
      "ok"
    }

    #[allow(non_snake_case)]
    #[tauri::command]
    pub async fn get_plugin_config(
      app: tauri::AppHandle,
      request: Option<Value>,
      plugin_id: Option<String>,
    ) -> Result<Value, String> { Ok(Value::Null) }

    #[tauri::command]
    pub fn start_agent_install(request: Option<Value>) -> Value { Value::Null }
  `;
  const cmds = extractRustCommandsFromSource(rustSrc, 'src-tauri/src/sample.rs');
  assert.deepEqual(cmds.map((c) => c.name), ['get_plugin_config', 'start_agent_install']);
  assert.equal(cmds[0].acceptsRequestWrapper, true);
  assert.equal(cmds[1].expectsRequestWrapper, true);
});

test('verify-ipc honors legacyBaseline ratchet and detects stale entries', () => {
  const root = createTempRepo({
    'src-tauri/src/main.rs': `fn main() { builder.invoke_handler(tauri::generate_handler![good_cmd]); }`,
    'src-tauri/src/cmds.rs': `#[tauri::command]\npub fn good_cmd() -> bool { true }`,
    'src/app.ts': `
      import { invoke } from '@tauri-apps/api/core';
      export async function run() {
        await invoke('good_cmd');
        await invoke('legacy_broken');
        await invoke('brand_new_broken');
      }
    `,
  });

  try {
    const cfg = {
      ...GATE_CONFIG.ipc,
      legacyBaseline: [
        { file: 'src/app.ts', command: 'legacy_broken', reason: 'known legacy' },
        { file: 'src/app.ts', command: 'good_cmd', reason: 'already fixed' },
      ],
    };
    const withBaseline = verifyIpcWorkspace(root, cfg);
    assert.deepEqual(withBaseline.errors.map((e) => e.command), ['brand_new_broken']);
    assert.deepEqual(withBaseline.baselinedErrors.map((e) => e.command), ['legacy_broken']);
    assert.deepEqual(withBaseline.staleBaselineEntries.map((e) => e.command), ['good_cmd']);

    const withoutBaseline = verifyIpcWorkspace(root, cfg, { ignoreBaseline: true });
    assert.deepEqual(withoutBaseline.errors.map((e) => e.command).sort(), ['brand_new_broken', 'legacy_broken']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-design catches arbitrary CSS radius, raw select, silent IPC catch, and honors escape hatches', () => {
  const badCss = `
    .card {
      border-radius: 7px;
      color: #ff00aa;
    }
    .nested::before {
      border-radius: calc(var(--control-radius) - 1px);
    }
    .allowed-one {
      border-radius: 10px; /* kite-design-ok: matches native macOS bezel */
    }
  `;
  const cssFindings = lintFileContent('src/components/views/demo/demo.css', badCss, GATE_CONFIG.design, { isAdded: false });
  assert.ok(cssFindings.some((f) => f.ruleId === 'no-arbitrary-css-radius' && f.line === 3));
  assert.ok(cssFindings.some((f) => f.ruleId === 'no-hardcoded-hex-colors' && f.line === 4));
  // Optical nesting calc(...) and escaped line must NOT trigger
  assert.equal(cssFindings.some((f) => f.line === 7), false);
  assert.equal(cssFindings.some((f) => f.line === 10), false);

  const badTsx = `
    import { invoke } from '@tauri-apps/api/core';
    export function BadView() {
      async function load() {
        try {
          await invoke('list_items', { request: {} });
        } catch {
          // ignored
        }
      }
      return (
        <div className="rounded-[7px]" style={{ borderRadius: 10, '--dynamic-col': '1fr' }}>
          <select aria-label="Pick"><option>A</option></select>
        </div>
      );
    }
  `;
  const tsxFindings = lintFileContent('src/components/views/demo/BadView.tsx', badTsx, GATE_CONFIG.design, { isAdded: false });
  assert.ok(tsxFindings.some((f) => f.ruleId === 'no-silent-ipc-catch'));
  assert.ok(tsxFindings.some((f) => f.ruleId === 'no-tailwind-arbitrary-radius'));
  assert.ok(tsxFindings.some((f) => f.ruleId === 'no-raw-html-select'));
  assert.ok(tsxFindings.some((f) => f.ruleId === 'no-static-inline-style'));
});

test('verify-design enforces monolith warning only on newly added files and skips excluded theme files', () => {
  const bigFile = Array.from({ length: 620 }, (_, i) => `export const x${i} = ${i};`).join('\n');
  const existingFindings = lintFileContent('src/components/views/demo/Big.ts', bigFile, GATE_CONFIG.design, { isAdded: false });
  const addedFindings = lintFileContent('src/components/views/demo/Big.ts', bigFile, GATE_CONFIG.design, { isAdded: true });
  assert.equal(existingFindings.some((f) => f.ruleId === 'max-new-file-lines'), false);
  assert.equal(addedFindings.some((f) => f.ruleId === 'max-new-file-lines'), true);

  const root = createTempRepo({
    'src/visual-language.css': '.x { border-radius: 7px; color: #112233; }\n',
    'src/components/views/clean/ok.css': '.x { border-radius: var(--control-radius); }\n',
  });
  try {
    const res = verifyDesignWorkspace(root, GATE_CONFIG.design, {
      files: ['src/visual-language.css', 'src/components/views/clean/ok.css'],
    });
    assert.equal(res.errors.length, 0);
    assert.equal(res.warnings.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-gate routes changed areas to Vitest, Cargo, E2E specs, and flags Rust rebuild + visual review', () => {
  const plan = planGateExecution(
    GATE_CONFIG,
    ['src/components/views/chat/ChatComposer.tsx', 'src-tauri/src/voice_realtime.rs'],
    { profile: 'standard' },
  );

  assert.equal(plan.needsRustRebuild, true);
  assert.equal(plan.needsVisualReview, true);
  assert.ok(plan.matchedAreas.includes('chat-and-thread'));
  assert.ok(plan.matchedAreas.includes('voice-and-argos'));
  assert.ok(plan.vitestPaths.includes('src/components/views/chat'));
  assert.ok(plan.cargoFilters.includes('voice_realtime'));
  assert.ok(plan.e2eSpecs.includes('thread-streaming'));
  assert.ok(plan.e2eSpecs.includes('voice-mode'));
});

test('verify-gate handoff markdown exposes INCOMPLETE verdict when E2E is skipped and lists screenshots', () => {
  const md = buildVerifierHandoffMarkdown({
    timestamp: '2026-11-25T10-00-00Z',
    profile: 'standard',
    verdict: 'INCOMPLETE',
    reason: 'Desktop CDP E2E skipped (--skip-e2e); cannot approve ODD closeout.',
    changedFiles: ['src/components/views/agents/AgentAuditTab.tsx'],
    matchedAreas: ['agents-and-routines'],
    needsVisualReview: true,
    stages: [
      { id: 'ipc', status: 'passed', durationMs: 120, summary: '0 errors' },
      { id: 'e2e', status: 'skipped', durationMs: 0, summary: 'Skipped via --skip-e2e' },
    ],
    screenshots: ['test-results/e2e/run-1/UI-LAYOUT-01/01-standard-closed-dock-1366x840.png'],
  });

  assert.ok(md.includes('INCOMPLETE'));
  assert.ok(md.includes('cannot approve ODD closeout'));
  assert.ok(md.includes('01-standard-closed-dock-1366x840.png'));
});

test('verify-ipc honors payloadCheckSeverity=error and JSX apostrophes do not blind comment stripping', () => {
  const root = createTempRepo({
    'src-tauri/src/main.rs': `fn main() { builder.invoke_handler(tauri::generate_handler![flat_cmd]); }`,
    'src-tauri/src/cmds.rs': `#[tauri::command]\npub fn flat_cmd(id: String) -> String { id }`,
    'src/View.tsx': `
      import { invokeCommand } from './lib/ipc';
      export function View() {
        // invoke('should_stay_ignored')
        const el = <p>It's working</p>;
        // invoke('still_ignored_after_apostrophe')
        void invokeCommand('flat_cmd', { id: 'x' });
        return el;
      }
    `,
  });

  try {
    const res = verifyIpcWorkspace(root, { ...GATE_CONFIG.ipc, payloadCheckSeverity: 'error', legacyBaseline: [] });
    assert.deepEqual(res.errors.map((e) => e.code), ['unexpected-request-wrapper']);
    assert.equal(res.warnings.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-ipc validates invokeFlatCommand symmetrically against flat and request-wrapped Rust commands', () => {
  const root = createTempRepo({
    'src-tauri/src/main.rs': `fn main() { builder.invoke_handler(tauri::generate_handler![flat_cmd, wrapped_cmd]); }`,
    'src-tauri/src/cmds.rs': `
      #[tauri::command]
      pub fn flat_cmd(id: String) -> String { id }
      #[tauri::command]
      pub fn wrapped_cmd(request: Value) -> Value { request }
    `,
    'src/App.ts': `
      import { invokeFlatCommand, invokeCommand } from './lib/ipc';
      export async function run() {
        await invokeFlatCommand('flat_cmd', { id: 'ok' });
        await invokeCommand('wrapped_cmd', { id: 'ok' });
        await invokeFlatCommand('wrapped_cmd', { id: 'bad' });
      }
    `,
  });

  try {
    const res = verifyIpcWorkspace(root, { ...GATE_CONFIG.ipc, payloadCheckSeverity: 'error', legacyBaseline: [] });
    assert.deepEqual(res.errors.map((e) => `${e.command}:${e.code}`), ['wrapped_cmd:missing-request-wrapper']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify-gate computeGateVerdict enforces exit codes for FAILED, INCOMPLETE, FAST_ONLY, and PASS', () => {
  assert.equal(computeGateVerdict({ anyFailed: true }).exitCode, 1);
  assert.equal(computeGateVerdict({ anyFailed: false, incompleteReason: 'E2E skipped', allowIncomplete: false }).exitCode, 2);
  assert.equal(computeGateVerdict({ anyFailed: false, incompleteReason: 'E2E skipped', allowIncomplete: true }).exitCode, 0);
  const fast = computeGateVerdict({ anyFailed: false, profile: 'fast', needsVisualReview: true });
  assert.equal(fast.verdict, 'FAST_ONLY');
  assert.equal(fast.exitCode, 0);
  const pass = computeGateVerdict({ anyFailed: false, profile: 'standard', needsVisualReview: false });
  assert.equal(pass.verdict, 'PASS');
  assert.equal(pass.exitCode, 0);
});
