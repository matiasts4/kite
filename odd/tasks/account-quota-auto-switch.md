# Automatic Account Switching on 0% Quota with Subscription & Model Compatibility Confirmation

Objective: Allow users to configure opt-in automatic account switching when an active account hits `0%` quota (`isExhausted` / rate-limit failure), while protecting subscription tier differences by asking for explicit confirmation via an interactive notification button whenever the active model is unavailable in the target account's plan.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `single-pr` on `feat/response-thread` (selective staging keeping concurrent dirty work untouched).
Test runner: `cargo test account_switcher`, `cargo test quota::`, `cargo test handoff`, `cargo test chat::`, `cargo test terminal::`, `npx vitest run src/components/quota src/components/views/settings src/lib/toast`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.

---

## Specs

### S1 — Configurable Per-Provider Auto-Switch Policy (`0%` Opt-In & User Controls)
Addresses user requirement: *"cambio automatico de las cuentas al llegar a la cuota limite, claramente debe ser algo configurable es decir a decicion del usuario"* and *"cuando se llegue al limite 0%"*.

1. **Backend Policy Persistence (`registry.rs` / `profiles.json`):**
   - Add an opt-in `auto_switch_policies: HashMap<String, AutoSwitchPolicy>` map (`#[serde(default)]`) to `AccountProfilesRegistry` keyed by canonical provider (`"agy"` for Antigravity, schema extensible per provider). Existing registries deserialize cleanly with `enabled = false`.
   - `AutoSwitchPolicy` fields:
     - `enabled: bool` (default `false` — strictly opt-in).
     - `trigger_threshold_percent: f64` (default `0.0`, triggering when quota reaches `0%` / `isExhausted`).
     - `selection_strategy: String` (`"highest_quota"` default | `"priority_order"`).
     - `priority_order: Vec<String>` (ordered account IDs when user prefers manual order).
     - `excluded_account_ids: Vec<String>` (saved profiles the user excludes from automatic rotation).
     - `model_mismatch_policy: String` (`"confirm_notification"` default | `"auto_fallback"`, honoring *"si el modelo es distinto pedir confirmacion"* while staying user-configurable).
     - `busy_terminals_policy: String` (`"wait_idle"` default | `"ask"` | `"interrupt"`, reusing `inspect_provider_sessions` busy detection rather than silently killing streaming work unless explicitly allowed).
     - `auto_continue_chat_turn: bool` (default `true` once account switch + model validation succeed).
     - `cooldown_seconds: u64` (default `120`) and `max_consecutive_switches: u32` (default `3` within a rolling 10-minute window) as anti-ping-pong circuit breakers.
2. **IPC Contract (`account_switcher.rs` / `src/lib/ipc/accounts.ts`):**
   - Expose `get_auto_switch_policy(provider)` (returning policy + live coordinator status: `paused`, `pauseReason`, `cooldownUntilMs`, `recentSwitchCount`) and `save_auto_switch_policy(provider, policy)` + `resume_auto_switch(provider)`.
   - Validation rejects empty/negative bounds and normalizes provider aliases (`"antigravity"` -> `"agy"`).

---

### S2 — Per-Profile Subscription Tier, Quota Windows & Enabled Model Catalog Caching
Addresses user requirement: *"hay diferentes tipos de suscripciones y hay que considerar que tal vez no esten disponibles los modelos exactos al cambia"*.

1. **Enriched Profile Capability Snapshot (`registry.rs`):**
   - Extend `SavedAccountProfile` with additive `#[serde(default)]` fields (backwards-compatible with older `profiles.json`):
     - `quota_windows: Vec<CachedQuotaWindow>` (`name`, `remaining_percent`, `is_exhausted`, `resets_at`, `time_until_reset_ms`, `updated_at_unix_ms`) capturing per-family buckets (e.g., Gemini 5h vs Claude vs Flash).
     - `available_model_ids: Vec<String>` and `models_updated_at_unix_ms: Option<i64>` recording the real models reported for that account's subscription (`provider_models("antigravity", ...)` / `query_agy_models_cli` / IDE `clientModelConfigs`).
   - Whenever `save_current_account_profile_direct`, active quota probes, or `list_saved_accounts_direct` refresh metadata for the currently active profile, persist its `plan_name`, `quota_windows`, and known `available_model_ids` (never cross-contaminating inactive profiles).
