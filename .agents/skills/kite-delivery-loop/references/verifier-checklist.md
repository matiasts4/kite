# Proposer Slice Contract & Independent Visual/QA Verifier Checklist

Reference document for `.agents/skills/kite-delivery-loop/SKILL.md`.

---

## 1. Lane 1 — Proposer Slice Contract (Required Before Writing Code)

Every proposed vertical slice must state these 5 items concisely before authorization:

1. **User-visible flow**: One end-to-end outcome a user can trigger and observe.
2. **IPC contract**: Exact `#[tauri::command]` names, registration in `src-tauri/src/main.rs`, and payload wrapper shape (`request: Value` via `invokeCommand` vs flat args).
3. **UI primitives & copy**: Which `src/components/ui/` components and `docs/visual-language.md` tokens are used, and consistent UI copy language.
4. **Automated proof**: Which Vitest/Cargo tests AND which `scripts/e2e/specs/*.e2e.mjs` scenario + CDP screenshots prove the slice works live.
5. **Risk line**: `Risk: item N (reason)` or `Risk: none` per `odd-workflow`.

---

## 2. Lane 4 — Independent QA & Visual Verifier Rubric

The Verifier runs in a **fresh read-only context** (never the Builder that authored the slice) and inspects `verifier-handoff.md`, `report.json`, `process-logs.txt`, and every captured PNG.

### A. Hard Automated Gate Checks (Instant `REJECT` on Failure)
- [ ] `report.json` verdict is `PASS` (NEVER approve `FAILED`, `INCOMPLETE`, or `FAST_ONLY` for a UI/runtime slice).
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
