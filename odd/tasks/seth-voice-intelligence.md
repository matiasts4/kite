# SETH Voice Mode — Naturalidad Conversacional e Inteligencia Contextual

Objective: Elevar la calidad del modo de voz de SETH (asistente operador de Kite Code) en dos ejes prioritarios: (1) naturalidad conversacional con barge-in real, gestión de turnos adaptativa, baja latencia con streaming end-to-end y prosodia limpia; y (2) inteligencia contextual con conciencia estricta del workspace activo, memoria de sesión y entre sesiones, interpretación robusta de STT en español y desambiguación activa en máximo una pregunta.
Branch: `feat/response-thread`. No cambiar de rama. Los commits de implementación deberán agruparse por unidad de trabajo y contener únicamente los archivos de esta iniciativa.
Delivery strategy: `ask-on-risk`. Pronóstico: ~1.800–2.400 líneas modificadas en 3 fases (supera el umbral orientativo de ~400 líneas; requerirá confirmación de estrategia de PR encadenado por fase antes de implementar).
Test runner: `npx vitest run src/lib/operator src/components/ZedStrip.test.tsx src/components/views/chat`, `npx tsc --noEmit`, `cargo test --manifest-path src-tauri/Cargo.toml operator_runtime`, `node .kite/sanitizer/audit-references.mjs --check`, `npm run verify:desktop:e2e`.
Connected ODDs:
- `odd/tasks/assistant-reach.md` (`S1–S13`): alcance del operador, índice de chats, memoria corta, lanzamiento de hilos/terminales y trazas JSONL.
- `odd/tasks/thread-voice-mode.md` (`S1–S10`, `T1–T20`): superficie de modo de voz en Thread, coordinación con el orbe flotante, VAD inicial, resúmenes sin corte por tiempo y delegación ODD-first.
- `odd/tasks/elevenlabs-streaming-tts-zed.md`: integración de síntesis ElevenLabs y fallback nativo.
- `odd/tasks/seth-voice-latency-optimization.md`: optimizaciones complementarias de caché de prefijo de prompt, deduplicación de herramientas nativas y ejecución paralela de acciones (`T1–T7`).
- `odd/tasks/seth-conversational-orchestrator.md` (`S1–S4`, `T1–T5`): hilo principal anclado con subagentes exploradores por defecto, lazo de retorno con `dispatch_read` y memoria viva de sesión larga.

Constraints: un único cerebro operador (sin asistentes duplicados), sin reproducción TTS simultánea, sin abrir terminales de Code salvo solicitud explícita, aislamiento estricto de datos por workspace activo, compatibilidad hacia atrás con las notas de memoria existentes (`kite.zed.memoryNotes.v1`) y respeto íntegro de los estándares visuales de `AGENTS.md` §1–§3.

---

## Diagnóstico del Estado Actual y Cuellos de Botella

Inspección realizada sobre el código actual en `feat/response-thread` y trazas reales de producción (`%APPDATA%\Kite Code\operator-traces\2026-11-20.jsonl`, 77 eventos, 6 turnos LLM completados y 3 capturas de voz descartadas).

### Telemetría Base Medida (2026-11-20)

| Indicador observado | Valor actual | Evidencia | Impacto en UX |
| :--- | :--- | :--- | :--- |
| Latencia de planificación LLM (`plan.created`) | **p50 = 11.85 s · p95 = 15.92 s** | `operator-traces/2026-11-20.jsonl` (`deepseek-v4.1-flash`) | Pausa inaceptable antes de escuchar la primera palabra |
| Tiempo al primer token (`provider_first_token - provider_request`) | **8.88 s – 15.92 s** (idéntico al total) | `operator-traces/2026-11-20.jsonl` + `operator_runtime.rs:337` | Streaming SSE inexistente en escritorio Tauri |
| Capturas de voz descartadas por silencio | **30% (3 de 10 `turn.start`)** | `operator-traces/2026-11-20.jsonl` + `zedVoice.ts:88` | Churn de micrófono cada 8 s y tonos Zen repetidos |
| Índice de chats inyectado por turno | **737–914 chars en 6/6 turnos** (creciente, sin filtro de proyecto) | `operator-traces/2026-11-20.jsonl` + `chatIndex.ts:99-113` | Contaminación entre workspaces y bloat de prompt |
| Observabilidad de voz E2E (VAD -> STT -> TTS audio) | **0 eventos STT/TTS en trazas**; `tokenCounts` redactado como `[REDACTED_SECRET]` | `ZedStrip.tsx:520`, `zedVoice.ts`, `runLedger.ts:149` | Ceguera para medir STT y tiempo a primera frase audible |

### Cuellos de Botella Críticos Identificados

