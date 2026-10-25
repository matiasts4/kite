# Account Vault Live Reconciliation and Intelligent Terminal Orchestration

Objective: Eliminate manual terminal restart friction and session identity desynchronization in Kite by implementing live account state reconciliation, surgical per-provider process inspection, graceful terminal quiescence, and throttled/lazy respawn without host freezes or work disruption.
Branch: `feat/account-vault-terminal-orchestration`. Do not commit on `main`.
Delivery: `ask-on-risk`; slices are review boundaries. Test runners: `npm test` (`vitest run`) and `cargo test` in `src-tauri`.
Workers: The user launches them. The author of this document does not.

---

## Product decision

Transform the account switching and vault workflow from a rigid, manual error barrier (`PROVIDER_BUSY: Cierra el cliente antes de cambiar de cuenta`) into an automated, production-grade session orchestrator. Keep Kite lightweight, fast, and responsive even under heavy terminal concurrency.

1. **Single Source of Live Truth (Continuous Reconciliation):**
   - The Account Vault must never display stale `is_active` flags from static configuration files.
   - Every read of saved accounts dynamically probes the real, live identity present in the host OS (e.g. Windows Credential Manager, active token files, or IDE storage).
   - If the active OS identity matches a known profile in the vault, that profile is immediately marked `isActive = true` (and all others `false`).
   - If the active OS identity represents an unregistered external login, the vault surfaces an informational banner with a one-click *"Guardar sesión como nuevo perfil"* action, rather than falsely displaying another account as active.

2. **Dual-Store Synchronization (IDE + CLI Consistency):**
   - For multi-client providers (such as Antigravity), session persistence and switching must atomically synchronize both the desktop application store (Windows Credential Manager `gemini:antigravity` + `state.vscdb`) and the CLI/agent runtime store (`~/.gemini/` configuration and state files).
   - This eliminates split-brain conditions where the graphical IDE operates under Account A while embedded agent terminals operate under Account B.

3. **Surgical Terminal Discovery & Isolation:**
   - Switching an account must never disrupt generic shell sessions or unrelated workloads.
   - The inspection engine isolates only sessions belonging to the targeted provider:
     - Dedicated agent terminals (`engine == provider`).
     - Generic shells (`powershell`, `cmd`, `bash`, `wsl`) currently hosting a child agent CLI process, resolved via OS process tree traversal (`detect_child_agent_in_shell`).
   - Pure shell sessions running build tools (`cargo`, `npm`, `python`), git commands, or servers are strictly untouched.

4. **Resource Governance & Anti-Overload Protection (Lazy Staggered Respawn):**
   - Simultaneously terminating and respawning multiple terminal ConPTY instances causes severe CPU spikes, IPC saturation, and desktop freezing (*thundering herd*).
   - The orchestrator enforces a three-tier lifecycle:
     - **Priority 0 (Active Visible Pane):** Respawns immediately (<100ms) with the updated account credentials.
     - **Priority 1 (Background Tabs in Active Workspace):** The old process is gracefully terminated to release credential file locks, but the new process is marked `StalePendingRespawn` and created **lazily on-focus** when the user clicks the tab, or queued with a 300ms inter-process throttle.
     - **Priority 2 (Inactive Workspaces):** Persisted in `terminal-sessions.json` without active OS processes (0% CPU, 0 MB RAM footprint).

5. **Graceful Quiescence vs. Busy Task Protection:**
   - **Idle Terminals:** Drain output buffer to `.scrollback`, send soft interruption (`SIGINT` / `Ctrl+C`), wait up to 600ms, and terminate cleanly to release file handles.
   - **Busy Terminals (Active Generation / Tool Calls):** Do not kill blindly. Present a non-intrusive action sheet detailing the active job, allowing the user to choose between:
     - `[ Esperar a que finalice ]`: Keep current turn running; apply switch to idle terminals first.
     - `[ Interrumpir y rotar ahora ]`: Send abort signal and restart immediately.

6. **Seamless Visual Continuity & In-Terminal Audit Trail:**
   - Historical terminal scrollback is completely preserved across account switches.
   - Upon reconnection, Kite injects a clean, branded audit divider directly into the terminal stream:
     ```text
     ──────────────────────────────────────────────────────────────────
     ✦ Kite Vault: Cuenta cambiada a «Google AI Pro - Personal»
     ──────────────────────────────────────────────────────────────────
     ```
   - Each agent terminal header displays a subtle account chip (`[ ✦ Antigravity: Personal ]`) with hover tooltip detailing remaining quota, eliminating all ambiguity about active identity.

