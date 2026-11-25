# Kite Code — Agent Guidelines

Kite Code is a focused desktop client for autonomous coding agents.

This document serves as the single source of truth for AI agents contributing code to this repository. Its rules prevent design drift, architectural fragmentation, and guesswork.

---

## 1. Visual Language & Corner Radius System

To maintain tight aesthetic cohesion across all desktop surfaces, Kite enforces a **4-tier semantic radius system** anchored in CSS variables and mapped directly in `tailwind.config.js`.

### The Radius Contract

| Semantic Tier | Token | Value | Tailwind Utilities | Primary Use Cases |
| :--- | :--- | :--- | :--- | :--- |
| **Micro** | `--vl-radius-xs` / `--vl-radius-sm` | **4px / 6px** | `rounded-xs`, `rounded-sm` | Checkboxes, keycap badges, micro-tags, chips, small pill labels. |
| **Control (Universal)** | `--control-radius` (`--vl-radius-md`) | **8px** | `rounded-control`, `rounded-md` | **All interactive elements**: Buttons (`.primary-button`, `.chrome-button`), inputs (`.ui-field`), select triggers, sidebar items, dropdown rows, segmented items. |
| **Container / Card** | `--card-radius` (`--vl-radius-lg`) | **12px** | `rounded-card`, `rounded-lg` | Surface cards (`.ui-card`), agent tiles, code preview blocks, panels, chat containers. |
| **Dialog / Overlay** | `--dialog-radius` (`--vl-radius-xl`) | **14px** | `rounded-dialog`, `rounded-xl` | Floating modals, dialog backdrops, overlay sheets, major drawers. |
| **Pill / Circle** | `--pill-radius` | **9999px / 50%** | `rounded-full`, `rounded-pill` | Avatars, status dots, toggle switches, stadium buttons. |

### Strict Rules for Agents

1. **NO Arbitrary Pixel Radii**:
   - ❌ Never write arbitrary ad-hoc values like `border-radius: 2px`, `3px`, `5px`, `7px`, `9px`, `10px` in CSS.
   - ❌ Never use inline arbitrary Tailwind classes like `rounded-[7px]` or `rounded-[10px]`.
   - ✅ Always use the semantic tokens (`var(--control-radius)`, `var(--card-radius)`, `var(--dialog-radius)`) or standard utilities (`rounded-control`, `rounded-card`, `rounded-dialog`, `rounded-md`, `rounded-lg`, `rounded-sm`, `rounded-full`).

2. **Optical Nesting (Concentric Borders)**:
   - When rendering simulated borders or inset rings using pseudo-elements (`before:` or `after:`), subtract `1px` so the inner line remains concentric and free of corner artifacts:
     ```css
     border-radius: var(--control-radius); /* 8px */
     /* Pseudo inner border */
     &::before {
       border-radius: calc(var(--control-radius) - 1px); /* 7px */
     }
     ```

---

## 2. Control Sizing & Height Standards

To prevent jarring height jumps when users navigate across lateral tabs and panels, interactive elements must adhere to the 3-tier control height standard:

| Control Tier | Token | Value | Applied To |
| :--- | :--- | :--- | :--- |
| **Standard (Default)** | `--vl-control-md` | **32px** | View header action buttons (`.primary-button`, `.tickets-new`), search fields (`.ui-field`, `.tickets-search`), select dropdown triggers. |
| **Compact (Dense)** | `--control-row` / `--vl-control-sm` | **28px / 26px** | Toolbar navigation buttons, address bar inputs, secondary action buttons, sidebar rows, filter chips. |
| **Hero / Large** | `--vl-control-lg` | **38px** | Prominent hero inputs, splash actions. |

### Strict Rules for Agents
- ❌ Never declare arbitrary ad-hoc inline heights like `height: 20px`, `22px`, `24px`, `30px`, `34px` for buttons or inputs.
- ✅ Always use standard 32px height for view header search inputs and primary action buttons.
- ✅ Always use 26px or 28px for compact toolbar icon buttons.

---

## 3. Protected Zones (Do Not Alter)

