# Argos Assistant & Voice Mode — Unified Adaptive Architecture, Consultative Multi-Turn Loop, `kite-ctx` Integration & Roadmap

Objective: Unificar al asistente operador **Argos** (antes llamado `Zed`, renombrado para precisión fonética 100% en STT en español/inglés y sin colisiones externas) y a **Voice Mode** bajo la **Opción A** (un único cerebro consultivo y una única sesión continua en `voiceSessionStore` con dos vistas adaptativas: integrada en el escenario/footer/timeline cuando estás en `Thread`/`Agent`, y como Orbe/Cápsula flotante `ArgosStrip` cuando estás en `Code`, siempre respaldada por su hilo de voz), integrando nativamente `kite-ctx` (`< 250 tokens` dinámicos + KV cache + `SharedContextStore`/`CcrStore`) y un flujo consultivo multi-turno (`peek_*` -> propuesta -> ventana automática manos libres -> confirmación -> delegación) en **3 Olas (`T1–T10`)**.
Branch: `feat/response-thread`.
Test runner: `npx vitest run src/lib/operator src/components/ZedOrb.test.tsx src/components/ZedStrip.test.tsx src/components/views/chat/ThreadVoiceMode.test.tsx src/components/views/chat/composer/VoiceModeFooterBar.test.tsx src/components/views/agents/AgentChatShell.test.tsx src/components/views/settings/ZedTab.test.tsx`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml --workspace`, `npm run verify:desktop:e2e`, `node .kite/sanitizer/audit-references.mjs --check`.
Constraints: No modifica zonas protegidas (`src/components/TitleBar.tsx` mode switcher) ni rompe los contratos de radios/alturas de `AGENTS.md` §1–§3. Mantiene alias/re-exports compatibles donde sea necesario para no romper imports ni configuraciones existentes en `localStorage`.

---

## Specs

### S1 — Unificación Opción A (`Argos` + `Voice Mode`), Renombrado a `Argos` y Diagnóstico STT/Rearme
- **Verbatim**:
  > "vamos con la opcion A, aunque quiero cambiarle el nombre al asistente, a algo mas simple al momento de dictar dado que zed siempre se toma como seth dame buenas opciones, considera que habria que cambiar el nombre a varios archivos que tienen zed"
  > "creo que para el nombre me quedare con Argos, Entonces, considerando eso, quiero que continúes con todo. Lo que habíamos conversado anteriormente y también, bueno, con el cambio de nombre de archivos y demás."
  > "cuando yo estoy hablando. Al menos en el primer. Bloque de texto cuando yo hablo, si voy viendo que palabra por palabra se va colocando. En el texto o en la parte donde se escribe... Hay un periodo donde me escucha, nuevamente sin tener que yo apretar."
- **Behavior**:
  1. **Identidad canónica `Argos` y renombrado con compatibilidad**:
     - El nombre por defecto del asistente pasa a ser **`Argos`** en `persona.ts`, `storage.ts`, `voiceSessionStore.ts`, `prompt.ts`, UI de Ajustes, cápsula/orbe y documentación (`docs/argos-assistant/`).
     - Si `localStorage` tenía guardado el default antiguo `'Zed'` o `'Seth'`, se migra transparentemente a `'Argos'`.
     - Se crean los módulos canónicos `ArgosOrb.tsx`, `ArgosStrip.tsx`, `argosFloat.css`, `ArgosTab.tsx`, `src/components/views/settings/argos/*` y `argosVoice.ts`, manteniendo re-exports limpios en las rutas `Zed*` / `zed*` para preservar compatibilidad total con imports y suites existentes.
     - `voiceNormalizer.ts` reconoce wake-words y variantes fonéticas de **Argos** (`"oye Argos"`, `"che Argos"`, `"hola Argos"`, `"argo"`, `"argus"`, `"hargos"` -> `"Argos"`), manteniendo soporte retrocompatible para `"Zed"`/`"Seth"`.
  2. **Opción A — Un Solo Sistema con Dos Vistas Adaptativas (`Thread` Stage vs `Code` Floating Orb)**:
     - **Un único estado de sesión (`voiceSessionStore.ts`)**: se elimina la duplicación entre `zedCallState` (`App.tsx`) y `voiceSessionStore`. El botón del asistente en `TitleBar` (`operatorOpen`) y el botón de Voice Mode en `ChatComposer` controlan y reflejan la misma sesión de **Argos**.
     - **En `Thread` / `Agent`**: la sesión se presenta integrada en el hilo activo (escenario + `VoiceModeFooterBar` + `ConsultativeDraftCard` + traza completa en el timeline).
     - **En `Code` (o cuando la vista activa no es el hilo de voz)**: la misma sesión se presenta como el **Orbe / Cápsula flotante de Argos (`ArgosStrip`)**, sin cortar el micrófono (`App.tsx` ya no llama a `releaseOperatorCapture()` al cambiar de superficie mientras la sesión siga activa) y registrando cada turno hablado en el hilo de voz vinculado (creando/vinculando uno automáticamente si se inició desde `Code`).
  3. **Solución a los 6 defectos verificados del STT palabra-por-palabra y del rearme en Turno 2+**:
     - **Streaming STT `wss://api.x.ai/v1/stt` detrás del VAD local (`transcriptionProviders.ts` + `zedVoice.ts`/`argosVoice.ts`)**: transmite frames PCM16 (16 kHz mono) en vivo apenas `AdaptiveVadController` abre captura (drenando los 400 ms de `PcmPreRollBuffer`), recibiendo `transcript.partial` palabra por palabra y cerrando con `{"type":"audio.done"}` (`0 ms` de espera post-habla), con fallback automático al upload WAV HTTP (`POST /v1/stt`) si el handshake WebSocket falla.
     - **Recreación limpia del fallback `SpeechRecognition`**: cuando se usa `SpeechRecognition` local, se espera su cierre y se instancia un objeto nuevo en cada turno en lugar de reutilizar la instancia vencida en `onend`.
     - **Endpointing lingüístico en español (`adaptiveVad.ts` + `speechPartial.ts`)**: si el transcript parcial termina en cláusula abierta (`"eh"`, `"em"`, `"para"`, `"con"`, `"que"`, `"por"`, `"como"`, `"o"`, `"y"`, `"si"`, `"porque"` o coma/puntos suspensivos), extiende la ventana de silencio a `1,750–2,100 ms` en vez de cortar a los `700 ms` tras 18 caracteres.
     - **Unificación de rearme con guarda anti-eco de `180 ms` (`ArgosStrip.tsx` + `useOperatorTurn.ts`)**: se memoiza el retorno de `useOperatorTurn` (`useMemo`) y se consolidan los 3 rearmes competitivos en una única transición gobernada por `VoiceTurnArbitrator` (`speaking -> post_tts_guard (180 ms) -> awaiting_reply`), evitando que el eco del parlante dispare capturas vacías y backoffs muertos de `1.2–3.2 s`.
     - **Estado veraz en `VoiceModeFooterBar.tsx`**: muestra `"Escuchando en vivo"` o `"Esperando tu respuesta…"` únicamente cuando `voice.isListening === true`, e indica `"Preparando micrófono…"` durante la guarda anti-eco o reconexión.

### S2 — Integración Profunda de `kite-ctx` en Argos y Voice Mode (`src-tauri/crates/kite-ctx/` + `ctx_bridge.rs`)
- **Verbatim**:
  > "también considera que nosotros implementamos kite ctx ¿En cuál podemos llegar a modificar? Para llegar a utilizar de mejor manera en el voice mode Y lograr tener un contexto más fresco y, no lo sé, tal vez. Corto, o que se enfoque. En nuestra solución para. Lo que queremos hacer, que sería hacerlo mejor, más profesional de, asistente de voz."
- **Behavior**:
  1. **Perfil de compresión `CrusherConfig::voice()` y `ContextEngine::pack_voice_context` (`crusher.rs`, `lossless.rs`, `lib.rs`)**:
     - Normalizar separadores Windows (`\` y `/`) en `path_heading` (`lossless.rs:256`).
     - Agregar `CrusherConfig::voice()` (`max_tokens: 220`, `head_ratio: 0.70`, `tail_ratio: 0.25`) y `ContextEngine::pack_voice_context` para comprimir el estado del workspace, terminales, diffs y subagentes en **`< 250 tokens`** frescos por turno.
  2. **Alineación de KV Cache `KvAligner::plan_voice_window` (`kv_aligner.rs` + `planner/prompt.ts`)**:
     - Detectar timestamps relativos en español/inglés (`"hace Xs"`, `"Xm ago"`) en `scan_volatile_tokens` y agregar `plan_voice_window` con congelamiento por lotes (*batch-frozen prefix*).
     - Separar `planner/prompt.ts` en un prefijo `messages[0]` 100% estático e inmutable (identidad de **Argos**, reglas, esquema JSON) y una cola dinámica `< 250 tokens` generada por `kite-ctx`.
  3. **Puente IPC Tauri `src-tauri/src/ctx_bridge.rs` y Handoffs `SharedContextStore` + `CcrStore`**:
     - Exponer comandos Tauri `ctx_pack_voice_context`, `ctx_kv_plan`, `ctx_share_put`, `ctx_share_get`, `ctx_ccr_retrieve` y `ctx_read_compact` (con cliente TypeScript `src/lib/operator/context/ctxClient.ts` y fallback en memoria para tests).
     - Al delegar (`spawnSubagent.ts`), Argos guarda el brief acordado en `SharedContextStore` (`key: "brief:<role>"`); al retornar un subagente (`subagentReturnWatcher.ts`), guarda el resumen y el `<<ccr:HASH>>` (`key: "finding:<childThreadId>"`) para consultas de seguimiento en `< 50 ms`.

### S3 — Argos Consultivo Multi-Turno (`peek_*` -> Propuesta -> Refinamiento Manos Libres -> Delegación)
- **Verbatim**:
  > "A grandes rasgos lo que quiero es poder conversar con el agente. Por ejemplo yo le hablo, él busca las cosas, acciona, delega, luego ya él me contesta. Hay un periodo donde me escucha, nuevamente sin tener que yo apretar. Y claro, ese sería el foco. Tal vez antes de que. Comience a realizar acciones. Eh, me consulte cosas, por ejemplo. Le digo, no lo sé, una oración. Él me consulta. Para ver si es que está correctamente lo que, la tarea básicamente. Eh, luego yo le respondo, modifica, me responde nuevamente y ahí ya partiría a delegar."
- **Behavior**:
  1. **Herramientas Read-Only de Inspección Rápida (`peek_*`, presupuesto `< 450 ms`)**:
     - `peek_changes` (git status/diff resumido), `peek_runs` (terminales/tests activos), `peek_agents` (subagentes/hilos en curso), `peek_files` (`ctx_read` en modo `signatures` | `map` | `lines`) y `recall_conversations`.
     - Lazo ReAct acotado (máximo 2–3 saltos de solo lectura en `index.ts` / `executor/index.ts`) para que Argos verifique el contexto antes de contestar o proponer una tarea.
  2. **Acuerdo Consultivo Multi-Turno (`DraftTaskProposal` + `ConsultativeDraftCard`)**:
     - `DraftTaskProposal` en `voiceSessionStore.ts` (`status: 'drafting' | 'awaiting_confirmation' | 'confirmed' | 'cancelled'`, `targetKind`, `title`, `taskBrief`, `role`, `provider`, `mode`, `oddMode`, `workspaceMode`, `questionForUser`, `contextRefs`, `revision`).
     - Acciones del contrato (`contract.ts`): `propose_task`, `refine_proposal`, `confirm_proposal`, `cancel_proposal` y `stay_silent`.
     - El fast-path heurístico (`heuristic.ts`) queda restringido a controles locales directos (`stop_speaking`, `manage_pane_layout`, `switch_workspace`, `close_terminals` explícito, `open_terminals` explícito). Toda tarea de desarrollo, análisis o delegación pasa por el flujo consultivo salvo que el usuario pida explícitamente ejecución inmediata (*"hazlo directo / sin preguntar"*).
     - Componente visual **`ConsultativeDraftCard.tsx`**: muestra en vivo la propuesta en borrador sobre el composer (en `Thread`) y en `ArgosStrip` (en `Code`) con botones `"Confirmar"` y `"Cancelar"` sincronizados con la confirmación por voz (`"dale"`, `"sí, lanzalo"`, `"correcto"`).
  3. **Árbitro de Línea (`VoiceTurnArbitrator` v2), Plegado de Retornos y Ventana Manos Libres (`10–15 s`)**:
     - Estados: `"free" | "busy" | "user_speaking" | "post_tts_guard" | "awaiting_reply"`.
     - Si terminan varios subagentes mientras el usuario habla o Argos está ocupado, los retornos se pliegan en `foldedUpdates` y se narran en un solo resumen cuando la línea queda `"free"`.
     - Cada vez que Argos termina de hablar (y especialmente al formular una pregunta o `propose_task`), tras los `180 ms` de `post_tts_guard`, emite un chime suave Web Audio y abre automáticamente la ventana manos libres (`10–15 s`, `setHandsFreeReplyWindow`) para que el usuario responda sin apretar ningún botón.

### S4 — Olas 2 y 3: Calidad Acústica Full-Duplex, Ergonomía Desktop, Trazabilidad y Captura Nativa Rust
- **Behavior**:
  1. **Ola 2 (`T5–T7`)**:
     - Barge-in con rampa de ganancia de `20 ms` (`clearWithRamp`) y truncado exacto del historial hasta lo realmente reproducido (`audioEndMs` / frases habladas).
     - Mic Mute con flush de `500 ms` de PCM en cero sin destruir el stream, y ring buffer pre-conexión (`15–30 s`).
     - Hotkey híbrido Tap-vs-Hold (`< 500 ms` toggle / `>= 500 ms` `Hold Spacebar`), loteo (`250 ms`) de mensajes escritos durante la llamada, desambiguación extendida (`inject_prompt`/`handoff_to_agent`) y expansión de `utterances.es.json`.
     - Hot-swap en `track.onended`/`devicechange`, banner *Mic Flatline* con selector `audioinput`/`audiooutput` (`setSinkId`), velocidad `0.5x–2.0x`, `navigator.wakeLock` y auto-pausa bloqueada mientras haya subagentes activos.
  2. **Ola 3 (`T8–T10`)**:
     - Divisores de inicio/fin de sesión de voz, pills colapsables `"Trabajó Xs"`, tarjeta de **Recibo y Resumen Post-Llamada** en Threads y *tail flush* al cerrar.
     - Diagnóstico nativo Rust WASAPI (`probe_microphone_privacy_status` en `audio_ducking.rs` clasificando `0x80070005` / `0x88890004`), ejecución DAG paralela en `executor/index.ts` (`Promise.allSettled`) y suite E2E CDP `scripts/e2e/specs/voice-mode.e2e.mjs`.
     - **Kite Companion Voice Bar** global (`Alt+Space`) con lock singleton entre ventanas, transferencia de llamada en vivo y selector visual rápido de contexto.

### S5 — Estrategia de Testing y Métricas de Calidad (SLIs/SLOs)
- **Checks**:
  - `npx tsc --noEmit` (0 errores).
  - `npx vitest run` sobre `src/lib/operator`, `ArgosOrb`/`ZedOrb`, `ArgosStrip`/`ZedStrip`, `ThreadVoiceMode`, `VoiceModeFooterBar`, `AgentChatShell` y `ArgosTab`/`ZedTab`.
  - `cargo test --manifest-path src-tauri/Cargo.toml --workspace` (incluyendo `kite-ctx` y `ctx_bridge`).
  - `node .kite/sanitizer/audit-references.mjs --check` (0 reference leaks).

---

## Tasks

- [x] **T0** (`S1`–`S5`, Risk: `none`, route: `inline`): Auditar arquitectura, definir unificación **Opción A** y renombrado a **Argos**, preparar estado compartido `DraftTaskProposal` + ventana manos libres en `voiceSessionStore.ts` y consolidar `odd/tasks/argos-voice-mode-roadmap.md`.
- [x] **T1** (`S2`, `S5`, Risk: `item 3 (kite-ctx crate API & Tauri IPC contract)`, route: `delegated (parallel unit 1: Rust surface)`): **Ola 1A — Motor `kite-ctx` para Voz y Puente IPC Tauri (`ctx_bridge.rs`)**: normalizar separadores Windows en `src-tauri/crates/kite-ctx/src/lossless.rs`, agregar `CrusherConfig::voice()` (`< 250 tokens`) y `ContextEngine::pack_voice_context` en `crusher.rs`/`lib.rs`, extender `scan_volatile_tokens` + `plan_voice_window` en `kv_aligner.rs`, y crear `src-tauri/src/ctx_bridge.rs` registrado en `src-tauri/src/main.rs` con tests unitarios en Rust (`cargo test -p kite-ctx` 41/41 passed, `cargo test ctx_bridge` 2/2 passed, `cargo check` 0 errors).
- [x] **T2** (`S1.1`, `S1.3`, `S5`, Risk: `item 4 (streaming WebSocket lifecycle & recognition teardown)`, route: `delegated (parallel unit 2: Voice STT/VAD/Normalizer surface)`): **Ola 1B — Streaming STT `wss://api.x.ai/v1/stt`, Fix Palabra-por-Palabra Multi-Turno, Endpointing Español y Normalizador `Argos`**: implementar `streamTranscribeWithGrokWs` en `transcriptionProviders.ts` con fallback WAV, conectar streaming PCM16 detrás del VAD + recreación limpia de `SpeechRecognition` en `zedVoice.ts` (+ `argosVoice.ts`), extender `computeAdaptiveEndpointMs` (`adaptiveVad.ts`/`speechPartial.ts`) para cláusulas abiertas en español (`1,750–2,100 ms`), y agregar wake-words/fonética de **Argos** + términos técnicos en `voiceNormalizer.ts` y `utterances.es.json` (6/6 archivos, 95/95 tests en verde).
- [x] **T3** (`S2.2`–`S2.3`, `S3`, `S5`, Risk: `item 3 (operator contract, heuristic gate & planner loop)`, route: `delegated (parallel unit 3: Planner/Executor/Arbitrator surface)`): **Ola 1C — Cerebro Consultivo Multi-Turno de Argos (`peek_*` + `DraftTaskProposal` + `ctxClient.ts` + `stay_silent` + Plegado)**: crear `src/lib/operator/context/ctxClient.ts`, agregar `peek_changes`/`peek_runs`/`peek_agents`/`peek_files`/`recall_conversations` (`executor/actions/peekWorkspace.ts`) y acciones `propose_task`/`refine_proposal`/`confirm_proposal`/`cancel_proposal`/`stay_silent` en `contract.ts` y `executor/index.ts`, dividir `planner/prompt.ts` en prefijo estático de **Argos** + cola `kite-ctx`, restringir `heuristic.ts`, actualizar `disambiguation.ts` para refinamiento/confirmación multi-turno, conectar `SentenceStreamChunker` -> cola FIFO en `ttsNarrator.ts` (`index.ts`), y evolucionar `turnArbitrator.ts` + `subagentReturnWatcher.ts` con plegado `foldedUpdates` y handoffs `ctx_share_put` (`tsc --noEmit` 0 errors, 30/30 archivos operator green).
- [x] **T4** (`S1.1`–`S1.3`, `S3.2`, `S3.4`, Risk: `item 4 (unified session lifecycle & anti-echo re-arm)`, route: `delegated (parallel unit 4: UI/App/Components/Rename surface)`): **Ola 1D — Unificación Opción A (`App.tsx`), Renombrado UI a `Argos`, Ventana Manos Libres (`180 ms` Anti-Eco) y `ConsultativeDraftCard`**: migrar default `'Argos'` en `config/persona.ts` y `config/storage.ts`, memoizar `useOperatorTurn.ts`, crear `ArgosOrb.tsx`, `ArgosStrip.tsx`, `argosFloat.css`, `ArgosTab.tsx`, `src/components/views/settings/argos/*` (con re-exports compatibles en `Zed*`), unificar `operatorOpen` y `voiceSessionStore` en `src/App.tsx` y `ArgosStrip.tsx` con guarda anti-eco de `180 ms` + ventana manos libres (`10–15 s`) + chimes suaves, actualizar `VoiceModeFooterBar.tsx` con estado real de escucha y crear `ConsultativeDraftCard.tsx` integrado en `SingleThreadPane.tsx`, `AgentChatShell.tsx` y `ArgosStrip.tsx` (`tsc --noEmit` 0 errors, seam Vitest 37/37 files, 452/452 tests green, sanitizer 176 files / 0 leaks).
- [x] **T5** (`S4.1`, `S5`, Risk: `item 4 (Web Audio gain ramp & zero-PCM flush)`, route: `delegated (parallel unit A: TTS/VAD/Store surface)`): **Ola 2A — Barge-In Exacto (`audioEndMs` + Rampa `20 ms`), Mute con Flush de `500 ms` y Ring Buffer Pre-Conexión (`15–30 s`)** (`ttsNarrator.ts`, `adaptiveVad.ts`, `zedVoice.ts`, `voiceSessionStore.ts`, `3/3` test files, `54/54` tests green, `tsc --noEmit` 0 errors).
- [x] **T6** (`S4.1`, `S5`, Risk: `none`, route: `delegated (parallel unit B: PTT/Disambiguation surface)`): **Ola 2B — Hotkeys Tap-vs-Hold (`500 ms` `Hold Spacebar`), Sync Texto-en-Llamada (`250 ms`) y Desambiguación Extendida** (`pttController.ts`, `disambiguation.ts`, `32/32` operator test files, `407/407` tests green, `tsc --noEmit` 0 errors).
- [x] **T7** (`S4.1`, `S5`, Risk: `none`, route: `delegated (parallel unit C: AudioDevices/Resilience/Footer surface)`): **Ola 2C — Hot-Swap de Dispositivos, Banner *Mic Flatline* (`setSinkId`), Velocidad `0.5x–2.0x`, `Wake Lock` y Auto-Pausa Protegida por Subagentes** (`audioDevices.ts`, `callResilience.ts`, `VoiceModeFooterBar.tsx`, `2/2` test files, `22/22` tests green, `tsc --noEmit` 0 errors).
- [x] **T8** (`S4.2`, `S5`, Risk: `none`, route: `delegated (parallel unit D: Timeline/Karaoke surface)`): **Ola 3A — Divisores de Sesión, Pills `"Trabajó Xs"`, Tarjeta de Recibo/Resumen Post-Llamada y Karaoke TTS** (`voiceTranscript.ts`, `ThreadVoiceMode.test.tsx` `22/22` tests green, `tsc --noEmit` 0 errors).
- [x] **T9** (`S4.2`, `S5`, Risk: `item 4 (native WASAPI audio thread & parallel DAG)`, route: `delegated (parallel unit 1: WASAPI/DAG/E2E surface)`): **Ola 3B — Diagnóstico Nativo Rust (`audio_ducking.rs` WASAPI `0x80070005`), DAG Paralelo y Suite E2E CDP (`voice-mode.e2e.mjs`)** (`cargo test audio_ducking` 4/4 passed, `npx vitest run src/lib/operator` 33/33 files / 421/421 tests passed, `node --check scripts/e2e/specs/voice-mode.e2e.mjs` 0 errors).
- [x] **T10** (`S4.2`, `S5`, Risk: `item 4 (cross-window singleton voice lock & call transfer)`, route: `delegated (parallel unit 2: CompanionTransfer/ArgosCompanionBar surface)`): **Ola 3C — Kite Companion Voice Bar Global (`Alt+Space`) con Transferencia de Llamada y Selector Visual de Contexto** (`companionTransfer.ts`, `ArgosCompanionBar.tsx`, `2/2` test files / `11/11` tests green, `tsc --noEmit` 0 errors).

---

## Log

- **L1 (2026-11-22)**: Auditoría inicial y baseline (`33` archivos, `422` tests Vitest en verde; `T21` aplicado en `odd/tasks/thread-voice-mode.md`).
- **L2 (2026-11-22)**:
  > "si consolida el plan aunque considera que no se llama seth es zed el asistente o voice mode tambien aunque no son lo mismo"
- **L3 (2026-11-22)**:
  > "A grandes rasgos lo que quiero es poder conversar con el agente. Por ejemplo yo le hablo, él busca las cosas, acciona, delega, luego ya él me contesta. Hay un periodo donde me escucha, nuevamente sin tener que yo apretar... Tal vez antes de que. Comience a realizar acciones. Eh, me consulte cosas, por ejemplo. Le digo, no lo sé, una oración. Él me consulta. Para ver si es que está correctamente lo que, la tarea básicamente. Eh, luego yo le respondo, modifica, me responde nuevamente y ahí ya partiría a delegar."
- **L4 (2026-11-22 — Selección de Opción A y renombrado a `Argos`)**:
  > "vamos con la opcion A, aunque quiero cambiarle el nombre al asistente, a algo mas simple al momento de dictar dado que zed siempre se toma como seth dame buenas opciones, considera que habria que cambiar el nombre a varios archivos que tienen zed"
  > "creo que para el nombre me quedare con Argos, Entonces, considerando eso, quiero que continúes con todo. Lo que habíamos conversado anteriormente y también, bueno, con el cambio de nombre de archivos y demás. Considero utilizar varios subagentes. A ver. Eh. Vale, ¿sus agentes hasta que se acabe la cuota? Porque se va a acabar, pero. Puedes continuar simplemente. Luego ya continuaremos si es que se acaba. Con otra delegación. Pero claro, utiliza sus agentes, hidrogen."
  - Se consolidó `odd/tasks/argos-voice-mode-roadmap.md` con la unificación **Opción A**, el renombrado canónico a **Argos** y la partición de la Ola 1 en 4 unidades paralelas con superficies de edición disjuntas (`T1–T4`) delegadas a subagentes en `gemini-4-hydrogen`.
- **L5 (2026-11-22 — Implementación Completa Olas 1, 2 y 3: `T1–T10` y cierre de `elevenlabs-streaming-tts-zed.md`)**:
  - Se completaron las 10 tareas (`T1–T10`) mediante subagentes paralelos en `gemini-4-hydrogen` con superficies disjuntas y verificación combinada (`tsc --noEmit` 0 errores, Vitest operator + UI + companion bar en verde, `cargo test -p kite-ctx`, `ctx_bridge` y `audio_ducking` en verde, y `audit-references.mjs --check` con 0 leaks). Se cerraron formalmente AC1–AC6 en `odd/tasks/elevenlabs-streaming-tts-zed.md`.
- **L6 (2026-11-22 — Integración runtime final, tarea QA en Kite Tasks y release `v0.1.79`)**:
  > "Okey, dado que se acabó la cuota, quiero que continúes tú con la implementación de todo lo que quedó, pendiente por corregir."
  > "si quiero que generes la tarea ademas de generar la actualizacion"
  - Se conectaron todos los módulos de Ola 2 y Ola 3 en las superficies reales de ejecución (`ArgosStrip.tsx`, `App.tsx`, `ChatComposer.tsx`, `SingleThreadPane.tsx`, `VoiceModeFooterBar.tsx`, `src-tauri/src/main.rs`) verificando `41/41` suites Vitest (`504/504` tests), `cargo test` y `audit-references.mjs --check` (`0` leaks). Se generó la tarea consolidada de QA manual en Kite Tasks y la actualización local `v0.1.79`.
