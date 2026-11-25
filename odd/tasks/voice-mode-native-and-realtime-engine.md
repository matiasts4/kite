# Voice Mode v2 — Sub-Second Latency Pipeline, Native Rust Audio Stack & Full-Duplex Realtime Engine

Objective: Upgrade Kite Code's unified **Voice Mode** (Argos's live spoken channel) from a WebView2-bound half-duplex cascaded pipeline into a studio-grade, ultra-low-latency desktop voice engine by (1) absorbing and modernizing all 7 unimplemented latency optimizations from `odd/tasks/seth-voice-latency-optimization.md` (`T1–T7`), (2) replacing stubbed `src-tauri/src/dictation.rs` handlers with a real native Rust WASAPI (`cpal`) audio capture + optional local offline STT fallback stack, (3) adding an optional full-duplex Speech-to-Speech Realtime WebSocket transport wired directly into Argos's action executor, and (4) consolidating Voice/Audio settings (`settings-consolidation-and-overhaul.md` `T4`) with persistent call receipts and desktop CDP E2E coverage.
Branch: `feat/response-thread`.
Delivery strategy: `ask-on-risk` (8 reviewable ~250–400 line slices `T1–T8`; implementation gated on explicit user authorization before starting `T1`).
Test runner: `npx tsc --noEmit`, `npx vitest run src/lib/operator src/components/ArgosOrb.test.tsx src/components/ArgosStrip.test.tsx src/components/views/chat/ThreadVoiceMode.test.tsx src/components/views/chat/composer/VoiceModeFooterBar.test.tsx src/components/views/settings/ZedTab.test.tsx`, `cargo test --manifest-path src-tauri/Cargo.toml --workspace`, `npm run verify:desktop:e2e`, `node .kite/sanitizer/audit-references.mjs --check`.
Connected / Absorbed ODDs:
- **Absorbs & modernizes**: pending `T1–T7` of `odd/tasks/seth-voice-latency-optimization.md` (updated for `Argos` + `kite-ctx`) and pending `T4` (Audio deduplication) of `odd/tasks/settings-consolidation-and-overhaul.md`.
- **Builds on**: `odd/tasks/argos-voice-mode-roadmap.md` (`T0–T10 [x]`), `odd/tasks/thread-voice-mode.md` (`T1–T21 [x]`), `odd/tasks/elevenlabs-streaming-tts-zed.md` (`AC1–AC6 [x]`), and pairs with `odd/tasks/argos-assistant-capabilities-v2.md`.
Constraints: Does not change protected zones (`src/components/TitleBar.tsx` mode switcher) and adheres to `AGENTS.md` §1–§3 radius/height tokens. Implementation gated on explicit user authorization before `T1`.

---

## Verified Code Baseline & Architecture Overview

Auditing `src/lib/operator/`, `src-tauri/src/dictation.rs`, `src-tauri/src/audio_ducking.rs`, and pending ODD files on `feat/response-thread` confirmed:

1. **Unimplemented Latency Optimization ODD (`odd/tasks/seth-voice-latency-optimization.md`)**:
   - All 7 tasks (`T1–T7`) remain `[ ]` open (0/7 implemented).
2. **Broken KV Prompt Caching, Raw History & Full Tool Bloat (`src/lib/operator/planner/llm.ts:74, 236-242`, `src/lib/operator/providers/openaiCompat.ts:104`, `src/lib/operator/planner/prompt.ts:168-254`)**:
   - `llm.ts:240` merges `promptParts.staticPrefix` and `promptParts.dynamicTail` back into a single `system` string, invalidating provider KV prefix caching whenever terminals, branch, or active proposals change.
   - `MAX_PRIOR_TURNS = 14` injects up to 14 raw turns, and every turn sends all 22 `OPERATOR_NATIVE_TOOLS` schemas alongside duplicated textual JSON schemas and 15+ few-shot examples.
3. **Unused Multi-Tier Model Routing (`src/lib/operator/providers/resolvePlanner.ts:12-89`, `src/lib/operator/index.ts:163`)**:
   - `VERIFIED_PROVIDER_MODELS` already defines `fast` vs `diagnosis` model tiers, yet `runOperatorTurn` calls `resolvePlannerProvider(config)` with the default tier and never executes `L0 -> L1 -> L2` intent routing or escalation.
