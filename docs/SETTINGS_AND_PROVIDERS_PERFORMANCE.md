# Settings & Providers Performance, Freeze Elimination, and Cache-First UX

This document explains why Kite's **Settings**, **Providers**, **Quotas**, **Subagents**, and **Plugins** surfaces previously stalled or froze during navigation and editing, how each layer was fixed across the Rust backend and React frontend, and which architectural guardrails keep those paths responsive.

---

## Executive Summary

| Bottleneck Area | Pre-Fix Mechanism | Implemented Solution |
| --- | --- | --- |
| Synchronous Rust `#[tauri::command]` handlers | Blocking filesystem scans, SQLite queries, OS keyring lookups, and external CLI probes ran synchronously on the WebView/IPC request path | Converted Settings, Quotas, Account Switcher, Subagents, Agent Updates, Plugins, Dictation, Notifications, and Operator Runtime commands to `pub async fn` using `tauri::async_runtime::spawn_blocking` over preserved `*_direct` sync cores |
| Repeated SQLite opens in credential lookup | `get_vault_credential` re-opened `ConnectionRegistry`, sibling appdata DBs, and ran `CREATE TABLE IF NOT EXISTS` / migrations per provider inside loops | Added single-pass `get_vault_credentials_batch` / `get_vault_credentials_batch_with` (`credentials.rs`) and `ConnectionRegistry::open_if_exists` + `get_secrets_map` (`connections.rs`) so fallback stores open at most once without holding `db_connection()` across fallback I/O |
| Broad backend mutexes & sequential CLI probes | `REGISTRY_LOCK` wrapped external process/keyring checks and slow staging; engine updates, CLI account detection, provider discovery, and quota refreshes probed targets sequentially | Narrowed `REGISTRY_LOCK` around fast registry reads/writes (`SWITCH_LOCK` serializes actual switches), parallelized probes via bounded/scoped worker threads (`std::thread::scope`, `MAX_CONCURRENT_ENGINE_PROBES = 4`), and added write-invalidated caches (`DetectedCliAccountsCache` `5s`, `ThreadProvidersCache` `10s`, `AgentUpdatesSummaryCache` `60s`) |
| Monolithic `SettingsView` mount & Voice IPCs | Mounting `SettingsView` statically pulled all 15 tab trees into the bundle chunk and fired `read_dictation_availability`, `read_dictation_settings`, `list_dictation_input_devices`, and `listAudioInputDevices` on every Settings open | Split all 15 tabs with `React.lazy` + `<Suspense>` and hover/focus `prefetchTab`; deferred Voice dictation/audio discovery strictly until the `'voice'` / `'dictation'` tab activates and cached the snapshot in `dictationCache` across closes |
| Providers/Quotas/Subagents cold waterfalls | `QuotasTab`, `AccountTab`, `AccountVault`, and `SubagentsTab` mounted blank/spinning, prewarmed all 12 `ALL_SUPPORTED_PROVIDERS`, and re-fetched duplicate payloads across components | Added SWR caches (`QUOTAS_TAB_SWR_KEY`, module caches in `AccountTab` and `SubagentsTab`), filtered `prewarmTargetIds` to enabled or configured providers only, coalesced `SubscriptionQuotaManager.fetchAll(true)` via promise reuse instead of busy-waiting, and turned `useAgentUpdates()` into a singleton store with `AGENT_UPDATES_AUTO_CHECK_COOLDOWN_MS = 60_000` |
| Input typing & poll storms | `ZedTab` / `saveOperatorConfig` serialized `localStorage`, fired `save_provider_credential` IPC, and dispatched window events per keystroke; `usePluginConnections` polled every `2000ms` | Added `saveOperatorConfigDebounced` (`OPERATOR_CONFIG_DEBOUNCE_MS = 350`) with `flushOperatorConfigSave` on blur/section-switch/unmount; slowed `usePluginConnections` idle polling to `PLUGIN_CONNECTIONS_POLL_MS = 15_000` with `inFlightFetchRef` and `document.hidden` gating; deferred heavy filter lists (`KeybindingsTab`, `TelemetryTab`, `PluginsView`, `AddProviderModal`) via `useDeferredValue` |
| Compositor & layout thrashing | Blocking `<AnimatePresence mode="wait">` on tab switch, stacked `backdrop-filter: blur(...)` overlays/scrims, `height: 'auto'` animations in `ChangelogTab`, and repeated DOM geometry reads in `SelectMenu` | Removed blocking `mode="wait"` wrappers and heavy blur/shadow stacks in `settings.css`, `quotas-tab.css`, and `QuotaAccountSwitcher.tsx`; batched `SelectMenu` geometry reads + `requestAnimationFrame` throttling; replaced height animations with static disclosure sections |

