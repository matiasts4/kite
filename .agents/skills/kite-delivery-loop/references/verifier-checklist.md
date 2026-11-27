# Proposer Slice Contract, Tier Selection & Visual Verifier Checklist

Reference document for `.agents/skills/kite-delivery-loop/SKILL.md`.

---

## 0. Verification Tier Selection & Build/Release Boundary

Choose the lowest tier that truthfully covers the change:

| Tier | Applies When | Gate Command | Visual Review |
| :--- | :--- | :--- | :--- |
| **Tier 1 — Micro / Non-Visual** | Copy/label edits, static assets/wallpapers, unit tests, pure TS/Rust logic with no layout change and no new IPC | `npm run verify:gate -- --tier micro` (or `verify:gate:fast` when only non-UI/test files changed) | None (0 E2E, 0 subagent) |
| **Tier 2 — Scoped Visual** | Bounded visual/CSS/state tweak inside 1 view/component, no shell/cross-view layout change, `Risk: none` | `npm run verify:gate -- --tier scoped --spec <spec>` (`--rebuild-rust` if Rust changed) | **Inline**: inspect only the 1–2 relevant PNGs of that view (no Verifier subagent) |
| **Tier 3 — Large / Feature / Structural** | New feature/view, multi-view or shell/primitives change, new/changed IPC contract, or `Risk: item 1–6` | `npm run verify:gate` (`--rebuild-rust` if Rust changed) | **Independent Verifier subagent**: full `1366x840` + `960x680` screenshot audit |
| **Build / Release Only** | Packaging already-verified ODD work (`npm run release`, `release:fast`, `build:installer`, `update`) | `npm test` / `release:fast` (or `--skip-tests` if tests just passed with no edits) | None — E2E already ran at ODD closeout; reserve `--profile full` for manual milestone audits |

### Mandatory Tier 2 -> Tier 3 Escalation Triggers
Escalate immediately to **Tier 3** if the change:
- modifies `src/App.tsx`, `TitleBar.tsx`, `Sidebar.tsx`, `RightDock.tsx`, `src/visual-language.css`, or shared `src/components/ui/` primitives;
- spans more than one decoupled view area in `scripts/quality/gate.config.json`;
- adds or alters a `#[tauri::command]` IPC contract; or
- carries any `Risk: item 1–6`.

---

## 1. Lane 1 — Proposer Slice Contract

- **Tier 3**: Required in full (5 items below) before writing code and STOP for user approval.
- **Tier 2**: Concise 1-paragraph scope naming the target view, expected visual state, and `--spec <slug>`.
- **Tier 1**: Skipped (implement inline).

Tier 3 Proposer items:
1. **User-visible flow**: One end-to-end outcome a user can trigger and observe.
2. **IPC contract**: Exact `#[tauri::command]` names, registration in `src-tauri/src/main.rs`, and payload wrapper shape (`request: Value` via `invokeCommand` vs flat args via `invokeFlatCommand`).
3. **UI primitives & copy**: Which `src/components/ui/` components and `docs/visual-language.md` tokens are used, and consistent UI copy language.
4. **Automated proof**: Which Vitest/Cargo tests AND which `scripts/e2e/specs/*.e2e.mjs` scenario + CDP screenshots prove the slice works live.
5. **Risk line**: `Risk: item N (reason)` or `Risk: none` per `odd-workflow`.

---

## 2A. Tier 2 — Scoped Inline Visual Check

When `verify:gate -- --tier scoped --spec <slug>` completes:
1. Confirm `report.json` verdict is `PASS` (`verify:ipc` and `verify:design` report 0 errors).
2. Read the 1–2 relevant PNGs for the modified component/view inline via file read (no separate Verifier subagent required).
3. Confirm intentional states render cleanly with zero clipping, overlap, horizontal overflow, or errors in `process-logs.txt`.
4. Escalate to Tier 3 (`--tier large` + Independent Verifier) if a cross-view regression appears.

---

## 2B. Tier 3 — Lane 4 Independent QA & Visual Verifier Rubric

The Verifier runs in a **fresh read-only context** (never the Builder that authored the slice) and inspects `verifier-handoff.md`, `report.json`, `process-logs.txt`, and every captured PNG.

### A. Hard Automated Gate Checks (Instant `REJECT` on Failure)
- [ ] `report.json` verdict is `PASS` (NEVER approve `FAILED`, `INCOMPLETE`, or `FAST_ONLY` for a Tier 3 UI/runtime slice).
- [ ] `verify:ipc` reports `0` broken commands and zero unaddressed payload wrapper mismatches on changed files.
- [ ] `verify:design` reports `0` blocking violations on changed files (and no unjustified `kite-design-ok:` escapes).
- [ ] Zero uncaught runtime errors, blank fallback states, or Rust panics in `process-logs.txt`.

### B. Visual & Layout Inspection (Read Every Captured PNG via File Read)
Inspect both standard (`1366x840`) and compact (`960x680`) captures plus feature-specific milestone PNGs:
- [ ] **Alignment & Geometry**: Zero overlapping controls, clipped text, horizontal scrollbars, or misaligned baselines.
- [ ] **Visual Language Fidelity (`docs/visual-language.md` & `AGENTS.md` §1–§2)**:
  - Radii match 4-tier tokens (`4/6px` micro, `8px` control, `12px` card, `14px` dialog).
  - Control heights match `26/28px` compact, `32px` standard, `38px` hero with no vertical jumps between adjacent controls.
  - Surfaces use canvas / raised / overlay hierarchy with legible contrast and consistent stroke weights (`12%` rest / `22%` emphasis).
- [ ] **Component & Copy Consistency**: No stray raw HTML `<select>`, unstyled inputs, or mixed UI copy languages within the same view.
- [ ] **Real States Visible**: Interactive states, empty states, and error states render intentionally (no stuck spinners or silent empty panels).

### C. Verifier Output Format
Return strictly:
- **Verdict**: `APPROVE` or `REJECT`
- **Inspected Artifacts**: List every PNG and log file actually read.
- **Defects (if `REJECT`)**: Numbered list with exact `file:line` or screenshot name, observed defect, and concrete fix required.