| # | Eje | Cuello de botella verificado | Ubicación exacta | Causa raíz técnica |
| :--- | :--- | :--- | :--- | :--- |
| **B1** | Naturalidad | **Sin barge-in acústico real durante TTS** | `ZedStrip.tsx:434,524-530`, `zedVoice.ts:537,612` | Al finalizar la frase del usuario, `stopOperatorListening()` cierra `MediaStream`, `AudioContext` y `AnalyserNode`. El micrófono permanece apagado durante `planning`, `executing` y `speakingTts`, y solo se rearma en `ttsNarrator.speak({ onEnd })`. Interrumpir exige clic o atajo manual. |
| **B2** | Naturalidad | **VAD estático, latencia fija de 2.4 s y churn de hardware cada 8 s** | `zedVoice.ts:86-88,236-240,280,301`, `audioDucking.ts:76-115` | Umbral fijo `VAD_RMS_THRESHOLD = 0.015` sin calibración de ruido ambiente; espera fija `TRAILING_SILENCE_MS = 2400` tras cada frase (lento en órdenes breves, riesgoso en pausas sintácticas); `IDLE_NO_SPEECH_MS = 8000` destruye y reabre `getUserMedia` + `AudioContext` + `ScriptProcessorNode` (deprecado en hilo principal) disparando `stopAudioDucking()` / `startAudioDucking()` repetidamente. |
| **B3** | Naturalidad | **Falso streaming LLM en Tauri + cero pooling HTTP + cascada secuencial STT/TTS** | `src-tauri/src/operator_runtime.rs:209,337`, `config/httpFetch.ts:50-69`, `planner/llm.ts:205`, `ttsNarrator.ts:407-428`, `zedVoice.ts:505` | `proxy_operator_http` crea un `reqwest::Client` nuevo por petición (sin keep-alive TLS/HTTP2) y hace `resp.text().await`, reteniendo todo el SSE hasta `[DONE]`. Además `planTurnLLM` no pasa `onDelta` ni alimenta frases incrementales al TTS; `zedVoice.ts` espera hasta 600 ms por `MediaRecorder.stop()` pese a tener PCM WAV listo; `transcriptionProviders.ts:60-70` prueba `/stt` antes de fallback en cada turno; `proactiveWatcher.ts:358` puede hablar sin arbitraje de turno. |
| **B4** | Naturalidad | **Prosodia con fugas técnicas, muletillas de plantilla e identidad desconectada** | `ttsNarrator.ts:70-109`, `planner/sanitize.ts:98-171`, `launchThread.ts:157`, `spawnSubagent.ts:125`, `launchAgent.ts:161`, `config/persona.ts:205-242` | `cleanTextForSpeech` no filtra UUIDs, rutas Windows/POSIX, URLs ni flags CLI. Los ejecutores anexan muletillas repetitivas (`"Seguimos conversando por acá."`). `buildZedSystemInstructions()` en `persona.ts` nunca se invoca desde `prompt.ts`, ignorando el nombre configurado (`SETH`), tono, brevedad y `builderCallMe`. |
| **B5** | Contexto | **Ceguera de hilos/subagentes/agentes y fugas entre workspaces** | `operator/index.ts:64-136`, `chatIndex.ts:99-113`, `planner/prompt.ts:26-30`, `executor/actions/narrate.ts:13-57` | `TurnContext` solo carga `activeTerminals` (leyendo workspace desde `localStorage` y filtrando con `!t.workspaceId \|\| t.workspaceId === resolvedWsId`, lo que filtra terminales sin `workspaceId` a cualquier proyecto). `fetchLiveChatCatalog()` devuelve chats de **todos** los workspaces sin filtrar. `loadZedMemoryNotes()` ignora `note.workspace`. `TurnContext` desconoce hilos, subagentes (`dispatch_ls`) y agentes autónomos (`list_agent_profiles`) del proyecto; `narrate_summary` busca únicamente en terminales PTY. |
| **B6** | Contexto | **Sin memoria episódica entre sesiones ni resolución temporal** | `voiceSessionStore.ts:329-383`, `chatIndex.ts:39-78`, `config/persona.ts:122-123` | `rememberBetweenCalls` y `afterCallMode: 'summary+decisions'` existen en configuración pero no tienen escritor. `voiceSessionStore` persiste turnos por `threadId` en `localStorage`, dejando en blanco una nueva sesión del día siguiente. `consultChats` exige patrones literales (`revisa el chat X`) y devuelve `not-one` ante >1 coincidencia, fallando en `"continúa lo de ayer"` o `"¿qué quedó pendiente?"`. |
| **B7** | Intención | **Heurísticas rígidas antes del LLM, polaridad mixta rota y mapa fonético incompleto** | `operator/index.ts:162-226`, `planner/heuristic.ts:88-111,433-528`, `planner/heuristicPatterns.ts:79-92`, `planner/workspaceThreadIntent.ts:100-159` | `planTurnHeuristic` intercepta antes del LLM: `"no cierres las terminales, abre un hilo con Claude"` es bloqueado íntegramente por `isNegatedTerminalImperative`; `"abre un agente de Claude..."` dispara `open_terminals` incluso en modo Thread; `SPAWN_SUBAGENT` fuerza `cli: 'grok'` por defecto; `parseLaunchThreadIntent` está anclado con `^` y no reconoce homófonos STT (`threats`, `treads`, `su agente`, `o de de`, `clot`, `códec`, `oye Seth`). |
| **B8** | Intención | **Ausencia de contrato de desambiguación activa** | `contract.ts:137-145`, `planner/heuristic.ts:175-182` | No existe estado estructurado de slot pendiente (`PendingDisambiguation`). Ante órdenes incompletas o referencias ambiguas (`"cierra esa"`, `"delega esto"`), la heurística adivina (`target: 'finished'`, `task: 'tarea delegada'`) en lugar de hacer una pregunta concreta y retomar la intención en el turno siguiente. |

---

## Arquitectura Propuesta

### 1. Pipeline de Voz Full-Duplex con Streaming E2E

```text
[Mic Persistent MediaStream (AEC + NS + AGC)]
        │
        ▼
[AudioWorkletNode: Adaptive VAD + 400ms Pre-Roll Ring Buffer]
   ├── Estado LISTENING: noiseFloor EMA + histéresis + endpointing dinámico (650ms–2200ms)
   ├── Estado SPEAKING (Barge-in Gate): umbral elevado + voiced >= 220ms + echo guard
   │       └── Barge-in confirmado ─► ttsNarrator.stop() + abort LLM + captura pre-roll
   └── Fin de turno ─► PCM 16kHz directo (sin esperar MediaRecorder)
        │
        ▼
[STT Fast Path (endpoint saludable en caché + paralelo con interim Web Speech)]
        │  emit: vad.eos, stt.start, stt.end
        ▼
[Capa de Intención (Normalizador STT -> Polaridad por Cláusula -> Router Híbrido)]
        │  contexto: WorkspaceSnapshotProvider + EpisodicMemory + PendingDisambiguation
        ├── Fast-path determinista de alta confianza (< 10 ms)
        └── LLM Streaming via `proxy_operator_http_stream` (pooled reqwest::Client + Tauri Channel)
                │  emit: llm.first_token
                ├── Turno conversacional / aclaración (`actions: []`)
                │       └─► Incremental Sentence Splitter ─► SpeechSentenceQueue ─► TTS Streaming
                │                                            (ElevenLabs optimize_streaming_latency / Nativo)
                └── Turno con acciones
                        └─► Executor + Verificación ─► Prosody Normalizer ─► TTS Streaming
                                                                 │  emit: tts.first_audio
                                                                 ▼
                                                [VoiceTurnArbitrator] ◄── cola diferida de proactiveWatcher
```

**Decisiones clave del pipeline de voz:**
1. **Sesión de audio persistente (`AudioWorklet`)**: abrir `getUserMedia` una sola vez al iniciar la sesión de voz y cerrarlo únicamente al pausar/mutear el micrófono o finalizar la sesión. Eliminar `ScriptProcessorNode`, la espera de `600 ms` de `MediaRecorder.stop()` cuando hay PCM válido y los ciclos destructivos cada `8 s` con ducking/chime repetidos (el ducking WASAPI se aplica una vez al entrar a la llamada o se coordina limpiamente sin re-disparar tonos Zen en silencio).
2. **Barge-in con protección contra auto-disparo**: mantener el `AudioWorklet` escuchando mientras SETH habla con un perfil de sensibilidad de barge-in más estricto (`rms > max(0.032, noiseFloor * 4.0)` y duración sostenida `>= 220 ms`, más ventana de supresión de ataque inicial de `250 ms` al iniciar el audio). Al dispararse, abortar reproducción/streaming TTS en `< 50 ms`, conservar los últimos `400 ms` del ring buffer para no mutilar la primera palabra del usuario y marcar la respuesta anterior en el historial como `[interrumpida por el usuario]` para mantener el hilo.
3. **Streaming nativo en Rust (`proxy_operator_http_stream`)**: incorporar un `reqwest::Client` compartido (`OnceLock`, HTTP/2 + pool keep-alive) y emitir deltas SSE por Tauri Channel/Event con cancelación por `requestId`, manteniendo `proxy_operator_http` intacto como respaldo.
4. **Streaming de voz seguro**: para respuestas conversacionales o preguntas de desambiguación (`actions: []`), extraer oraciones completas conforme llegan tokens del campo hablado (`answer`/`reply`) y encolarlas inmediatamente en `TTSNarrator` (`speakStreamedSentences`). Para planes con acciones mutantes o de cierre, verificar recibos antes de anunciar la confirmación para evitar afirmar acciones fallidas o bloqueadas.
5. **Arbitraje único de turnos (`VoiceTurnArbitrator`)**: centralizar el estado de turno (`IDLE_LISTENING`, `USER_SPEAKING`, `ENDPOINTING`, `THINKING`, `EXECUTING`, `SPEAKING`, `BARGE_IN`). Los avisos proactivos (`proactiveWatcher` de terminales, subagentes y agentes) se encolan si el usuario está hablando o SETH está respondiendo, evitando audio encimado.

