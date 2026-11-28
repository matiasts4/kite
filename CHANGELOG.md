# Changelog

All notable changes to **Kite Code** will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.96] - 2026-11-28

> Browser agentico, estabilidad de subagentes y sesiones ACP reanudadas

### Added
- Motor de browser agentico integrado in-process con WebView2 CDP, multiples pestanas por agente, herramienta MCP kite_browser, CLI kite browser, rol browser y cache semantico kite-ctx v3

### Fixed
- Bloqueo de replay de historial y notificaciones huerfanas al reanudar sesiones ACP (antigravity_acp, grok_pool y grok) para evitar respuestas previas duplicadas debajo del prompt en Agents y Threads
- Normalizacion de nombres de herramientas ACP en subagentes/fallback, manejo silencioso de timeouts parciales en wait, alineacion de conteo MCP (13 herramientas), limite <2KB en reglas dispatch y carga lazy en AgentsView

---

## [0.1.95] - 2026-11-27

> Runtime extensible de plugins, arranque lazy de sidecars y diagnostico de fallos

### Added
- Runtime extensible de plugins con soporte de manifiestos multi-formato, instalacion desde carpeta local, repositorio Git o archivo .zip, catalogo configurable por feeds, paneles Web UI de sidecars en RightDock, enlaces clicables sidecar:// en chat, integracion MCP/skills/reglas/perfiles de agente, MCP Apps sandboxeadas (ui://), hooks nativos de ciclo de vida y sidecars programados por cron.

### Changed
- Arranque bajo demanda (lazy) por defecto para sidecars Web UI (autoStartUiSidecars en false), inicializacion diferida del proxy loopback (2 workers Tokio solo cuando un sidecar esta activo), consulta diferida de MCP Apps al abrir el menu New tab y detencion automatica del sidecar al cerrar su ultima pestana en RightDock para reducir el consumo base de RAM.

### Fixed
- Persistencia de panics fatales en crash.log tambien en builds release y mejora del script update-and-launch.ps1 para limpiar bloqueos de WebView2 y lanzar la aplicacion en el escritorio interactivo del usuario.

---

## [0.1.94] - 2026-11-26

> Correccion de permisos ACP y cambio rapido entre modos

### Changed
- Reduccion drastica de latencia al cambiar entre Agent, Code y Thread mediante aislamiento con React.memo, callbacks estabilizados, carga diferida de subtabs y perfil/mente en AgentsView, fast-path sin reflow en ChatComposer, cache TTL en listConnections, cortocircuito en capas ocultas de useTranscriptMotion y agrupamiento memoizado en ThreadRoster.

### Fixed
- Correccion del flujo de permisos ACP (session/request_permission con params.toolCall, preservacion del tipo de id JSON-RPC, normalizacion camelCase/optionId y alcance de aprobacion por sesion) para evitar rechazos silenciosos en modo acceptEdits.
- Soporte para frames usage_update (used/size), preservacion de result.usage y stopReason en el adaptador persistente, y deduplicacion del fallback de transcript frente a llamadas call_* ya recibidas por ACP.

---

## [0.1.93] - 2026-11-26

> Optimizacion integral de RAM, daemons multiplexados, Hub MCP y Fast Lane nativo

### Added
- Motor Fast Lane nativo en Rust para API Keys oficiales y gateway OpenCode Go con herramientas de workspace sandboxeadas, cliente MCP HTTP/stdio, compactacion en 2 etapas y telemetria en tiempo real.
- Pools multiplexados compartidos para daemons persistentes (Antigravity ACP, OpenCode server y Grok ACP), Hub MCP HTTP/Stdio centralizado en kite-core, ProcessGovernor FIFO (limite configurable 1-8) y cierre inmediato de subagentes efimeros.

### Changed
- Reduccion del consumo base de RAM en Rust (-84% Private Bytes en pruebas aisladas) mediante stubs lazy de hilos (LRU de 8), aislamiento SQLite del daemon, compactacion unica de bloat legado, code-splitting de arranque (780 kB) y ventana inicial de 48 filas en AgentChatShell.

### Fixed
- Eliminacion de fugas de referencias LRU en chat, liberacion de workers de diff y canvas de terminal ocultos con tope DPR 1.5, cierre de WebViews secundarios por workspace inactivo y limpieza de listeners/timers en segundo plano.

---

## [0.1.92] - 2026-11-26

> Correcciones en Automated Routines y navegación de modos

### Fixed
- Botón Back, Escape y cambio de modo desde Automated Routines a Agent/Code/Thread, con estado activo en el sidebar.
- Migración automática del ID legacy de la rutina inicial a UUID válido para pausar/reanudar sin errores ni mensajes [object Object].
- Barra de filtros y Actionable only alineados sin solapamientos, acciones del footer visibles, eliminación de '+ +' en New routine y SelectMenu en editor de rutinas.

---

## [0.1.91] - 2026-11-26

> Modo Agent simplificado, aislamiento estricto con Thread y translucidez uniforme

### Changed
- Modo Agent en 2 filas limpias: se ocultó la barra de módulos durante el chat detrás del botón `Edit` (`Back to chat` para volver), se eliminó el switch `Chat | Terminal` en agentes conversacionales y se movieron `Open in Thread` y `Auto` al riel de pestañas.
- La tira `Teammate inbox` solo se muestra cuando el agente tiene mensajes reales o errores de carga, liberando espacio vertical en chats activos.
- Translucidez uniforme en Agent (`backdrop-filter: none` sobre `StageBackdrop`) para alinear la apariencia vidrio con los modos `Code` y `Thread`.

### Fixed
- Aislamiento estricto entre `Agent` y `Thread`: enviar mensajes o abrir nuevos chats de agente permanece en modo `Agent`, evita mutar `save_thread_grid` y bloquea la adopción silenciosa de `profileId` ajeno tanto en frontend como en backend SQLite (`load_thread` y `load_agent_chat_thread`).
- Corrección visual de los botones `Open in Thread` y `Routines` (sin restricción cuadrada fija) y limpieza de encabezados de contrato Markdown (`## Job`, `## Sources`, etc.) en el subtítulo del sidebar.

---

## [0.1.90] - 2026-11-26

> Plataforma Agents v3 funcional y especialistas Ship Guard y Discovery Architect

### Added
- Skills vinculables desde .agents/skills/ y raíces globales con gating de requisitos (requires), flags manual-only/context: fork y captura directa desde chats.
- Nuevo comando kite_thread launch para abrir Threads de primer nivel (con worktree y orquestador) desde un agente, menciones @agente en Thread mode y tabs visibles en Agents.
- Broker interactivo de aprobaciones con botón Always allow, hooks deterministas PreToolUse con bloqueo exit 2 (políticas y verificación clean-room) y Readiness Score de 8 pilares.
- Skill manual pre-push-cleanroom-gate y plantillas especializadas Ship Guard y Discovery Architect sobre Antigravity con instalación idempotente.

### Fixed
- Playbooks reales sin stub de Antigravity (espera de cierre, waves paralelas y worktrees), triggers de eventos y quiet ticks HEARTBEAT_OK en Routines, y ejecución .cmd en Windows para AutoPilot.

---

## [0.1.89] - 2026-11-25

> Asistente Argos: persistencia confiable del proveedor y limpieza automática de caché

### Fixed
- Limpieza automática no destructiva de cachés heredadas de hilos en `localStorage` (`>200 KB` al iniciar y recuperación progresiva en 3 fases ante `QuotaExceededError`) sin afectar configuraciones, temas, favoritos ni credenciales.
- Persistencia desacoplada entre `localStorage`, la bóveda SQLite (`operator_settings_json` con `updatedAtMs` monotónico y guardia contra condiciones de carrera) y eventos en vivo, evitando que cambiar el proveedor a Antigravity (`gemini-4-hydrogen-low`) vuelva a OpenCode.

### Changed
- Indicador completo de proveedor y modelo activo en la tarjeta superior de Ajustes del asistente (`Antigravity · <modelo>`, `Grok · <modelo>` y `Local · Heurístico`).

---

## [0.1.88] - 2026-11-25

> Modo de voz: errores claros de proveedor, dictado en vivo estable y teleprompter sin parpadeos

### Fixed
- Avisos claros cuando el proveedor del asistente rechaza una solicitud por permisos o suscripción (HTTP 401/403), preservando el detalle sin descartarlo por incluir URLs y alineando la migración del vault hacia gemini-4-hydrogen-low.
- Transcripción en vivo más fluida y sin reescrituras hacia atrás mediante normalización por palabra, estabilizador monótono de prefijo (LiveTranscriptStabilizer), prioridad estricta de streaming STT frente a WebSpeech/rolling WAV y scroll automático inferior en el compositor.
- Estabilización con histéresis en el panel superior del teleprompter para eliminar los cambios rápidos al iniciar la sesión de voz y mantener el indicador estable en Argos.

