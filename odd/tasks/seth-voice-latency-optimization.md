# SETH Voice Mode — Optimización de Latencia sin Degradación de Inteligencia

Objective: Investigar, especificar y planificar las optimizaciones de latencia extremo a extremo para el Modo de Voz de SETH (`src/lib/operator/`, `odd/tasks/thread-voice-mode.md`, `odd/tasks/assistant-reach.md`), reduciendo el **Tiempo a Primer Audio (TTFA)** y el **Tiempo a Primera Acción** manteniendo intacta la capacidad de razonamiento, precisión de herramientas y ejecución multi-agente.
Branch: `feat/response-thread`. Documentación de arquitectura e investigación (solo especificación ODD; sin cambios de código en esta entrega).
Test runner (para futuras tareas de implementación): `npx vitest run src/lib/operator src/components/views/chat`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.
Connected ODDs:
- `odd/tasks/assistant-reach.md` (`S1–S13`): alcance del operador, índice de chats, memoria corta, streaming TTS y trazas JSONL.
- `odd/tasks/thread-voice-mode.md` (`S1–S6`): sesión de voz continua en Thread y coordinación con el orbe.
- `odd/tasks/elevenlabs-streaming-tts-zed.md`: motor ElevenLabs streaming y fallback a navegador.

---

## 1. Diagnóstico del Pipeline Actual (Baseline en Código)

Al auditar el flujo real de un turno de voz en `src/lib/operator/`, se identifican los siguientes cuellos de botella estructurales:

1. **Pre-carga síncrona del catálogo de chats antes de planificar (`src/lib/operator/planner/llm.ts:169-171`)**:
   - En cada turno LLM, `planTurnLLM()` ejecuta `await fetchLiveChatCatalog()` y `await consultChats()` *antes* de construir el prompt, incluso cuando la orden es puramente operativa o conversacional (ej. *"abre dos terminales"*, *"hola"*).
2. **Prompt monolítico y prefijo no cacheable (`src/lib/operator/planner/prompt.ts:9-225`)**:
   - `buildOperatorSystemPrompt()` reconstruye ~225 líneas con 15 reglas críticas, esquema JSON completo, 16 ejemplos few-shot y notas de memoria, intercalando estado volátil (`terminalsDesc`, `workspaceName`, `mode`, `chatReachSection`) dentro del mismo mensaje `system`. Esto rompe el *prompt caching* de los proveedores ante cualquier cambio en terminales o modo.
3. **Doble serialización de herramientas (`prompt.ts:106-125` + `providers/openaiCompat.ts:104,160`)**:
   - El prompt textual describe las 12 acciones en `ESQUEMA JSON PERMITIDO` y, simultáneamente, `OpenAiCompatPlannerProvider` envía el array completo `OPERATOR_NATIVE_TOOLS` (`src/lib/operator/contract.ts:186-389`, 12 schemas) en cada petición.
4. **Historial sin compactación (`llm.ts:61`)**:
   - `MAX_PRIOR_TURNS = 14` adjunta hasta 14 mensajes previos completos sin resumen ni recorte por presupuesto de tokens.
5. **Ejecución secuencial bloqueante (`src/lib/operator/executor/index.ts:64-150`)**:
   - `executePlan()` itera con un `for` secuencial (`await` uno por uno) y verifica cada acción antes de iniciar la siguiente, incluso cuando las acciones son independientes (ej. abrir un hilo y abrir un navegador, o lanzar múltiples subagentes).
6. **TTS de turno completo post-ejecución (`src/lib/operator/index.ts:229-251`, `ttsNarrator.ts:418`)**:
   - `runOperatorTurn()` espera a que termine **todo** `planTurnLLM()` y **todo** `executePlan()` antes de llamar a `ttsNarrator.speak(reply)`. El audio no comienza a sintetizarse durante el streaming de tokens del modelo ni por frases.
7. **Ausencia de modelo clasificador ligero intermedio (`providers/resolvePlanner.ts:86`)**:
   - O bien resuelve la heurística regex (`planTurnHeuristic`, `<2ms`), o bien escala directamente al modelo configurado completo con `reasoning: 'low'`, sin un nivel intermedio de enrutamiento/respuesta rápida.