### 2. Capa de Intención, Normalización STT y Desambiguación Activa

```text
Transcripción bruta (STT español)
  │
  ▼  1. Normalizador Fonético Contextual (`normalizeSpanishVoiceStt`)
  │     - Limpia invocaciones ("oye Seth", "che Seth", "hey Zed")
  │     - Corrige homófonos solo en ranuras válidas:
  │       "sierra/serrar" -> "cierra/cerrar" (imperativo)
  │       "threats/treads/trids" -> "threads" (delegación)
  │       "su agente/la gente" -> "subagente/el agente" (delegación)
  │       "clot/claudio" -> "claude" · "códec" -> "codex" · "anti gráviti" -> "antigravity"
  │       "o de de/ode" -> "ODD" · "dos. Terminales" -> "dos terminales"
  │
  ▼  2. Analizador de Polaridad por Cláusula (`analyzeClausePolarity`)
  │     - Segmenta cláusulas contrastivas ("no cierres X, abre Y", "mejor no..., haz...")
  │     - Marca negación por cláusula (nunca anula una cláusula afirmativa posterior)
  │     - Mantiene bloqueo defensivo de `close_terminals` sin verbo de cierre afirmativo
  │
  ▼  3. Enrutador Híbrido por Confianza (`routeOperatorIntent`)
  │     ├── Alta confianza + acción utilitaria sin ambigüedad ─► Fast-Path (< 10 ms)
  │     │     (stop_speaking, layout, browser, cierre/apertura de terminal explícita y resuelta)
  │     └── Delegación, consulta contextual, polaridad mixta, referencia temporal
  │         o entidad ambigua ─► LLM Planner con Roster del Workspace + PendingDisambiguation
  │
  ▼  4. Matriz de Superficies + Regla de 1 Pregunta (`PendingDisambiguation`)
        - Hilo (`launch_thread`): trabajo de feature/análisis dedicado o pedido explícito de hilo.
        - Subagente (`spawn_subagent` `via: "thread"`): tarea acotada en paralelo al hilo actual.
        - Agente autónomo (`launch_agent`): perfil coincidente en `list_agent_profiles`.
        - Terminal (`open_terminals` / `inject_prompt`): solo ante "terminal/consola/powershell" o terminal ya abierta.
        - Si falta dato crítico (target/task/surface) o hay empate real entre entidades:
          emitir `actions: []`, guardar `PendingDisambiguation` (TTL 90 s / 2 turnos) y hacer 1 sola pregunta concreta.
```

