# Orquestación de Agentes, ODD y Asistente Operador en Kite Code

Este directorio contiene la arquitectura, análisis del estado del arte (incluyendo hallazgos de `gentle-shell` y ODD - Organic-Driven Development), y los dos planes de implementación ejecutables para **Kite Code**:

- **[Registro de fallos de Zed](./zed-fallos.md)** — protocolo para anotar malos turnos del operador y cerrarlos con utterances o evidencia.
- **[Handoff agente → terminal hija](./agent-handoff.md)** — buzón `.kite/inbox`, CLI `scripts/kite-agent.mjs` y entrega del cuerpo completo del archivo de tarea.
- **[OpenCode Go en Zed](./opencode-go-integration.md)** — contrato HTTP verificado, resolución de credenciales, sesión y catálogo; ACP documentado como opción futura.

## 📑 Documentos de Planificación

1. 📘 **[Plan 1: Orquestación ODD (Planner $\rightarrow$ Executor) y Sistema de Skills](./plan-1-odd-orchestration-and-subagents.md)**
   - Metodología ODD: paso de especificación por referencia (`.kite/tasks/<slug>.md`).
   - Handoff estructurado sin parafraseo lossy.
   - 3 Skills en `skills/`: `kite-odd-handoff`, `kite-subagent-executor`, `kite-odd-verify`.
   - Soporte en backend Rust (`terminal.rs` y `odd_tasks.rs`) para inyección de `initial_prompt`, `auto_approve` y flags CLI por motor (`grok`, `codex`, `claude`, `agy`, `opencode`).
   - Despacho desde el chat con un clic y comando `/delegate`.
   - Suite completa de tests en Rust y TypeScript.

2. 📗 **[Plan 2: Kite Operator (Asistente de Acciones Rápidas, Canales Multi-Proveedor y TTS)](./plan-2-kite-operator-assistant-and-tts.md)**
   - Operador de acciones rápidas sobre la app (abrir/cerrar $N$ terminales, inyectar prompts por stdin en caliente, abrir navegador).
   - Puente de contexto de sesiones (`SessionContextHub`): buffer limpio sin ANSI ni chrome para cada terminal y chat.
   - Síntesis de voz (TTS) para lectura de resúmenes en voz alta sin leer código crudo.
   - Canales multi-proveedor seleccionables: OpenCode Direct API (HTTP sub-500ms), Anti-Gravity (Suscripción Gemini Flash), Grok Build (Suscripción xAI) y Motor Local Heurístico (0ms).
   - Banco de pruebas y telemetría de latencia en milisegundos con tabla interactiva para optimizar velocidad y costo.
   - Barra de operador flotante (`KiteOperatorBar`) y suite completa de tests en Rust y TypeScript.

3. 📕 **[Plan 3: Reescritura y Verificación Real del Asistente Operador (Zed)](./plan-3-operator-rewrite-and-verification.md)**
   - Arquitectura desacoplada en capas (`contract`, `planner`, `providers`, `executor`, `verify`, `trace`, `config`).
   - Contrato formal con validación Zod y recibos obligatorios post-condición.
   - Eliminación de eco de prompts, respuestas en inglés no solicitadas y eventos DOM sin ACK.
   - Bus de UI con confirmación y sincronización de montaje de workspace.
   - Suite de verificación en 4 niveles (Unit A, Integración B, Planner C con mocks, E2E D con arnés real y sabotaje).
   - Reportes: [Línea base (F0)](./plan-3-baseline.md) y [Reporte de verificación E2E (F8)](./plan-3-e2e-report.md).

4. 🔮 **[Plan 4: Rediseño a Esfera Pura del Asistente Flotante y Conexión de Voz con Veloce](./plan-4-floating-orb-and-veloce-voice.md)**
   - Eliminación del cuadro de texto manual y pestañas; transición a esfera pura de 72px interactiva.
   - Micro-controles revelados al hover y pastilla de estado reactiva en español.
   - Sleep mode y optimización WebGL para resolver consumo excesivo de CPU/GPU y lag.
   - Integración con motor de voz local de alta velocidad (Veloce / faster-whisper, ruta configurable).
   - Configuración del Asistente dentro de la pestaña de Voz en Ajustes.



