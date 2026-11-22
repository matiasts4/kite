---
name: qa-task-handoff
description: "Trigger: QA task, manual test, testeo pendiente, crear en Tasks, voice mode QA, zed QA. Create one focused QA task in Kite Tasks with ODD and thread links."
license: Apache-2.0
metadata:
  author: "matiasts4"
  version: "1.0"
---

## Activation Contract

Load at closeout (or on explicit user request) when work modifies a key interactive area: **Voice Mode**, **Zed / SETH Assistant**, or **Agent / Orchestration**.

## Hard Rules

- **Key areas only**: proactively offer a QA task only for **Voice Mode**, **Zed / SETH Assistant**, **Agent / Orchestration**, or when explicitly asked. Skip routine unrelated refactors.
- **User confirmation gate**: if the user did not explicitly request creating a task in **Kite Tasks**, ask first at closeout before calling `create_task`.
- **One task per ODD / delivery**: consolidate manual checks into **1 single focused task** (never split into 10–20 micro-cards). Reuse/update an existing open QA task via `list_tasks` + `update_task` if the same `oddPath` already has one pending.
- **Mandatory traceability**: populate `oddPath`, `sourceAgent` (e.g. `antigravity`, `opencode`, `claude-code`, `codex`), and `sourceThreadId` (`KITE_ADDRESS` `thread:<id>` or external session/conversation ID) on `create_task`.
- **Default state & labels**: create in state `Review` (unless the user requests `To Do`), with labels `["qa-manual", "<domain>"]` (`voice-mode` | `zed-assistant` | `agent`).

## Decision Gates

| Situation | Action |
|---|---|
| User explicitly asks to log QA task in Tasks | Create/update the single consolidated task right after checks pass. |
| Change touches Voice Mode, Zed/SETH, or Agent without task request | Propose in 2 lines at closeout (`oddPath` + focus) and wait for confirmation. |
| Same `oddPath` already has an unverified QA task (`To Do`/`Review`) | Update that existing task with `update_task` / `add_task_comment` instead of duplicating. |
| `kite-tasks` MCP tool unavailable in current harness | Return the ready-to-paste task payload (title, `oddPath`, traceability, checklist) instead of inventing persistence. |

## Execution Steps

1. Identify the affected key area (`voice-mode`, `zed-assistant`, or `agent`), the linked `oddPath` (`odd/tasks/<slug>.md`), `sourceAgent`, and `sourceThreadId`.
2. Run `list_tasks` (`label: "qa-manual"`) to verify whether a pending QA card already exists for that `oddPath`.
3. Compose **1 concise task**:
   - **Title**: `[QA · <Area>] Testear <enfoque concreto>`
   - **Description**:
     - `ODD`: `<oddPath>` (`S#`, `T#`)
     - `Qué cambió`: 1–2 lines summarizing the user-visible behavior change
     - `Checklist para probar`: 2–5 short `- [ ]` manual steps in the live app
     - `Criterio OK`: observable expected result vs failure signal
     - `Checks automáticos`: automated tests/builds passed vs manual/hardware checks pending
4. Call `create_task` (or `update_task`) with `state: "Review"`, `labels`, `oddPath`, `sourceAgent`, and `sourceThreadId`.

## Output Contract

Report created/updated task ID (`KITE-###`), state, linked `oddPath`, `sourceAgent`, `sourceThreadId`, and whether the task was created now or awaiting user confirmation.

## References

- [../../../AGENTS.md](../../../AGENTS.md) — Key areas, QA verification gates, and portable skills index.
- [../odd-workflow/SKILL.md](../odd-workflow/SKILL.md) — ODD specification and closeout discipline.
