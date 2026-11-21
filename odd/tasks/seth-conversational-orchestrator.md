# SETH Conversational Orchestrator — Anchored Subagents, Return Loop & Working Context

Objective: Transformar el operador conversacional SETH (Modo de Voz en Thread y Orbe) de un lanzador "disparo y me olvido" a un director de orquesta con hilo principal anclado, subagentes exploradores por defecto (`explore` vs `odd`/`execute`), lazo cerrado de retorno por voz (`chat-subagent-event` + `dispatch_read`), lectura real de hallazgos en `narrate_summary` y memoria viva rodante para sesiones largas (40+ min).
Branch: `feat/response-thread`. Preservar el working tree previo sin mezclar commits no autorizados.
Test runner: `npx vitest run src/lib/operator src/components/ZedStrip.test.tsx src/components/views/chat`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Connected ODDs:
- `odd/tasks/seth-voice-intelligence.md` (`S1–S8`, `T1–T13`): pipeline full-duplex, VAD adaptativo, barge-in, streaming, aislamiento de workspace, memoria episódica y desambiguación activa.
- `odd/tasks/thread-voice-mode.md` (`S1–S10`, `T1–T20`): superficie de modo de voz en Thread, proyección de timeline y delegación ODD-first.
- `odd/tasks/thread-cross-provider-orchestration.md`: `dispatch_run`, `dispatch_read`, `dispatch_wait` y eventos `chat-subagent-event`.

Constraints: un único cerebro operador, respeto estricto a `VoiceTurnArbitrator` (sin audio encimado ni auto-eco), compatibilidad hacia atrás con `oddMode?: boolean` y `kite.voiceTurns.*` / `kite.operator.episodicMemory.v1.*`, aislamiento estricto por `workspaceId`, y cumplimiento íntegro de `AGENTS.md` §1–§4.

---

## Specs

- **S1 — Hilo principal anclado y subagentes por defecto (`explore` vs `odd`/`execute`)**:
  - Verbatim:
    > "Hilo principal anclado + Subagentes por defecto: Cambiar la matriz en prompt.ts para que todo trabajo derivado de la charla salga como spawn_subagent hijo del hilo de voz (parent: thread:<boundThreadId>), y launch_thread se use solo si pedís explícitamente abrir un hilo aparte. Distinguir subagente explorador (read-only, sin oddMode, pensado para traerte hechos y seguir conversando) vs subagente ejecutor/ODD (recién cuando vos y el asistente acuerdan avanzar)."
  - Comportamiento aceptado:
    - En `src/lib/operator/contract.ts`, `SpawnSubagentActionSchema` y `OPERATOR_NATIVE_TOOLS` (`spawn_subagent`) aceptan `mode?: 'explore' | 'odd' | 'execute'` manteniendo compatibilidad total con `oddMode?: boolean`.
    - En `src/lib/operator/executor/actions/oddBrief.ts`, `formatDelegatedTask` distingue:
      - `mode === 'explore'` (y `oddMode !== true`): agrega directivas concisas de **solo lectura** (inspeccionar hechos y código sin editar archivos ni crear documentos ODD, devolviendo un resumen concreto para conversar).
      - `mode === 'odd'` o `oddMode === true` (salvo `mode === 'explore'`): conserva las directivas ODD-first (`odd/tasks/<slug>.md`).
      - `mode === 'execute'` (sin `oddMode`): pasa la tarea limpia sin forzar ODD ni solo lectura.
    - En `src/lib/operator/planner/prompt.ts`, la Regla 7 y `MOTOR Y CANAL POR DEFECTO` fijan el hilo de voz (`boundThreadId`) como conversación principal anclada: todo trabajo derivado sale como `spawn_subagent` (`via: "thread"`) hijo del hilo actual; `launch_thread` se reserva únicamente para cuando el usuario pida explícitamente abrir un hilo aparte o mensajear otro hilo existente; explorar/revisar/investigar para conversar usa `"mode": "explore"` y `"oddMode": false`; `"oddMode": true` (`"mode": "odd"`) se usa recién cuando el usuario pida ODD o acuerden avanzar con diseño/implementación.
    - En `src/lib/operator/planner/heuristic.ts` y `src/lib/operator/planner/workspaceThreadIntent.ts`, las palabras exploratorias (`investiga`, `revisa`, `analiza`) ya no fuerzan `oddMode: true` automáticamente.
    - En `src/lib/operator/executor/actions/spawnSubagent.ts`, el subagente hereda `parent: thread:<boundThreadId>` / `from: thread:<boundThreadId>`, asigna rol apropiado (`Explorer` para `explore`, `ODD Planner` para `odd`) y registra el run en el watcher de retorno.
  - Aceptación: el prompt prioriza `spawn_subagent` con `mode: "explore"` sobre `launch_thread` en sesiones de voz; `formatDelegatedTask` aplica framing read-only en `explore` y ODD-first en `odd`; los recibos reflejan el modo y no fuerzan ODD en exploraciones.
  - Checks: pruebas unitarias en `prompt.test.ts`, `executor.test.ts`, `heuristic.test.ts` y nueva suite dedicada `conversationalOrchestrator.test.ts`.

