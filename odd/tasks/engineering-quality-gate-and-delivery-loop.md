# Engineering Quality Gate & 4-Lane Autonomous Delivery Loop

Objective: Build a reusable, config-driven engineering quality gate and 4-lane delivery workflow (`Proposer -> Builder -> Automated Gate -> Independent Visual/QA Verifier`) that eliminates false-green verification, enforces IPC and visual-language contracts automatically, and removes the human from exploratory manual QA loops.
Branch: `feat/response-thread`.
Test runner: `node --test scripts/quality/quality.test.mjs`, `npm run verify:ipc`, `npm run verify:design`, `npm run verify:gate`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Does not change protected zones (`src/components/TitleBar.tsx` mode switcher).

## Specs

- **S1 — Config-Driven IPC Contract Verifier (`verify:ipc`)**:
  - Verbatim:
    > "cada cosa que se crea no está funcionando a la primera. Por ende, creo que hay un mal proceso de testeo."
    > "La idea sería llegar a crear, em, alguna forma de poder utilizar ahora y también en mucho tiempo después, quiero decir, tenemos que hacer el sistema lo suficientemente bueno. Para solamente ir ajustando cosas pequeñas. Reutilizable, básicamente."
  - Behavior: Parse `tauri::generate_handler![...]` in `src-tauri/src/main.rs` and every `#[tauri::command]` definition under `src-tauri/src/**/*.rs`, then scan all frontend `invoke` / `invokeCommand` calls under `src/**/*.{ts,tsx}` (excluding tests). Report hard errors for any frontend invocation targeting an undefined or unregistered Rust command and detect payload-wrapper mismatches (`invokeCommand` wrapping `{ request }` vs flat-argument commands, or raw `invoke` omitting `{ request }` when Rust expects `request:`). Driven by `scripts/quality/gate.config.json` with `--json` output and exported pure functions for unit testing.
  - Checks: `node --test scripts/quality/quality.test.mjs` (unit tests including intentional broken-IPC sabotage fixtures) and `npm run verify:ipc` against the live repository.

- **S2 — Declarative Diff-Scoped Design & Hygiene Linter (`verify:design`)**:
  - Verbatim:
    > "Inclusive también en cuanto a diseño, quiero decir, hay varias cosas malas. En cuanto a vista y diseño."
    > "tenemos que hacer el sistema lo suficientemente bueno. Para solamente ir ajustando cosas pequeñas. Reutilizable, básicamente."
  - Behavior: Read rule definitions, severity levels, globs, and exclusions from `scripts/quality/gate.config.json`. By default check only modified/added files in git diff (`--base <ref>`, `--staged`, or working tree) so legacy debt never blocks day-one adoption while zero new regressions enter; also support `--all` for full-repo baseline reports and `--files <paths>` for targeted checks. Enforce: (1) no arbitrary CSS `border-radius` values (`AGENTS.md` §1), (2) no Tailwind `rounded-[Npx]` arbitrary radii, (3) no hardcoded `#hex` colors in component CSS outside token/theme files, (4) no raw `<select>` in views (`src/components/views/**`) where `SelectMenu` is required, (5) no silent `catch {}` swallowing around IPC calls in views, (6) no static hardcoded layout/color/radius bloat in inline `style={{}}`, and (7) monolith file-size guardrails on newly added files. Support explicit inline documented escape hatches (`/* kite-design-ok: <reason> */`).
  - Checks: `node --test scripts/quality/quality.test.mjs` (positive + negative fixture assertions) and `npm run verify:design`.

