# T0 — Driver evidence matrix

Read-only evidence for `agent-sessions.md` (S4, S7, S9, S16, S17). Date: 2026-10-23.

Method: what Kite does today is read from the tree; what each driver offers is read from the installed
CLI's own `--version` / `--help` on this machine. No provider auth file or MCP file was written, moved,
or deleted. No provider process was started with a prompt.

Sources:
- `src-tauri/src/chat/runtime.rs:470-519` endpoint declarations, `:633-704` argv construction, `:711-755` binary resolution, `:345-396` spawn lifecycle.
- `src-tauri/src/chat/utils.rs:25-27` prompt clipping, `:38-60` PATH resolution.
- `src-tauri/src/chat/models.rs:22-72` model catalog.
- `src-tauri/src/acp.rs:738-960` MCP discovery.
- `src-tauri/src/agent_mind/memory.rs:219-221` instruction files written by the recipe sync.

## Installed on this machine

| CLI | Version | Path |
| --- | --- | --- |
| `agy` | 1.4.5 | `C:\Users\PC\AppData\Local\agy\bin\agy.exe` |
| `claude` | **not installed** | — |
| `codex` | 0.163.0 | `C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe` |
| `cursor-agent` | 2026.10.22 | `C:\Users\PC\AppData\Local\cursor-agent\cursor-agent.ps1` |
| `gemini` | 0.64.0 | `C:\Users\PC\AppData\Roaming\npm\gemini.ps1` |
| `grok` | 1.0.62 | `C:\Users\PC\.grok\bin\grok.exe` |
| `opencode` | 2.1.4 | `C:\Users\PC\AppData\Roaming\npm\opencode.ps1` |
| `agent` | 1.0.62 | `C:\Users\PC\.grok\bin\agent.exe` — **this is Grok's binary** |

## Matrix

`session_mode` is the classification S4 requires, derived only from observed flags.

| Driver | Program | argv today | session_mode (evidence) | Resume handle | Work modes today | Effort today |
| --- | --- | --- | --- | --- | --- | --- |
| antigravity | `agy` | `-p <prompt> --output-format stream-json [--conversation <id>] [--model <m>] [--effort <e>] --mode plan\|accept-edits\|--dangerously-skip-permissions` | `persistent` (`--input-format stream-json` reads one NDJSON message per line from stdin and runs a turn for each; requires `--output-format stream-json`) | `--conversation <id>`, `--continue` | plan, accept-edits, full access | `--effort` |
| claude | `claude` | `-p --output-format text --permission-mode plan\|acceptEdits\|bypassPermissions [--resume <id>] [--model <m>] <prompt>` | **unknown** (binary absent; cannot probe) | `--resume` (argv only, unprobed) | plan, acceptEdits, bypassPermissions | none passed |
| codex | `codex` | `exec [resume <id>] --skip-git-repo-check [--sandbox read-only \| --full-auto] [--model <m>] <prompt>` | `persistent` (`app-server` is exposed, experimental) | `exec resume <id>` | sandbox: read-only, full-auto | none passed |
| cursor | `agent` then `cursor-agent` | `-p <prompt>` | `resumable` (`--resume [chatId]`, `ls resume`, `--output-format stream-json`) | `--resume` | none passed | none |
| gemini | `gemini` | `--prompt <prompt>` | `resumable` (`--resume`, `--session-id`, `--output-format stream-json`) | `--resume`, `--session-id` | none passed | none |
| grok | `grok` | `-p <prompt>` | `resumable` (`--resume`, `--session-id`, `--permission-mode` with 6 values) | `--resume` | 6 documented values, none passed | none |
| opencode | `opencode` | `run <prompt>` | `persistent` (`serve`, `--server <url>`, `--session <id>`, `acp`) | `--session <id>` | none passed | none |

## Per-driver detail

### antigravity (`agy` 1.4.5)
- Launcher observed. `--print`, `-p`, `--prompt` are aliases. `--print-timeout 0` waits for the turn.
- Lasting channel: documented by `--input-format stream-json`. Not exercised, so "accepts a second turn on the same process" remains an assumption with strong flag evidence, not a probe result.
- Auth source: CLI state under `~/.gemini/antigravity*` plus the Windows Credential Manager entry `gemini:antigravity` recorded in `provider-connections.md`. Exact file not re-verified in this pass.
- MCP source: `~/.gemini/antigravity-cli/mcp/*` and `~/.gemini/antigravity/mcp_config.json` (`acp.rs:765-837`).
- Instruction document: unknown. The recipe sync writes `AGENTS.md` and `CLAUDE.md`, and no Antigravity-specific document was observed.
- Model catalog: dynamic (`fetch_antigravity_models_dynamic`, `models.rs:47`). Advertises effort levels.
- Unknowns: whether `--effort` values match the catalog; whether a persistent session keeps approvals across turns.

### claude (not installed)
- **Unobservable on this machine.** The argv in the tree is the only evidence, and it is not proof.
- S17 asserts a stream-json open session on stdin/stdout. That assertion cannot be verified here and must not gate T4.
- Auth source: `~/.claude/.credentials.json` per `provider-connections.md`.
- MCP source: `~/.claude.json` (`acp.rs:846-885`).
- Instruction document: `CLAUDE.md`, written by the sync.
- Model catalog: hardcoded in `models.rs:60-66`, and it disagrees with the static TS catalog in `src/components/views/chat/types.ts:122-128` (the TS list adds `claude-sonnet-5-5`, the Rust list does not).