8. **Instrumentación incompleta para voz (`runLedger.ts:63-72`, `trace/types.ts:4-14`)**:
   - Existen `firstToken` y `tokenCounts`, pero faltan marcas de tiempo para **fin de STT**, **primer audio reproducido (TTFA-Audio)**, **primera acción iniciada/emitida (TTFA-Action)** y desglose de tokens por sección del prompt.

---

## 2. Arquitectura Objetivo de Baja Latencia

```text
[STT Final / Parcial]
       │
       ├──► (L0) Heurística Determinista (<2ms) ──────────────────────────┐
       │                                                                  ▼
       ├──► (L1) Router / Planner Ligero (Prefix Cache + Tools Filtradas) │
       │          ├─ Conversación / 1-2 acciones ──► Streaming por Frases ──► [TTS Queue (MP3/PCM)]
       │          └─ Requiere razonamiento profundo ──► (L2) Modelo Grande ──┘
       │
       └──► [DAG Executor: Acciones Paralelas + Ack Especulativo] ──► [Receipts / Verify]
```

---

## Specs

### S1 — Reducción y Compresión del Contexto de Proyecto por Turno
- **Qué es INDISPENSABLE en cada turno (Hot Context, presupuesto objetivo ≤ 250 tokens)**:
  1. Identidad de alcance: `workspaceId`, `workspaceName`, `mode` (`code` | `thread`), `voiceSessionActive` y `boundThreadId`.
  2. Terminales activas en formato ultra-compacto: `idx | codename | engine | state` (ej. `1:Orion(grok,running)`). Omitir UUIDs (`sessionId`) y títulos largos del prompt base (el executor los resuelve por `idx` o `codename`).
  3. Digest de memoria corta (`loadZedMemoryNotes`): máximo top-5 notas relevantes o resumen ≤ 150 tokens.
- **Qué NO debe inyectarse por defecto (Cold Context, carga bajo demanda)**:
  1. **Catálogo de chats (`fetchLiveChatCatalog` / `consultChats`)**: dejar de invocarlo en cada turno de `planTurnLLM`. Solo consultarlo cuando el clasificador L0/L1 detecte referencia explícita o implícita a historial/chats/decisiones previas, o mediante tool call bajo demanda (`lookup_chat_context`).
  2. **Cuerpos de transcripciones y buffers de terminal**: nunca en el prompt inicial; solo bajo lectura puntual (`narrate_summary` o `consultChats` de un único hilo).
- **Compresión de historial conversacional**:
  - Reemplazar `MAX_PRIOR_TURNS = 14` en bruto por una ventana deslizante de los **últimos 4 turnos** íntegros + un **resumen rodante** (≤ 120 tokens) para turnos anteriores de la misma sesión de voz.
- **Criterio de aceptación**: El contexto dinámico inyectado en un turno estándar no supera los ~250 tokens (frente a los ~800–2,500+ actuales cuando hay notas, terminales y catálogo de chats), sin perder resolución de agentes por nombre/índice ni acceso a memoria/chats cuando se solicitan.

### S2 — Selección Dinámica y Carga Diferida de Herramientas (Tool Pruning)
- **Eliminación de redundancia**: cuando el proveedor soporta `tools` nativos (`OpenAiCompatPlannerProvider`), retirar el bloque textual `ESQUEMA JSON PERMITIDO` y los 16 ejemplos few-shot redundantes del system prompt, dejando solo reglas de desambiguación semántica y formato de voz.
- **Particionado de `OPERATOR_NATIVE_TOOLS` (`contract.ts`) en 4 suites por intención**:
  1. `conversational`: `[]` (0 tools) o únicamente `stop_speaking` cuando el usuario conversa, pregunta conceptos o pide aclaraciones.
  2. `terminals`: `open_terminals`, `close_terminals`, `inject_prompt`, `narrate_summary`, `manage_pane_layout`, `handoff_to_agent`.
  3. `orchestration`: `launch_thread`, `spawn_subagent`, `launch_agent`, `switch_workspace`.
  4. `navigation`: `open_browser`, `switch_workspace`, `stop_speaking`.