- **S2 — Lazo cerrado de reporte de subagentes hacia voz (`chat-subagent-event` + `dispatch_read`)**:
  - Verbatim:
    > "Lazo cerrado de reporte (Subagent Result Callback -> Voz): Reusar dispatch_wait / dispatch_read (ya existentes en Rust) en un watcher de subagentes del hilo de voz: cuando un subagente hijo termina, leer su respuesta final, guardarla resumida en el contexto de la sesión y disparar automáticamente una síntesis hablada corta de SETH (respetando VoiceTurnArbitrator para no pisarte si estás hablando) con los hallazgos y la propuesta de cómo seguir."
  - Comportamiento aceptado:
    - Crear `src/lib/operator/subagentReturnWatcher.ts` con:
      - `readThreadFinalOutput(threadId)`: invoca `dispatch_read` (`address: "thread:<id>"`, `last: true`, `caller: "human"`) con respaldo seguro a `loadChatThread(threadId)` (extrayendo el último ítem `assistant` no vacío) y a `run.items` del evento cuando esté disponible.
      - `summarizeSubagentFindingsForVoice(rawText, meta)` y `composeSubagentReturnSpeech(meta)`: limpian rutas, UUIDs, bloques de código y markdown con `normalizeForVoiceSpeech`, generan un resumen condensado (para Working Context y ledger) y una síntesis hablada corta de 2–4 oraciones con hallazgos + propuesta natural de cómo seguir según `mode` (`explore` vs `odd`/`execute`) y `status` (`completed` / `failed` / `waiting`).
      - Suscripción a eventos Tauri `chat-subagent-event` (`kind: "subagentRunUpdated"`) + sondeo acotado de respaldo únicamente mientras existan subagentes rastreados activos (cero polling en reposo), con deduplicación estricta por `childThreadId` + estado terminal para evitar anuncios repetidos e ignorando `killed`.
      - Al completarse un subagente hijo: guarda el hallazgo en `voiceSessionStore` Working Context, actualiza `episodicMemory` (`recordDelegation` con `outcomeSummary` real), registra un turno de reporte proactivo (`isProactiveReport: true`) visible en el timeline del hilo (sin burbuja de usuario falsa), y solicita el habla a través de `voiceTurnArbitrator.requestProactiveSpeech(...)`.
    - Montar `startSubagentReturnWatcher` en `src/components/ZedStrip.tsx` durante sesiones de voz activas usando un `speakProactiveInSession` que coordina `speakingTts`, `voiceTurnArbitrator`, `armBargeInMonitor` y rearmado de micrófono (cero auto-eco, soporte completo de barge-in y respeto total al silencio de `speakerMuted`).
  - Aceptación: cuando un subagente hijo termina, el watcher lee su salida real vía `dispatch_read`, guarda el hallazgo en Working Context y memoria episódica, lo proyecta al timeline del hilo y lo narra con voz respetando `VoiceTurnArbitrator` (encolado si el usuario está hablando/pensando, sin repeticiones).
  - Checks: pruebas unitarias deterministas en `conversationalOrchestrator.test.ts` y pruebas de integración en `ZedStrip.test.tsx`.

