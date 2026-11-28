# Remote Control Gateway (`kite-remote/v1`) & Desktop Pairing Surface

Objective: Expose a secure, local-first HTTP + WebSocket remote control gateway (`kite-remote/v1`) from Kite Code's Rust backend paired with an Argos Voice Mode desktop bridge and a Settings -> Control Remoto tab (`QR` pairing, device management, and Tailscale/LAN bind options) so the companion `kite-mobile` React Native + Expo app can inspect workspaces/diffs, continue threads, approve permissions, launch agents/playbooks/swarms, and interact via voice.
Branch: `feat/remote-control`.
Test runner: `node .kite/sanitizer/audit-references.mjs --check`, `npm run verify:ipc`, `npm run verify:design`, `npx tsc --noEmit`, `npx vitest run src/lib/remote src/components/views/settings/RemoteTab.test.tsx src/components/views/settings/SettingsModal.test.tsx`, `cargo test --manifest-path src-tauri/Cargo.toml remote::`, `npm run verify:gate -- --tier fast`.
Does not change protected zones (`src/components/TitleBar.tsx` mode switcher).

## Specs

- **S1 — Protocol Contract & Sibling Mobile Repo Boundary (`kite-remote/v1`)**:
  - Verbatim:
    > "A ver, creo que en cuanto al stock, podemos continuar con React Native y Expo. No me parece malo. Si bien la aplicación la utilizaremos solamente en Android por ahora. Eh, en un futuro, tal vez, tal vez, se pase a iOS, así que. Continuemos con eso. Eh, quiero que crees el repositorio. No sé exactamente dónde ubicarlo. No sé si dentro de este o, en una carpeta afuera. Si es que es así, créalo en la carpeta de proyectos."
  - Behavior: Lock the complete versioned HTTP + WebSocket + QR URI contract in `docs/remote-protocol-v1.md` and keep the companion React Native + Expo repository in `c:\Users\PC\Desktop\Proyectos\kite-mobile` (tracked by `kite-mobile/odd/tasks/kite-mobile-android-app.md`).
  - Checks: `docs/remote-protocol-v1.md` exists with exact endpoints, RPCs, push events, and QR format; `kite-mobile` repository is initialized and verified independently.

- **S2 — Secure LAN/Tailscale Pairing & Device Token Persistence (`src-tauri/src/remote/auth.rs`)**:
  - Verbatim:
    > "El remote control. Básicamente quiero crear una aplicación para Android. Donde pueda. Gestionar toda nuestra. Aplicación."
  - Behavior: Persist `remote-gateway.json` under `roaming_app_dir()` storing `enabled`, `port` (default `17420`), `bindMode` (`"lan"` | `"loopback"`), `autoStart`, and paired devices (`id`, `name`, `platform`, SHA-256 `tokenHash`, `createdAtUnixMs`, `lastSeenUnixMs`). Generate single-use 5-minute TTL pairing credentials (`6-digit code` + `16-byte hex secret`) and `kite-remote://pair?...` URI listing detected LAN + Tailscale IPv4 hosts. Constant-time SHA-256 token verification; revoking a device clears its access and disconnects active WebSocket sessions immediately.
  - Checks: `cargo test --manifest-path src-tauri/Cargo.toml remote::tests::` covering config persistence, pairing TTL/single-use expiry, constant-time token verification, and revocation.

- **S3 — HTTP + Multiplexed WebSocket Gateway Server (`src-tauri/src/remote/server.rs`, `events.rs`)**:
  - Verbatim:
    > "Por ejemplo, continuar chats. Eh, o lanzar agentes. Ese tipo de cosas. Responderles."
  - Behavior: Bind a Tokio `TcpListener` on `0.0.0.0:<port>` or `127.0.0.1:<port>` with clean `watch` shutdown. Serve CORS-enabled `GET /api/v1/health` and `POST /api/v1/pair` (64 KiB body limit) alongside `GET /ws` WebSocket upgrades authenticated via `?token=` or `Authorization: Bearer` (rejecting invalid/revoked tokens with `401` pre-upgrade). Stream live `thread.delta`, `thread.snapshot`, `thread.approval_required`, `thread.finished`, `voice.argos_status`, `voice.realtime_event`, and `gateway.devices_changed` over `RemoteEventBus` without holding std mutex locks across `.await`.
  - Checks: `cargo test --manifest-path src-tauri/Cargo.toml remote::tests::` loopback TCP + `tokio-tungstenite` tests for health, pairing, 401 unauthorized WS, `system.ping`, `system.bootstrap`, `thread.create`/`thread.list`, revocation disconnect, and clean shutdown.