---

## Root Causes and Implemented Fixes

### 1. Rust Backend: Async IPC, Batch Credentials, Narrowed Locks & Probe Caching (`S1`)

#### Non-Blocking IPC Boundary
- **Root cause**: Multiple Tauri commands backing **Settings**, **Account Switcher**, **Quotas**, **Subagents**, **Plugins**, **Agent Maintenance**, **Dictation/Voice**, **Notifications**, and **Operator Runtime** were synchronous `#[tauri::command] pub fn` handlers that executed SQLite queries, file I/O, or subprocess probes directly on the synchronous command thread.
- **Fix**: Preserved synchronous `*_direct` cores for direct unit testing and internal composition while exposing `pub async fn` Tauri command wrappers backed by `tauri::async_runtime::spawn_blocking`:
  - [`credentials.rs`](../src-tauri/src/credentials.rs): `get_provider_credentials`, `get_active_provider_key`, `save_provider_credential`, `delete_provider_credential`, `migrate_localstorage_credentials`.
  - [`connections.rs`](../src-tauri/src/connections.rs): `list_connections`.
  - [`account_switcher.rs`](../src-tauri/src/account_switcher.rs): all 12 commands (`list_saved_accounts`, `list_detected_cli_accounts`, `save_current_account_profile`, `switch_account_profile`, `delete_account_profile`, `rename_account_profile`, `get_active_account_profile`, `prepare_new_account_login`, `start_account_login_flow`, `cancel_account_login_flow`, `probe_live_account_login_status`, `inspect_provider_sessions`).
  - [`agent_maintenance.rs`](../src-tauri/src/agent_maintenance.rs): `get_agent_updates_summary`, `start_agent_tool_job`, `get_active_agent_tool_jobs`, `cancel_agent_tool_job`.
  - [`chat_commands/mod.rs`](../src-tauri/src/chat_commands/mod.rs) & [`subagents_ui.rs`](../src-tauri/src/chat_commands/subagents_ui.rs): `get_thread_subagent_detail`, `list_all_subagent_runs`, `get_thread_swarm_state`, `send_subagent_message`, `stop_subagent_run`, `swarm_post_from_ui`, `swarm_switch_worker_model`, `swarm_kill_worker_from_ui`, `get_subagent_settings`, `save_subagent_settings`, `list_subagent_roles`, `save_subagent_role`, `delete_subagent_role`, alongside chat read handlers.
  - [`plugins.rs`](../src-tauri/src/plugins.rs), [`dictation.rs`](../src-tauri/src/dictation.rs), [`notifications.rs`](../src-tauri/src/notifications.rs), [`operator_runtime.rs`](../src-tauri/src/operator_runtime.rs), and [`quota/opencode/credentials.rs`](../src-tauri/src/quota/opencode/credentials.rs).

#### Single-Pass Vault & Connection Registry Resolution
- **Root cause**: `get_provider_credentials` iterated through providers calling `get_vault_credential` individually. Each miss re-opened sibling appdata SQLite files, re-ran schema setup, and opened `ConnectionRegistry::open()`.
- **Fix**:
  - Added `ConnectionRegistry::open_if_exists`, `open_if_exists_at`, and single-query `get_secrets_map` in [`connections.rs`](../src-tauri/src/connections.rs).
  - Added `get_vault_credentials_batch` and testable `get_vault_credentials_batch_with` in [`credentials.rs`](../src-tauri/src/credentials.rs) so primary DB queries finish and drop `db_connection()` before fallback sibling DBs or `ConnectionRegistry` open once for all unresolved keys.
  - Backfilled resolved sibling entries in a single transaction via `upsert_vault_entries_conn`, and invalidated `ThreadProvidersCache` on credential mutations.

