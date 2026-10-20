# Plan 3 — Reescritura y verificación real del Asistente Operador (Zed)

> **Destinatario:** otro agente de implementación. Debe poder ejecutar este plan sin contexto previo.
> **Idioma:** toda salida visible al usuario, TTS y mensajes de log legibles deben estar en **español**. El código y los identificadores, en inglés.
> **Regla de oro:** *ninguna fase se da por terminada sin evidencia verificable en logs/trace*, no "porque el test unitario pasa".

---

## Estado de avance

| Fase | Estado |
|---|---|
| **F0 — Baseline y diagnóstico de fallas** | ✅ **HECHO** (2026-10-18). Documentado en [`plan-3-baseline.md`](./plan-3-baseline.md). |
| **F1 — Trace por turno (Tauri + TS)** | ✅ **HECHO** (2026-10-18). `operator_trace_append`, `operator_trace_path`, buffer TS en disco/localStorage. |
| **F2 — Contrato y sanitización** | ✅ **HECHO** (2026-10-18). Zod schemas, bloqueo de eco de prompts y filtro de inglés en TTS. |
| **F3 — Heurístico y fixtures en español** | ✅ **HECHO** (2026-10-18). 62 fixtures STT en `utterances.es.json`, planner determinista probado. |
| **F4 — Bus de UI con confirmación (ACK)** | ✅ **HECHO** (2026-10-18). Request/Ack tipado, `code-workspace-ready` sin timeouts ciegos. |
| **F5 — Executor con post-condiciones y recibos** | ✅ **HECHO** (2026-10-18). Verificación de terminales activas, respuestas derivadas de recibos reales. |
| **F6 — Planner LLM multi-proveedor** | ✅ **HECHO** (2026-10-18). Proveedores `openaiCompat`, `cli`, `local` con validación Zod y degradación visible. |
| **F7a — Rediseño visual del widget flotante (UI)** | ✅ **HECHO** (2026-10-18). Cabecera limpia, panel de estado único, registros compactos. |
| **F7b — Integración UI + hooks + timeline trace v2** | ✅ **HECHO** (2026-10-18). `useOperatorTurn`, inspector de traces, badges de estrategia, copia de trace y re-ejecución. |
| **F8 — Verificación E2E real y prueba de sabotaje** | ✅ **HECHO** (2026-10-18). 100% PASS en E1–E11 + Sabotaje anti-falsos-positivos. Reporte en [`plan-3-e2e-report.md`](./plan-3-e2e-report.md). |
| **F9 — Limpieza y compatibilidad retroactiva** | ✅ **HECHO** (2026-10-18). Monolito desarticulado, re-exports seguros, TypeScript 0 errores, suite completa verde. |

> **Nota para el ejecutor:** el rediseño visual ya está hecho. **No lo rehagas.** Al llegar a F7 solo falta F7b: extraer hooks (`useOperatorTurn`, `useOperatorVoice`), conectar el timeline del trace v2 en la pestaña Registros y las fases del estado ("Abriendo terminales…", "Verificando…"). Mantén los `data-testid` y las clases CSS existentes porque el harness E2E (§6.4) depende de ellos.

### F7a: qué se hizo
Archivos: [`ZedStrip.tsx`](../../src/components/ZedStrip.tsx) y [`zedFloat.css`](../../src/components/zedFloat.css). **No se tocó la lógica del operador** (salvo el punto marcado con \*).
- **Cabecera limpia:** punto de estado (reposo / ocupado pulsante / ok / error) + nombre + tabs segmentados (`Comando`, `Registros` con contador) + cerrar. Se eliminó el grip de arrastre; toda la cabecera arrastra.
- **Un solo panel de estado** (`data-testid="zed-status"`, `role="status"`) en lugar de chips/respuestas apiladas: *Pensando y ejecutando…* (spinner) → respuesta (máx. 4 líneas) con etiqueta del **camino usado** (`Intérprete local` / `IA remota` / `IA (CLI)` / `Respaldo local` en ámbar), latencia y enlace *Ver detalle*.
- **Estado vacío útil:** 3 comandos de ejemplo clicables (rellenan el input).
- **Registros compactos:** cada turno es una fila colapsada (punto ok/fallo + comando + hora); al desplegar: respuesta, camino/modelo/latencia, pasos ejecutados, error y *respuesta en bruto* dentro de un `<details>` plegado. Máx. 20 filas. Sin emojis.
- **`data-testid` añadidos:** `zed-card`, `zed-input`, `zed-send`, `zed-status`, `zed-tab-command`, `zed-tab-logs`.
- \* **Honestidad en el error:** si `dispatchOperatorCommand` lanza, ya no se muestra el texto optimista de la heurística local ("Abriendo 2 terminales…" sin haber hecho nada); ahora dice *"No pude completar la orden: <motivo>"*.
- Chip flotante único (`slice(-1)`) con la tarjeta cerrada se mantiene. Ancho del popover 340→372 px.
- Placeholder: `Ej: abre 2 terminales con grok y ejecuta los test` (el test existente usa `/abre 2 terminales/i`).
- Verificado: `npx tsc --noEmit` 0 errores; `npx vitest run src/lib/operator src/components/ZedStrip.test.tsx` 57/57.
- **Pendiente visual (lo valida el humano, §6.5):** revisar en la app real con `npm run tauri dev`.