### 3. Contexto Estricto de Proyecto y Memoria en 3 Capas

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ WorkspaceSnapshotProvider (estrictamente filtrado por activeWorkspaceId)   │
│  ├─ Proyecto activo: id, nombre, ruta raíz, rama Git (fuente autoritativa) │
│  ├─ Terminales PTY del proyecto: índice, codename (Nova/Orion), motor,     │
│  │  estado, última línea útil (sin filtrar terminales ajenas ni huérfanas) │
│  ├─ Hilos del proyecto (top 8 recientes): id, título, proveedor, estado    │
│  ├─ Subagentes del proyecto (dispatch_ls): rol, proveedor, estado, padre   │
│  └─ Agentes autónomos del proyecto: perfil, motor, estado de chat activo   │
├────────────────────────────────────────────────────────────────────────────┤
│ Memoria en 3 Capas (aislada por workspaceId, presupuesto <= 700 tokens)    │
│  1. Sesión activa: historial conversacional + DelegationLedger en vivo     │
│     + PendingDisambiguation + marca de turnos interrumpidos por barge-in   │
│  2. Episódica entre sesiones (persistida en disco por workspace):          │
│     resumen + decisiones al cerrar llamada (`afterCallMode`) + registro    │
│     de tareas delegadas con timestamp y último estado reconciliado         │
│  3. Consulta bajo demanda (`consultChats` v2 por workspace):               │
│     resolución temporal ("ayer", "la última vez", "lo de Nova") con        │
│     ranking por recencia/relevancia y lectura acotada de 1 solo chat       │
└────────────────────────────────────────────────────────────────────────────┘
```

**Inspección unificada de entidades (`inspect_entity_status` / extensión de `narrate_summary`)**:
- Al consultar `"¿qué está haciendo Nova?"` o `"¿en qué quedó el subagente de auth?"`, SETH busca primero en el snapshot del workspace activo en orden determinista: **Terminales PTY -> Subagentes activos -> Agentes autónomos -> Hilos recientes** (y `DelegationLedger` si acaba de finalizar). Nunca responde falsamente `"no hay ninguna terminal abierta"` cuando la entidad existe como agente autónomo, subagente o hilo.

---

## Riesgos y Mitigaciones

| Riesgo | Severidad | Probabilidad | Mitigación concreta |
| :--- | :--- | :--- | :--- |
| **Auto-disparo de barge-in por eco de altavoces** | Alta | Media-Alta | Activar AEC nativo (`echoCancellation: true`), ventana de guarda de 250 ms al inicio de TTS, umbral dinámico elevado + duración de voz sostenida `>= 220 ms`, y detección de auto-barge-in repetido (`>= 2` falsos cortes en un turno eleva el margen adaptativo o sugiere auriculares). |
| **Hablar confirmaciones antes de verificar acciones** | Alta | Media | Restringir el streaming directo LLM->TTS a respuestas conversacionales/aclaraciones (`actions: []`). Cuando existan acciones ejecutables, esperar la verificación de recibos (`executePlan`) antes de narrar el resultado. |
| **Incremento de tokens de prompt que neutralice la mejora de latencia** | Media | Media | Presupuesto estricto de contexto (`<= 700` tokens): máximo 8 terminales, 8 hilos, 6 subagentes, 8 agentes, 6 memorias episódicas en formato compacto de 1 línea; eliminar la inyección global sin filtrar de `chatIndex` y compactar ejemplos redundantes en `prompt.ts`. |
| **Contaminación entre workspaces al cambiar de proyecto rápido** | Alta | Baja-Media | Resolver `workspaceId` desde el estado autoritativo de la app/IPC (no solo `localStorage`), invalidar caché de `WorkspaceSnapshotProvider` en `kite:workspace-changed` y exigir `workspaceId` coincidente en terminales, hilos, subagentes, agentes y memoria. |
| **Regresión en comandos deterministas rápidos o pruebas existentes** | Media | Media | Conservar fast-path en órdenes utilitarias inequívocas, mantener intacto el bloqueo defensivo de `close_terminals` (`allowsCloseAction`) y validar con suite regresiva + nuevos fixtures en `src/lib/operator/fixtures/utterances.es.json`. |
| **Desincronización de memoria episódica frente al estado real** | Media | Media | Reconciliar los registros de `DelegationLedger` contra `list_chat_summaries` y `dispatch_ls` al cargar el snapshot; etiquetar claramente lo histórico ("ayer terminó...") frente a lo vivo ("ahora mismo está corriendo..."). |
| **Compatibilidad del streaming HTTP proxy con OpenCode Go y cancelación** | Alta | Media | Mantener `proxy_operator_http` como fallback; diseñar `proxy_operator_http_stream` con inyección server-side de credenciales equivalente, abort explícito por `requestId` y pruebas unitarias en Rust y Vitest. |

---

## Specs

- **S1 — Barge-in real sin perder el hilo conversacional**:
  - Verbatim: `"Barge-in real: permitir interrumpir al asistente mientras habla, cortando el TTS de inmediato sin perder el hilo."`
  - Comportamiento aceptado:
    - Durante una sesión de voz activa (en Thread o en el orbe flotante), el grafo de captura `MediaStream` + `AudioWorkletNode` permanece montado mientras SETH narra, operando con una compuerta de barge-in resistente al eco (`echoCancellation: true`, guarda inicial de `250 ms`, energía sobre piso adaptativo y duración sostenida `>= 220 ms`) y un ring buffer pre-roll de `~400 ms`.
    - Al confirmarse voz del usuario mientras SETH habla, `ttsNarrator.stop()` detiene el audio y aborta el stream HTTP/síntesis en `< 100 ms`, transiciona el turno a captura con el audio pre-roll intacto y anota el turno anterior del asistente en la memoria de sesión como interrumpido (conservando el texto ya proyectado/hablado para continuidad).
    - El barge-in manual (clic en orbe/botón o atajo) mantiene su comportamiento inmediato como respaldo.
  - Aceptación: hablar mientras SETH está narrando corta el TTS de inmediato sin perder las primeras sílabas de la nueva orden, mantiene la sesión abierta y conserva el hilo conversacional en el siguiente turno; en silencio con TTS reproduciéndose no se auto-interrumpe.
  - Checks: pruebas unitarias de compuerta de barge-in y ring buffer (`zedVoice.test.ts`), integración de interrupción en `ZedStrip.test.tsx` / `ThreadVoiceMode.test.tsx`.

- **S2 — Gestión de turnos con VAD adaptativo y sin solapamientos**:
  - Verbatim: `"Gestión de turnos: detección de fin de frase/silencio con umbrales adaptativos, evitar respuestas encimadas y evitar cortes prematuros."`
  - Comportamiento aceptado:
    - Calibrar dinámicamente el piso de ruido ambiente (`noiseFloorRms`) con EMA e histéresis (umbral de inicio superior al de liberación) en `AudioWorkletNode`, reemplazando `VAD_RMS_THRESHOLD = 0.015` fijo y `ScriptProcessorNode`.
    - Reemplazar `TRAILING_SILENCE_MS = 2400` fijo por una ventana de fin de turno adaptativa: `650–850 ms` para frases cerradas/órdenes breves y extensión automática a `1600–2200 ms` cuando el texto parcial termina en conjunción, preposición, muletilla de duda (`"eh"`, `"em"`, `"para"`, `"con"`, `"que"`, `"y"`) o cláusula abierta.
    - Eliminar el ciclo destructivo cada `8 s` (`IDLE_NO_SPEECH_MS`) que cierra y reabre `getUserMedia` y dispara `startAudioDucking`/`stopAudioDucking` repetidamente en silencio.
    - **Compuerta de captura PCM por VAD (sin facturar silencio en espera)**: mientras la sesión espera voz (`!hasDetectedSpeech`), NO acumular frames en `rawPcmChunks` ni iniciar `MediaRecorder` en paralelo cuando existe grafo PCM (`AudioWorkletNode` / `ScriptProcessorNode`); mantener únicamente el ring buffer circular `PcmPreRollBuffer` (`400 ms` fijos en RAM). Al detectar inicio real de voz (`speechStartedNow` o `SpeechRecognition`), abrir captura volcando el pre-roll de `400 ms` (sin duplicar el frame de ataque), recortar al cierre el exceso de silencio de *endpointing* reteniendo un respiro final de `250 ms` (`trimTrailingPcmSamples`, solo cuando el VAD observó voz activa para no mutilar susurros captados por `SpeechRecognition`), calcular `durationSecs` / `stt.start.audioDurationMs` sobre el audio útil real y limpiar `preRollBuffer` en inicios no-barge-in.
    - Incorporar `VoiceTurnArbitrator` para serializar la toma de palabra y encolar anuncios de `proactiveWatcher` mientras el usuario habla o SETH responde, evitando respuestas encimadas.
  - Aceptación: una orden breve cierra captura en `< 1 s` de silencio sin cortes prematuros ante pausas sintácticas; 60 s de silencio en llamada abierta producen 0 reinicios de micrófono y 0 tonos Zen repetidos; tras espera prolongada en silencio, el WAV enviado a Grok/Cloudflare contiene únicamente el habla real (pre-roll `~400 ms` + habla + cola `~250 ms`) y 0 peticiones en silencio puro; un aviso proactivo durante el habla no se superpone al TTS ni a la captura.
  - Checks: tests deterministas de VAD adaptativo, endpointing sintáctico y `VoiceTurnArbitrator` + `proactiveWatcher.test.ts`.

- **S3 — Reducción y medición de latencia con streaming de respuesta y de audio**:
  - Verbatim: `"Latencia: medir y reducir el tiempo STT -> intención -> primera frase audible; streaming de respuesta y de audio."`
  - Comportamiento aceptado:
    - Instrumentar el pipeline con eventos estructurados en `trace.ts` y `runLedger.ts`: `vad.speech_start`, `vad.eos`, `stt.start`, `stt.end`, `intent.route`, `llm.first_token`, `tts.first_sentence`, `tts.first_audio`, con métricas agregadas `p50`/`p95` por etapa; corregir `runLedger.ts:149` para no redactar `tokenCounts` y eliminar la emisión duplicada de `plan.created` en `llm.ts:173`.
    - Implementar `proxy_operator_http_stream` en `src-tauri/src/operator_runtime.rs` con un `reqwest::Client` compartido (HTTP/2 + keep-alive), entrega incremental de chunks SSE vía Tauri Channel/Event y cancelación real por `requestId`.
    - Acelerar STT: evitar la espera de `600 ms` de `MediaRecorder.stop()` cuando el buffer PCM ya está disponible y cachear el endpoint STT funcional por sesión para no repetir fallos HTTP 404 en cada turno.
    - Implementar streaming LLM -> TTS por oraciones (`SpeechSentenceQueue`) para turnos conversacionales/aclaraciones (`actions: []`), iniciando la síntesis de la primera oración en cuanto cierra mientras el modelo genera las siguientes, y habilitando `optimize_streaming_latency` / pipelining en `ttsNarrator.ts`.
  - Aceptación: las trazas JSONL registran los hitos completos de latencia sin `tokenCounts` redactado; en Tauri `llm.first_token` llega de forma incremental antes del fin de generación (ya no igualado al tiempo total) y la primera oración audible comienza antes de terminar la respuesta completa en turnos conversacionales.
  - Checks: tests Rust para `proxy_operator_http_stream` y pooling; tests Vitest de `OpenAiCompatPlannerProvider` streaming, `SpeechSentenceQueue`, `ttsNarrator.test.ts` y `runLedger.test.ts`.

- **S4 — Prosodia natural, brevedad y estilo hablado de SETH**:
  - Verbatim: `"Prosodia y estilo: respuestas breves de 2 a 4 oraciones, sin leer rutas ni UUIDs, con arranques naturales y sin muletillas de plantilla."`
  - Comportamiento aceptado:
    - Crear `normalizeForVoiceSpeech` (aplicado antes de TTS sin alterar los recibos visuales del hilo) que elimine o humanice UUIDs, rutas de archivo Windows/POSIX, URLs largas, hashes hexadecimales, flags CLI y bloques de código.
    - Conectar `ZedPersonaConfig` (`persona.name` con soporte/identidad SETH, `tone`, `brevity`, `builderCallMe`, `standingInstructions`) dentro de `buildOperatorSystemPrompt` (`prompt.ts`), reforzando respuestas habladas de 2 a 4 oraciones completas para conversación y 1 a 2 oraciones directas para confirmaciones.
    - Eliminar muletillas fijas de plantilla (`"Seguimos conversando por acá."`, `"Seguimos por acá."`, saludos robóticos repetidos) en `launchThread.ts`, `spawnSubagent.ts`, `launchAgent.ts` y `prompt.ts`, generando arranques naturales acordes al contexto del turno.
  - Aceptación: ninguna salida TTS vocaliza UUIDs, rutas `C:\...` o `src/...`, URLs crudas ni muletillas repetidas de plantilla; las respuestas conversacionales se mantienen en 2 a 4 oraciones completas.
  - Checks: tests unitarios dedicados para `normalizeForVoiceSpeech`, `sanitize.test.ts`, `ttsNarrator.test.ts` y `executor.test.ts`.

- **S5 — Conciencia estricta del proyecto/workspace activo sin contaminación cruzada**:
  - Verbatim: `"Conciencia del proyecto/workspace activo: SETH debe saber en qué proyecto está, qué terminales, hilos y agentes existen ahí, y no inventar ni mezclar elementos de otros workspaces."`
  - Comportamiento aceptado:
    - Implementar `WorkspaceSnapshotProvider` alimentado por la identidad autoritativa del workspace activo (`workspaceId`, `workspaceName`, `workspacePath`, rama Git si está disponible) con caché acotada e invalidación por eventos (`kite:workspace-changed`, `kite:threads-changed`, `kite:terminal-agent-update`).
    - Extender `TurnContext` y `buildOperatorSystemPrompt` con el inventario acotado y estrictamente filtrado por `workspaceId` de: (1) terminales activas del proyecto, (2) hilos recientes del proyecto (`list_chat_summaries` filtrado), (3) subagentes del proyecto (`dispatch_ls` / hilos hijos) y (4) agentes autónomos disponibles y su estado (`list_agent_profiles` + `list_agent_chat_summaries`).
    - Cerrar las fugas actuales: eliminar el permiso `!t.workspaceId` que mezclaba terminales sin workspace en `index.ts:106`, `sessionContextHub.ts:100` y `narrate.ts:15`; filtrar `fetchLiveChatCatalog()` (`chatIndex.ts`) y `loadZedMemoryNotes()` (`prompt.ts`) por el workspace activo.
    - Unificar la inspección de estado (`narrate_summary` / `inspect_entity_status`) para resolver entidades por nombre (`Nova`, `Orion`, nombre de perfil de agente, rol de subagente o título de hilo) en todas las superficies del workspace activo.
  - Aceptación: con dos workspaces cargados (`A` y `B`), preguntar por terminales, hilos o agentes estando en `A` solo lista y opera sobre entidades de `A`, jamás inventa entidades inexistentes ni mezcla elementos de `B`; preguntar `"¿qué está haciendo Nova?"` responde con precisión ya sea terminal, subagente, agente autónomo o hilo.
  - Checks: pruebas de aislamiento multi-workspace en `operator.test.ts`, `chatIndex.test.ts`, `prompt.test.ts` y `executor.test.ts`.

- **S6 — Memoria de sesión y entre sesiones por proyecto**:
  - Verbatim: `"Memoria de sesión y entre sesiones: recordar decisiones, tareas delegadas y estado de los agentes para responder \"¿qué está haciendo Nova?\" o \"continúa lo de ayer\" con precisión."`
  - Comportamiento aceptado:
    - Mantener un `DelegationLedger` en vivo por workspace que registre cada hilo, subagente, agente autónomo o terminal lanzado/referenciado (nombre/rol, objetivo breve, recurso ID, timestamp, estado y resumen más reciente actualizado por eventos de runtime).
    - Persistir memoria episódica por workspace en disco (respetando `persona.rememberBetweenCalls` y `afterCallMode: 'summary+decisions'`, coexistiendo sin migrar destructivamente `kite.zed.memoryNotes.v1`): al cerrar una llamada de voz o completar delegaciones clave, guardar decisiones acordadas, tareas delegadas y pendientes resumidos.
    - Reconciliar el `DelegationLedger` y la memoria episódica con el estado real (`list_chat_summaries`, `dispatch_ls`, `getActiveAgentTerminals`) antes de inyectar un bloque compacto (`<= 6` ítems recientes del workspace) en el planner.
    - Actualizar `consultChats` (`chatIndex.ts`) con filtrado por workspace, resolución de consultas temporales (`"ayer"`, `"anoche"`, `"última sesión"`, `"lo que delegamos"`) y desempate por recencia/relevancia en lugar de rechazar sistemáticamente con `not-one`, preservando la regla de leer como máximo 1 conversación completa bajo demanda.
  - Aceptación: al abrir una nueva sesión de voz al día siguiente en el mismo workspace y pedir `"continúa lo de ayer"` o `"¿qué está haciendo Nova?"`, SETH recupera la decisión/delegación correspondiente del proyecto correcto y reporta su estado real reconciliado sin volcar todos los chats.
  - Checks: tests de persistencia/recuperación entre sesiones, reconciliación de estado y `consultChats` temporal en `chatIndex.test.ts` y tests del módulo de memoria episódica.

- **S7 — Interpretación robusta de STT en español, polaridad y elección de superficie**:
  - Verbatim: `"Interpretación de instrucciones ambiguas o mal transcritas (STT en español): desambiguación fonética, polaridad (no cierres / abre), y elección correcta del tipo de acción entre hilo, subagente, agente o terminal."`
  - Comportamiento aceptado:
    - Implementar `normalizeSpanishVoiceStt` con corrección fonética sensible al contexto (invocaciones `"oye Seth"`, `"sierra/serrar"`, `"threats/treads/trids"`, `"su agente/la gente"`, `"o de de"`, proveedores `claude/grok/codex/antigravity/opencode`, puntuación de pausas STT), preservando la transcripción original en la traza para depuración.
    - Implementar análisis de polaridad por cláusula (`analyzeClausePolarity`) para separar negaciones y cláusulas contrastivas: `"no cierres las terminales, abre un hilo con Claude"` suprime únicamente el cierre negado y ejecuta `launch_thread`; `"no cierres nada"` sigue bloqueando toda acción de cierre.
    - Refinar el enrutador híbrido (`index.ts` + `heuristic.ts`): restringir el fast-path determinista a comandos utilitarios inequívocos; enviar al LLM con el roster del workspace las solicitudes con ambigüedad fonética, polaridad mixta o selección entre **hilo** (`launch_thread`), **subagente** (`spawn_subagent` `via: "thread"`), **agente autónomo** (`launch_agent`) y **terminal** (`open_terminals` / `inject_prompt`). Eliminar el secuestro de `"abre un agente..."` hacia `open_terminals` en modo Thread y el default forzado `cli: 'grok'` en `SPAWN_SUBAGENT`.
  - Aceptación: batería de casos reales STT en español (seseo, `"threats"`, `"su agente"`, `"no cierres..., abre..."`, delegación a hilo vs subagente vs agente autónomo vs terminal) elige la acción y polaridad correctas con 100% de precisión en pruebas deterministas.
  - Checks: ampliación de `src/lib/operator/fixtures/utterances.es.json` + tests en `heuristic.test.ts`, `operator.test.ts`, `llm.test.ts`.

- **S8 — Desambiguación activa con máximo una pregunta concreta**:
  - Verbatim: `"Desambiguación activa: si falta un dato crítico, hacer como máximo una pregunta concreta antes de delegar."`
  - Comportamiento aceptado:
    - Extender `OperatorPlan` (`contract.ts`) y `voiceSessionStore` con soporte estructurado para `clarification` y `PendingDisambiguation` (`question`, `missingSlot`, `candidates`, `draftAction`, `createdAt`, `remainingTurns: 1`).
    - Cuando falte un dato crítico antes de delegar o ejecutar una acción ambigua (por ejemplo: objetivo vacío en una delegación, múltiples entidades llamadas igual en distintas superficies, o orden de cierre sin objetivo claro habiendo varias terminales activas), SETH no ejecuta ni adivina destructivamente: guarda `PendingDisambiguation` y formula **como máximo una pregunta concreta y breve** ofreciendo 2–3 opciones reales del workspace.
    - En el turno inmediatamente posterior, la respuesta del usuario resuelve el hueco y ejecuta la acción; si el usuario cambia de tema o cancela (`"déjalo"`, `"olvídalo"`), `PendingDisambiguation` se limpia limpiamente. Nunca encadenar dos preguntas consecutivas por la misma intención.
  - Aceptación: una orden ambigua produce 0 acciones ejecutadas y 1 pregunta concreta; responder esa pregunta ejecuta la acción esperada en el turno siguiente; cancelar descarta el borrador sin efectos secundarios.
  - Checks: tests de máquina de estados de desambiguación de 2 turnos en `useOperatorTurn.test.ts`, `llm.test.ts` y `ThreadVoiceMode.test.tsx`.

---

## Tasks

Plan priorizado en 3 fases incrementales. Cada fase es desplegable y verificable de forma independiente.

### Fase 1 — Naturalidad Conversacional y Latencia (`S1`, `S2`, `S3`, `S4`)

- [x] **T1** (`S3`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 (contrato de trazas)` — **Instrumentación E2E de latencia y correcciones de telemetría**: agregados `vad.speech_start`, `vad.eos`, `stt.start`, `stt.end`, `intent.route`, `llm.first_token`, `tts.first_sentence`, `tts.first_audio` y `computeVoiceLatencySummary` en `src/lib/operator/trace/{types,trace}.ts`; corregida redacción de `tokenCounts` en `src/lib/operator/runLedger.ts` y `src-tauri/src/operator_runtime.rs`; eliminado `plan.created` duplicado en `src/lib/operator/planner/llm.ts`. (GREEN: `trace.test.ts`, `runLedger.test.ts`, `llm.test.ts` 41/41).
- [x] **T2** (`S1`, `S2`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 4 (concurrencia de audio/turnos)` — **Motor de audio persistente (`AudioWorklet`), VAD adaptativo y barge-in acústico**: creados `AdaptiveVadController`, `PcmPreRollBuffer` (`400 ms`), `BargeInGate` y `computeAdaptiveEndpointMs` (`src/lib/operator/voice/adaptiveVad.ts`), integrados en `src/lib/operator/voice/zedVoice.ts` con grafo persistente en llamadas continuas (sin reinicios cada 8 s) y omisión de espera de `600 ms` de `MediaRecorder.stop()` cuando hay PCM listo.
- [x] **T3** (`S1`, `S2`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 4 (arbitraje de estado asíncrono)` — **Arbitraje de turnos (`VoiceTurnArbitrator`) e integración de barge-in en `ZedStrip` y `proactiveWatcher`**: creado `src/lib/operator/voice/turnArbitrator.ts`, integrado barge-in full-duplex en `src/components/ZedStrip.tsx` + `src/lib/operator/hooks/useOperatorVoice.ts` + marca `[respuesta interrumpida por el usuario]` en `voiceSessionStore.ts`, ducking idempotente en `audioDucking.ts` y cola no solapada en `proactiveWatcher.ts`.
- [x] **T4** (`S3`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 & 4 (proxy HTTP streaming en Rust)` — **Streaming HTTP nativo con pool `reqwest::Client` y caché de endpoint STT**: `shared_http_client()` (`OnceLock`), `proxy_operator_http_stream` + `cancel_operator_http_stream` (UTF-8 chunk-safe) y `operator_memory_{load,save}` en `src-tauri/src/operator_runtime.rs` y `src-tauri/src/main.rs` (`cargo test operator_runtime` 10/10); `operatorHttpStreamFetch` en `src/lib/operator/config/httpFetch.ts`; cableado SSE en `openaiCompat.ts`; caché de endpoint STT en `transcriptionProviders.ts`.
- [x] **T5** (`S3`, `S4`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 (formato de salida hablada)` — **Streaming LLM -> TTS por oraciones, normalizador de prosodia e identidad SETH**: creados `normalizeForVoiceSpeech`, `StreamingJsonReplyExtractor` y `SpeechSentenceQueue` (`src/lib/operator/voice/speechProsody.ts`), integrados en `ttsNarrator.ts` (`optimize_streaming_latency=3`, `tts.first_audio`), `llm.ts`, `ZedStrip.tsx`, `prompt.ts` (identidad `SETH` + persona) y ejecutores sin muletillas (`launchThread.ts`, `spawnSubagent.ts`, `launchAgent.ts`).

### Fase 2 — Contexto Estricto de Proyecto y Memoria (`S5`, `S6`)

- [x] **T6** (`S5`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 (contrato TurnContext y aislamiento de workspace)` — **`WorkspaceSnapshotProvider` y cierre de fugas multi-workspace**: creado `src/lib/operator/context/workspaceSnapshot.ts` con caché invalidada por eventos y roster acotado de terminales, hilos, subagentes y agentes autónomos estrictamente filtrados por `workspaceId`; cerrado el escape `!t.workspaceId` en `index.ts`, `sessionContextHub.ts` y `narrate.ts`; filtradas notas locales por workspace en `prompt.ts`.
- [x] **T7** (`S5`, `S6`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 1 (persistencia en disco por workspace)` — **Memoria episódica por workspace y `DelegationLedger`**: creado `src/lib/operator/context/episodicMemory.ts` con persistencia en disco (`operator_memory_{load,save}` + respaldo local), registro automático desde recibos en `index.ts`, hook de cierre `afterCallMode` en `voiceSessionStore` y reconciliación contra estado vivo.
- [x] **T8** (`S5`, `S6`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `none` — **Inspección unificada de entidades y `consultChats` v2 temporal por workspace**: actualizado `src/lib/operator/executor/actions/narrate.ts` para resolver entidades por nombre en terminales, subagentes, agentes autónomos, hilos y `DelegationLedger`; actualizado `src/lib/operator/chatIndex.ts` con filtrado estricto por `workspaceId` y resolución temporal (`"continúa lo de ayer"`).

### Fase 3 — Desambiguación Inteligente y Verificación Integral (`S7`, `S8`)

- [x] **T9** (`S7`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 (enrutamiento de comandos existentes)` — **Normalizador fonético español STT y analizador de polaridad por cláusula**: creados `src/lib/operator/planner/voiceNormalizer.ts` y `src/lib/operator/planner/clausePolarity.ts`, integrados en `heuristic.ts`, `workspaceThreadIntent.ts`, `llm.ts` e `index.ts`.
- [x] **T10** (`S7`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 (contrato de enrutamiento híbrido)` — **Enrutador híbrido por confianza y matriz de superficies**: actualizado `runOperatorTurn` (`index.ts`) para evitar que `"abre un agente..."` en modo Thread/Voz sea secuestrado por `open_terminals`, retirado el default forzado `cli: 'grok'` en `SPAWN_SUBAGENT` y reforzada la matriz Hilo / Subagente / Agente autónomo / Terminal en `prompt.ts`.
- [x] **T11** (`S8`) — Route: `inline` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 (extensión de OperatorPlan y estado de sesión)` — **Contrato de desambiguación activa (`PendingDisambiguation`)**: agregados `ClarificationSchema` en `contract.ts`, estado con TTL (`90 s` / `remainingTurns: 1`) en `voiceSessionStore.ts` y `src/lib/operator/planner/disambiguation.ts` con guardia anti-bucle (máximo 1 pregunta concreta) y cancelación limpia.
- [x] **T12** (`S1`–`S8`) — Route: `inline + independent verifier` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 & 4 (verificación integral)` — **Suite de fixtures de voz en español y verificación integral**: agregados `voicePipelinePhase1.test.ts`, `contextMemoryPhase2.test.ts`, `intentDisambiguationPhase3.test.ts` y nuevos fixtures en `utterances.es.json`; `npx tsc --noEmit` (0 errores), `npx vitest run` (32/32 archivos, 417/417 tests), `cargo test operator_runtime` (10/10), `audit-references.mjs --check` (396 archivos, 0 fugas) y revisor independiente (`thread:936a293d-8c71-406c-92f2-3548a3a5376c`) **APPROVE** (`S1`–`S8` PASS). Nota: `npm run verify:desktop:e2e` pendiente de ejecución manual contra ventana Tauri en vivo con hardware de audio.
- [x] **T13** (`S2`) — Route: `inline + independent verifier` — Commit: `uncommitted (feat/response-thread)` — Riesgo: `item 3 & 4 (captura compartida por modo voz continuo, dictado one-shot y barge-in)` — **Compuerta de captura PCM por VAD con pre-roll y recorte de silencio final**: `trimTrailingPcmSamples` en `src/lib/operator/voice/adaptiveVad.ts`, compuerta `isSpeechCaptureOpen` + omisión de `MediaRecorder` redundante + recorte de cola `250 ms` + `audioDurationMs` en `src/lib/operator/voice/zedVoice.ts` y `src/lib/operator/trace/types.ts`, con 5 pruebas nuevas en `zedVoice.test.ts` y `voicePipelinePhase1.test.ts`. Verificado: `npx tsc --noEmit` (0 errores), `npx vitest run` (`src/lib/operator/voice` 4/4 archivos, 38/38 tests; `zedVoice` + `voicePipelinePhase1` + `ttsNarrator` 3/3 archivos, 42/42 tests; suite `src/lib/operator` + `ZedStrip` + `ThreadVoiceMode` 29/30 en carga paralela con `ttsNarrator` 30ms flake verificado en verde en corrida aislada), `node .kite/sanitizer/audit-references.mjs --check` (396 archivos, 0 fugas) y revisor independiente (`thread:6f0a7e1a-9720-450a-8bbd-c48751885caa`) **APPROVE** (`S2: PASS`, `S1 non-regression: PASS`).

---

## Log

- **L1 (2026-11-20)**:
  > Objetivo: elevar la calidad del modo de voz de SETH (asistente operador de Kite Code) en dos ejes prioritarios.
  >
  > 1) Naturalidad conversacional:
  > - Barge-in real: permitir interrumpir al asistente mientras habla, cortando el TTS de inmediato sin perder el hilo.
  > - Gestión de turnos: detección de fin de frase/silencio con umbrales adaptativos, evitar respuestas encimadas y evitar cortes prematuros.
  > - Latencia: medir y reducir el tiempo STT -> intención -> primera frase audible; streaming de respuesta y de audio.
  > - Prosodia y estilo: respuestas breves de 2 a 4 oraciones, sin leer rutas ni UUIDs, con arranques naturales y sin muletillas de plantilla.
  >
  > 2) Inteligencia contextual del asistente:
  > - Conciencia del proyecto/workspace activo: SETH debe saber en qué proyecto está, qué terminales, hilos y agentes existen ahí, y no inventar ni mezclar elementos de otros workspaces.
  > - Memoria de sesión y entre sesiones: recordar decisiones, tareas delegadas y estado de los agentes para responder "¿qué está haciendo Nova?" o "continúa lo de ayer" con precisión.
  > - Interpretación de instrucciones ambiguas o mal transcritas (STT en español): desambiguación fonética, polaridad (no cierres / abre), y elección correcta del tipo de acción entre hilo, subagente, agente o terminal.
  > - Desambiguación activa: si falta un dato crítico, hacer como máximo una pregunta concreta antes de delegar.
  >
  > Entregables:
  > - ODD en odd/tasks/ con alcance, arquitectura propuesta (pipeline de voz, capa de intención, contexto de proyecto), riesgos y plan por fases.
  > - Diagnóstico del estado actual del modo de voz y del manejo de contexto, con los principales cuellos de botella identificados.
  > - Plan de implementación priorizado (fase 1: naturalidad y latencia; fase 2: contexto de proyecto y memoria; fase 3: desambiguación inteligente).
  >
  > Trabaja en segundo plano, sin abrir terminales. Registra hallazgos y decisiones en el ODD.

- **L2 (2026-11-20) — Diagnóstico y decisiones de arquitectura registradas**:
  - **Evidencia de código y trazas**: se auditaron `src/lib/operator/{index,contract,ttsNarrator,chatIndex,sessionContextHub,runLedger,proactiveWatcher}.ts`, `src/lib/operator/voice/{zedVoice,transcriptionProviders,audioDevices,audioDucking,voiceSessionStore}.ts`, `src/lib/operator/planner/{llm,prompt,sanitize,heuristic,heuristicPatterns,workspaceThreadIntent,terminalSummary}.ts`, `src/lib/operator/providers/openaiCompat.ts`, `src/lib/operator/config/{httpFetch,persona}.ts`, `src/lib/operator/executor/{index,actions/{narrate,launchThread,spawnSubagent,launchAgent}}.ts`, `src/components/ZedStrip.tsx`, `src-tauri/src/operator_runtime.rs`, `src-tauri/src/chat_commands/threads_cmd.rs` y las trazas vivas de `%APPDATA%\Kite Code\operator-traces\2026-11-20.jsonl`.
  - **Hallazgos críticos confirmados**:
    1. La latencia LLM medida hoy es `p50 = 11.85 s` / `p95 = 15.92 s` y `first_token` coincide con el tiempo total (`8.88–15.92 s`) porque `proxy_operator_http` (`operator_runtime.rs:209,337`) instancia un `reqwest::Client` nuevo en cada solicitud y ejecuta `resp.text().await` bloqueando todo el stream SSE en Rust.
    2. No existe barge-in acústico en llamada porque `zedVoice.ts:537,612` y `ZedStrip.tsx:434,524-530` cierran el micrófono al finalizar la frase del usuario y no lo reabren hasta `ttsNarrator.speak({ onEnd })`.
    3. `VAD_RMS_THRESHOLD = 0.015`, `TRAILING_SILENCE_MS = 2400` e `IDLE_NO_SPEECH_MS = 8000` (`zedVoice.ts:86-88`) provocan 2.4 s de espera fija por turno, 30% de capturas descartadas en las trazas analizadas y reaperturas de hardware con ducking/tonos Zen repetidos.
    4. `TurnContext` (`index.ts:64-136`) solo conoce terminales PTY (permitiendo fugas cuando `!t.workspaceId`), mientras `fetchLiveChatCatalog()` (`chatIndex.ts:99-113`) y `loadZedMemoryNotes()` (`prompt.ts:26`) mezclan todos los workspaces sin filtro.
    5. `ZedPersonaConfig` (`persona.ts:205`) no se inyecta en `prompt.ts`, `afterCallMode: 'summary+decisions'` no tiene escritor y `runLedger.ts:149` redacta `tokenCounts` como `[REDACTED_SECRET]`.
    6. Las heurísticas pre-LLM (`heuristic.ts`, `heuristicPatterns.ts:79-92`) anulan cláusulas afirmativas tras una negación en polaridad mixta, desvían `"abre un agente..."` a terminales en modo Thread y no contemplan un flujo estructurado de desambiguación de 1 pregunta.
  - **Decisiones**:
    - Mantener `odd/tasks/seth-voice-intelligence.md` como documento público único de esta iniciativa (conectado a `thread-voice-mode.md` y `assistant-reach.md`), priorizando en 3 fases: **Fase 1 (T1–T5)** naturalidad y latencia, **Fase 2 (T6–T8)** contexto de proyecto y memoria, **Fase 3 (T9–T12)** desambiguación inteligente y verificación integral.
    - No modificar código de producción en esta iteración (alcance exclusivo de diagnóstico, arquitectura y ODD); siguiente paso: aprobación de alcance/fases para iniciar **Fase 1 (`T1`–`T5`)**.

- **L3 (2026-11-20)**: `"si vamos con esas implementaciones"` — Autorización explícita para implementar `odd/tasks/seth-voice-intelligence.md` (`T1–T12` en Fases 1, 2 y 3) sobre la rama `feat/response-thread`. Se preserva el working tree previo sin mezclar commits no autorizados y se verifica cada fase con pruebas RED/GREEN, `tsc`, `vitest`, `cargo test` y auditoría de referencias.

- **L4 (2026-11-20) — Cierre de implementación T1–T12 y verificación independiente**:
  - Completadas las 3 fases (`T1–T12`, `S1–S8`) con 9 módulos nuevos (`adaptiveVad.ts`, `turnArbitrator.ts`, `speechProsody.ts`, `workspaceSnapshot.ts`, `episodicMemory.ts`, `voiceNormalizer.ts`, `clausePolarity.ts`, `disambiguation.ts` + 3 suites dedicadas) y streaming HTTP pooled en Rust (`proxy_operator_http_stream`, `cancel_operator_http_stream`, `operator_memory_{load,save}`).
  - Verificación observada: `npx tsc --noEmit` (0 errores), `npx vitest run` en `src/lib/operator`, `ZedStrip.test.tsx`, `ThreadVoiceMode.test.tsx`, `SingleThreadPane.test.tsx` y `AgentChatShell.test.tsx` (**32/32 archivos, 417/417 tests en verde**), `cargo test --manifest-path src-tauri/Cargo.toml operator_runtime` (**10/10 en verde**), `node .kite/sanitizer/audit-references.mjs --check` (**396 archivos, 0 fugas**).
  - Revisor independiente de solo lectura (`thread:936a293d-8c71-406c-92f2-3548a3a5376c`): **APPROVE** (`S1`–`S8` PASS). Se aplicó además su observación menor en `ensureEpisodicSessionHook` (`episodicMemory.ts`) para usar `resolveAuthoritativeWorkspace().workspaceId`.
  - Pendiente para validación en vivo: ejecutar `npm run verify:desktop:e2e` / prueba de audio en vivo contra una compilación de escritorio con micrófono y altavoces reales.

- **L5 (2026-11-20)**: `"genera la actualizaicon"` — Publicada versión local `v0.1.76` vía `node scripts/release.mjs patch --fast` (`Kite-Code_0.1.76_x64-setup.exe`, `17,605,079` bytes / `16.79 MiB`, firma `.sig` de `440` bytes). Verificado feed vivo `http://127.0.0.1:9101/studio/latest.json` (`HTTP 200`, `0.1.76`), `feed/studio/latest.json`, `%LOCALAPPDATA%\Kite Code\feed\studio\latest.json`, `CHANGELOG.md`, `src/lib/changelogData.ts` y `node .kite/sanitizer/audit-references.mjs --check` (396 archivos, 0 fugas).

- **L6 (2026-11-21)**: `"Habría que revisar eso y que realmente se utiliza el tiempo real de lo que uno. Está hablando. Para transcribir y no el tiempo total de escucha con tiempo vacío. ¿Cómo podemos hacer eso? Bueno. Detectando la intensidad, si es que se detecta. Que hay contenido, claramente ahí, se debe mandar la petición, pero si es que no, en espera, o algo así."` -> `"Okey, sí, quiero que vayamos con eso."` — Detectado en `zedVoice.ts:256,536-541` que, pese a contar con `AdaptiveVadController` y `PcmPreRollBuffer` (`400 ms`), `rawPcmChunks` y `MediaRecorder` acumulaban silencio desde el inicio de la escucha, inflando la RAM y enviando todo el silencio previo al primer habla en el WAV facturado por Grok STT. Implementada compuerta por VAD + pre-roll + recorte de silencio final (`250 ms` pad) en `T13` (`S2`).
