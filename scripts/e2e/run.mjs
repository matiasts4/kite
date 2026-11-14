import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchIsolatedDesktop } from './launch-desktop.mjs';
import { captureArtifactScreenshot } from './assertions.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPECS_DIR = path.join(__dirname, 'specs');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const specFilters = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--spec' && argv[i + 1]) {
      specFilters.push(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--spec=')) {
      specFilters.push(arg.slice('--spec='.length));
    }
  }
  return { specFilters };
}

async function discoverSpecs(filters) {
  const entries = await fs.readdir(SPECS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.e2e.mjs'))
    .map((entry) => entry.name)
    .sort();

  const selected =
    filters.length === 0
      ? files
      : files.filter((file) =>
          filters.some((f) => file.includes(f) || file.replace(/\.e2e\.mjs$/, '') === f)
        );

  return selected.map((file) => path.join(SPECS_DIR, file));
}

async function runSingleSpec(specPath, runArtifactsRoot) {
  const specModule = await import(pathToFileURL(specPath).href);
  const specId = specModule.meta?.id || path.basename(specPath, '.e2e.mjs');
  const specArtifactsDir = path.join(runArtifactsRoot, specId);
  const startedAt = Date.now();

  let session = null;
  let failureShot = null;
  try {
    session = await launchIsolatedDesktop({
      artifactsDir: specArtifactsDir,
      ...(specModule.launchOptions || {}),
    });

    await specModule.run(session);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[PASS] ${specId} (${elapsedMs}ms) — artifacts: ${specArtifactsDir}`);
    return { specId, ok: true, elapsedMs, artifactsDir: specArtifactsDir };
  } catch (err) {
    if (session?.page) {
      failureShot = await captureArtifactScreenshot(
        session.page,
        specArtifactsDir,
        'FAILURE-state'
      ).catch(() => null);
    }
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[FAIL] ${specId} (${elapsedMs}ms): ${message}`);
    if (failureShot) {
      console.error(`  Failure screenshot: ${failureShot}`);
    }
    console.error(`  Logs & artifacts: ${specArtifactsDir}`);
    return { specId, ok: false, elapsedMs, message, artifactsDir: specArtifactsDir };
  } finally {
    if (session) {
      await session.close({ failed: false }).catch(() => {});
    }
  }
}

async function main() {
  const { specFilters } = parseArgs(process.argv.slice(2));
  const specPaths = await discoverSpecs(specFilters);
  if (specPaths.length === 0) {
    throw new Error(`No desktop E2E specs matched filters: ${JSON.stringify(specFilters)}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runArtifactsRoot = path.join(REPO_ROOT, 'test-results', 'e2e', timestamp);
  await fs.mkdir(runArtifactsRoot, { recursive: true });

  console.log(`Running ${specPaths.length} isolated desktop E2E spec(s)...`);
  const results = [];
  for (const specPath of specPaths) {
    results.push(await runSingleSpec(specPath, runArtifactsRoot));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nDesktop E2E summary: ${passed}/${results.length} passed, ${failed} failed.`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
