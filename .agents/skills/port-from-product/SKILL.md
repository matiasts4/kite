---
name: port-from-product
description: "Trigger: copy from, match, parity, port, copiar, copiar completamente. Inventory full source behavior, propose totality, and write clean-room ODD specs."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.0"
---

## Activation Contract

Load whenever the user asks to match, reach feature parity with, port, or reproduce a capability seen in another workflow or external application.

## Hard Rules

- **Inventory before code or specs**: inspect source behavior first from primary behavior, docs, `--help`, CLI/IPC paths, and UI states. Recollection is not an inventory.
- **Walk twice (User + Agent)**: map every human-visible surface AND every agent-visible channel (env vars, instruction loading, skills, flags, lifecycle, errors). A missed channel is a missed feature.
- **Confirm totality first**: present the complete surface inventory (keep vs defer) and wait for explicit user confirmation before writing product code or landing implementation slices.
- **Strict clean-room hygiene**: public `odd/tasks/*.md`, `docs/`, UI copy, source comments, and commit messages MUST NEVER name external/donor products or copying phrasing. Store private comparative notes locally in gitignored `.kite/tasks/` only (if unavailable in cloud IDE, keep comparisons strictly in chat reply, never in tracked files).
- **Keep ODD synchronized**: later adjustments to the feature must update the same `odd/tasks/<slug>.md` (`## Specs`, `## Tasks`, `## Log`) in the same change.

## Decision Gates

| Situation | Action |
|---|---|
| Inventory has unmapped rows | Keep inspecting before suggesting or writing specs. |
| User named only one sub-feature of a connected workflow | Present the full surface inventory first and confirm what is kept vs deferred. |
| Public file/comment/commit would mention external product | Rewrite strictly in Kite's domain terminology. |
| Follow-up fix belongs to ported ODD | Append verbatim request to `## Log`, update affected `S#`, and reopen/add `T#` in the same change. |

## Execution Steps

1. Inspect reference evidence thoroughly (human path + agent path) using [references/surfaces.md](references/surfaces.md).
2. Run the suggestion pass from [references/discovery-and-odd.md](references/discovery-and-odd.md) with explicit keep/defer recommendations and wait for totality confirmation.
3. Author/update clean-room `odd/tasks/<slug>.md` with full `S#`, `T#`, and `L#` entries.
4. Implement confirmed surfaces cleanly inside Kite's architecture, tests, and visual rules.

## Output Contract

Return: complete surface matrix (`surface | source behavior | gap | keep or defer`), explicit totality confirmation status before coding, clean-room ODD path, and implementation/test results with zero external names.

## References

- [references/surfaces.md](references/surfaces.md) — Complete human + agent surface checklist.
- [references/discovery-and-odd.md](references/discovery-and-odd.md) — Suggestion pass, clean-room ODD landing, and sync rules.