---

## Terms

- **Vault Profile:** A saved credentials snapshot stored in `connections/shared_account_profiles/<provider>/<id>/`.
- **Live Identity:** The actual authenticated identity currently recognized by the host OS or CLI runtime (verified via JWT decoding, Credential Manager, or OAuth cache).
- **Split-Brain State:** A desynchronized condition where different tools (IDE vs. terminal CLI) or views (Quotas vs. Vault) report conflicting active accounts.
- **Dedicated Agent PTY:** A Kite terminal spawned directly with an AI engine (`agy`, `claude`, `codex`).
- **Hybrid Shell:** A generic shell (`powershell`, `bash`) within which a user or script executed an AI agent CLI.
- **Pure Shell:** A terminal running arbitrary developer commands (`npm`, `cargo`, `docker`) without an active AI agent child.
- **Thundering Herd:** The system performance degradation occurring when multiple resource-heavy processes (ConPTY, Node/Python runtimes) spawn simultaneously.
- **Lazy On-Focus Respawn:** Deferring process creation until the user brings the corresponding tab into view.
- **Quiescence:** Bringing a terminal process into a safe, non-writing state before swapping files under it.

---

## Current-state audit

### Observed facts in the codebase

1. **Static Registry Desynchronization (`src-tauri/src/account_switcher.rs`):**
   - `list_saved_accounts` reads `profiles.json` where `is_active` is a static flag.
   - On lines 757–768, `list_saved_accounts` probes `get_cached_live_quota()`. When `saved_email != now.email`, the code executes `return None;` and silently skips updating the registry.
   - As a result, the Account Vault continues displaying `Activa` / `En uso ahora` on an inactive profile if the user logged in externally or if a prior switch aborted.

2. **Primitive Concurrency Guard (`ensure_provider_idle`):**
   - Lines 522–541 run a global `tasklist` scan. If any process matching the provider name is found anywhere on the system, it immediately rejects the operation with:
     `PROVIDER_BUSY: Cierra el cliente de <provider> antes de cambiar de cuenta (procesos activos: <list>).`
   - It makes no distinction between Kite-managed terminals, idle prompts, or external applications.
   - It forces the user into manual process management and tab recreation.

3. **Terminal Management Capabilities (`src-tauri/src/terminal.rs`):**
   - Kite already maintains a global terminal registry (`get_terminals(): Mutex<HashMap<String, Arc<TerminalInstance>>>`).
   - Supports live CWD extraction, buffer draining (`drain_buffer_into_scrollback`), and persistent state snapshots (`snapshot_and_shutdown_all_terminals`).
   - `src-tauri/src/session_resolver.rs` contains `detect_child_agent_in_shell(root_pid)` capable of traversing the Windows process tree to find agent CLIs inside PowerShell/Bash.
   - However, there is no targeted API to query or restart terminals by provider identity without shutting down the entire application.

4. **UI Friction in `AccountVault.tsx`:**
   - Displays static `prof.isActive` values.
   - Renders generic error banners upon `PROVIDER_BUSY`.
   - Lacks an inspection sheet for active terminals or inline restart progress.

---

## Specs

### S1. Live Identity Auto-Reconciliation Engine
- **Trigger:** Invoked whenever `list_saved_accounts` is called, or when the user navigates to the Account Vault or Quotas tab.
- **Algorithm:**
  1. Retrieve `live_identity` (email, plan, provider) from live provider probes (`fetch_live_quota`).
  2. If `live_identity.email` matches an existing profile `P` in `profiles.json`:
     - Set `P.is_active = true`.
     - Set all other profiles for that provider to `is_active = false`.
     - Commit changes atomically to `profiles.json`.
  3. If `live_identity.email` does not match any stored profile:
     - All stored profiles are set to `is_active = false`.
     - Return an `unregistered_live_session` payload containing the detected email, name, and provider.
- **Outcome:** The Vault card chip `[Activa]` and `En uso ahora` always match the real account reported by the Quotas tab.

