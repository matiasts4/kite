# Antigravity Account Detection, Registration, and Vault Switching Overhaul

Objective: Eliminate active-account misdetection, cross-provider identity contamination, silent profile overwrites during registration and switching, and incomplete credential restoration for Antigravity (`agy` / `antigravity`) across all Kite surfaces.
Branch: `fix/antigravity-account-management-overhaul`. Do not commit on `main`.
Delivery: `ask-on-risk`; slices below are the review boundaries. Test runners: `npx vitest run` (`npm test`) for frontend and `cargo test` in `src-tauri` for Rust.
Workers: Delegated subagents or engineers execute tasks against this specification.

---

## Product Decision

Antigravity account management in Kite must operate on **verifiable, single-source-of-truth credentials** rather than heuristic file fallbacks or cached quota metadata:

1. **Authoritative Antigravity Credential Parsing (`gemini:antigravity`):**
   - Antigravity CLI (`agy`) stores its live OAuth session in Windows Credential Manager under the generic credential target `gemini:antigravity`.
   - Depending on whether the session was freshly created or refreshed via OAuth token rotation, the JSON payload in `gemini:antigravity` stores the user's email either inside an `id_token` JWT (`id_token` / `token.id_token`) **or** directly in the top-level field `"id_token_email": "<email>"` (with `"id_token"` omitted).
   - Kite must parse `id_token_email`, `id_token` JWT claims, `token.id_token` JWT claims, and `email` from `gemini:antigravity` as the primary, authoritative identity of the `agy` CLI runtime.

2. **Strict Separation Between Antigravity (`agy`) and Standalone Gemini CLI (`gemini`):**
   - `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json` belong to the standalone `@google/gemini-cli` (`gemini`) tool. `agy` never reads or writes those files.
   - Antigravity identity detection (`enrich_google_identity`, `list_detected_cli_accounts`, `antigravity_list_google_accounts`, and `sessionDetection.ts`) must **never** read `~/.gemini/oauth_creds.json` or `~/.gemini/google_accounts.json` to attribute an email to `antigravity` / `agy`.
   - `get_provider_file_mappings("agy")` must not snapshot or overwrite `~/.gemini/oauth_creds.json`, `~/.gemini/google_accounts.json`, `~/.gemini/antigravity-cli/settings.json` (user CLI preferences and `trustedWorkspaces`), or `%APPDATA%\Antigravity\User\globalStorage\storage.json` (window layout).

3. **Zero-Cache Live Identity Probing (`read_live_provider_identity`):**
   - Account Vault operations (`list_saved_accounts`, `save_current_account_profile_direct`, `switch_account_profile_direct`, `get_active_account_profile`) must never trust `get_cached_live_quota` to determine which account is currently active in the OS.
   - Reading the active OS identity from Windows Credential Manager (`gemini:antigravity`) or provider auth files takes `<1ms` and must run synchronously on every vault read, save, and switch.
   - Whenever the live OS identity email differs from the email stored in `quota_cache.json`, the provider's quota cache entry is immediately invalidated so stale quota metadata can never masquerade as the active account.

4. **Safe Account Registration & Pre-Switch Snapshot Integrity:**
   - Saving the current session (`save_current_account_profile_direct`) must resolve the email directly from the live OS credential (`gemini:antigravity`). If the live credential belongs to an email not yet in `profiles.json`, it must always create a **new** profile rather than matching a stale cached email and overwriting an existing profile.
   - Before switching from Profile A to Profile B (`switch_account_profile_direct`), Kite must verify that the live OS credential email actually matches Profile A's email before refreshing Profile A's snapshot. If the live OS credential belongs to a different account (e.g., an external login), Kite must **never** overwrite Profile A's vault directory with that external session.

5. **Self-Healing Vault & Guided New-Account Onboarding:**
   - On registry load, Kite inspects `gemini_antigravity_cred.json` inside each `agy` profile directory and repairs any profile whose `profiles.json` metadata (`email` / auto-generated `label`) drifted from the actual credential stored inside its snapshot.
   - Kite provides a first-class **"Conectar nueva cuenta"** flow that safely snapshots the current active session, clears the active `gemini:antigravity` keyring entry (`CredDeleteW`), and launches an interactive `agy` login session so the user can authenticate a new Google account without manual credential management.

