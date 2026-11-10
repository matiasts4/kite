# Assistant reach

Objective: Make the existing assistant more useful. It keeps a short memory, consults one other chat when the question needs it, launches a terminal or a thread, and speaks in an open session.
Branch: `feat/response-thread`. Do not switch branches. Commits for this feature contain only this feature's files.
Delivery strategy: `ask-on-risk`. Forecast: implementation exceeds about 400 authored lines. Ask before the slice that crosses that count.
Test runner: `npx vitest run`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.

Constraints: no second assistant, no new pane, no new send protocol, and no full transcript dump on a normal turn. Existing one-shot dictation, terminal launch, and dispatch flags stay. Do not delete or rewrite existing memory notes.

## Specs

- **S1 — The assistant we already have, used for more**:
  - User verbatim: `"Tiene que ser un agente. O un asistente. Que ya tenemos básicamente pero. Mucho más útil."`
  - User verbatim: `"un agente bastante general que pueda realizar acciones en la aplicación"`
  - The floating assistant is the agent. Voice, memory, chat lookup, and launches are capabilities of that assistant, not a second product and not a second brain.
  - It keeps the actions it already has. S2–S5 add reach. They do not replace those actions.
  - Acceptance: a person still starts from the same orb. No new assistant window appears.

- **S2 — An index, then one read, across every CLI**:
  - User verbatim: `"Leer chats, tal vez"`
  - User verbatim: `"puede consultar otros chats. Revisar, básicamente, cosas interiores."`
  - User verbatim: `"funciones para todos los CLI, una memoria unificada. Que sea optimizado, claramente no. Que consulte y sea muy lento. Aunque eso sí es costoso."`
  - Accepted behavior: an index of title, CLI, and last decision. If the question needs one chat, that chat is opened. The other chats are not put in the prompt.
  - The index covers every CLI the app already launches. It does not add a CLI.
  - A normal turn receives the index, not the transcripts. Listing is not a review. Reviewing the inside of a chat is a separate read of that one chat.
  - A question that does not name or need a chat must not read every transcript. A question that needs one chat reads that chat and no other.
  - If the index has no matching chat, the assistant says so. It does not invent a transcript and it does not fall through into a full scan.
  - If the one read fails, the assistant names the chat and the failure. It does not scan the rest to compensate.
  - Acceptance: a fixture with many transcripts proves a normal turn does not read them all, and a turn that asks about one chat reads that chat.

- **S3 — Launch a terminal or a thread**:
  - User verbatim: `"lanzar agentes, eh. Tanto del terminal como de otro tipo."`
  - User verbatim: `"no manejamos solamente en la parte de de code"`
  - Accepted behavior: a terminal stays a live pane. A thread can be resumed. Both remain. The assistant chooses.
  - Launching a terminal keeps today's behavior, including the default shell unless the person names an agent.
  - Launching or messaging a thread uses the existing dispatch thread family (`--via thread`). Do not add a second submit path and do not change that flag.
  - A thread launch does not require a terminal pane and does not force Code mode.
  - If the person asked for a thread and the launch fails, the assistant reports the failure. It does not open a terminal instead.
  - If the person asked for a terminal, the assistant does not open a thread instead.
  - Acceptance: one request opens a terminal agent as today. Another request submits to a thread through dispatch and leaves the terminal list unchanged.

- **S4 — Short memory, always loaded, separate from chats**:
  - User verbatim: `"una memoria unificada"`
  - Accepted behavior: a short memory of the assistant's own, loaded on every live turn, separate from chats. The full chat is read only when needed.
  - Reuse the assistant's existing local notes. Do not create a second memory store. Do not delete, migrate, or rewrite notes that are already stored.
  - The live planner loads those notes. A note is not a copy of a chat, and a chat read does not automatically become a note.
  - The assistant does not answer from another chat's contents unless S2 selected that chat.
  - Acceptance: a live turn's planner input contains the notes. It does not contain another chat's transcript unless that chat was the one read. Existing notes survive a turn unchanged when the turn does not edit them.