4. **Per-Sentence HTTP TTS & Streamed Double-Speak (`src/lib/operator/ttsNarrator.ts:685`, `src/lib/operator/index.ts:337-389, 447-463`)**:
   - `ttsNarrator.createStreamingQueue` exists, but `index.ts:447` still calls `ttsNarrator.speak(reply)` after streaming sentences, and ElevenLabs streaming opens a fresh HTTP request per sentence rather than holding a persistent `stream-input` WebSocket across the call.
5. **Stubbed Native Rust Audio & Dictation Commands (`src-tauri/src/dictation.rs:121-180`)**:
   - `unavailable_dictation`, `unavailable_voice_input`, `dictation_error`, and `voice_error` unconditionally return `"state": "unavailable"` / `"No local engine is installed"`.
   - All live audio capture remains inside WebView2 JS (`AudioWorklet` / `SpeechRecognition`), vulnerable to WebView2 mic-handle contention and background throttling.
6. **Missing Full-Duplex Speech-to-Speech Transport & Consolidated Audio Settings**:
   - While `audio_ducking.rs` provides native WASAPI privacy detection (`probe_microphone_privacy_status`, `0x80070005` / `0x88890004`) and `transcriptionProviders.ts` supports `wss://api.x.ai/v1/stt`, Kite Code lacks a native Rust `cpal` capture daemon, a local offline STT engine, an optional full-duplex 24 kHz Realtime Speech-to-Speech proxy, and unified Audio/Voice settings (`settings-consolidation-and-overhaul.md` `T4`).

```text
                        ┌─────────────────────────────────────────┐
                        │  Native Rust Audio Daemon (voice_audio) │
                        │  cpal WASAPI (16/24 kHz PCM16 + RMS)    │
                        └──────┬───────────────────────────┬──────┘
                               │                           │
          Mode A: Cascaded Multi-Provider          Mode B: Full-Duplex Realtime
          (Default — Any Kite Provider)            (Optional 24 kHz S2S Proxy)
                 │                                         │
   ┌─────────────▼──────────────┐             ┌────────────▼───────────────┐
   │ tokio-tungstenite /v1/stt  │             │ src-tauri/src/voice_realtime│
   │ OR Local Offline STT       │             │ Server VAD + Audio Truncate │
   └─────────────┬──────────────┘             └────────────┬───────────────┘
                 │                                         │
   ┌─────────────▼──────────────┐                          │
   │ L0 (<2ms) -> L1 (fast)     │                          │
   │   -> L2 (diagnosis)        │                          │
   │ + Immutable KV Prefix      │◄───── Tool Bridge ───────┘
   │ + Dynamic Tool Pruning     │
   └─────────────┬──────────────┘
                 │ (SentenceStreamChunker)
   ┌─────────────▼──────────────┐
   │ Persistent ElevenLabs WS   │
   │ (`stream-input`) + <50ms   │
   │ Atomic Barge-In Truncation │
   └────────────────────────────┘
```

---

## Specs

### S1 — End-to-End Voice Latency Telemetry, Token Accounting & SLI/SLO HUD (Absorbs `seth-voice-latency-optimization` `S7`)
- **Behavior**:
  1. Extend `RunRecord` (`src/lib/operator/runLedger.ts`) and `TraceEvent` (`src/lib/operator/trace/types.ts`) with exact turn milestones:
     - `sttFinalizedAt` (`t = 0`), `contextReadyAt`, `routerDecisionAt`, `providerRequestAt`, `firstTokenAt`, `firstActionStartAt`, `ttsRequestAt`, and `firstAudioAt` (`TTFA-Audio` measured on real `audio.onplay` / `utterance.onstart`).
  2. Record granular `tokenBreakdown`: `systemStaticTokens`, `contextDynamicTokens`, `toolsSchemaTokens`, `historyTokens`, `promptTokensTotal`, `cachedTokens`, `completionTokens`, and `cacheHitRatio`.
  3. Compute rolling `p50` / `p95` / `p99` percentiles segmented by `tier` (`L0` | `L1` | `L2`), `transport` (`cascaded` | `realtime`), and `ttsEngine` (`elevenlabs_ws` | `elevenlabs_http` | `browser`), surfaced live in `ArgosLatencySection.tsx`.
  4. **Target SLOs**: `TTFA-Audio p50 <= 900 ms` (Cascaded L1 + ElevenLabs WS) and `<= 450 ms` (Full-Duplex Realtime); barge-in audio abort `< 50 ms`; `cacheHitRatio >= 60%` on Turn 2+.
