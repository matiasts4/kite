---
name: cognitive-doc-design
description: "Trigger: README, guide, RFC, docs, onboarding, architecture doc, changelog. Design concise docs that minimize cognitive load."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.0"
---

## Activation Contract

Load when writing or restructuring guides, READMEs, RFCs, ODD specs, architecture references, or review notes meant to be understood rapidly.

## Hard Rules

- **Lead with the answer**: put the core decision, architecture rule, or action in the opening paragraph; background comes second.
- **Progressive disclosure**: happy path / quick start first, edge cases and deep reference tables afterward.
- **Recognition over recall**: replace dense prose walls with scannable tables, numbered workflows, file links, and concrete templates.
- **Short flat lists & clear signposting**: break multi-topic docs into short focused sections with explicit headings.
- **Review empathy**: highlight exact entry points, verification steps, and explicit out-of-scope boundaries so readers never reconstruct intent from scratch.
- **Clean-room hygiene**: keep tracked docs free of external donor references and machine-specific host paths (`C:\Users\...`).

## Decision Gates

| Doc Type | Primary Structure |
|---|---|
| Onboarding / How-To Guide | Goal summary -> Quick Start steps -> Deep reference / Decision table -> Checklist |
| Feature Spec (`odd/tasks/*.md`) | Header -> `## Specs` (`S#`) -> `## Tasks` (`T#`) -> `## Log` |
| PR / Change Summary | What changed -> Why -> What to verify first -> Risks & non-goals |

## Execution Steps

1. Identify target audience (human maintainer, AI agent, or code reviewer).
2. Lead with the outcome and quick path.
3. Structure details into compact tables, checklists, and runnable commands.
4. Read back to trim redundant prose and ensure every path and command exists cleanly in the repo.

## Output Contract

Deliver structured, scannable Markdown with verified repo-relative paths, exact commands, and clear next actions.

## References

- [../../../AGENTS.md](../../../AGENTS.md) — Repository engineering standards and verification commands.