#### Lock Narrowing, Parallel Probing & Write-Invalidated Caches
- **Root cause**: `REGISTRY_LOCK` stayed locked across process checks and slow OS probes; `detect_all_cli_accounts_uncached`, `discover_thread_providers_with_settings`, `get_agent_updates_summary`, and stale quota refreshes queried external CLIs and APIs sequentially.
- **Fix**:
  - Added `SWITCH_LOCK` (`switch_lock()`) in [`account_switcher/commands.rs`](../src-tauri/src/account_switcher/commands.rs) to serialize multi-step account switches while freeing `REGISTRY_LOCK` around read/probe helpers; added `DetectedCliAccountsCache` (`5s` TTL, write-invalidated via `invalidate_detected_cli_accounts_cache`, time-TTL bypassed under `cfg!(test)`).
  - Added `AgentUpdatesSummaryCache` (`SUMMARY_CACHE_TTL = 60s`, invalidated on tool jobs/updates) and bounded `MAX_CONCURRENT_ENGINE_PROBES = 4` worker pool over shared `MAINTENANCE_HTTP_CLIENT` in [`agent_maintenance.rs`](../src-tauri/src/agent_maintenance.rs).
  - Added `ThreadProvidersCache` (`THREAD_PROVIDERS_CACHE_TTL = 10s`, keyed by subagent settings + write-invalidated on credential, account, engine, and subagent writes) and scoped parallel scans in [`chat/models/providers.rs`](../src-tauri/src/chat/models/providers.rs).
  - Parallelized background quota refresh workers with `std::thread::scope` and an RAII `RefreshingResetGuard` for `IS_REFRESHING` in [`quota/service.rs`](../src-tauri/src/quota/service.rs), and coalesced Antigravity connection persistence in [`quota/antigravity/service.rs`](../src-tauri/src/quota/antigravity/service.rs).

#### Concurrency Fix: Eliminating Notification / Persistence AB-BA Deadlock
- **Root cause**: Moving notification commands onto `spawn_blocking` exposed an existing AB-BA lock-order inversion under parallel test execution (`--test-threads >= 8`):
  1. `persist()` ([`persist.rs`](../src-tauri/src/persist.rs)) builds `DiskState { ... }` inline, so temporary `MutexGuard`s in struct field expressions stay alive across subsequent field acquires in lock order `workspaces -> ... -> revision_counter() -> notifications()`.
  2. `make_notifications_snapshot()` and `notifications_mark_read_direct()` / `notifications_mark_all_read_direct()` ([`notifications.rs`](../src-tauri/src/notifications.rs)) previously held `notifications()` while calling `make_notifications_snapshot_inner()`, which locked `revision_counter()` and `center()`.
- **Fix**: In [`notifications.rs`](../src-tauri/src/notifications.rs), `make_notifications_snapshot()` clones and drops `notifications()` before calling `make_notifications_snapshot_inner()`; `notifications_mark_read_direct()` and `notifications_mark_all_read_direct()` clone the updated slice and drop the guard before building the snapshot; and `make_notifications_snapshot_inner()` reads `revision_counter()` and `center()` in separate short-lived scopes with zero nested locks.

---

### 2. Frontend Data Layer: SWR Caches, Debounced Persistence & Poll Reduction (`S2`, `S3`)

- **Promise-coalesced Quota Refresh & Diff-Gated Storage ([`quotaManager.ts`](../src/lib/quota/quotaManager.ts))**:
  - Replaced spin-wait polling inside `SubscriptionQuotaManager.fetchAll(true)` with explicit in-flight promise coalescing (`queuedForcedPromise`, `queuedForcedProviders`, `hasQueuedForcedAll`).
  - Gated `saveQuotaCache` and subscriber notifications behind value-change comparisons (`mergePayloadIntoCache`).
- **Singleton `useAgentUpdates` Store ([`agentUpdates.ts`](../src/lib/agentUpdates.ts))**:
  - Replaced independent per-component timers and IPC requests with a module-level external store (`useSyncExternalStore`) using `AGENT_UPDATES_INITIAL_DELAY_MS = 1500` and `AGENT_UPDATES_AUTO_CHECK_COOLDOWN_MS = 60_000` with in-flight request sharing.
