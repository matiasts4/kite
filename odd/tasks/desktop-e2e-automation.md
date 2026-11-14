# Desktop E2E Automation — Thread, Agents & Orchestration

Objective: Automate real desktop end-to-end verification in Kite Code (Tauri + WebView2 + Rust backend + core daemon) over CDP with Playwright, covering Thread live streaming, Agent runs, parallel Subagent/Swarm orchestration, and geometric/visual checks without mocks hiding regressions.
Branch: `feat/response-thread`
Delivery strategy: ask-on-risk
Allowed edit surfaces: `odd/tasks/desktop-e2e-automation.md`, `package.json`, `.gitignore`, `vite.config.ts`, `scripts/e2e/**`, `test-results/**` (gitignored artifacts), `.agents/skills/kite-desktop-qa/**`, `.kite/tasks/run-tests.md`, `docs/qa/**`, `server/server.mjs` / `scripts/qa/**` (only if Phase 3 `dev:browser` alignment touches them; verify before editing). Never alter unrelated dirty workspace files or protected `TitleBar.tsx` switcher geometry.
Test runner: `npm run verify:desktop:e2e`, `npx tsc --noEmit`, `npx vitest run`, `node .kite/sanitizer/audit-references.mjs --check`

## Specs

### S1 — Isolated Desktop CDP Sandbox Launcher
- A Node launcher under `scripts/e2e/` spawns an isolated Kite Code desktop instance using temporary `APPDATA`, `LOCALAPPDATA`, and `USERPROFILE` directories plus a unique `KITE_CORE_PIPE` named pipe so tests never touch or lock the user's installed app data, SQLite databases, WebView2 `EBWebView` folder, or live core daemon.
- The launcher enables WebView2 remote debugging via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (`--remote-debugging-port=<free-port>`), manages the Vite dev server on `127.0.0.1:1420` when launching the debug binary (`kite-code.exe`), waits for the CDP `/json/version` endpoint, and connects `playwright-core` via `chromium.connectOverCDP(...)`.
- On completion or failure, cleanup terminates any Vite/desktop/daemon child processes started by the harness (Windows process tree cleanup) and removes temporary sandbox state while preserving failure logs and screenshots under `test-results/e2e/`.
- Smoke check (`desktop-smoke.e2e.mjs`): verifies the real Tauri desktop shell mounted cleanly (`window.__TAURI_INTERNALS__` present, `__is_web_ipc_shim__` absent), switches to `Thread` mode, verifies the Thread home composer is visible and interactive without overlap, and submits/opens a Thread cleanly with zero uncaught `pageerror`s.

### S2 — Deterministic Fake CLI Driver with Real Orchestration Dispatch
- A deterministic cross-platform / Windows-callable fake driver under `scripts/e2e/fake-driver/` supplies executable shims for configured agent CLIs (such as `agy`, `claude`, `grok`, prepended onto the launcher `PATH` without overwriting system user binaries).
- The fake driver passes Kite's startup version probes (`--version`) matching existing driver fixtures, emits realistic `stream-json` and ACP JSON-RPC stdio sequences driven by test scenario scripts/env directives, and does not short-circuit Rust's runtime or event log.
- When spawned by Kite's runtime with `KITE_DISPATCH=1`, `KITE_ADDRESS`, `KITE_THREAD_ID`, and the injected `kite` companion shim on `PATH`, fake driver scenarios execute real `kite dispatch run --via thread`, `kite dispatch wait`, and `kite dispatch swarm` commands against the live desktop core daemon/orchestrator.

### S3 — Live Streaming, Orchestration & Failure E2E Suite + Sabotage Gate
- `THREAD-STREAM-01`: Sending a prompt in Thread executes a real Rust turn + fake CLI stream and updates the UI live chunk-by-chunk as deltas arrive, reaching completion state without reloading or manual polling hacks.
- `THREAD-SWITCH-01`: Switching away from an active streaming Thread to another Thread or workspace view and switching back preserves streaming state, accumulated output, and final completion accurately.
- `ORCH-SUB-01`: A parent Thread turn launches 2+ parallel child subagents via `kite dispatch run --via thread`; the Subagents dock/inspector and parent Thread update live as children transition `running` -> `completed` and converge results cleanly.
- `ORCH-SWARM-01`: A Swarm orchestration dispatched via `kite dispatch swarm` spawns worker panes/cards, streams real child activity, and converges to completion in UI state.
- `ORCH-FAIL-01`: When a child subagent exits non-zero or stops streaming, the failure/timeout state surfaces visibly in the UI (status badge and failure details) rather than hanging silently as `running`.
- Sabotage gate: An automated verification mode injects a temporary controlled breakage (e.g., broken event subscription or overlapping invisible overlay blocking a primary control) and confirms the E2E suite fails decisively with a diagnostic screenshot/message, proving against false positives before restoring green state.

### S4 — Geometric Layout Assertions & Visual Evidence Capture
- All E2E interactions use genuine Playwright pointer actions (`.click()`, `.fill()`, `.press()`); `{ force: true }` is strictly disallowed so occluded, detached, zero-sized, or overlapped controls always fail the test.
- Layout invariants verify via `boundingBox()` and computed styles that interactive Thread/Agent/Subagent controls have non-zero clickable area, do not overflow the viewport horizontally, do not collide/overlap sibling interactive controls, and remain visible in compact and standard window widths.
- Full-page / region PNG screenshots are automatically captured under `test-results/e2e/` on every failure and at key visual milestones (Thread home, active stream, Subagent dock expanded, Swarm active) for review and regression checks.