---

## 0. Por qué fallan los intentos actuales (diagnóstico)

Se probó por prueba-y-error varias veces y nada funcionó. Causas identificadas leyendo el código actual (`src/lib/operator/*`, `src/components/ZedStrip.tsx`, `src-tauri/src/operator_runtime.rs`):

| # | Síntoma reportado | Causa raíz en el código |
|---|---|---|
| D1 | "Me lee lo que le dije / parafrasea" | `queryOperatorLLM` con provider `local` devuelve `Comando procesado localmente: ${prompt}` (operatorProviders.ts ~L234). Además `callOpenAICompatibleEndpoint` y `callCliSubscriptionProvider` convierten **cualquier texto no‑JSON en `reply` con `actions: []`** (L170‑174, L203‑208). El usuario escucha texto que *parece* respuesta, pero no se ejecutó nada. |
| D2 | "Me dijo parte del prompt" | `callCliSubscriptionProvider` (L184) concatena **system prompt + `User request:`** en un único argumento de CLI. Si el CLI hace eco, trunca o falla, su `stdout` (con trozos del system prompt) se usa como `reply` (L203‑208) y se **habla por TTS**. No hay sanitización ni detección de eco. |
| D3 | "No hace nada visible" | La **respuesta (reply) y las acciones no están acopladas**: se muestra/lee el `reply` del LLM *antes/independiente* de si la acción se ejecutó. No existe un "recibo" verificado post‑condición (¿realmente hay N terminales nuevas en el registro?). |
| D4 | "Agente de IA vs heurística" | Hay **3 caminos** distintos (fast‑path local, provider remoto, `executeOperatorCommand` heurístico, y fallback local dentro de providers). Imposible razonar cuál corrió. `dispatchOperatorCommand` ejecuta `parseOperatorIntent` siempre primero. |
| D5 | "Código feo / mezcla de cosas" | `operatorBrain.ts` (~800 líneas) mezcla parseo regex, ejecución, ruteo de providers, auditoría y formateo. `operatorConfig.ts` pesa ~35 KB (config + persona + modelos + métricas). `operatorProviders.ts` mezcla HTTP, CLI, prompt y parsing. `ZedStrip.tsx` mezcla UI, voz y orquestación. |
| D6 | Eventos al vacío | La creación de terminales depende de eventos DOM sueltos (`kite:navigate-mode`, `kite:spawn-agent-terminal`) escuchados por `App.tsx` y `CodeWorkspace.tsx` (solo montado en modo `code`). No hay **ack**: el emisor no sabe si alguien escuchó. Se parcheó con `setTimeout(180)`, que es frágil. |
| D7 | Timeout CLI | `timeoutSecs: 15` y prompt grande por argv en Windows (límite ~32 KB, problemas de quoting). |

**Conclusión:** hay que rediseñar en capas con un **contrato único**, **acks reales** y **trace por turno**, y probar con **verificación end‑to‑end sobre la app real**, no solo unit tests.

---

## 1. Objetivos y criterios de aceptación globales

1. Una instrucción de usuario produce **exactamente un "Turno"** con un `turnId`, y un **trace JSONL** completo (ver §3).
2. El asistente **solo dice que hizo algo si una post‑condición lo verificó**. Si falla, dice en español *qué falló y por qué*.
3. Nunca se habla ni se muestra texto crudo del modelo que contenga system prompt/JSON/eco. Todo `reply` pasa por un **sanitizador** (§4.5).
4. El camino usado (`ia-remota` | `ia-cli` | `heurística-local` | `fallback-por-error`) es **visible** en el panel "Registros" y en el trace. El fallback local **nunca es silencioso**.
5. Widget flotante limpio: input + 1 línea de estado del turno actual. Detalle solo en "Registros".
6. Suite de verificación (§6) pasa en CI local con `npm run test:operator` y `npm run verify:operator:e2e`.