- **S3 — Lectura real de salida de subagentes e hilos en `narrate_summary` y roster enriquecido**:
  - Verbatim:
    > "Hacer que narrate_summary en narrate.ts también lea la salida real con dispatch_read cuando preguntés manualmente por un subagente o hilo."
    > "workspaceSnapshot.ts solo le pasa { role, status, title } (sin hallazgos)."
  - Comportamiento aceptado:
    - En `src/lib/operator/executor/actions/narrate.ts`, `describeNonTerminalTarget` pasa a ser asíncrono y, al resolver un subagente, agente autónomo con hilo activo, hilo del workspace o entrada del `DelegationLedger`, consulta `readThreadFinalOutput(targetThreadId)` (vía `dispatch_read`) o reutiliza hallazgos frescos del Working Context para narrar el contenido real encontrado (limpiado con `normalizeForVoiceSpeech`), en lugar de limitarse a `"ya terminó su tarea"`.
    - También soporta consultas genéricas de subagente (`"subagente"`, `"explorador"`, `"último subagente"`) resolviendo al subagente más reciente del hilo de voz / workspace activo.
    - En `src/lib/operator/context/workspaceSnapshot.ts`, `activeSubagents` enriquece cada subagente con `findingsSummary` desde el Working Context de sesión y el `DelegationLedger` del workspace, y `formatWorkspaceRosterForPrompt` muestra ese hallazgo compacto junto al rol y estado.
  - Aceptación: preguntar por un subagente o hilo devuelve hallazgos concretos leídos con `dispatch_read` (con degradación limpia si está aún corriendo o sin respuesta) y el roster del prompt expone los hallazgos conocidos.
  - Checks: pruebas en `executor.test.ts`, `contextMemoryPhase2.test.ts` y `conversationalOrchestrator.test.ts`.

- **S4 — Memoria viva de sesión larga (`WorkingContext`)**:
  - Verbatim:
    > "Memoria viva de sesión larga (Working Context): Mantener junto a los últimos turnos un bloque compacto de estado de la charla (tema actual, decisiones acordadas y hallazgos clave de cada subagente que volvió), para que a los 40 minutos siga sabiendo exactamente dónde están parados."
  - Comportamiento aceptado:
    - Crear `src/lib/operator/context/workingContext.ts` con `SessionWorkingContext` persistido por `threadId` (`kite.voiceWorkingContext.v1.<threadId>`): `currentTopic`, `decisions` (hasta 6), `findings` de subagentes (hasta 6), `openQuestions` (hasta 4) y `olderTurnsSummary` (hasta 6 resúmenes compactos de los turnos que salieron de la ventana reciente de 8 turnos).
    - Actualizar el Working Context automáticamente en cada turno completado (`voiceSessionStore.addThreadVoiceTurn`) y en cada lanzamiento/retorno de subagente (`upsertSubagentFinding`), compactando deterministamente los turnos antiguos (> 8 turnos) sin agregar latencia LLM extra.
    - Inyectar `formatWorkingContextForPrompt(...)` en `buildOperatorSystemPrompt` (`src/lib/operator/planner/prompt.ts`) como bloque acotado `CONTEXTO VIVO DE LA SESIÓN ACTUAL` (≤ ~1,200 chars), y combinar turnos de reporte proactivo de forma segura en `voiceSessionStore.getConversationHistory` (evitando mensajes `assistant` consecutivos inválidos para proveedores estrictos) y en `voiceTurnsToChatItems` (sin burbuja de usuario vacía).
    - Enriquecer `saveSessionClosureSummary` (`episodicMemory.ts`) con decisiones y hallazgos del Working Context al cerrar la llamada.
  - Aceptación: tras 15+ turnos en una sesión larga, el bloque `CONTEXTO VIVO DE LA SESIÓN ACTUAL` conserva el tema actual, decisiones acordadas, hallazgos de subagentes y digest de turnos anteriores que ya salieron de la ventana de los últimos 8 turnos.
  - Checks: pruebas de compactación de sesión larga (> 12 turnos), persistencia, proyección de timeline y prompt injection en `conversationalOrchestrator.test.ts` y `voiceTranscript` / `ThreadVoiceMode` tests.

---

## Tasks

### Fase 1 — Subagentes por Defecto, Modo Exploración y Lazo de Retorno con `dispatch_read` (`S1`, `S2`, `S3`)