- **S4 — Chat, Agents, Playbooks, Subagents, Swarms & Git Diff RPC Surface (`src-tauri/src/remote/rpc.rs`)**:
  - Verbatim:
    > "Por ejemplo, continuar chats. Eh, o lanzar agentes. Ese tipo de cosas. Responderles."
  - Behavior: Implement all `kite-remote/v1` RPC methods (`system.*`, `workspace.*`, `thread.*`, `agent.*`, `subagent.*`, `swarm.*`) delegating to Kite's real Rust `persist`, `chat`, `chat_commands`, `agents`, `agent_playbooks`, and `git` modules using `spawn_blocking` for synchronous SQLite/chat calls.
  - Checks: `cargo test --manifest-path src-tauri/Cargo.toml remote::tests::` + `npm run verify:ipc`.

- **S5 — Remote Voice Transcription, Argos Voice Mode Bridge & Realtime Proxy (`src-tauri/src/remote/rpc.rs`, `src/lib/remote/argosRemoteBridge.ts`)**:
  - Verbatim:
    > "Eh, tener funcionalidades de voz para poder responderles por voz. También lo del voice mode."
  - Behavior: Handle `voice.transcribe` (<= 15 MiB decoded audio) via Kite's saved xAI/OpenAI STT credential or local offline Whisper fallback; handle `voice.argos.turn` via `remote:argos-turn-request` event -> desktop `runOperatorTurn({ source: 'voz', ttsEnabled: false })` -> `remote_argos_turn_reply` (45s timeout, optional ElevenLabs HTTP TTS audio when configured, always replying cleanly on errors); bridge `voice.realtime.*` to `crate::voice_realtime`.
  - Checks: `cargo test --manifest-path src-tauri/Cargo.toml remote::tests::` (`voice.transcribe` validation) + `npx vitest run src/lib/remote`.

- **S6 — Desktop Settings Tab, Deterministic QR Generator & Typed IPC (`src/components/views/settings/RemoteTab.tsx`, `src/lib/remote/qrSvg.ts`, `src/lib/ipc/remote.ts`)**:
  - Verbatim:
    > "Quiero que crees los ODDs, eh, quiero que utilices varios subagentes. Para implementarlo rápidamente. Todo."
  - Behavior: Add Settings -> `Control Remoto` (`remote`) tab showing gateway status, enable/disable toggle, `LAN + Tailscale` vs `Loopback` bind mode, port input, QR pairing SVG generated purely in TypeScript (`qrSvg.ts`), 6-digit code + countdown + candidate URLs, and paired devices list with revoke button, compliant with `AGENTS.md` §1–§3 design tokens.
  - Checks: `npm run verify:ipc`, `npm run verify:design`, `npx tsc --noEmit`, `npx vitest run src/lib/remote src/components/views/settings/RemoteTab.test.tsx src/components/views/settings/SettingsModal.test.tsx`.

- **S7 — End-to-End Verification, Adversarial Audit & Closeout**:
  - Verbatim:
    > "Quiero que crees los ODDs, eh, quiero que utilices varios subagentes. Para implementarlo rápidamente. Todo."
  - Behavior: Verify all Rust tests, frontend tests, IPC parity, design lint, clean-room sanitizer, and `verify:gate -- --tier fast`, run independent adversarial review (`jd-judge-a`), fix any confirmed findings, commit cleanly on `feat/remote-control`, and propose one consolidated manual QA task at closeout.
  - Checks: `npm run verify:gate -- --tier fast`, `cargo test --manifest-path src-tauri/Cargo.toml remote::`, `node .kite/sanitizer/audit-references.mjs --check`, and `jd-judge-a` audit verdict.

## Tasks