---

## 2. Arquitectura objetivo (reescritura por capas)

Carpeta nueva: `src/lib/operator/` reorganizada así (mover, no duplicar; mantener re‑exports temporales en los archivos antiguos hasta terminar migración y luego borrarlos):

```
src/lib/operator/
  contract.ts          // Tipos: Turn, Plan, Action, ActionResult, Receipt, TraceEvent (zod schemas)
  planner/
    index.ts           // planTurn(input, ctx) -> Plan   (elige estrategia, NUNCA ejecuta)
    heuristic.ts       // parseo local determinista (regex STT-friendly) -> Plan
    llm.ts             // construye mensajes, llama provider, valida con zod -> Plan
    prompt.ts          // buildSystemPrompt(ctx) + ejemplos few-shot; SOLO aquí vive el prompt
    sanitize.ts        // sanitizeReply(), detectPromptEcho()
  providers/
    types.ts           // interface PlannerProvider { id; plan(messages, opts): Promise<RawModelOutput> }
    openaiCompat.ts    // opencode / vercel (fetch por proxy_operator_http)
    cli.ts             // grok/claude/agy vía query_operator_agent (stdin/archivo, no argv)
    local.ts           // proveedor "none": delega a heuristic
  executor/
    index.ts           // executePlan(plan, ctx) -> Receipt[]  (secuencial, con ack y verificación)
    actions/
      openTerminals.ts closeTerminals.ts injectPrompt.ts openBrowser.ts narrate.ts spawnSubagent.ts
    ui-bus.ts          // Request/Ack tipado sobre window (ver §4.3)
  verify/
    postconditions.ts  // verifyOpenTerminals(before, after, expected) etc.
  trace/
    trace.ts           // emitTrace(event) -> memoria + localStorage + archivo (Tauri)
    types.ts
  config/
    schema.ts defaults.ts storage.ts   // partir operatorConfig.ts en 3
  index.ts             // API pública: runOperatorTurn(input, opts)
```

### 2.1 Flujo único del Turno

```
UI (texto/voz) ──► runOperatorTurn(input)
   1. trace turn.start {turnId,input,source:'voz'|'texto',mode,workspaceId}
   2. context = snapshot(workspace, terminales activas, modo actual)
   3. plan = planTurn(input, context)          // trace plan.created {strategy, actions, rawModelOutput?, latencyMs}
   4. por cada acción: receipt = executeAction()  // trace action.start / action.ack / action.verify / action.end
   5. reply = composeReply(plan, receipts)     // el reply SALE de los recibos, NO del LLM
   6. speak(reply) si TTS activo               // trace tts.speak
   7. trace turn.end {overallSuccess, durationMs}
```

**Decisión clave:** el texto que se muestra y se habla lo **construye el código a partir de los recibos verificados** (`"Abrí 2 terminales con Grok y les envié: «ejecuta los test»."`). El `reply` del LLM es solo opcional/ignorado salvo en acciones de tipo conversación (`answer`), y aun así pasa por `sanitizeReply`.

### 2.2 Contrato del Plan (zod)

```ts
Plan = {
  strategy: 'llm' | 'heuristic' | 'heuristic-fallback',
  fallbackReason?: string,      // obligatorio si strategy = 'heuristic-fallback'
  actions: Action[],
  answer?: string               // solo para preguntas conversacionales
}
Action =
  | {type:'open_terminals', count:number(1..8), engine:Engine, prompts?:string[]}
  | {type:'close_terminals', target: string|number}
  | {type:'inject_prompt', target: string|number, prompt:string}
  | {type:'open_browser', url:string}
  | {type:'narrate_summary', target?: string|number}
  | {type:'spawn_subagent', cli:Engine, task:string}
```

Salida del modelo se valida con zod; si inválida → **un reintento** con mensaje corrector ("tu salida no cumplió el esquema: …"); si vuelve a fallar → `heuristic-fallback` con `fallbackReason` visible.

---

## 3. Observabilidad: Trace por turno (la base de toda verificación)

