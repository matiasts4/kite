# Plugin System and Agent Service Hub

Objective: Implement the complete Kite plugin ecosystem, establishing an authentic Agent Tool & Service Hub. This includes the canonical 29-service catalogue, connection state machine, Rust Tauri IPC backend (`plugin_connections`, `plugin_connection_action`), React hook with focus-aware polling, interactive card grid with state-swap buttons, and end-to-end integration with Agent Settings (`disabledPluginIds` & MCP tool gating).
Branch: `feat/plugin-system`. Do not commit on `main`.
Delivery strategy: `delegated` via subagents.
Test runner: `npm test` (`vitest run`) for frontend; `cargo test` in `src-tauri` for Rust. `npx tsc --noEmit` for type checking.

---

## Specs

### S1. Clean Architecture & Provenance Isolation
Product documentation, UI copy, code comments, tests, and commit messages describe this product's own implementation only:
- No external project names, no copy claims, and no derivation notes.
- Use established terminology: "Plugins", "Service Hub", "MCP Connections", "Agent Settings".
- Strict English identifiers in code and technical documentation; UI copy matches the product visual language.

### S2. Canonical 29-Service Catalogue & Auth Modalities
The catalogue must contain the 29 supported services with their exact identifiers, categories, and authentication modalities:
- **Identifiers**: `x`, `apollo`, `vidiq`, `higgsfield`, `fal`, `youtube`, `github`, `linear`, `stripe`, `revenuecat`, `cloudflare`, `gmail`, `supabase`, `vercel`, `shopify`, `slack`, `notion`, `sentry`, `resend`, `metaads`, `googleads`, `ryze`, `blender`, `unreal`, `unity`, `quickbooks`, `posthog`, `zernio`, `paddle`.
- **Authentication Types**:
  - `apiKey`: direct key/token (`vidiq`, `fal`, `github`, `stripe`, `revenuecat`, `cloudflare`, `shopify`, `slack`, `resend`).
  - `oauthMCP`: remote MCP server authorization (`apollo`, `higgsfield`, `linear`, `supabase`, `vercel`, `notion`, `sentry`, `ryze`, `posthog`, `zernio`, `paddle`).
  - `localMCP`: local process connection via stdio (`blender`, `unreal`, `unity`).
  - `oauthGoogle`: Google OAuth integration (`youtube`, `gmail`, `googleads`).
  - `oauthMeta`: Meta OAuth (`metaads`).
  - `oauthIntuit`: Intuit OAuth (`quickbooks`).
  - `preview`: Informational preview mode (`x`, `posthog`, `zernio`, `paddle` initial preview).
- **Default Connection States**:
  - `preview`: `x`, `posthog`, `zernio`, `paddle`.
  - `unavailable`: `youtube`, `gmail`, `metaads`, `quickbooks`.
  - `disconnected`: all remaining 21 plugins.
- **Visuals**:
  - Tile branding with `prefersDarkTile` flags.
  - Fallback icons: `bug` for Sentry, `send` for Resend.

### S3. Connection Lifecycle & Data Model
Connection status follows a strict 7-state finite state machine:
```typescript
export type PluginConnectionState =
  | 'preview'           // Informational tile only
  | 'unavailable'       // Disabled in current build
  | 'disconnected'      // Ready for connection
  | 'connecting'        // Authorization in flight
  | 'connected'         // Actively connected with account info
  | 'needsReauth'       // Token expired or revoked
  | 'disconnectPending';// Disconnect in progress or retryable
```
Each connection item carries:
```typescript
export interface PluginConnection {
  id: string;
  state: PluginConnectionState;
  account: string | null;
  message: string | null;
}
```

### S4. Tauri IPC Contract & Rust Backend
The Tauri backend must expose and handle two commands:
1. `plugin_connections`:
   - Returns a vector of all 29 `PluginConnection` records.
   - Reads persisted connection data from SQLite/store (`~/.kite/plugins.json` or `kite.sqlite3`).
2. `plugin_connection_action`:
   - Request payload: `{ request: { schemaVersion: 1, id: String, action: "connect" | "cancel" | "disconnect" } }`.
   - Handles transition logic:
     - `connect`: sets state to `connecting`, simulates/executes external browser auth flow or local MCP spawn, then resolves to `connected` with mock or real account (e.g. `user@domain.com`).
     - `cancel`: reverts `connecting` back to `disconnected`.
     - `disconnect`: clears tokens and sets state to `disconnected`.

