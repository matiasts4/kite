# Antigravity Multi-Account Reliability, Scoped Terminal Orchestration & Vault UX Overhaul

Objective: Eliminate false-positive account switches, fix unscoped terminal restarts that disrupt non-Antigravity terminals, repair the broken guided login flow, and unify Kite Code's multi-account vault into a predictable, transparent, and intuitive system. Supersedes the unimplemented and diverged scopes of `odd/tasks/antigravity-account-management-overhaul.md` and `odd/tasks/account-vault-terminal-orchestration.md`.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `single-pr` on `feat/response-thread` (user-selected; isolated selective `git add` per work unit so unrelated `thread-timeline-surface` working-tree edits remain untouched).
Test runner: `cargo test account_switcher`, `cargo test quota::`, `cargo test terminal::`, `cargo test chat::`, `npx vitest run src/components/quota src/components/views/settings src/components/views/TerminalView`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.

---

## Specs

### S1 — Atomic, Token-Verified Credential Persistence & IDE Sync (`state.vscdb`)
Addresses user report: *"me decía que se cambió de cuenta, pero realmente no sucedió"* and broken/half-saved profiles.

1. **Strict OAuth Token Validation (`parse_antigravity_credential_blob`):**
   - **Current defect:** `src-tauri/src/quota/antigravity/credentials.rs:115-143` returns `Some(AntigravityCredentialIdentity)` whenever an `email` / `id_token_email` exists, even when both `access_token` and `refresh_token` are missing or empty.
   - **Requirement:** `parse_antigravity_credential_blob` MUST keep identity parsing helpers explicit, while a credential-validity predicate (and switch preflight) MUST verify that a non-empty `refresh_token` OR `access_token` is present (and valid JSON structure) before accepting a profile snapshot or activation.
   - **Acceptance check:** Unit test in `quota::antigravity_tests` confirming email-only/tokenless JSON is classified as invalid for switching (`missing_tokens`), while valid OAuth payloads pass.

2. **Fail-Closed Snapshot Creation (`snapshot_active_to_profile`):**
   - **Current defect:** `src-tauri/src/account_switcher/storage.rs:291-297` ignores `fs::write(..., gemini_antigravity_cred.json)` errors via `let _ = ...` and still returns `true` when only `.pbtxt` files copy. Combined with `probe_live_provider_identity("agy")` falling back to `state.vscdb` (`storage.rs:61-68`), `save_current_account_profile_direct` creates empty profiles that fail on every switch.
   - **Requirement:** `snapshot_active_to_profile("agy", ...)` MUST return `Result<bool, String>`, propagate filesystem errors, and fail when `gemini:antigravity` has no readable/valid credential blob (cannot silently produce a cred-less profile from `.pbtxt` files alone).
   - **Acceptance check:** Unit test attempting to snapshot when `gemini:antigravity` is absent even if `.pbtxt` exists returns explicit error without registering a broken profile.

3. **Antigravity IDE `state.vscdb` Auth Extract & Restore (`ide_auth_state.json`):**
   - **Current defect:** `get_provider_file_mappings("agy")` (`storage.rs:198-210`) maps only `~/.gemini/antigravity/antigravity_state.pbtxt` and `~/.gemini/antigravity-cli/jetski_state.pbtxt`, completely omitting `state.vscdb`. Consequently Language Server RPC fallback (`quota/antigravity/service.rs:199-275`) and `probe_live_provider_identity` fallback keep reading the old IDE account, producing CLI/IDE split-brain and reporting stale emails after a switch.
   - **Requirement:**
     - Maintain existing `antigravity_state.pbtxt` and `jetski_state.pbtxt` mappings.
     - On snapshot (`snapshot_active_to_profile`), extract ONLY auth keys (`antigravityAuthStatus`, `antigravityUnifiedStateSync.oauthToken`, `antigravityUnifiedStateSync.userStatus`, `antigravity.profileUrl`) from `state.vscdb` into `<profile_dir>/ide_auth_state.json` when the IDE email matches the captured credential email (never copy the whole binary SQLite file).
     - On switch (`apply_profile_to_active`), when `state.vscdb` exists and `ensure_provider_idle` confirms the Antigravity IDE is closed, restore those keys into `state.vscdb` inside a SQLite transaction if `ide_auth_state.json` exists, OR delete stale auth keys matching a *different* email so fallback readers never resurrect the previous account's identity.
   - **Acceptance check:** SQLite unit test verifying round-trip extraction and transactional restore of auth rows in a temp `state.vscdb` while preserving unrelated UI/extension rows, and verifying stale IDE auth keys are cleared when target profile lacks matching `ide_auth_state.json`.