- [x] **T1** (`S1`, Risk: `none`, route: `inline`): Author `docs/remote-protocol-v1.md`, `odd/tasks/remote-control-gateway.md`, Engram mirror `odd/remote-control-gateway/tasks`, and scaffold sibling repository `c:\Users\PC\Desktop\Proyectos\kite-mobile` before first source edit.
- [x] **T2** (`S2, S3, S4, S5`, Risk: `item 2, item 3, item 4 (LAN auth/tokens, gateway RPC contract, Tokio WS/broadcast/oneshot concurrency)`, route: `delegated (Rust Remote Gateway Builder)`): Implement `src-tauri/src/remote/{mod,auth,events,rpc,server,voice,tests}.rs` with auth store, pairing URIs, HTTP+WS server (`GET /api/v1/health`, `POST /api/v1/pair`, `GET /api/v1/session`, `GET /ws`), live thread event pump, full RPC surface, voice STT/Argos/realtime bridges, and loopback tests (`cargo test --manifest-path src-tauri/Cargo.toml remote::`: `10 passed; 0 failed`).
- [x] **T3** (`S5, S6`, Risk: `item 3 (new Tauri IPC bindings and Argos remote event bridge)`, route: `delegated (Desktop Settings & Argos Bridge Builder)`): Implement `src/lib/ipc/remote.ts`, `src/lib/remote/qrSvg.ts`, `src/lib/remote/argosRemoteBridge.ts`, `src/components/views/settings/RemoteTab.tsx` + `remote-tab.css`, and unit tests (`npx tsc --noEmit` exit `0`, `30/30` Vitest tests passing across 4 files, `verify-design --files` `0 errors / 0 warnings`).
- [x] **T4** (`S2, S3, S5, S6`, Risk: `item 3, item 4 (Tauri command registration, startup/shutdown lifecycle, Settings tab routing)`, route: `inline`): Wire `src-tauri/src/main.rs`, `src/lib/ipc/index.ts`, `src/App.tsx`, `src/components/views/SettingsView.tsx`, `src/components/views/settings/icons.tsx`, and `scripts/quality/gate.config.json` (`npm run verify:ipc`: `409 registered / 409 Rust`, `PASS`).
- [ ] **T5** (`S7`, Risk: `item 2, item 3, item 4 (independent security, contract, and concurrency verification)`, route: `inline + independent verifier (jd-judge-a)`): Audit with `jd-judge-a` and all 10 findings fixed + targeted checks re-verified (`audit-references.mjs --check`: `478` files clean; `verify:ipc` PASS; `verify-design --files` `0/0`; `tsc` exit `0`; `30/30` Vitest; `10/10` `cargo test remote::`). **Pending**: full Tier 3 `npm run verify:gate` (Desktop CDP E2E + PNG inspection) and committing cleanly on `feat/remote-control` (deferred so pre-existing uncommitted `feat/response-thread` changes in the working tree are neither overwritten nor accidentally committed).
- [x] **T6** (`S2, S6`, Risk: `item 3 (pairing UX & gateway guard)`, route: `inline`): Harden `remote_gateway_create_pairing()` against stopped gateway, decouple `.remote-tab__qr-frame` from primary button ink/bg for guaranteed ISO contrast across all themes, auto-enable gateway on QR generation, add `Copiar enlace`, `Nuevo código`, and emulator pair command copy actions, and poll connected devices every 3s for automatic pairing confirmation (`verify:design` 0/0, `verify:ipc` PASS, `vitest` 15/15, `cargo test remote::` 10/10).

## Log

- **L1 (2026-11-26 — Initial Request & Architecture Lock)**:
  > "Quiero que de nuestros próximos proyectos, o bueno, próximas mejoras a nuestra aplicación sea. El remote control. Básicamente quiero crear una aplicación para Android. Donde pueda. Gestionar toda nuestra. Aplicación. La nuestra propia, no me refiero. Por ejemplo, continuar chats. Eh, o lanzar agentes. Ese tipo de cosas. Responderles. Eh, tener funcionalidades de voz para poder responderles por voz. También lo del voice mode. Eh, bueno, habría que aterrizar un poco más, pero también quisiera que examinaras otros. Otros aplicaciones. Quiero decir hay bastantes repositorios de código abierto que hacen algo como nosotros. Que es un gestor de agentes, que también implementan. Aplicación móvil, para dispositivos. Android o iPhone. O iOS, perdón. Y bueno, la idea sería averiguar qué podemos hacer con el stack. ¿Qué cosas podemos traer a esta aplicación? Y eso, habría que ir aterrizando todo. Ver cómo lo organizamos también, si es que creamos un repositorio aparte. Te creo, sería lo correcto."