- **S5 — Voice is the mouth of this same assistant**:
  - User verbatim: `"los voice mode. O el modo voz."`
  - User verbatim: `"estar hablando con la gente, te va contactando en tiempo real."`
  - User verbatim: `"Todo responde mucho más rápido"`
  - Accepted behavior: the open session is the channel, not another product. Narration starts as audio arrives. It does not wait for the whole file.
  - The session stays on the existing orb. It does not open a pane.
  - Starting voice mode opens a session that stays open across turns until the person ends it. One reply does not close the microphone.
  - The current press-and-release dictation still takes one utterance and closes. Voice mode is a distinct control on the orb. It does not steal the current dictation gesture.
  - If the person speaks while the assistant is speaking, playback stops and the session stays open. That speech is the next turn.
  - The orb shows listening, thinking, speaking, and a failed session as distinct states. A failure to open the session does not disable one-shot dictation.
  - A voice turn can use the same actions as a typed turn, including S3. The spoken text is the mouth. The action still runs.
  - When an agent the assistant launched finishes, the assistant speaks a short notice. If a voice session is open, it speaks through that session. If not, it speaks the notice without opening a session, and the existing notification still fires.
  - The session does not survive closing the window.
  - No voice CLI. No command for another agent to read voice status. No per-packet audio trace.
  - Acceptance: a session survives a reply and a barge-in. Playback begins before the full audio body exists. One-shot dictation still resolves one transcript and stops. A finished launched agent produces one spoken notice.

- **S6 — Single speech playback per turn (no double speaking)**:
  - User verbatim: `"Como dije, está contestando dos veces, ya sea utilizando la forma heurística o la forma con el modelo de IA, cosa errónea claramente."`
  - Accepted behavior: a reply is narrated exactly once per turn.
  - Speech playback in `ZedStrip.tsx` is guarded by turn ID so re-renders or state changes during the `'done'` window do not re-trigger narration.
  - Calling `runOperatorTurn` from the UI orb does not fire concurrent dual speech against `ZedStrip` auto-speak.
  - Acceptance: a heuristic turn and an LLM turn both speak the reply once and never trigger duplicate speech playback.

- **S7 — Natural speech playback duration without arbitrary cutoff**:
  - User verbatim: `"la duración de las respuestas no se procesan en su totalidad, si es que llega hasta cierto segundo, se corta. Deben ser 15 segundos exactos y se corta si es que la respuesta se pasa de eso, cosa que está mal."`
  - Accepted behavior: speech narration plays to completion regardless of duration.
  - In browser synthesis fallback, long text is spoken without hitting the Chromium 15-second freeze by chunking sentences or maintaining active keepalive heartbeats, and safety timers scale strictly with text length.
  - In ElevenLabs streaming playback, audio streams continuously until the end of stream without synthetic truncation.
  - Acceptance: a response lasting longer than 15 seconds plays through to completion without prematurely cutting off.

- **S8 — Prior chat transcripts and memory reach wired to live LLM planner**:
  - User verbatim: `"Le pregunté sobre cosas como la memoria o si tuviera si tiene contexto de conversaciones anteriores de, no lo sé, antigravity o demás. Bueno, eso me respondió que no tiene acceso a nada."`
  - Accepted behavior: the live LLM planner receives cross-CLI chat reach and existing memory notes.
  - When the user asks about prior conversations, chats, or historical decisions (e.g. antigravity, claude, codex, kite), `consultChats` is invoked and the relevant transcript or chat catalog is injected into the planner prompt.
  - `launch_thread` is documented in the LLM system prompt's JSON schema so the AI planner can directly launch threads when requested.
  - Acceptance: asking the assistant about prior conversations with an agent or antigravity reads the matching chat context instead of claiming zero access.

