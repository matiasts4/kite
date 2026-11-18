# Diff Viewer Overhaul

Objective: Replace Kite's plain-text, multi-gutter diff tables with a syntax-highlighted, intra-line word-diff engine featuring a single line-number gutter in unified mode, expandable context separators, theme-blended surfaces, a hierarchical file tree, and whitespace/test filters across RightDock Diffs, Files Changes, and Chat approvals/tool logs.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`. Forecast exceeds 400 authored lines (~1,200 authored lines across dependencies, Rust IPC, shared diff engine, file tree, and UI migration); hold git commits until chain/commit preference on `feat/response-thread` is confirmed.
Test runner: `npx vitest run`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run build:vite`, `node .kite/sanitizer/audit-references.mjs --check`.
Confirmed totality (2026-11-12): Full diff engine & UI overhaul below is in scope while keeping Kite's native Git workflow (`CommitBar`, `All`/`Staged`/`Unstaged`, `Focused`/`Stream`, `Stage`/`Unstage`/`Discard`, `Open in editor`) intact. Deferred: branch-base/commit-history comparison picker, inline gutter line selection + review comments into chat composer, and dedicated Diffs Settings section / alternate colorblind palette.

## Specs

### S1. Single-column diff engine, syntax highlighting, intra-line word diffs, and theme adaptation
User words (sanitized): "quiero mejorar la visualizacion de los diffs especificamente porque creo qeu se ven banstnate mal podriamos tomar como lo muestra [reference desktop client] ya que creo que se ve mejor y tambien me molesta esto de que tiene varias columnas de numeraicon" -> confirmed: "si continua con la implementacion".
Acceptance:
- All rendered diffs use `@pierre/diffs` + `@pierre/highlights` (with shared `WorkerPoolManager` using `@pierre/diffs/worker/worker.js?worker` when Workers are supported, and clean non-worker fallback in headless/test environments).
- Unified/stacked mode renders **one single line-number column** (eliminating separate old-number, new-number, and `+`/`-` marker columns); split mode renders clean left/right columns with one line-number column per side.
- Syntax highlighting uses dark (`pierre-dark`) and contrast-adjusted light (`kite-light`) themes synced dynamically with `html[data-theme]`, using subtle `color-mix` additions/deletions tinting and a crisp left border bar (`--diff-addition`, `--diff-deletion`, `--code-background`). Legacy hardcoded hexes (`#0b0f17`, `#121824`, `#ecfdf5`, `#fff1f2`) are removed from diff code styling.
- Intra-line word-level highlighting is enabled (`lineDiffType: "word-alt"`), matching word-level change highlights inside modified lines.
Checks: Unit tests for theme resolution, patch normalization, word-diff & option mapping, and worker pool provider fallback.

### S2. Raw unified patch and workspace-scoped file contents IPC for context expansion
Acceptance:
- `read_workspace_file_diff` in `src-tauri/src/git.rs` stays backward-compatible (`lines`, `truncated`) while adding `rawPatch: Option<String>` containing the canonical unified patch (including untracked-file synthetic unified patches).
- New Tauri command `read_workspace_diff_file_contents` (`workspaceId`, `oldPath`, `newPath`) safely reads old (`HEAD:<oldPath>` via git) and new (working-tree / index) text within the resolved workspace root, rejecting path traversal outside the repository.
- Interactive `"N unmodified lines"` hunk separators (`24px` bar inside the diff viewer) expand surrounding unchanged context lines using `loadDiffFiles` when raw patch + contents are available.
- Diffs constructed solely from legacy `DiffData` (`{ lines, truncated }`) without `rawPatch` synthesize valid patch/metadata cleanly so existing callers and mocks continue working.
Checks: Rust unit tests in `src-tauri/src/git.rs` covering `rawPatch`, untracked synthetic patch generation, `read_workspace_diff_file_contents`, and traversal rejection; TS tests for `DiffData` -> patch/file-metadata conversion and `loadDiffFiles`.

### S3. Unified diff component across RightDock Diffs, Files Changes, and Chat approvals/tool logs
Acceptance:
- `DiffCodeViewer` (`RightDock -> DiffsView`) and `UnifiedDiffView` (`Files -> Changes`, `ChatApprovalCard`, `ChatItemRow` expanded tool diffs) share the same visual diff component and CSS tokens (`Single line-number column`, syntax highlighting, word diffs, theme sync).
- Raw `diff --git` metadata lines are hidden from rendered code rows; split mode pairs sides cleanly; word wrap (`wrap` vs `scroll`) toggles overflow cleanly.
Checks: Component tests in `DiffsView.test.tsx`, `UnifiedDiffView.test.tsx` (or equivalent), `ChangesView`, and `ChatApprovalCard`/`ChatItemRow` regression tests verifying single-column diff rendering and no `diff --git` code rows.

### S4. Sticky 32px file headers, copy path, toolbar filters (`+X -Y`, `Ignore whitespace`, `Hide test files`), and preserved Git workflow
Acceptance:
- File card headers adopt clean `32px` sticky geometry with subtle hover accent bar, status pill, path + hover-reveal copy-path button (`DiffFilePathCopyButton`), per-file `+add -del` badge, and preserved Kite actions (`Stage / Unstage`, `Discard` confirmation, `Open in editor`).
- `DiffsToolbar` (and its narrow overflow menu) adds: total `+X -Y` badge for the current scope, `Ignore whitespace` toggle (`Pilcrow` icon, collapsing whitespace/indentation-only diff lines while preserving real changes), and `Hide test files` toggle (filtering common test/spec filenames cleanly).
- Existing Kite capabilities remain untouched in behavior: repo workspace switcher, `All / Staged / Unstaged` filter, `Focused / Stream` modes, `Expand all / Collapse all`, `Unified / Split`, `Word wrap`, `DiffsCommitBar`, and `diffPreviewNav` turn focus + auto-expand.
Checks: Component & logic tests covering whitespace filtering, test-file filtering, total `+X -Y` aggregation, copy-path action, and all existing `DiffsView.test.tsx` scenarios.