- **Fallback / Expansión diferida**: si el usuario combina dominios o el router L1 devuelve baja confianza, incluir un tool ligero `request_tool_suite(suite)` o reintentar una sola vez con el conjunto completo (`OPERATOR_NATIVE_TOOLS`).
- **Criterio de aceptación**: En turnos conversacionales o de un solo dominio se envían entre 0 y 6 definiciones de herramientas en lugar de las 12 completas, reduciendo los tokens de esquema entre un 55% y un 100% sin impedir comandos multi-dominio.

### S3 — Streaming de TTS por Frases y Arranque Anticipado de Síntesis
- **Segmentación incremental durante el streaming del LLM**:
  - Conectar un `SentenceStreamChunker` al stream SSE de `OpenAiCompatPlannerProvider` (extrayendo incrementalmente el texto de `"reply"` / `"answer"` en JSON streaming o el texto directo cuando `actions: []`).
  - Cortar en fronteras naturales de frase (`. `, `! `, `? `, `:\n`, `\n`) respetando un umbral mínimo de **35–50 caracteres** (para evitar micro-peticiones HTTP con prosodia cortada) y un máximo de **180 caracteres** para la primera frase.
- **Cola ordenada de reproducción y arranque anticipado**:
  - Apenas se cierra la **Frase 1**, despacharla inmediatamente a `ttsNarrator` (ElevenLabs `/stream` con `optimize_streaming_latency=3` o WebSocket `stream-input` persistente por sesión de voz, o `SpeechSynthesis` en modo navegador) **en paralelo** con la generación de las frases siguientes y la ejecución no bloqueante de acciones.
  - Mantener una cola FIFO de reproducción de audio vinculada al `generation` token actual de `ttsNarrator` para que el *barge-in* (`stop()`) aborte tanto el stream LLM como todos los `AbortController` de TTS pendientes en <50 ms.
- **Criterio de aceptación**: El primer audio comienza a reproducirse tras recibir la primera frase del LLM + TTFB de TTS, sin esperar al cierre completo de la respuesta JSON ni al fin de acciones en segundo plano.

### S4 — Caché de Prompts (Prompt Caching) y Precarga de Contexto Estable
- **Reestructuración por inmutabilidad de prefijo**:
  - Separar `buildOperatorSystemPrompt` en dos partes estrictas:
    1. **Prefijo Estático (100% inmutable entre turnos y sesiones)**: rol de SETH, reglas críticas de seguridad/voz y guía de estilo hablado. Se ubica siempre al inicio del mensaje `system` (y con `cache_control: ephemeral` en proveedores que lo requieran) para maximizar *KV-cache hits* (descuentos de 50–90% en latencia TTFT y costo de tokens de entrada).
    2. **Sufijo Dinámico (por turno)**: enviado en un bloque separado al final (último mensaje antes del `user` input o dentro del bloque `user` delimitado): `workspace`, `mode`, `activeTerminals` compactas y `chatReach` (solo si aplica).
- **Precarga al abrir la sesión de voz (`voiceSessionStore.startSession`)**:
  - Pre-calentar conexiones TLS/HTTP2 hacia el endpoint del proveedor LLM activo y ElevenLabs (eliminando handshake TLS de ~120–250 ms en el primer turno).
  - Pre-cargar `loadZedMemoryNotes()` y mantener una caché en memoria del catálogo de chats (`chatCatalogCache`, TTL 30s o invalidación por evento IPC) para evitar lecturas IPC en el camino crítico.
- **Criterio de aceptación**: El prefijo estático de `system` permanece byte-a-byte idéntico entre turnos consecutivos de una misma sesión, logrando `cachedTokens > 0` en proveedores con soporte de caché de prefijo.

### S5 — Ejecución Especulativa y Paralelización de Acciones Independientes
- **Paralelización DAG en `executePlan()` (`src/lib/operator/executor/index.ts`)**:
  - Clasificar las acciones del plan según sus dependencias:
    - *Independientes*: múltiples `launch_thread`, `spawn_subagent`, `open_browser`, `open_terminals` sin dependencia entre sí se ejecutan concurrentemente con `Promise.allSettled()`.
    - *Dependientes*: `switch_workspace` antes de `open_terminals`; `open_terminals` antes de `inject_prompt` dirigido a la terminal recién creada; `handoff_to_agent` tras creación de origen. Estas conservan orden secuencial estricto.