- **S3 — Unified Quality Gate Orchestrator (`verify:gate`) & Verifier Handoff Artifacts**:
  - Verbatim:
    > "¿Podemos llegar a pensar en alguna solución que nos difaga entre proposición de nuevas implementaciones? Prueba de estas mismas."
    > "ahora mismo yo soy el cuello de botella. Y el hecho de tener que probar cada cosa que simplemente. Es el limitante."
  - Behavior: Provide a single reusable CLI (`scripts/quality/verify-gate.mjs`, exposed via `npm run verify:gate`, `npm run verify:gate:fast`, `npm run verify:ipc`, `npm run verify:design`, `npm run verify:quality:test`) that reads `scripts/quality/gate.config.json` to map changed files to affected Vitest suites, Cargo test filters, Rust binary rebuild flags, and Desktop CDP E2E specs. Support `--profile fast|standard|full`, `--dry-run`, `--base <ref>`, `--files`, `--continue-on-error`, and `--skip-e2e` (which explicitly marks the report `INCOMPLETE` and exits non-zero unless `--allow-incomplete` is passed so partial runs can never masquerade as full passes). Emit machine-readable `report.json` and `verifier-handoff.md` under `test-results/quality-gate/<timestamp>/` containing exact command results and paths to every captured E2E screenshot for independent visual review.
  - Checks: `node --test scripts/quality/quality.test.mjs`, `npm run verify:gate -- --dry-run`, and `npm run verify:gate:fast`.

- **S4 — Portable 4-Lane Delivery Loop Contract (`.agents/skills/kite-delivery-loop/` + `AGENTS.md`)**:
  - Verbatim:
    > "¿Podemos llegar a pensar en alguna solución que nos difaga entre proposición de nuevas implementaciones? Prueba de estas mismas."
    > "tenemos que hacer el sistema lo suficientemente bueno. Para solamente ir ajustando cosas pequeñas. Reutilizable, básicamente."
  - Behavior: Author `.agents/skills/kite-delivery-loop/SKILL.md` and `references/verifier-checklist.md` following `.agents/skills/skill-creator/SKILL.md` defining four explicit lanes: (1) **Proposer** (slim vertical slice with IPC contract, UI primitives, and E2E criteria before any write), (2) **Builder** (implements + writes tests + runs `verify:gate`, forbidden from self-approving closeout), (3) **Automated Gate** (`npm run verify:gate` producing `report.json` + `verifier-handoff.md` + CDP PNGs), and (4) **Independent QA & Visual Verifier** (separate read-only agent inspecting every PNG and log against `docs/visual-language.md` and `verifier-checklist.md`, bouncing defects back to Builder up to 2 rounds before human escalation). Register the skill and mandatory pre-closeout gate rules in `AGENTS.md` §4 and §6.
  - Checks: Frontmatter/structure compliance against `skill-creator`, `AGENTS.md` registration, and `node .kite/sanitizer/audit-references.mjs --check`.

- **S5 — Phase 2 (Queued): Desktop CDP E2E Coverage for Blind Views & Loud IPC Errors**:
  - Behavior: Add isolated real-Tauri CDP E2E specs covering `agents-routines`, `settings-tasks`, and `code-diffs`, wire them into `scripts/quality/gate.config.json` `areaMapping`, and replace silent `catch {}` IPC handlers in views with visible error states/logging.
  - Checks: `npm run verify:desktop:e2e` across all new specs plus `--sabotage` verification.

- **S6 — Phase 3 (Queued): Core UI Primitives Kit (`src/components/ui/`) & Live Visual Audit Route**:
  - Behavior: Consolidate core primitives (`Button`, `Field`, `Card`, `Modal`, `Tabs`, `Badge`, `EmptyState`) mapped 1:1 to `docs/visual-language.md` and expose a dev-only `?ui-kit=1` gallery route auditable via CDP screenshots.
  - Checks: Vitest component tests, `npm run verify:design`, and CDP visual audit of `?ui-kit=1`.

## Tasks