### codex (0.163.0)
- `app-server` and `exec-server` are exposed. `resume` exists as an interactive picker; the spawn uses `exec resume <id>`.
- Auth source: `~/.codex/auth.json` (OAuth), distinct from `OPENAI_API_KEY`.
- MCP source: `~/.codex/config.toml`, parsed line-wise (`acp.rs:886-922`).
- Instruction document: `AGENTS.md`, written by the sync.
- Model catalog: dynamic (`fetch_codex_models_dynamic`, `models.rs:48`). Effort is advertised but no effort flag is passed.
- Unknowns: whether `app-server` is stable enough to bind a thread, and which frames it emits for tools and approvals.

### cursor (2026.10.22-27dcf5f)
- **Launcher defect.** `runtime.rs:734` resolves `agent` before `cursor-agent`. On this machine `agent` is `C:\Users\PC\.grok\bin\agent.exe`, so a Cursor send currently starts Grok. This is a candidate-caused routing bug, not a provider limitation.
- Lasting channel: `--resume` and `ls resume` only. No server subcommand observed, so `resumable`, not `persistent`.
- Auth source: unknown. `~/.cursor` exists for MCP; the credential location was not observed.
- MCP source: `~/.cursor/mcp.json` (`acp.rs:925-950`).
- Instruction document: unknown. Cursor conventions are `AGENTS.md` or `.cursor/rules`; the sync writes neither into a workspace.

### gemini (0.64.0)
- `--resume`, `--session-id`, `--output-format stream-json`, `mcp`, `--allowed-mcp-server-names`.
- S17 assumes a driver without a lasting channel is one-shot. Gemini contradicts that: it is resumable today.
- Auth source: `~/.gemini/oauth_creds.json`, `google_accounts.json`, or `GEMINI_API_KEY` — different endpoints, never merged.
- MCP source: not read in this pass; `gemini mcp` manages it. Marked unknown.
- Instruction document: `GEMINI.md` by convention. **The sync does not write it** (`memory.rs:219-221` writes only `AGENTS.md`, `CLAUDE.md`, `README.md`).

### grok (1.0.62)
- `--resume`, `--session-id`, `--permission-mode` with `default, acceptEdits, auto, dontAsk, bypassPermissions, plan`, `--json-schema`.
- Resumable. Kite passes none of it.
- Auth source: `~/.grok/auth.json`, distinct from `GROK_API_KEY`.
- MCP source: **not discovered** by `list_provider_mcp_servers`.
- Instruction document: unknown.
- Model catalog: hardcoded two rows (`models.rs:53-56`), static TS catalog has one.

### opencode (2.1.4)
- `serve`, `--server <url>`, `--standalone`, `--session <id>`, `acp`, `mcp`, `service`.
- Persistent channel is available today. The Go chat endpoint split from `provider-connections.md` still applies: `opencode run` with no model is not the Go endpoint.
- Auth source: CLI config plus `~/.kite/opencode-go-quota.json` for quota. The secret store was not re-verified.
- MCP source: **not discovered** by `list_provider_mcp_servers`.
- Instruction document: `AGENTS.md` is the expected channel; written only into the agent home by the sync.

## Findings that change the plan

1. **Cursor can start the wrong binary.** `agent` resolves to Grok before `cursor-agent`. Any Cursor evidence gathered without fixing this is invalid, and T4 must not treat "process started" as Cursor evidence.
2. **`claude` is absent.** S17's Claude premise and T4's "Antigravity, Claude, and Codex first" ordering cannot be verified locally for Claude. The task needs an explicit "unobservable" result instead of an assumed pass.
3. **`one_shot` is Kite's limitation, not the drivers'.** Gemini, Grok, and Cursor expose resume flags; Antigravity, Codex, and OpenCode expose a lasting channel. Only the absence of argv wiring makes them one-shot.
4. **The model catalog is mostly static.** Only Antigravity and Codex fetch dynamically (`models.rs:46-72`); the rest are hardcoded, and the Rust and TypeScript lists disagree for Gemini and Grok. S9's "model choices come from that session's catalog" is not met today.
5. **MCP discovery skips Grok and OpenCode**, and a built-in `kite-tasks` server is reported as available to every provider (`acp.rs:749-763`). That contradicts S6's opt-in, session-scoped, revocable rule.
6. **Instruction files cover only part of the fleet.** The sync writes `AGENTS.md`, `CLAUDE.md`, `README.md` into the agent home only. No `GEMINI.md`, no Cursor rules, and a workspace thread never calls the sync at all (`runtime.rs:364-381`).
7. **Prompt clipping is silent.** `clip_argv` truncates at 12,000 characters (`utils.rs:25-27`). On a one-shot driver that silently drops the pasted thread context with no notice.
8. **Effort is advertised but not delivered.** The catalog marks `supportsEffort` for Claude, Codex, Grok, and Gemini; only Antigravity passes `--effort`.
9. **Permission mapping is lossy.** Grok declares six permission values; Kite maps three. Codex maps to sandbox `read-only` / `full-auto` and has no `acceptEdits` equivalent, so the composer cannot be truthful for both under one label.

## T0 verdict

Observable for six of seven drivers. Claude is unobservable on this machine. Two findings are defects, not gaps: the Cursor launcher collision and the built-in MCP injection. The session-mode column contradicts the assumption behind T7, so T7 must be rewritten from this matrix before it is scheduled.