- **Acceptance**: Every voice turn emits complete latency & token telemetry without leaking secrets; `ArgosLatencySection.tsx` displays real `p50`/`p95` TTFA and cache hit metrics.
- **Checks**: Vitest tests in `runLedger.test.ts` and `ZedTab.test.tsx` asserting milestone timestamps, token breakdown math, and percentile aggregation.

### S2 — Immutable KV-Cache Split, Dynamic Intent Tool Pruning & Rolling History Compression (Absorbs `S1`, `S2`, `S4`)
- **Behavior**:
  1. **Strict Immutable Prefix (`llm.ts` + `prompt.ts` + `openaiCompat.ts`)**: Keep `messages[0]` (`staticPrefix`) byte-for-byte identical across turns of a call (with provider cache directives where supported), and pass `dynamicTail` (`kite-ctx` `< 250 tokens`) in a separate trailing context block immediately preceding the user utterance.
  2. **Remove Schema Duplication & Prune Tools by Intent (`contract.ts` + `llm.ts`)**: When native tool calling is enabled, omit redundant textual `ESQUEMA JSON PERMITIDO` and few-shot blocks from the system prompt. Partition `OPERATOR_NATIVE_TOOLS` into intent suites: `conversational` (`stay_silent` / `stop_speaking` only), `inspect` (`peek_*`, `recall_conversations`, `read_diff`), `orchestration` (`spawn_subagent`, `propose_task`, `refine_proposal`, `confirm_proposal`, `cancel_proposal`, `control_subagent`, `coordinate_swarm`, `launch_thread`, `launch_agent`), `terminals` (`open_terminals`, `close_terminals`, `inject_prompt`, `narrate_summary`, `manage_pane_layout`), `tasks_routines` (`manage_tasks`, `manage_routines`, `manage_memory`), and `workspace_ops` (`switch_workspace`, `navigate_view`, `run_check`, `open_browser`). Include a single automatic retry with the full catalog on ambiguous/multi-domain tool misses.
  3. **Rolling History & Session Pre-Warming**: Replace `MAX_PRIOR_TURNS = 14` with the last `4` verbatim turns plus a `<= 120`-token rolling summary compressed by `kite-ctx`. On `voiceSessionStore.startSession()`, pre-warm TLS/HTTP2 connections (`proxy_operator_http`), memory notes, and `chatCatalogCache` (`30 s` TTL + IPC invalidation).
- **Acceptance**: `messages[0]` remains byte-identical across Turn 1..N; conversational turns send `0–2` tools instead of 22+; input tokens per standard turn drop by `>= 40%`.
- **Checks**: `prompt.test.ts` & `llm` unit tests verifying byte-identical `messages[0]`, suite pruning counts, full-catalog fallback retry, and 4-turn + summary history bounding.

### S3 — 3-Tier Hybrid Voice Routing (`L0 -> L1 -> L2`) & Speculative Partial Pre-Capture (Absorbs `S5`, `S6`)
- **Behavior**:
  1. **L0 (`< 2 ms`)**: Deterministic heuristic (`planTurnHeuristic`) handles unambiguous local controls (`stop_speaking`, layout equalize, explicit terminal open/close, proposal confirm/cancel).
  2. **L1 (`fast` tier)**: Default LLM planner uses `resolvePlannerProvider(config, 'fast')` with pruned tools and cached prefix for natural conversation, single-hop `peek_*`, and 1–2 action turns, emitting `escalate: true` when deep code/ODD reasoning or multi-step planning is needed.
  3. **L2 (`diagnosis` tier)**: Invoked automatically only on `L1` escalation (reusing already-collected `peek_*` context and cached prefix).
  4. **Speculative Pre-Capture**: When `speechPartial.ts` observes `> 250 ms` of stable partial transcript before final endpointing, pre-capture `TurnContext` and warm `chatCatalogCache` asynchronously. Support optimistic non-blocking spoken acknowledgements for safe async launches (`spawn_subagent`, `launch_thread` background), strictly forbidden on destructive actions (`close_terminals`, `cancel_subagent`).
- **Acceptance**: Routine voice queries resolve on L0/L1 without touching heavy L2 reasoning models, while complex tasks escalate seamlessly without re-asking the user.
- **Checks**: Unit tests in `resolvePlanner.test.ts` and `conversationalOrchestrator.test.ts` verifying L0/L1/L2 transitions, escalation handoff, and speculative pre-capture cancellation on speech change.