- **S9 — Comprehensive operator trace logging & quick debug access**:
  - User verbatim: `"La idea es poder llegar a testear y debuguear de forma rápida dejando o almacenando logs de toda la traza que se ejecute por el asistente Zed. Es decir, si yo le hablo, quiero que se deje registrado qué fue lo que hizo, qué cosas consultó y así, básicamente para luego llegar a debuguear una traza de acciones que hizo."`
  - Accepted behavior: every operator turn, whether executed via heuristic or LLM, records full event traces (input, strategy, provider, latency, actions, receipts, tools consulted, consultChats results) to disk via `operator_trace_append`.
  - Settings UI (`ZedTab.tsx`) and the operator strip provide direct one-click access to open the operator traces log directory on disk for fast debugging and testing.
  - Acceptance: executing a turn appends the complete trace to the disk JSONL file, and the settings view offers a functional button to reveal the trace logs folder.

- **S10 — Uncapped natural spoken replies without mid-word or 280-character slicing**:
  - User verbatim: `"No me respondió en los primeros dos. En el último que sí me respondió, se cortó."`
  - User verbatim: `"la duración de las respuestas no se procesan en su totalidad, si es que llega hasta cierto segundo, se corta. Deben ser 15 segundos exactos y se corta si es que la respuesta se pasa de eso, cosa que está mal."`
  - Accepted behavior: conversational answers (`answer` and `reply`) are not sliced down by a short 280-character default in `sanitizeReply`.
  - The default limit for conversational text is raised to at least 1200 characters, and trimming preserves complete sentence boundaries without appending trailing ellipses mid-word.
  - Acceptance: a conversational answer longer than 280 characters is not chopped mid-sentence or mid-word.

- **S11 — Visual thread navigation, provider recognition, and human receipt speech**:
  - User verbatim: `"le dije que que que abriera un nuevo thread con Grok. Y me respondió. Utilizando un código, creo. Como el código de. Identificador de esa, de ese thread. Me dijo que lo abrió, no veo nada."`
  - Accepted behavior: `launch_thread` schemas in planner prompts and heuristics accept `"provider"` (`grok`, `claude`, `codex`, `antigravity`, `opencode`) and pass it to chat creation.
  - Creating or opening a thread emits `kite:threads-changed` and `kite:select-thread` so the application switches to thread view and focuses the new thread on screen.
  - The receipt speech (`summaryEs`) speaks clean, human-friendly status (e.g. `"Nuevo hilo con Grok iniciado."`) without reading raw UUIDs aloud.
  - Acceptance: asking the assistant to launch a thread with a provider creates the thread with that provider, opens and focuses it visually in the UI, and speaks a friendly message without UUIDs.

- **S12 — Intent-based cross-CLI chat transcript reach in consultChats**:
  - User verbatim: `"Le pregunté sobre cosas como la memoria o si tuviera si tiene contexto de conversaciones anteriores de, no lo sé, antigravity o demás. Bueno, eso me respondió que no tiene acceso a nada."`
  - Accepted behavior: `consultChats` recognizes natural queries asking about prior chats, history, or context of a provider or CLI (e.g. antigravity, grok, claude).
  - When matching multiple candidates for a provider query, it reads the most recent chat transcript instead of rejecting with `not-one`.
  - The LLM prompt explicitly instructs the model to explain prior discussions based on the retrieved transcript context rather than asserting lack of access.
  - Acceptance: natural questions about previous chats with antigravity or grok load transcript context and produce informative answers.

- **S13 — Turn synchronization and empty/discarded mic capture tracing**:
  - User verbatim: `"No me respondió en los primeros dos. En el último que sí me respondió, se cortó."`
  - Accepted behavior: `useOperatorTurn` updates `lastTurn` atomically with the `'done'` / `'error'` stage transition to eliminate state race conditions in auto-speak.
  - Discarded voice captures (empty audio, silence, or failed STT) in `zedVoice.ts` emit trace records so all mic interaction attempts are persisted and observable in `operator-traces/*.jsonl`.
  - Acceptance: silence or discarded microphone input leaves an explicit trace entry in the JSONL log file.

## Tasks

