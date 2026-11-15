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
  let sabotageMode = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--spec' && argv[i + 1]) {
      specFilters.push(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--spec=')) {
      specFilters.push(arg.slice('--spec='.length));
    } else if (arg === '--sabotage') {
      sabotageMode = 'overlay';
    } else if (arg.startsWith('--sabotage=')) {
      sabotageMode = arg.slice('--sabotage='.length) || 'overlay';
    }
  }
  return { specFilters, sabotageMode };
}

async function applySabotageFault(page, mode) {
  if (mode === 'ipc-drop') {
    await page.evaluate(() => {
      const origFetch = window.fetch.bind(window);
      const parseIpcCmd = (rawUrl) => {
        try {
          const parsed = new URL(rawUrl, window.location.href);
          if (parsed.hostname === 'ipc.localhost' || parsed.protocol === 'ipc:') {
            return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
          }
        } catch {}
        return '';
      };
      const emptyTurnUpdates = (bodyText) => {
        let req = {};
        try {
          req = (typeof bodyText === 'string' ? JSON.parse(bodyText) : {})?.request || {};
        } catch {}
        return {
          schemaVersion: 1,
          runId: req.runId || '',
          nextSequence: req.afterSequence || 0,
          events: [],
        };
      };
      const okJsonResponse = (data) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'Tauri-Response': 'ok',
          },
        });

      window.fetch = async (input, init) => {
        const rawUrl =
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input || '');
        const cmd = parseIpcCmd(rawUrl);
        if (cmd === 'plugin:event|listen') {
          return okJsonResponse(0);
        }
        if (cmd === 'read_chat_turn_updates' || cmd === 'read_agent_chat_turn_updates') {
          return okJsonResponse(emptyTurnUpdates(init?.body));
        }
        return origFetch(input, init);
      };

      try {
        const ipc = window.ipc;
        if (ipc && typeof ipc.postMessage === 'function') {
          const origPostMessage = ipc.postMessage.bind(ipc);
          ipc.postMessage = (payload) => {
            try {
              const parsed = typeof payload === 'string' ? JSON.parse(payload) : null;
              if (parsed?.cmd === 'plugin:event|listen') {
                window.__TAURI_INTERNALS__?.runCallback?.(parsed.callback, 0);
                return;
              }
              if (
                parsed?.cmd === 'read_chat_turn_updates' ||
                parsed?.cmd === 'read_agent_chat_turn_updates'
              ) {
                window.__TAURI_INTERNALS__?.runCallback?.(
                  parsed.callback,
                  emptyTurnUpdates(JSON.stringify(parsed.payload || {})),
                );
                return;
              }
            } catch {}
            return origPostMessage(payload);
          };
        }
      } catch {}
    });
    return;
  }

  // Default `overlay`: inject a full-viewport hit-test interceptor mimicking z-index occlusion.
  await page.evaluate(() => {
    const blocker = document.createElement('div');
    blocker.id = 'kite-e2e-sabotage-blocker';
    blocker.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(220,38,38,0.12);pointer-events:auto;';
    document.body.appendChild(blocker);
  });
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

async function runSingleSpec(specPath, runArtifactsRoot, sabotageMode) {
  const specModule = await import(pathToFileURL(specPath).href);
  const specId = specModule.meta?.id || path.basename(specPath, '.e2e.mjs');
  const specArtifactsDir = path.join(runArtifactsRoot, specId);
  const startedAt = Date.now();

  let session = null;
  let failureShot = null;
  let failed = false;
  try {
    session = await launchIsolatedDesktop({
      artifactsDir: specArtifactsDir,
      ...(specModule.launchOptions || {}),
    });

    if (sabotageMode) {
      await applySabotageFault(session.page, sabotageMode);
    }

    await specModule.run(session);
    const elapsedMs = Date.now() - startedAt;

    if (sabotageMode) {
      failed = true;
      console.error(`[SABOTAGE MISS] ${specId} passed unexpectedly under --sabotage=${sabotageMode}`);
      return { specId, ok: false, elapsedMs, artifactsDir: specArtifactsDir };
    }

    console.log(`[PASS] ${specId} (${elapsedMs}ms) — artifacts: ${specArtifactsDir}`);
    return { specId, ok: true, elapsedMs, artifactsDir: specArtifactsDir };
  } catch (err) {
    failed = !sabotageMode;
    if (session?.page) {
      failureShot = await captureArtifactScreenshot(
        session.page,
        specArtifactsDir,
        'FAILURE-state'
      ).catch(() => null);
    }
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    if (sabotageMode) {
      if (!failureShot) {
        console.error(`[FAIL] ${specId} (${elapsedMs}ms): Sabotage caught failure without FAILURE-state screenshot.`);
        return { specId, ok: false, elapsedMs, message, artifactsDir: specArtifactsDir };
      }
      console.log(`[SABOTAGE CAUGHT] ${specId} (${elapsedMs}ms) under --sabotage=${sabotageMode}: ${message}`);
      console.log(`  Verified failure screenshot: ${failureShot}`);
      return { specId, ok: true, elapsedMs, artifactsDir: specArtifactsDir };
    }

    console.error(`[FAIL] ${specId} (${elapsedMs}ms): ${message}`);
    if (failureShot) {
      console.error(`  Failure screenshot: ${failureShot}`);
    }
    console.error(`  Logs & artifacts: ${specArtifactsDir}`);
    return { specId, ok: false, elapsedMs, message, artifactsDir: specArtifactsDir };
  } finally {
    if (session) {
      await session.close({ failed }).catch(() => {});
    }
  }
}

async function main() {
  const { specFilters, sabotageMode } = parseArgs(process.argv.slice(2));
  const specPaths = await discoverSpecs(specFilters);
  if (specPaths.length === 0) {
    throw new Error(`No desktop E2E specs matched filters: ${JSON.stringify(specFilters)}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runArtifactsRoot = path.join(REPO_ROOT, 'test-results', 'e2e', timestamp);
  await fs.mkdir(runArtifactsRoot, { recursive: true });

  console.log(
    sabotageMode
      ? `Running sabotage check (--sabotage=${sabotageMode}) across ${specPaths.length} desktop E2E spec(s)...`
      : `Running ${specPaths.length} isolated desktop E2E spec(s)...`,
  );
  const results = [];
  for (const specPath of specPaths) {
    results.push(await runSingleSpec(specPath, runArtifactsRoot, sabotageMode));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nDesktop E2E summary: ${passed}/${results.length} passed, ${failed} failed.`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
