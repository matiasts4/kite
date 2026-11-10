# Thread Voice Mode — Live Voice Session, Inline Trace Timeline, and Locked Assistant Footer

Objective: Integrate the existing Zed voice assistant (`odd/tasks/assistant-reach.md`) into the `Thread` (`chat`) surface as a live conversational voice mode. Pressing the Voice Mode button in the thread composer opens a continuous voice session bound to that thread, swaps the bottom composer controls for a locked (non-editable) assistant model badge and live call controls, projects user utterances, live stage commentary, and structured operator traces (`ActionReceipt`, `consultChats`) directly into the thread timeline, and coordinates seamlessly with the `Code`-mode floating orb (`ZedStrip.tsx`).
Branch: `feat/response-thread`. Do not switch branches. Commits for this feature contain only this feature's files.
Delivery strategy: `ask-on-risk`. Forecast: implementation exceeds about 400 authored lines across composer, timeline, and session coordination. Ask before the slice that crosses that count.
Test runner: `npx vitest run src/components/views/chat src/lib/operator`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Connected ODDs:
- Foundation (upstream engine, memory, cross-CLI chat reach, streaming TTS, and JSONL disk traces): `odd/tasks/assistant-reach.md` (`S1–S13`).
- Thread surface counterparts: `odd/tasks/thread-timeline-surface.md` and `odd/tasks/thread-composer-and-navigation.md`.

Constraints: no second assistant brain, no duplicate TTS playback, no editable thread model picker while in Voice Mode, and no arbitrary pixel radii or heights (`AGENTS.md` §1–§3). In `Code` mode, the floating orb (`ZedStrip.tsx`) remains the non-intrusive surface; in `Thread` mode, the thread timeline and composer host the live voice conversation and its full execution trace.

---

## Thread Voice Mode Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Thread Timeline (`SingleThreadPane.tsx` — `.chat-transcript`)              │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 🎙 User Voice Bubble: "Abrime dos terminales con Grok y revisa auth" │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ ▾ Traza del Asistente Zed (2 acciones · 1 consulta · 340 ms)     [OK]│  │
│  │   ├─ 🔍 Consulta de chats: índice del proyecto (3 hilos)             │  │
│  │   ├─ ⚡ open_terminals: 2 terminales con Grok abiertas     [Verificado]│  │
│  │   └─ ⚡ launch_thread: Hilo con Claude para auth           [Verificado]│  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ✨ [Shimmer en vivo cuando ejecuta]: "Verificando terminales abiertas…"   │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 🔊 Zed Assistant Reply: "Abrí 2 terminales con Grok..."              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────────────────┤
│ Composer Card in Voice Mode (`ChatComposer.tsx` — `rounded-card` 12px)     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Hybrid Textarea: "Escribir en la sesión de voz…"                     │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Voice Mode Footer (`32px` controls, standard pickers hidden)         │  │
│  │ [+ disabled]    [🔒 Zed · Grok / ElevenLabs]  [🎙] [🔊] [ılı Finalizar]│  │
│  │                 (o cambia a [Enviar ↵] si hay texto en el borrador)  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Specs

- **S1 — Voice Mode Entry Point in Thread Composer & Coexistence with One-Shot Dictation**:
  - User verbatim: `"en la parte de Thread, que sería la más similar que tenemos a ellos, para las conversaciones, agregan una parte. Que, apretando un botón, se abre el voice mode."`
  - User verbatim: `"Luego, cómo es una sesión en vivo. Se puede seguir hablando claramente."`
  - Accepted behavior:
    - `ChatComposer.tsx` renders a dedicated `32px × 32px` (`size-8 rounded-control`) **Voice Mode** button in the right control cluster next to the existing one-shot dictation button (`.chat-dictate-control`).
    - The existing one-shot dictation button keeps its current behavior: it records one utterance into the composer text draft and stops.
    - Clicking the Voice Mode button (or triggering the voice session shortcut while in `Thread` mode) starts a continuous live voice session bound to the active thread (creating a new thread automatically if none is selected).
    - If the user activates one-shot dictation while a Voice Mode session is open, the continuous voice session microphone pauses cleanly during dictation and resumes when dictation finishes.
  - Acceptance: clicking the Voice Mode button in `ChatComposer` enters live Voice Mode for the active thread without breaking one-shot dictation.