- **Preparación y confirmación especulativa**:
  - **Pre-resolución durante STT**: cuando `speechPartial.ts` detecta estabilidad del transcript parcial (>250 ms sin cambios antes del endpoint final), pre-computar `captureCurrentTurnContext()` y, si hay mención de chats/hilos, pre-calentar `chatCatalogCache`.
  - **Ack hablado optimista para acciones lentas en segundo plano**: para `launch_thread`, `spawn_subagent` y `launch_agent` (con `focusThread: false`), iniciar la síntesis de confirmación (*"Lanzando el hilo en segundo plano"*) en paralelo con el despacho IPC, notificando por voz únicamente si `action.verify` falla. (Nunca aplicar ack optimista a acciones destructivas como `close_terminals`).
- **Criterio de aceptación**: Planes con N acciones independientes reducen su tiempo de ejecución total de `sum(t_i)` a `max(t_i)`, preservando verificación completa de recibos (`ActionReceipt`).

### S6 — Routing Híbrido: Heurística (L0) → Clasificador/Planner Ligero (L1) → Modelo Grande (L2)
- **Arquitectura de 3 niveles**:
  - **L0 — Heurística Determinista (`<2 ms`)**: `planTurnHeuristic` (`heuristic.ts`) resuelve órdenes directas e inequívocas (silencio/barge-in, abrir N terminales, cerrar por nombre explícito, negaciones).
  - **L1 — Modelo Ligero (`~150–400 ms` TTFT)**: usa el tier `fast` de `VERIFIED_PROVIDER_MODELS` (ej. `gemini-3.8-flash-low`, `deepseek-v4.1-flash`, `@cf/meta/llama-3.1-8b-instruct-fp8`) con `reasoning: 'none' | 'low'`, prefijo cacheado y tools filtradas (S2). Resuelve directamente:
    - Respuestas conversacionales rápidas.
    - Clasificación de intención y selección de suite de herramientas.
    - Planes de 1–2 acciones con parámetros explícitos.
    - Emite bandera `escalate: true` (o tool call de escalado) únicamente si detecta ambigüedad compleja, múltiples dependencias, análisis de código/transcript extenso o redacción de especificaciones ODD complejas.
  - **L2 — Modelo Grande de Razonamiento (`~800–2500 ms`)**: usa el tier `diagnosis` (`deepseek-v4-pro`, `gemini-3.8-pro`, `anthropic/claude-3-5-sonnet`, `grok-4.7`) **solo** cuando L1 escala, manteniendo el mismo prefijo cacheado y pasando el contexto relevante ya resuelto.
- **Criterio de aceptación**: ≥75% de los turnos de voz cotidianos se resuelven en L0 o L1 sin degradar la calidad en tareas complejas, las cuales escalan automáticamente a L2.

### S7 — Plan de Instrumentación de Métricas y Observabilidad
Extender `RunRecord` (`src/lib/operator/runLedger.ts`) y `TraceEvent` (`src/lib/operator/trace/types.ts`) para medir sin sesgos cada tramo del pipeline:

1. **Marcas temporales por turno (`timestamps`)**:
   - `sttFinalizedAt`: instante en que el STT entrega la transcripción final (origen `t = 0` de latencia percibida por el usuario).
   - `contextReadyAt`: fin de captura de contexto y (si aplica) consulta de catálogo.
   - `routerDecisionAt`: fin de clasificación L0/L1.
   - `providerRequestAt` / `firstTokenAt` / `finalResponseAt`: tiempos del proveedor LLM.
   - `firstActionStartAt` / `firstActionEndAt`: **Tiempo a Primera Acción** (`firstActionStartAt - sttFinalizedAt`).
   - `ttsRequestAt` / `firstAudioAt`: **Tiempo a Primer Audio (TTFA-Audio)** (`firstAudioAt - sttFinalizedAt`, medido en `audio.onplay` para ElevenLabs y `utterance.onstart` para Web Speech).
2. **Contabilidad granular de tokens (`tokenBreakdown`)**:
   - `systemStaticTokens`, `contextDynamicTokens`, `toolsSchemaTokens`, `historyTokens`, `promptTokensTotal`, `cachedTokens`, `completionTokens`, `cacheHitRatio`.