### Phase 1 — Reusable Quality Gate Engine & 4-Lane Delivery Contract (Authorized)
- [x] **T1** (`S1–S3`, Risk: `none`, route: `inline`, commit: `300487b`): Create `scripts/quality/gate.config.json`, `scripts/quality/gate.config.schema.json`, `scripts/quality/git-diff-files.mjs`, and RED-first `scripts/quality/quality.test.mjs` covering IPC verification, design linting, diff resolution, and gate area routing. (`node --test scripts/quality/quality.test.mjs`: RED observed -> 13/13 passed)
- [x] **T2** (`S1`, Risk: `none`, route: `inline`, commit: `300487b`): Implement `scripts/quality/verify-ipc.mjs` parsing Rust `generate_handler![]`, `#[tauri::command]` signatures (including Rust lifetimes, raw strings, and hybrid `Option<Value>` handlers), and frontend `invoke`/`invokeCommand` call sites with `legacyBaseline` ratchet and configurable `payloadCheckSeverity`. (`npm run verify:ipc`: 392 registered / 393 commands / 483 calls parsed; surfaced 11 pre-existing broken commands baselined + 12 real payload wrapper mismatches)
- [x] **T3** (`S2`, Risk: `none`, route: `inline`, commit: `300487b`): Implement `scripts/quality/verify-design.mjs` reading declarative rules from `gate.config.json` with diff-scoped default, `--all` baseline mode, and inline documented escape hatches (`/* kite-design-ok: <reason> */`). (`npm run verify:design` on Phase 1 files: 0 errors, 0 warnings; `--all --report-only` scanned 925 files and surfaced 31 blocking debt items)
- [x] **T4** (`S3`, Risk: `item 5 (adds verify:* scripts to package.json)`, route: `inline`, commits: `300487b`, `e740aa4`): Implement `scripts/quality/verify-gate.mjs` (profile orchestration, smart area mapping, deterministic `computeGateVerdict` blocking false-green `INCOMPLETE` / `FAST_ONLY` closeouts, `report.json` + `verifier-handoff.md` generation) and add `verify:ipc`, `verify:design`, `verify:gate`, `verify:gate:fast`, `verify:quality:test` scripts to `package.json`. (`npm run verify:gate -- --dry-run` verified)
- [x] **T5** (`S4`, Risk: `item 3 (updates repo-wide AGENTS.md verification contract & skill index)`, route: `inline`, commit: `pending`): Author `.agents/skills/kite-delivery-loop/SKILL.md` + `references/verifier-checklist.md` and update `AGENTS.md` §4, §5 & §6 to enforce the 4-lane workflow and prohibit closing ODD tasks with skipped E2E. (`audit-references.mjs --check`: clean, 257 files)
- [x] **T6** (`S1–S4`, Risk: `none`, route: `inline + independent verifier`, commit: `pending`): Run Phase 1 verification (`verify:quality:test` 13/13 passed, `verify:ipc` passed with ratchet, `verify:design` 0 errors/0 warnings on slice, `verify:gate --dry-run` passed, `audit-references.mjs --check` clean; note pre-existing unrelated `src/visual-language.test.ts` fails `npx tsc --noEmit` due to missing `@types/node`), independent read-only verifier audit (`thread:d8bae232-f28a-4b1d-913d-491a0ca4fe64`: `APPROVE` across `S1–S4`, all 4 P2 polish items applied and unit-tested), and Engram mirror synced.

### Phase 2 — Blind-Area Desktop CDP E2E Expansion (Pending Authorization)
- [ ] **T7** (`S5`, Risk: `item 3 (updates view IPC error surfacing)`, route: `pending`): Add `agents-routines.e2e.mjs`, `settings-tasks.e2e.mjs`, and `code-diffs.e2e.mjs` CDP specs and register them in `scripts/quality/gate.config.json`.
- [ ] **T8** (`S5`, Risk: `item 3`, route: `pending`): Replace silent IPC `catch {}` blocks across views with visible error feedback + structured warnings and verify via CDP E2E.

### Phase 3 — Core UI Primitives Kit & Visual Catalog (Pending Authorization)
- [ ] **T9** (`S6`, Risk: `item 3 (shared UI primitives)`, route: `pending`): Build core primitives (`Button`, `Field`, `Card`, `Modal`, `Tabs`, `Badge`, `EmptyState`) in `src/components/ui/` mapped 1:1 to `docs/visual-language.md`.
- [ ] **T10** (`S6`, Risk: `none`, route: `pending`): Add dev-only `?ui-kit=1` visual audit route + CDP screenshot verification spec.