### S4 — Persistent Streaming TTS (`stream-input` WebSocket), Zero Double-Speak & Atomic `<50 ms` Barge-In (Absorbs `S3`)
- **Behavior**:
  1. Eliminate post-stream double-speak in `src/lib/operator/index.ts:447` (`!streamedViaQueue`).
  2. Upgrade ElevenLabs streaming in `src/lib/operator/ttsNarrator.ts` from per-sentence HTTP `POST /stream` calls to a persistent per-call WebSocket (`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`) with keepalive pings, chunk-level generation fencing, and seamless fallback to HTTP `/stream` -> browser synthesis.
  3. Bind `SentenceStreamChunker` (`35–50` char min, `180` char first-sentence cap) to the active `generation` FIFO queue so barge-in (`stopWithRamp(20)`) aborts in-flight LLM SSE streams, closes/flushes the TTS WebSocket input, ramps Web Audio gain down over `20 ms`, and records exact `audioEndMs` / `heardText` in `< 50 ms`.
- **Acceptance**: Multi-sentence replies begin speaking immediately on sentence 1 over a single reused TTS socket and cut cleanly within `50 ms` on user interruption with exact heard-text truncation.
- **Checks**: `ttsNarrator.test.ts` & `voicePipelinePhase1.test.ts` testing persistent WS mock, fallback to HTTP on WS failure, generation-token isolation, and `< 50 ms` barge-in abort.

### S5 — Native Rust Audio Capture Daemon (`cpal` WASAPI) & Local Offline STT Engine (`dictation.rs`)
- **Behavior**:
  1. Implement `src-tauri/src/voice_audio/` (re-using `audio_ducking.rs` WASAPI privacy probes) with `cpal` 16 kHz mono PCM16 capture on a dedicated non-blocking audio thread, a lock-free ring buffer (preserving `15–30 s` pre-connect / `400 ms` VAD pre-roll), device hot-swap recovery, and throttled `voice:audio-level` Tauri events for waveform rendering.
  2. Stream PCM16 directly from Rust over `tokio-tungstenite` to `wss://{api_base}/v1/stt` (with RIFF/WAVE fallback on WS error) so microphone capture never freezes when WebView2 throttles or switches views, and keep `SpeechRecognition` strictly as a browser-preview/fallback path.
  3. **Real Local Offline STT Engine (`src-tauri/src/dictation.rs`)**: Replace stubbed `unavailable_dictation` / `unavailable_voice_input` (`dictation.rs:121-180`) with real availability probing and optional local Whisper/Parakeet model configuration (stored in `dictationSettings` SQLite), enabling 100% offline dictation & voice fallback when cloud STT keys or internet are unavailable.
- **Acceptance**: Calling native dictation/voice commands reports live device/engine readiness instead of `"unavailable"`; live voice calls capture cleanly through Rust WASAPI even when navigating across Kite views or Companion mode.
- **Checks**: Rust unit/integration tests for ring buffer, PCM16 resampler, WAV clip fallback, and `dictation.rs` readiness states (`cargo test voice_audio`, `cargo test dictation`).

### S6 — Optional Full-Duplex Speech-to-Speech Realtime Transport Mode
- **Behavior**:
  1. Add a selectable `Voice Transport Mode` (`cascaded` [default, works with any Kite LLM provider] vs `realtime` [full-duplex 24 kHz PCM16 Speech-to-Speech]) in `config/types.ts` and `ArgosAudioSection.tsx`.
  2. Implement `src-tauri/src/voice_realtime.rs` as an authenticated native WebSocket proxy (`wss://api.x.ai/v1/realtime` or compatible endpoint) streaming bidirectional 24 kHz PCM16 audio frames between `voice_audio` and the realtime endpoint with server-side VAD (`prefix_padding_ms`, `silence_duration_ms`).
  3. **Barge-In & Mid-Work Pruning**: On user speech onset, emit `conversation.item.truncate` with exact `audioEndMs`; prune stale mid-work commentary items (`conversation.item.delete`) beyond a 20-item sliding cap to keep long calls stable.
  4. **Argos Tool Bridge**: Forward realtime function-call events (`peek_*`, `propose_task`, `refine_proposal`, `confirm_proposal`, `spawn_subagent`, `manage_tasks`, `stay_silent`) directly into Argos's `executePlan()` and return structured results (`conversation.item.create` + `response.create`), automatically downgrading to `cascaded` mode if the realtime session fails or lacks credentials.
- **Acceptance**: Users with realtime credentials can toggle Full-Duplex Realtime mode for sub-500 ms bidirectional conversation while keeping full Argos workspace tools and timeline sync.
- **Checks**: Rust protocol serialization/truncation tests (`cargo test voice_realtime`) + TypeScript tool-bridge & automatic cascaded-fallback tests.