2. **Compatibility-Aware Candidate Ranking (`get_alternative_accounts_with_quota` upgrade):**
   - Replace naive `.unwrap_or(100.0)` filtering with `rank_auto_switch_candidates_in`:
     - Exclude current active profile, profiles in `excluded_account_ids`, profiles with `credential_status != "valid"`, and profiles inside cooldown or recently marked exhausted without reset elapsed.
     - Verify quota using both the relevant model/group `QuotaWindow` (when available) and `primary_remaining_percent > policy.trigger_threshold_percent` (or reset deadline passed). Known healthy quota ranks strictly ahead of profiles with unknown (`None`) cached quota.
     - Classify each eligible candidate against `requested_model` (if present in the triggering Thread or active context):
       - **`exact`**: `requested_model` is confirmed in `candidate.available_model_ids` (or `requested_model` is unset/PTY-default).
       - **`model_mismatch`**: `requested_model` is absent from `candidate.available_model_ids` (or that model's bucket is `0%` while other buckets have quota), attaching `suggested_fallback_model` (closest compatible family/effort match in `candidate.available_model_ids`) and `source_plan` / `target_plan`.
       - **`unverified_catalog`**: candidate has quota > 0% and valid tokens, `available_model_ids` was not cached yet (e.g., older profile saved before caching); verify post-switch catalog before auto-resuming a pinned `thread["model"]`.
     - Prefer `"exact"` candidates first (sorted by `priority_order` or `primary_remaining_percent` descending); only fall back to `"model_mismatch"` / `"unverified_catalog"` when no exact-model candidate has remaining quota.

---

### S3 — Deterministic `0%` Exhaustion Triggers & Anti-Loop Coordinator
Addresses *"cuando se llegue al limite 0%"* safely across Threads, Quota Polling, and Antigravity PTY terminals.

1. **Serialized `AutoSwitchCoordinator` (`account_switcher/auto_switch.rs`):**
   - Mutex-serialized evaluation preventing concurrent duplicate switches from racing pollers and settled chat turns.
   - Circuit breaker tracks switches per `(provider, target_account_id)` and rolling 10-minute switch count: if `recent_switches >= max_consecutive_switches` or no eligible candidate exists, pauses auto-switch with an actionable reason (`ALL_ACCOUNTS_EXHAUSTED` with earliest reset ETA, `CIRCUIT_BREAKER_PAUSED`, `IDE_PROCESS_BUSY`), emits event `kite://auto-switch-status`, and NEVER thrashes credentials in a loop.
   - Cooldown resets automatically when a different healthy reset arrives or the user manually triggers `resume_auto_switch` / switches account cleanly.
2. **Three Coordinated Trigger Sources (when `policy.enabled == true`):**
   - **Thread Turn Exhaustion (`chat/runtime/settle.rs`):** When `detect_quota_exhaustion` fires at turn end (e.g., `RESOURCE_EXHAUSTED`, `429`, quota limit reached):
     - Evaluate `AutoSwitchCoordinator` with `requested_model = thread["model"]` and `thread_id`.
     - If an `"exact"` candidate wins cleanly (and terminals satisfy `busy_terminals_policy`): run `switch_account_profile_direct_with_options`, immediately verify post-switch catalog still supports `requested_model`, clear `thread["providerSessionId"]` + `thread["quotaHandoffOffer"]`, and if `auto_continue_chat_turn == true`, call `start_turn` automatically with the built handoff capsule + emit toast (`"Cuenta «A» llegó a 0% -> cambiada a «B»"`).
     - If best candidate is `"model_mismatch"` or `"unverified_catalog"` (and `model_mismatch_policy == "confirm_notification"`) OR `busy_terminals_policy == "ask"` with busy PTYs: do **NOT** overwrite `thread["model"]` or interrupt silently; keep `quotaHandoffOffer` populated and emit a `PendingAutoSwitchConfirmation` (`S4`).
     - If *no* same-provider account has quota: retain existing `QuotaHandoffBanner` cross-provider suggestions (`claude`, `codex`, etc.) and emit exhaustion pause notice.
   - **Quota Polling (`quota/service.rs`):** When a fresh (epoch-valid, non-SWR-stale) quota fetch reports the active account at `<= trigger_threshold_percent` (default `0.0`) or `is_exhausted == true`:
     - Evaluate `AutoSwitchCoordinator` (checking `busy_terminals_policy` before any PTY restart; if `"wait_idle"` and Antigravity terminals are actively streaming, defer switch until idle or surface actionable confirmation rather than dropping output; when `PROVIDER_BUSY` detects an open IDE desktop window (`base_app_open`), pause cleanly with `IDE_PROCESS_BUSY` and never force-close the desktop window; when only residual background processes remain (`residual_only`), surface actionable cleanup alongside the notice).
   - **Guarded Antigravity PTY Exhaustion Detection (`terminal/lifecycle.rs`):**
     - Scan ANSI-stripped PTY error lines ONLY on `antigravity`/`agy` (including hybrid shell `agy`) terminals using unambiguous CLI quota-exhaustion patterns, and require correlation with live quota/debounce (`>= 10s` per session + never firing simply because source code / git diffs print `"RESOURCE_EXHAUSTED"` without an active CLI error frame) before invoking `AutoSwitchCoordinator`.

---

### S4 — Interactive Notification Confirmation & Post-Switch Model Reconciliation
Addresses user requirement: *"si el modelo es distinto pedir confirmacion, puede ser por una notificacion con un boton o algo asi"*.

1. **Pending Confirmation Flow (`pending_auto_switch`):**
   - Backend emits `kite://auto-switch-confirmation` AND mirrors a sticky actionable item into `src-tauri/src/notifications.rs` (`notifications_report_attention`-compatible record with `kind: "autoSwitchConfirm"` and payload metadata) so confirmation survives missed/dismissed transient toasts.
   - Payload includes: `confirmationId`, `provider`, `fromAccountLabel`, `fromEmail`, `toAccountId`, `toAccountLabel`, `toPlanName`, `requestedModel`, `suggestedFallbackModel`, `availableTargetModels`, `threadId`, `busySessions`, `reason`, `expiresAtUnixMs`.
2. **Actionable Toast (`src/lib/toast.ts` `toast.action`) & Notification Bell Card (`NotificationsView.tsx`):**
   - Frontend listener triggers `toast.action(...)` with clear title & description (e.g., *"«Personal» llegó a 0% — confirmar cambio de modelo"*, `"«Work (Free)» tiene 100%, pero no incluye «claude-opus-4-6». ¿Cambiar usando «gemini-2.5-flash»?"*) and primary button (*"Cambiar y usar «gemini-2.5-flash»"*), plus opens/focuses inline model picker inside the notification card or confirmation sheet if the user wants to pick a different model from `availableTargetModels` or switch without auto-resuming.
   - `NotificationsView.tsx` / `AppNotificationsPopover.tsx` renders the same pending confirmation card with one-click `"Confirmar cambio"` and `"Descartar"` buttons until resolved.
3. **Transactional Confirm & Catalog Verification (`confirm_pending_auto_switch` / `dismiss_pending_auto_switch`):**
   - On confirmation with `selected_model_id` (defaulting to `suggested_fallback_model`):
     - Re-run `switch_account_profile_direct_with_options(provider, to_account_id, force_busy)` (handling rollback on credential failure cleanly).
     - After `evict_provider_runtime_state`, query fresh `provider_models("antigravity", true)` and run `validate_provider_model_selection("antigravity", &target_model)` (resolving an adjusted model if the fresh catalog changed unexpectedly).
     - If linked `threadId` exists and `auto_continue_chat_turn == true`, set `thread["model"] = json!(validated_model)` (never keeping an unsupported `thread["model"]`), clear `providerSessionId` & `quotaHandoffOffer`, record system notice in thread items, and resume turn cleanly via `start_turn`.
     - If terminals were rotated (`quiesce`/`respawn`), keep `SpawnMode::Agent` clean so PTYs launch on the new account with preserved scrollback divider.

---

### S5 — Unified Auto-Switch Settings UI in Vault & Popover
Addresses *"claramente debe ser algo configurable es decir a decicion del usuario"* cleanly inside existing Vault surfaces without fragmenting settings or violating design tokens (`AGENTS.md`).

1. **Shared Store Integration (`src/lib/accounts/accountVaultStore.ts` & `useAccountVault.ts`):**
   - Manage `autoSwitchPolicy`, `autoSwitchRuntimeStatus`, and `pendingAutoSwitchConfirm` per provider inside `AccountVaultStore`, synchronized across `AccountVault`, `AccountSwitcherModal`, `SubscriptionQuotaPopover`, and `QuotasTab` via `kite:auto-switch-changed`.
2. **Configuration Controls (Design System Compliant):**
   - Use `--control-radius` (8px), `--card-radius` (12px), `--dialog-radius` (14px), and `32px`/`28px` control heights; zero changes to `src/components/TitleBar.tsx`.
   - In `AccountVault.tsx` & `AccountSwitcherModal.tsx` (compact drawer/section) + status indicator badge in `SubscriptionQuotaPopover`:
     - Master toggle: **"Cambio automático al 0%"** (apagado por defecto).
     - Sub-controls shown when enabled:
       - Prioridad/Elegibilidad: toggles por cuenta + orden (`Mayor cuota disponible` vs `Orden manual` con controles subir/bajar).
       - Comportamiento si cambia el plan/modelo: `"Pedir confirmación con notificación"` (default) vs `"Ajustar automáticamente al mejor modelo compatible"`.
       - Terminales ocupadas: `"Esperar a que terminen"` (default) vs `"Preguntar antes de reiniciar"` vs `"Reiniciar enseguida"`.
       - Banner de estado en vivo cuando está en cooldown o pausado (*"Auto-cambio pausado: todas las cuentas en 0% — próximo reset en X"* + botón **"Reanudar"**).

---

### S6 — End-to-End Test & Regression Verification
- Add Rust unit/integration tests in `account_switcher/tests.rs` and `chat`/`handoff` tests covering: policy serialization backwards-compatibility; candidate ranking (`exact` > `model_mismatch`, exclusion of `excluded_account_ids` & non-valid credentials, unknown `None` quota handling, reset-elapsed detection); circuit breaker pause + cooldown anti-loop; model verification after confirm; and PTY exhaustion correlation false-positive guard.
- Add Vitest tests covering `AutoSwitchSettings` persistence & `accountVaultStore` sync, `toast.action` confirmation click -> `confirmAutoSwitch` IPC invocation with selected fallback model, and `NotificationsView` sticky confirmation card rendering/resolution.
- Gate every slice with `cargo test`, `npx tsc --noEmit`, `npx vitest run`, and `node .kite/sanitizer/audit-references.mjs --check`.

---

## Tasks

- [x] **T1** (`S1`, `S2`, Risk: `item 1, item 3 — profiles.json additive schema & capability cache`, route: `inline`, ~220 lines): Extend `AccountProfilesRegistry` and `SavedAccountProfile` (`registry.rs`) with `AutoSwitchPolicy`, `CachedQuotaWindow`, and `available_model_ids`; implement `get_auto_switch_policy`, `save_auto_switch_policy`, `resume_auto_switch` IPCs and TS client types/functions; persist model/window snapshots during active save/list/quota probes; implement `rank_auto_switch_candidates_in` with model-compatibility classification. (Commit `8d83678`; Verified `S1: PASS, S2: PASS`)
- [x] **T2** (`S3`, Risk: `item 4 — serialized AutoSwitchCoordinator, circuit breaker & trigger orchestration`, route: `delegated`, ~280 lines): Build `account_switcher/auto_switch.rs` (`AutoSwitchCoordinator`, cooldown, rolling ping-pong circuit breaker, pause/resume state); wire fresh `quota/service.rs` `0%` / `is_exhausted` poll triggers and guarded Antigravity PTY exhaustion trigger (`terminal/lifecycle.rs`) with busy-terminal respect (`wait_idle`/`ask`/`interrupt`). (Commit `211b736`; Verified `S3: PASS`)
- [x] **T3** (`S3`, `S4`, Risk: `item 3, item 4 — model compatibility confirmation IPCs & Thread auto-continue`, route: `delegated`, ~260 lines): Add `PendingAutoSwitchConfirmation` lifecycle (`confirm_pending_auto_switch`, `dismiss_pending_auto_switch`), wire `settle.rs` exhaustion detection to auto-continue exact-match switches or emit `kite://auto-switch-confirmation` + `notifications.rs` record on model/tier mismatch, and enforce fresh `provider_models` validation + `thread["model"]` update before resuming. (Commit `1c5eadf`; Verified `S3: PASS, S4: PASS`)
- [x] **T4** (`S4`, `S5`, Risk: `item 3 — interactive toast/notification confirmation & Vault settings UI`, route: `delegated`, ~320 lines): Wire global frontend `kite://auto-switch-confirmation` handler with `toast.action` button + `NotificationsView.tsx` actionable confirmation card (including inline fallback model picker when needed), add `AutoSwitchSettings` controls + per-account eligibility/priority UI inside `accountVaultStore`, `AccountVault`, `AccountSwitcherModal`, and `SubscriptionQuotaPopover` indicator, following `AGENTS.md` radius/height tokens. (Commit `7db337a`; Verified `S4 (Frontend): PASS, S5: PASS`)
- [x] **T5** (`S1`–`S6`, Risk: `none`, route: `inline`, ~240 lines): Add end-to-end Rust tests (`account_switcher::tests`, `chat`/`handoff`, `terminal`) and Vitest regression tests (`accountVaultStore`, `AccountVault`, `UnifiedAccountSync`, `NotificationsView`, `toast.action` confirm flow), and run full `cargo test`, `npx tsc --noEmit`, `npx vitest run`, and reference audit checks. (Verified `S1`–`S6`)

---

## Log

- **L1 (2026-11-14 — User Requests):**
  > "quiero que pensemos en una nueva funcionalidad relacionada con lo que estamos trabaando, tiene que ver con el cambio automatico de las cuentas al llegar a la cuota limite, claramente debe ser algo configurable es decir a decicion del usuario"
  > "cuando se llegue al limite 0%, una cosa importante, hay diferentes tipos de suscripciones y hay que considerar que tal vez no esten disponibles los modelos exactos al cambia"
  > "si el modelo es distinto pedir confirmacion, puede ser por una  notificacion con un boton o algo asi, quiero armar el odd"
- **L2 (2026-11-14 — Read-Only Codebase Audit & ODD Authoring):**
  - Inspected `src-tauri/src/account_switcher/{registry.rs,commands.rs}` (`SavedAccountProfile`, `get_alternative_accounts_with_quota`), `src-tauri/src/quota/antigravity/service.rs` (`QuotaWindow`, `planName`, `clientModelConfigs`), `src-tauri/src/chat/models/{catalog_agy_grok.rs,providers.rs}` (`query_agy_models_cli`, `validate_provider_model_with_catalog`), `src-tauri/src/chat/runtime/{spawn.rs,settle.rs}` (`detect_quota_exhaustion`, `continue_turn_with_handoff`, `thread["model"]`), `src-tauri/src/handoff.rs`, `src-tauri/src/notifications.rs`, `src/lib/toast.ts` (`toast.action`), `src/lib/quota/quotaManager.ts`, and `src/lib/accounts/accountVaultStore.ts`.
  - Authored `odd/tasks/account-quota-auto-switch.md` and mirrored to Engram (`odd/account-quota-auto-switch/tasks`). Awaiting user confirmation before implementing `T1`.
- **L3 (2026-11-14 — User Authorization & Residual Process Rule):**
  > "Y bueno. Continuando, me gustaría que desarrollaras todo el ODD como tal."
  - Authorized full implementation (`T1`–`T5`), coordinated with `T8` from `odd/tasks/antigravity-multi-account-reliability-and-ux.md` so both manual switches and auto-switch never force-kill open Antigravity IDE desktop windows (`base_app_open`), while surfacing clean residual-process cleanup when only background helper processes linger.
- **L4 (2026-11-15 — Full ODD Completion `T1`–`T5`):**
  - Completed `T1` (`8d83678`), `T2` (`211b736`), `T3` (`1c5eadf`), `T4` (`7db337a`), and `T5` (E2E evaluation -> confirm -> anti-bounce cooldown test, multi-thread confirmation store dedup, long-path wrapping fix in notifications CSS, dead-code test cfg polish, and full regression checks).