---

## Terms

- **Authoritative CLI Credential (`gemini:antigravity`):** The Windows Credential Manager generic blob read and written by `agy`. Its JSON schema is:
  ```json
  {
    "token": {
      "access_token": "...",
      "token_type": "Bearer",
      "refresh_token": "...",
      "expiry": "2026-10-30T19:13:14.8340187-03:00",
      "expires_in": 3599
    },
    "auth_method": "consumer",
    "id_token": "<optional JWT>",
    "id_token_email": "<email persisted by agy after token refresh>"
  }
  ```
- **IDE Auth State (`state.vscdb`):** The SQLite database at `%APPDATA%\Antigravity\User\globalStorage\state.vscdb` where Antigravity IDE stores `ItemTable` keys `antigravityAuthStatus`, `antigravityUnifiedStateSync.oauthToken`, `antigravityUnifiedStateSync.userStatus`, and `antigravity.profileUrl`.
- **Standalone Gemini CLI Files:** `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json`. Owned exclusively by `gemini` CLI; unrelated to `agy`.
- **Profile Drift / Clobbering:** A corruption state where `profiles.json` lists Email X for a profile ID, but `gemini_antigravity_cred.json` inside that profile's directory contains the token for Email Y.

---

## Current-State Root-Cause Audit

### RC1. `read_antigravity_credential()` ignores `id_token_email` (`src-tauri/src/quota/antigravity.rs:266-290`)
- `read_antigravity_credential()` only inspects `val.get("id_token")` and `val.pointer("/token/id_token")`.
- When `agy` refreshes an OAuth token or saves a consumer session in current CLI builds, it writes `"id_token_email": "<email>"` and omits `"id_token"`.
- As a result, `read_antigravity_credential()` returns `None` even when `gemini:antigravity` is present and valid in Windows Credential Manager.

### RC2. Fallback Contamination from `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json` (`src-tauri/src/quota/antigravity.rs:392-435`, `src-tauri/src/account_switcher.rs:1252-1300`)
- When `read_antigravity_credential()` returns `None`, `enrich_google_identity()` falls back to reading `~/.gemini/oauth_creds.json` (lines 393–418) and `~/.gemini/google_accounts.json` (lines 420–434) before checking `read_antigravity_ide_identity()`.
- Worse, `list_detected_cli_accounts()` (`src-tauri/src/account_switcher.rs:1252-1300`) **never** calls `read_antigravity_credential()` at all; it exclusively reads `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json`.
- If the user ever logged into `@google/gemini-cli` (`gemini`) with `Account A` (`~/.gemini/oauth_creds.json`), Kite permanently reports `Account A` as the active Antigravity account even when `agy` is actively signed into `Account B` in `gemini:antigravity`.

### RC3. `get_cached_live_quota` Masking Live OS Identity Changes (`src-tauri/src/account_switcher.rs:716-733, 791, 883, 1157` & `src-tauri/src/quota/service.rs:76-85`)
- `get_cached_provider_status()` in `src-tauri/src/quota/service.rs` returns the in-memory or disk-persisted `quota_cache.json` entry without checking `CACHE_TTL_SECS`.
- `list_saved_accounts`, `save_current_account_profile_direct`, and `get_active_account_profile` all call `get_cached_live_quota(&provider).or_else(|| fetch_live_quota(&provider))`.
- Because `get_cached_live_quota` always returns `Some(...)` once `quota_cache.json` exists, `list_saved_accounts` and `save_current_account_profile_direct` read stale cached emails instead of probing the current OS credential.

### RC4. New Account Registration Overwrites Existing Profiles (`src-tauri/src/account_switcher.rs:882-965`)
- When the user authenticates a new Antigravity account (`Account B`) and clicks **"Guardar sesión"**, `save_current_account_profile_direct` resolves the wrong email (`Account A`) due to RC1, RC2, and RC3.
- The upsert check (lines 895–900) matches `Account A`'s existing profile in `profiles.json` and overwrites `Account A`'s directory (`snapshot_active_to_profile`) with `Account B`'s `gemini_antigravity_cred.json` while keeping `Account A`'s email in `profiles.json`.
- Consequently, the new account is never added as a separate row, and the previously saved profile is silently corrupted.