3. **Segmentación y agregación**:
   - Calcular `p50`, `p95`, `p99` por `tier` (`L0` | `L1` | `L2`), `ttsEngine` (`browser` | `elevenlabs`) y `source` (`voz` | `texto`) en `runLedger.ts` con exportación JSONL para comparativas A/B antes y después de cada optimización.

---

## Tabla de Trade-offs y Recomendaciones Priorizadas

| Prioridad | Estrategia | Reducción TTFA-Audio | Reducción TTFA-Action | Ahorro Tokens / Costo | Riesgo sobre Inteligencia / Ejecución | Complejidad | Mitigación del Riesgo |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **P0** | **S7: Instrumentación de Métricas** | N/A (habilitador) | N/A (habilitador) | N/A | Ninguno | Baja | Overhead <1 ms en memoria; redacción de secretos ya existente en `runLedger.ts`. |
| **P0** | **S1: Contexto Hot/Cold (quitar `fetchLiveChatCatalog` por defecto + compactar terminales/historial)** | ~150–400 ms | ~150–400 ms | **35–55%** input tokens | Bajo (si un turno necesita un chat y no se carga) | Baja | Incluir tool/clasificador `lookup_chat_context` bajo demanda cuando el input mencione chats/hilos/decisiones. |
| **P0** | **S4: Prefijo Inmutable para Prompt Caching + Pre-warming** | ~200–600 ms (TTFT) | ~200–600 ms | **50–80%** costo en prefijo cacheado | Ninguno (mismo contenido lógico, distinto orden) | Baja | Separar estrictamente reglas estáticas (inicio) de estado dinámico (final). |
| **P1** | **S3: Streaming TTS por Frases + Arranque Anticipado** | **~800–2,000 ms** | 0 ms (desacoplado) | Neutra (ligero +overhead por chunks) | Bajo (prosodia si frases son muy cortas) | Media | Umbral mínimo de 35–50 chars por frase; cola FIFO con `generation` token para barge-in instantáneo. |
| **P1** | **S2: Tool Pruning Dinámico por Intención** | ~100–250 ms | ~100–250 ms | **40–70%** tokens de schema | Medio (si falta una tool en orden multi-dominio) | Media | Suite fallback / reintento automático único con `OPERATOR_NATIVE_TOOLS` si hay baja confianza. |
| **P1** | **S6: Routing Híbrido L0 → L1 (Ligero) → L2 (Grande)** | **~600–1,800 ms** | **~500–1,500 ms** | **60–85%** costo promedio | Medio (si L1 resuelve mal una orden compleja) | Media-Alta | Criterios estrictos de escalado a L2 (multi-paso, ambigüedad, ODDs, análisis de archivos/chats). |
| **P2** | **S5: Paralelización DAG + Ack Especulativo** | ~100–500 ms (en acciones) | ~200–800 ms (multi-acción) | Ninguno | Bajo-Medio (condiciones de carrera en acciones dependientes) | Media | Matriz explícita de dependencias; nunca usar ack optimista en acciones destructivas (`close_terminals`). |

### Hoja de Ruta Recomendada
1. **Ola 1 (Quick Wins — P0)**: Implementar **S7** (baseline medible), **S1** (mover `fetchLiveChatCatalog` bajo demanda y compactar contexto/historial) y **S4** (separar prefijo estático cacheable del sufijo dinámico + pre-warming de sesión). Impacto inmediato esperado: **-35% a -60% en tokens por turno** y **-400 a -900 ms en TTFT** sin tocar el flujo de ejecución.
2. **Ola 2 (Salto Perceptual de Voz — P1)**: Implementar **S3** (streaming TTS por frases sobre el stream SSE) y **S2** (tool pruning por intención). Impacto esperado: **TTFA-Audio < 1.2s** en respuestas conversacionales con ElevenLabs.
3. **Ola 3 (Escala y Concurrencia — P1/P2)**: Implementar **S6** (routing L1 ligero → L2 grande) y **S5** (DAG paralelo + preparación especulativa en STT parcial).

---

## Tasks

- [ ] **T1 — Instrumentación de Latencia y Desglose de Tokens (`S7`)**:
  - Linked `S#`: `S7`
  - Route: `inline`
  - Scope: `src/lib/operator/runLedger.ts`, `src/lib/operator/trace/types.ts`, `src/lib/operator/ttsNarrator.ts`, `src/lib/operator/index.ts`.
  - Deliverable: Eventos `stt.finalized`, `tts.first_audio`, `firstActionStartAt` y `tokenBreakdown` con cálculo p50/p95/p99.