- **L2 (2026-11-26 — Stack Confirmation, Sibling Repo & ODD Kickoff)**:
  > "A ver, creo que en cuanto al stock, podemos continuar con React Native y Expo. No me parece malo. Si bien la aplicación la utilizaremos solamente en Android por ahora. Eh, en un futuro, tal vez, tal vez, se pase a iOS, así que. Continuemos con eso. Eh, quiero que crees el repositorio. No sé exactamente dónde ubicarlo. No sé si dentro de este o, en una carpeta afuera. Si es que es así, créalo en la carpeta de proyectos. Eh, y quiero que comiences con todo básicamente. Quiero que crees los ODDs, eh, quiero que utilices varios subagentes. Para implementarlo rápidamente. Todo. Y eso."
  - Created `docs/remote-protocol-v1.md`, `odd/tasks/remote-control-gateway.md` (`T1 [x]`), and sibling repository `c:\Users\PC\Desktop\Proyectos\kite-mobile`.
- **L3 (2026-11-26 — Implementation, Adversarial Audit Fixes & Targeted Verification)**:
  - Implemented Rust gateway (`auth.rs`, `events.rs`, `voice.rs`, `rpc.rs`, `server.rs`, `mod.rs`, `tests.rs`), `RemoteTab.tsx`, `qrSvg.ts`, `argosRemoteBridge.ts`, `src/lib/ipc/remote.ts`, and wiring (`main.rs`, `App.tsx`, `SettingsView.tsx`, `gate.config.json`).
  - Completed blind adversarial review (`jd-judge-a`) and resolved all 10 findings across `kite` and `kite-mobile` (`WatcherGuard.disarmed` race guard, readonly live-turn delta cursor, `GET /api/v1/session` auth probe, `spawn_blocking` pairing/config I/O, RPC concurrency semaphore, `ffmpeg` audio transcode fallback, `gateway.resync_required` lagged handling, `subagent.list` wrapper normalization, explicit `requestId` forwarding, pairing secret UI display, and `Argos` language forwarding).
  - Observed post-edit checks (`kite` `feat/remote-control`):
    - `node .kite/sanitizer/audit-references.mjs --check`: `[AUDIT CLEAN] Scanned 478 file(s). Zero reference leaks detected.`
    - `npm run verify:ipc`: `[verify:ipc] Registered: 409 | Rust #[tauri::command]: 409 | Frontend calls: 507 (325 unique)` / `[PASS] Zero new broken IPC contracts detected.`
    - `node scripts/quality/verify-design.mjs --files src/components/views/settings/RemoteTab.tsx src/components/views/settings/remote-tab.css src/components/views/SettingsView.tsx src/App.tsx src/lib/remote/qrSvg.ts src/lib/remote/argosRemoteBridge.ts src/lib/ipc/remote.ts src/lib/ipc/index.ts src/components/views/settings/icons.tsx`: `Scanned: 9 file(s) | Errors: 0 | Warnings: 0` / `[PASS]`
    - `npx tsc --noEmit`: exit `0`
    - `npx vitest run src/lib/remote src/components/views/settings/RemoteTab.test.tsx src/components/views/settings/SettingsModal.test.tsx`: `Test Files  4 passed (4)`, `Tests  30 passed (30)`
    - `cargo test --manifest-path src-tauri/Cargo.toml remote::`: `10 passed; 0 failed` (914 filtered out)
  - Blocked/Pending for `T5`: clean commit on `feat/remote-control` (working tree retains 385 pre-existing uncommitted `feat/response-thread` changes) and full Tier 3 `npm run verify:gate` desktop CDP E2E + manual LAN/Tailscale Android QA.
- **L4 (2026-11-26 — Settings QR & Mobile Visual Alignment Feedback)**:
  > "¿Hay feedback que te puedo dar instantáneamente? Me parece que se ve bastante fea la aplicación, quiero decir, podemos basarnos bastante en lo que nosotros ya tenemos. En la aplicación nuestra. Partiendo por eso en cuanto a la visualización, diseño, temas. Ese tipo de cosas. Creo que podríamos basarnos en eso en lugar de estar creando algo desde cero y que no está tan alineado con nuestra. Nuestro diseño original. Claramente. Entonces partiendo por eso tenemos que llegar a modificar eso. Eh, en cuanto al QR. Em, claro, tendríamos que llegar también a modificar nuestra aplicación para poder generar el QR, o la conexión correcta. Para eso hay una parte de, creo que una parte de remote en la parte de configuraciones, tendríamos que llegar a implementarlo como tal, en su totalidad. Pero quiero que continúes trabajando con eso en su totalidad."