- **SWR & Event Coalescing Across Providers, Quotas, Accounts, and Subagents**:
  - [`QuotasTab.tsx`](../src/components/views/settings/QuotasTab.tsx): Initializes CLI accounts, verified connections, and vault credentials synchronously from `QUOTAS_TAB_SWR_KEY` (`localStorage`), limits `prewarmTargetIds` strictly to enabled or credential-configured providers instead of all 12 `ALL_SUPPORTED_PROVIDERS`, passes `quotas` directly down to [`AccountVault.tsx`](../src/components/views/settings/AccountVault.tsx) rather than opening a duplicate subscription, and batches `kite:accounts-changed` listener refreshes through `queueMicrotask`.
  - [`AccountTab.tsx`](../src/components/views/settings/AccountTab.tsx), [`accountVaultStore.ts`](../src/lib/accounts/accountVaultStore.ts), and [`SubagentsTab.tsx`](../src/components/views/settings/SubagentsTab.tsx): Added module-level SWR caches (`cachedSnapshot` + `cachedModelsByProvider` in `SubagentsTab`) and microtask-coalesced event listeners.
- **Debounced Zed / Operator Persistence ([`storage.ts`](../src/lib/operator/config/storage.ts), [`ZedTab.tsx`](../src/components/views/settings/ZedTab.tsx))**:
  - Added `saveOperatorConfigDebounced` (`OPERATOR_CONFIG_DEBOUNCE_MS = 350`) merging pending patches cleanly and `flushOperatorConfigSave` called on blur, section changes, and unmount. This stops keystroke-by-keystroke `localStorage` serialization, SQLite `save_provider_credential` IPC floods, and `kite:operator-config-*` broadcast loops.
- **Plugins & Provider Search Efficiency ([`usePluginConnections.ts`](../src/components/views/plugins/usePluginConnections.ts), [`useAgentPluginCoverage.ts`](../src/components/views/plugins/useAgentPluginCoverage.ts), [`PluginsView.tsx`](../src/components/views/PluginsView.tsx), [`AddProviderModal.tsx`](../src/components/quota/AddProviderModal.tsx))**:
  - Increased idle connection poll interval to `PLUGIN_CONNECTIONS_POLL_MS = 15_000`, added `inFlightFetchRef` deduplication and `document.visibilityState === 'hidden'` skip, avoided unnecessary N+1 `load_agent_profile` calls when `listAgentProfiles` already provides `disabledPluginIds`, and applied `useDeferredValue` on provider/plugin search filters.

---

### 3. Settings Shell, Lazy Tabs, Voice Deferral & Compositor Cleanup (`S4`)

- **Code-Split Tabs with Hover Prefetch ([`SettingsView.tsx`](../src/components/views/SettingsView.tsx))**:
  - Converted all 15 Settings tab panels (`GeneralTab`, `ChatSettingsTab`, `SubagentsTab`, `AppearanceTab`, `VoiceTab`, `KeybindingsTab`, `AboutTab`, `TelemetryTab`, `ChangelogTab`, `QuotasTab`, `ZedTab`, `TerminalTab`, `NotificationsTab`, `PluginsView`, `RoutinesView`) to `React.lazy` over `tabLoaders` inside `<Suspense fallback={<SettingsTabFallback />}>`.
  - Added `prefetchTab` on navigation button pointer/focus events and preserved `SettingsModal`'s `isOpen === false` -> `null` contract while retaining loaded module caches (`prefetchedTabs` and `dictationCache`) across close/reopen.
- **Deferred Voice IPCs ([`SettingsView.tsx`](../src/components/views/SettingsView.tsx), [`VoiceTab.tsx`](../src/components/views/settings/VoiceTab.tsx))**:
  - Moved `read_dictation_availability`, `read_dictation_settings`, `list_dictation_input_devices`, and WebRTC `listAudioInputDevices` off root Settings open so they execute only when `'voice'` or `'dictation'` becomes active, sharing a single-flight `loadDictationSnapshot` cache.
- **Tab Transitions, Deferred Filtering, Layout Batching & GPU Layers**:
  - Removed blocking `<AnimatePresence mode="wait" initial={false}>` around active tab panels in [`SettingsView.tsx`](../src/components/views/SettingsView.tsx) and [`SettingsMasterDetail.tsx`](../src/components/views/settings/SettingsMasterDetail.tsx) so switching tabs commits synchronously.
  - Replaced animating `height: 0 -> 'auto'` disclosures in [`ChangelogTab.tsx`](../src/components/views/settings/ChangelogTab.tsx) and deferred search filtering in [`KeybindingsTab.tsx`](../src/components/views/settings/KeybindingsTab.tsx) and [`TelemetryTab.tsx`](../src/components/views/settings/TelemetryTab.tsx) with `useDeferredValue`.
  - Batched DOM geometry reads before style writes in [`SelectMenu.tsx`](../src/components/ui/SelectMenu.tsx) (`updatePosition`) with `requestAnimationFrame` throttling and internal scroll filtering.
  - Eliminated stacked full-viewport `backdrop-filter: blur(...)` layers and oversized multi-pass shadows in [`settings.css`](../src/components/views/settings.css), [`quotas-tab.css`](../src/components/views/settings/quotas-tab.css), and [`QuotaAccountSwitcher.tsx`](../src/components/quota/QuotaAccountSwitcher.tsx) while keeping `AGENTS.md` 4-tier radii and 3-tier control heights intact.