- **S2 — Locked Assistant Model Badge & Live Call Controls Footer in `ChatComposer`**:
  - User verbatim: `"la parte de abajo de los modelos, claramente no puede mostrar los modelos por defecto. Sino que, el que se seleccione para el, asistente como tal. Ya que no. No debería ser como. Movible o editable para que no tenga esa. Imperfección en cuanto a rendimiento."`
  - User verbatim: `"utilizar la misma configuración que se tiene actualmente de el asistente Zed. Eh, para hablar, para escuchar, para. Pensar, mismo modelo. Y todo ese tipo de cosas."`
  - Accepted behavior:
    - While Voice Mode is active in `ChatComposer`, the standard thread footer pickers (`ModelPickerPopover`, `EffortSliderPopover`, `WorkModePickerPopover`, `PermissionPickerPopover`, `ConnectionPickerPopover`) are hidden and replaced by the **Voice Mode Footer Bar** (while keeping the lower `ComposerContextStrip` intact):
      1. **Left cluster (`.kite-composer-footer-left`)**:
         - **Locked Assistant & Brain Model Badge (Non-Editable)**: Placed in the exact left slot where the model picker normally sits. Reads `getConfiguredAssistantDisplay()` from `loadOperatorConfig()` + `resolveVerifiedModel()` (`activeProvider`, resolved brain model ID such as `deepseek-v4.1-flash` or `grok-4.7`, and `ttsEngine` `ElevenLabs` / `Voz Nativa`) and renders a read-only badge with a model chip.
         - **Live Voice Activity Pill (`voice-live-status-pill`)**: Displays a live status dot and real-time stage/speech feedback (`"Escuchando…"`, `"«transcripción parcial…»"`, `"Pensando…"`, `"Hablando…"`, or `"Micrófono silenciado"`).
      2. **Right Call Controls Cluster (`.kite-composer-footer-right`)**:
         - Disabled attachment button (`+` / paperclip) while call is live.
         - **Mic Mute Toggle** (`aria-pressed`): mutes or unmutes microphone capture while keeping the voice session open.
         - **Speaker Mute Toggle** (`aria-pressed`): mutes or unmutes spoken narration (`ttsNarrator.stop()` immediately on mute) while continuing to stream text replies and traces into the thread.
         - **Active Waveform & End Stadium Pill** (`rounded-pill`): accent blue stadium pill (`#339cff`) with a live 28×12px audio waveform canvas + `"Finalizar"`.
  - Acceptance: activating Voice Mode hides the editable thread model/effort/permission pickers, displays the locked assistant model badge with resolved brain model and live status pill on the left, retains the lower context strip, and exposes functional Mic Mute, Speaker Mute, and Waveform/End controls on the right.

- **S3 — Hybrid Text Input & Dynamic Send Swap During Active Voice Mode**:
  - User verbatim: `"Luego, cómo es una sesión en vivo. Se puede seguir hablando claramente. Entonces ahí van apareciendo las cosas y la traza de todo."`
  - Accepted behavior:
    - While Voice Mode is active, the composer `<textarea>` remains active above the voice footer with placeholder `"Escribir en la sesión de voz…"`.
    - When the textarea draft is empty, the right cluster of the footer shows the 3 call controls (`Mic Mute`, `Speaker Mute`, `Finalizar`).
    - When the user types non-empty text into the textarea while in Voice Mode, the right cluster dynamically swaps to the primary **Enviar** button (and `Enter` submits the text). Submitting dispatches the text as an operator turn (`runOperatorTurn`) within the same active voice session, appends the user message, trace cards, and assistant reply to the thread timeline, narrates the reply if speaker is unmuted, clears the draft, and restores the 3 call controls.
  - Acceptance: typing in the composer during an active voice session swaps the right controls to Send, executes the turn through the assistant without closing the voice session, and restores the call controls once sent.