4. **Diagnostic Win32 Credential Writes & Strict Post-Switch Verification:**
   - **Current defect:** `write_antigravity_credential` (`quota/antigravity/credentials.rs:152-199`) returns bare `bool` (swallowing `GetLastError()`, e.g., Win32 `CredWriteW` 2560-byte `CRED_MAX_CREDENTIAL_BLOB_SIZE` failures or permission errors), returns `false` silently on `#[cfg(not(windows))]`, and `apply_profile_to_active` (`storage.rs:547-576`) only verifies email rather than email + token match.
   - **Requirement:** Add `write_antigravity_credential_checked(&str) -> Result<(), String>` surfacing OS error code, byte size vs Win32 limit diagnostics if exceeded, and explicit non-Windows unsupported guidance. `apply_profile_to_active` + `switch_account_profile_direct` MUST NOT commit `is_active = true` or return `success: true` unless re-reading `gemini:antigravity` confirms target email AND non-empty token material, rolling back to the backed-up previous profile on failure.
   - **Acceptance check:** Unit test verifying rollback preserves prior active credential and does not flip `is_active` when post-write verification fails.

5. **Profile Credential Health & Persisted Deduplication (`registry.rs`):**
   - **Current defect:** `load_registry_from` (`registry.rs:124-156`) only saves `if repaired` (ignoring duplicate-email pruning on lines `131-152`), and `SavedAccountProfile` exposes no credential validity field to the UI.
   - **Requirement:** Persist deduplication changes whenever duplicates are removed, and add computed `credentialStatus: "valid" | "missing_tokens" | "missing_file" | "corrupt"` (plus `hasRefreshToken: boolean`) to serialized `SavedAccountProfile` items.

---

### S2 — Honest State Reconciliation, Cache Coherency & Auth Precedence
Addresses *"me decía que se cambió de cuenta, pero realmente no sucedió"* and stale/blocking reads.

1. **Consistent Live Reconciliation Across All Read Paths:**
   - **Current defect:** `get_active_account_profile_direct` (`commands.rs:453-494`) reads `get_cached_live_quota` instead of `probe_live_provider_identity` and reverts `profiles.json` to stale cached quota email. Meanwhile `list_saved_accounts_direct` (`commands.rs:57-104`) only updates `is_active` when live email is `Some(...)`, leaving stale `is_active = true` when signed out (`None`).
   - **Requirement:** Both `list_saved_accounts_direct` and `get_active_account_profile_direct` MUST reconcile against `probe_live_provider_identity` (with `gemini:antigravity` authoritative over `state.vscdb` for CLI state, returning split-brain metadata separately). When `probe_live_provider_identity` returns `None`, clear `is_active` across saved profiles for that provider (without deleting profiles).

2. **Eliminate Stale Quota Cache Races (Backend SWR & Frontend `QuotaManager`):**
   - **Current defects:**
     - `src-tauri/src/quota/service.rs:271-287`: an in-flight `!is_force` SWR worker thread writes pre-switch `fetch_single_provider` output back into `CACHE` after `switch_account_profile_direct` calls `invalidate_provider_cache`.
     - `src/lib/quota/quotaManager.ts:327-329`: `if (this.isFetching) return this.getAllQuotas();` silently drops `fetchAll(true)` if a background 90s or focus poll happens to be running during an account switch.
     - `quotaManager.ts:292`: `window.addEventListener('focus', ...)` is never removed in `stopPolling()`.
   - **Requirement:**
     - Track a monotonic `AtomicU64` invalidation epoch per provider in `quota/service.rs`; SWR background writers MUST skip inserting into `CACHE` and skip emitting `kite://subscription-quotas-updated` if the epoch changed while the fetch was running.
     - In `SubscriptionQuotaManager.fetchAll(forceRefresh)`, queue or await an in-flight fetch when `forceRefresh === true` and start a fresh forced fetch afterward (never return pre-switch cached data for an explicit post-switch refresh), and clean up the `focus` listener cleanly on `stopPolling()`.
     - Also clear per-account frontend `localStorage` entry / mark active Antigravity quota as `"refreshing"` immediately on switch until fresh identity-matched data returns.