### 3.1 Eventos (JSONL, una línea por evento)

```jsonc
{"ts":1739900000000,"turnId":"t-ab12","seq":1,"ev":"turn.start","input":"abre dos terminales con grok","source":"texto","mode":"chat","workspaceId":"ws1"}
{"seq":2,"ev":"plan.created","strategy":"llm","provider":"opencode","model":"...","latencyMs":812,"actions":[...],"rawModelOutputTruncated":"<=2000 chars"}
{"seq":3,"ev":"action.start","actionIdx":0,"type":"open_terminals","args":{...}}
{"seq":4,"ev":"ui.request","reqId":"r-1","kind":"navigate","payload":{"mode":"code"}}
{"seq":5,"ev":"ui.ack","reqId":"r-1","ok":true,"ms":34}
{"seq":6,"ev":"ui.request","reqId":"r-2","kind":"spawn-terminal","payload":{...}}
{"seq":7,"ev":"ui.ack","reqId":"r-2","ok":true,"sessionId":"term-9","ms":210}
{"seq":8,"ev":"action.verify","actionIdx":0,"expected":{"newTerminals":2},"observed":{"newTerminals":2,"sessionIds":["term-9","term-10"]},"ok":true}
{"seq":9,"ev":"reply.composed","text":"Abrí 2 terminales con Grok…","source":"receipts"}
{"seq":10,"ev":"tts.speak","chars":58}
{"seq":11,"ev":"turn.end","overallSuccess":true,"durationMs":1480}
```

### 3.2 Destinos
- **Memoria + `localStorage`** (`kite.operator.trace.v2`, máx. 200 turnos) para la pestaña "Registros".
- **Archivo en disco (Tauri):** nuevo comando `operator_trace_append(line)` en `src-tauri/src/operator_runtime.rs` → `%APPDATA%/<app>/operator-traces/YYYY-MM-DD.jsonl`. **Es lo que leen los tests E2E** (un proceso externo no puede leer localStorage fácilmente).
- Comando `operator_trace_path()` para que la UI muestre "Abrir carpeta de logs".
- Compat: mantener `recordOperatorAudit` como adaptador que lee de trace hasta migrar `ZedStrip` y luego eliminarlo.

### 3.3 Redacción
- Nunca escribir API keys. `rawModelOutputTruncated` ≤ 2000 chars. Entrada de voz se guarda tal cual (útil para depurar STT).

---

## 4. Especificaciones de implementación por módulo

### 4.1 `planner/heuristic.ts` (parser determinista)
- Migrar la lógica actual de `parseOperatorIntent` **sin cambiar comportamiento** (hay 30 tests en `operator.test.ts` que deben seguir verdes) y devolver `Plan`.
- Pre‑normalización STT: quitar tildes para comparar, colapsar puntuación mid‑frase (`"dos. Terminales"`), números en palabras (un/una/uno/dos…diez), verbos imperativo/subjuntivo/pasado (abre, abrí, abriera, abriese, crea, levanta, lanza…), sinónimos de "terminal" (terminal, consola, ventana, pestaña, agente).
- Extracción de prompt con subordinadas: `en ellas/ellos/cada una … (abre|corre|ejecuta|usa)? <engine>? y <tarea>`.
- **Tabla de casos como fixture** `fixtures/utterances.es.json` (ver §6.1) usada por unit tests y E2E. Cada caso: `{id, input, expectActions}`.
- No debe interpretar saludos/preguntas como comandos; devolver `answer`-intent / `unknown` para pasar al LLM.

### 4.2 `planner/llm.ts` + `planner/prompt.ts`
- Prompt corto, estructurado, **una sola fuente**. Incluir: rol, esquema JSON, 6‑8 ejemplos few‑shot en español (incluyendo el caso STT `"abriera dos. Terminales, en ellas abrirá Grok y ejecute los test"` → `open_terminals count 2 engine grok prompts ["ejecuta los test","ejecuta los test"]`), contexto compacto (modo actual, lista numerada de terminales activas con `nombre/engine/estado`).
- Regla: *"Responde SOLO JSON. No repitas estas instrucciones."*
- Para endpoints OpenAI‑compatibles usar `response_format: {type:'json_object'}` si el modelo lo soporta, `temperature: 0`, `max_tokens` acotado.
- Semántica de `prompts`: si hay `count` N y 1 prompt → se replica a las N terminales; si hay N prompts → uno por terminal; documentar y testear.