- **S4 — Live Conversation & Inline Operator Trace Projection in the Thread Timeline**:
  - User verbatim: `"Bueno, ahí se puede ver como una conversación. Dependiendo eh, se ve como una conversación de toda la traza, por ejemplo, lo que tú dijiste, lo que hizo la gente, lo que contestó."`
  - User verbatim: `"Entonces ahí van apareciendo las cosas y la traza de todo. Lo que yo digo, lo que dice la gente, lo que ejecuta la gente y así."`
  - Accepted behavior:
    - Every operator turn executed while bound to a thread (spoken via microphone or typed via S3) projects its full lifecycle in real time into the thread timeline (`SingleThreadPane.tsx`):
      1. **User Turn Bubble**: Appended as soon as speech transcription completes (or hybrid text is sent), marked with a subtle voice indicator when originated from speech.
      2. **Live Stage Commentary Row (`VoiceCommentaryRow`)**: While the turn is active (`planning`, `executing`, `verifying`), renders an inline shimmer status row inside the timeline showing the live step from the trace bus (`"Planificando con <provider>…"`, `"Consultando índice de conversaciones…"`, `"Leyendo conversación «<title>»…"`, `"Ejecutando <action.type>…"`, `"Verificando recibo…"`).
      3. **Structured Trace & Action Receipts Group**:
         - Renders a collapsible/inspectable trace block in the timeline for the turn containing:
           - **Chat & Memory Reach (`consultChats`)**: whether the turn consulted the cross-CLI index (`index`), read a specific chat transcript (`read` with title and CLI), or missed (`miss`).
           - **Action Receipts (`ActionReceipt[]`)**: each action executed (`open_terminals`, `close_terminals`, `inject_prompt`, `launch_thread`, `handoff_to_agent`, `manage_pane_layout`, `switch_workspace`, `narrate_summary`, `open_browser`) with its human summary (`summaryEs`), target/engine parameters, execution duration (`durationMs`), and verification badge (`Verificado` / `Fallo`).
           - **Delegation & Launch Cards**: when the turn opens a terminal agent or launches/messages a thread, an inline card shows the created/targeted resource so the user can see and click it from the conversation.
      4. **Assistant Reply Bubble**: Appended with the full `reply` / `answer` text (`odd/tasks/assistant-reach.md` `S10`) as voice narration begins.
    - Supports barge-in (`odd/tasks/assistant-reach.md` `S5`): if the user speaks while the assistant is narrating, TTS stops immediately and the new utterance begins the next timeline turn.
  - Acceptance: speaking a command or question in Thread Voice Mode renders the user bubble, live stage shimmer, structured trace/receipts block, and assistant reply bubble in the thread timeline.

- **S5 — Unified Brain & Seamless Mode Handshake (`Thread` Mode vs `Code` Mode)**:
  - User verbatim: `"tenemos una especie de choque porque, ahora mismo tenemos el asistente que hace cosas. Pero, para la parte de code sirve no ver lo que hace o la traza, pero para la parte de thread sí sirve ya que es una parte estructurada donde podemos ver. La. La traza de las cosas que hace. Y de lo que uno dice claramente."`
  - User verbatim: `"Quiero decir, este nuevo DD tiene que estar claramente conectado con el anterior del asistente."`
  - Accepted behavior:
    - `Thread` Voice Mode and the `Code`-mode floating orb (`ZedStrip.tsx`) share a single voice session coordinator (`voiceSessionStore.ts`) and the same `useOperatorTurn` / `runOperatorTurn` pipeline from `odd/tasks/assistant-reach.md`.
    - When the user is in **`Code` mode**, `ZedStrip.tsx` remains the active compact orb surface so code and terminal panes stay unobstructed.
    - When the user is in **`Thread` (`chat`) mode** with Voice Mode active, `ChatComposer` and `SingleThreadPane` own the visual controls and narration trigger; `ZedStrip.tsx` suppresses duplicate orb auto-speak and hides/minimizes its redundant session controls so the assistant never speaks twice (`odd/tasks/assistant-reach.md` `S6`).
    - If a voice turn started in `Thread` mode executes an action that switches the app to `Code` mode (e.g., `"abre dos terminales con Grok"`), the voice session remains open seamlessly on the `Code`-mode orb, while the turn's transcript and action trace are still recorded in the originating thread's timeline.
  - Acceptance: starting Voice Mode in a thread never triggers duplicate speech from `ZedStrip`, and switching between `Thread` and `Code` modes during an open voice session preserves the active call and records the turn in the bound thread.

- **S6 — Session Persistence & Post-Call Thread Continuity**:
  - Accepted behavior:
    - All user voice turns, inline operator trace cards, and assistant replies recorded during a Thread Voice Mode session remain persisted in the thread's conversation history (in addition to the disk trace in `operator-traces/*.jsonl` from `odd/tasks/assistant-reach.md` `S9`).
    - Clicking **Finalizar** flushes any pending transcription, stops the microphone and active narration, restores the standard `ChatComposer` footer pickers (`ModelPickerPopover`, etc.), and keeps the entire voice conversation and trace history in the thread so the user can review what was executed or continue chatting by text or voice.
  - Acceptance: ending a voice session leaves all spoken turns and trace cards visible in the thread and restores the normal composer controls.