- [x] **T1** (`S1`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Risk: `item 3 (contrato SpawnSubagentAction, framing de tareas y reglas del prompt)` — **Hilo principal anclado, `mode: 'explore' | 'odd' | 'execute'` y matriz de delegación subagente-first**: actualizados `contract.ts`, `oddBrief.ts`, `spawnSubagent.ts`, `prompt.ts`, `heuristic.ts` y `workspaceThreadIntent.ts`.
- [x] **T2** (`S2`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Risk: `item 4 (eventos asíncronos de subagentes y arbitraje de voz)` — **Watcher de retorno de subagentes (`subagentReturnWatcher.ts`) + lectura `dispatch_read` + cableado en `ZedStrip.tsx`**: implementados `readThreadFinalOutput`, condensación para voz, suscripción `chat-subagent-event` + fallback acotado (solo con runs activos), registro de hallazgos y síntesis hablada arbitrada con barge-in en `ZedStrip.tsx`.
- [x] **T3** (`S3`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Risk: `item 3 (contrato de narrate_summary y roster del workspace)` — **Inspección real con `dispatch_read` en `narrate.ts` y hallazgos en `workspaceSnapshot.ts` / `episodicMemory.ts`**: lectura real de salida final de subagentes/hilos en `narrate.ts` (incluyendo targets genéricos `"subagente"` / `"explorador"`) y exposición de `findingsSummary` en el roster del prompt.

### Fase 2 — Memoria Viva de Sesión Larga (`WorkingContext`) y Verificación Integral (`S4`, `S1–S4`)

- [x] **T4** (`S4`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Risk: `item 3 (estado de sesión de voz, historial de conversación y proyección de timeline)` — **Memoria viva rodante (`workingContext.ts`), integración en `voiceSessionStore.ts`, `prompt.ts`, `voiceTranscript.ts` y `episodicMemory.ts`**: tema actual, decisiones, hallazgos de subagentes, compactación determinista de turnos > 8, fusión segura de reportes proactivos en el historial e inyección en el system prompt.
- [x] **T5** (`S1`–`S4`) — Route: `inline + independent verifier` — Commit: `uncommitted (feat/response-thread)` — Risk: `item 3 & 4 (verificación integral y auditoría independiente)` — **Suite regresiva completa, auditoría de referencias y revisor independiente**: agregados `conversationalOrchestrator.test.ts` (12 tests) y test de integración en `ZedStrip.test.tsx`; verificado `npx vitest run src/lib/operator src/components/ZedStrip.test.tsx src/components/views/chat/ThreadVoiceMode.test.tsx src/components/views/chat/SingleThreadPane.test.tsx src/components/views/agents/AgentChatShell.test.tsx` (33/33 archivos, 437/437 tests), `npx tsc --noEmit` (exit 0), `node .kite/sanitizer/audit-references.mjs --check` (400 archivos, 0 fugas), y revisor independiente (`thread:4e34e152-9bc2-43f7-930c-9cc09e07157c`) **APPROVE** (`S1–S4: PASS`).

---

## Log

- **L1 (2026-11-21)**:
  > "continua"
  >
  > "esto era lo que estabamos viendo Te entiendo AL 100% — y de hecho acabo de revisar el código y explica exactamente por qué te pasó eso en esos 40 minutos. No fue mala suerte del modelo: la arquitectura actual del operador está diseñada como un lanzador "disparo y me olvido", no como un director de orquesta con retorno.
  >
  > Por qué hizo eso (verificado en el código)
  > Sesgo a crear hilos top-level (launch_thread) en lugar de subagentes:
  > En prompt.ts, la Regla 7 pone launch_thread primero para "features o investigaciones" sin fijar que el hilo de Voice Mode es el hilo principal. Entonces decís "quiero revisar el asistente y el orquestador" y te crea un hilo huérfano aparte y listo.
  > Delegación "fire-and-forget" sin lazo de retorno:
  > spawnSubagent.ts lanza dispatch_run con wait: false y termina ahí.
  > proactiveWatcher.ts solo escucha terminales PTY (kite:terminal-agent-update) — no vigila subagentes de hilo ni reacciona cuando terminan (on_thread_settled). Nadie le avisa a SETH que su subagente volvió con la respuesta.
  > SETH es ciego al contenido real de lo que devuelve un subagente:
  > workspaceSnapshot.ts solo le pasa { role, status, title } (sin hallazgos).
  > Y narrate.ts, si preguntás qué hizo un subagente, solo contesta "El subagente X ya terminó su tarea" — nunca llama a dispatch_read (que ya existe en commands.rs) para leer qué encontró.
  > Fuerza oddMode: true incluso cuando solo querés explorar y charlar:
  > En prompt.ts y oddBrief.ts, apenas mencionás investigar o revisar, le pide armar un ODD en vez de explorar en solo-lectura y traerte contexto para conversar.
  > Amnesia en charlas largas (40 min):
  > voiceSessionStore.ts recorta el historial a los últimos 8 turnos sin resumen rodante de la sesión ni registro de hallazgos de subagentes.
  > Qué corregiría para que funcione como un verdadero asistente conversacional
  > Hilo principal anclado + Subagentes por defecto:
  > Cambiar la matriz en prompt.ts para que todo trabajo derivado de la charla salga como spawn_subagent hijo del hilo de voz (parent: thread:<boundThreadId>), y launch_thread se use solo si pedís explícitamente abrir un hilo aparte.
  > Distinguir subagente explorador (read-only, sin oddMode, pensado para traerte hechos y seguir conversando) vs subagente ejecutor/ODD (recién cuando vos y el asistente acuerdan avanzar).
  > Lazo cerrado de reporte (Subagent Result Callback -> Voz):
  > Reusar dispatch_wait / dispatch_read (ya existentes en Rust) en un watcher de subagentes del hilo de voz: cuando un subagente hijo termina, leer su respuesta final, guardarla resumida en el contexto de la sesión y disparar automáticamente una síntesis hablada corta de SETH (respetando VoiceTurnArbitrator para no pisarte si estás hablando) con los hallazgos y la propuesta de cómo seguir.
  > Hacer que narrate_summary en narrate.ts también lea la salida real con dispatch_read cuando preguntés manualmente por un subagente o hilo.
  > Memoria viva de sesión larga (Working Context):
  > Mantener junto a los últimos turnos un bloque compacto de estado de la charla (tema actual, decisiones acordadas y hallazgos clave de cada subagente que volvió), para que a los 40 minutos siga sabiendo exactamente dónde están parados.
  > ¿Querés que armemos el ODD de esto y lo implementemos en fases (empezando por subagentes por defecto + lazo de retorno con dispatch_read, y después memoria rodante de sesión)?"

- **L2 (2026-11-21) — Verificación previa en código**:
  - Confirmados todos los hallazgos en `src/lib/operator/planner/prompt.ts`, `src/lib/operator/executor/actions/{spawnSubagent,oddBrief,narrate}.ts`, `src/lib/operator/proactiveWatcher.ts`, `src/lib/operator/context/workspaceSnapshot.ts`, `src/lib/operator/voice/voiceSessionStore.ts`, `src-tauri/src/dispatch_wire/commands.rs`, `src-tauri/src/dispatch/types.rs` y `src-tauri/src/chat/subagents/lifecycle.rs`.
  - Confirmado además que `src-tauri/src/chat/subagents/lifecycle.rs:342` ya emite el evento Tauri `chat-subagent-event` (`kind: "subagentRunUpdated"`, `threadId`, `subagentId`, `run`) al finalizar subagentes hijos y que `dispatch_read` devuelve `Receipt.text` con la última respuesta del asistente cuando `last: true`.
  - Creado ODD público `odd/tasks/seth-conversational-orchestrator.md` (`S1–S4`, `T1–T5`) y su espejo en Engram `odd/seth-conversational-orchestrator/tasks`.

- **L3 (2026-11-21) — Implementación completa Fase 1 + Fase 2 (`T1–T5`) y verificación independiente**:
  - Implementados `src/lib/operator/subagentReturnWatcher.ts` y `src/lib/operator/context/workingContext.ts`, y actualizados `contract.ts`, `oddBrief.ts`, `spawnSubagent.ts`, `prompt.ts`, `heuristic.ts`, `workspaceThreadIntent.ts`, `narrate.ts`, `workspaceSnapshot.ts`, `episodicMemory.ts`, `voiceSessionStore.ts`, `voiceTranscript.ts` y `ZedStrip.tsx`.
  - Corregido también el parseo heurístico de consultas en español (`"¿cómo va el subagente?"`, `"¿qué encontró el explorador?"`) para no capturar el artículo `"el"`, y el reemplazo de guiones bajos por espacios en la prosodia de hallazgos (`dispatch_read` -> `dispatch read`).
  - Verificación observada: `npx vitest run` en `src/lib/operator`, `ZedStrip.test.tsx`, `ThreadVoiceMode.test.tsx`, `SingleThreadPane.test.tsx`, `AgentChatShell.test.tsx` (**33/33 archivos, 437/437 tests en verde**), `npx tsc --noEmit` (**exit 0**), `node .kite/sanitizer/audit-references.mjs --check` (**400 archivos, 0 fugas**).
  - Revisor independiente de solo lectura (`thread:4e34e152-9bc2-43f7-930c-9cc09e07157c`): **APPROVE** (`S1: PASS`, `S2: PASS`, `S3: PASS`, `S4: PASS`, sin hallazgos bloqueantes).

- **L4 (2026-11-21) — Publicación local de `v0.1.78`**:
  - Completada la release local `v0.1.78` (`Kite-Code_0.1.78_x64-setup.exe`, `19,379,499` bytes, firma `.sig` de `440` bytes) mediante `scripts/release.mjs patch --skip-tests` tras validar los 4 suites focalizados (`66/66` tests en verde), `npx tsc --noEmit` (`exit 0`) y `audit-references.mjs --check` (`400` archivos, `0` fugas).
  - Publicada en `releases/v0.1.78/`, `feed/studio/`, `%LOCALAPPDATA%\Kite Code\feed\studio\` y verificada en vivo en `http://127.0.0.1:9101/studio/latest.json` con las 5 notas completas sin truncar.
