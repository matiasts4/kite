# `kite-remote/v1` Wire Protocol Specification

`kite-remote/v1` is the versioned HTTP + WebSocket remote control contract connecting **Kite Code Desktop** (`src-tauri/src/remote/`) and mobile/remote clients such as **`kite-mobile`** (Android / iOS).

---

## 1. Transport, Ports & Pairing URI

- **Default Port**: `17420` (configurable via `remote_gateway_configure`).
- **Bind Modes**:
  - `"loopback"` (`127.0.0.1:<port>`): Local testing / SSH / Tailscale Serve-only loopback proxy.
  - `"lan"` (`0.0.0.0:<port>`): Accepts connections on local Wi-Fi/LAN and private overlay networks (e.g. Tailscale `100.64.0.0/10`).
- **External Access (Tailscale Serve / Funnel & Custom Public URL)**:
  - Desktop can probe Tailscale (`tailscale status --json`, `tailscale serve status --json`) and configure `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (private tailnet HTTPS) or `tailscale funnel --bg --https=443 http://127.0.0.1:<port>` (public fixed `https://<node>.<tailnet>.ts.net`), plus optional `publicUrl`.
  - Portless `https://` / `wss://` candidate URLs use TLS port `443` (never `:17420`).
- **QR Pairing URI**:
  ```text
  kite-remote://pair?v=1&host=<primaryHost>&port=<port>&hosts=<csvPercentEncodedCandidates>&code=<6digits>&secret=<hexSecret>&name=<urlEncodedHostName>
  ```
  - `primaryHost`: Primary detected LAN IPv4 address (falls back to `127.0.0.1` or external URL).
  - `hosts`: Comma-separated ordered candidate entries (LAN IPv4s, percent-encoded `https://` Tailscale/public URLs, and detected Tailscale `100.64.0.0/10` IPv4s).
  - `code`: 6-digit numeric one-time code (failed `POST /api/v1/pair` `401`/`410` responses include a 250ms rate-limit backoff).
  - `secret`: 32-char lowercase hex secret (16 random bytes).
  - `ttl`: 300 seconds (`expiresAtUnixMs`), single-use.

---

## 2. HTTP Endpoints (`http://<host>:<port>`)

CORS headers (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type, Authorization`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`) are returned on all responses, and `OPTIONS /*` returns `204 No Content`.

### `GET /api/v1/health`
Returns `200 OK`:
```json
{
  "ok": true,
  "protocol": "kite-remote/v1",
  "appVersion": "0.1.89",
  "hostName": "WORKSTATION",
  "pairingActive": true
}
```

### `GET /api/v1/session`
Validates a paired device token via `Authorization: Bearer <deviceToken>` or `?token=<deviceToken>`.
- `200 OK`: `{ "ok": true, "deviceId": "uuid-v4" }`
- `401 Unauthorized`: `{ "error": "unauthorized" }` (used by native WebSocket clients to distinguish revoked tokens from transient LAN errors).

### `POST /api/v1/pair`
Maximum request body: `64 KiB` (`413 Payload Too Large` if exceeded).

Request JSON:
```json
{
  "code": "482910",
  "secret": "a1b2c3d4e5f6...",
  "deviceName": "Pixel 9",
  "platform": "android"
}
```
(`platform` is `"android" | "ios" | "web"`).

Responses:
- `200 OK`:
  ```json
  {
    "deviceId": "uuid-v4",
    "deviceToken": "64-hex-char-token",
    "hostName": "WORKSTATION",
    "protocol": "kite-remote/v1",
    "wsPath": "/ws"
  }
  ```
- `400 Bad Request`: Malformed JSON, empty `deviceName`, or unsupported `platform`.
- `401 Unauthorized`: Invalid `code` or `secret` (constant-time comparison).
- `410 Gone`: No active pairing session, expired TTL, or pairing code already consumed.

---

## 3. WebSocket Endpoint (`/ws`)

- URL: `ws://<host>:<port>/ws?token=<deviceToken>` OR `Authorization: Bearer <deviceToken>` header.
- Authentication happens during the HTTP upgrade handshake. Invalid, missing, or revoked tokens are rejected with `401 Unauthorized` before upgrading.
- Revoking a device via `remote_gateway_revoke_device` removes the stored token hash and immediately closes active WebSocket connections owned by that `deviceId`.

### Frame Envelope (UTF-8 JSON Text Frames)