- **S7 — Visual Language & Control Sizing Contract (`AGENTS.md` §1–§3)**:
  - Accepted behavior:
    - All interactive controls in the Voice Mode footer (`Mic Mute`, `Speaker Mute`, `Voice Mode` trigger, locked assistant model badge, and `Finalizar` waveform pill) adhere strictly to the `32px` standard composer control height (`--vl-control-md`).
    - Radii strictly use semantic tokens: `rounded-control` (`8px`) for buttons and the locked model badge, `rounded-pill` (`9999px`) for the active waveform/End stadium pill, and `rounded-card` (`12px`) for timeline trace cards.
    - The protected TitleBar Mode Switcher (`src/components/TitleBar.tsx`) is never altered.
  - Acceptance: zero arbitrary pixel radii or heights in CSS/JSX; all controls match the 4-tier radius and 3-tier height contracts.

---

## Tasks

- [x] **T1** (`S1`, `S5`) — Route: `inline` — Commit: `b8a5604` — Shared Voice Session Coordinator (`src/lib/operator/voice/voiceSessionStore.ts` + `ZedStrip.tsx`): unify voice session lifecycle (`inactive | starting | active | stopping`), bound `threadId`, `micMuted`, `speakerMuted`, and single-playback ownership between `ChatComposer` and `ZedStrip`.
- [x] **T2** (`S2`, `S7`) — Route: `inline` — Commit: `b8a5604` — Locked Assistant Model Badge & Voice Mode Footer Bar (`src/components/views/chat/composer/VoiceModeFooterBar.tsx`): render the non-editable assistant model/provider/TTS badge from `loadOperatorConfig()`, Mic Mute toggle, Speaker Mute toggle, and reactive 28×12px waveform + `"Finalizar"` stadium pill.
- [x] **T3** (`S1`, `S3`, `S7`) — Route: `inline` — Commit: `b8a5604` — Composer Voice Trigger, Dictation Pause Handshake, and Hybrid Text Submit (`src/components/views/chat/ChatComposer.tsx`): add the `32px` Voice Mode button, pause/resume continuous voice mic during one-shot dictation, swap to `VoiceModeFooterBar` when active, and dynamically swap the right controls to **Enviar** when draft text is present.
- [x] **T4** (`S4`, `S7`) — Route: `inline` — Commit: `b8a5604` — Live Stage Commentary & Structured Operator Trace Cards in Thread Timeline (`src/components/views/chat/SingleThreadPane.tsx` + `src/components/views/chat/VoiceTurnTraceCard.tsx`): subscribe to live trace events (`turn.start`, `plan.created`, `action.start`, `action.verify`, `action.end`, `reply.composed`, `turn.end`) for the bound thread, render the live shimmer commentary row, and project user voice bubbles, collapsible `ActionReceipt` / `consultChats` trace cards, and assistant reply bubbles into the timeline.
- [x] **T5** (`S5`, `S6`) — Route: `inline` — Commit: `b8a5604` — Cross-Mode Continuity & Thread Transcript Persistence (`src/components/views/chat/SingleThreadPane.tsx`, `src/App.tsx`): persist voice turns and operator trace items in the thread transcript across mode switches (`Thread` ↔ `Code`) and flush cleanly on session end.
- [x] **T6** (`S1`–`S7`) — Route: `inline` — Commit: `b8a5604` — Focused Unit & Integration Tests (`src/components/views/chat/composer/VoiceModeFooterBar.test.tsx`, `src/components/views/chat/ThreadVoiceMode.test.tsx`): verify locked assistant model badge, dynamic text-to-send swap, inline trace card rendering, one-shot dictation coexistence, and single TTS playback across `Thread` and `Code` modes.
- [x] **T7** (`S1`–`S7`) — Route: `inline` — Commit: `pending` — Pure CSS Composer & Timeline Polish + Background Engine Mounting (`src/components/views/chat/composer/composer.css`, `src/components/views/chat/composer/VoiceModeFooterBar.tsx`, `src/components/ZedStrip.tsx`, `src/lib/operator/voice/voiceSessionStore.ts`, `src/components/views/chat/SingleThreadPane.tsx`, `src/App.tsx`): add Zero-Tailwind Pure CSS rules for composer triggers, footer bar, and voice timeline cards; place locked assistant + resolved model badge and live status pill on the left; mount `ZedStripHost` in background (`hideFloatingOrb`) when `operatorOpen` is false so STT, brain planner, and TTS run end-to-end in Thread Voice Mode.

---

## Log