- [x] **T1** (`S2`) — Route: `inline` — Cross-CLI index and one-chat read (`chatIndex.ts` + `chatIndex.test.ts` 5/5 green). Commit: `d4a4e2f`.
- [x] **T2** (`S4`) — Route: `inline` — Load the existing short notes on the live turn, without a second store (`prompt.ts` + `prompt.test.ts` 4/4 green). Commit: `d4a4e2f`.
- [x] **T3** (`S3`) — Route: `inline` — Assistant launches a thread through the existing dispatch thread family, and still launches a terminal (`heuristic.ts` + `launchThread.ts` + `executor.test.ts` 23/23 green). Commit: `d4a4e2f`.
- [x] **T4** (`S5`) — Route: `inline` — Open voice session on the orb, streamed narration, barge-in, same actions (`ttsNarrator.ts` + `ZedStrip.tsx` + tests 21/21 green). Commit: `830efa1`.
- [x] **T5** (`S1`, `S5`) — Route: `inline` — Spoken notice when a launched agent finishes (`proactiveWatcher.ts` + `proactiveWatcher.test.ts` 9/9 green, wired to session). Commit: `d4a4e2f` / `830efa1`.
- [x] **T6** (`S6`) — Route: `inline` — Guard speech narration to strictly once per turn using `lastSpokenTurnIdRef` in `ZedStrip.tsx` and prevent dual TTS dispatch in `runOperatorTurn`. Commit: `f57cf34`.
- [x] **T7** (`S7`) — Route: `inline` — Prevent 15s premature cutoff in `ttsNarrator.ts` (sentence chunking/heartbeat in browser synthesis, extended safety timer, uninterrupted streaming). Commit: `f57cf34`.
- [x] **T8** (`S8`) — Route: `inline` — Wire `consultChats` into `planTurnLLM` and prompt context, and add `launch_thread` to LLM system prompt schema. Commit: `f57cf34`.
- [x] **T9** (`S9`) — Route: `inline` — Ensure complete trace logging (including chat consultations) to disk JSONL and expose a direct button to reveal logs folder in `ZedTab.tsx`. Commit: `f57cf34`.
- [x] **T10** (`S10`) — Route: `inline` — Uncap conversational replies in `sanitizeReply` and `composeReplyFromReceipts` with sentence-boundary trimming (`sanitize.ts` + `sanitize.test.ts` 13/13 green).
- [x] **T11** (`S11`) — Route: `inline` — Wire `launch_thread` provider support, UI navigation event (`kite:select-thread`), and clean receipt speech in `launchThread.ts`, `prompt.ts`, `App.tsx` (`executor.test.ts` 23/23 green).
- [x] **T12** (`S12`) — Route: `inline` — Expand `consultChats` in `chatIndex.ts` for provider history queries and prompt LLM to summarize from transcripts (`chatIndex.test.ts` 6/6 green, `prompt.test.ts` 5/5 green).
- [x] **T13** (`S13`) — Route: `inline` — Synchronize `lastTurn` with `stage = 'done'` in `useOperatorTurn.ts` and trace discarded mic captures in `zedVoice.ts` (`zedVoice.test.ts` 9/9 green, `useOperatorTurn.test.ts` 16/16 green).

T1–T13 share the operator turn. They are not independent. Do not split them across parallel writers.

## Log