---

## [0.1.86] - 2026-11-25

> Modo de voz: escenario atmosférico, teleprompter editorial y transcripción en vivo

### Added
- Rediseño visual del Modo de Voz con escenario atmosférico en todo el panel, orbe cinético con retícula orbital, cinta acústica reactiva (VoiceWaveRibbon), teleprompter traslúcido editorial con karaoke y cápsula de entrada con haz de borde animado.

### Fixed
- Corregida la transcripción en vivo del usuario en modos Cascaded y Realtime: resolución de IDs de micrófono WebView2 a nombres WASAPI, VAD nativo más sensible (0.008 RMS) y previews cloud continuos mediante captura WAV no destructiva (voice_audio_snapshot_wav).
- Acumulación incremental de deltas de transcripción en Realtime (xAI, OpenAI y Gemini Live), aislamiento de eventos input_audio_transcription fuera de la respuesta del agente y visibilidad continua del texto del usuario (live-user-echo) y estado "Transcribiendo tu voz" en el teleprompter.

---

## [0.1.85] - 2026-11-25

> Personalización: selector de color integrado, figuras reactivas y fondos 2K

### Added
- Rediseñadas las 6 figuras de portada y la marca de agua con animaciones de saludo al abrir chat, reacciones al interactuar, seguimiento sutil del puntero y estado atento al escribir, respetando movimiento reducido y ventana minimizada.
- Renovados los fondos de escenario y atmósfera en 2K: nuevos Crepúsculo Alpino invernal, Horizonte de Eventos, Claro de Luna sobre océano abierto, Tokio Sakura, Pradera Celeste, Nebulosa Astral y Bosque de Niebla, conservando Horizonte Solar y Aurora Boreal.

### Changed
- Migrados los selectores tipográficos de Personalización al componente unificado SelectMenu y actualizadas las descripciones y miniaturas de la galería de escenarios.

### Fixed
- Reemplazado el selector de color nativo en Personalización por un popover integrado (ColorPickerPopover) con paleta, código hexadecimal y sincronización en vivo del indicador de actividad de agentes en cabeceras, turnos y enjambres.

---

## [0.1.84] - 2026-11-25

> Motor de contexto kite-ctx v0.2, búsqueda FTS5/BM25 y monitor renovado

### Added
- Contabilidad neta real en kite-ctx v0.2.0 (ahorro bruto menos recuperaciones CCR, excluyendo hits falsos de caché) y búsqueda indexada FTS5/BM25 por fragmentos con límite de 16K caracteres.
- Caché de comandos inmutables en git (tool_cache aislado por directorio y worktree), congelación KV por lotes en el historial de hilos (assemble_thread_context) y auditor estático Turn-0 (kite ctx audit --fix).
- Monitor de Contexto renovado en el popover de recursos con desglose neto/bruto, grilla de salud del motor (Caché real, KV Prefix Hits, CCR FTS5 y Tool Cache), tarjeta de Auditoría Turn-0 e IPC refresh_context_monitor.

### Changed
- Hooks fail-open de Windows optimizados con fast-path directo al binario en AppData (Kite Code/bin/kite.exe), apertura SQLite acelerada con PRAGMA user_version = 2 y caché de escaneos del host de 30s.

### Fixed
- Corregida fuga de stderr/Error en vitest con código de salida 0, truncamiento con preservación de errores finales en build/playwright/docker, seguridad UTF-8 en reescritura 2>&1 y exclusión de comandos gh/docker interactivos o streaming.

---

## [0.1.83] - 2026-11-25

> Modo de voz inmersivo, teleprompter sincronizado y arquitectura Talker multi-proveedor

### Added
- Anillo concéntrico y resplandor ambiental WebGL reactivo al volumen de voz y paleta activa en el compositor.
- Teleprompter acoplado con efecto vidrio esmerilado, animación de entrada/salida, karaoke sincronizado por audio a 60 fps y selector de velocidad 0.75x a 2.0x.
- Adaptadores Speech-to-Speech multi-proveedor en Rust (xAI Realtime, Google Gemini Live y OpenAI Realtime) con delegación asíncrona al Thinker y fallback automático a modo cascada.
- Auto-pausa configurable por inactividad para proteger cuota de audio, vaciado de silencio en mute y telemetría de segundos de stream.
- Tarjeta post-llamada con resumen asíncrono en español, visor completo de transcripción en RightDock y selector de 9 voces con paletas de color.

### Fixed
- Eliminados avisos falsos de silencio en modo voz continuo y corregido el montaje diferido de RightDock al abrir transcripciones.

---

## [0.1.82] - 2026-11-25

> Correccion de escucha nativa WASAPI, VAD adaptativo y barge-in en Argos

### Added
- Conectado el streaming STT nativo en Rust (voice:stt-partial y voice:stt-final) con pre-roll de 400 ms y fallback automatico a WAV.

### Fixed
- Corregida la deteccion de voz (VAD), endpointing automatico por silencio y transcripcion en el motor de captura nativa Rust WASAPI (cpal).
- Restaurado el barge-in acustico continuo con captura WASAPI persistente entre turnos, control de mute nativo y audio ducking.

---

## [0.1.81] - 2026-11-25

> Mejoras de contraste, bordes, uniformidad visual y barra superior translucida

### Changed
- Jerarquia de bordes y contraste renovada (--glass-border, --glass-card-border, --glass-inner-border, --glass-field-bg) con calibracion dedicada en modales y modo claro/oscuro.
- Selector superior Agent | Code | Thread adaptado al patron translucido consciente de tema y modo vidrio preservando su geometria y animacion.
- Diseno unificado entre Configuraciones, Plugins, Rutinas (con modo embebido) y vistas secundarias eliminando dobles marcos, alturas/radios arbitrarios y colores fijos de modo oscuro.

### Fixed
- Preservada la elevacion de superficies (--pane, --composer, --menu-plate) y --accent-fill solido en packs de temas, corregidos textos de error (--danger-ink) y el token --warning-text en Changelog.

---

## [0.1.80] - 2026-11-25

> Voice Mode v2 nativo y Realtime, Argos Assistant v2 y Agentes Autonomos v2