## Log

- **L1 (2026-11-25 — Initial Problem Statement & Plan Request)**:
  > "Okey, mira, siento que ahora estamos avanzando bastante, bastante lento en cuanto a el desarrollo. Pruebas. Y avance real en la aplicación, quiero decir, estamos bastante estancados. Me gustaría poder llegar a idear alguna, solución para esto. Quiero decir, ahora mismo yo soy el cuello de botella. Y el hecho de tener que probar cada cosa que simplemente. Es el limitante. ¿Podemos llegar a pensar en alguna solución que nos difaga entre proposición de nuevas implementaciones? Prueba de estas mismas. Em. Y todo, básicamente, porque cada cosa que se crea no está funcionando a la primera. Por ende, creo que hay un mal proceso de testeo. O ese tipo de cosas. Inclusive también en cuanto a diseño, quiero decir, hay varias cosas malas. En cuanto a vista y diseño. Para momento de crear. Frances. Tal como que llegará. Alguna solución para esto. Propónme algo. Algún plan."
  - Audited repository baseline: 393 Rust `#[tauri::command]` endpoints vs 807 Vitest `vi.mock`/`invoke` lines, only 5 desktop E2E specs (all Thread/Voice) across 14 view directories, 142 CSS arbitrary `border-radius` violations, 1,824 inline `style={{}}` occurrences, 1,675 hardcoded `#hex` CSS values, missing core UI primitives in `src/components/ui/`, and recent ODDs closed `[x]` with `verify:desktop:e2e` deferred to manual QA.
  - Proposed a 3-phase reusable 4-lane architecture (`Proposer -> Builder -> Automated Gate -> Independent Visual/QA Verifier`).

- **L2 (2026-11-25 — Phase 1 Authorization & Long-Term Reusability Requirement)**:
  > "si me parece correcto La idea sería llegar a crear, em, alguna forma de poder utilizar ahora y también en mucho tiempo después, quiero decir, tenemos que hacer el sistema lo suficientemente bueno. Para solamente ir ajustando cosas pequeñas. Reutilizable, básicamente. Entonces, quiero que continuemos con eso."
  - Created `odd/tasks/engineering-quality-gate-and-delivery-loop.md` (`S1–S6`, `T1–T10`, with Phase 1 `T1–T6` authorized for immediate execution).

- **L3 (2026-11-25 — Phase 1 Completed & Independently Verified)**:
  - Delivered `scripts/quality/` (`gate.config.json`, `gate.config.schema.json`, `git-diff-files.mjs`, `verify-ipc.mjs`, `verify-design.mjs`, `verify-gate.mjs`, `quality.test.mjs`), `.agents/skills/kite-delivery-loop/` (`SKILL.md`, `references/verifier-checklist.md`), `AGENTS.md` §4–§6 updates, and `package.json` `verify:*` scripts.
  - Immediate live defects uncovered on day 1 by the new gate: 11 pre-existing unregistered/missing IPC calls (ratcheted in `legacyBaseline`), 12 live `{ request }` payload-wrapper mismatches against flat Rust commands (including `voice_call_receipt_*`, `voice_realtime_*`, `voice_audio_start_capture`, `operator_duck_audio`, `save_opencode_api_key`), 31 design/hygiene errors across existing views (16 raw `<select>`, 9 silent IPC `catch {}`, 6 arbitrary `border-radius` in `usageDashboard.css`), and 1 pre-existing `tsc --noEmit` failure in `src/visual-language.test.ts`.
  - Independent read-only verifier (`thread:d8bae232-f28a-4b1d-913d-491a0ca4fe64`) returned `APPROVE` across `S1–S4`; all 4 P2 polish items applied and verified (`verify:quality:test` 13/13 passed, `verify:ipc` passed, `verify:design` 0 errors/0 warnings on slice, `audit-references.mjs --check` clean).