### RC5. Pre-Switch Snapshot Clobbers Stale `is_active` Profile (`src-tauri/src/account_switcher.rs:1027-1039`)
- During `switch_account_profile_direct`, lines 1028–1039 find the profile marked `is_active == true` in `profiles.json` and unconditionally execute `snapshot_active_to_profile(&provider, &active_prof.id)` before switching.
- If the live OS credential was changed externally (or if `is_active` was out of sync), `snapshot_active_to_profile` overwrites `active_prof`'s saved credentials with the wrong account's live session.

### RC6. Harmful File Mappings & Non-Transactional Keyring Restore (`src-tauri/src/account_switcher.rs:345-374, 610-702`)
- `get_provider_file_mappings("agy")` copies `settings.json` (`trustedWorkspaces`, `model`), `storage.json`, `google_accounts.json`, `oauth_creds.json`, and the entire 40MB+ `state.vscdb`.
- Meanwhile, `gemini_antigravity_cred.json` (the actual `agy` credential) is **not** backed up into `_backups/agy/<timestamp>/`, is **not** checked by `apply_profile_to_active` when validating whether a profile has session files, and its `write_antigravity_credential` return value is ignored.

### RC7. Frontend Session Detection & Modal Gaps (`src/lib/quota/sessionDetection.ts`, `src/components/quota/AccountSwitcherModal.tsx`, `src/components/quota/SubscriptionQuotaPopover.tsx`, `src/components/views/settings/AccountTab.tsx`)
- `resolveProviderDetectedSession` (`src/lib/quota/sessionDetection.ts:49-61`) returns early for `terminal_agent` without populating `email`, `accountLabel`, or `planName`, and conflates `gemini` with `antigravity` on line 69.
- `AccountSwitcherModal.tsx` and `SubscriptionQuotaPopover.tsx` call `listSavedAccounts()` instead of `listSavedAccountsFull()`, discarding `unregisteredLiveSession` so users opening the modal cannot see or one-click save an unregistered active session.
- `AccountTab.tsx` (lines 229–246) renders a `Cuenta de Google` selector wired to `antigravity_set_active_google_account` (`src-tauri/src/acp.rs:1311`), which only mutates `"active"` in `~/.gemini/google_accounts.json` without changing any Antigravity credential.
- `connectionMethods.ts` (line 32) instructs users to run `agy auth login`, a subcommand that does not exist in `agy.exe`.

---

## Specifications

### S1. Authoritative Antigravity Credential Reader & Writer (`src-tauri/src/quota/antigravity.rs`)

1. **Structured Credential Identity (`AntigravityCredentialIdentity`):**
   - Define:
     ```rust
     #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
     #[serde(rename_all = "camelCase")]
     pub struct AntigravityCredentialIdentity {
         pub email: String,
         pub name: Option<String>,
         pub auth_method: Option<String>,
         pub has_refresh_token: bool,
         pub expiry: Option<String>,
         pub source: String, // "gemini:antigravity" | "state.vscdb"
     }
     ```
2. **Parsing `gemini:antigravity` JSON (`parse_antigravity_credential_blob(raw: &str) -> Option<AntigravityCredentialIdentity>`):**
   - **WHEN** `raw` is valid JSON:
     1. Extract `id_token` from `val.get("id_token")` or `val.pointer("/token/id_token")`. If present and decodable as a JWT, extract `email` and `name` from its payload claims.
     2. If `email` is still `None`, extract `val.get("id_token_email").and_then(|v| v.as_str())`, or `val.pointer("/token/id_token_email")`, or `val.get("email")`.
     3. Verify that `val.pointer("/token/refresh_token")` or `val.pointer("/token/access_token")` or `val.get("refresh_token")` or `val.get("access_token")` is non-empty.
     4. Return `Some(AntigravityCredentialIdentity { email, name, auth_method, has_refresh_token, expiry, source: "gemini:antigravity".into() })`.
   - `read_antigravity_credential()` must delegate to `read_antigravity_raw_credential().and_then(|raw| parse_antigravity_credential_blob(&raw))` and return `Option<(String, Option<String>)>`.