### S7 — Unified Audio/Voice Settings Consolidation, Persistent Call Receipts & Desktop E2E (`settings-consolidation` `T4`)
- **Behavior**:
  1. Consolidate duplicated mic/speaker/language/VAD/TTS settings between `Dictation` (`dictation.rs`), `Voice`, and `Argos` (`ArgosAudioSection.tsx`, `config/storage.ts`) into a single synchronized source of truth (`settings-consolidation-and-overhaul.md` `T4`).
  2. Persist completed call sessions (`voice-calls/<callId>.json`) with duration, turn count, TTFA metrics, tools executed, and linked `boundThreadId`, powering clickable **Post-Call Receipt Cards** in Thread timelines and Settings history.
  3. Extend `scripts/e2e/specs/voice-mode.e2e.mjs` with deterministic mocked audio/WebSocket transport fixtures verifying multi-turn hands-free re-arm, barge-in truncation, dynamic tool pruning, and Companion surface handoff.
- **Acceptance**: Audio device or language changes in one place reflect across Dictation, Thread Voice Mode, Orb, and Companion Bar; call receipts survive app restarts; CDP E2E tests pass.
- **Checks**: `ZedTab.test.tsx`, `ThreadVoiceMode.test.tsx`, and `npm run verify:desktop:e2e`.

---

## Prioritized Trade-offs & Delivery Waves

| Wave | Tasks | Expected Impact | Risk Tier |
| :--- | :--- | :--- | :--- |
| **Wave 1 — Latency & Cost Wins (`P0`)** | `T1–T3` | `-40%` to `-65%` input tokens/turn; `cacheHitRatio >= 60%`; L0/L1 routing cuts median planner latency by `500–1200 ms` | `item 3` (planner prompt split, tool pruning, model tier routing) |
| **Wave 2 — Streaming TTS & `<50ms` Barge-In (`P1`)** | `T4` | Eliminates double-speak & per-sentence HTTP TTS handshake (`TTFA-Audio p50 <= 900 ms`) | `item 4` (persistent TTS WebSocket & generation-fenced audio queue) |
| **Wave 3 — Native Rust Audio & Offline STT (`P1`)** | `T5–T6` | Replaces `dictation.rs` stubs, eliminates WebView2 mic contention, enables offline STT continuity | `item 4, item 5` (`cpal` audio thread lifecycle & `Cargo.toml` audio dependencies) |
| **Wave 4 — Full-Duplex Realtime & Consolidation (`P2`)** | `T7–T8` | Sub-500 ms S2S realtime mode + unified settings + persistent call receipts + CDP E2E | `item 2, item 3, item 4` (realtime credentials proxy & audio settings schema) |

---

## Tasks