### Added
- Motor de voz v2 de baja latencia: split inmutable de cache KV (messages[0]), poda dinamica de herramientas por intencion, routing hibrido L0/L1/L2, pre-captura especulativa y HUD de latencia TTFA/cache en Ajustes.
- Streaming TTS persistente por WebSocket (stream-input) con fallback automatico y barge-in atomico menor a 50 ms, captura nativa Rust WASAPI (cpal) con STT offline local (Whisper/Parakeet) y modo opcional full-duplex Realtime 24 kHz.
- Configuracion unificada de Audio, Voz y Dictado con recibos persistentes post-llamada (voice-calls/*.json) e historial desplegable en Ajustes de Argos.
- Argos Assistant v2 con alcance total sobre el workspace: manage_tasks, control_subagent, coordinate_swarm, manage_routines, manage_memory, read_diff, run_check y navigate_view, planes consultivos multipaso y atajo global del sistema operativo.
- Plataforma de Agentes Autonomos v2: AutoPilot con LLM multi-proveedor para hilos y terminales con Verification Gates, herramientas kite_tasks/kite_ctx/kite_diff con politicas por agente, Knowledge Packs bajo demanda, rutinas por eventos con historial SQLite, Playbooks multi-agente, auditoria de herramientas y bundles portables.

### Fixed
- Eliminada la doble narracion TTS al transmitir por cola de streaming, corregido el truncado de observaciones ReAct con sobres estructurados kite-ctx y ampliada la cobertura E2E de Voice Mode.

---

## [0.1.79] - 2026-11-22

> Argos: asistente de voz consultivo unificado, streaming STT, kite-ctx y Companion Bar

### Added
- Unificacion del asistente de voz bajo Argos (Opcion A): sesion continua compartida entre el Stage y Footer de Thread y Agent, la capsula flotante ArgosStrip en Code y la nueva barra global ArgosCompanionBar (Alt+Space).
- Cerebro consultivo multi-turno con herramientas rapidas de inspeccion (peek_changes, peek_runs, peek_agents, peek_files, recall_conversations), tarjeta interactiva ConsultativeDraftCard (Confirmar, Refinar, Cancelar) y ejecucion DAG paralela.
- Compresion de contexto de voz con kite-ctx (< 250 tokens), alineacion de cache KV sin marcas de tiempo relativas y handoffs comprimidos <<ccr:HASH>> para subagentes.
- Streaming STT por WebSocket con parciales palabra por palabra, deteccion de clausulas abiertas en espanol (1950 ms), ventana manos libres anti-eco (180 ms) y rampa de barge-in de 20 ms con truncado exacto a lo escuchado.

### Fixed
- Orden cronologico real de tarjetas de subagentes e items de voz en el timeline del hilo (createdAtUnixMs y completedAt), deduplicacion de recibos spawn_subagent y diagnostico WASAPI de privacidad de microfono en Windows.

---

## [0.1.78] - 2026-11-21

> SETH orquestador conversacional con retorno de subagentes y captura VAD sin silencio

### Added
- Orquestador conversacional SETH con hilo de voz anclado y subagentes exploradores en solo lectura (explore vs odd/execute), reservando launch_thread para pedidos explicitos de hilo aparte.
- Lazo cerrado de retorno de subagentes (subagentReturnWatcher): al terminar un subagente hijo lee su salida real via dispatch_read, guarda hallazgos y los narra por voz respetando VoiceTurnArbitrator y barge-in.
- Memoria viva rodante de sesion larga (WorkingContext) por hilo de voz con tema actual, decisiones acordadas, hallazgos de subagentes y compactacion automatica de turnos antiguos mas alla de la ventana de 8 turnos.
- Lectura real de resultados de subagentes e hilos en narrate_summary (incluyendo consultas como "como va el subagente" o "que encontro el explorador") y hallazgos visibles en el roster del proyecto.

### Fixed
- Compuerta de captura PCM por VAD en modo de voz continuo con pre-roll de 400 ms y recorte de silencio final a 250 ms para evitar acumular silencio en RAM y facturar tiempo vacio en STT.

---

## [0.1.77] - 2026-11-21

> Nuevos fondos cosmicos de escenario y mejora de Aurora Boreal

### Added
- Nuevos fondos de escenario cosmicos: Horizonte de Eventos (agujero negro con disco de acrecion luminoso) y Claro de Luna (luna sobre oceano nocturno estrellado).

### Changed
- Renovado el fondo Aurora Boreal con cintas organicas luminosas sobre fiordo nordico reflejado en el agua.

### Fixed
- Permitida la invocacion directa del generador de imagenes integrado en Thread Mode dentro del hook de subagentes.

---

## [0.1.76] - 2026-11-20

> Modo de voz SETH: barge-in real, streaming de baja latencia e inteligencia contextual

### Added
- Barge-in acustico real durante la narracion TTS con captura AudioWorklet persistente, buffer pre-roll de 400 ms, VAD adaptativo por piso de ruido y arbitraje de turnos sin solapamientos ni reinicios cada 8 segundos.
- Streaming HTTP nativo en Rust con cliente pooled keep-alive (proxy_operator_http_stream), streaming LLM a TTS por oraciones en turnos conversacionales y telemetria completa de latencia de voz (vad, stt, llm.first_token, tts.first_audio).
- Conciencia estricta del workspace activo (terminales, hilos, subagentes y agentes autonomos sin fugas entre proyectos), memoria episodica persistente por workspace y recuperacion temporal para consultas entre sesiones.
- Normalizador fonetico STT en espanol, polaridad mixta por clausula, matriz de superficies hilo/subagente/agente/terminal y desambiguacion activa con maximo una pregunta concreta antes de delegar.

### Fixed
- Prosodia hablada limpia sin UUIDs, rutas de disco, URLs ni muletillas de plantilla, identidad SETH conectada al planner y preservacion de metricas tokenCounts en trazas y runLedger.

---

## [0.1.75] - 2026-11-20

> Envio instantaneo en Voice Mode, soporte en Agentes y sesion fijada al hilo

### Fixed
- En Voice Mode, el mensaje hablado aparece al instante como burbuja del usuario y limpia el cuadro de texto mientras el asistente piensa, evitando que parezca congelado durante respuestas largas.
- Fijado el hilo destino y el modo thread antes de invocar al planner para que las respuestas nunca se descarten si cambia la vista o se finaliza la sesion en curso.
- Soporte completo de turnos de voz, estado en vivo y envio hibrido en AgentChatShell (modo Agentes), y tecla Escape acotada solo al orbe flotante visible para no cerrar Voice Mode en hilos.

---

## [0.1.74] - 2026-11-20

> Estabilidad de Voice Mode, resumen hablado completo y delegacion ODD-first

### Added
- Orquestacion conversacional en Voice Mode con memoria por hilo y delegacion ODD-first a hilos, subagentes reales (dispatch_run) y agentes autonomos con recibos clicables en la conversacion.

### Changed
- Resumenes hablados concisos separados de los recibos tecnicos detallados, presupuesto del planner ampliado a 1400 tokens y recorte de resumenes en limites de oracion.

### Fixed
- Estabilidad de entrada y ciclo de vida en Voice Mode con corte automatico por silencio basado en energia RMS (VAD), manejo limpio de errores fatales de STT, respeto de microfono silenciado al rearmar, cierre limpio de sesion y eliminacion del orbe WebGL oculto duplicado.
- Eliminado el corte de narracion por tiempo en sintesis nativa, corregido el fallback automatico de ElevenLabs a voz nativa y resuelto el falso positivo del filtro de eco en respuestas conversacionales.

---

## [0.1.73] - 2026-11-20

> Refinamiento visual de burbujas, acciones flotantes y densidad glass en Thread

### Changed
- Estilo mate 3D sutil casi solido para burbujas de mensajes del usuario consistente en modo oscuro, claro y glass.
- Mayor densidad glass en el compositor, selector de modelo, tiras de archivos modificados y contexto, y tarjetas de subagentes en chat y RightDock.

### Fixed
- Reubicacion y placa esmerilada legible para acciones de mensajes del usuario junto con menu popover vertical estructurado para Edit from here.

---

## [0.1.72] - 2026-11-19

> Indicadores configurables de actividad de agentes y color

### Added
- Indicadores de actividad de agentes seleccionables en Configuracion -> Apariencia con 8 estilos geometricos (Matriz neural, Barras activas, Pulso sereno, Cometa Kite, Grilla 3x3, Pulso en linea, Anillo fluido y Flujo activo) y vista previa compacta en vivo.
- Selector de color configurable para el indicador de actividad con sincronizacion automatica al acento del tema, paleta rapida y color hexadecimal personalizado.

### Changed
- Reemplazo de la orbita anterior por Matriz neural como indicador predeterminado y soporte de animacion reducida en todas las variantes.

---

## [0.1.71] - 2026-11-19

> Optimizacion de contexto Fase 1: filtros sin fugas y Auto-CCR

### Added
- Techo universal Auto-CCR (16,000 chars) en comandos de kite-ctx que conserva cabecera, errores intermedios, cola y recuperacion <<ccr:HASH>>.

### Changed
- Filtros mejorados para git grep/rg (reparto por archivo + CCR), git diff/show (plegado de lockfiles y stat-first), git status por carpetas y cargo check/build con warnings deduplicados.

### Fixed
- Resolucion compartida de subcomandos con flags globales (npx --prefix, npm --prefix, git -C/-c, cargo --manifest-path) y omision de hooks en git -C commit.
- Descubrimiento de sesiones Antigravity en profundidad 4 con deteccion de reescrituras por hook, y atribucion de agentes en hilos por rol sin exponer titulos de usuario.

---

## [0.1.70] - 2026-11-19

> Estabilidad de subagentes, streaming fluido y eliminacion de consolas externas

### Changed
- Streaming de chat mas fluido con coalescencia de deltas a 24 ms, texto suavizado y mejoras en el renderizado del hilo y tarjetas de subagentes.

### Fixed
- Eliminacion de ventanas externas de consola en Windows al generar borradores de agentes mediante hidden_exec::run.
- Limpieza deterministica de arboles de procesos descendientes con Job Objects en hidden_exec::run para evitar procesos huerfanos y bloqueos de pipes.
- Aislamiento de pruebas unitarias del backend Rust para evitar ejecuciones reales de CLIs externas durante cargo test.
- Recuperacion y reconciliacion mas robusta de turnos y subagentes interrumpidos, paginacion completa de eventos y limpieza de estado tras errores.

---

## [0.1.69] - 2026-11-19

> Optimizacion profunda de memoria RAM, GPU y recursos en reposo

### Added
- Figuras interactivas de 8 modos en WebGL2 para Modo Voz y Asistente Zed con miniaturas PNG pre-renderizadas de bajo consumo.

### Changed
- Optimizacion integral de RAM y persistencia SQLite en Rust: eliminacion de duplicacion permanente del estado en memoria, guardado incremental solo de hilos modificados, checkpoint de WAL acotado y lecturas directas en el daemon sin cargar historiales de chat.
- Code-splitting y carga diferida de vistas de diffs, Mermaid, modales frios, monitor de recursos y Zed Strip, con pool unico compartido de workers de diffs, eliminacion de importaciones muertas de xterm y reduccion de iconos estaticos.
- Reduccion de capas GPU y compositor eliminando doble blur en fondos, sustituyendo backdrop-filter permanente en paneles por superficies tintadas, suspendiendo capas de modos inactivos y reemplazando miniaturas pesadas en Personalizaciones.
- Ajuste del pool persistente de sesiones con limite mas acotado, limpieza deterministica de arboles de procesos mediante Job Objects en Windows y limites acotados para historial de eventos y comandos.
- Externalizacion de vistas previas base64 de adjuntos con lectura bajo demanda y cache LRU, limpieza de adjuntos al enviar, resumenes livianos sin items en localStorage y limites LRU en cachés de hilos, archivos y git diffs.
- Optimizacion de memoria en terminal con cache LRU acotada sin clonado por frame de filas sin cambios, scrollback por defecto ajustado y runtime Tokio acotado en el daemon.

### Fixed
- Eliminacion de ciclos de polling y despertares en reposo en notificaciones, buzon de agentes, ejecuciones activas compartidas, panel derecho oculto, bucle TCP bloqueante de dispatch y planificadores reutilizables de terminal.

---

## [0.1.68] - 2026-11-18

> Plataforma autonoma de agentes, auto-scroll estable y mejoras visuales en Thread

### Added
- Plataforma autonoma de agentes multi-proveedor con enlace real de workspace y Places, memoria dinamica, user.txt compartido, indice incremental de hilos, creacion y edicion con borrador por IA, habilidades con telemetria y tarjetas de reflexion post-turno.
- Herramientas CLI y MCP de agente (kite_thread, kite_memory, kite_routine, kite_teammate) con control de permisos y plugins, resolucion de perfiles entre los 7 proveedores, activacion en frio por mensaje, rutinas en segundo plano, AutoPilot multi-turno e inbox con enlaces directos.

### Changed
- Tarjeta ChangedFilesCard acoplada al borde superior del compositor con despliegue hacia arriba e icono de microfono alineado opticamente en la barra de entrada.

### Fixed
- Auto-scroll continuo en vivo y seleccion estable de texto sin saltos ni reinicios al arrastrar en Thread, Agent Chat, inspector de subagentes y Swarm Board.
- Superficies opacas en selector de subagentes, vista previa del riel lateral y monitor de recursos sin filtracion de fondo, junto con silencio de avisos y sonidos al terminar subagentes y workers.

---

## [0.1.67] - 2026-11-18

> Inspector compacto de subagentes, organizacion lateral y estabilidad MCP

### Changed
- Reestructuracion compacta del inspector de subagentes en RightDock (header fijo en 2 filas, selector desplegable SubagentRunSwitcher con buscador, Task Brief a ancho completo, Jump to latest sin solapamiento y agrupacion de fallos vacios).
- Organizacion de subagentes en la barra lateral izquierda con resumen nativo de ejecuciones activas, indicador orbital limpio, toggle persistente, sincronizacion de resaltado y limite de 3 filas con +N more.
- Modelo predeterminado de subagentes configurado a gemini-4-hydrogen en Antigravity con configuracion editable desde Ajustes, enlace de workspace y Places en AgentsView, y preservacion de instrucciones de repositorio en modo Agents.

### Fixed
- Separacion de llamadas spawn frente a wait/read/send para eliminar tarjetas repetidas o fantasma con auto-reparacion de hilos persistidos, esquema PreToolUse compatible por agente, timeouts acotados en kite dispatch mcp (120s/150s) y reduccion de polling en dispatch_audit.

---

## [0.1.66] - 2026-11-18

> Plugin unificado kite-dispatch, MCP de subagentes y mejoras en Thread

### Added
- Servidor MCP nativo (kite dispatch mcp) con herramientas kite_subagent_run, kite_subagent_send, kite_subagent_wait, kite_subagent_read y kite_swarm, interceptor PreToolUse/BeforeTool (kite dispatch hook-subagent) y regla concisa rules/AGENTS.md sin skills sueltas.
- Delegacion paralela de multiples subagentes (--task repetible, --count y batch members en Swarm) y envio de tareas de seguimiento sobre subagentes existentes (kite dispatch send thread:<id> --wait) con tarjetas nativas en Thread y RightDock.

### Changed
- Ruteo unificado de subagentes y workers hacia el tier de modelos livianos (defaultDelegation -> stack -> modelo rapido) con limite seguro de effort y migracion de roles de ejemplo a command: auto.

### Fixed
- Supresion de avisos internos duplicados (wait --children all|any, internalDispatch), recuperacion de subagentes e hilos interrumpidos, y correccion de tablas Markdown en Thread (ancho en paneles amplios, columnas laterales y saltos <br>).

---

## [0.1.65] - 2026-11-18

> Hooks obligatorios de contexto, compresión in-process y proxy MCP

### Added
- proxy stdio ligero `kite ctx mcp-proxy` para comprimir respuestas extensas de servidores MCP sin demonios HTTP adicionales, junto con el auditor `kite ctx discover` y filtros declarativos personalizados (`.kite/ctx-filters.json`).

### Changed
- Hooks y plugins obligatorios (`PreToolUse`, `BeforeTool` y plugins nativos) en `kite ctx init` para Antigravity, Claude Code, Codex, Gemini CLI, Cursor, OpenCode y Copilot, con soporte para cadenas de comandos compuestas (`&&` y `;`) en `kite ctx hook-rewrite`.
- Compresión automática in-process en el runtime de Kite para historiales de conversación largos (`runtime:thread_history`) y handoffs de subagentes (`runtime:subagent_handoff`), preservando anclas de inicio/cierre y referencias reversibles `<<ccr:HASH>>`.

---

## [0.1.64] - 2026-11-18

> Motor de contexto kite-ctx, integracion multi-agente y ahorro por funcionalidad

### Added
- Motor modular de optimizacion de contexto en Rust puro sin dependencias ML (kite-ctx) con compresion sin perdida, compresor tabular JSON, deduplicacion de lecturas por sesion, recuperacion reversible CCR, handoffs compartidos y alineacion KV-cache.
- Comandos CLI kite ctx (read, exec, compress, retrieve, share, stats, init, hook-rewrite, kv-check) e instalacion automatica de hooks y skills en todos los agentes locales con atribucion de sesion, agente, proveedor, modelo y proyecto.
- Nueva pestana Contexto en el Monitor de Recursos con ahorro acumulado y por sesion, cuota preservada, desglose por agente, modelo, canal y por funcionalidad, mas acceso directo desde Resumen.

---

## [0.1.63] - 2026-11-17

> Recuperacion de turnos congelados en Antigravity, curado de errores post-respuesta y tarjetas unicas de subagente

### Changed
- Conservacion del identificador de conversacion durante el turno activo frente a cambios de cuenta y guardia contra cierre prematuro mientras haya subagentes o comandos en segundo plano en ejecucion.

### Fixed
- Recuperacion automatica de turnos de Antigravity desde su transcripcion en disco cuando se corta stdout tras errores transitorios, liquidando herramientas previas interrumpidas y podando en vivo el aviso de inactividad.
- Adopcion unica de subagentes para evitar tarjetas duplicadas por delegacion, lectura legible de reportes estructurados JSON y envoltura de chips en el inspector lateral.
- Curado idempotente de desconexiones posteriores a respuestas ya entregadas, limpieza de fallos previos al iniciar o completar turnos y recicle limpio de sesiones persistentes tras errores de red.

---

## [0.1.62] - 2026-11-17

> Entrega completa de imagenes adjuntas a agentes, cola FIFO persistente mientras trabaja el agente y asociacion de carpetas en Thread

### Added
- Miniaturas de previsualizacion para imagenes adjuntas en el compositor, el historial de mensajes y la cola de ejecucion, ademas de traspaso automatico de adjuntos desde borradores en Agent Chat.

### Changed
- Tarjetas de mensajes en cola ancladas sobre el compositor con edicion en el lugar conservando el borrador actual, envio inmediato (Send now / Steer) y control desplegable de elementos.

### Fixed
- Entrega real de imagenes pegadas y archivos adjuntos a todos los agentes conectados mediante resolucion de ruta en disco, inferencia MIME, banderas de archivo y soporte de turnos con solo imagenes.
- Cola persistente de mensajes enviados mientras el agente trabaja (QueuedRunsControl) sincronizada entre cambios de conversacion en Thread y Agent Chat, con despacho automatico FIFO al terminar el turno.
- Asociacion explicita de conversaciones a carpetas de proyecto, generacion automatica y regeneracion de titulos de conversacion, y agrupacion unificada en tiempo real de ejecucion de herramientas.

---

## [0.1.61] - 2026-11-17

> Translucidez global en 4 niveles, terminales cristalinas, transicion Code-Thread fluida y Settings en espanol

### Added
- Sistema reutilizable de vidrio esmerilado en 4 niveles (--glass-*) con adopcion global en Sidebar, Files, Diffs (incluido Shadow DOM), Settings, Quotas, Notificaciones, Composers, Modales y Popovers.
- Terminales translucidas en GhostGrid 2D mediante contexto alfa y limpieza selectiva sobre paneles esmerilados en modos Code y Agent.

### Changed
- Interfaz de Agent armonizada visualmente con Thread y traduccion completa al espanol en Customizations, Settings y Plugins.
- Limpieza de presets de wallpaper descartados y superposiciones SVG para mejorar el contraste sobre Aurora Mesh, Alpine Dusk y Solar Horizon.

### Fixed
- Transicion fluida entre Code y Thread conservando la posicion de scroll y dimensiones exactas sin doble parpadeo ni saltos al inicio de la conversacion.
- Fluidez de scroll en hilos largos eliminando animaciones continuas de fondo, desenfoques anidados en listas y mediciones sin throttle en ThreadTurnRail.

---

## [0.1.60] - 2026-11-17

> Wallpapers en alta resolucion, paneles con translucidez real y figuras tematicas en vistas activas

### Added
- Seis wallpapers tematicos en alta resolucion (1920x1080) integrados en StageBackdrop y en las previsualizaciones de Customizations (Aurora Mesh, Alpine Dusk, Solar Horizon, Cyber Prism, Architect Grid y Editorial Paper).
- Ilustraciones y figuras tematicas (ThemeHeroFigure) integradas en los estados iniciales de Thread, Agent y el dock de Subagentes.

### Changed
- Translucidez real de vidrio esmerilado en todos los paneles principales, chat central, inspector de subagentes, tarjetas y composer para que el fondo se aprecie a traves de toda la interfaz y no solo entre bordes.
- Activacion automatica de superficies translucidas al usar cualquier escena de fondo con opacidad predeterminada al 56% (ajustable de 15% a 95%) y atenuacion optimizada al 14%.

---

## [0.1.59] - 2026-11-16

> Temas visuales multicapa, fondos de escenario, vidrio esmerilado y mejoras de interfaz

### Added
- Sistema de temas visuales multicapa con paquetes de tema, fondos de escenario, figuras decorativas, efecto de vidrio esmerilado y control de contraste.
- Paleta daltonizada para diffs, sincronizacion cromatica en el canvas de terminal y panel de personalizacion con importacion y exportacion de perfiles.

### Changed
- Mejoras en el visor de diffs de columna unica y nuevos iconos orbitales de estado para agentes y subagentes laterales.
- Persistencia optimizada del modo de trabajo seleccionado al iniciar la aplicacion.

---

## [0.1.58] - 2026-11-16

> Estabilidad en Thread sin congelamientos, persistencia diferencial y sincronizacion de subagentes

### Changed
- Activado SQLite WAL con synchronous NORMAL y busy_timeout de 5000ms, sincronizacion diferencial de threads por revision y timestamp, y persistencia asincrona coalesced en persist_async

### Fixed
- Eliminados bloqueos y congelamientos en Thread (Application Hang 1002) corrigiendo el deadlock AB-BA entre persist y threads, desacople de locks en checkpoints, settle, swarm y dispatch_wire
- Pasados a async con spawn_blocking todos los comandos bloqueantes restantes en chat, git, handoff y actividad de agentes para evitar trabas en el hilo UI
- Aumentada la cola de eventos de transporte a 8192 preservando frames terminales, retencion de 120s tras cierre de turnos largos y reconciliacion resyncRequired sin cortar pollers activos
- Guards contra solapamiento de intervalos en live runs, dictado y agentes, proteccion contra regresiones de estado asentado en useChatSession y recarga en vivo del inspector de subagentes
- Separadas consultas de gestion de subagentes como llamadas dinamicas, soporte de payloads en arreglo y transcript URI nativos, herencia de modelo en inspector y ocultamiento de sobres internos de despacho

---

## [0.1.57] - 2026-11-15

> Cambio automático de cuenta al 0% de cuota y cierre seguro de procesos residuales

### Added
- Cambio automático de cuenta al alcanzar el 0% de cuota con política opt-in configurable por proveedor, circuit breaker y anti-rebote entre cuota y terminal
- Confirmación interactiva en notificaciones y toast con selector de modelo alternativo cuando la cuenta destino tiene un tier o catálogo distinto
- Continuación automática en Thread tras confirmar o ejecutar un cambio de cuenta y panel compartido en Cuentas, Cuotas y modal de cambio

### Fixed
- Detección y cierre selectivo de procesos residuales en segundo plano al cambiar de cuenta sin afectar la aplicación base
- Validación contra catálogo fresco al aprobar cambios pendientes y deduplicación por hilo de confirmaciones concurrentes

---

## [0.1.56] - 2026-11-14

> Configuraciones y Proveedores sin freezes, cache SWR y cambio fluido entre threads

### Changed
- Carga diferida (React.lazy) de las 15 pestañas en Configuraciones, diferimiento de IPCs de voz/audio hasta abrir la pestaña Voice y limpieza de capas backdrop-filter y SelectMenu
- Caché SWR instantánea y sondeos paralelos con invalidación por escritura para cuotas, cuentas CLI, modelos por thread, plugins y actualizaciones de agentes

### Fixed
- Eliminados freezes en Configuraciones, Proveedores, Cuotas, Cuentas, Subagentes y Notificaciones pasando comandos Rust bloqueantes a async (spawn_blocking) con lotes SQLite y locks acotados
- Eliminada inversión de bloqueo AB-BA en instantáneas de notificaciones bajo ejecución concurrente
- Persistencia con debounce de 350 ms y flush en Zed/Operator y transición suave entre threads sin parpadeo del indicador de carga

---

## [0.1.55] - 2026-11-14

> Optimización de arranque, Thread rápido y persistencia de vista

### Added
- Reapertura automática en la última vista activa (Agent, Code o Thread) al reiniciar
- Nuevo visor unificado de diffs con resaltado de sintaxis y mejoras de subagentes y swarm

### Changed
- Aislamiento de runtime en Vite para excluir chunks pesados de la precarga inicial

### Fixed
- Optimizado el arranque inicial con carga diferida de rutas, overlays, Mermaid y workers de diffs
- Eliminado el doble bootstrap al abrir la aplicación y reducido el splash mínimo a 250 ms
- Inicialización no bloqueante en Rust para dispatch wire, shims por metadatos y daemon sincronizado sin frenar la ventana
- Reparada la animación del spinner en Thread, hidratación instantánea desde caché y lecturas SQLite sin escrituras innecesarias

---

## [0.1.54] - 2026-11-12

> Correcciones en Thread: sidebar, diff stats y turn rail

### Fixed
- Restaurado listado completo de chats en la sidebar lateral
- Corregido calculo de estadisticas (+N -M) y visualizacion de archivos modificados
- Posicionamiento elevado del riel de turnos y margenes contra colision con iconos
- Perfeccionada geometria circular del indicador de actividad Working

---

## [0.1.53] - 2026-11-12

> Modularización y optimización arquitectónica

### Changed
- modularización de 15 módulos monolíticos de backend en submódulos cohesivos
- descomposición de páginas complejas en frontend React
- encapsulamiento de estado y extracción de módulos spawn y codec en terminal

---

## [0.1.52] - 2026-11-11

> Thread Voice Mode, Operator Traces and Archiving Overhaul

### Added
- live thread voice mode with trace timeline and locked assistant footer
- cross-cli chat index and thread dispatch reach

### Fixed
- route thread archiving correctly and overhaul archived chats modal
- permit tool execution in persistent plan mode
- pure CSS styling and background Zed engine wiring for voice mode

---

## [0.1.51] - 2026-11-07

> Delegation paste stability and canonical codename assignment

### Fixed
- wrap multiline terminal paste in bracketed paste to prevent queue flooding
- assign canonical codenames to delegated agents
- distinguish idle/done prompts from genuine blocked approvals

---

## [0.1.50] - 2026-11-07

> Dispatch manual CLI & skill roots fix

### Added
- Expand dispatch skill installation across OpenCode, Gemini, Copilot, Kimi, Amp, and shared agent skill directories

### Fixed
- Strip SKILL.md YAML frontmatter and guard leading hyphens when passing system prompts to Grok and Claude Code CLI

---

## [0.1.49] - 2026-11-07

> Dispatch skill channel

### Added
- The dispatch skill is installed into existing agent skill directories.

### Fixed
- Agents receive the dispatch manual as a skill file, not the first chat message.

---

## [0.1.48] - 2026-11-07

> Dispatch and local updates

### Added
- dispatch CLI to launch, send, wait, and kill agents
- agents receive the complete dispatch manual at start

### Fixed
- updater signing key for the local feed

---

## [0.1.47] - 2026-11-05

> Restore de terminales AntiGravity y Grok

### Added
- Restore de sesiones Grok con descubrimiento en ~/.grok/sessions y arranque con -r <id>

### Changed
- Cursor de puntero por defecto sobre las terminales

### Fixed
- Primer frame al restaurar terminales: espera geometría estable del pane, snapshot completo tras el resize del PTY y un empujón de una fila para que AntiGravity y OpenCode redibujen
- El canvas no pinta deltas vacíos hasta el primer frame completo
- Caret visible en AntiGravity al restaurar

---

## [0.1.46] - 2026-11-04

> Sidebar: nombres de ventana y remocion de badge de proveedor

### Fixed
- Reemplazar nombres de agente en la cabecera de ventana por 'Ventana N'
- Eliminar badge de texto de proveedor en subpaneles de la barra lateral

---

## [0.1.45] - 2026-11-04

> Kite Core Daemon framed IPC, terminal canvas binario y reordenamiento de paneles

### Added
- Arquitectura desacoplada 'kite-core' daemon con IPC framed binario de 9 bytes y control de flujo por créditos
- Codec de snapshot binario empaquetado para terminal con reutilización de memoria in-place en Canvas 2D
- Reordenamiento interactivo de paneles de terminal mediante arrastrar y soltar (drag & drop)
- Árbol de sesiones multiterminal colapsable en la barra lateral con insignias de marcas y jerarquía visual

### Changed
- Eliminación definitiva de la superficie DOM heredada (XtermDomSurface) en favor del motor Canvas exclusivo
- Telemetría de recursos del sistema con desglose detallado por proyecto y terminal en el monitor de memoria

### Fixed
- Recuperación y repintado forzado de pantalla completa ante pérdidas de secuencia de frames en el canvas

---

## [0.1.44] - 2026-11-02

> Estabilización de Terminal Canvas, Enfoque y Scroll en Agentes

### Changed
- removed: Retirada de badges e indicadores "GhostGrid 2D" en las cabeceras de paneles y barras de herramientas

### Fixed
- Restauración de captura de pulsaciones de teclado y auto-enfoque en terminal Canvas (GhostGrid 2D)
- Propagación y sincronización de isFocused en paneles de agentes y workspace (Antigravity, Cursor, etc.)
- Restauración de paquetes SGR para rueda de ratón y clics en aplicaciones TUI interactivas
- Prevención de desenfoque por defecto del navegador en mousedown sobre superficie de terminal

---

## [0.1.43] - 2026-11-02

> Arquitectura Modular, Estabilización de Terminal y Monitor de Recursos

### Added
- Módulos dedicados para renderizado de Canvas 2D, seguimiento de ratón, codificación de teclas y sincronización de sesiones PTY

### Changed
- Arquitectura modular y desacoplamiento de componentes centrales (TerminalView, TerminalCanvasSurface, CodeWorkspace, RightDock y SystemResourcePopover)
- Componentes de cuotas y selector de cuentas desacoplados en submódulos especializados

### Fixed
- Corrección del desplazamiento de viewport (scrollback) con deltaLines en motor Canvas 2D
- Sincronización de redimensionamiento PTY en superficie DOM de xterm
- Restauración completa de selección con ratón, auto-scroll y copia al portapapeles en terminal
- Soporte nativo para arrastre de archivos y pegado de imágenes en terminal
- Persistencia de configuración de filtros y procesos en monitor de recursos del sistema

---

## [0.1.42] - 2026-11-01

> Motor de Terminal 2D, Eliminación de Artefactos ConPTY y Streaming Continuo

### Added
- Superficie de renderizado procedural Canvas 2D con rasterizador de glifos box/block/braille
- Motor de terminal virtual nativo en Rust con snapshots atómicos y soporte de actualizaciones sincronizadas DEC 2026
- Polling en segundo plano para terminales aparcadas en memoria

### Changed
- Lanzamiento directo de ejecutables de agentes bajo ConPTY eliminando wrappers innecesarios
- Desactivar estrangulamiento de timers de WebView2 en segundo plano

### Fixed
- Desincronización de ancho de celda en glifos VS16 (`U+FE0F`) y secuencias ZWJ en Windows ConPTY que causaba fragmentos y caracteres desplazados
- Parpadeo y desincronización de scrollback al alternar entre motores de renderizado
- Eliminar congelamiento y aceleración x5 en terminales al cambiar de proyecto o ventana
- Omitir repintados costosos de xterm mientras la terminal no es visible

---

## [0.1.41] - 2026-10-29

> Ajuste Estabilizado de Terminal, Apariencia Personalizable y Enrutamiento de Atajos

### Added
- personalización de apariencia y tipografía en Settings (modo DOM ClearType vs WebGL GPU)
- cálculo geométrico y ajuste estabilizado de viewport ConPTY con StableCellFitAddon

### Fixed
- preservación de buffers al reconectar sesiones PTY activas
- delegación de tecla Escape a la terminal sin abortar asistentes u overlays
- aislamiento de directorio de datos WebView2 para desarrollo y producción

---

## [0.1.40] - 2026-10-28

> Estabilización ConPTY de Terminal, Paleta de Comandos y Mejoras en Zed

### Added
- Paleta de comandos integrada y enrutamiento global de atajos de teclado
- Persistencia local de preferencias de tema, paleta de colores y shell predeterminado
- Apertura nativa de archivos y opción de revelado en el explorador del sistema operativo
- Trazabilidad en tiempo real de ejecución del operador y handoff inteligente de terminales para Zed
- Detección de disponibilidad del terminal antes de despachar el proyectil de prompt

### Changed
- Consolidación y rediseño unificado de pestañas de configuración y cuentas
- Indicador activo optimizado para la lista de workspaces y limpieza del panel lateral

### Fixed
- Eliminación de ghosting de texto y sincronización geométrica de ConPTY en el terminal
- Renderizado continuo de filas y eliminación de huecos en arte ASCII y caracteres de bloque
- Prevención de congelamiento de texto residual al restaurar el buffer alternativo de pantalla
- Normalización de codificación de consola para agentes en terminales Windows

---

## [0.1.39] - 2026-10-27

> Voz Hiperrealista ElevenLabs para Zed, Composer Moderno y Control de Razonamiento

### Added
- Integración de ElevenLabs Streaming TTS para el asistente Zed con soporte v4 turbo y fallback nativo
- Selector y control de esfuerzo de razonamiento dinámico por modelo en el composer
- Configuración de voces curadas y personalizadas en Ajustes > Voz y Zed
- Sistema integrado de notificaciones toast flotantes con Sileo
- Telemetría de sistema con desglose granular de subprocesos y memoria privada

### Fixed
- Sincronización de repositorios y ramas Git entre vistas de Agente e Hilos sin desfase
- Posicionamiento anclado mediante portales y scroll optimizado en selectores de modelos

---

## [0.1.38] - 2026-10-26

> Gestión de Ramas Git en Hilos, Selector de Workspace y Optimización del Chat

### Added
- Selector interactivo de ramas Git con búsqueda y creación instantánea de nuevas ramas
- Selector desplegable de proyecto (workspace) en la cabecera para reasignar hilos de trabajo

### Changed
- Edición y guardado in-place del título del chat mediante clic directo
- Reemplazo del icono de nuevo chat por un icono de suma intuitivo

### Fixed
- Eliminación del panel lateral ThreadInspector y simplificación del frame de chat

---

## [0.1.37] - 2026-10-25

> Conmutación Asíncrona de Cuentas, Restauración de Sesiones y Estabilidad de Terminal

### Added
- Conmutador desplegable flotante de cuentas superpuesto en el popover de Cuotas
- Restauración automática de la conversación y sesión activa de AntiGravity al reiniciar o cambiar de cuenta

### Changed
- Optimización del apagado y reinicio de agentes reduciendo latencia y timeouts

### Fixed
- Eliminación del congelamiento de la interfaz durante el cambio de cuenta con ejecución asíncrona
- Corrección de caracteres fantasma y artefactos en la terminal reseteando el estado ANSI al reconectar
- Corrección del bloqueo de dimensiones de la terminal en 80 columnas sincronizando tamaño real de filas y columnas

---

## [0.1.36] - 2026-10-25

> Consolidacion de Sistema de Diseno y Pestanas Dinamicas

### Added
- Sistema unificado de border-radius y tokens semánticos en visual-language y Tailwind
- Pestañas Prompts y Tasks configurables y cerrables a demanda en RightDock

### Changed
- Estandarización de alturas y controles en paneles laterales a 32px y 28px
- Integración de directrices estrictas de diseño y arquitectura en AGENTS.md

### Fixed
- Rediseño visual del botón Commit en DiffsView alineado con el tema principal

---

## [0.1.35] - 2026-10-25

> Restauracion de ZedOrb WebGL2 y Fluidez en Barra de Tareas

### Changed
- feat(zed): Restaurar el renderizador WebGL2 de ZedOrb con optimizacion inteligente de tasa de cuadros y pausa en minimizado
- perf(taskbar): Eliminar mas de 110,000 escrituras sincronas en app.log durante eventos de ventana y restauracion
- perf(titlebar): Restaurar mini-orbe ligero acelerado por GPU eliminando animaciones CSS continuas y capas SVG pesadas
- perf(focus): Debounce en refreshGit (1.2s), metricas de sistema (2s) y cuotas (2.5s) al reactivar o enfocar la aplicacion
- perf(terminal): Cachear sesiones de proveedor ya vinculadas evitando re-resolucion innecesaria

---

## [0.1.34] - 2026-10-25

> Eliminacion de Bucles de E/S y Bloqueos de Arranque

### Changed
- perf: Reemplazar raymarching WebGL2 continuo en ZedOrb por esfera CSS acelerada por hardware
- perf: Reducir polling IPC inactivo de terminal de 90ms a 220ms conservando 40ms en escritura
- perf: Acelerar animacion de mini-orbe en barra de titulo con capas de composicion GPU

### Fixed
- Eliminar escaneo periodico de 70MB de transcripciones y contencion en terminal.rs
- Desactivar llamadas bloqueantes a Windows Restart Manager (rstrtmgr.dll) en resolucion de sesiones

---

## [0.1.33] - 2026-10-25

> Estabilización y Rendimiento de Arranque

### Changed
- Mejorar el lanzador de escritorio limpiando procesos residuales y liberando candados de EBWebView
- Sincronizar catalogo de modelos de Grok y Cursor con sus respectivas CLIs

### Fixed
- Eliminar shaders WebGL (ReadPixels) y loops de canvas raymarching en vistas de produccion para evitar bloqueos
- Resolver contencion en el bucle principal de WebView2 y limpiar procesos huerfanos al iniciar
- Optimizar animaciones de la orbe Zed en la barra de titulo con degradados acelerados por hardware

---

## [0.1.32] - 2026-10-25

> Gobernanza de Plugins y Asignación de Motores de IA

### Added
- Selector interactivo de proveedores para motores de IA
- Asignación granular por agente con switches sincronizados

### Changed
- Modal rediseñado con componente Sheet nativo y tokens de diseño

### Fixed
- Validación estricta de credenciales en plugins antes de conectar

---

## [0.1.31] - 2026-10-24

> Validación de Credenciales y Selección de Proveedores en Plugins

### Added
- Modal de detalles con Sheet oficial y pestañas para Configuración, Proveedores de IA y Agentes
- Selector interactivo de proveedores para habilitar/deshabilitar plugins por motor de IA (Claude, Codex, Antigravity, OpenCode, Cursor, Gemini, Grok)
- Asignación granular por agente con switches individuales y sincronización con perfiles

### Changed
- Reemplazo completo de modales flotantes por el componente Sheet nativo con tokens de diseño auténticos

### Fixed
- Validación estricta de credenciales en plugins antes de conectar, previniendo falsos estados activos

---

## [0.1.30] - 2026-10-24

> Refinamiento de UI y Proveedores en Plugins

### Added
- Visualización de proveedores y motores compatibles (Claude Code, Codex, Antigravity, OpenCode, Cursor, Gemini) en el modal de detalles

### Changed
- Diseño minimalista y limpio en las tarjetas del catálogo de Plugins
- Enrutamiento de gobernanza de plugins directamente a la pestaña Ajustes de cada agente

### Fixed
- Eliminación de elementos visuales saturados en las tarjetas del catálogo

---

## [0.1.29] - 2026-10-24

> Ecosistema de Plugins y Cobertura de Agentes

### Added
- Catálogo canónico de 29 plugins para servicios externos y herramientas de agentes
- Modal interactivo de configuración de credenciales (API keys / puertos MCP) y permisos por plugin
- Cobertura bidireccional de agentes con gobernanza granular de plugins
- Pila compacta de mini-avatares en tarjetas conectadas mostrando los agentes activos
- Sincronización en segundo plano cada 2000ms con detección de foco

### Changed
- Integración automática de plugins conectados en el catálogo MCP de Agent Settings

### Fixed
- Control de acceso en modo sólo lectura para herramientas con mutaciones

---

## [0.1.28] - 2026-10-24

> Laboratorio de Animaciones y Ajustes Visuales

### Added
- Laboratorio interactivo de efectos visuales y motion en el puerto 1430

### Changed
- Preservacion de la interfaz nativa y personalizacion del chat composer
- Sincronizacion de metricas de telemetria y cuotas en la barra superior

### Fixed
- Estabilizacion de dependencias WebGL y eliminacion de img-fx

---

## [0.1.26] - 2026-10-22

> Cuotas a tu medida: agregá, ordená y fijá proveedores

### Added
- Agregá proveedores de cuotas manualmente desde Configuración → Cuotas
- Reordená proveedores con flechas y fijá cuál se muestra en la barra

### Changed
- Todos los proveedores arrancan deshabilitados; solo se monitorean los que agregues
- La barra superior muestra solo el icono y el porcentaje, sin tiempo de reseteo
- La primera actualización reinicia la lista de proveedores monitoreados; tus claves y sesiones se conservan

### Fixed
- La pastilla de cuotas sigue visible aunque no tengas proveedores agregados
- Navegación con flechas y rueda en el popover cuando hay más de tres proveedores

---

## [0.1.25] - 2026-10-22

> OpenCode Go sincroniza su cuota real

### Added
- Detección automática de credenciales desde OpenCode (opencode.db y auth.json), OPENCODE_API_KEY y la configuración de OpenCode.
- Diagnóstico visible con fuente de credencial, endpoint, estado HTTP y errores por ventana.

### Changed
- La configuración de OpenCode Go usa una API key opcional y deja de pedir la cookie y el workspace legacy.

### Fixed
- OpenCode Go consulta la API oficial de uso y muestra las ventanas de 5 horas, semanal y mensual en lugar de un 0% fijo.

---

## [0.1.24] - 2026-10-22

> Soporte oficial para Gentle Shell

### Added
- Integración oficial de Gentle Shell en el catálogo de agentes y nueva sesión
- Detección y ciclo de vida de procesos de Gentle Shell en el backend

### Fixed
- Soporte para scroll nativo fluido en terminales de Gentle Shell evitando bloqueo de pantalla alterna

---

## [0.1.23] - 2026-10-20

> Zed suelta el microfono y devuelve el volumen

### Changed
- La transcripción ya no depende de una clave escrita en el programa; si falta la de Cloudflare o Grok, Ajustes lo dice.

### Fixed
- Pedir qué hay en una terminal ahora la narra, y si está vacía dice que no hay nada, en lugar de inyectar un comando.
- Después de una orden, un toque en Zed vuelve a abrir el micrófono y la siguiente instrucción no se pierde.
- Si el micrófono está ocupado, Zed suelta su propia captura y lo explica en español.
- El volumen de las otras apps vuelve al cerrar o minimizar Zed, si la escucha falla, y al salir de Kite.

---

## [0.1.22] - 2026-10-20

> Supresion de demonios huerfanos de Antigravity y aislamiento de procesos

### Fixed
- Inyección estricta de AGY_CLI_DISABLE_AUTO_UPDATE=true en Rust (main, quota, chat, terminal, hidden_exec) para suprimir el demonio en segundo plano de agy.
- Aislamiento total de ventanas de consola en Windows 11 impidiendo la delegación a WindowsTerminal.exe.

### Security
- Configuración persistente a nivel de usuario en Windows para evitar ejecuciones huérfanas de background updater.

---

## [0.1.21] - 2026-10-19

> Supresion de consolas en sesiones de agentes y servidores MCP

### Changed
- Sanitización de nombres de archivo de sesión en el gestor de portapapeles.

### Fixed
- Prevención de destellos de terminal en la inicialización de servidores MCP (windowsHide activado).
- Inyección de AGY_CLI_DISABLE_AUTO_UPDATE=1 en terminales y agentes ConPTY para bloquear daemons huérfanos de agy.

---

## [0.1.20] - 2026-10-19

> Eliminacion definitiva de delegacion de Windows Terminal con CREATE_NO_WINDOW

### Changed
- Supresión de asignación de consolas en la ejecución oculta de subprocesos y herramientas CLI

### Fixed
- Reemplazo definitivo de CREATE_NEW_CONSOLE por CREATE_NO_WINDOW en hidden_exec para impedir la delegación a Windows Terminal en Windows 11
- Aislamiento completo de procesos en segundo plano para consultas de cuotas de Antigravity y servidores MCP

---

## [0.1.19] - 2026-10-19

> Corrección de congelamiento en terminales y respuesta interactiva instantánea

### Fixed
- Elimina el bloqueo asíncrono en enqueueWrite que dejaba las terminales oscuras y no responsivas

---

## [0.1.18] - 2026-10-19

> Optimizaciones de Rendimiento y Prevencion de Congelamiento

### Changed
- Polling adaptativo en terminales integradas con reduccion del 75% en reposo y 95% en segundo plano
- Pausa automatica en el muestreo de procesos del sistema cuando la ventana esta oculta
- Debounce de 2.5s en comprobador de actualizaciones al recuperar foco de la ventana

### Fixed
- Prevenir congelamiento de UI tras periodos en segundo plano con banderas anti-suspension en WebView2
- Eliminar escritura sincrona a app.log en el bucle principal de eventos (MainEventsCleared)

---

## [0.1.17] - 2026-10-19

> Eliminacion de ventanas emergentes de consola y optimizacion en segundo plano

### Added
- Refinamiento de la barra de control de asistencia ZedStrip y renderizado suave de ZedOrb

### Changed
- Optimización del tiempo de respuesta en la comprobación periódica de cuotas de Antigravity

### Fixed
- Eliminación de ventanas emergentes de PowerShell y Windows Terminal al consultar cuotas de Antigravity
- Aislamiento estricto de procesos en segundo plano con flags CREATE_NO_WINDOW y CREATE_NEW_CONSOLE en hidden_exec
- Prevención de apertura de consolas al consultar modelos CLI de Antigravity

---

## [0.1.16] - 2026-10-18

> Estabilidad de doble instancia y optimización del Asistente

### Changed
- Optimización del renderizado de la esfera ZedOrb evitando WebGL en orbes pequeños y pausando en reposo

### Fixed
- Aislamiento completo de carpetas WebView2 entre desarrollo e instalada para evitar bloqueos y congelamientos
- Asistente Zed cerrado por defecto al abrir la aplicación sin píldora flotante automática
- Corrección en el script de desarrollo para preservar el bloqueo de la aplicación de producción

---

## [0.1.15] - 2026-10-18

### Added
- Floating Zed orb and interactive dock assistant with sound wave animations and drag controls.
- Operator protocol with autonomous subagent dispatcher and task runner.
- Settings Zed tab for operator configuration, microphone dictation, and speech toggles.

### Changed
- ConPTY terminal paste handler with bracketed paste mode and multiline sanitization.

### Fixed
- Stabilized background thread synchronization for IPC command channels.

---

## [0.1.14] - 2026-10-17

### Added
- Windows ConPTY terminal keepalive daemon and auto-reconnection on window resize.
- Standalone PowerShell desktop launch script (`scripts/launch-desktop-app.ps1`).

### Changed
- Pruned legacy release artifacts and build cache to optimize installer packaging.

### Fixed
- Fixed terminal cursor drift and background flicker during heavy process execution.

---

## [0.1.13] - 2026-10-16

### Added
- Hardware telemetry monitoring CPU, memory, and disk usage with real-time HUD badge.
- Auto-healing background feed server daemon (`scripts/feed-server.mjs`) on port 9101.

### Changed
- One-command atomic release pipeline (`scripts/release.mjs`) with NSIS bundling and Minisign verification.

### Fixed
- Eliminated feed server port collision and zombie child process leaks.

---

## [0.1.12] - 2026-10-16

### Added
- Persistent SQLite memory engine (`agent_mind.rs`) for long-term agent contextual memory.
- Autonomous local autopilot execution loop with step-by-step goal verification.

### Changed
- Configurable agent memory budgets and note caps in Agent Settings.

### Fixed
- Memory leak during repeated subagent task state serialization.

---

## [0.1.11] - 2026-10-16

### Added
- Unified sidebar navigation with dedicated views for Agents, Workspaces, Chat, and Settings.
- Custom modal system (What's New modal, Launch Preset modal, Keyboard Shortcuts).

### Changed
- Responsive view docking and collapsible rail navigation.

### Security
- Sanitized IPC layer and sandboxed WebView2 execution bounds.

---

## [0.1.10] - 2026-10-16

### Added
- Multi-account switcher with secure local token storage for AI providers.
- Live subscription quota monitor and token usage telemetry graphs.

### Fixed
- Token refresh race condition during simultaneous agent requests.

---

## [0.1.9] - 2026-10-15

### Added
- Native ticket management board and task dispatcher for autonomous coding runs.
- Model Context Protocol (MCP) server configuration manager and tool discovery.

### Changed
- Real-time ticket status updates synchronized with background agent actions.

---

## [0.1.8] - 2026-10-15

### Added
- Multi-agent roster supporting customized system prompts, engine selection, and role specializations.
- Background routine scheduler with interval and event-based triggers.

### Fixed
- Process cleanup on routine cancellation or engine timeout.

---

## [0.1.7] - 2026-10-15

### Added
- Native workspace filesystem explorer with recursive tree navigation and file search.
- Integrated code editor with markdown preview and diff visualization.

### Changed
- File watcher performance optimized with debounce and gitignore filtering.

---

## [0.1.6] - 2026-10-15

### Added
- Streaming Agent Communication Protocol (ACP) for low-latency token and tool output.
- Human-in-the-loop tool execution approval prompts with inline diff reviews.

### Changed
- Enhanced chat composer with multiline expansion and command palette autocomplete.

### Security
- Strict path traversal guards and execution approval enforcement.

---

## [0.1.5] - 2026-10-16

### Added
- Dynamic version synchronization across all Settings tabs (General, About, Changelog, Footer).
- Interactive Changelog view displaying complete release history with incoming update previews.

### Changed
- Synchronized What's New modal directly with Kite Code release ledger.

### Fixed
- Eliminated hardcoded legacy version numbers from GeneralTab, ChangelogTab, and modals.

---

## [0.1.4] - 2026-10-16

### Added
- Reactive updater singleton store synchronizing Sidebar, Circular indicator, and Settings in real time.
- Auto-healing feed server: background daemon automatically starts on update requests.

### Changed
- Replaced raster TitleBar logo with 100% crisp vector SVG full-bleed icon.

### Fixed
- Transparent update diagnostics: displays connection errors with one-click retry.
- Persistent feed directory configured to prevent build tools from clearing release artifacts.

---

## [0.1.3] - 2026-10-16

### Changed
- Redesigned terminal monogram mark with high-contrast chevron and terminal cursor.

### Fixed
- Enabled HTTP Content-Length headers for exact update download percentage calculation.
- Streamlined HEAD and OPTIONS request handling across local feed endpoints.

---

## [0.1.2] - 2026-10-16

### Added
- Brand identity: Kite Code with custom deep-sapphire and cyan identity.
- Air-gapped offline runtime and sanitized local persistent storage.

### Changed
- Interactive TitleBar with dedicated Agent, Code, and Thread mode switchers.

---

## [0.1.1] - 2026-10-15

### Added
- Native ConPTY Windows terminal daemon with hardware-accelerated rendering and automatic resizing.
- Multi-agent orchestration supporting local models and cloud providers in parallel.

### Fixed
- Eliminated terminal window flickering during background quota and process probing.

---

## [0.1.0] - 2026-10-15

### Added
- Embedded WebView2 browser surface with bounded layout preservation.
- Local Token and Subscription quota telemetry.

### Security
- Strict process isolation and secure minisign signature verification for updates.