3. **Deleting Active Credential (`delete_antigravity_credential() -> bool`):**
   - On Windows, invoke `CredDeleteW` (`advapi32.dll`) for target `"gemini:antigravity"` with `CRED_TYPE_GENERIC (1)`. Return `true` if deleted or already absent (`ERROR_NOT_FOUND`).

### S2. De-Contaminating Antigravity Identity Resolution (`src-tauri/src/quota/antigravity.rs`, `src-tauri/src/ quota/gemini.rs`)

1. **Dedicated `enrich_antigravity_identity(status: &mut ProviderQuotaStatus)`:**
   - **Precedence for Antigravity (`provider_id == "antigravity"`):**
     1. `read_antigravity_credential()` (Windows Credential Manager `gemini:antigravity`). Sets `metadata["accountSource"] = "gemini:antigravity"`.
     2. `read_antigravity_ide_identity()` (`%APPDATA%\Antigravity\User\globalStorage\state.vscdb` -> `antigravityAuthStatus`). Sets `metadata["accountSource"] = "Antigravity IDE"`.
     3. **IF AND ONLY IF** both `gemini:antigravity` and `state.vscdb` are present and report **different** emails (`cli_email != ide_email`), populate:
        - `status.metadata["email"] = json!(cli_email)` (since `agy` CLI uses `gemini:antigravity`)
        - `status.metadata["ideEmail"] = json!(ide_email)`
        - `status.metadata["splitBrainWarning"] = json!(true)`
   - **Prohibition:** `enrich_antigravity_identity` MUST NOT read `~/.gemini/oauth_creds.json` or `~/.gemini/google_accounts.json`.
2. **Separate `enrich_gemini_cli_identity(status: &mut ProviderQuotaStatus)` for `gemini` (`src-tauri/src/quota/gemini.rs`):**
   - Standalone Gemini CLI (`provider_id == "gemini"`) reads `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json` exclusively.
   - Remove `sync_google_siblings` in `src-tauri/src/account_switcher.rs` so switching an Antigravity (`agy`) profile never mutates `gemini` profile active flags or vice versa.

### S3. Direct Live OS Identity Probe & Cache Invalidation (`src-tauri/src/account_switcher.rs`, `src-tauri/src/quota/service.rs`)

1. **Direct Fast Identity Probe (`probe_live_provider_identity(provider: &str) -> Option<LiveIdentityProbe>`):**
   - Define a synchronous, `<5ms` local probe function in `src-tauri/src/account_switcher.rs` that reads the OS credential store directly without spawning CLI subprocesses or reading `quota_cache.json`:
     - For `"agy"`: calls `read_antigravity_credential()` first; if `None`, falls back to `read_antigravity_ide_identity()`.
     - For `"codex"`: reads `~/.codex/auth.json` JWT claims.
     - For `"claude"`: reads `~/.claude.json` (`oauthAccount.emailAddress`) and `~/.claude/.credentials.json`.
     - For `"grok"`: reads `~/.grok/auth.json`.
2. **TTL Enforcement & Identity Consistency in `get_cached_live_quota` (`src-tauri/src/account_switcher.rs`, `src-tauri/src/quota/service.rs`):**
   - In `src-tauri/src/quota/service.rs`, `load_persisted_cache()` must compute the age of each entry from `status.last_updated_ms` compared to `now_ms()` rather than stamping `Instant::now()` unconditionally on startup.
   - In `src-tauri/src/account_switcher.rs`, `resolve_live_account_state(provider: &str)`:
     1. Calls `probe_live_provider_identity(provider)` to obtain the authoritative `live_email`.
     2. Checks `get_cached_live_quota(provider)`.
     3. **WHEN** `cached_quota.email` differs from `live_email` (case-insensitive):
        - Immediately call `crate::quota::invalidate_provider_cache(quota_key)` so the stale cached quota is discarded.
        - Trigger `fetch_live_quota(provider)` (or return `live_email` immediately with fresh quota metrics).
3. **`list_detected_cli_accounts()` Fix (`src-tauri/src/account_switcher.rs:1252-1300`):**
   - For `"antigravity"`, `list_detected_cli_accounts()` must call `read_antigravity_credential()` first and `read_antigravity_ide_identity()` second.
   - It must **never** read `~/.gemini/oauth_creds.json` or `~/.gemini/google_accounts.json` for `"antigravity"`.
   - `config_path` and `details` must accurately reflect `"Windows Credential Manager (gemini:antigravity)"` or `"Antigravity IDE (state.vscdb)"`.

