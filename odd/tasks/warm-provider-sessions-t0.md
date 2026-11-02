# T0: Warm Provider Wire Compatibility Matrix

## Purpose
This document establishes the verified CLI flags, streaming wire formats, lasting transport mechanisms, and session resume capabilities across all supported providers in Kite for the *Warm Provider Sessions & Lifecycle Management* system.

## Provider Wire Specification

| Provider | Transport Mode | Lasting Channel | Resume Flag / Argument | Wire Protocol | Session Handle Source |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Antigravity** | Lasting stdio (`stream-json`) | Stdin JSON-RPC / lines | `--resume <session_id>` | JSON Lines (`type: "turn"`) | Event `session.created` -> `session_id` |
| **OpenCode** | HTTP Server (`opencode serve`) | HTTP loopback RPC / SSE | `--session <session_id>` | JSON / SSE events | Header `x-session-id` or response payload |
| **Codex** | Lasting stdio or subproc | Stdin stream / command line | `resume <session_id> --json` | JSON stream events | Init event `session_id` |
| **Claude** | Lasting stdio (`stream-json`) | Stdin JSON lines | `--resume <session_id>` | JSON Lines | Event `system` / `session_id` |
| **Cursor / Fallback** | Process restart / Fallback | N/A (One-shot fallback) | N/A | Stdout JSON lines | Managed locally via thread transcript |

## Wire Transport Invariants

### 1. Warm Turn Dispatch (Lasting Stdio)
- When a `ManagedSession` is in state `Idle` with an open pipe:
  - Do NOT re-send historical context or markdown transcripts (`assemble_thread_context`).
  - Write directly to the running child process's `stdin`:
    ```json
    {"type": "user_turn", "content": "<prompt>", "timestamp_ms": 1729864200000}
    ```
  - Upstream LLM engine maintains KV prompt cache across turns in the active process context.

### 2. Idle Eviction & Reaping
- When a process has been idle for > 30 minutes, or when active warm processes exceed `MAX_WARM_PROCESSES` (default 3):
  - Extract the provider's `resume_handle` received during session handshake.
  - Send graceful shutdown signal to the process (e.g. `SIGTERM` or EOF on stdin).
  - Transition state to `SessionState::Reaped`.
  - Child process terminates, reclaiming all host memory (150MB–600MB per process).

### 3. Transparent Lazy Resurrection
- When the user sends a new message to a thread in `SessionState::Reaped`:
  - Retrieve the persisted `resume_handle` from SQLite.
  - Spawn the provider process with its resume argument (e.g. `--resume <handle>`).
  - Send ONLY the delta user prompt to the newly resurrected process.
  - Upstream provider reloads the KV prompt cache from disk/cloud using the resume handle.
  - If the resume handle is rejected (expired, not found, or exit code non-zero on resume):
    - Fallback transparently to cold-start: re-assemble the thread transcript via `assemble_thread_context()` and start a fresh session.
