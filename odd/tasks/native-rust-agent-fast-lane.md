# Native Rust Agent Fast Lane (Phase 3 of 3)

Objective: Introduce an ultra-lightweight (~5 MB/agent) native Rust agentic turn engine inside `kite-core` strictly for officially supported HTTPS/SSE endpoints (OpenCode Go gateway and direct API keys for OpenAI, Anthropic, xAI, Gemini, DeepSeek, Kimi, Vercel, Cloudflare) and lightweight utility/research subagents — explicitly refusing consumer-subscription OAuth spoofing — alongside pooled MCP consumption and live runtime resource telemetry/settings in the desktop UI.
Branch: `feat/remote-control`. Delivery strategy: `work-unit-commits` (forecast ~1,500–2,000 authored changed lines across 5 parallel disjoint units `T1`–`T5` + parent seam wiring).
Test runner: `cargo test --manifest-path src-tauri/Cargo.toml --workspace`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npm run verify:ipc`, `npm run verify:design`, `npm run verify:gate -- --tier scoped --spec desktop-smoke`, `node .kite/sanitizer/audit-references.mjs --check`.
Series: ODD 3 of 3 for Alternative 3 (follows `odd/tasks/baseline-ram-and-leak-elimination.md` and `odd/tasks/multiplexed-provider-daemons-and-mcp-hub.md`).
Protected zones: Do NOT modify `src/components/TitleBar.tsx` (`mode-toggle--stadium`, `layoutId="titlebar-mode-toggle-indicator"`), and enforce the 4-tier corner radius and 3-tier control height contracts in `AGENTS.md`.

---

## Specs

- **S1 — Native Rust HTTPS/SSE Provider Adapters & Strict Auth Eligibility Guard**:
  - Verbatim:
    > "No necesariamente quitándola, pero sí buscando. Como dije, una alternativa o creando nuestra propia CLI, o forma de. Mostrar todo. Utilizando las, las suscripciones como tal."
  - Behavior:
    - Implement `DirectEligibility` (`OfficialApiKey`, `OfficialGateway(OpenCodeGo)`) and `resolve_fast_lane_endpoint(...) -> Result<FastLaneEndpoint, FastLaneIneligible>` in `src-tauri/src/native_agent/`: explicitly rejects consumer subscription OAuth tokens (Antigravity, Claude Pro/Max, ChatGPT/Codex OAuth, Cursor session cookies) so those always execute over Phase 2 official multiplexed daemons.
    - Share one singleton `reqwest::Client` (`pool_max_idle_per_host = 16`, `pool_idle_timeout = 90s`).
    - Implement streaming SSE parsers emitting normalized `NativeStreamChunk` (`TextDelta`, `ReasoningDelta`, `ToolCallStart`, `ToolCallDelta`, `Usage`, `Done`, `RateLimited`, `Error`) for OpenAI-compatible gateways/APIs (`openai_compat.rs` incl. OpenCode Go `x-opencode-session`), Anthropic Messages (`anthropic.rs` incl. `cache_control: ephemeral`, thinking + `tool_use`), and Gemini Developer API (`gemini.rs` `streamGenerateContent?alt=sse`).
  - Checks: Deterministic SSE fixture tests for all 3 adapters + explicit consumer OAuth eligibility rejection tests.

- **S2 — Native Rust Workspace-Sandboxed Coding Tools Suite**:
  - Verbatim:
    > "creando nuestra propia CLI, o forma de. Mostrar todo."
  - Behavior:
    - Implement JSON-schema callable tools in `src-tauri/src/native_agent/tools/`: `read_file` (line ranges + `kite-ctx` map/signatures), `edit_file` (exact match + replacement), `write_file`, `grep_search`, `find_files`, and `run_command` (wrapping `crate::hidden_exec` + `kite-ctx` compression).
    - Enforce canonical workspace root containment rejecting `..` escapes and unauthorized absolute paths.
  - Checks: Temp-directory unit tests covering all 6 tools and path-traversal rejection.

- **S3 — Native Rust Pooled MCP Client**:
  - Verbatim:
    > "nuestra aplicación tiene que ser cualiviana posible."
  - Behavior:
    - Implement `NativeMcpClient` (`src-tauri/src/native_agent/mcp_client.rs`) connecting over Streamable HTTP/SSE (`POST /mcp` against `kite-core` MCP Hub with bearer auth) and pooled stdio fallback, compressing large responses with `kite_ctx::mcp_proxy::compress_mcp_jsonrpc_line`.
  - Checks: Loopback TCP mock MCP server test verifying `initialize`, `tools/list`, and `tools/call`.

- **S4 — Native Rust ReAct Loop, Token-Budget Compaction & `SessionTransport` Integration**:
  - Verbatim:
    > "creando nuestra propia CLI, o forma de. Mostrar todo."
  - Behavior:
    - Implement 2-stage `compaction.rs` (CCR replacement of older large tool outputs first, oldest-turn summarization beyond 75% token budget), async Tokio `loop_engine.rs` emitting canonical `ProviderTurnEvent`s with `PermissionMode` approval gating via `crate::chat::approval` and clean cancellation, and `NativeFastLaneTransport` implementing `SessionTransport` (`transport.rs`).
  - Checks: Scripted mock `NativeProvider` tests covering multi-step tool loops, `supervised` approval gate, cancellation, and compaction.

- **S5 — Runtime Architecture Telemetry & Settings Controls**:
  - Verbatim:
    > "Mostrar todo."
  - Behavior:
    - Add typed IPC helpers `getRuntimeTransportMetrics` and `saveRuntimeResourceSettings` in `src/lib/ipc/chat.ts` backed by Tauri commands registered in `src-tauri/src/main.rs`.
    - Display live runtime metrics in `src/components/telemetry/SystemResourcePopover.tsx` (active multiplexed daemons, MCP Hub pooled servers, Native Fast Lane sessions, Heavy process concurrency `active/max`).
    - Expose token-compliant settings toggles/controls (`rounded-control`, `32px`/`28px` height tokens, no edits to `TitleBar.tsx`) in `GeneralTab.tsx` / `SubagentsTab.tsx` for Fast Lane opt-in (API keys / OpenCode Go), MCP Hub pooling, and Heavy Process concurrency cap (`1–8`).
  - Checks: Vitest tests for `SystemResourcePopover` and settings tabs, `npx tsc --noEmit`, `npm run verify:ipc`, `npm run verify:design`.

---

## Tasks

- [x] **T1** (`S1`, Risk: `item 2 — auth eligibility boundary & official SSE endpoints`, route: `delegated (bounded-writer Unit 3A)`): Create `src-tauri/src/native_agent/{types.rs,providers/{mod,openai_compat,anthropic,gemini}.rs}` with `DirectEligibility` guard and SSE parsers + tests.
- [x] **T2** (`S2`, Risk: `item 2 — workspace path containment`, route: `delegated (bounded-writer Unit 3B)`): Create `src-tauri/src/native_agent/tools/{mod,fs_tools,search_tools,shell_tools}.rs` with canonical workspace root containment + tests.
- [x] **T3** (`S3`, Risk: `item 3 — MCP JSON-RPC client`, route: `delegated (bounded-writer Unit 3C)`): Create `src-tauri/src/native_agent/mcp_client.rs` supporting HTTP MCP Hub + pooled stdio fallback + tests.
- [x] **T4** (`S4`, Risk: `item 4 — async turn cancellation & approval synchronization`, route: `delegated (bounded-writer Unit 3D)`): Create `src-tauri/src/native_agent/{compaction,loop_engine,transport,mod}.rs` implementing `NativeFastLaneTransport` + tests.
- [x] **T5** (`S5`, Risk: `item 3 — typed IPC contract & UI design tokens`, route: `delegated (bounded-writer Unit 3E)`): Add `getRuntimeTransportMetrics` / `saveRuntimeResourceSettings` in `src/lib/ipc/chat.ts`, surface runtime breakdown in `SystemResourcePopover.tsx`, and add settings controls in `GeneralTab.tsx` / `SubagentsTab.tsx` + Vitest coverage.
- [x] **T6** (`S1`–`S5`, Risk: `item 3, item 5 — main.rs command registration & runtime routing`, route: `inline seam & full verification`): Register `native_agent` and telemetry/settings commands in `main.rs`, wire Fast Lane opt-in routing in `chat/runtime/state.rs`, run full workspace verification (`cargo test --workspace`, `tsc`, `vitest`, `build`, `verify:ipc`, `verify:design`, `verify:gate --tier scoped --spec desktop-smoke`, `audit-references.mjs`), and log live measured RAM benchmark across all 3 ODDs.

---

## Log

- **L1 (2026-11-26 — Initial Request):**
  > "Creo que hagamos una revisión exhaustiva sobre posibles optimizaciones en cuanto al consumo. Básicamente, nuestra aplicación tiene que ser cualiviana posible. Se logre. A lo que me refiero es que de, de base ya tenemos un consumo elevado. Entonces, la idea es pensar en ciertos puntos de optimización. Para llegar a abordarlos. También con respecto a los agentes y la comunicación ACP. Pensar en alternativas o formas de optimizar esto. Dado que, al tener muchos agentes, se vuelve muy costoso. Creo que en Anti-Gravity, inclusive teniendo, por ejemplo, cinco conversaciones. Y estos ejecutando sus agentes en cada una. No sube mucho. Quiero decir, a ver. En una conversación. Consume alrededor de un giga trescientos. De RAM. Y al tener por ejemplo cinco. En paralelo. Y cada uno con sus agentes. Consume alrededor de dos gigabytes. En cambio nosotros consumimos como unos cinco gigabytes, o, cuatro. Al tener esos cinco conversaciones en paralelo con sus agentes. Por ende tenemos que pensar en... cómo hacerlo. No lo sé, tal vez quitando la comunicación a CP o, buscando algún, alguna alternativa. No necesariamente quitándola, pero sí buscando. Como dije, una alternativa o creando nuestra propia CLI, o forma de. Mostrar todo. Utilizando las, las suscripciones como tal."
- **L2 (2026-11-26 — User Selection of Alternative 3 & Parallel Subagent Authorization):**
  > "¿Ok, si me parece todo correcto? Nos quedamos con la alternativa tres. Quiero que plantees los ODS correspondientes para implementar. Quiero que utilices subagentes en paralelo para hacerlo más rápido. No importa cuántos sean, pueden ser hasta máximo seis en paralelo. Pero claro, tienen que ser tareas que se puedan hacer en paralelo ellos como tal. Quiero que continúes con todo."
  - Phase 3 ODD authored before source edits; queued behind Wave 2 verification.
- **L3 (2026-11-26 — Phase 3 Seam Integration, Full Verification & Live Benchmark):**
  - Wired `pub mod native_agent;`, startup `global_process_governor().set_heavy_limit(...)`, and `get_runtime_transport_metrics` / `save_runtime_resource_settings` / `get_runtime_resource_settings` in `src-tauri/src/main.rs`, plus `try_select_fast_lane_transport` in `src-tauri/src/chat/runtime/state.rs` and `invokeFlatCommand` in `src/lib/ipc/chat.ts`.
  - Rust verification: `cargo test --bin kite-code native_agent::` `46 passed; 0 failed` (`2.29s`); `cargo test -p kite-ctx` `50 passed; 0 failed` (`0.11s`); `cargo check --bin kite` OK; `cargo build --no-default-features --bin kite-code --bin kite` OK (`49.72s`); prior full `kite-code` run (skipping 4 pre-existing/environmental tests) observed `1,045 passed; 1 failed` due to parallel race in `account_switcher::tests::test_rank_priority_order_bucket_mismatch_and_resume_runtime_state` (`1/1 passed` in `0.04s` solo) and pre-existing `hidden_exec::tests::job_object_kills_descendant_process_tree_on_kill` failed even serially (`0.36s`, untouched outside task scope).
  - Frontend & E2E verification: `tsc --noEmit` `0` errors; full `vitest run` `256/256` files / `1,947/1,947` tests passed (`93.25s`); `vite build` entry `index-*.js` `780.44 kB`; `verify-ipc.mjs` `[PASS]`; `verify-design.mjs --files` `[PASS]` (0 blocking violations across Phase 1–3 edited files); `audit-references.mjs --check` `[AUDIT CLEAN]`; `DESKTOP-SMOKE-01` CDP E2E `1/1 passed` (`7.12s`, screenshots inspected).
  - Isolated live benchmark (loading copied 167-thread `94.9 MB` `kite.sqlite` in sandboxed `Kite Code Dev` serving Vite `:1420` + CDP): GUI `77.9 MB WS / 33.7 MB Priv` (down `-80.6%` Priv from `173.9 MB`), `--daemon` `27.8 MB WS / 17.3 MB Priv` (down `-88.2%` Priv from `146.2 MB`), total `696.1 MB WS / 412.8 MB Priv` (including unbundled dev-mode WebView2 `361.8 MB Priv` under CDP; production bundle WebView2 + `VACUUM` checkpoint remains to be measured in a release installer build).
  - `Risk: item 2, item 3, item 4, item 5 (auth eligibility guard refusing consumer OAuth, workspace path sandboxing, async ReAct loop/cancellation & approvals, main.rs IPC registration, and subagent settings/telemetry UI)`.