### S4. Safe Profile Registration (`save_current_account_profile_direct`) & Pre-Switch Snapshot Guard (`src-tauri/src/account_switcher.rs`)

1. **Authoritative Email Resolution on Save (`save_current_account_profile_direct`):**
   - **WHEN** `save_current_account_profile_direct(provider, label)` is invoked for `"agy"`:
     1. Obtain `live_identity = probe_live_provider_identity("agy")`.
     2. If `live_identity` is `None`, return `{ "success": false, "error": "No se detectó una sesión activa de Antigravity en el sistema (gemini:antigravity). Inicia sesión primero." }`.
     3. Use `live_identity.email` as the authoritative `email` for the profile (never overwrite it with a different email from `get_cached_live_quota`).
     4. Only attach quota metrics (`primary_remaining_percent`, `primary_reset_at`, `time_until_reset_ms`, `plan_name`) from `live_quota` if `live_quota.email` matches `live_identity.email` (or after invalidating cache and fetching fresh quota for `live_identity.email`).
     5. Match `existing_idx` strictly against `live_identity.email` (case-insensitive). If no profile in `profiles.json` has `email == live_identity.email`, generate a new `Uuid::new_v4()` and create a new `SavedAccountProfile`.
2. **Pre-Switch Snapshot Identity Verification (`switch_account_profile_direct`):**
   - **WHEN** `switch_account_profile_direct(provider, target_account_id)` runs Step 1 (refreshing the currently active profile before leaving it):
     1. Read `live_identity = probe_live_provider_identity(&provider)`.
     2. Find `matching_live_profile` in `reg.profiles` by matching `live_identity.email` against `p.email` (case-insensitive).
     3. **IF** `matching_live_profile` exists and `matching_live_profile.id != target_account_id`:
        - Refresh the snapshot of `matching_live_profile.id` (the profile that **actually** owns the live credential).
     4. **ELSE IF** `live_identity` has an email that does **not** match any profile in `reg.profiles`:
        - Do **not** overwrite `active_prof`! Instead, save the unregistered live session into `_backups/<provider>/unregistered_<email_sanitized>_<timestamp>/` so the user never loses it, and leave all existing vault profiles untouched.

### S5. Clean Antigravity Snapshot & Transactional Restore (`src-tauri/src/account_switcher.rs`)

1. **Scoped File Mappings for `"agy"` (`get_provider_file_mappings`):**
   - Remove from `"agy"` mappings:
     - `~/.gemini/antigravity-cli/settings.json` (user CLI preferences & `trustedWorkspaces` must persist across accounts).
     - `%APPDATA%\Antigravity\User\globalStorage\storage.json` (window geometry & workspace list must persist across accounts).
     - `~/.gemini/google_accounts.json` (belongs to `gemini` CLI).
     - `~/.gemini/oauth_creds.json` (belongs to `gemini` CLI).
   - Keep only Antigravity state files (`antigravity_state.pbtxt`, `jetski_state.pbtxt`) and handle `gemini_antigravity_cred.json` as the primary required credential artifact for `"agy"`.
   - For Antigravity IDE (`state.vscdb`): instead of copying/replacing the entire 40MB+ `state.vscdb` file (which overwrites recent workspaces, chat UI layout, and extension state, and causes split-brain when `state.vscdb` holds a different email), extract and restore only the auth-related rows in `ItemTable` (`antigravityAuthStatus`, `antigravityUnifiedStateSync.oauthToken`, `antigravityUnifiedStateSync.userStatus`, `antigravity.profileUrl`) into `ide_auth_state.json` **only when** the `antigravityAuthStatus` email in `state.vscdb` matches the profile's email!
