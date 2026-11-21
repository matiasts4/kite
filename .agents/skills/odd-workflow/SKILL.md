---
name: odd-workflow
description: "Trigger: ODD, odd/tasks, spec, feature plan, Risk line, task sizing. Execute Organic Driven Development and track features."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.0"
---

## Activation Contract

Load at the start of any feature request, bugfix, architecture proposal, or change that inspects or edits code, docs, or `odd/tasks/*.md`.

## Hard Rules

- **Authorize first**: investigation, explanation, audit, review, and planning requests are read-only until change intent is explicit. If ambiguous, ask one focused question and remain read-only.
- **Explore before proposing**: inspect relevant code, `AGENTS.md`, and existing `odd/tasks/*.md` proportionately first.
- **Verbatim specs, zero scope creep**: `## Specs` and `## Log` quote user strings, commands, and errors verbatim. Never invent unrequested features; mark assumptions explicitly.
- **Small vs Large**: never classify by counting files, lines, or tests. Classify as **large** only if resuming from original request + `git diff` alone would fail. Small tasks stay inline with no durable ODD file.
- **Sync ODD on follow-ups**: corrections to an existing feature append the user's words to `## Log`, update only affected `S#`, and reopen/add linked tasks in the same change.
- **Check off only verified truth**: mark `[x]` only after observing real checks; record skipped, blocked, or local-only checks honestly (`[NEEDS LOCAL VERIFICATION]` in cloud environments).
- **Risk line**: close every code change with `Risk: item N (reason)` or `Risk: none` per `references/odd-template.md`.

## Decision Gates

| Situation | Action |
|---|---|
| Read-only analysis / explanation / review | Inspect and report without modifying files. |
| Real unresolved product decision | Ask one focused question with recommended choice first; STOP and wait. |
| Small task (clear, low risk, resumable from diff) | Implement inline, test-first where applicable, close with `Risk:` line. |
| Large task | Create/update `odd/tasks/<slug>.md` BEFORE the first source edit. |
| Change shares helpers/parsers/flags with sibling paths | Add regression coverage and run a differential behavior check before closing. |
| Running in cloud/browser IDE without local toolchain | Author specs, TypeScript/React changes, and Vitest tests; mark Rust/CDP checks `[NEEDS LOCAL VERIFICATION]`. |

## Execution Steps

1. Classify authorization (read-only vs authorized write).
2. Explore affected modules and existing ODD files.
3. Evaluate Task Size using [references/odd-template.md](references/odd-template.md); if large, create `odd/tasks/<slug>.md` in fixed section order (`Header -> ## Specs -> ## Tasks -> ## Log`).
4. Implement task by task (`RED` -> `GREEN` -> refactor while green).
5. Run proportionate verification (`tsc --noEmit`, `vitest run`, `cargo test`, or mark unavailable cloud checks clearly).
6. Update ODD checkboxes/log with observed command evidence and close with `Risk: item N (reason)` or `Risk: none`.

## Output Contract

Report: modified/created file paths, ODD tasks (`T#`) & specs (`S#`) covered, exact observed verification commands/results (or `[NEEDS LOCAL VERIFICATION]`), and final `Risk:` line.

## References

- [references/odd-template.md](references/odd-template.md) — Exact `odd/tasks/<slug>.md` schema, 6 high-risk categories, and test-first differential rule.
