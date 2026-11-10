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

## Tasks

- [ ] **T1** (`S2`) — Route: `inline` — Cross-CLI index and one-chat read. Re-evaluate the route at implementation. No commit yet.
- [ ] **T2** (`S4`) — Route: `inline` — Load the existing short notes on the live turn, without a second store. No commit yet.
- [ ] **T3** (`S3`) — Route: `inline` — Assistant launches a thread through the existing dispatch thread family, and still launches a terminal. No commit yet.
- [ ] **T4** (`S5`) — Route: `inline` — Open voice session on the orb, streamed narration, barge-in, same actions. No commit yet.
- [ ] **T5** (`S1`, `S5`) — Route: `inline` — Spoken notice when a launched agent finishes. No commit yet.

T1–T5 share the operator turn. They are not independent. Do not split them across parallel writers.

## Log

- **L1 (2026-11-10)**: `"Necesito que investiguemos completamente. Una mejora. Específica para. El asistente. Que tenemos integrado."` `"los voice mode. O el modo voz."` `"estar hablando con la gente, te va contactando en tiempo real."` `"Todo responde mucho más rápido"` `"evaluar qué es lo que tenemos actualmente. Ver cómo podemos mejorarlo. ¿De qué podemos agregar?"` The request also named reference programs and an investigation tool. That comparison is kept in the internal note, not here.
- **L2 (2026-11-10)**: `"Tiene que ser un agente. O un asistente. Que ya tenemos básicamente pero. Mucho más útil."` `"Leer chats, tal vez"` `"una memoria unificada"` `"puede consultar otros chats. Revisar, básicamente, cosas interiores."` `"funciones para todos los CLI, una memoria unificada. Que sea optimizado, claramente no. Que consulte y sea muy lento. Aunque eso sí es costoso."` `"un agente bastante general que pueda realizar acciones en la aplicación, lanzar agentes"` `"Tanto del terminal como de otro tipo."` `"no manejamos solamente en la parte de de code"` `"Prea agents."` `"avance sustancial"`
- **L3 (2026-11-10)**: `"quisiera que me des ideas. De partes que podemos agrandar tal vez. Para mejorar."`
- **L4 (2026-11-10)**: User confirmed the four parts: index then one read, launch a thread as well as a terminal, short memory always loaded and separate from chats, and voice as the mouth of this assistant with an open session and streamed narration. Verbatim: `"si me parece correcto, arma el odd compeltamente, considera no cambiar de rama, haz tus commits relacionados con esto solametne para separar de lo otro que estamos trabajando en paralelo"`
- **L5 (2026-11-10)**: `"quiero que se implemente en su totalidad, quiero que uses la mayor canditidad de agnetes en paralelo posible para hacelro mas rapido quiero decir un tope  de 5 agentes en paralelo sin que se solapen claramente y cuando sea posible"`
  Parallel writers are allowed only on disjoint files. The parent owns `planner/prompt.ts` index lines, `ZedStrip.tsx`, and git. Do not switch branches.
