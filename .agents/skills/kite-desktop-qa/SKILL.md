---
name: kite-desktop-qa
description: "Trigger: desktop E2E, Tauri verification, CDP tests, sabotage gate, Kite QA. Verify Kite Code desktop UI and IPC flows over CDP."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.1"
---

## Activation Contract

Load this skill before running, extending, or debugging desktop UI, IPC streaming, orchestration, or layout verification in Kite Code.

## Hard Rules

- Test the real Tauri + WebView2 desktop binary over CDP (`npm run verify:desktop:e2e`); never treat the legacy `dev:browser` mock lane as desktop proof.
- Isolate every run in a fresh sandbox (`HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `KITE_STATE_DIR`, `KITE_SETTINGS_PATH`, isolated SQLite DB, and workspace copy); never mutate developer state or credentials.
- Interact through real focus and pointer hit-testing (`assertVisibleAndClickableRect`); never bypass hit-testing with forced pointer options or fake state shortcuts.
- On Windows, inject scripted providers via native executable shims (`win-shim-v1.exe`), never `.cmd` wrappers that truncate multiline prompts at newlines.
- Visually inspect every captured milestone PNG and `FAILURE-state.png` via file read before reporting a pass or diagnosing a failure.
- Confirm any newly added assertion catches real faults via `--sabotage=overlay` or `--sabotage=ipc-drop`.

## Decision Gates

| Symptom or Goal | Action |
|---|---|
| Verify UI shell & TitleBar | Run `npm run verify:desktop:e2e -- --spec desktop-smoke`. |
| Verify Thread deltas & switching | Run `npm run verify:desktop:e2e -- --spec thread-streaming`. |
| Verify subagents, swarms, errors | Run `npm run verify:desktop:e2e -- --spec orchestration`. |
| Verify compact/standard geometry | Run `npm run verify:desktop:e2e -- --spec ui-layout`. |
| Prove assertions reject real bugs | Run `--sabotage=overlay` on `desktop-smoke` and `--sabotage=ipc-drop` on `thread-streaming`. |
| Change touches `src-tauri/` | Rebuild debug binary with `cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin kite-code` so it serves live Vite (`127.0.0.1:1420`) rather than embedded `dist/`. |

## Execution Steps

1. Start only the target spec (`--spec <slug>`) or full suite (`npm run verify:desktop:e2e`) in an isolated sandbox.
2. Wait for natural completion; never cancel or timeout-guess active runs prematurely.
3. Inspect captured PNGs, `driver-calls.jsonl`, and `process-logs.txt` under `test-results/e2e/<timestamp>/<SPEC-ID>/`.
4. Separate genuine product regressions (e.g., Rust dispatch state errors or CSS overlap) from E2E harness issues; never weaken fake drivers to mask product bugs.

## Output Contract

Report exact commands run, pass/fail status per spec ID, sabotage gate verdicts, inspected PNG/log artifact paths, and any real product bugs surfaced.

## References

- [scripts/e2e/run.mjs](../../../scripts/e2e/run.mjs) — CDP runner, spec filtering, and `--sabotage` fault injector.
- [scripts/e2e/assertions.mjs](../../../scripts/e2e/assertions.mjs) — Tauri shell, hit-test, overflow, and overlap assertions.
- [docs/qa/catalog.md](../../../docs/qa/catalog.md) — Desktop E2E scenario registry and legacy HTTP mock catalog.