- **L1 (2026-11-10)**: `"Necesito que investiguemos completamente. Una mejora. Específica para. El asistente. Que tenemos integrado."` `"los voice mode. O el modo voz."` `"estar hablando con la gente, te va contactando en tiempo real."` `"Todo responde mucho más rápido"` `"evaluar qué es lo que tenemos actualmente. Ver cómo podemos mejorarlo. ¿De qué podemos agregar?"` The request also named reference programs and an investigation tool. That comparison is kept in the internal note, not here.
- **L2 (2026-11-10)**: `"Tiene que ser un agente. O un asistente. Que ya tenemos básicamente pero. Mucho más útil."` `"Leer chats, tal vez"` `"una memoria unificada"` `"puede consultar otros chats. Revisar, básicamente, cosas interiores."` `"funciones para todos los CLI, una memoria unificada. Que sea optimizado, claramente no. Que consulte y sea muy lento. Aunque eso sí es costoso."` `"un agente bastante general que pueda realizar acciones en la aplicación, lanzar agentes"` `"Tanto del terminal como de otro tipo."` `"no manejamos solamente en la parte de de code"` `"Prea agents."` `"avance sustancial"`
- **L3 (2026-11-10)**: `"quisiera que me des ideas. De partes que podemos agrandar tal vez. Para mejorar."`
- **L4 (2026-11-10)**: User confirmed the four parts: index then one read, launch a thread as well as a terminal, short memory always loaded and separate from chats, and voice as the mouth of this assistant with an open session and streamed narration. Verbatim: `"si me parece correcto, arma el odd compeltamente, considera no cambiar de rama, haz tus commits relacionados con esto solametne para separar de lo otro que estamos trabajando en paralelo"`
- **L5 (2026-11-10)**: `"quiero que se implemente en su totalidad, quiero que uses la mayor canditidad de agnetes en paralelo posible para hacelro mas rapido quiero decir un tope  de 5 agentes en paralelo sin que se solapen claramente y cuando sea posible"`
  Parallel writers are allowed only on disjoint files. The parent owns `planner/prompt.ts` index lines, `ZedStrip.tsx`, and git. Do not switch branches.
- **L6 (2026-11-10)**: User requested full completion verbatim: `"quiero que lo temrines completmaente"`. Verified and completed T1 through T5 across streaming narration, continuous voice mode, barge-in, thread launches, notes injection, and cross-cli chat index. All 110 unit tests passing, tsc clean, audit references clean.
- **L7 (2026-11-10)**: User reported 4 critical defects verbatim: `"la duración de las respuestas no se procesan en su totalidad, si es que llega hasta cierto segundo, se corta. Deben ser 15 segundos exactos y se corta si es que la respuesta se pasa de eso, cosa que está mal."` `"Como dije, está contestando dos veces, ya sea utilizando la forma heurística o la forma con el modelo de IA, cosa errónea claramente."` `"Le pregunté sobre cosas como la memoria o si tuviera si tiene contexto de conversaciones anteriores de, no lo sé, antigravity o demás. Bueno, eso me respondió que no tiene acceso a nada."` `"La idea es poder llegar a testear y debuguear de forma rápida dejando o almacenando logs de toda la traza que se ejecute por el asistente Zed. Es decir, si yo le hablo, quiero que se deje registrado qué fue lo que hizo, qué cosas consultó y así, básicamente para luego llegar a debuguear una traza de acciones que hizo. Eso creo que ya existe, pero quiero tal vez mejorarlo, si es que no existe, hay que implementarlo. Para tenerlo estructurado, también hay que actualizar el ODD con respecto a esto. Quiero que implementes todo."` Appended specs S6–S9 and tasks T6–T9.
- **L8 (2026-11-10)**: User evaluated live traces and approved 4-point fix plan verbatim: `"Okey, estoy probando. Me gustaría saber si puedes obtener esa, esos intentos que estuve haciendo. Como consideración. No me respondió en los primeros dos. En el último que sí me respondió, se cortó. Bueno, por las casualidades, le dije que que que abriera un nuevo thread con Grok. Y me respondió. Utilizando un código, creo. Como el código de. Identificador de esa, de ese thread. Me dijo que lo abrió, no veo nada. No sé exactamente si tiene las capacidades como para abrir threads, pero bueno. Fue lo que intenté. Eh, tenemos que planear una corrección bastante más grande. No quiero que llegues y corrijas, sino que me digas realmente qué es lo que intentarás corregir como tal en esta iteración. Para que evaluemos si es que está correcto o no."` and `"si vamos con eso"`. Appended specs S10–S13 and tasks T10–T13.