2. **Transactional Keyring Backup & Verification in `apply_profile_to_active`:**
   - For `"agy"`, `src_dir.join("gemini_antigravity_cred.json")` is **mandatory**:
     - **WHEN** `gemini_antigravity_cred.json` does not exist or fails `parse_antigravity_credential_blob`, abort the switch before touching any files and return:
       `Err("El perfil seleccionado no contiene credenciales válidas de Antigravity (gemini_antigravity_cred.json). Vuelve a iniciar sesión con esa cuenta y guárdala.")`.
   - Before writing the new credential:
     - Back up the current live `read_antigravity_raw_credential()` to `backup_dir.join("gemini_antigravity_cred.json")`.
   - Apply the new credential via `write_antigravity_credential(&raw)`:
     - Verify `write_antigravity_credential(&raw)` returns `true` and that a subsequent `read_antigravity_credential()` returns the expected email.
     - If verification fails, restore `backup_dir.join("gemini_antigravity_cred.json")` into Windows Credential Manager and return an error.

### S6. Vault Self-Healing & Integrity Reconciliation (`src-tauri/src/account_switcher.rs`)

1. **Automatic Profile Metadata Repair (`reconcile_agy_profile_integrity`):**
   - **WHEN** `load_registry_from(root)` loads `profiles.json`:
     - For every profile where `canon_provider(&p.provider) == "agy"`:
       1. Check `root.join("agy").join(&p.id).join("gemini_antigravity_cred.json")`.
       2. If the file exists and `parse_antigravity_credential_blob` extracts `cred_email`:
          - **IF** `p.email.as_deref()` does not match `cred_email` (case-insensitive):
            - If `p.label` was empty or equal to the old `p.email`, update `p.label = cred_email.clone()`.
            - Update `p.email = Some(cred_email)`.
          - Mark `p.has_valid_credential = true` (or `credential_status = "ok"`).
       3. Remove legacy contaminated files (`oauth_creds.json`, `google_accounts.json`, `cli_settings.json`) from `root.join("agy").join(&p.id)` so they can never be restored on top of user settings.
     - Deduplicate profiles by `(canon_provider, email_lowercase)` after repairing `p.email`, keeping the profile with a valid `gemini_antigravity_cred.json` and the most recent `last_used_unix_ms`.

### S7. Guided "Conectar Nueva Cuenta" Flow (`begin_new_account_login`) (`src-tauri/src/account_switcher.rs`, `src/lib/ipc.ts`)

1. **New Tauri Command `prepare_new_account_login(request: Option<Value>) -> Value`:**
   - **Input:** `{ "provider": "antigravity" }`
   - **Execution for `"agy"`:**
     1. Probe live identity via `probe_live_provider_identity("agy")`.
     2. If a live identity exists with `live_email`:
        - Automatically save/upsert the current active session into the vault (`save_current_account_profile_direct("agy", live_email)`) so the user's current account is safely preserved in the vault before logging out!
     3. Quiesce/terminate running `agy` CLI processes (`quiesce_provider_terminals("agy")`, `terminate_provider_cli_processes("agy")`).
     4. Call `delete_antigravity_credential()` to clear `gemini:antigravity` from Windows Credential Manager.
     5. Mark all `"agy"` profiles in `profiles.json` as `is_active = false` and invalidate `"antigravity"` quota cache.
     6. Return `{ "success": true, "previousEmailSaved": live_email, "loginCommand": "agy" }`.
2. **Frontend Flow in `AccountVault.tsx` & `AccountSwitcherModal.tsx`:**
   - Provide a prominent button: **`+ Conectar nueva cuenta`** alongside **`Guardar sesión actual`**.
   - **WHEN** the user clicks **`+ Conectar nueva cuenta`** on Antigravity:
     1. Calls `prepareNewAccountLogin('antigravity')`.
     2. Dispatches an event to open/focus an interactive terminal running `agy` (which immediately prompts the user for Google OAuth sign-in because `gemini:antigravity` was cleared).
     3. Starts a lightweight polling loop (every 2.5s while the modal/tab is open, up to 120s) calling `listSavedAccountsFull('antigravity')`.
     4. As soon as the new `unregisteredLiveSession` (or newly authenticated email) is detected in `gemini:antigravity`, automatically saves it to the vault (or highlights the one-click **"Guardar nueva cuenta detectada (`<email>`)"** banner) and updates all views!

### S8. Unified Frontend Account Attribution Across All Surfaces

