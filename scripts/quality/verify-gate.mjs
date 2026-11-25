import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchesAnyGlob, normalizeRelPath, resolveTargetFiles, walkFiles } from './git-diff-files.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'gate.config.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Pure planner mapping changed files + profile into concrete verification commands.
 */
export function planGateExecution(config, changedFiles, options = {}) {
  const profileName = options.profile || 'standard';
  const profile = config.gate.profiles[profileName];
  if (!profile) {
    throw new Error(
      `Unknown gate profile '${profileName}'. Expected one of: ${Object.keys(config.gate.profiles).join(', ')}`,
    );
  }

  const normalizedFiles = changedFiles.map((f) => f.replace(/\\/g, '/'));
  const matchedAreas = [];
  const vitestPaths = new Set();
  const cargoFilters = new Set();
  const e2eSpecs = new Set();
  let needsVisualReview = false;

  for (const area of config.gate.areaMapping || []) {
    if (normalizedFiles.some((f) => matchesAnyGlob(f, area.patterns || []))) {
      matchedAreas.push(area.id);
      for (const vp of area.vitestPaths || []) vitestPaths.add(vp);
      for (const cf of area.cargoFilters || []) cargoFilters.add(cf);
      for (const spec of area.e2eSpecs || []) e2eSpecs.add(spec);
      if (area.visualReview) needsVisualReview = true;
    }
  }

  const hasSrcChanges = normalizedFiles.some((f) => f.startsWith('src/'));
  const hasRustChanges = normalizedFiles.some((f) => f.startsWith('src-tauri/'));
  const hasUiFileChanges = normalizedFiles.some(
    (f) => f.startsWith('src/') && (f.endsWith('.tsx') || f.endsWith('.css')),
  );

  if (hasUiFileChanges) {
    needsVisualReview = true;
    if (e2eSpecs.size === 0) {
      e2eSpecs.add('desktop-smoke');
      e2eSpecs.add('ui-layout');
    }
  }

  return {
    profile: profileName,
    stages: [...profile.stages],
    changedFiles: normalizedFiles,
    matchedAreas,
    vitestPaths: [...vitestPaths],
    cargoFilters: [...cargoFilters],
    e2eSpecs: [...e2eSpecs],
    needsRustRebuild: hasRustChanges,
    needsVisualReview,
    hasSrcChanges,
    hasRustChanges,
  };
}

/**
 * Build the markdown handoff consumed by the independent QA & Visual Verifier agent.
 */
export function buildVerifierHandoffMarkdown(report) {
  const lines = [
    `# Quality Gate & Verifier Handoff`,
    '',
    `- **Timestamp**: \`${report.timestamp}\``,
    `- **Profile**: \`${report.profile}\``,
    `- **Verdict**: **${report.verdict}**${report.reason ? ` — ${report.reason}` : ''}`,
    `- **Matched Areas**: ${report.matchedAreas.length > 0 ? report.matchedAreas.map((a) => `\`${a}\``).join(', ') : '_none_'}`,
    `- **Visual Review Required**: ${report.needsVisualReview ? '**YES** (independent verifier must visually inspect every PNG below)' : 'No'}`,
    '',
    '## Stage Results',
    '',
    '| Stage | Status | Duration | Summary |',
    '| :--- | :--- | ---: | :--- |',
  ];

  for (const s of report.stages) {
    lines.push(`| \`${s.id}\` | \`${s.status}\` | ${s.durationMs}ms | ${s.summary || ''} |`);
  }

  lines.push('', '## Captured Desktop E2E Screenshots (Inspect Visually)');
  if (report.screenshots && report.screenshots.length > 0) {
    for (const png of report.screenshots) {
      lines.push(`- \`${png}\``);
    }
  } else {
    lines.push('- _No screenshots captured in this run._');
  }

  lines.push('', `## Changed Files (${report.changedFiles.length})`);
  for (const f of report.changedFiles.slice(0, 80)) {
    lines.push(`- \`${f}\``);
  }
  if (report.changedFiles.length > 80) {
    lines.push(`- _...and ${report.changedFiles.length - 80} more file(s)._`);
  }

  lines.push(
    '',
    '## Independent Verifier Contract',
    '',
    '1. Load `.agents/skills/kite-delivery-loop/SKILL.md` and `references/verifier-checklist.md`.',
    '2. Reject automatically if Verdict is `FAILED` or `INCOMPLETE` for a UI/runtime slice.',
    '3. Read every PNG listed above visually (never approve on exit codes alone) and check `process-logs.txt`.',
    '4. Return either `APPROVE` or `REJECT` with exact `file:line` / screenshot defect pointers.',
    '',
  );

  return lines.join('\n');
}