1. **Client -> Host Request**:
   ```json
   { "type": "req", "id": "req-uuid", "method": "thread.list", "params": { "workspaceId": "..." } }
   ```
2. **Host -> Client Response**:
   - Success:
     ```json
     { "type": "res", "id": "req-uuid", "ok": true, "result": { ... } }
     ```
   - Error:
     ```json
     { "type": "res", "id": "req-uuid", "ok": false, "error": { "code": "invalid_params", "message": "..." } }
     ```
3. **Host -> Client Push Event**:
   ```json
   { "type": "event", "event": "thread.delta", "seq": 12, "ts": 1791770226543, "payload": { ... } }
   ```
4. **Heartbeat**:
   - Client/Host sends `{ "type": "ping", "ts": 1791770226543 }`
   - Peer replies `{ "type": "pong", "ts": 1791770226543 }`

---

## 4. RPC Methods (`kite-remote/v1`)

### System & Workspaces
- **`system.ping`** `{}` -> `{ "ok": true, "serverTimeMs": number, "connectedClients": number }`
- **`system.bootstrap`** `{}` ->
  ```json
  {
    "protocol": "kite-remote/v1",
    "hostName": "string",
    "appVersion": "string",
    "candidateUrls": ["http://192.168.1.42:17420", "https://desktop.tailnet.ts.net"],
    "workspaces": [Workspace],
    "agents": [AgentProfile],
    "providerModels": { "<providerId>": [ProviderModelOption] },
    "liveRuns": [LiveChatRun],
    "pendingApprovals": [{ "threadId": "string", "title": "string", "profileId": "string|null", "approval": {} }],
    "voiceCapabilities": {
      "cloudSttConfigured": true,
      "offlineSttReady": false,
      "elevenLabsTtsConfigured": false,
      "realtimeConfigured": false,
      "realtimeProviders": ["xai", "openai", "gemini_live"]
    }
  }
  ```
- **`workspace.list`** `{}` -> `{ "workspaces": [Workspace] }`
- **`workspace.branches`** `{ "workspaceId": string }` -> `{ "current": string | null, "branches": string[] }`
- **`workspace.changes`** `{ "workspaceId": string }` -> `WorkspaceChanges`
- **`workspace.file_diff`** `{ "workspaceId": string, "path": string, "untracked"?: boolean }` -> `WorkspaceFileDiff`

### Providers & Models
- **`provider.models`** `{ "provider": string, "forceRefresh"?: boolean, "connectionId"?: string }` -> `{ "provider": string, "models": [ProviderModelOption], "cached": boolean, "catalogState": "ready" | "missing-binary" | "signed-out" }`

### Threads & Approvals
- **`thread.list`** `{ "workspaceId"?: string, "agentId"?: string, "includeArchived"?: boolean }` -> `{ "summaries": [ThreadSummary], "liveRuns": [LiveChatRun] }`
- **`thread.load`** `{ "threadId": string, "agentId"?: string }` -> Full projected `ExtendedChatThread` JSON (auto-subscribes caller to live updates if active or when requested)
- **`thread.create`** `{ "kind": "general" | "agent", "workspaceId"?: string, "provider"?: string, "agentId"?: string, "model"?: string, "mode"?: string, "plan"?: boolean }` -> Created `ExtendedChatThread` JSON
- **`thread.send`** `{ "threadId": string, "prompt": string, "agentId"?: string, "provider"?: string, "model"?: string, "mode"?: string, "plan"?: boolean, "clientMessageId"?: string }` -> Starts turn via `start_chat_turn` / `start_agent_chat_turn`, auto-subscribes caller to `threadId`, returns `{ "schemaVersion": 1, "runId": string, "thread": ExtendedChatThread, "clientMessageId"?: string }`
- **`thread.cancel`** `{ "threadId": string, "agentId"?: string }` -> `{ "ok": true, "threadId": string }`
- **`thread.configure`** `{ "threadId": string, "provider"?: string, "model"?: string, "mode"?: string, "plan"?: boolean, "effort"?: string }` -> Updated `ExtendedChatThread` JSON
- **`thread.approve`** `{ "threadId": string, "approvalId"?: string, "requestId"?: string, "decision": "allowOnce" | "allowForSession" | "alwaysAllow" | "deny" | "denyAndStop" }` -> Updated `ExtendedChatThread` JSON
- **`thread.respond_input`** `{ "threadId": string, "requestId"?: string, "answers": object }` -> Updated `ExtendedChatThread` JSON
- **`thread.subscribe`** `{ "threadId": string }` -> `{ "ok": true, "threadId": string }`
- **`thread.unsubscribe`** `{ "threadId": string }` -> `{ "ok": true, "threadId": string }`