1. **`src/lib/quota/sessionDetection.ts` (`resolveProviderDetectedSession`):**
   - Do **not** conflate `gemini` and `antigravity` in `cliAccounts.find(...)` (remove lines 68–69 cross-matching `gemini` <-> `antigravity`).
   - When `activeTerm` is found (`sessionType: 'terminal_agent'`), still enrich `email`, `accountLabel`, and `planName` from `cli` (`cliAccounts`) or `quota?.metadata?.email` so the active account email is always displayed even while a terminal agent is running!
2. **`src/components/quota/AccountSwitcherModal.tsx` & `src/components/quota/SubscriptionQuotaPopover.tsx`:**
   - Switch both components from `listSavedAccounts(provider)` to `listSavedAccountsFull(provider)`.
   - Render the `unregisteredLiveSession` warning banner inside both `AccountSwitcherModal` and `SubscriptionQuotaPopover` whenever an active OS session is detected that is not yet saved in the vault, with a 1-click **`Guardar en bóveda`** button.
   - In `SubscriptionQuotaPopover.tsx` (line 764), display the active account email from the reconciled `savedAccounts.find(a => a.isActive)?.email ?? unregisteredLiveSession?.email ?? currentQuota.metadata?.email`.
3. **`src/components/views/settings/AccountTab.tsx`:**
   - Remove the broken `SelectMenu` that calls `setActiveGoogleAccount(email)` (`antigravity_set_active_google_account`) on `~/.gemini/google_accounts.json` for `acc.provider === 'antigravity'`.
   - Instead, use the unified `AccountSwitcherModal` (`Cuentas…`) or inline vault profile selector backed by `listSavedAccountsFull('antigravity')` and `switchAccountProfile('antigravity', profileId)`.