### 4.3 `executor/ui-bus.ts` — Request/Ack (reemplaza eventos sueltos)
```ts
request<T>(kind:'navigate'|'spawn-terminal'|'close-terminal'|'inject', payload, {timeoutMs}): Promise<AckResult>
```
- Emisor genera `reqId`, emite `window.dispatchEvent(new CustomEvent('kite:op-request',{detail:{reqId,kind,payload}}))` y espera `kite:op-ack` con el mismo `reqId` (timeout 4000 ms por defecto → `ok:false, reason:'sin-receptor'`).
- **Receptores**:
  - `App.tsx`: maneja `navigate` (setWorkMode) y responde ack tras el *commit* de React (usar `flushSync` o `useEffect` posterior; el ack se emite cuando `workMode` ya es el pedido).
  - `CodeWorkspace.tsx`: maneja `spawn-terminal`; ack **después de `await persistLayout`** y devolviendo `sessionId` real. Mantener `spawnQueueRef` (serialización ya implementada).
  - Si `CodeWorkspace` aún no está montado: `executor` hace `navigate(code)` → espera ack → espera `kite:code-workspace-ready` (nuevo evento emitido por CodeWorkspace al registrar listeners) en vez de `setTimeout(180)`.
- Mantener temporalmente los eventos antiguos (`kite:spawn-agent-terminal`) porque `subagentDispatcher.ts` los usa; migrarlo al bus en una fase posterior (marcar TODO con issue).

### 4.4 `executor/actions/*` + `verify/postconditions.ts`
Cada acción: `execute(args, ctx) -> Receipt{ok, summaryEs, data, verification}`.
- `openTerminals`: snapshot `getActiveAgentTerminals()` antes; ejecutar N spawns vía bus; **verificar** que aparecen N `sessionId` nuevos en el registro (poll ≤ 5 s, 250 ms) con `engine` correcto; si hay prompts, verificar que se inyectaron (la inyección devuelve ack; si el engine necesita arranque, esperar prompt‑ready con timeout configurable y reportar "enviado" vs "terminal lista").
- `closeTerminals`: verificar que los `sessionId` objetivo ya no están (o estado `closed`).
- `openBrowser`: verificar ack de la vista/dock y URL.
- Ningún `catch` silencioso: todo error → `Receipt{ok:false, summaryEs:"No pude … porque …"}`.