3. **Non-Blocking Vault Opening & Connection Registry Accuracy:**
   - **Current defects:**
     - `list_saved_accounts_direct` (`commands.rs:44-46`) synchronously executes `fetch_live_quota` (`agy -p /usage`, up to 20s) on modal open whenever cache was invalidated.
     - `quota/antigravity/service.rs:270` calls `record_google_oauth_connection(google_connection_identity.as_ref())` instead of updating with `rpc_identity` if available.
     - `list_detected_cli_accounts_impl` (`commands.rs:573`) hardcodes `plan_name: Some("Google Cloud AI / Gemini")` for Antigravity, and omits standalone `gemini` CLI (`save_current_account_profile_direct("gemini", ...)` returns `"Proveedor no soportado: gemini"`).
     - Dead legacy `antigravity_list_google_accounts` and `antigravity_set_active_google_account` (`acp/accounts.rs:331-426`, `src/lib/ipc/accounts.ts:121-132`) remain wired to `~/.gemini/google_accounts.json`.
   - **Requirement:**
     - Keep `list_saved_accounts_direct` sub-50ms using OS identity probes + persisted profile/cache quota; expose explicit async per-provider/per-profile quota refresh without blocking modal open.
     - Fix `record_google_oauth_connection` (`service.rs:270`), remove hardcoded plan placeholder, align standalone `gemini` CLI detection/support boundaries cleanly (without conflating `antigravity` and `gemini`), and verify/remove unused `antigravity_*_google_account` legacy commands (confirming 0 active UI callers first).

4. **Resolve `GEMINI_API_KEY` vs Google OAuth Precedence Conflict:**
   - **Current defect:** `credentials.rs:362, 389-394` maps `"antigravity"` -> `["GEMINI_API_KEY"]` with fallback to the `"gemini"` API key vault entry, and `terminal/spawn.rs:246-253` injects `GEMINI_API_KEY` into `antigravity` terminals when absent from process env. Switching Google OAuth accounts leaves an injected `GEMINI_API_KEY` override active without user visibility.
   - **Requirement:** Isolate Antigravity OAuth account sessions from unrelated `gemini` API-key fallback unless the user explicitly configures an `antigravity` API-key override, and surface active auth mode (`Google OAuth (<email>)` vs `API Key override`) clearly in Antigravity Vault / Connection panel so users never switch OAuth accounts only to hit an unintended API key. `[Assumption: default multi-account vault users intend Google OAuth CLI auth for agy unless explicit antigravity API key mode is chosen.]`

---

### S3 — Provider-Scoped Terminal Orchestration (Never Restart Unrelated Terminals)
Addresses user requirement verbatim: *"si yo cambio de cuenta para cuentas de antigravity, o sea, para terminales antigravity, esas son las que deberían reiniciarse, no todas las terminales sin importar el proveedor."*

1. **Remove Global Frontend `restart-agent` Broadcast:**
   - **Current defect:** `AccountVault.tsx:97-101`, `AccountSwitcherModal.tsx:96-100`, and `SubscriptionQuotaPopover.tsx:100-104` dispatch `window.dispatchEvent(new CustomEvent('kite:terminal-command', { detail: { command: 'restart-agent' } }))` with no `provider` or `sessionId`. `TerminalView.tsx:198-226` matches `isGlobalAgentRefresh` on **every** mounted terminal pane regardless of engine (`powershell`, `claude-code`, `codex`, `opencode`, `grok`, `gemini`), calling `attach_terminal(..., columns: 80, rows: 24)` (`80x24` geometry clobbering) or respawning fresh processes — while also racing backend `respawn_provider_terminals`.
   - **Requirement:**
     - Account switch UIs MUST NOT broadcast unscoped `{ command: 'restart-agent' }`. Backend `switch_account_profile` owns `quiesce_provider_terminals` + `respawn_provider_terminals` exclusively for terminals matching `provider`, returning structured respawn telemetry (`terminalsRestarted`, `targetedSessionIds`, `skippedUnaffectedCount`).
     - Tighten `TerminalView.tsx`'s `kite:terminal-command` handler: `restart-agent` MUST accept optional `provider` / `targetProviders` / `targetSessionIds` filters and MUST NOT trigger global `isGlobalAgentRefresh` on `restart-agent` without an explicit target scope; any frontend fallback attach MUST preserve real terminal dimensions (never hardcode `columns: 80, rows: 24`).
   - **Acceptance check:** Vitest test mounting an Antigravity `TerminalView` + Claude/Codex/PowerShell `TerminalView`s, triggering account switch for Antigravity, asserting zero `attach_terminal` / `startSession` / resize calls occur on non-Antigravity terminals.

