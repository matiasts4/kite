# Clean-Room Discovery, Specs & ODD Sync

## Suggestion Pass (Before Coding)
For every surface identified in `surfaces.md`:
1. Describe what capability it provides in user/agent terms (without naming external products in repo docs).
2. Show how it fits Kite's architecture and visual design system.
3. Recommend `Keep` or `Defer`.
4. Close with a summary of scope vs deferred items and wait for user confirmation.

## Landing Public Specs (`odd/tasks/<slug>.md`)
- Document only accepted surfaces using clean Kite terminology (`odd/tasks/<slug>.md`).
- Never reference external repositories, apps, or "copying from X" inside tracked Markdown, code comments, UI labels, or commit messages.
- Local private notes (only when working locally with `.kite/` ignored) may live under `.kite/tasks/<slug>-reference.md`. In cloud IDEs (e.g., Google AI Studio), never commit comparison notes to Git.

## Ongoing Sync Rule
Whenever follow-up feedback touches the ported capability:
1. Append user words verbatim to `## Log` (clean of unrelated external brand references).
2. Revise only affected `S#`.
3. Reopen or append the matching `T#`.
4. Verify locally with `node .kite/sanitizer/audit-references.mjs --check` before staging or committing.