### S5. Hierarchical collapsible `DiffFileTree`
Acceptance:
- Replace the flat list in `DiffFileTree.tsx` with a collapsible folder tree compressing single-child directory chains, sorting directories before files, showing folder icons/chevrons, search filter, status letter, `+add -del` counts, staged badge, active file highlight, and scroll/select behavior for both `Focused` and `Stream` modes.
Checks: Pure tree-builder unit tests + component interaction tests (`folder` collapse/expand, search filter, clicking file selects & focuses).

## Tasks

- T1 — Foundation: install `@pierre/diffs` + `@pierre/highlights`, build worker pool provider, light/dark syntax theme tokens, `DiffData`/string patch normalizers, whitespace-hiding + test-file predicates, and unit tests. (S1, S2, S4) — route: inline. Status: done.
- T2 — Rust IPC & git client bridge: extend `WorkspaceFileDiff` with `rawPatch`, add `read_workspace_diff_file_contents` in `src-tauri/src/git.rs` + register in `main.rs`, update `src/lib/ipc/git.ts` + `src/components/views/files/gitTypes.ts`, add Rust & TS tests. (S2) — route: parallel writer (disjoint Rust/IPC surface via `41ba9986`). Status: done.
- T3 — Core diff UI & inline migration: build shared `@pierre/diffs` React renderer (`KiteDiffView`), migrate `DiffCodeViewer.tsx` and `UnifiedDiffView.tsx`, wire theme/shadow-DOM CSS + word-diff + `loadDiffFiles` context expansion + Vite ES worker format, update/add tests. (S1, S2, S3) — route: inline. Status: done.
- T4 — RightDock `DiffsView` polish: hierarchical `DiffFileTree`, sticky `32px` headers + copy-path button, `Ignore whitespace` / `Hide test files` / global `+X -Y` toolbar + narrow menu, per-file stat extraction, and tests. (S4, S5) — route: inline. Status: done.
- T5 — End-to-end verification: `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run build:vite`, `node .kite/sanitizer/audit-references.mjs --check`, plus independent verifier for high-risk dependency/contract changes. (S1–S5) — route: delegated verifier + inline checks. Status: done (commits pending user delivery decision).

## Log

- **L1. 2026-11-12.** User request (sanitized for public spec; verbatim copy stored in `.kite/tasks/diff-viewer-overhaul-reference.md`):
  > quiero mejorar la visualizacion de los diffs especificamente porque creo qeu se ven banstnate mal podriamos tomar como lo muestra [reference desktop client] ya que creo que se ve mejor y tambien me molesta esto de que tiene varias columnas de numeraicon
  Confirmation (verbatim):
  > si continua con la implementacion
- **L2. 2026-11-12.** Completed full surface inventory across Kite (`DiffsView`, `DiffCodeViewer`, `UnifiedDiffView`, `ChangesView`, `ChatApprovalCard`, `ChatItemRow`, `diffs.css`, `chat.css`, `chunks.css`, `src-tauri/src/git.rs`) and reference implementation. Confirmed CSP (`null` in `tauri.conf.json`) and React 18 compatibility (`@pierre/diffs@1.6.4`). Created `odd/tasks/diff-viewer-overhaul.md` and internal blueprint `.kite/tasks/diff-viewer-overhaul-reference.md`.
- **L3. 2026-11-12.** Completed T1–T4 implementation: added `@pierre/diffs@1.6.4` + `@pierre/highlights@0.4.0`, Rust `rawPatch` + `read_workspace_diff_file_contents`, `KiteDiffView` + `DiffWorkerPoolProvider` + `DiffStatBadge` + `DiffFilePathCopyButton`, migrated `DiffCodeViewer` & `UnifiedDiffView` (passing `filePath`/`status` context from `ChangesView` & `ChatItemRow`), upgraded `DiffFileTree` (`diffFileTree.logic.ts`), sticky `32px` headers, toolbar `+X -Y` / `Ignore whitespace` / `Hide test files` toggles, and set `worker: { format: 'es' }` in `vite.config.ts` to support code-split WASM language chunks in Web Workers.
- **L4. 2026-11-12.** Addressed independent verifier findings: wired `externalGitService`, `refreshNonce` cache busting (using structural `getWorkspaceChangesSignature` + `gitLoading`/`gitBusy` completion detection to avoid object-identity re-render loops), and `loadDiffFiles` in both `DiffsView` and `FilesView`/`ChangesView`; enforced `validate_repo_relative_path` after Windows backslash normalization on `untracked` diffs in `git.rs`; preserved non-patch text fallback in `UnifiedDiffView` and `ChatApprovalCard`; clamped `.diff-view` width and enabled hover/focus-reveal on `.kite-diff-copy-btn`; added tests in `ChatApprovalCard.test.tsx`, `ChatItemRow.test.tsx`, `DiffsView.test.tsx`, and `git.rs`.