2. **Strict Ownership of Process Cleanup & Fail-Closed IDE Lock Check:**
   - **Current defects:**
     - `terminate_provider_cli_processes("agy")` (`storage.rs:353-378`) executes global `taskkill.exe /F /T /IM agy.exe /IM language_server_windows_x64.exe` (or `pkill -9 -f agy`), killing external user shells, active language servers, and concurrent quota probes.
     - `ensure_provider_idle` (`storage.rs:401-404`) returns `Ok(())` if process enumeration fails.
   - **Requirement:**
     - `ensure_provider_idle` MUST fail closed if process enumeration fails.
     - Account switching MUST quiesce ONLY Kite-owned PTYs matching `provider` (via `quiesce_provider_terminals`), NEVER blindly run `taskkill /IM agy.exe` or `pkill -f agy` system-wide across unrelated user terminals or processes; external blocking IDE processes (`antigravity.exe`) continue triggering structured `PROVIDER_BUSY` (with clear close/retry guidance) BEFORE touching or killing any Kite terminals (`ensure_provider_idle` MUST run before destructively killing terminals, or non-destructively inspect first!).

---

### S4 — Clean Post-Switch Session Continuity, Busy Protection & Chat Runtime Sync
Addresses *"hacer todo el sistema un poco más profesional e intuitivo"* and broken post-switch runtime behavior.

1. **Clean Re-spawn Arguments & Preserve Scrollback + Audit Divider:**
   - **Current defects:**
     - `switch_account_profile_direct` (`commands.rs:290-305`) kills Kite terminals *before* validating target profile readability/tokens or checking `ensure_provider_idle`.
     - `respawn_provider_terminals_local` (`terminal/quiesce.rs:257-316`) deletes historical scrollback (`delete_scrollback_file(&q.session_id)` at line 268), ignores `_new_account_label` (emits no divider), and spawns `SpawnMode::Resume { provider_session_id: q.provider_session_id }` -> passing Account A's `--conversation <id>` to Account B's `agy` process!
     - Killing PTY emits `terminal-exited` / `terminal://activity` (`exited: true`), causing `useTerminalSnapshotPoller.ts:492-496` + `TerminalView.tsx:375-383` to latch `status = 'exited'` overlay even while backend respawns under the same `sessionId`.
   - **Requirement:**
     - Validate target profile & run `inspect_provider_sessions` + external lock preflight BEFORE quiescing any terminal.
     - When `quiesce_provider_terminals_local` stops a terminal for account rotation: drain output (`50ms`), send `\x03` (Ctrl+C) and allow up to `600ms` graceful exit before hard termination; tag internal shutdown so UI does not latch permanent `'exited'` banner during planned rotation.
     - In `respawn_provider_terminals_local`: NEVER delete scrollback history on rotation; write historical scrollback + clear audit divider line (`\r\n─── ✦ Kite Vault: Sesión reactivada con cuenta «{label}» ───\r\n`) into scrollback/PTY; launch Antigravity cleanly (`SpawnMode::Agent` with no cross-account `--conversation <old_id>`) and emit `terminal://account-rotated` `{ sessionId, provider, accountLabel, email }` so frontend updates UI state to `running` without needing `attach_terminal` hack.

2. **Busy Terminal Protection (`inspect_provider_sessions`) & Priority/Lazy Respawn:**
   - **Current defect:** Active terminals currently streaming agent output are killed without warning, and background workspaces respawn eagerly.
   - **Requirement:** Expose `inspect_provider_sessions(provider)` returning `{ managedIdle, managedBusy, externalBlocking, unaffectedTerminalsCount }`. If `managedBusy.length > 0` and caller hasn't confirmed force-interrupt (`force: true`), `switch_account_profile` returns `CONFIRM_BUSY_TERMINALS` with details so the UI presents a clean confirmation modal (`Esperar`, `Cancelar`, `Interrumpir y cambiar ahora`). Respawn active/focused pane immediately (`Priority 0`), leaving unfocused workspaces lazy on focus (`Priority 1/2`) while displaying a clear respawn divider when focused.