### S5. Focus-Aware Polling Hook (`usePluginConnections`)
The React hook `usePluginConnections`:
- Queries `plugin_connections` immediately on mount.
- Sets up an interval that polls every 2000 ms (`2e3`), active **only** while `document.hasFocus()` is true.
- Suspends polling when the window loses focus to preserve system resources.
- Provides `{ connections, ready, error, pending, action, refresh }`.
- Deeply compares incoming data to avoid redundant re-renders when data has not changed.
- Handles optimistic updates and rolling back on network or IPC error.

### S6. Interactive Catalogue UI (`PluginsView`)
The view must implement the full interactive experience:
- **Search**:
  - Live filtering across `name`, `vendor`, and `summary`.
  - Escape key clears the search input.
  - Empty state when no matches: `"No plugins match “{query}”."`.
- **Sorting Order**:
  1. Active/Pending connections first (`connected`, `needsReauth`, `disconnectPending`).
  2. Remaining services sorted alphabetically by name.
- **Card Copy Resolution**:
  - If `connection.message` exists: displays the error message with failed tone.
  - If `state === 'connected'`: displays `account` (fallback to `"Connected"`).
  - If `state === 'needsReauth'`: displays `"{account} — reconnect to keep using it."`.
  - If `state === 'connecting'`: displays `"Finish in your browser or local app, then return here."`.
  - If `state === 'unavailable'`: displays `"Account setup is not available in this build."`.
  - Otherwise (`disconnected` / `preview`): displays `plugin.summary`.
- **Action Button States**:
  - `preview` / `unavailable`: static non-clickable chip (`Preview` / `Unavailable`).
  - `connecting`: quiet action button with spinner and `"Cancel"`.
  - `connected`: dynamic swap button displaying a green active dot + `"Connected"`, switching on `:hover` to `"Disconnect"`.
  - `disconnected`: button with `"Connect"`.
  - `needsReauth`: button with `"Reconnect"`.
  - `disconnectPending`: button with `"Disconnect"`.
- **Footnote**:
  - Displays: `"Connect once to Kite. Choose each agent’s plugins in Agent Settings. Its access mode controls approvals; Read only keeps plugins read-only."`

### S7. Agent Settings & MCP Tool Gating
Integrate the connected plugins with `AgentSettingsTab.tsx`:
- Connected plugins are projected into the agent's MCP servers list (`visibleMcpServers`).
- The agent's `disabledPluginIds` list selectively disables tools for that specific agent.
- Toggling the switch updates `disabledPluginIds` in `AgentProfile` and persists via `save_agent`.
- When an agent is in `Read-only` mode, plugins with financial or mutation actions (charges, refunds, deletions) remain strictly read-only.

### S8. Agent Coverage Visibility & Bidirectional Control
Provide bidirectional visibility and control between plugins and agents:
- **Card Avatar Stack**: In `PluginCard.tsx`, when a plugin is `connected`, render a compact row of mini `AgentAvatar` badges representing the agents that have this plugin enabled (`!agent.disabledPluginIds.includes(plugin.id)`).
- **Details Modal / Drawer (`PluginDetailsDrawer.tsx`)**:
  - Clicking any plugin card opens the details dialog.
  - Contains complete metadata: vendor, version, authentication type, full description, required permissions, and docs URL.
  - Contains an interactive **"Active on Agents"** section listing all workspace agents with their avatar, name, and engine.
  - Each agent row has a live toggle switch: toggling updates `disabledPluginIds` in the backend (`update_agent_profile`), granting or revoking that agent's access to this plugin without leaving the modal.

### S9. Phase 2: Plugin Configuration & Credential Persistence
Enable live execution credentials and tool parameters:
- Tauri backend commands:
  - `get_plugin_config(plugin_id)`: retrieves stored credentials and options.
  - `save_plugin_config(plugin_id, config)`: saves API keys, custom endpoints, and ports to encrypted/secure local storage.
  - Saving a valid configuration automatically transitions the plugin's connection state to `connected`.
- In `PluginDetailsDrawer`, plugins with `apiKey` or `localMCP` display secure credential inputs with masked keys, read-only toggles, and instant save capability.

---

## Tasks

- [x] **T1. Types, Schemas and Catalogue Specification**
  - Path: `src/components/views/plugins/types.ts`, `src/components/views/plugins/pluginIdentity.ts`, `src/components/views/plugins/catalog.ts`.
  - Scope: Ensure all 29 plugin identities, connection states, and catalog definitions are strictly typed and match S2 and S3.
  - Route: inline. Status: completed. Evidence: strict TypeScript definitions matching canonical 29 services.

