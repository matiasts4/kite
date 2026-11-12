# Agent Update Detection & Lifecycle Management — Specification

Objective: Provide real-time agent version detection, non-intrusive update notification, and in-place background updates/installations across Kite Code desktop surfaces by augmenting existing provider configuration interfaces without creating redundant surfaces.
Branch: `feat/ui-composer` (or feature branch `feat/agent-update-management`).
Delivery: `ask-on-risk`; review boundaries defined below. Test runners: `npx vitest run` (`npm test`) for frontend and `cargo test` in `src-tauri` for Rust.

---

## 1. Context & Architectural Principles

Kite Code orchestrates multiple AI coding engines (such as Antigravity `agy`, Claude Code, OpenAI Codex, OpenCode, Google Gemini, Grok, Kimi, etc.). Upstream CLI releases occur frequently, delivering new capabilities, bug fixes, and revised communication protocols.

### 1.1 Guiding Principles
1. **Zero Redundancy (Reuse Existing Surfaces)**:
   - Kite already has a comprehensive configuration interface under **Settings > Cuentas y Proveedores** ([QuotasTab.tsx](file:///E:/kite/src/components/views/settings/QuotasTab.tsx) and [ProviderConnectionPanel.tsx](file:///E:/kite/src/components/quota/ProviderConnectionPanel.tsx)), which already detects sessions, lists supported providers, and manages credentials.
   - We do **not** build an isolated duplicate modal catalog. Instead, version status and update/install capabilities are embedded directly into the existing provider cards and connection panels.
2. **Leverage Existing Detection Infrastructures**:
   - Kite already maintains binary path discovery (`engine_installed`, `resolve_engine_program` in `src-tauri/src/terminal.rs`) and CLI session detection (`listDetectedCliAccounts`, `detectAllProviderSessions`).
   - We enrich this existing detection with semantic version extraction (`--version`) and remote registry comparison.
3. **Non-Intrusive Quick Access**:
   - Avoid floating modals or intrusive overlays in the workspace.
   - Provide a discrete, lightweight top-bar instrument in `TitleBar.tsx` for quick 1-click updates of outdated tools, linked to the existing Settings view for in-depth configuration.

---

## 2. Product Decisions & User Experience

Kite implements a unified, non-redundant lifecycle flow across two complementary touchpoints:

### 2.1 Top-Bar Quick Instrument (`AgentUpdatesBadge` & `AgentUpdatesPopover`)
- **Location**: In the TitleBar trailing instrument slot ([TitleBar.tsx](file:///E:/kite/src/components/TitleBar.tsx#L290-L300)), right beside `SystemResourceBadge` and `SubscriptionQuotaBadge`.
- **Badge Behavior**:
  - **Quiescent State**: When all installed agents are up-to-date (or 0 updates are pending), the badge is collapsed/hidden, preserving a pristine top bar.
  - **Update Available**: When one or more installed engines have updates, an animated compact pill displays the update glyph (`⬆`) and count (e.g. `⬆ 2`).
  - Standard compact control height (`28px` / `--control-row`), radius `--control-radius` (`8px` / `rounded-control`).
- **Popover (`AgentUpdatesPopover`)**:
  - Clicking the badge opens a lightweight anchored popover.
  - Displays **only installed engines that are outdated**, allowing the developer to update immediately without leaving their active task.
  - Each item shows: brand logo (`BrandLogo`), engine name, version transition (`v0.2.29 → v0.2.32`), and an **"Actualizar"** button.
  - Clicking "Actualizar" triggers the update silently in the background, showing an in-place spinner until completed.
  - **Footer Action**: *"Configuración de proveedores y agentes →"*, which triggers `openSettingsTab('quotas', providerId)` to navigate directly to the existing configuration panel.

### 2.2 Augmenting the Existing Provider Configuration Surface (`ProviderConnectionPanel`)
Instead of duplicating provider cards in a new modal, the existing **Cuentas y Proveedores** view is upgraded:

1. **Provider List Overview ([QuotasTab.tsx](file:///E:/kite/src/components/views/settings/QuotasTab.tsx))**:
   - In the provider navigation list, providers with an available update display an amber update indicator tag (`Actualizar`) alongside their quota badge.
2. **Connection Panel CLI Tab ([ProviderConnectionPanel.tsx](file:///E:/kite/src/components/quota/ProviderConnectionPanel.tsx))**:
   - Directly under the session status header, a new **Lifecycle & Version Card** is integrated:
     - **Estado: Desactualizado**:
       - Displays: `Versión instalada: v0.2.29` · `Última disponible: v0.2.32`.
       - Primary Action: **"Actualizar agente"** button that executes the update command in the background.
       - Secondary Action: *"Copiar comando de actualización"* (e.g. `claude update`, `agy update`, `npm i -g ...`).
     - **Estado: Al día**:
       - Displays: `Versión instalada: v0.2.32 (Al día)` with a subtle green verification dot.
       - Action: *"Revisar actualizaciones"* (fuerza reprobación de la versión remota).
     - **Estado: No instalado**:
       - Displays: `No se detectó el binario en el sistema`.
       - Primary Action: **"Instalar CLI / Agente"** button with automatic background execution.
       - Secondary Action: *"Ver instrucciones de instalación manual"*.

### 2.3 Silent Background Tool Runner (Tauri Backend)
- Executes update and install commands in the background without launching visible terminal windows (`CREATE_NO_WINDOW` on Windows / background process on Unix).
- Emits progress events over Tauri IPC (`agent:tool-job-changed`).
- In-memory registry cache (TTL: 60 minutes) to prevent redundant network requests.
- Automatically reprobes local versions and invalidates cache when an update finishes.

---

## 3. Data Contracts & IPC Schema

### 3.1 Shared TypeScript Models (`src/types/agentUpdates.ts`)

```typescript
export type AgentLifecycleState = 'outdated' | 'up_to_date' | 'not_installed' | 'unknown';

export interface AgentUpdateAdvisory {
  engine: string;
  displayName: string;
  state: AgentLifecycleState;
  currentVersion: string | null;
  latestVersion: string | null;
  updateCommand: string;
  installCommand?: string;
  binaryPath?: string | null;
  checkedAtUnixMs: number;
}

export interface AgentUpdatesSummary {
  totalSupported: number;
  installedCount: number;
  outdatedCount: number;
  advisories: Record<string, AgentUpdateAdvisory>; // keyed by engine/provider id
  lastCheckedUnixMs: number;
}

export type ToolJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ToolJobProgress {
  jobId: string;
  engine: string;
  action: 'update' | 'install';
  status: ToolJobStatus;
  percent?: number | null;
  lastLine?: string | null;
  error?: string | null;
  startedAtUnixMs: number;
  finishedAtUnixMs?: number | null;
}
```

### 3.2 Backend Tauri Commands (`src-tauri/src/agent_maintenance.rs`)

1. `get_agent_updates_summary(force_refresh: Option<bool>) -> Result<AgentUpdatesSummary, String>`
   - Inspects existing `engine_installed()` and `resolve_engine_program()`.
   - Runs fast local version probe (`--version`) with timeouts (<2s).
   - Fetches registry latest versions (cached for 60 min).
   - Returns full map of advisories keyed by provider/engine ID (`antigravity`, `claude`, `codex`, `gemini`, `opencode`, `grok`, etc.).
2. `start_agent_tool_job(engine: String, action: String) -> Result<ToolJobProgress, String>`
   - Spawns background process with hidden window executing the update/install command.
3. `get_active_agent_tool_jobs() -> Vec<ToolJobProgress>`
   - Returns currently running or recent jobs.

---

## 4. Behavioral Contracts (`WHEN ... THEN ...`)

### 4.1 Background Version Probing & TTL
- `WHEN` Kite starts or a periodic timer triggers (every 60 min):
  - `THEN` the backend checks local versions of all supported installed CLIs.
  - `THEN` remote versions are resolved from cache or fetched from official registries (npm registry, GitHub release manifests, agy release endpoints).
  - `THEN` advisories are updated in the in-memory cache and broadcast to frontend subscribers.

### 4.2 Top Bar Instrument Behavior
- `WHEN` all installed engines are up to date (`outdatedCount === 0`):
  - `THEN` `AgentUpdatesBadge` in `TitleBar.tsx` remains completely hidden, leaving the top bar clean.
- `WHEN` at least one installed engine is outdated (`outdatedCount > 0`):
  - `THEN` `AgentUpdatesBadge` is rendered showing `⬆ <count>`.
  - `THEN` clicking the badge opens `AgentUpdatesPopover` anchored to the button.

### 4.3 Quick Update from Popover
- `WHEN` the user clicks "Actualizar" on an outdated agent row in `AgentUpdatesPopover`:
  - `THEN` Kite initiates `start_agent_tool_job(engine, "update")`.
  - `THEN` the button reflects active loading state without closing the popover or disrupting open editors.
  - `THEN` upon exit code 0, the advisory updates to `up_to_date`, the badge counter decrements, and a temporary success checkmark is shown.

### 4.4 Navigation to Existing Provider Settings
- `WHEN` the user clicks *"Configuración de proveedores y agentes →"* in the popover or clicks an update badge in `QuotasTab`:
  - `THEN` Kite dispatches `openSettingsTab('quotas', providerId)`.
  - `THEN` Kite opens the existing **Cuentas y Proveedores** settings view with the selected provider active.
  - `THEN` `ProviderConnectionPanel` highlights the CLI tab with version details, upgrade notes, and the **"Actualizar agente"** button.

### 4.5 In-Place Installation of Missing Agents
- `WHEN` viewing an uninstalled provider in `ProviderConnectionPanel`:
  - `THEN` the panel displays status *"No instalado"* and an **"Instalar CLI"** button.
  - `THEN` clicking "Instalar CLI" triggers the official background installer, verifying PATH discovery upon completion.

---

## 5. Visual Language & Token Compliance

In strict compliance with [E:\kite\AGENTS.md](file:///E:/kite/AGENTS.md):
- **Corner Radii**:
  - Buttons, inputs, badge rows: `var(--control-radius)` (`8px` / `rounded-control`).
  - Popover surfaces and cards: `var(--card-radius)` (`12px` / `rounded-card`).
  - Concentric pseudo-borders: subtract 1px (`calc(var(--control-radius) - 1px)`).
- **Heights**:
  - TitleBar compact badge: `var(--control-row)` (`28px`).
  - Standard action buttons in `ProviderConnectionPanel`: `var(--vl-control-md)` (`32px`).
- **Protected Zones**:
  - Do **not** alter the stadium pill toggle in `TitleBar.tsx` (`mode-toggle--stadium`) or its motion indicator.

---

## 6. Implementation Slices

### Slice 1: Rust Backend Service (`src-tauri/src/agent_maintenance.rs`)
- Local CLI version discovery (`read_installed_version` via `--version` on resolved program paths).
- Remote registry query with 60-minute TTL cache (`npm registry`, `agy manifest`, etc.).
- Semver comparator and advisory generator (`AgentUpdateAdvisory`).
- Background job executor with hidden process creation (`CREATE_NO_WINDOW` on Windows).
- Expose Tauri commands: `get_agent_updates_summary`, `start_agent_tool_job`, `get_active_agent_tool_jobs`.

### Slice 2: Frontend State Management (`src/lib/agentUpdates.ts`)
- TypeScript types and IPC invokers.
- Reactive manager/hook (`useAgentUpdates`) with periodic polling and cache invalidation.
- Event listener for live job progress (`agent:tool-job-changed`).

### Slice 3: Top Bar Quick Instrument (`AgentUpdatesBadge.tsx` & `AgentUpdatesPopover.tsx`)
- Embed `AgentUpdatesBadge` in `TitleBar.tsx` trailing slot.
- Implement `AgentUpdatesPopover` with motion presence tokens.
- Add footer navigation via `openSettingsTab('quotas', providerId)`.

### Slice 4: Augment Existing Provider Surface (`ProviderConnectionPanel.tsx` & `QuotasTab.tsx`)
- In [ProviderConnectionPanel.tsx](file:///E:/kite/src/components/quota/ProviderConnectionPanel.tsx), add the version & lifecycle block in the CLI tab:
  - Version comparison (`v0.2.29 → v0.2.32`).
  - "Actualizar agente" button with inline progress.
  - "Instalar agente" button when `state === 'not_installed'`.
- In [QuotasTab.tsx](file:///E:/kite/src/components/views/settings/QuotasTab.tsx), add the subtle update indicator badge in the provider list sidebar.

### Slice 5: Quality Verification & Audit
- Unit tests: `src/components/quota/ProviderConnectionPanel.test.tsx` and `src/components/updates/AgentUpdatesBadge.test.tsx`.
- Rust tests in `src-tauri` for semver comparison and command resolution.
- Sanitizer audit: `node .kite/sanitizer/audit-references.mjs --check`.