3. **Persistent Chat Transport Eviction & Model Cache Invalidation:**
   - **Current defects:** `switch_account_profile_direct` never clears `SessionManager` (`src-tauri/src/chat/session.rs`, `chat/runtime/state.rs`) warm `AntigravitySession` child processes or per-account `chat::models::model_cache()`, and `continue_turn_with_handoff` (`chat/runtime/settle.rs:399`) sets `thread["provider"] = "agy"` instead of canonical `"antigravity"`.
   - **Requirement:** Reap/evict idle/warm `antigravity` persistent sessions in `SessionManager` (so next turn spawns under the newly active account), invalidate Antigravity model cache entries cleanly, and normalize `"agy"` -> `"antigravity"` in `continue_turn_with_handoff`.

---

### S5 — Working `+ Conectar nueva cuenta` Guided Login Flow
Addresses broken account addition flow and false detection banners.

1. **Real Scoped Login Terminal Launcher (Retire Dead `launch-cli`):**
   - **Current defect:** `AccountVault.tsx:152` and `AccountSwitcherModal.tsx:155` dispatch `{ command: 'launch-cli', provider }`, which has **0 listeners** in `src/`. Meanwhile `prepare_new_account_login_direct` (`commands.rs:853-894`) prematurely kills `agy` terminals, deletes `gemini:antigravity` while leaving `state.vscdb` untouched, and does blind `taskkill /IM`.
   - **Requirement:**
     - Provide a real Tauri/workspace flow (`start_account_login_flow` / workspace event handled cleanly in `useWorkspaceEventListeners.ts`) that:
       1. Saves current live session to Vault if unregistered/valid (failing clearly or warning if unsaved).
       2. Snapshots temporary rollback backup of current `gemini:antigravity` + `ide_auth_state.json` + `.pbtxt` state BEFORE clearing auth state so cancelling restores the user's previous working session seamlessly.
       3. Clears BOTH CLI (`gemini:antigravity` + auth `.pbtxt` identity if any) and IDE (`state.vscdb` auth rows when idle) only for clean login state (without calling blind `taskkill /IM`!).
       4. Opens and focuses a dedicated Antigravity login terminal executing interactive Google login (`agy acp --login` when supported by installed `agy` binary — verified in CLI help: `--login   Log in with Google interactively, then exit (ACP terminal auth)` — with fallback to `agy`).
   - **Acceptance check:** UI + backend test confirming clicking `+ Conectar nueva cuenta` opens/targets an interactive login terminal (never emits a dead unhandled event) and cancelling restores prior credentials on rollback.

2. **Truthful Detection Polling & Lifecycle Cleanup:**
   - **Current defect:** Frontend polls `listSavedAccountsFull` every `2500ms` (max 60s), triggers heavy `/usage` spawns on every tick, fails to clean up `setInterval` when closing modal/tab, falsely triggers on untouched `state.vscdb`, and reports `'¡Nueva cuenta detectada y guardada en la bóveda!'` (`AccountVault.tsx:163`, `520`) without even saving.
   - **Requirement:**
     - Poll lightweight `probe_live_account_login_status(provider, previousEmail)` (OS credential probe only, ZERO `/usage` spawn per poll) for up to `120s` with clean `AbortController` / `useEffect` unmount/close cleanup and a visible `"Cancelar y restaurar"` action.
     - Recognize login completion ONLY when `gemini:antigravity` contains valid non-empty tokens (`credentialStatus == "valid"`).
     - Automatically call `saveCurrentAccountProfile` with the new email/default label upon verified token detection, refresh quotas & CLI accounts once cleanly, and ONLY THEN show saved confirmation. Handle "logged back into same account" distinctly from "new account saved".

---

### S6 — Unified, Professional & Intuitive Multi-Account UI/UX
Addresses *"hacer todo el sistema un poco más profesional e intuitivo"* across all fragmented surfaces.