- **TitleBar Mode Switcher**:
  The stadium pill toggle in `src/components/TitleBar.tsx` (`mode-toggle--stadium` for `Agent | Code | Thread`) and its sliding motion indicator (`layoutId="titlebar-mode-toggle-indicator"`) is a signature brand element. **Do not modify its geometry, padding, or motion behavior.**

---

## 4. Architecture & Task Discipline

1. **Dual-Tier ODDs**:
   - Public task specifications live under `odd/tasks/<slug>.md`. They must be 100% product-focused and clean of external donor or cloning references.
   - Internal investigation tasks live under `.kite/tasks/<slug>.md` (gitignored).
   - A correction that belongs to an existing ODD updates that document in the same change: append the user's words to `## Log`, rewrite the affected `S#`, and reopen or add the linked task. Do not leave the fix floating only in code.
2. **Quality Verification & 4-Lane Delivery Gate**:
   - Follow `.agents/skills/kite-delivery-loop/SKILL.md` for every non-trivial feature or UI slice: **Proposer** (slim vertical slice + IPC/UI/E2E contract) -> **Builder** (`npm run verify:gate:fast` during iteration) -> **Automated Gate** (`npm run verify:gate`) -> **Independent QA & Visual Verifier** (separate read-only agent inspecting `verifier-handoff.md` and captured CDP PNGs).
   - Run `npm run verify:ipc` and `npm run verify:design` (included inside `npm run verify:gate`) to enforce real Rust `generate_handler![]` parity, design tokens, and zero silent IPC `catch {}` blocks.
   - Never mark an ODD verification task `[x]` if `verify:gate` returned `FAILED`, `INCOMPLETE` (`--skip-e2e`), or `FAST_ONLY` on a UI/runtime slice.
   - For real desktop UI, streaming, orchestration, and layout verification over CDP, run `npm run verify:desktop:e2e` (see [docs/qa/catalog.md](docs/qa/catalog.md) and local skill `kite-desktop-qa`).
   - Before any commit or push, run `node .kite/sanitizer/audit-references.mjs --check`.
3. **Matching another product**:
   - Write gate: inventory the source as a person and as an agent before any code. Cover how the feature is delivered, how it is read, how it is shown, CLI, flags, env gates, instruction/skill loading, engines, lifecycle, panes, persistence, and every other user-visible behavior of the requested feature.
   - A missing instruction channel, environment gate, skill-file install, or presentation detail is a missed feature.
   - Discovery before specs: suggest every copyable part with its behavior and look, confirm totality, then land detailed `S#` on the ODD. Do not implement one slice as the whole feature.
   - Public `odd/tasks`, docs, UI copy, and comments stay product-focused. They never name the source product. Internal notes live under `.kite/tasks/` (gitignored).
   - Follow `.agents/skills/port-from-product/SKILL.md` when triggered.
4. **Manual QA Task Handoff (Key Areas)**:
   - For changes touching **Voice Mode**, **Zed / SETH Assistant**, or **Agent / Orchestration**, follow `.agents/skills/qa-task-handoff/SKILL.md`: propose **one consolidated verification task** in **Kite Tasks** (with `oddPath`, `sourceAgent`, and `sourceThreadId` traceability) at closeout and wait for user confirmation unless explicitly requested.

---

## 5. Repository Architecture & Environment Boundary

