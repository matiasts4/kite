# Argos Assistant & Voice Mode Architecture

**Argos** is Kite Code's unified conversational operator assistant and live Voice Mode engine (`odd/tasks/argos-voice-mode-roadmap.md`).

---

## 1. Option A — Unified Session Across Two Adaptive Surfaces

Argos and Voice Mode share a single session store (`src/lib/operator/voice/voiceSessionStore.ts`) and turn execution coordinator (`src/lib/operator/index.ts`):

- **Thread & Agent Mode (`SingleThreadPane.tsx`, `AgentChatShell.tsx`, `VoiceModeFooterBar.tsx`)**:
  - Docks the live session directly into the conversation stage and composer footer.
  - Projects spoken user prompts, live stage commentary, `ActionReceipt` / `consultChats` rows, post-call session summary cards, and live `SubagentActivityCard` items inline in chronological order.
- **Code Mode (`ArgosStrip.tsx`, `ArgosOrb.tsx`)**:
  - Morphs the active session into the floating studio-grade WebGL2 orb and micro-dock without dropping microphone capture or losing thread history.
- **Global Companion Bar (`ArgosCompanionBar.tsx`, `companionTransfer.ts`)**:
  - Toggled via `Alt+Space`, coordinating single-host microphone ownership across windows (`VoiceHostSingletonClaim`) and live call transfers (`Thread <-> Orb <-> Companion`) with 1-click visual context snapshots (`captureVisualContextSnapshot`).

---

## 2. Consultative Multi-Turn Loop (`Peek -> Propose -> Hands-Free Refine -> Delegate`)

1. **Fast Read-Only Peeks (`<= 450 ms`, `src/lib/operator/executor/actions/peekWorkspace.ts`)**:
   - `peek_changes`, `peek_runs`, `peek_agents`, `peek_files` (backed by `kite-ctx`), and `recall_conversations`.
2. **Multi-Turn Task Proposals (`DraftTaskProposal` & `ConsultativeDraftCard.tsx`)**:
   - Non-trivial delegations create or refine a `DraftTaskProposal` (`propose_task` -> `refine_proposal` -> `confirm_proposal` / `cancel_proposal`), rendered live above the composer and confirmed hands-free by voice (`"dale"`, `"confirmar"`, `"lánzalo"`) or click.
3. **Line-State Arbitration & Hands-Free Reply Window (`turnArbitrator.ts`)**:
   - Enforces a `180 ms` post-TTS anti-echo guard (`post_tts_guard`) followed by an automatic `12 s` hands-free reply window (`awaiting_reply`) with a soft Web Audio chime, while folding concurrent subagent returns (`foldedUpdates`) and supporting `stay_silent`.

---

## 3. `kite-ctx` Native Bridge (`src-tauri/crates/kite-ctx/` & `src-tauri/src/ctx_bridge.rs`)

- **`CrusherConfig::voice()` (`pack_voice_context`)**: Compresses dynamic workspace, terminal, and subagent context below `250 tokens` per turn.
- **`KvAligner::plan_voice_window`**: Separates the 100% static `messages[0]` prefix of Argos from batch-frozen conversation history for high KV cache hit ratios.
- **`SharedContextStore` & `CcrStore`**: Shares subagent briefs (`brief:<role>`) and findings (`finding:<childThreadId>`, `<<ccr:HASH>>`) with zero prompt bloat.