4. **`src/lib/quota/connectionMethods.ts`:**
   - Update `PROVIDERS.ANTIGRAVITY.cliCommand` from the non-existent `'agy auth login'` to `'agy'` (with help copy explaining `/config` or using Kite's **Conectar nueva cuenta** button).

---

## Tasks & Review Slices

### Slice A — Backend Identity, Vault Integrity & Safe Switching (`src-tauri`)

- **T1. Authoritative `gemini:antigravity` credential parser, `id_token_email` support, and `CredDeleteW` helper.**
  - Specs: S1, S2.
  - Edit surfaces: `src-tauri/src/quota/antigravity.rs`, `src-tauri/src/quota/gemini.rs`, `src-tauri/src/quota/mod.rs`.
  - Verification: Unit tests in `src-tauri/src/quota/antigravity.rs` verifying:
    1. `parse_antigravity_credential_blob` extracts `email` when only `id_token_email` is present (no `id_token` JWT).
    2. `parse_antigravity_credential_blob` extracts `email` and `name` when `id_token` JWT is present.
    3. `enrich_antigravity_identity` ignores `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json`.

- **T2. Direct live OS identity probe (`probe_live_provider_identity`) and quota cache invalidation on identity mismatch.**
  - Specs: S3.
  - Edit surfaces: `src-tauri/src/account_switcher.rs`, `src-tauri/src/quota/service.rs`.
  - Verification: Unit tests verifying that when `probe_live_provider_identity("agy")` returns `user_b@example.com` while `quota_cache` holds `user_a@example.com`, `list_saved_accounts` invalidates the stale cache, reconciles `user_b@example.com` as active (or returns `unregisteredLiveSession`), and `list_detected_cli_accounts` reports `user_b@example.com`.

- **T3. Vault self-healing on load, safe registration (`save_current_account_profile_direct`), and pre-switch snapshot guard (`switch_account_profile_direct`).**
  - Specs: S4, S5, S6.
  - Edit surfaces: `src-tauri/src/account_switcher.rs`.
  - Verification: Unit tests verifying:
    1. Saving a new account when `quota_cache` holds a different email creates a **new** profile with the live credential's email and never overwrites the existing profile.
    2. Switching from Profile A (marked `is_active: true` in `profiles.json`) to Profile B while Account C is actually logged into the OS does **not** overwrite Profile A's `gemini_antigravity_cred.json` with Account C's credential.
    3. `reconcile_agy_profile_integrity` repairs a drifted `profiles.json` entry whose `gemini_antigravity_cred.json` has `id_token_email: "real@example.com"` and deduplicates colliding entries.
    4. `get_provider_file_mappings("agy")` does not include `settings.json`, `storage.json`, `oauth_creds.json`, or `google_accounts.json`.

- **T4. Backend `prepare_new_account_login` Tauri command for guided account onboarding.**
  - Specs: S7.
  - Edit surfaces: `src-tauri/src/account_switcher.rs`, `src-tauri/src/main.rs`.
  - Verification: Unit test verifying `prepare_new_account_login` snapshots the active credential before clearing active flags.

### Slice B — Frontend Attribution, Modals & Onboarding Flow (`src`)

- **T5. Fix `sessionDetection.ts` email attribution and decouple `gemini` from `antigravity`.**
  - Specs: S8.1.
  - Edit surfaces: `src/lib/quota/sessionDetection.ts`, `src/lib/quota/connectionMethods.ts`.
  - Verification: Vitest unit tests verifying `resolveProviderDetectedSession('antigravity', ...)` preserves `email` when `terminal_agent` is active and never inherits a `gemini` CLI email.

- **T6. Upgrade `AccountSwitcherModal`, `AccountVault`, `SubscriptionQuotaPopover`, and `AccountTab` with `unregisteredLiveSession` and `+ Conectar nueva cuenta`.**
  - Specs: S7.2, S8.2, S8.3.
  - Edit surfaces: `src/lib/ipc.ts`, `src/components/quota/AccountSwitcherModal.tsx`, `src/components/views/settings/AccountVault.tsx`, `src/components/quota/SubscriptionQuotaPopover.tsx`, `src/components/views/settings/AccountTab.tsx`, `src/components/quota/Modals.test.tsx`, `src/components/views/settings/AccountTab.test.tsx`.
  - Verification: Vitest component tests for `AccountSwitcherModal`, `AccountVault`, and `AccountTab`.

---

## Invariants

1. **Corner Radius & Control Sizing Contract (`AGENTS.md`):**
   - All new or modified interactive controls must strictly use semantic radius tokens (`var(--control-radius)`, `var(--card-radius)`, `var(--dialog-radius)`) and standard control heights (`32px` standard / `28px` compact). Never introduce arbitrary pixel radii or heights.
2. **Protected Zones:**
   - Do not touch `src/components/TitleBar.tsx`.
3. **Clean Provenance:**
   - All code comments, UI copy, test descriptions, and commit messages must describe Kite's own architecture only. Run `node .kite/sanitizer/audit-references.mjs --check` before concluding any slice.

---

## Acceptance Criteria

1. **Active Account Accuracy (`id_token_email` & Cache Immunity):**
   - When Windows Credential Manager `gemini:antigravity` contains `{"id_token_email": "active-user@example.com", "auth_method": "consumer", "token": {...}}` (without `id_token`) and `~/.gemini/oauth_creds.json` contains `"other-user@example.com"`, all Kite surfaces (`QuotasTab`, `AccountVault`, `AccountSwitcherModal`, `SubscriptionQuotaPopover`, `AccountTab`) display `active-user@example.com` as the active Antigravity account.
2. **Self-Healing of Previously Corrupted Profiles:**
   - On first load after the update, any existing `agy` profile in `profiles.json` whose stored `gemini_antigravity_cred.json` contains a different email (`id_token_email` or `id_token` JWT) is automatically repaired to display the true email of its stored credential.
3. **Unregistered Account Detection & Registration:**
   - When the active `gemini:antigravity` email does not match any saved profile in `profiles.json`, `AccountVault`, `AccountSwitcherModal`, and `SubscriptionQuotaPopover` set all saved profiles to `isActive = false` and surface the `unregisteredLiveSession` banner with a 1-click **"Guardar en bóveda"** action that creates a new profile without overwriting any existing profile.
4. **Zero-Clobber Switching:**
   - Switching between saved Antigravity profiles atomically updates Windows Credential Manager `gemini:antigravity`, verifies the written email, preserves user CLI preferences (`~/.gemini/antigravity-cli/settings.json`), and never overwrites a previously active profile if the live credential email did not match that profile.
5. **Quality Gates:**
   - `cargo test` in `src-tauri` passes.
   - `npx tsc --noEmit` passes with 0 errors.
   - `npx vitest run` passes.
   - `node .kite/sanitizer/audit-references.mjs --check` reports `[CLEAN]`.
