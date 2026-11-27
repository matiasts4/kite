---
name: kite-delivery-loop
description: "Trigger: new feature, UI fix, verify slice, delivery loop, quality gate, release build. Calibrate Tier 1/2/3 verification and separate builds from E2E."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.1"
---

## Activation Contract

Load before proposing, verifying, or closing changes — or packaging a release — in Kite Code.

## Hard Rules

- **Lowest honest tier** (`references/verifier-checklist.md` §0): **Tier 1** (micro), **Tier 2** (scoped visual), or **Tier 3** (full 4-lane).
- **Build / Release separation**: `release`, `release:fast`, `build:installer`, and `update` run unit tests + build only (or `--skip-tests` if green) and **never** re-run `verify:gate`, CDP E2E, or Verifier. Reserve `--profile full` for manual milestone audits.
- **No false-green closeouts**: never close Tier 2/3 ODD tasks `[x]` on `FAILED`, `INCOMPLETE`, or `FAST_ONLY`; Tier 1 closes on `--tier micro` `PASS`.
- **Static gates**: every code tier runs `verify:ipc` and `verify:design` via `verify:gate`.

## Decision Gates

| Situation | Action |
|---|---|
| Tier 1 (copy, assets, tests, logic) | `npm run verify:gate -- --tier micro` (`verify:gate:fast` if no `.tsx`/`.css` changed). |
| Tier 2 (1-view tweak, `Risk: none`) | `npm run verify:gate -- --tier scoped --spec <spec>` (`--rebuild-rust` if Rust); check 1–2 PNGs (§2A). |
| Escalation (shell/UI kit, >1 area, IPC, `Risk: item 1–6`) | Escalate to **Tier 3**. |
| Tier 3 (feature/structural/IPC/risk) | Proposer (§1) -> approval -> Builder -> `verify:gate` -> Verifier (§2B). |
| Build / Release | Unit tests (`npm test` / `release:fast` / `--skip-tests`) + build only; no E2E. |
| Cloud sandbox / Verifier `REJECT` | Mark CDP/Cargo `[NEEDS LOCAL VERIFICATION]`; on `REJECT`, fix & re-verify (max 2 rounds). |

## Execution Steps

1. Classify Tier (`references/verifier-checklist.md` §0).
2. Tier 1/2: RED -> GREEN (`ui/` + typed IPC); verify via `--tier micro` or `--tier scoped --spec` + §2A.
3. Tier 3: Lanes 1–4 (`Proposer -> Builder -> verify:gate -> Verifier`).
4. Build/Release: unit tests + build only.

## Output Contract

Report: Tier, ODD (`S#`, `T#`), gate/build verdict, inspected PNGs + Verifier verdict (Tier 2/3), and `Risk:` line.

## References

- [references/verifier-checklist.md](references/verifier-checklist.md) — Tier matrix, escalation, Proposer, §2A/§2B.
- [../../../scripts/quality/gate.config.json](../../../scripts/quality/gate.config.json) — IPC/design & area routing.
- [../kite-desktop-qa/SKILL.md](../kite-desktop-qa/SKILL.md) — Desktop CDP E2E & sabotage.
- [../../../docs/RELEASING.md](../../../docs/RELEASING.md) — Release packaging rules.