### Agents, Playbooks, Subagents & Swarms
- **`agent.list`** `{}` -> `{ "agents": [AgentProfile], "availability": object }`
- **`agent.playbooks.list`** `{ "agentId"?: string }` -> `{ "playbooks": [...], "runs": [...] }`
- **`agent.playbooks.run`** `{ "playbookId": string, "workspaceId"?: string, "prompt"?: string }` -> `{ "ok": true, "run": PlaybookRunRecord }`
- **`subagent.list`** `{ "threadId"?: string, "workspaceId"?: string, "limit"?: number }` -> `{ "runs": [...] }` (or `{ "detail": ... }` when `threadId` + `subagentId` provided, or filtered list by `threadId`)
- **`subagent.send`** `{ "threadId": string, "subagentId"?: string, "message": string }` -> `{ "ok": boolean, "run"?: object, "error"?: string }`
- **`subagent.stop`** `{ "threadId": string, "subagentId"?: string }` -> `{ "ok": boolean, "run"?: object, "error"?: string }`
- **`swarm.state`** `{ "threadId": string }` -> `SwarmState` JSON
- **`swarm.post`** `{ "threadId": string, "message": string, "to"?: string }` -> `{ "ok": boolean, "result"?: object, "swarmState"?: object, "error"?: string }`
- **`swarm.kill`** `{ "threadId": string, "memberName": string }` -> `{ "ok": boolean, "result"?: object, "swarmState"?: object, "error"?: string }`

### Voice Dictation, Argos Voice Mode & Realtime Audio
- **`voice.transcribe`** `{ "audioBase64": string, "mimeType"?: string, "language"?: string }` -> `{ "text": string, "backend": "cloud_stt" | "offline_stt", "durationMs": number }`
  - Max decoded audio size: `15 MiB`.
- **`voice.argos.turn`** `{ "transcript"?: string, "audioBase64"?: string, "mimeType"?: string, "language"?: string, "workspaceId"?: string, "history"?: Array<{ "role": "user"|"assistant", "content": string }>, "requestTts"?: boolean }` ->
  ```json
  {
    "turnId": "string",
    "transcript": "string",
    "reply": "string",
    "receipts": [],
    "proposal": null,
    "strategy": "string",
    "durationMs": 420,
    "ttsAudioBase64": "optional-base64-mp3",
    "ttsMimeType": "audio/mpeg"
  }
  ```
- **`voice.realtime.start`** `{ "provider"?: "xai" | "openai" | "gemini_live", "voice"?: string, "workspaceId"?: string, "instructions"?: string }` -> `{ "ok": boolean, "status": RealtimeStatus, "error"?: string }`
- **`voice.realtime.audio`** `{ "pcm16Base64": string, "sampleRate": number }` -> `{ "ok": boolean }`
- **`voice.realtime.truncate`** `{ "itemId": string, "audioEndMs": number }` -> `{ "ok": boolean }`
- **`voice.realtime.stop`** `{}` -> `{ "ok": boolean }`

---

## 5. Push Events (`Host -> Client`)

- **`thread.delta`**: `{ "threadId": string, "runId": string, "events": [TurnUpdateEvent], "nextSequence": number }`
- **`thread.snapshot`**: `{ "threadId": string, "thread": ExtendedChatThread }`
- **`thread.approval_required`**: `{ "threadId": string, "title": string, "approval": object }`
- **`thread.finished`**: `{ "threadId": string, "runId": string, "status": "idle" | "error" | "cancelled" | "waiting" }`
- **`voice.argos_status`**: `{ "turnId": string, "phase": "transcribing" | "thinking" | "speaking" | "done" | "error", "detail"?: string }`
- **`voice.realtime_event`**: `{ "eventType": string, "payload": object }`
- **`gateway.devices_changed`**: `{ "count": number }`
- **`gateway.endpoints_changed`**: `{ "candidateUrls": string[] }` (pushes updated reachable URLs whenever desktop Tailscale or gateway configuration changes so paired clients auto-sync without re-pairing).
