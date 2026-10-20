# Plan 3 — F0: Línea Base de Pruebas y Diagnóstico

Fecha: 2026-10-18  
Estado: APROBADO (Fase F0 completada)

## 1. Estado de Pruebas y Compilación Inicial

- **TypeScript Typecheck (`npx tsc --noEmit`)**: 0 errores.
- **Suite del operador (Zed)**:
  - `src/lib/operator/operatorLog.test.ts` (3 tests) — PASA
  - `src/lib/operator/operatorCatalog.test.ts` (5 tests) — PASA
  - `src/lib/operator/operatorProviders.test.ts` (15 tests) — PASA
  - `src/lib/operator/operator.test.ts` (30 tests) — PASA
  - `src/components/ZedStrip.test.tsx` (4 tests) — PASA
  - **Total**: 57 tests verdes.
- **Suite Completa del Repositorio**: 30 archivos de test, 172 tests pasando.

## 2. Hallazgos del Sistema Anterior (Diagnóstico D1 a D7)

1. **D1 (Parafraseo y respuestas vacías)**:
   - Con el proveedor `local`, `queryOperatorLLM` emitía `Comando procesado localmente: ${prompt}`.
   - En llamadas a LLM, cuando la respuesta no era JSON válido, se devolvía el texto plano como `reply` pero con `actions: []`. El usuario escuchaba una confirmación sin que el sistema realizara ninguna acción en las terminales.
2. **D2 (Eco del System Prompt por TTS)**:
   - `callCliSubscriptionProvider` concatenaba el system prompt completo con la petición del usuario en los argumentos de invocación del CLI. Al retornar salidas truncadas o errores del CLI, trozos del prompt interno ("REGLAS CRÍTICAS", esquemas JSON) terminaban leyéndose en voz alta por el narrador TTS.
3. **D3 (Acciones no acopladas y falta de verificación)**:
   - La respuesta verbal y visual se generaba antes e independientemente de si la acción realmente se ejecutaba en el DOM o en los procesos PTY. No existía ningún chequeo posterior (postcondición) que confirmara si las terminales estaban vivas en el registro.
4. **D4 (Rutas de ejecución confusas / heurística vs IA)**:
   - Había 3 caminos de ejecución intercalados: fast-paths locales, llamada a provider remoto y fallback local silencioso dentro de catch. El usuario no tenía certeza de qué modelo o lógica procesó su instrucción.
5. **D5 (Monolito y acoplamiento excesivo)**:
   - `operatorBrain.ts` superaba las 800 líneas mezclando regexes, despacho, auditoría, formateo y control de estado. `operatorConfig.ts` acumulaba 35 KB mezclando configuración, datos de persona y métricas de latencia.
6. **D6 (Emisión de eventos DOM al vacío sin ACK)**:
   - `kite:navigate-mode` y `kite:spawn-agent-terminal` se disparaban con un `setTimeout(180ms)` sin confirmación de recepción (ACK), fallando cuando la vista `CodeWorkspace` no estaba montada en el ciclo de renderizado de React.
7. **D7 (Límite de argumentos y timeout rígido)**:
   - Invocaciones CLI de 15 segundos sin paso de prompt por archivo temporal ni control de buffers en Windows.

## 3. Plan de Acción Inmediato
Proceder a la **Fase F1 (Trace por Turno)** creando el subsistema de traza en `src/lib/operator/trace/` e implementando el comando Tauri en `src-tauri/src/operator_runtime.rs` para persistir eventos JSONL en disco.