- **L1 (2026-11-10)**: `"Mira, actualmente se me ocurrió otra cosa que podemos llegar a aterrizar para mejorar mucho todo. Y, es crear un voice mode. Pero un poco más fiel a como lo hace Antigravity o Codex. O ChatGPT, que son lo mismo básicamente. ¿Cómo lo hacen ellos? Bueno, en la parte de Thread, que sería la más similar que tenemos a ellos, para las conversaciones, agregan una parte. Que, apretando un botón, se abre el voice mode. Bueno, ahí se puede ver como una conversación. Dependiendo eh, se ve como una conversación de toda la traza, por ejemplo, lo que tú dijiste, lo que hizo la gente, lo que contestó. Luego, cómo es una sesión en vivo. Se puede seguir hablando claramente. Entonces ahí van apareciendo las cosas y la traza de todo. Lo que yo digo, lo que dice la gente, lo que ejecuta la gente y así. Se me ocurrió eso porque, claro, tenemos una especie de choque porque, ahora mismo tenemos el asistente que hace cosas. Pero, para la parte de code sirve no ver lo que hace o la traza, pero para la parte de thread sí sirve ya que es una parte estructurada donde podemos ver. La. La traza de las cosas que hace. Y de lo que uno dice claramente. Entonces teniendo eso en cuenta creo que sería útil, agregar esto que comento. Ahora claro esto tiene sus consideraciones por ejemplo, la parte de abajo de los modelos, claramente no puede mostrar los modelos por defecto. Sino que, el que se seleccione para el, asistente como tal. Ya que no. No debería ser como. Movible o editable para que no tenga esa. Imperfección en cuanto a rendimiento. Y bueno hay muchísimas cosas más que considerar yo me quedo corto pensándolo así que hay que examinar los. Programas como tal de Antigravity. Y. ChatGPT en la parte de codecs, eh, utilizando React. Que bueno, ya lo hicimos. Me gustaría que lo vuelvas a hacer para aterrizar un poco más esta idea y mejorar con lo que ya hicimos del ODD."` External program comparisons are kept in `.kite/tasks/thread-voice-mode.md`.
- **L2 (2026-11-10)**: `"A ver, mira. Como tal, me gustaría realmente dividir esto. Esta nueva funcionalidad, en un nuevo ODD. ¿Por qué razón? Para no sobrecargar tanto uno solo. Pero claro, tienen que estar conectados. Quiero decir, este nuevo DD tiene que estar claramente conectado con el anterior del asistente. Por ende, quiero hacer un nuevo DD mejor estructurado, más modular y mejor detallado, para lograr concentrar todo. Todas las funcionalidades que realmente tiene que tener."` Created `odd/tasks/thread-voice-mode.md` connected to `odd/tasks/assistant-reach.md` (`S1–S13`) and the Thread surface ODDs.
- **L3 (2026-11-10)**: `"si haz la implementacion completa"` Completed T1–T6. All 49 test files in `src/components/views/chat` and `src/lib/operator` (501 tests) passed clean (`VoiceModeFooterBar.test.tsx` 6/6, `ThreadVoiceMode.test.tsx` 8/8). `tsc --noEmit` and audit reference sanitizer clean (0 reference leaks).
- **L4 (2026-11-10)**: `"Okey, mira, estoy viendo muchísimos puntos de mejora de el voice mode. De partida. ¿La ubicación está incorrecta? ... Quiero decir en la parte donde uno selecciona los modelos y ahí, ahí sí se implementa el voice mode, pero mmm, no sé realmente si es que implementarlo ahí o no... porque se siente un poco raro, pero bueno. En fin, la cosa sería intentar ahora mejorar un poco la presentación. Y el, cómo se ve toda esa parte. Además que, ahora se ve bastante feo realmente, quiero decir... no tiene buenas finalizaciones. La idea es llegar a mejorar muchísimo esto. Eh, como tal tampoco está funcionando. Y bueno, tenemos que verificar también cómo es que se está alimentando esto, quiero decir. ¿Qué modelos está utilizando? ¿Cómo está? hablando. ¿Cómo está haciendo todo? Bueno. La idea, en base a esto sería llegar a utilizar lo que ya construimos para el asistente. Por ejemplo, utilizar la misma configuración que se tiene actualmente de el asistente Zed. Eh, para hablar, para escuchar, para. Pensar, mismo modelo. Y todo ese tipo de cosas."` Fixed pure CSS styling in `composer.css` (removing unstyled HTML buttons and vertical block stacking), aligned the locked assistant + resolved model badge (`getConfiguredAssistantDisplay()`) and live status pill on the left of `VoiceModeFooterBar`, retained `ComposerContextStrip`, removed the duplicate `kite:toggle-voice-session` dispatch in `ChatComposer` that toggled the session off immediately, and mounted `ZedStripHost` (`hideFloatingOrb`) whenever `voiceSessionStore` is active so Zed's STT, brain model, memory, and TTS run end-to-end in Thread mode.