- [x] **T1** (`S1`, Risk: `none`, route: `inline`): Instrument `runLedger.ts`, `trace/types.ts`, `ttsNarrator.ts`, and `index.ts` with full voice latency milestones (`sttFinalizedAt`, `firstTokenAt`, `firstActionStartAt`, `firstAudioAt`), granular `tokenBreakdown`, `p50`/`p95`/`p99` segmentation, and live HUD display in `ArgosLatencySection.tsx`, with unit tests.
- [x] **T2** (`S2`, Risk: `item 3 (planner prompt message boundary, tool schema pruning, and history compaction)`, route: `inline`): Separate immutable `messages[0]` (`staticPrefix`) from `dynamicTail` (`kite-ctx` `< 250 tokens`) in `planner/llm.ts` and `prompt.ts`, omit redundant textual schemas/few-shots when native tools are active, implement intent-based tool suite pruning with full-catalog retry fallback in `contract.ts`/`llm.ts`, replace `MAX_PRIOR_TURNS = 14` with 4-turn + rolling summary history, and pre-warm session connections/caches on `startSession()`.
- [x] **T3** (`S3`, Risk: `item 3 (hybrid L0/L1/L2 planner routing & escalation)`, route: `inline`): Wire 3-tier routing (`L0` heuristic -> `L1` `fast` tier -> `L2` `diagnosis` tier on escalation) in `resolvePlanner.ts` + `index.ts`, add `> 250 ms` stable-partial speculative context pre-capture in `speechPartial.ts`, and add safe non-destructive optimistic spoken acks, with unit tests.
- [x] **T4** (`S4`, Risk: `item 4 (persistent TTS WebSocket lifecycle & atomic barge-in cancellation)`, route: `inline`): Fix `streamedViaQueue` double-speak guard in `index.ts:447`, implement persistent per-call ElevenLabs `stream-input` WebSocket transport with HTTP/browser fallback in `ttsNarrator.ts`, and enforce `< 50 ms` atomic barge-in cancellation across LLM SSE + TTS WS + 20 ms Web Audio ramp with exact `audioEndMs` truncation.
- [ ] **T5** (`S5`, Risk: `item 4, item 5 (cpal WASAPI audio thread, tokio-tungstenite STT & Cargo dependencies)`, route: `delegated (Rust audio backend unit)`): Create `src-tauri/src/voice_audio/` (`cpal` 16/24 kHz PCM16 capture, lock-free ring buffer, device hot-swap, `voice:audio-level` events, `tokio-tungstenite` `/v1/stt` + WAV fallback), wire into `src-tauri/src/dictation.rs` and `main.rs`, and update JS capture consumers (`zedVoice.ts`) to prefer native Rust capture when available.
- [ ] **T6** (`S5`, Risk: `item 5 (optional local offline STT model integration)`, route: `delegated (Rust + Settings UI unit)`): Replace remaining `"unavailable"` stubs in `src-tauri/src/dictation.rs` with real local offline STT engine readiness/execution (Whisper/Parakeet model path & availability probing) and wire offline engine selection/status into `ArgosAudioSection.tsx` with tests.
- [ ] **T7** (`S6`, Risk: `item 2, item 3, item 4 (realtime WebSocket proxy credentials, 24 kHz duplex audio & tool bridge)`, route: `delegated (Rust realtime proxy + TS tool bridge unit)`): Implement `src-tauri/src/voice_realtime.rs` (24 kHz PCM16 full-duplex proxy, server VAD, `audioEndMs` truncation, mid-work pruning) and TypeScript Argos tool-call bridge with automatic fallback to `cascaded` mode and transport toggle in `ArgosAudioSection.tsx`, with tests.
- [ ] **T8** (`S7`, Risk: `item 1, item 3 (consolidated audio settings storage & voice-calls JSON persistence)`, route: `inline + independent verifier`): Unify Audio/Dictation/Voice settings (`settings-consolidation` `T4`), persist `voice-calls/<callId>.json` post-call receipts & replay viewer, extend `scripts/e2e/specs/voice-mode.e2e.mjs`, run full `tsc`/`vitest`/`cargo test`/`verify:desktop:e2e`/`audit-references.mjs --check`, sync Engram mirror, and propose one consolidated QA verification task per `AGENTS.md` §4.4.

---

## Log

- **L1 (2026-11-25 — Initial Audit & ODD Authoring)**:
  > "Ok, mira, lo que tenemos que hacer actualmente es, analizar un poco de lo que estuvimos trabajando últimamente. ¿A qué me refiero? Bueno. Estuvimos trabajando. En. Eh, todo lo que sería la mejora de la orquestación. Subagentes y demás. Lo cual está bien. Pero también tenemos que continuar trabajando en el asistente. En las cosas que puede realizar. En el modo de voz, que está bastante conectado con el asistente. En todo este tipo de cosas. Al mismo tiempo en. La parte de agentes. Entonces quiero que armes un ODD para cada uno. O para cada cosa, que elije. Rápidamente. Pero claro, no quiero cambios tan ligeros, sino que quiero que sean muy detallados. Con respecto a. Evidenciar avances. Eh nosotros ya examinamos otras soluciones y creo que tenemos ODDs pendientes. Tal vez, o tal vez, puedes analizar los últimos en los que trabajamos con respecto a las cosas que mencioné. Para continuar. Mejorando y haciendo mucho más profesional todo esto."
  - Audited `odd/tasks/argos-voice-mode-roadmap.md` (`T0–T10 [x]`), `odd/tasks/thread-voice-mode.md` (`T1–T21 [x]`), `odd/tasks/elevenlabs-streaming-tts-zed.md` (`AC1–AC6 [x]`), `odd/tasks/seth-voice-latency-optimization.md` (`0/7` implemented — `T1–T7` all open), `odd/tasks/settings-consolidation-and-overhaul.md` (`T4` open), `src-tauri/src/dictation.rs`, and `src/lib/operator/`.
  - Created `odd/tasks/voice-mode-native-and-realtime-engine.md` (`S1–S7`, `T1–T8`) absorbing the 7 pending latency tasks and charting the native Rust WASAPI audio stack, local offline STT, optional full-duplex Realtime transport, and consolidated Audio settings. Awaiting user authorization before `T1`.
