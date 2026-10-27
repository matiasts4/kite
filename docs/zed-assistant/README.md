# Asistente Zed (Kite Operator) — Centro de Documentación

Bienvenido a la documentación técnica del **Asistente Zed (Kite Operator)** de Kite Code. Esta carpeta reúne las especificaciones de arquitectura, diagnóstico de ejecuciones, sistema de voz y aislamiento de proyectos para desarrolladores y agentes de inteligencia artificial que trabajen en este subsistema.

---

## 📚 Documentos Disponibles

1. **[Guía de Auditoría e Inspección de Ejecuciones (`execution-and-diagnostics.md`)](./execution-and-diagnostics.md)**  
   Explica cómo se ejecutan los turnos del asistente, dónde se almacenan las trazas (memoria, sessionStorage y LevelDB en disco) y cómo un agente puede inspeccionar y diagnosticar cualquier ejecución mediante comandos CLI en segundos sin necesidad de DevTools.

2. **[Arquitectura de Voz e Interrupciones TTS (`tts-and-interruption.md`)](./tts-and-interruption.md)**  
   Detalla el pipeline de síntesis de voz con ElevenLabs Streaming, el sistema de épocas/generaciones para cancelación con latencia cero y cómo se evita que la voz robótica nativa del navegador se dispare al interrumpir al asistente.

3. **[Aislamiento y Contexto por Proyecto (`workspace-isolation.md`)](./workspace-isolation.md)**  
   Describe cómo el operador resuelve el workspace activo (`workspaceId`, `workspaceName`, `workspacePath`), filtra las terminales activas estrictamente para la ventana visible y evita cualquier contaminación o confusión entre proyectos diferentes.

---

## 🗺️ Mapa de Archivos del Código Fuente

| Componente | Archivo Principal | Responsabilidad |
|---|---|---|
| **Coordinador del Pipeline** | [`src/lib/operator/index.ts`](file:///E:/kite/src/lib/operator/index.ts) | Orquesta el turno: traza, planificación, ejecución, verificación y voz. |
| **Contrato y Esquemas** | [`src/lib/operator/contract.ts`](file:///E:/kite/src/lib/operator/contract.ts) | Tipos y esquemas Zod para `Turn`, `Plan`, `Action`, `Receipt` y `Context`. |
| **Planificador Heurístico** | [`src/lib/operator/planner/heuristic.ts`](file:///E:/kite/src/lib/operator/planner/heuristic.ts) | Fast-path determinista (< 2ms) para órdenes directas de voz y texto. |
| **Planificador LLM** | [`src/lib/operator/planner/llm.ts`](file:///E:/kite/src/lib/operator/planner/llm.ts) | Planificación mediante modelos de lenguaje para órdenes complejas. |
| **Prompt del Sistema** | [`src/lib/operator/planner/prompt.ts`](file:///E:/kite/src/lib/operator/planner/prompt.ts) | Prompt único del operador con few-shot examples y contexto de proyecto. |
| **Controlador de App** | [`src/lib/operator/appOperatorController.ts`](file:///E:/kite/src/lib/operator/appOperatorController.ts) | Controlador determinista de acciones sobre terminales y navegador. |
| **Ejecutor y Verificador** | [`src/lib/operator/executor/index.ts`](file:///E:/kite/src/lib/operator/executor/index.ts) | Ejecución secuencial de acciones y verificación de postcondiciones. |
| **Narrador TTS** | [`src/lib/operator/ttsNarrator.ts`](file:///E:/kite/src/lib/operator/ttsNarrator.ts) | Motor de síntesis de voz (ElevenLabs Streaming + fallback nativo). |
| **Reconocimiento de Voz** | [`src/lib/operator/voice/zedVoice.ts`](file:///E:/kite/src/lib/operator/voice/zedVoice.ts) | Captura de micrófono, streaming y transcripción STT con VAD. |
| **Trazas y Observabilidad** | [`src/lib/operator/trace/trace.ts`](file:///E:/kite/src/lib/operator/trace/trace.ts) | Bus de eventos y ring buffer en memoria de los últimos turnos. |
| **Componente Flotante UI** | [`src/components/ZedStrip.tsx`](file:///E:/kite/src/components/ZedStrip.tsx) | Orbe animado, controles flotantes y atajos de teclado del asistente. |

---

## ⚡ Comprobación Rápida de Salud

Para verificar que todos los subsistemas del operador funcionan correctamente:

```powershell
# 1. Ejecutar la suite completa de tests del operador (196 tests)
npx vitest run src/lib/operator

# 2. Comprobar tipado TypeScript estricto
npx tsc --noEmit

# 3. Comprobar auditoría y sanitización de referencias
node .kite/sanitizer/audit-references.mjs --check
```
