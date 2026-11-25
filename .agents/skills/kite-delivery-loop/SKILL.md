---
name: kite-delivery-loop
description: "Trigger: new feature, implement UI, verify slice, delivery loop, quality gate, visual QA. Enforce Proposer -> Builder -> Automated Gate -> Independent Verifier."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.0"
---

## Activation Contract

Load at the start of any feature proposal, UI/backend implementation slice, or closeout verification in Kite Code.

## Hard Rules

- **Separate proposal, build, and approval**: the agent that writes code NEVER self-approves an ODD closeout or skips live verification.
- **Vertical slices only**: propose and deliver one end-to-end usable slice at a time (IPC + UI + tests + E2E), never multi-thousand-line waves deferred to manual QA.
- **No false-green closeouts**: NEVER mark an ODD verification task `[x]` if `npm run verify:gate` returned `FAILED`, `INCOMPLETE`, or `FAST_ONLY` on a UI/runtime slice.
- **IPC & design gates are mandatory**: every slice must pass `npm run verify:ipc` (real Rust `generate_handler![]` match) and `npm run verify:design` (tokens, no raw `<select>`, no silent IPC `catch {}`).
- **Visual inspection is mandatory for UI**: an independent read-only Verifier must inspect every captured desktop CDP PNG (`1366x840` and `960x680`) against `docs/visual-language.md` and `references/verifier-checklist.md`.
- **Bounded auto-fix loop**: if the Verifier returns `REJECT`, return exact defects to Builder for at most **2 automated fix rounds** before escalating to the user.

## Decision Gates

| Situation | Action |
|---|---|
| Starting a new feature or UI change | Run **Lane 1 (Proposer)**: present slice scope, exact IPC commands, UI primitives, E2E spec, and `Risk:` line; STOP for user approval. |
| Builder iterating locally | Run `npm run verify:gate:fast` during inner loop; fix every IPC/design/test error before requesting verification. |
| Slice touches `src-tauri/` | Run `npm run verify:gate -- --rebuild-rust` so WebView2 CDP tests execute against the updated binary. |
| Slice touches any `.tsx` or `.css` view | Run `npm run verify:gate`, then spawn an independent read-only **Verifier** agent with `verifier-handoff.md` and all PNGs. |
| Running in cloud/browser sandbox without Tauri/Cargo | Run `verify:ipc`, `verify:design`, `tsc`, `vitest`; mark local CDP/Cargo stages `[NEEDS LOCAL VERIFICATION]` and never claim full desktop pass. |
| Verifier returns `REJECT` | Bounce defect list (`file:line` + screenshot findings) to Builder; re-run `verify:gate` and re-verify (max 2 rounds). |

## Execution Steps

1. **Lane 1 — Proposer**: Read target area + `scripts/quality/gate.config.json`. Output the concise vertical slice contract from `references/verifier-checklist.md` §1 and wait for approval.
2. **Lane 2 — Builder**: Implement RED -> GREEN using existing `src/components/ui/` primitives and typed IPC helpers (zero silent `catch {}`). Run `npm run verify:gate:fast`.
3. **Lane 3 — Automated Gate**: Run `npm run verify:gate` (with `--rebuild-rust` if Rust changed) to generate `test-results/quality-gate/<timestamp>/report.json` and `verifier-handoff.md`.
4. **Lane 4 — Independent Visual & QA Verifier**: Delegate a fresh read-only agent with `verifier-handoff.md`, `references/verifier-checklist.md`, and every captured PNG.
5. **Human Review Package**: Only after Verifier returns `APPROVE`, present the user a concise summary with verified commands, screenshot paths, and `Risk:` line.

## Output Contract

Report: slice ODD reference (`S#`, `T#`), `verify:gate` verdict and `verifier-handoff.md` path, independent Verifier verdict (`APPROVE` / `REJECT` + round count), visually inspected PNG paths, and final `Risk:` line.

## References

- [references/verifier-checklist.md](references/verifier-checklist.md) — Proposer slice contract and Independent Visual & QA Verifier rubric.
- [../../../scripts/quality/gate.config.json](../../../scripts/quality/gate.config.json) — Single declarative config for IPC, design rules, and area-to-E2E routing.
- [../kite-desktop-qa/SKILL.md](../kite-desktop-qa/SKILL.md) — Isolated Tauri + WebView2 CDP execution and sabotage gates.
- [../../../docs/visual-language.md](../../../docs/visual-language.md) — Kite visual language tokens, heights, radii, and surfaces.