### S2. Targeted Terminal & Process Inspector
- **Function:** `inspect_provider_sessions(provider: &str) -> ProviderInspectionReport`
- **Report Schema:**
  - `managed_idle`: List of Kite session IDs running the provider currently idle at prompt.
  - `managed_busy`: List of Kite session IDs actively streaming output or executing tools.
  - `external_pids`: List of PIDs running on the host OS not attached to any Kite PTY.
  - `unaffected_terminals_count`: Count of open terminals that will remain untouched.

### S3. Graceful Quiescence & Drain Pipeline
- **Execution:**
  1. For each targeted managed session:
     - Flush in-memory output buffer to disk using `drain_buffer_into_scrollback`.
     - Capture `live_cwd` and startup arguments.
     - Send soft interrupt (`Ctrl+C` / break signal).
     - Wait up to 600ms for child process exit.
     - If still active after timeout, issue process termination on the child handle.
  2. Guarantee file locks on credential paths are fully released before proceeding to file swap.

### S4. Dual-Store Atomic Credential Swap
- **Execution:**
  - Back up current credentials to `_backups/<provider>/<timestamp>/`.
  - Atomically copy profile files into destination paths.
  - On Windows for Antigravity: atomically update Windows Credential Manager `gemini:antigravity` alongside `~/.gemini/` and AppData stores.
  - If any file operation fails, roll back from backup directory and preserve original state.

### S5. Staggered & Lazy On-Focus Respawn Controller
- **Visible Active Terminal:**
  - Instantly respawns in the current pane with the new environment and session credentials.
  - Target latency: <150ms.
- **Background Terminals (Same Workspace):**
  - Set state to `StalePendingRespawn`.
  - When the tab gains focus: spawn ConPTY process dynamically and attach to the existing scrollback buffer.
  - Optional setting: Background staggered spawn (queue with 300ms delay between instances).
- **Background Workspaces:**
  - Updated in `terminal-sessions.json` only; zero OS processes spawned until workspace is activated.

### S6. Context Preservation & Audit Dividers
- On terminal respawn, prepend historical scrollback.
- Inject formatted audit divider:
  ```text
  ──────────────────────────────────────────────────────────────────
  ✦ Kite Vault: Sesión reactivada con cuenta «{label}»
  ──────────────────────────────────────────────────────────────────
  ```
- Position cursor at a clean prompt in the preserved `live_cwd`.

### S7. Busy Terminal Protection & User Consent Sheet
- If `managed_busy.len() > 0`:
  - Open a dedicated confirmation sheet in `AccountVault.tsx` detailing active tasks:
    - `"Terminal 1 (Workspace: kite): Generando código..."`
  - Provide two actions:
    - **`[ Esperar a que terminen ]`**: Abort switch; notify user when idle.
    - **`[ Interrumpir y rotar ahora ]`**: Issue graceful abort and execute full pipeline.

### S8. Terminal Header Account Attribution Badge
- In the pane header of each agent terminal (`CodePaneHeader.tsx` / `AgentTerminalPane.tsx`):
  - Add a pill badge: `[ ✦ Antigravity: {Account Label} ]`.
  - Click opens the Account Switcher Modal pre-selected on that provider.

---

## Verification & Acceptance Criteria

1. **Reconciliation Test:**
   - Log into Account B externally via terminal or IDE while Account A is marked active in Kite.
   - Open Account Vault: Account B must immediately show the `[Activa]` badge and `En uso ahora` without manual clicks. Quotas and Vault must match 100%.

2. **Idle Auto-Restart Test:**
   - Open 3 agent terminals in Kite with Antigravity at idle prompt.
   - Click "Activar" on Account B in Account Vault.
   - Active visible terminal restarts automatically with Account B within 150ms.
   - No `PROVIDER_BUSY` error shown.
   - Background tabs do not spike CPU and resume cleanly on click.

3. **Busy Terminal Protection Test:**
   - Run a long-running generation in Terminal 1.
   - Click "Activar" in Account Vault.
   - Confirmation sheet appears warning about Terminal 1 being busy.
   - User can choose to wait or interrupt.

4. **Neutral Terminal Isolation Test:**
   - Open PowerShell running `npm run dev` and bash running a git watch.
   - Switch account in Account Vault.
   - PowerShell and bash processes remain uninterrupted with zero dropped packets.

5. **Reference Audit:**
   - Run `node .kite/sanitizer/audit-references.mjs --check` with 0 violations.
   - Verify TypeScript: `npx tsc --noEmit`.
   - Verify Vitest: `npx vitest run`.