- [ ] **T2 — Reducción de Contexto Hot/Cold y Compresión de Historial (`S1`)**:
  - Linked `S#`: `S1`
  - Route: `inline`
  - Scope: `src/lib/operator/planner/llm.ts`, `src/lib/operator/planner/prompt.ts`, `src/lib/operator/chatIndex.ts`, `src/lib/operator/hooks/useOperatorTurnLogic.ts`.
  - Deliverable: `consultChats` bajo demanda, formato compacto de terminales activas y ventana deslizante + resumen de historial.

- [ ] **T3 — Prefijo Estático para Prompt Caching y Pre-warming de Sesión (`S4`)**:
  - Linked `S#`: `S4`
  - Route: `inline`
  - Scope: `src/lib/operator/planner/prompt.ts`, `src/lib/operator/providers/openaiCompat.ts`, `src/lib/operator/voice/voiceSessionStore.ts`.
  - Deliverable: Separación prefijo inmutable / sufijo dinámico y pre-calentamiento de conexiones + caché de catálogo de chats.

- [ ] **T4 — Streaming de TTS por Frases y Cola con Barge-in Atómico (`S3`)**:
  - Linked `S#`: `S3`
  - Route: `delegated` (si supera ~150 líneas entre chunker SSE y cola de audio)
  - Scope: `src/lib/operator/ttsNarrator.ts`, `src/lib/operator/providers/openaiCompat.ts`, `src/lib/operator/index.ts`.
  - Deliverable: `SentenceStreamChunker` + cola FIFO en `TTSNarrator` conectada al stream de tokens del planner.

- [ ] **T5 — Tool Pruning Dinámico por Intención (`S2`)**:
  - Linked `S#`: `S2`
  - Route: `inline`
  - Scope: `src/lib/operator/contract.ts`, `src/lib/operator/planner/prompt.ts`, `src/lib/operator/planner/llm.ts`.
  - Deliverable: Catálogo particionado en 4 suites (`conversational`, `terminals`, `orchestration`, `navigation`) con fallback seguro a catálogo completo.

- [ ] **T6 — Routing Híbrido L0 → L1 → L2 (`S6`)**:
  - Linked `S#`: `S6`
  - Route: `delegated`
  - Scope: `src/lib/operator/providers/resolvePlanner.ts`, `src/lib/operator/planner/llm.ts`, `src/lib/operator/index.ts`.
  - Deliverable: Enrutador que despacha L1 (`fast`) por defecto y escala a L2 (`diagnosis`) ante `escalate: true` o tareas complejas.

- [ ] **T7 — Ejecución DAG Paralela y Preparación Especulativa (`S5`)**:
  - Linked `S#`: `S5`
  - Route: `inline`
  - Scope: `src/lib/operator/executor/index.ts`, `src/lib/operator/voice/speechPartial.ts`, `src/lib/operator/index.ts`.
  - Deliverable: Ejecución concurrente de acciones independientes, pre-captura de contexto en parciales estables y ack optimista en acciones no destructivas.

---

## Log

- **L1 (Original Request)**: `[Subagent Role: Performance Researcher] Investigar y documentar en un ODD (odd/tasks/) las estrategias para optimizar la latencia del Modo de Voz del asistente SETH sin degradar su inteligencia ni su capacidad de ejecutar tareas. Cubrir al menos: 1) reducción y compresión del contexto de proyecto inyectado por turno (resumen del workspace, índice de hilos, terminales activas) y qué es realmente indispensable; 2) recorte o carga diferida del conjunto de herramientas expuestas al modelo (tool selection dinámico según intención); 3) streaming de TTS por frases y arranque anticipado de la síntesis; 4) caché de prompts (prompt caching) y precarga de contexto estable; 5) ejecución especulativa y paralelización de acciones independientes; 6) modelos ligeros para clasificación de intención vs modelo grande solo para razonamiento. Incluir un plan de instrumentación de métricas (tiempo a primer audio, tiempo a primera acción, tokens por turno) y una tabla de trade-offs con recomendaciones priorizadas.`
