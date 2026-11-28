# Agentic Embedded Browser & Context-Reuse Verification Engine

Objective: transform Kite Code's embedded RightDock browser into a fast, zero-setup agentic testing and verification surface driven by native in-process WebView2 CDP, compact batched MCP/CLI tools, a dedicated browser subagent role, multi-tab takeover UX, and a 5-layer `kite-ctx` v3 context-optimization and deterministic replay layer.
Branch: `feat/remote-control`. Delivery strategy: `ask-on-risk` (pre-existing uncommitted work on `feat/remote-control` preserved in working tree; feature changes verified cleanly before slicing commits). Test runner: `cargo test --manifest-path src-tauri/Cargo.toml -p kite-ctx`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npx tsc --noEmit`, `npx vitest run`, `node .kite/sanitizer/audit-references.mjs --check`, and `npm run verify:gate -- --rebuild-rust`.
Does not change protected zones (`src/components/TitleBar.tsx` mode switcher).

## Specs

- **S1 — `kite-ctx` v3 Semantic AX Snapshot Cache, Origin Chrome Stripping & Browser Compression**:
  - Verbatim:
    > "Añadiendo a esto, también claro quiero optimizar lo que hacen ellos, quiero decir. Testear utilizando el browser es algo, a mi parecer, o antes era algo costoso. Supongo que ahora ya no lo es tanto porque no se equivocan tanto los agentes. Por ende me gustaría llegar a mejorar también este sistema. Tal vez a implementar algo con nuestra reutilización de contexto. El. kitectx Diría que tal vez podríamos implementar algo relacionado con eso, ¿y a qué me refiero? Bueno. Se hacen llamadas que también se reutilizan o con texto que se reutiliza, por ejemplo. Al analizar una página eh, y realmente hacer las acciones. Ahí hay cosas y lecturas reutilizadas. O reutilizables."
  - Behavior:
    1. Migrate `kite-ctx` SQLite schema (`store.rs`) cleanly from v2 to v3 (`CURRENT_SCHEMA_VERSION = 3`) adding `browser_snapshots`, `browser_chrome`, and `browser_recipes` tables without losing existing v2 data.
    2. Implement `kite_ctx::browser_cache::BrowserReadCache` normalizing accessibility snapshots into canonical `AxNode` records keyed by `stable_key = short_hash(frame_id | landmark | role | normalized_name | sibling_ordinal)` (ignoring volatile `@eN` handles and generated framework IDs such as `:r1a:` / `mui-*`).
    3. Compute `full_hash` and `structure_hash`: identical re-snapshots return a compact ~18–25 token stub; mutated same-route snapshots emit an incremental semantic delta (`+`, `~`, `-`) with automatic break-even fallback to full when `changed > 45%` or `delta_tokens >= raw_tokens`, spilling the full payload to `CcrStore` (`<<ccr:HASH>>`).
    4. Implement per-origin landmark chrome factoring (`browser_chrome` table) so repeated `banner`, `navigation`, `contentinfo`, and static `complementary` subtrees across same-origin routes emit once as `[chrome:HASH]` and collapse to a 1-line stub or targeted badge delta on subsequent routes.
    5. Extend `pipeline.rs` (`ContentKind::{AxTree, Dom, NetworkWaterfall}`) and `lossless.rs` (`elide_svg_and_style_noise`), route JSON network/console arrays through `SmartCrusher` + `CcrStore` FTS5, and redact sensitive values (`password`, `cc-*`, `Authorization`, cookies, JWTs) to `[REDACTED]` before persisting.
  - Checks: `cargo test --manifest-path src-tauri/Cargo.toml -p kite-ctx` covering v2->v3 migration, unchanged stub, semantic AX delta, break-even fallback, origin chrome stripping, SVG/style stripping, network crushing, and redaction.

- **S2 — Deterministic Action/Flow Replay Cache (`BrowserRecipeStore`) & Inter-Agent Handoffs**:
  - Verbatim:
    > "Al analizar una página eh, y realmente hacer las acciones. Ahí hay cosas y lecturas reutilizadas. O reutilizables. Por ende, creo que también nos serviría para el sistema. Tenerlas, optimizadas."
  - Behavior:
    1. Implement `kite_ctx::browser_recipes::BrowserRecipeStore` persisting verified multi-step UI recipes (`BrowserRecipe` + `BrowserActionStep` with `primary_locator`, `fallback_locators`, optional `param_slot`, `expected_landmark_hash`, `success_count`, `failure_count`, `expires_at`) keyed by `(origin, route_pattern, intent)`.
    2. Resolve recipes when route matches and structural landmark similarity passes threshold (`>= 0.80`), enabling deterministic 0-LLM-token replay; auto-quarantine after 2 consecutive failures and return step-level self-healing diagnostics on break.
    3. Support structured parent <-> browser subagent compressed handoffs via `SharedContextStore` (`browser:tab:*`, `browser:origin:*`, `browser:flow:*`).
  - Checks: unit tests in `kite-ctx` covering recipe upsert, parameterized lookup, structural match gating, 2-strike quarantine, self-heal update, and `SharedContextStore` handoff round-trip.

- **S3 — Stateful Browser MCP Proxy, Screenshot Dedup, KV Alignment & `browser:*` Telemetry**:
  - Verbatim:
    > "Por ende me gustaría llegar a mejorar también este sistema. Tal vez a implementar algo con nuestra reutilización de contexto. El. kitectx"
  - Behavior:
    1. Add stateful `tools/call` request-to-response tracking in `mcp_proxy.rs` and `SharedStdioMcpHub` (`mcp_hub.rs`) so browser snapshot/console/network MCP replies automatically flow through `BrowserReadCache` / `SmartCrusher`, and identical base64 `image` blocks on the same `(session_id, tab_id)` deduplicate by SHA-256 into a compact stub.
    2. Extend `kv_aligner.rs` with `VolatileCategory::DomVolatileAttr` (CSRF tokens, generated React/MUI IDs, Vite `?t=` cache-busters, nonces) and `KvAligner::plan_browser_window` batch-freezing for long browser loops.
    3. Record honest `browser:*` telemetry (`browser:snapshot_stub`, `browser:ax_diff`, `browser:chrome_strip`, `browser:network_crush`, `browser:screenshot_dedup`, `browser:recipe_replay`) in `SavingsLedger` (`ledger.rs`), surfaced in `kite ctx stats --json`, `fetch_context_monitor`, and `ContextTab`.
  - Checks: unit tests in `kite-ctx` (`mcp_proxy`, `kv_aligner`, `ledger`) and Vitest (`ContextTab`).

- **S4 — Native In-Process WebView2 COM CDP Engine (`src-tauri/src/browser_cdp.rs`)**:
  - Verbatim:
    > "Básicamente los agentes pueden encontrar el browser rápidamente. Creo que es algo que nosotros tenemos que llegar a implementar porque nuestro browser no lo estamos aprovechando del todo, quiero decir. Podemos mostrar cosas, eso es cierto, pero, más allá de eso no estamos haciendo ni tests, ni nada. Utilizando un browser."
  - Behavior:
    1. Implement an in-process Windows WebView2 CDP bridge using `Webview::with_webview` -> `ICoreWebView2Controller::CoreWebView2()` -> `ICoreWebView2::CallDevToolsProtocolMethod` and `GetDevToolsProtocolEventReceiver` (bridged to async Rust via `tokio::sync::oneshot` with explicit timeouts), requiring zero external browser launch and zero TCP debug ports.
    2. Support compact interactive Accessibility Tree extraction (`Accessibility.getFullAXTree` mapped to short `@eN` refs with visibility/viewport filtering and occlusion culling), programmatic input (`click`, `fill`, `type`, `press`, `hover`, `scroll`, `select`), `Emulation.setDeviceMetricsOverride` for background tabs and responsive viewports, on-demand downscaled `Page.captureScreenshot` (`<=1024px`), structured waits (`wait_for` text/selector/url/idle), and assertions (`assert_text`, `assert_url`, `assert_no_errors`).
    3. Attach bounded per-tab CDP event ring buffers for `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` (warnings/errors, truncated) and `Network` requests (max 50 entries, 4xx/5xx preserved, headers/bodies scrubbed of secrets).
    4. Provide clean cross-platform fallback stubs so non-Windows targets compile cleanly.
  - Checks: Rust unit tests in `browser_cdp` (AX tree parsing/pruning, ref resolution, ring buffer bounds, assertion engine, screenshot sizing/hash) and live Desktop E2E verification.

- **S5 — Multi-Tab Embedded Browser Lifecycle, Agent Ownership & Dev-Server Auto-Discovery**:
  - Verbatim:
    > "Básicamente los agentes pueden encontrar el browser rápidamente... Armar un buen sistema. Que nos ayude, a testear o validar, ciertas cosas."
  - Behavior:
    1. Extend `src-tauri/src/browser.rs` to support multiple concurrent browser tabs per workspace with explicit ownership (`User` vs `Agent { thread_id }`), page title, live `agent_active` / `status_pill` / `paused_for_auth` state, revision bumping on navigation/reload for cache invalidation, and non-eviction of active agent tabs on workspace view switches.
    2. Ensure background/parallel agent tabs do not steal keyboard focus or navigate away from the user's active tab, and render at real viewport dimensions via CDP device emulation rather than `1x1` offscreen bounds.
    3. Implement `src-tauri/src/browser_discovery.rs` probing active loopback dev ports (Vite/Next/React/Tauri/custom ports) and active workspace terminal URLs so `discover` immediately returns reachable local app URLs.
  - Checks: Rust unit tests for multi-tab registry, ownership isolation, revision invalidation, and loopback discovery parser/probe.

- **S6 — Security & Actuation Guardrails (`src-tauri/src/browser_policy.rs`)**:
  - Verbatim:
    > "Ok, me parece bastante, bastante bien. Creo que continuamos con todo, así que, sigamos." (Confirmed Phase 1 + Phase 2 surface matrix.)
  - Behavior:
    1. Enforce `Deny > Ask > Allow` domain actuation policy with per-port `localhost` / `127.0.0.1` / `[::1]` isolation (approving `localhost:5173` never grants `localhost:8080`).
    2. Block cloud metadata / link-local SSRF targets (`169.254.*`, `100.100.100.200`, `metadata.google.internal`) and automatically pause actuation (`paused_for_auth`) on identity providers (OAuth/SSO), payment processors, or CAPTCHA pages so the user completes auth manually and resumes the agent.
    3. Scrub secrets (`Bearer`, `Basic`, `Authorization`, `Cookie`, JWTs, API keys, password fields) across network/console/snapshot outputs and gate arbitrary JS `eval` via explicit policy (`ask | allow | deny`).
  - Checks: Rust unit tests in `browser_policy` covering port isolation, SSRF blocks, IdP/payment detection, secret scrubbing, and `eval` policy gates.

- **S7 — Compact `kite_browser` MCP Tool, `kite browser` CLI, Built-in `browser` Subagent Role & Agent Instructions**:
  - Verbatim:
    > "Básicamente los agentes pueden encontrar el browser rápidamente... Armar un buen sistema. Que nos ayude, a testear o validar, ciertas cosas."
  - Behavior:
    1. Register one compact `kite_browser` tool in `src-tauri/src/dispatch/mcp.rs` and matching `kite browser <subcommand>` CLI in `src-tauri/src/bin/kite.rs`, routed through `dispatch_wire` GUI endpoint directly into live RightDock WebView2 tabs and compressed via `kite-ctx`.
    2. Support actions: `discover`, `tabs`, `open`, `close`, `snapshot`, `act`, `batch` (multi-step sequence + assertions in one call), `replay` (0-token recipe replay with self-heal reporting), `console`, `network`, `errors`, `screenshot`, `eval`, `takeover`, `resume`.
    3. Register a built-in `browser` subagent role profile in Kite's dispatch roles and document `kite_browser` / `kite browser` cleanly in Kite's generated agent dispatch rules (`docs.rs`) and `kite ctx browser` CLI.
  - Checks: Rust tests covering MCP schema registration, CLI arg parsing, dispatch_wire protocol round-trip, and `kite_ctx` integration.

- **S8 — RightDock Multi-Tab Browser UI, Live Agent Status, Takeover & Capture-to-Thread**:
  - Verbatim:
    > "Ok, me parece bastante, bastante bien. Creo que continuamos con todo, así que, sigamos." (Confirmed Phase 2 UX polish.)
  - Behavior:
    1. Upgrade `src/components/views/browser/` (`BrowserView`, `BrowserTabBar`, `browserSurfaceSession.ts`) and `src/components/RightDock.tsx` to display multi-tab headers distinguishing user tabs and parallel agent-owned tabs (showing agent badge, live status pill, and non-focus-stealing background indicators).
    2. Provide one-click **Stop / Take Over** on agent-controlled tabs (halting agent actuation immediately and returning manual control) and **Resume Agent** when paused for user sign-in/auth handoff.
    3. Add toolbar **Capture Screenshot to Thread** and **Local Servers** quick-picker buttons adhering strictly to `AGENTS.md` §1–§2 tokens (`8px` control radius, `26/28px` compact toolbar buttons, `32px` standard inputs, zero silent IPC catches).
  - Checks: Vitest tests (`BrowserView.test.tsx`, `RightDock.test.tsx`), `npm run verify:ipc`, `npm run verify:design`, and Tier 3 Desktop CDP E2E + visual verification at `1366x840` and `960x680`.

- **Deferred to Phase 3 (Confirmed Out of Scope for This Delivery)**:
  - External Chrome `--autoConnect` Lighthouse/performance/heap profiling bridge.
  - Session `.mp4` video screencast recording artifacts.
  - WebMCP page tool discovery/execution.
  - Remote WebRTC live browser video streaming.

## Tasks

- [x] **T1** (`S1`, `S2`, `S3`, Risk: `item 1 (SQLite store.db v2->v3 schema migration), item 3 (shared kite-ctx mcp_proxy/ledger/kv_aligner)`, route: `delegated` — parallel Wave 1 disjoint crate surface): Implement `kite-ctx` v3 (`store.rs` migration, `browser_cache.rs`, `browser_recipes.rs`, `pipeline.rs`, `lossless.rs`, `kv_aligner.rs`, `ledger.rs`, stateful `mcp_proxy.rs` + SHA-256 image dedup) with full unit test suite. Verified: `cargo test -p kite-ctx` (62 passed, 0 failed, 0 warnings).
- [x] **T2** (`S5`, `S6`, Risk: `item 2 (domain allowlist, SSRF/IdP/payment guards, secret scrubbing, JS eval policy)`, route: `delegated` — parallel Wave 1 disjoint new modules): Implement standalone `src-tauri/src/browser_policy.rs` and `src-tauri/src/browser_discovery.rs` with exhaustive unit tests. Verified: `browser_policy::tests` (11 passed) + `browser_discovery::tests` (3 passed, including live loopback probe).
- [x] **T3** (`S4`, `S5`, Risk: `item 4 (WebView2 STA/COM async callback lifecycle), item 5 (Cargo.toml webview2-com direct dependency)`, route: `inline`): Add `webview2-com = "0.39"` to `src-tauri/Cargo.toml`, implement in-process COM CDP engine in `src-tauri/src/browser_cdp.rs`, and upgrade `src-tauri/src/browser.rs` for multi-tab agent ownership, background device emulation, revision invalidation, and CDP commands registered in `src-tauri/src/main.rs`. Verified: `browser::tests` + `browser_cdp::tests` + `kite-code` debug build clean.
- [x] **T4** (`S3`, `S7`, Risk: `item 3 (dispatch MCP schema, CLI subcommands, SharedStdioMcpHub stateful compression, agent rules)`, route: `inline`): Wire `kite_browser` MCP tool (`dispatch/mcp.rs`), `kite browser` & `kite ctx browser` CLI (`bin/kite.rs`, `ctx_cli.rs`), `dispatch_wire` GUI routing, stateful browser compression in `mcp_hub.rs`, `ctx_bridge.rs` / `context_monitor.rs`, built-in `browser` subagent role, and updated `docs.rs` instructions. Verified: `kite_browser` MCP, `mcp_hub` SHA-256 image dedup, `role::tests`, `ctx_cli::tests`, and `kite` binary build all passed.
- [x] **T5** (`S8`, Risk: `item 3 (RightDock/BrowserView IPC contract & layout)`, route: `inline`): Upgrade `src/components/views/browser/` and `src/components/RightDock.tsx` with multi-tab bar, parallel agent badges, live status pill, one-click Stop/Take Over & Resume controls, local dev-server picker, screenshot-to-thread capture, `ContextTab` browser telemetry formatting, and Vitest coverage. Verified: `tsc --noEmit` (0 errors), `BrowserView.test.tsx` (4/4), `RightDock.test.tsx` (pass), `verify:ipc` (0 errors), `verify:design` on changed files (0 errors), `audit-references.mjs` (`[AUDIT CLEAN]`).
- [x] **T6** (`S1`–`S8`, Risk: `none`, route: `inline` + Independent Verifier): Add `scripts/e2e/specs/browser-agent.e2e.mjs`, map browser area in `scripts/quality/gate.config.json`, run full Tier 3 verification (`cargo test`, `tsc`, `vitest`, `audit-references.mjs`, Desktop CDP E2E `BROWSER-AGENT-01` + `--sabotage=overlay`), run Independent Visual Verifier (`thread:2cea9917-42a7-4875-a0b0-20c339079595`, verdict: `APPROVE`) on `1366x840` & `960x680` PNGs, and close out ODD + Engram mirror.

## Log

- **L1 (2026-11-27)**:
  > "Mira, me estoy dando cuenta de algo muy, pero muy útil que estoy viendo en Google Antigravity. Es que, mejoraron demasiado el uso del browser. Básicamente los agentes pueden encontrar el browser rápidamente. Creo que es algo que nosotros tenemos que llegar a implementar porque nuestro browser no lo estamos aprovechando del todo, quiero decir. Podemos mostrar cosas, eso es cierto, pero, más allá de eso no estamos haciendo ni tests, ni nada. Utilizando un browser. Por ende, me gustaría que, plantearas... algo para. Abordar este tema. Quiero que utilices también, subagentes. Eh para analizar con. Utilizando REA. Anti-gravity, básicamente. Para ver qué, es lo que han hecho, cómo podemos implementar algo similar, ver también o examinar otros, repositorios para. Armar un buen sistema. Que nos ayude, a testear o validar, ciertas cosas. Añadiendo a esto, también claro quiero optimizar lo que hacen ellos, quiero decir. Testear utilizando el browser es algo, a mi parecer, o antes era algo costoso. Supongo que ahora ya no lo es tanto porque no se equivocan tanto los agentes. Por ende me gustaría llegar a mejorar también este sistema. Tal vez a implementar algo con nuestra reutilización de contexto. El. kitectx Diría que tal vez podríamos implementar algo relacionado con eso, ¿y a qué me refiero? Bueno. Se hacen llamadas que también se reutilizan o con texto que se reutiliza, por ejemplo. Al analizar una página eh, y realmente hacer las acciones. Ahí hay cosas y lecturas reutilizadas. O reutilizables. Por ende, creo que también nos serviría para el sistema. Tenerlas, optimizadas. No lo sé, diferentes cosas. ¿Qué tal si analizas detalladamente y luego me comentas qué podemos hacer?"
- **L2 (2026-11-27)**: User confirmed totality (Phase 1 + Phase 2 in scope; Phase 3 deferred) and authorized full implementation:
  > "Ok, me parece bastante, bastante bien. Creo que continuamos con todo, así que, sigamos."
- **L3 (2026-11-27)**: Tier 3 delivery verified end-to-end.
  - `cargo test --manifest-path src-tauri/Cargo.toml -p kite-ctx`: 62 passed, 0 failed, 0 warnings.
  - `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --bin kite-code`: `browser::tests`, `browser_cdp::tests`, `browser_policy::tests`, `browser_discovery::tests` (incl. live loopback probe), `kite_browser` MCP, `mcp_hub` stateful SHA-256 image dedup, `role::tests`, `ctx_cli::tests` all passed; `kite-code` & `kite` debug binaries built cleanly.
  - `npx tsc --noEmit`: 0 errors; `vitest`: `BrowserView.test.tsx` (4/4), `RightDock.test.tsx`, `contextMonitor.test.ts` (4/4) all passed.
  - `verify:ipc`: 0 errors; `verify:design` on our 8 changed browser/composer/monitor files: 0 errors (note: 3 pre-existing >1000-line errors exist in unrelated uncommitted `feat/remote-control` files `ArgosStrip.tsx`, `RemoteTab.tsx`, `peekWorkspace.ts`); `node .kite/sanitizer/audit-references.mjs --check`: `[AUDIT CLEAN]`.
  - Desktop CDP E2E `BROWSER-AGENT-01` (`node scripts/e2e/run.mjs --spec browser-agent`): 1/1 PASS (23.7s), verified real Windows WebView2 COM CDP AX extraction, `unchanged_stub` reuse, batched click + assertion, Local Dev Servers discovery, Stop/Take Over & Resume Agent, Screenshot capture to thread, and `1366x840` + `960x680` layout; `--sabotage=overlay` caught hit-test occlusion (1/1 PASS).
  - Independent QA & Visual Verifier (`thread:2cea9917-42a7-4875-a0b0-20c339079595`): `APPROVE` (0 defects across all 6 PNGs and `process-logs.txt`).
  - Pre-existing uncommitted edits on `feat/remote-control` preserved cleanly; awaiting user confirmation before slicing commits (`ask-on-risk`).