function runShellStage(command, cwd) {
  const startedAt = Date.now();
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const durationMs = Date.now() - startedAt;
  const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const tail = output
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-12)
    .join('\n');
  return {
    ok: res.status === 0,
    exitCode: res.status ?? 1,
    durationMs,
    output,
    tail,
  };
}

function collectRecentE2eScreenshots(repoRoot, e2eArtifactsRel, startedAfterMs) {
  const e2eRoot = path.join(repoRoot, e2eArtifactsRel);
  if (!fs.existsSync(e2eRoot)) return [];
  const allPngs = walkFiles(e2eRoot, repoRoot, { extensions: ['.png'], ignoreDirs: new Set() });
  return allPngs.filter((rel) => {
    try {
      const stat = fs.statSync(path.join(repoRoot, rel));
      return stat.mtimeMs >= startedAfterMs - 2000;
    } catch {
      return false;
    }
  });
}

function parseCliArgs(argv) {
  let configPath = DEFAULT_CONFIG_PATH;
  let profile = 'standard';
  let baseRef = null;
  let staged = false;
  let all = false;
  let dryRun = false;
  let skipE2e = false;
  let allowIncomplete = false;
  let continueOnError = false;
  let rebuildRust = false;
  let json = false;
  const files = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' && argv[i + 1]) {
      profile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
    } else if (arg === '--base' && argv[i + 1]) {
      baseRef = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--base=')) {
      baseRef = arg.slice('--base='.length);
    } else if (arg === '--config' && argv[i + 1]) {
      configPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--staged') staged = true;
    else if (arg === '--all') all = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--skip-e2e') skipE2e = true;
    else if (arg === '--allow-incomplete') allowIncomplete = true;
    else if (arg === '--continue-on-error') continueOnError = true;
    else if (arg === '--rebuild-rust') rebuildRust = true;
    else if (arg === '--json') json = true;
    else if (arg === '--files' && argv[i + 1]) {
      files.push(...argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }

  return {
    configPath,
    profile,
    baseRef,
    staged,
    all,
    files,
    dryRun,
    skipE2e,
    allowIncomplete,
    continueOnError,
    rebuildRust,
    json,
  };
}

/**
 * Compute final gate verdict and process exit code deterministically.
 */
export function computeGateVerdict({
  anyFailed,
  incompleteReason = null,
  profile = 'standard',
  needsVisualReview = false,
  allowIncomplete = false,
}) {
  if (anyFailed) {
    return {
      verdict: 'FAILED',
      reason: 'One or more required verification stages failed.',
      exitCode: 1,
    };
  }
  if (incompleteReason) {
    return {
      verdict: 'INCOMPLETE',
      reason: incompleteReason,
      exitCode: allowIncomplete ? 0 : 2,
    };
  }
  if (profile === 'fast' && needsVisualReview) {
    return {
      verdict: 'FAST_ONLY',
      reason: 'Fast inner-loop profile passed; run standard verify:gate with Desktop CDP E2E before closeout.',
      exitCode: 0,
    };
  }
  return {
    verdict: 'PASS',
    reason: '',
    exitCode: 0,
  };
}

function buildDesignCommand(opts) {
  const parts = ['node', 'scripts/quality/verify-design.mjs'];
  if (opts.files.length > 0) parts.push('--files', opts.files.join(','));
  else if (opts.all) parts.push('--all');
  else if (opts.staged) parts.push('--staged');
  else if (opts.baseRef) parts.push('--base', opts.baseRef);
  return parts.join(' ');
}

function runCli() {
  const opts = parseCliArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(opts.configPath, 'utf8'));
  const target = resolveTargetFiles(REPO_ROOT, {
    files: opts.files,
    all: opts.all,
    staged: opts.staged,
    baseRef: opts.baseRef,
    scanDirs: ['src', 'src-tauri/src', 'scripts'],
  });

  const plan = planGateExecution(config, target.files, { profile: opts.profile });
  const stageCommands = [];

  for (const stageId of plan.stages) {
    if (stageId === 'ipc') {
      stageCommands.push({ id: 'ipc', command: 'node scripts/quality/verify-ipc.mjs' });
    } else if (stageId === 'design') {
      stageCommands.push({ id: 'design', command: buildDesignCommand(opts) });
    } else if (stageId === 'sanitizer') {
      const sanitizerPath = path.join(REPO_ROOT, '.kite', 'sanitizer', 'audit-references.mjs');
      stageCommands.push({
        id: 'sanitizer',
        command: fs.existsSync(sanitizerPath) ? config.gate.sanitizerCommand : null,
        skipReason: fs.existsSync(sanitizerPath) ? null : 'Local .kite/sanitizer not present in this environment',
      });
    } else if (stageId === 'quality-tests') {
      stageCommands.push({ id: 'quality-tests', command: 'node --test scripts/quality/quality.test.mjs' });
    } else if (stageId === 'tsc') {
      stageCommands.push({ id: 'tsc', command: 'npx tsc --noEmit' });
    } else if (stageId === 'vitest') {
      if (plan.vitestPaths.length > 0) {
        const existing = plan.vitestPaths.filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
        stageCommands.push({
          id: 'vitest',
          command: existing.length > 0 ? `npx vitest run ${existing.join(' ')}` : null,
          skipReason: existing.length > 0 ? null : 'No affected Vitest paths matched',
        });
      } else {
        stageCommands.push({
          id: 'vitest',
          command: null,
          notApplicableReason: 'No frontend source paths affected in this slice',
        });
      }
    } else if (stageId === 'vitest-all') {
      stageCommands.push({ id: 'vitest-all', command: 'npx vitest run' });
    } else if (stageId === 'cargo') {
      if (!plan.hasRustChanges) {
        stageCommands.push({
          id: 'cargo',
          command: null,
          notApplicableReason: 'No src-tauri/ Rust files changed',
        });
      } else if (plan.cargoFilters.length > 0) {
        for (const filter of plan.cargoFilters) {
          stageCommands.push({
            id: `cargo:${filter}`,
            command: `cargo test --manifest-path src-tauri/Cargo.toml ${filter}`,
          });
        }
      } else {
        stageCommands.push({
          id: 'cargo',
          command: 'cargo test --manifest-path src-tauri/Cargo.toml --lib',
        });
      }
    } else if (stageId === 'cargo-all') {
      stageCommands.push({
        id: 'cargo-all',
        command: 'cargo test --manifest-path src-tauri/Cargo.toml --workspace',
      });
    } else if (stageId === 'e2e' || stageId === 'e2e-all') {
      const specs = stageId === 'e2e-all' ? [] : plan.e2eSpecs;
      const shouldRunE2e = stageId === 'e2e-all' || specs.length > 0;
      if (!shouldRunE2e) {
        stageCommands.push({
          id: stageId,
          command: null,
          notApplicableReason: 'No desktop UI/runtime areas matched for CDP E2E',
        });
      } else if (opts.skipE2e) {
        stageCommands.push({
          id: stageId,
          command: null,
          skippedByFlag: true,
          skipReason: 'Skipped via --skip-e2e (marks gate INCOMPLETE; cannot close ODD)',
        });
      } else {
        if (plan.needsRustRebuild && opts.rebuildRust) {
          stageCommands.push({ id: 'rust-debug-build', command: config.gate.rustRebuildCommand });
        }
        const specFlags = specs.map((s) => `--spec ${s}`).join(' ');
        stageCommands.push({
          id: stageId,
          command: specFlags
            ? `node scripts/e2e/run.mjs ${specFlags}`
            : 'node scripts/e2e/run.mjs',
        });
      }
    }
  }

  if (opts.dryRun) {
    const drySummary = {
      scope: target.scopeLabel,
      profile: plan.profile,
      changedFilesCount: plan.changedFiles.length,
      matchedAreas: plan.matchedAreas,
      needsRustRebuild: plan.needsRustRebuild,
      needsVisualReview: plan.needsVisualReview,
      stages: stageCommands,
    };
    if (opts.json) {
      console.log(JSON.stringify(drySummary, null, 2));
    } else {
      console.log(`[verify:gate --dry-run] Profile: ${plan.profile} | Scope: ${target.scopeLabel} (${plan.changedFiles.length} file(s))`);
      console.log(`  Matched areas: ${plan.matchedAreas.join(', ') || '(none)'}`);
      console.log(`  Rust rebuild needed before CDP: ${plan.needsRustRebuild ? 'YES' : 'no'}`);
      console.log(`  Visual review required: ${plan.needsVisualReview ? 'YES' : 'no'}`);
      console.log('  Planned stages:');
      for (const s of stageCommands) {
        console.log(`    - [${s.id}] ${s.command || `(${s.notApplicableReason || s.skipReason})`}`);
      }
    }
    process.exit(0);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactsDir = path.join(REPO_ROOT, config.gate.artifactsRoot, timestamp);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const stageResults = [];
  let anyFailed = false;
  let incompleteReason = null;
  let e2eStartedAt = null;

  console.log(`[verify:gate] Profile: ${plan.profile} | Scope: ${target.scopeLabel} (${plan.changedFiles.length} file(s))`);

  for (const stage of stageCommands) {
    if (!stage.command) {
      const status = stage.skippedByFlag ? 'skipped' : 'not-applicable';
      const reason = stage.skipReason || stage.notApplicableReason || 'Not applicable';
      if (stage.skippedByFlag) {
        incompleteReason = reason;
      }
      console.log(`  [${status.toUpperCase()}] ${stage.id}: ${reason}`);
      stageResults.push({
        id: stage.id,
        status,
        durationMs: 0,
        exitCode: 0,
        summary: reason,
      });
      continue;
    }

    if (anyFailed && !opts.continueOnError) {
      stageResults.push({
        id: stage.id,
        status: 'skipped',
        durationMs: 0,
        exitCode: 0,
        summary: 'Skipped after prior stage failure (use --continue-on-error to collect all)',
      });
      continue;
    }

    console.log(`  [RUN] ${stage.id} -> ${stage.command}`);
    if (stage.id === 'e2e' || stage.id === 'e2e-all') {
      e2eStartedAt = Date.now();
    }
    const res = runShellStage(stage.command, REPO_ROOT);
    const firstSummaryLine =
      res.tail
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .pop() || (res.ok ? 'Passed' : `Exit code ${res.exitCode}`);

    stageResults.push({
      id: stage.id,
      command: stage.command,
      status: res.ok ? 'passed' : 'failed',
      durationMs: res.durationMs,
      exitCode: res.exitCode,
      summary: firstSummaryLine.slice(0, 220),
    });

    if (res.ok) {
      console.log(`  [PASS] ${stage.id} (${res.durationMs}ms)`);
    } else {
      anyFailed = true;
      console.error(`  [FAIL] ${stage.id} (${res.durationMs}ms, exit ${res.exitCode})`);
      if (res.tail) {
        console.error(res.tail.split(/\r?\n/).map((l) => `    | ${l}`).join('\n'));
      }
    }
  }

  const screenshots = e2eStartedAt
    ? collectRecentE2eScreenshots(REPO_ROOT, config.gate.e2eArtifactsRoot, e2eStartedAt)
    : [];

  const { verdict, reason, exitCode } = computeGateVerdict({
    anyFailed,
    incompleteReason,
    profile: plan.profile,
    needsVisualReview: plan.needsVisualReview,
    allowIncomplete: opts.allowIncomplete,
  });

  const report = {
    timestamp,
    scope: target.scopeLabel,
    profile: plan.profile,
    verdict,
    reason,
    matchedAreas: plan.matchedAreas,
    needsRustRebuild: plan.needsRustRebuild,
    needsVisualReview: plan.needsVisualReview,
    changedFiles: plan.changedFiles,
    stages: stageResults,
    screenshots,
  };

  const reportJsonPath = path.join(artifactsDir, 'report.json');
  const handoffMdPath = path.join(artifactsDir, 'verifier-handoff.md');
  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(handoffMdPath, buildVerifierHandoffMarkdown(report), 'utf8');

  if (opts.json) {
    console.log(JSON.stringify({ ...report, reportJsonPath: normalizeRelPath(reportJsonPath, REPO_ROOT), handoffMdPath: normalizeRelPath(handoffMdPath, REPO_ROOT) }, null, 2));
  } else {
    console.log(`\n[verify:gate] VERDICT: ${verdict}${reason ? ` — ${reason}` : ''}`);
    console.log(`  Report JSON:      ${normalizeRelPath(reportJsonPath, REPO_ROOT)}`);
    console.log(`  Verifier Handoff: ${normalizeRelPath(handoffMdPath, REPO_ROOT)}`);
  }

  process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli();
}