1. **Single Source of Truth Across Surfaces & Dead-Code Cleanup:**
   - **Current defect:** Account controls are fragmented across `AccountVault`, `AccountSwitcherModal`, `SubscriptionQuotaPopover` + `QuotaPopoverContent` + `QuotaAccountSwitcher`, `QuotasTab`, `AccountTab`, and unused dead modal `QuotaSettingsModal.tsx` (only referenced in tests). Fixes only hit subsets, leaving `QuotasTab` `"Cuenta detectada"` (`QuotasTab.tsx:606`) stale and `QuotaPopoverContent.tsx:270` diverging from its tooltip.
   - **Requirement:**
     - Create a shared frontend controller/store (`useAccountVault` + global `kite:accounts-changed` bus) consumed by `AccountVault`, `AccountSwitcherModal`, `SubscriptionQuotaPopover`, `QuotasTab`, and `AccountTab`.
     - Switching, saving, renaming, or deleting in ANY surface updates every other mounted surface + forces quota refresh + refreshes `cliAccounts` in `QuotasTab` + keeps `QuotaPopoverContent.tsx:270` consistent with active OS/vault identity.
     - Retire dead `QuotaSettingsModal.tsx` UI component (move `PROVIDER_CONFIGS_ES` metadata cleanly into `src/config/quotaProviderMetadata.ts` or dedicated config module, updating test imports).

2. **Essential Account Lifecycle & Transparency Features:**
   - **No optimistic lie:** Show inline `"Cambiando y verificando..."` spinner on the target account row; flip `Activa` badge and toast ONLY after backend verification succeeds; on failure (`PROVIDER_BUSY`, invalid tokens, OS error), show actionable inline alert explaining *why* and offering retry/re-auth.
   - **Guard accidental overwrite on "Guardar sesión actual":** When current live email already exists in Vault with a different label, do NOT silently rename it; show `"Esta cuenta ya está guardada como «X»"` with explicit `"Actualizar credenciales"` vs `"Renombrar perfil"` actions (plus inline edit/rename button on every profile card).
   - **One-click save from Popover (`QuotaAccountSwitcher.tsx:117-131`):** Save unregistered active session directly in 1 click (or inline prompt) instead of opening Settings and losing context. Also load `savedAccounts` proactively when popover opens (or on active state change) rather than waiting for dropdown expand, and ensure dropdown container has `position: relative`.
   - **Health, Split-Brain & Token Status Indicators:** Display clear pills per profile (`Lista`, `Sin token / Reautenticar`, `IDE desincronizada` when `splitBrainWarning == true` with 1-click align/re-auth), per-profile quota refresh action, and accurate instructions in `AccountVault.tsx:351-361` matching the real guided flow.
   - **Custom Confirmation Dialog & Design Tokens:** Replace native `window.confirm` on delete (`AccountVault.tsx:181`) and add busy-terminal switch consent dialog (`S4`) using Kite's visual system (`var(--dialog-radius)` 14px, `var(--card-radius)` 12px, `var(--control-radius)` 8px, `32px` standard / `28px` compact control height; do NOT touch `TitleBar.tsx`). Fix `"Terminar sesión"` vs delete clarity.
   - **Terminal Pane Account Attribution (`CodePaneHeader.tsx`):** Show a subtle interactive `[✦ <Label/Email>]` pill on `antigravity` panes (clickable to open quick switcher) so users always know *which* account owns an active terminal.

---

### S7 — End-to-End Test & Regression Verification
- Add non-mocked backend tests in `account_switcher/tests.rs` (using temp directories + trait/test-hook credential store) for `save_current_account_profile_direct`, `switch_account_profile_direct` (valid, tokenless failure + rollback, email-dedup, busy guard), `prepare_new_account_login_direct` + rollback, and `terminal/quiesce.rs` (`quiesce_provider_terminals_local`, `respawn_provider_terminals_local` preserving non-target engines, preserving scrollback, emitting audit divider, omitting old `--conversation` ID).
- Add frontend Vitest suites verifying: (1) switching Antigravity never calls `attach_terminal` / `startSession` on `claude-code`, `codex`, `powershell`, or `gemini` `TerminalView` instances; (2) `SubscriptionQuotaManager.fetchAll(true)` never gets swallowed by an in-flight background `isFetching` poll; (3) guided login polling stops/cleans interval on unmount and restores on cancel; (4) `QuotasTab` & `QuotaPopoverContent` immediately reflect switched account identity.
- Gate every slice with `cargo test`, `npx tsc --noEmit`, `npx vitest run`, and `node .kite/sanitizer/audit-references.mjs --check`.

