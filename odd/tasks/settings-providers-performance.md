# Settings & Providers Performance, Freeze Elimination, and Cache-First UX

Objective: Eliminate UI and IPC freezes, synchronous backend locks, monolithic tab loading, un-debounced persistence storms, and heavy compositor/render churn across Settings and Providers while keeping state consistent and responsive.
Branch: `feat/response-thread`
Delivery strategy: `ask-on-risk`
Test runner: `npx tsc --noEmit`; `npx vitest run`; `cargo test --manifest-path src-tauri/Cargo.toml`; `node .kite/sanitizer/audit-references.mjs --check`

## Specs

S1. Rust backend async IPC, lock narrowing, and bounded probe concurrency:
- "la parte de configuraciones es lo que peor funciona con respecto a la carga de componentes o freeze, es decir se congela al utilizar diversas cosas, me pasa con los proveedores u otros, la idea seria encontrar puntos de mejora y optimizar"
- User authorized full plan ("si implemetna"), including async/spawn_blocking backend commands, narrowed lock scopes, singleflight/short-TTL invalidated caches, and cache-first background provider refresh.
- Convert synchronous blocking `#[tauri::command] pub fn` handlers invoked by Settings, Providers, Quotas, Account Switcher, Subagents, Agent Updates, Plugins, Dictation, Notifications, and Operator Runtime into non-blocking `async` commands using `spawn_blocking` around sync cores while preserving exact IPC command names, argument payloads, and return JSON schemas.
- Eliminate repeated SQLite DB opens/schema re-inits inside credential resolution loops (`get_vault_credential`), avoid holding `REGISTRY_LOCK` or global DB locks across slow external process scans or file copies where safe, add singleflight / short-TTL caches (invalidated on mutations and deterministic under tests) on heavy detection/discovery/update probes, and parallelize quota background refreshes across stale providers instead of blocking sequentially behind slow CLI probes.

S2. Cache-first (SWR) Providers, Quotas, Account Vault, Subagents, and Plugin connections:
- Render cached credentials, verified connections, and quotas immediately on opening Quotas/Providers/Account/Subagents without blocking UI on unconfigured providers (`ALL_SUPPORTED_PROVIDERS` prewarm limited to enabled/configured providers or background refresh), remove spin-waiting in `SubscriptionQuotaManager.fetchAll(true)`, deduplicate redundant `useAgentUpdates()` / quota / account-change event storms, and throttle/visibility-gate `usePluginConnections` polling (`2000ms` -> calm idle interval + in-flight dedup) and N+1 agent profile reads.

S3. Debounced Zed / Operator configuration and credential persistence:
- Eliminate per-keystroke synchronous `localStorage` serialization, SQLite `save_provider_credential` IPC floods, and broadcast event cascades in `ZedTab`, `ZedProvidersSection`, `ZedPersonaSection`, and `saveOperatorConfig` by debouncing disk/IPC writes while preserving instant input reactivity and flushing pending changes on blur/unmount.

S4. Lightweight `SettingsView`, lazy-loaded tabs, deferred Voice IPCs, and compositor/reflow cleanup:
- Lazy-load Settings tab modules (`React.lazy` + `<Suspense>`), remove `<AnimatePresence mode="wait">` blocking on tab switches, preserve `isOpen === false` -> `null` DOM contract while caching loaded tab data across modal close/reopen, defer dictation/audio IPC discovery (`read_dictation_availability`, `read_dictation_settings`, `list_dictation_input_devices`, `listAudioInputDevices`) strictly until the Voice tab is opened, add `useDeferredValue` on heavy search/filter lists (`KeybindingsTab`, `TelemetryTab`, `AddProviderModal`), optimize `SelectMenu` layout measurements, and remove heavy stacked `backdrop-filter: blur(...)`, oversized shadows, and `height: 'auto'` layout animations while preserving all `AGENTS.md` corner-radius and height tokens.

S5. Root-cause documentation and high-risk concurrency verification:
- Document Settings & Providers freeze causes, fixes, and ongoing performance invariants in `docs/SETTINGS_AND_PROVIDERS_PERFORMANCE.md`, keep unit tests covering every fix, verify shared surfaces via independent read-only audit (`Risk: item 3 / item 4`), and pass full `tsc`, `vitest`, `cargo test`, and `audit-references.mjs --check`.

## Tasks

- [x] T1. S1 — Convert blocking Settings/Providers/Quota/Subagent/Plugin/Account Tauri commands to `async` (`spawn_blocking`), fix credential SQLite re-open loop, narrow mutex lock hold times, parallelize quota probes, and add write-invalidated probe caching (`src-tauri/src/`). Route: `delegated (writer unit A)`. Commits: `2ccc59c`, `8282d28`, `2cfa090`, `42dddbb`, `96a26ed`, `fb012b0`.
- [x] T2. S2, S3 — Refactor Providers/Quotas/AccountVault/Subagents/Plugins to cache-first SWR + debounced Zed/Operator persistence + throttled/in-flight-guarded `usePluginConnections` (`src/lib/`, `src/components/quota/`, `src/components/views/settings/{QuotasTab,AccountVault,AccountTab,SubagentsTab,ZedTab,zed/*}`, `src/components/views/plugins/usePluginConnections.ts`). Route: `delegated (writer unit B)`. Commits: `ccae26b`, `1c8b87c`, `90229b2`.
- [x] T3. S4 — Lazy-load `SettingsView` tabs, defer Voice dictation IPCs out of root modal mount, preserve tab caches across close/reopen, remove `mode="wait"` blocking, defer filter rendering, optimize `SelectMenu`, and clean up stacked `backdrop-filter` / `box-shadow` / `height: auto` costs (`SettingsView.tsx`, `VoiceTab.tsx`, `SettingsMasterDetail.tsx`, `ChangelogTab.tsx`, `KeybindingsTab.tsx`, `TelemetryTab.tsx`, `SelectMenu.tsx`, `settings.css`, `quotas-tab.css`). Route: `delegated (writer unit C)`. Commits: `62a2d88`, `5a6a4bd`.
- [x] T4. S5 — Audit writer diffs against disjoint surfaces, run full suite (`tsc`, `vitest`, `cargo test`, `audit-references.mjs --check`), author `docs/SETTINGS_AND_PROVIDERS_PERFORMANCE.md`, and stage work-unit commits. Route: `inline`.
- [x] T5. S1-S5 — Run independent verification review covering concurrency/async ordering and shared contracts (`Risk: item 3, item 4`) and close ODD. Route: `delegated (verifier)`. Verified `S1`–`S5` PASS and `Risk: item 3, item 4` CLEAN on slice `cb577cd..5a6a4bd` + docs.

## Log

L1. User (2026-11-14): funciona bastante bien realemtne, la parte de configuraciones es lo que peor funciona con respecto a la carga de componentes o freeze, es decir se congela al utilizar diversas cosas, me pasa con los proveedores u otros, la idea seria encontrar puntos de mejora y optimizar
L2. User (2026-11-14): si implemetna (approved full optimization plan including Rust async/spawn_blocking with cache/SWR and SettingsView lazy-loading + cache-first providers)
L3. Verification (2026-11-14): Full verification passed after final edits (`tsc --noEmit`, `vitest`, parallel `cargo test`, `audit-references.mjs --check`); independent verifier (`T5`) confirmed `S1`–`S5` PASS and `Risk: item 3, item 4` clean.