### 4.5 `planner/sanitize.ts`
- `detectPromptEcho(text, systemPrompt)`: true si comparte ≥ 40 caracteres contiguos con el system prompt, contiene `REGLAS CRÍTICAS`, `User request:`, `"actions":`, o bloques ```` ``` ````.
- `sanitizeReply(text)`: quita markdown/JSON/URLs largas, recorta a 280 chars, fuerza español (si detecta mayoritariamente inglés → descartar y usar plantilla del recibo).
- `ttsNarrator.cleanTextForSpeech` se aplica **después**.

### 4.6 `providers/cli.ts`
- No pasar system prompt por argv. Escribir prompt a archivo temporal (o stdin) y pasar la ruta/stdin; en `operator_runtime.rs` actualizar `query_operator_agent` para soportar `promptFile`/stdin.
- Timeout por defecto 45 s configurable; devolver `{stdout, stderr, exitCode, durationMs}` y trazar `stderr` truncado.
- Si el CLI no es JSON válido → **no** usar stdout como reply; pasar a reintento/fallback con razón.

### 4.7 Config
Partir `operatorConfig.ts` (35 KB) en `schema.ts`/`defaults.ts`/`storage.ts` + `persona.ts`. Sin cambios de claves de localStorage (migración transparente) salvo trace v2.

### 4.8 UI (`ZedStrip.tsx` y relacionados) — *rediseño visual ya hecho en F7a; resta F7b*
- Extraer hooks: `useOperatorTurn()` (estado del turno), `useOperatorVoice()` (STT/TTS). `ZedStrip` solo renderiza.
- Widget: input + **una línea de estado** con fases en español: *Pensando… → Abriendo terminales… → Verificando… → Listo / Falló: motivo*. Chip con estrategia usada (IA remota / CLI / local / respaldo).
- Pestaña **Registros**: lista de turnos; al expandir, timeline del trace (plan, acciones, acks, verificación). Botones: *Copiar trace del turno*, *Abrir carpeta de logs*, *Reejecutar turno*.
- Indicador claro cuando se usó `heuristic-fallback` y **por qué** (p. ej. "El modelo devolvió texto inválido; usé el intérprete local").

---

## 5. Fases de trabajo (orden obligatorio)

| Fase | Entregable | Gate de salida |
|---|---|---|
| **F0** Baseline | Congelar tests actuales (`npx vitest run src/lib/operator` = 53 verdes) y `npx tsc --noEmit` = 0 errores. Capturar 3 traces manuales con el sistema viejo (anotar fallas). | ✅ Completado. Documento `docs/agent-orchestration/plan-3-baseline.md` con hallazgos. |
| **F1** Trace | `trace/*` + comando Tauri `operator_trace_append`; instrumentar el flujo para emitir eventos. | ✅ Completado. Comandos Rust y trace TS con buffer en disco/localStorage y tests unitarios. |
| **F2** Contrato + sanitize | `contract.ts`, `sanitize.ts` con tests de eco/inglés/JSON. Bloquear TTS de texto no sanitizado. | ✅ Completado. Zod schemas y sanitizador con tests A2/A3 pasando. |
| **F3** Heurístico + fixtures | `heuristic.ts` + `utterances.es.json` (62 casos). | ✅ Completado. 62 fixtures en español + 30 tests de compatibilidad verdes. |
| **F4** UI‑bus con ack | `ui-bus.ts`, receptores en `App.tsx`/`CodeWorkspace.tsx`, evento `code-workspace-ready`. | ✅ Completado. Tests de integración pasando, sin race conditions ni timeouts ciegos. |
| **F5** Executor + postcondiciones | `executor/*`, `verify/*`, `composeReply` desde recibos. | ✅ Completado. Acciones atómicas verificadas con postcondiciones reales. |
| **F6** Planner LLM + providers | `llm.ts`, `prompt.ts`, `providers/*`, validación zod, reintento, fallback explícito. | ✅ Completado. Proveedores modularizados con tests nivel C (C1–C6) verdes. |
| **F7** UI | Rediseño visual (F7a) + hooks (`useOperatorTurn`) + timeline de traces v2 (F7b). | ✅ Completado. UI limpia con 1 línea de estado, badges y panel de registros completo. |
| **F8** E2E real | Harness sobre la app y backend simulado/real. | ✅ Completado. `npm run verify:operator:e2e` verde (E1–E11 + Sabotaje), reporte en `docs/agent-orchestration/plan-3-e2e-report.md`. |
| **F9** Limpieza | Monolito `operatorBrain.ts` desarticulado en módulos, shims de compatibilidad, tsc y suite completa. | ✅ Completado. 0 errores tsc, 204 tests verdes en 36 archivos. |

Commits: una unidad de trabajo por fase (código + tests + docs juntos).

---

## 6. Estrategia de verificación (lo que realmente se pide)

Cuatro niveles. **El nivel D (E2E real) es obligatorio**; los otros evitan depurar en la app.

### 6.1 Nivel A — Unit
- **A1 Fixtures de enunciados** (`fixtures/utterances.es.json`), incluir como mínimo:
  - `"Abre 3 terminales con Grok"` → open ×3 grok
  - `"abriera dos. Terminales, en ellas abrirá Grok y ejecute los test"` → open ×2 grok prompts ["ejecute los test"]
  - `"abrí dos terminales con claude y corré los tests"` (voseo)
  - `"levanta una consola de powershell"`
  - `"Sierra Orion"` / `"cierra la terminal 2"` / `"cierra todas"` / `"cierra las terminadas"`
  - `"léeme el resumen de la terminal 2"`, `"abre el navegador en github.com"`
  - Negativos: `"hola, ¿cómo estás?"`, `"abre la puerta"`, `"cierra sesión de gmail en el navegador"` (NO debe cerrar terminales).
- **A2 Sanitizador:** eco de system prompt, JSON crudo, inglés, markdown, texto > 280 chars, texto vacío.
- **A3 Esquema zod:** acciones inválidas (`count:0`, `count:50`, engine desconocido) → rechazo.
- **A4 composeReply:** snapshot de textos en español por combinación éxito/fallo.

### 6.2 Nivel B — Integración (vitest + jsdom, sin Tauri)
Montar un mini‑harness: `App` mínimo o stubs con listeners reales del `ui-bus` y un **registro de terminales falso** (`terminalRegistry` mockeado).
- B1 Receptor presente → open 2 terminales → 2 `sessionId` nuevos → recibo ok → reply "Abrí 2 …".
- B2 **Sin receptor** (no se monta CodeWorkspace) → ack timeout → recibo `ok:false` → reply "No pude abrir las terminales: la vista de código no respondió" + trace `ui.ack ok:false`.
- B3 Spawn concurrente x3 → 3 hojas distintas en el layout (regresión del bug de sobrescritura).
- B4 Verificación falla (ack ok pero registro no cambia) → reply honesto, `overallSuccess:false`.
- B5 Cierre por nombre ("Orion") y por índice; inexistente → mensaje claro.

### 6.3 Nivel C — Planner con proveedor falso (determinista)
Provider `FakeProvider` configurable que devuelve:
1. JSON válido correcto → plan `strategy:'llm'`.
2. JSON válido con `engine` desconocido → reintento → luego fallback explícito.
3. Texto plano en inglés → reintento → fallback heurístico, `fallbackReason` presente.
4. **Eco del system prompt** → detectado, descartado, nunca llega a `reply`/TTS.
5. Timeout → fallback con razón "tiempo agotado".
6. Respuesta con ```` ```json ```` fences y texto extra → parseo tolerante.
Aserciones sobre el **trace** (secuencia de eventos esperada), no solo el retorno.

### 6.4 Nivel D — E2E sobre la app real (Windows / WebView2) — OBLIGATORIO
Objetivo: replicar el accionar del usuario: abrir la app, escribir/dictar al operador, y **verificar por logs y por estado real** que se ejecutó.

**Harness** (`scripts/verify-operator-e2e.mjs`, añadir scripts en `package.json`: `"verify:operator:e2e"`):
1. Compilar/arrancar la app en modo debug con WebView2 remote debugging:
   `set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` y lanzar `npm run tauri dev` (o el exe de `src-tauri/target/debug`). Esperar a `http://127.0.0.1:9222/json/version`.
2. Conectar con **Playwright `chromium.connectOverCDP('http://127.0.0.1:9222')`** (añadir `@playwright/test` como devDependency; la skill `webapp-testing` del repo puede servir de referencia).
3. Forzar entorno determinista **vía localStorage / comando de test** antes de cada caso:
   - Proveedor = `local` para pruebas de heurística; proveedor = `fake` (endpoint HTTP local servido por el propio script en `127.0.0.1:<port>/v1/chat/completions` que devuelve JSON/eco/inglés/timeout según el caso) para pruebas del camino LLM. Se configura `opencodeBaseUrl` hacia ese servidor. **Así se prueba la ruta real de red/proxy de Tauri sin gastar créditos ni depender de un modelo.**
   - TTS desactivado o espía (`window.__ttsSpy`) para registrar lo que se habría hablado.
   - Limpiar traces del día (o usar `turnId` para filtrar).
4. Por cada caso del `cases.e2e.json`:
   - Navegar a un modo inicial (`chat` / `agent` / `code`) — **incluir `chat`**, que es donde fallaba.
   - Escribir en el input del operador (selectores estables: `data-testid="zed-input"`, `zed-send`, `zed-status`, `zed-tab-logs`) y enviar.
   - Esperar `turn.end` en el archivo `.jsonl` (poll con timeout 30 s).
   - **Aserciones verificables** (todas obligatorias):
     a. Trace: secuencia `turn.start → plan.created → action.* → action.verify ok:true → turn.end overallSuccess:true`.
     b. **Estado de UI real:** `document.querySelectorAll('[data-testid="terminal-pane"]').length` aumentó en N (añadir testid a los panes) y modo = `code`.
     c. **Estado de backend real:** el comando Tauri que lista sesiones PTY (`list_terminal_sessions` o equivalente; si no existe, exponer uno de solo‑lectura para tests) devuelve N sesiones nuevas con el engine esperado.
     d. Texto del `zed-status` y `__ttsSpy` == reply compuesto (en español, sin eco del prompt, sin JSON).
     e. Screenshot (`page.screenshot`) guardado en `e2e-artifacts/<caso>.png` para revisión humana.
   - Limpieza: cerrar terminales creadas.
5. Reporte final: tabla caso / estrategia / latencias / pass‑fail + ruta del trace → `docs/agent-orchestration/plan-3-e2e-report.md`.

**Casos E2E mínimos (`cases.e2e.json`):**
| ID | Modo inicial | Entrada | Provider | Esperado |
|---|---|---|---|---|
| E1 | chat | "abre dos terminales con grok y ejecuta los test" | local | +2 panes, modo code, 2 PTY grok, prompts inyectados |
| E2 | chat | "abriera dos. Terminales, en ellas abrirá Grok y ejecute los test" | local | idem E1 |
| E3 | agent | "abre una terminal con claude" | fake‑JSON | +1 pane claude, strategy `llm` |
| E4 | code | "cierra la terminal 2" | local | pane 2 cerrado y sesión PTY terminada |
| E5 | code | "Sierra Orion" (con agente Orion activo) | local | solo Orion cerrado |
| E6 | chat | cualquier comando | fake‑eco‑del‑prompt | **no** se habla/muestra el eco; fallback explícito `heuristic-fallback` con razón; estado "Falló/usé local" |
| E7 | chat | cualquier comando | fake‑inglés | idem E6 |
| E8 | chat | cualquier comando | fake‑timeout | mensaje de timeout en español, sin quedarse "pensando" |
| E9 | chat | "hola, ¿cómo estás?" | fake‑answer | respuesta conversacional sanitizada, 0 acciones, sin terminales nuevas |
| E10 | code | "abre 3 terminales con grok" ×2 seguidas rápido | local | +6 panes en total, sin sobrescritura |
| E11 | chat | comando con workspace sin proyecto seleccionado | local | error claro en español (no silencio) |

**Prueba de sabotaje (obligatoria, anti falsos positivos):** una corrida del harness con una variable `OPERATOR_SABOTAGE=no-listener` que desmonta el receptor de spawn; el harness **debe fallar** en E1 con `ui.ack ok:false`. Si pasa, el harness está mal.

### 6.5 Nivel E — Checklist visual manual (5 min, lo hace el humano al final)
- Widget flotante sin chips apilados; 1 línea de estado.
- Voz: dictar la frase de E2 con micrófono real; verificar en "Registros" el texto STT exacto y el plan.
- Confirmar que el sonido hablado coincide con lo mostrado y está en español.

---

## 7. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| WebView2 no expone CDP en build release | Usar build debug / variable de entorno solo en el harness; no tocar producción. |
| CLIs (grok/claude) cambian formato | `providers/cli.ts` aislado + tests con fakes; en producción la falla va a fallback explícito. |
| Regresión de otros consumidores de eventos DOM | Mantener eventos antiguos hasta F9; test que verifica que `subagentDispatcher` sigue funcionando. |
| Trace crece sin límite | Rotación diaria + retención 7 días en Rust. |
| Refactor grande rompe UI | Fases con gates; shim de re‑exports hasta F9. |

---

## 8. Definición de "hecho" (checklist final para el agente)

- [x] `npx tsc --noEmit` sin errores.
- [x] `npx vitest run` completo verde (incluye fixtures A1, integración B, planner C).
- [x] `npm run verify:operator:e2e` verde en E1‑E11 **y** la prueba de sabotaje falla como se espera.
- [x] Reporte `plan-3-e2e-report.md` con traces y screenshots adjuntos.
- [x] No existe ruta que hable/muestre texto de modelo sin `sanitizeReply`.
- [x] No existe fallback silencioso: toda degradación aparece en UI y en trace.
- [x] `operatorBrain.ts` monolítico eliminado; ningún archivo del operador > 400 líneas.
- [x] Todo texto visible en español.
- [x] Documentación actualizada: `docs/agent-orchestration/README.md` enlaza este plan.

---

## 9. Notas para el agente ejecutor
- Antes de tocar nada, lee: `docs/agent-orchestration/plan-2-kite-operator-assistant-and-tts.md`, `src/lib/operator/operatorBrain.ts`, `operatorProviders.ts`, `appOperatorController.ts`, `src/components/ZedStrip.tsx`, `src/components/code/CodeWorkspace.tsx` (listener `kite:spawn-agent-terminal`, `spawnQueueRef`), `src/App.tsx` (L421‑464), `src-tauri/src/operator_runtime.rs`.
- No cambies el esquema de layout (`WorkspaceLayout`, `PaneLeaf`, `splitLeaf`).
- Si una suposición de este plan no coincide con el código (p. ej. no existe `list_terminal_sessions`), **documenta la discrepancia en el reporte y elige la alternativa más simple verificable**, sin omitir la verificación.
- Si el trace de un caso falla, **primero lee el trace**, luego arregla; no hagas cambios por intuición.
