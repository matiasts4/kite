---
name: skill-creator
description: "Trigger: new skill, SKILL.md, document agent pattern, portable instructions. Author LLM-first skills under .agents/skills/."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.0"
---

## Activation Contract

Load before creating or updating any repository skill under `.agents/skills/<skill-name>/SKILL.md`.

## Hard Rules

- A `SKILL.md` is a **runtime execution contract for LLMs**, not a human tutorial.
- **Frontmatter**: require `name`, `description` (single physical quoted line, trigger-first `"Trigger: ... . <Purpose>."`, <=160 chars target / <=250 chars max), `license`, `metadata.author`, `metadata.version`. Never add a `Keywords` heading.
- **Required section order**: `Activation Contract` -> `Hard Rules` -> `Decision Gates` -> `Execution Steps` -> `Output Contract` -> `References`.
- **Body token budget**: target **180–450 tokens**, recommended max **700**, hard max **1000**. Put templates, schemas, and deep examples into `assets/` or `references/` with repo-relative links.
- **Clean-room & portability**: zero machine-specific absolute paths (`C:\Users\...`), zero external donor names, and work seamlessly in both local harnesses and cloud IDEs (e.g., Google AI Studio Build).
- **Register every repo skill** in root `AGENTS.md` once added.

## Decision Gates

| Need | Action |
|---|---|
| Schema, template, or verbose example >15 lines | Move to `references/*.md` or `assets/` and link via relative path. |
| Pattern only applies once | Keep in `odd/tasks/*.md` or inline; do not add a permanent skill. |
| Skill touches external tool unavailable in browser sandbox | State fallback behavior explicitly inside `Decision Gates`. |

## Execution Steps

1. Confirm no duplicate skill covers the workflow in `.agents/skills/`.
2. Create `.agents/skills/<name>/SKILL.md` (plus optional `references/` / `assets/`).
3. Validate frontmatter line count, section order, token compactness, and relative links.
4. Register the new skill trigger row in `AGENTS.md`.
5. Locally verify with `node .kite/sanitizer/audit-references.mjs --check`.

## Output Contract

Return created/updated paths, `AGENTS.md` table registration update, token-compactness check, and sanitizer audit status.

## References

- [../../../AGENTS.md](../../../AGENTS.md) — Central skill index and clean-room rules.
