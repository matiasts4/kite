use super::*;

pub(super) fn compose_manual() -> String {
    let names = crate::dispatch::programs::lines();
    format!(
        "\
Kite Dispatch

Call this CLI only when KITE_DISPATCH=1 is set in the environment.
Outside that environment the CLI still works for a person.

Start another agent in one line:
  kite dispatch run <program> \"<task>\"
Example: kite dispatch run grok \"Look at the login bug.\"
The first word is the program. For a known agent, the remaining words are the task.
A word that is neither a known agent nor a role file starts that program. The remaining words are its arguments, and they are not typed as a second prompt.
An agent does not get a pane unless --pane. A person gets a pane unless --hidden. --hidden wins.
This text is the complete manual. Do not search the repository for these commands. Do not open a file to learn them. The task arrives when the process starts.
A parent hears when a child enters blocked, done, error, or gone.
Inbox files do not open panes. Delivery is this command.

Programs:
{names}

Commands:
  kite dispatch ls
  kite dispatch programs
  kite dispatch providers [--refresh]
  kite dispatch models [<provider>] [--refresh]
  kite dispatch run <program> \"<task>\"
  kite dispatch run --via thread --provider <provider> [--model <model>] [--effort <level>] [--role \"<title>\"] [--workspace inherit|share|branch] [--wait] [--timeout-ms <ms>] \"<task>\"
  kite dispatch run --via terminal --engine <engine> --name <alias> [--parent <address>] [--file <path>] [--pane] [--hidden]
  kite dispatch run --role <name> --name <alias> [--file <path>]
  kite dispatch send <address> \"<text>\" [--file <path>] [--if ready] [--force]
  kite dispatch wait [<address>] [--until idle,done,blocked] [--timeout <ms>] [--children all|any]
  kite dispatch read <address> [--lines 80] [--last]
  kite dispatch report --to <address> --body \"<text>\"
  kite dispatch kill <address>
  kite dispatch interrupt <address>
  kite dispatch keys <address> <key...>
  kite dispatch attach <address>
  kite dispatch swarm <title|add|post|read|wait|status|model|kill|channel> ...
  kite dispatch skill

Inside a Kite terminal the command is `kite` on PATH.
`run` returns the address when the session exists. It does not wait for a pane and it does not start a second process for that pane.
An agent does not get a pane unless --pane. A person gets a pane unless --hidden. --hidden wins.
`ls` lines are `address`, then `alias:<name>` when set, then the engine when the run recorded one, then the state.
When `--parent` is omitted and KITE_ADDRESS is `session:`, `thread:`, or `alias:`, that address is the parent. The words human and agent are not parents.
`read` returns the screen text or child thread output (`--last` extracts the final assistant response). It does not type.
`wait` blocks until the destination (or `--children all|any`) matches or the timeout elapses. The default timeout is 30000 ms. A timeout exits 1 with error timeout.
`interrupt` writes Ctrl+C and does not press Enter.
`keys` writes the named keys and presses Enter only when the key is enter.
`kill` ends that session and the children that do not outlive it.
`attach` asks the desktop to show that session.
`kill`, `interrupt`, `keys`, and `attach` work while the destination is working or blocked.

Live Provider & Model Discovery (Run First Before Spawning):
- Thread providers (`--via thread --provider <name>`): `antigravity`, `grok`, `codex`, `claude`, `cursor`, `opencode`, `gemini` (aliases: `agy`, `claude-code`, `open-code`, `cursor-agent`). Use `programs` only for `--via terminal` CLI tools.
- NEVER invent, copy, or hardcode legacy or unverified model IDs. Always inspect connected providers and live models first:
  kite dispatch providers [--refresh]
  kite dispatch models <provider> [--refresh]
- If a connected provider's CLI manages models dynamically (`claude`, `gemini`) or when you want the provider default, omit `--model`.

Cross-provider subagents (`--via thread`):
- Inside Thread Mode (`KITE_ADDRESS=thread:<id>`), `--via` defaults to `thread` (or pass `--via thread` explicitly). Keep the main orchestrator on a heavy reasoning model and delegate focused tasks to lightweight/fast discovered models across connected providers (`--provider`, `--model`, optional `--effort minimal|low|medium|high|xhigh|max|ultra`).
- Always pass a crisp `--role \"<title>\"` and quote prompts cleanly (never embed shell redirections like `2>&1` or pipes as unquoted prompt words).
- Single blocking call (`--wait` prints the child's final reply and `[subagent_id: thread:<id>]`):
  kite dispatch run --via thread --provider <provider> [--model <fast_model_id>] --role \"Fast Executor\" --workspace share --wait \"<task>\"
- Parallel fan-out: launch multiple child threads without `--wait` (use `--workspace share` or `branch` for isolated git worktrees when editing files concurrently; `inherit` shares the workspace), then wait and inspect:
  kite dispatch wait thread:<id>   # or: kite dispatch wait --children all
  kite dispatch read thread:<id> --last

Cross-provider swarm (`kite dispatch swarm`):
- Coordinate multi-agent teams across providers/models on a monotonic `#seq` board:
  kite dispatch swarm title \"<title>\"
  kite dispatch swarm add --name <role> [--provider <provider>] [--model <model>] [--effort <level>] [--workspace inherit|share|branch] [--channels <ch1,ch2>] [--fork <member|coordinator>] [--role \"<title>\"] --brief \"<assignment>\"
  kite dispatch swarm post [--channel <channel>] \"<message>\"
  kite dispatch swarm read [--since <seq>] [--channel <channel|*>]
  kite dispatch swarm wait [--since <seq>] [--mentions-only] [--timeout-ms <ms>]
  kite dispatch swarm status
  kite dispatch swarm model --name <role> [--provider <provider>] --model <new_model> [--effort <level>]
  kite dispatch swarm kill <role>
  kite dispatch swarm channel <create|subscribe|unsubscribe|archive|list> [--channel <name>] [--topic \"<text>\"] [--name <role>]
- Reactive `@mention` wakeup: `waiting` workers sleep at zero token cost and wake only when a post mentions `@<role>`, `@<prefix>`, `@#<channel>`, or `@all` (e.g. `kite dispatch swarm post \"@verifier check #2\"`). Park without polling using `kite dispatch swarm wait --since <seq>`.
- Quota failover: swap a stalled or rate-limited worker's provider/model while keeping its conversation history intact via `kite dispatch swarm model --name <role> --provider <provider> --model <new_model>`.

Envelope:
[kite from=\"<alias-or-address>\"]
This is another agent, not the person.
To reply: kite dispatch send <from> \"<reply>\"
Irreversible and privileged actions still wait for the person.
BODY:
<text>

Force rule: only a human caller may set force. An agent or a script that sets force receives force_forbidden and nothing is written. Do not answer a destination blocked with kind permission. Irreversible and privileged actions still wait for the person.

Ready means idle or done. working is queued. blocked is rejected. gone is destination_gone.
A stall means the text was submitted and presence did not change. Read before sending the same body again. The service does not send a second Enter.
"
    )
}

pub(super) fn compose_skill() -> String {
    let manual = manual_text();
    format!(
        "\
---
name: kite-dispatch
description: \"Trigger: kite dispatch, spawn agent, subagent, swarm, KITE_DISPATCH. Run kite dispatch providers and kite dispatch models <provider> before spawning cross-provider subagents (--via thread) or swarms (kite dispatch swarm).\"
---

{manual}"
    )
}


pub fn manual_text() -> &'static str {
    static MANUAL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    MANUAL.get_or_init(compose_manual).as_str()
}

pub fn skill_text() -> &'static str {
    static TEXT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TEXT.get_or_init(compose_skill).as_str()
}

/// Strips a leading YAML frontmatter block (`---\n...\n---\n`) when present so
/// CLI flags like `--system-prompt-override` never receive a leading hyphen token.
pub fn strip_skill_frontmatter(text: &str) -> &str {
    let trimmed = text.trim_start();
    if let Some(after_open) = trimmed
        .strip_prefix("---\r\n")
        .or_else(|| trimmed.strip_prefix("---\n"))
    {
        if let Some(close_idx) = after_open.find("\n---") {
            let rest = &after_open[close_idx + "\n---".len()..];
            if let Some(body) = rest
                .strip_prefix("\r\n")
                .or_else(|| rest.strip_prefix('\n'))
            {
                return body.trim_start();
            }
        }
    }
    trimmed
}