---

## Tasks

- [x] **T1** (`S1`, Risk: `item 1 — credential persistence & state.vscdb auth sync`, route: `inline`, ~220 lines): Harden `parse_antigravity_credential_blob` token validation, fail-closed `snapshot_active_to_profile`, Win32 error-reporting `write_antigravity_credential_checked`, post-switch identity+token verification + rollback, transactional `ide_auth_state.json` <-> `state.vscdb` sync, persisted email-dedup repair, and `credentialStatus` field on `SavedAccountProfile`.
- [x] **T2** (`S2`, Risk: `item 3, item 4 — shared quota cache, env injection, & account IPC contracts`, route: `inline`, ~210 lines): Reconcile `get_active_account_profile_direct` + empty-session reset cleanly, add `cache_epoch` against SWR stale overwrites, remove synchronous 20s `/usage` stall from `list_saved_accounts_direct`, fix `SubscriptionQuotaManager.fetchAll(true)` force-refresh drop & `stopPolling` listener leak, isolate `GEMINI_API_KEY` env injection from Antigravity OAuth switching, fix `record_google_oauth_connection`, and retire dead `antigravity_*_google_account` legacy IPCs.
- [ ] **T3** (`S3`, Risk: `item 3 — terminal command bus & OS process cleanup`, route: `inline`, ~160 lines): Eliminate unscoped `kite:terminal-command` `{ command: 'restart-agent' }` broadcasts across `AccountVault`, `AccountSwitcherModal`, and `SubscriptionQuotaPopover`; enforce explicit target scope & real geometry preservation in `TerminalView.tsx`; fail-closed `ensure_provider_idle`; replace blind global `taskkill /IM` / `pkill -9` with Kite-owned PTY shutdown.
- [ ] **T4** (`S4`, Risk: `item 4 — async PTY quiesce/respawn, busy guard & persistent chat eviction`, route: `delegated`, ~320 lines): Add `inspect_provider_sessions`, pre-switch idle/lock check ordering, graceful `\x03` 600ms drain, scrollback preservation + `✦ Kite Vault` audit divider, clean `SpawnMode::Agent` respawn (no old `--conversation` reuse), priority/lazy respawn + `terminal://account-rotated` frontend state sync, warm `SessionManager` / `model_cache()` eviction, and canonical `"antigravity"` normalization in `settle.rs`.
- [ ] **T5** (`S5`, Risk: `item 4 — guided CLI login lifecycle & credential rollback`, route: `delegated`, ~220 lines): Replace dead `launch-cli` broadcast with scoped workspace login terminal launcher (`agy acp --login` / `agy`), backup+rollback snapshot on cancel/failure, 120s lightweight identity-only poller (`probe_live_account_login_status`) checking valid tokens + auto-saving new account, truthful notices, and unmount interval cleanup.
- [ ] **T6** (`S6`, Risk: `item 3 — multi-account UI/UX unification`, route: `delegated`, ~350 lines): Build shared `useAccountVault` store + `kite:accounts-changed` sync across Vault/Modal/Popover/QuotasTab/AccountTab; non-optimistic verified switch feedback; rename profile inline + save overwrite guard; 1-click Popover save + proactive load; `credentialStatus` & `splitBrainWarning` badges; custom busy-terminal & delete confirmation modals (`--dialog-radius`); updated help guide; `[✦ <Account>]` pill in `CodePaneHeader.tsx`; retire dead `QuotaSettingsModal.tsx`.
- [ ] **T7** (`S1`–`S7`, Risk: `none`, route: `inline`, ~240 lines): Add comprehensive Rust integration tests (`account_switcher::tests`, `terminal::quiesce`) and Vitest regression tests (`TerminalView` provider isolation, `quotaManager` force-refresh concurrency, guided login lifecycle, unified Vault/Popover sync), plus run full `cargo test`, `npx tsc --noEmit`, `npx vitest run`, and reference sanitizer check.

---

## Log