### S5 — Project QA Skill, Documentation & Legacy Lane Alignment
- Add project skill `.agents/skills/kite-desktop-qa/SKILL.md` documenting how agents run isolated CDP desktop E2E tests, write fake-driver scenarios, assert layout/real-time invariants, inspect captured screenshots, and run the sabotage gate.
- Update `.kite/tasks/run-tests.md` and `docs/qa/catalog.md` with the new real desktop E2E command (`npm run verify:desktop:e2e`), scenario IDs, and honest separation between unit JSDOM tests, static browser preview (`dev:browser`), and full desktop E2E verification.
- Reconcile/mark legacy `dev:browser` (`server/server.mjs` mock) clearly in scripts/docs (and clean up stale expectations) so it is never mistaken for real streaming or orchestration verification.

## Tasks

| ID | Task | Specs | Route | Commit |
| :--- | :--- | :--- | :--- | :--- |
| T1 | Create isolated CDP desktop launcher (`scripts/e2e/sandbox.mjs`, `scripts/e2e/launch-desktop.mjs`, `scripts/e2e/run.mjs`), Phase 1 `desktop-smoke.e2e.mjs`, and `verify:desktop:e2e` script; verify end-to-end against real `kite-code.exe` | S1 | inline (Phase 1 setup & integration) | verified (commit pending) |
| T2 | Build deterministic Fake CLI Driver (`scripts/e2e/fake-driver/`) speaking `--version`, `stream-json`, ACP JSON-RPC stdio, and scenario-driven `kite dispatch` invocations | S2 | inline (after reading fixtures & driver parsers) | pending |
| T3 | Implement Thread streaming & switching E2E specs (`THREAD-STREAM-01`, `THREAD-SWITCH-01`) and verify against real backend + fake driver | S2, S3 | inline | pending |
| T4 | Implement Orchestration E2E specs (`ORCH-SUB-01`, `ORCH-SWARM-01`, `ORCH-FAIL-01`) and automated Sabotage verification mode | S2, S3 | inline | pending |
| T5 | Implement geometric layout assertion helpers, viewport resize/no-force checks, and automatic screenshot capture (`UI-LAYOUT-01`) under `test-results/e2e/` (gitignored) | S4 | inline | pending |
| T6 | Author `.agents/skills/kite-desktop-qa/SKILL.md`, update `.kite/tasks/run-tests.md` and `docs/qa/catalog.md`, align `dev:browser` status, and run full verification suite | S5 | inline | pending |

## Verification
- After Phase 1 (`T1`): `npm run verify:desktop:e2e`, `npx tsc --noEmit`, `npx vitest run`, `node .kite/sanitizer/audit-references.mjs --check`.
- After Phase 2 (`T2`–`T4`): `npm run verify:desktop:e2e` (all Thread + Orchestration specs green) + Sabotage check failing on injected regression and passing when reverted + `npx tsc --noEmit`, `npx vitest run`, `node .kite/sanitizer/audit-references.mjs --check`.
- After Phase 3 (`T5`–`T6`): Full `npm run verify:desktop:e2e` with layout + screenshots, `npx tsc --noEmit`, `npx vitest run`, `node .kite/sanitizer/audit-references.mjs --check`.

## Log
- **L1 (User request — verbatim):**
  1. `"quiero saber que metodologis o cosas podemos hacer para automatizar el proceso de testeo completamente, con esot me refi a que el cuello de botella actual soy yo al tener qeu testear todo o verificar que algunas cosas no se actualizan ni se ven bien, la idea seria poder meojrar esto pudiendo testear en la aplciacion realmente por ej usando ego browser o tal vez otra alternativa  pero la idea seria testear automatizada la parte de thread, agents o cosas puntuales, con el fin de asegurar por ejemplo que la parte de orquestacion funciona correctametne, o otras cosas que intentemos, quiero investigar sobre esto, ya sea skills u otras cosas"`
  2. `"si me parece correcto, tenemos que aterrizar completamente este plan"`
  3. `"si, crea el odd y comienza"`
- **L2 (Phase 1 observed findings & resolution):**
  - Evergreen WebView2 `157.0.4341.46` ignores `--remote-debugging-port` TCP binding under `--embedded-browser-webview=1`; `scripts/e2e/sandbox.mjs` automatically provisions/pins Fixed Version WebView2 `149.0.4022.98` in user cache (`~/.cache/kite-code-e2e/webview2/`) via `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` unless overridden (`KITE_E2E_WEBVIEW2_DIR` / `KITE_E2E_USE_SYSTEM_WEBVIEW2=1`).
  - `vite.config.ts` now scopes `optimizeDeps.entries` to `['index.html']` and ignores Rust/artifact directories under `server.watch.ignored`, reducing dev server cold response from ~77s (`/` 8.2s + `/src/main.tsx` 69.5s) to <1.7s (`/` 28ms + `/src/main.tsx` 1.6s).
  - Phase 1 gate passed: `DESKTOP-SMOKE-01` (30.2s, real Tauri IPC + WebView2 CDP + screenshots under `test-results/e2e/` + clean process/temp teardown), `npx tsc --noEmit`, `npx vitest run` (182 files / 1275 tests), and `node .kite/sanitizer/audit-references.mjs --check`.