| Path | Ownership & Purpose |
| :--- | :--- |
| `src/` | React 18 + TypeScript + Vite frontend (`App.tsx`, `views/chat`, `views/agents`, `views/subagents`, `views/diffs`, `views/settings`, `sidebar/`, `lib/operator/`, `motion/`). |
| `src-tauri/src/` | Rust / Tauri 2 native backend (`chat/`, `acp/`, `agent_mind/`, `agents.rs`, `dispatch/`, `dispatch_wire/`, `persist.rs`, `operator_runtime.rs`, `terminal/`, `vt_engine/`). |
| `src-tauri/crates/kite-ctx/` | Standalone pure-Rust context optimization crate (`lossless`, `cmd_filters`, `crusher`, `ccr_store`, `read_cache`, `shared_ctx`, `kv_aligner`, `ledger`, `hooks`). |
| `odd/tasks/*.md` | Public clean-room Organic Driven Development (ODD) feature specs (`Header -> ## Specs -> ## Tasks -> ## Log`). |
| `docs/` | Project architecture, QA catalog (`docs/qa/catalog.md`), release guides, and AI Studio setup (`docs/AI_STUDIO_AGENT_SETUP.md`). |
| `.agents/skills/` | Portable LLM-first runtime skill contracts shared across local agents and GitHub-synced cloud environments. |
| `scripts/e2e/` | Playwright CDP verification specs against real Windows Tauri WebView2 builds (`npm run verify:desktop:e2e`). |
| `scripts/quality/` | Config-driven reusable quality gate (`gate.config.json`, `verify-ipc.mjs`, `verify-design.mjs`, `verify-gate.mjs`). |

### Cloud / Browser Sandboxes (e.g., Google AI Studio Build) vs Local Machine
- **Supported in browser/cloud sandboxes**: Reading repo files and `.agents/skills/`, authoring/updating `odd/tasks/*.md` specs and `docs/`, React/CSS/TypeScript edits, `npx tsc --noEmit`, `npx vitest run`, and Vite builds when Node deps are present.
- **Local-only (mark `[NEEDS LOCAL VERIFICATION]` if working from cloud)**: Rust/Cargo (`cargo test --manifest-path src-tauri/Cargo.toml --workspace`), Tauri native desktop CDP tests (`npm run verify:desktop:e2e`), Windows process/Job Object checks, local Engram/CodeGraph tools, and `node .kite/sanitizer/audit-references.mjs --check`.

---

## 6. Portable Agent Skills Registry (`.agents/skills/`)

Before executing matching work, read the full `SKILL.md` file rather than guessing from memory:

| Skill | Trigger / When to Load | Path |
| :--- | :--- | :--- |
| `odd-workflow` | ODD specs, task sizing, `Risk:` lines, RED/GREEN test-first workflow, requirement sync | [`.agents/skills/odd-workflow/SKILL.md`](.agents/skills/odd-workflow/SKILL.md) |
| `work-unit-commits` | Splitting changes into commits, Conventional Commits, PR slices, clean commit hygiene | [`.agents/skills/work-unit-commits/SKILL.md`](.agents/skills/work-unit-commits/SKILL.md) |
| `judgment-day` | Explicit adversarial/dual review (`judgment day`, `juzgar`, blind pre-release diff audit) | [`.agents/skills/judgment-day/SKILL.md`](.agents/skills/judgment-day/SKILL.md) |
| `port-from-product` | Feature parity requests (`copy from`, `match`, `parity`, `port`) and full surface inventories | [`.agents/skills/port-from-product/SKILL.md`](.agents/skills/port-from-product/SKILL.md) |
| `cognitive-doc-design` | Writing or refactoring guides, READMEs, RFCs, or review docs with low cognitive load | [`.agents/skills/cognitive-doc-design/SKILL.md`](.agents/skills/cognitive-doc-design/SKILL.md) |
| `kite-delivery-loop` | Feature proposals, UI slices, `verify:gate`, Proposer -> Builder -> Independent Visual/QA Verifier workflow | [`.agents/skills/kite-delivery-loop/SKILL.md`](.agents/skills/kite-delivery-loop/SKILL.md) |
| `kite-desktop-qa` | Desktop E2E, Tauri CDP verification, layout matrix, and sabotage fault checks | [`.agents/skills/kite-desktop-qa/SKILL.md`](.agents/skills/kite-desktop-qa/SKILL.md) |
| `qa-task-handoff` | QA task, manual test, testeo pendiente, crear en Tasks for Voice Mode, Zed/SETH, and Agent | [`.agents/skills/qa-task-handoff/SKILL.md`](.agents/skills/qa-task-handoff/SKILL.md) |
| `skill-creator` | Creating or updating skills inside `.agents/skills/` | [`.agents/skills/skill-creator/SKILL.md`](.agents/skills/skill-creator/SKILL.md) |