- **L1 (2026-11-12 — User Request):**
  > "Quiero que revisemos completamente las funcionalidades de configuración de múltiples cuentas para antigravity. Básicamente, la idea sería corregir esto claramente porque en momentos anteriores me dio errores. Errores con respecto a, por ejemplo, que me decía que se cambió de cuenta, pero realmente no sucedió. También algunas cosas están tanto mal en cuanto a lógica. Por ejemplo, si yo cambio de cuenta para cuentas de antigravity, o sea, para terminales antigravity, esas son las que deberían reiniciarse, no todas las terminales sin importar el proveedor. Por ejemplo, ahora mismo se reinician incluso terminales de Entonces, la idea sería buscar puntos de mejora, corrección, mala lógica y, claro, hacer todo el sistema un poco más profesional e intuitivo.  puedes armar un odd para esto"
- **L2 (2026-11-12 — Deep Read-Only Codebase Audit & ODD Authoring):**
  - Completed full-stack read-only audit of `src-tauri/src/account_switcher/`, `quota/antigravity/`, `quota/service.rs`, `terminal/quiesce.rs`, `terminal/commands.rs`, `terminal/spawn.rs`, `chat/session.rs`, `chat/runtime/`, `connections.rs`, `credentials.rs`, and `src/components/{quota/*,views/settings/*,views/TerminalView.tsx,code/CodePaneHeader.tsx}`, `src/lib/quota/*`.
  - Root-cause findings verified across credential storage/IDE `state.vscdb` exclusion, tokenless validation bypass, global unscoped `restart-agent` broadcasts + `80x24` `attach_terminal` clobbering, dead `launch-cli` command, SWR/frontend polling race drops, `--conversation` cross-account leak, un-evicted persistent chat transports, `GEMINI_API_KEY` cross-fallback, and fragmented 5-surface UI state.
  - Created `odd/tasks/antigravity-multi-account-reliability-and-ux.md` and mirrored to Engram (`odd/antigravity-multi-account-reliability-and-ux/tasks`). Awaiting user review before implementation (`T1`).
- **L3 (2026-11-12 — `T1` (`S1`) Completed & Independently Verified):**
  - Executed `RED -> GREEN` across `credentials.rs`, `registry.rs`, `storage.rs`, and `commands.rs`: token-required OAuth validation (`parse_antigravity_credential_with_tokens`), fail-closed `snapshot_active_to_profile`, Win32 diagnostic `write_antigravity_credential_checked` (`2560`-byte limit), transactional `ide_auth_state.json` <-> `state.vscdb` sync/cleanup, post-write token+identity readback with full rollback, persisted email deduplication, and `credentialStatus` / `hasRefreshToken` health hydration.
  - Verified (`quota::antigravity`: 9/9 passed, `account_switcher`: 11/11 passed), independent verifier `e7af5226` reported ALL PASS across `S1.1`–`S1.5`, and reference audit clean.
- **L4 (2026-11-12 — `T2` (`S2`) Completed & Independently Verified):**
  - Reconciled `list_saved_accounts_direct` & `get_active_account_profile_direct` via `reconcile_live_identity_with_registry` (clearing stale `is_active` on sign-out and eliminating the synchronous `/usage` stall from `list_saved_accounts_direct` & `save_current_account_profile_direct`), added `build_antigravity_auth_telemetry`, removed hardcoded Antigravity plan in `list_detected_cli_accounts_impl`, and added standalone `gemini` CLI discovery/mappings distinct from `agy`.
  - Added `cache_epoch` invalidation guards to `QuotaCache` SWR commits & event emits in `quota/service.rs`, fixed `record_google_oauth_connection` to record `rpc_identity` when email exists, isolated `GEMINI_API_KEY` / `"gemini"` fallback from `antigravity` in `credentials.rs` & `terminal/spawn.rs`, retired dead `antigravity_*_google_account` IPCs, and fixed `SubscriptionQuotaManager.fetchAll(true)` queueing, `invalidateAndMarkRefreshing`, and `stopPolling()` focus listener cleanup.
  - Verified (`account_switcher`: 13/13, `quota::`: 31/31, `credentials::tests`: 4/4, `acp::tests`: 5/5, `terminal::`: 28/28, `vitest src/lib/quota`: 18/18, `tsc --noEmit`: 0 errors, sanitizer clean), and independent verifier `2d10752a` reported ALL PASS across `S2.1`–`S2.5`.