---

## Prevention Guardrails

Keep these invariants intact in future Settings, Providers, or IPC work:

1. **No blocking `#[tauri::command] pub fn` on SQLite, filesystem scans, or CLI probes**: Keep sync `*_direct` functions for fast unit tests and wrap Tauri commands in `pub async fn` with `tauri::async_runtime::spawn_blocking`.
2. **Never nest `notifications()` -> `revision_counter()` locks or open SQLite DBs inside credential loops**: Clone short slices before snapshot formatting, and always resolve multi-provider credentials in one batch (`get_vault_credentials_batch`) after releasing primary DB mutexes.
3. **Never probe all `ALL_SUPPORTED_PROVIDERS` eagerly on tab mount**: Hydrate from SWR caches first and limit prewarm targets to enabled or configured providers.
4. **Debounce persistent text/slider settings**: High-frequency editors in Settings must batch writes (`>= 350ms`) with explicit blur/unmount flush helpers instead of firing SQLite IPCs per keystroke.
5. **Keep Settings tabs behind `React.lazy` and gate tab-specific IPCs on active tab**: Opening Settings on `general` or `quotas` must never trigger audio enumeration, dictation probing, or changelog parsing.
6. **Avoid `mode="wait"`, `backdrop-filter` blur stacks, and unbatched geometry reads inside overlays**: Compositor-heavy blurs on fixed backdrops cause severe scroll/typing frame drops on desktop WebView2.

---

## Verification Coverage

- **Rust Backend (`cargo test --manifest-path src-tauri/Cargo.toml`)**:
  - Single-pass credential batching & non-locking fallback resolution (`credentials.rs`).
  - Single-pass secret map (`connections_tests.rs`).
  - Cache hits and write invalidation on CLI accounts (`account_switcher/tests.rs`), thread providers (`chat/models_tests.rs`), and agent updates (`agent_maintenance.rs`).
  - Async command wrapper roundtrips (`dictation.rs`, `notifications.rs`, `chat_commands_tests.rs`, `operator_runtime.rs`) and default parallel test suite stress without AB-BA deadlock.
- **Frontend (`npx vitest run`, `npx tsc --noEmit`)**:
  - Lazy tab loading, Voice IPC deferral, and modal cache retention ([`SettingsModal.test.tsx`](../src/components/views/settings/SettingsModal.test.tsx), [`TerminalAppearanceSettings.test.tsx`](../src/components/views/settings/TerminalAppearanceSettings.test.tsx)).
  - Quota coalescing & filtered prewarm ([`quotaManager.test.ts`](../src/lib/quota/quotaManager.test.ts), [`QuotasTab.test.tsx`](../src/components/views/settings/QuotasTab.test.tsx)).
  - Singleton update cooldown ([`agentUpdates.test.ts`](../src/lib/agentUpdates.test.ts)), debounced Zed persistence + flush ([`ZedTab.test.tsx`](../src/components/views/settings/ZedTab.test.tsx)), plugin poll cadence/N+1 avoidance ([`usePluginConnections.test.ts`](../src/components/views/plugins/usePluginConnections.test.ts), [`useAgentPluginCoverage.test.ts`](../src/components/views/plugins/useAgentPluginCoverage.test.ts)), deferred Keybindings filter ([`KeybindingsTab.test.tsx`](../src/components/views/settings/KeybindingsTab.test.tsx)), and batched `SelectMenu` positioning ([`SelectMenu.test.tsx`](../src/components/ui/SelectMenu.test.tsx)).
- **Sanitizer Audit (`node .kite/sanitizer/audit-references.mjs --check`)**: Verified clean across all touched files and docs.
