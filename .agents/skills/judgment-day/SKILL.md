---
name: judgment-day
description: "Trigger: judgment day, dual review, adversarial review, juzgar, audit diff. Run blind dual-perspective review with scoped fix rounds."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.0"
---

## Activation Contract

Load when the user explicitly requests `judgment day`, dual/adversarial review, or deep pre-release audit of a frozen diff, branch, or ODD feature.

## Hard Rules

- **Freeze immutable target first**: establish exact scope (commit SHA, `git diff`, or explicit file paths) before auditing.
- **Zero confirmation bias**: evaluate independently from two blind lenses—**Judge A (Correctness, Security, Concurrency & Shared Contracts)** and **Judge B (Maintainability, Edge Cases, Architecture & Project Conventions)**.
- **Corroborate before fixing**: prioritize severe findings confirmed with concrete `path:line` proof. Treat style preferences and speculative suggestions as `INFO`.
- **Two-round budget max**: allow at most 2 scoped fix + re-judgment passes. If severe issues remain after round 2, STOP and return `JUDGMENT: ESCALATED`.
- **Review is not delivery authority**: passing review never authorizes committing, pushing, or releasing unless separately authorized.

## Decision Gates

| Environment / Condition | Action |
|---|---|
| Multi-agent runtime available (`invoke_subagent` / dispatch) | Spawn two blind read-only judges in parallel using [references/audit-prompts.md](references/audit-prompts.md). Wait for both before deciding. |
| Single-agent runtime (e.g. Google AI Studio) | Execute Pass A cleanly first without softening criteria, then Pass B from scratch against the frozen target; synthesize corroborations. |
| Severe corroborated bugs found (`Round 1`) | Present findings + fix plan, apply atomic fixes in scope only, then run scoped re-judgment on the fix delta. |
| Unverified runtime checks (e.g. Rust/CDP inside cloud IDE) | Record check explicitly as `[NEEDS LOCAL VERIFICATION]`; never invent a pass. |

## Execution Steps

1. Freeze target identity (`commit`/`diff`/`paths`) and load `AGENTS.md` + matching `.agents/skills/*/SKILL.md`.
2. Run blind Judge Pass A and Judge Pass B against the same frozen scope.
3. Merge findings into `Confirmed Severe`, `Suspect / Single-Lens`, and `INFO`.
4. Confirm/apply fixes for `Confirmed Severe` items only (never refactor unrelated code).
5. Run scoped re-judgment over only the frozen findings + fix delta (max 2 rounds).
6. Emit final structured verdict.

## Output Contract

Return target identity, round number (`1` or `2`), counts (`confirmed`, `suspect`, `info`), concrete `path:line` evidence, verification status, and terminal status `JUDGMENT: APPROVED` or `JUDGMENT: ESCALATED`.

## References

- [references/audit-prompts.md](references/audit-prompts.md) — Exact Judge A, Judge B, Fix Actor, and Verdict structures.