- [x] **T2. Tauri Rust Backend (`plugin_connections` and `plugin_connection_action`)**
  - Path: `src-tauri/src/plugins.rs`, `src-tauri/src/main.rs`.
  - Scope: Implement plugin persistence, state machine transitions, and register Tauri command handlers.
  - Route: delegated. Status: completed. Evidence: `cargo test plugins` 5/5 passed, `cargo check` clean.

- [x] **T3. React Hook `usePluginConnections` & Unit Tests**
  - Path: `src/components/views/plugins/usePluginConnections.ts`, `src/components/views/plugins/usePluginConnections.test.ts`.
  - Scope: Implement polling with focus detection, action dispatching, error states, and comprehensive Vitest unit tests.
  - Route: delegated. Status: completed. Evidence: `usePluginConnections.test.ts` 9/9 passed.

- [x] **T4. Catalogue UI Components & Styling**
  - Path: `src/components/views/PluginsView.tsx`, `src/components/views/plugins/PluginCard.tsx`, `src/components/views/plugins/plugins.css`.
  - Scope: Rebuild the view to render the 29 cards, search filtering, dynamic sort, and the hover-swap connected button.
  - Route: delegated. Status: completed. Evidence: `PluginCard.test.tsx` (11 passed), `PluginsView.test.tsx` (6 passed).

- [x] **T5. Agent Settings Integration & Tool Exposure**
  - Path: `src/components/views/agents/AgentSettingsTab.tsx`.
  - Scope: Wire `usePluginConnections` into `AgentSettingsTab`, mapping connected plugins to MCP servers with `disabledPluginIds` toggle.
  - Route: delegated. Status: completed. Evidence: `AgentSettingsTab.test.tsx` 2/2 passed.

- [x] **T6. Verification, Test Suite & Cargo Check**
  - Scope: Run `npm test -- plugins`, `npx tsc --noEmit`, and `cargo check`. Verify zero errors and full functionality.
  - Route: inline. Status: completed. Evidence: vitest 28/28 passed, tsc exit 0, cargo check exit 0.

- [x] **T7. Phase 2 Backend: Plugin Credentials & Configuration Commands**
  - Path: `src-tauri/src/plugins.rs`, `src-tauri/src/main.rs`.
  - Scope: Implement `get_plugin_config` and `save_plugin_config` with disk persistence and auto-connection trigger.
  - Route: delegated. Status: completed. Evidence: `cargo test plugins` 9/9 passed, config persistence and auto-connect on API key save verified.

- [x] **T8. Agent Coverage Hook `useAgentPluginCoverage` & Unit Tests**
  - Path: `src/components/views/plugins/useAgentPluginCoverage.ts`, `src/components/views/plugins/useAgentPluginCoverage.test.ts`.
  - Scope: Hook that loads agents, computes enabled/disabled status per plugin, and provides interactive toggle.
  - Route: delegated. Status: completed. Evidence: `useAgentPluginCoverage.test.ts` 4/4 passed.

- [x] **T9. Plugin Details Modal with Agent Avatar Management & Card Mini-Stack**
  - Path: `src/components/views/plugins/PluginDetailsDrawer.tsx`, `src/components/views/plugins/PluginCard.tsx`.
  - Scope: Render details modal with description, credentials input, and agent list with live switches; render mini avatar stack on connected cards.
  - Route: delegated. Status: completed. Evidence: `PluginCard.test.tsx` (12 passed), `PluginsView.test.tsx` (7 passed).

---

## Invariants

1. Do not commit on `main`. Work on `feat/plugin-system` or current worktree.
2. English identifiers, comments, and schemas. UI copy adheres to Kite design system.
3. No external project names or third-party derivation text in source code, commit messages, or user-facing copy.
4. Maintain dirty changes in working tree unrelated to plugins.
5. All 29 plugins must be accounted for in the catalogue and types.

---

## Verification Plan

1. **Unit Tests**:
   - `npm test -- src/components/views/plugins` must pass with 100% green tests.
   - Tests cover: connection sorting, search filtering, state copy resolution, and `usePluginConnections` polling lifecycle.
2. **Type Safety**:
   - `npx tsc --noEmit` must exit with code 0.
3. **Backend Compilation**:
   - `cargo check --manifest-path src-tauri/Cargo.toml` must complete with 0 errors.
